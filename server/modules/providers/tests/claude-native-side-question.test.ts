import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeRuntime, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext, SideQuestionRequest } from '@/shared/types.js';

/**
 * The native side-question path (upstream #1673): a live query whose SDK
 * instance ships `askSideQuestion` answers on the session's own stdin
 * control channel — measured 3-5x faster than the read-only fork — while a
 * session whose stdin was already released falls back to the fork. These
 * drive the real runtime over a scripted SDK stream, the same seam the
 * subagent-approvals tests use, and pin three lines: the native answer
 * reaching the sink, the fallback on a released stdin, and the release a
 * turn asks for while a native question is outstanding being deferred until
 * that question settles.
 */

let sessionCounter = 0;
/** Unique per test: a lingering previous run's removeSession must not delete this test's entry. */
const nextSessionId = () => `native-side-question-${(sessionCounter += 1)}`;

type Harness = {
  /** The SDK instance the run registered; the test grafts `askSideQuestion` onto it. */
  instance: Record<string, unknown> & { askSideQuestion?: (question: string, options?: { signal?: AbortSignal }) => Promise<{ response: string; synthetic: boolean } | null> };
  releaseInput: () => void;
  /** Whether the run's prompt stream has been released (stdin closed). */
  released: () => boolean;
  /** Whether the deferred release has actually run. */
  releaseRun: () => boolean;
  /** Ends the scripted stream: the fork fallback consumes the same queue. */
  endStream: () => void;
  end: () => Promise<void>;
};

async function withRun(runTest: (harness: Harness, context: ProviderRuntimeContext, sessionId: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-native-side-'));
  // A stub CLI so the fork fallback's own spawn does not fail on a missing
  // binary before it even reaches the scripted stream.
  const cliPath = path.join(cwd, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (process.platform === 'win32') {
    await writeFile(cliPath, '@echo off\r\n', 'utf8');
  } else {
    await writeFile(cliPath, '#!/bin/sh\n', 'utf8');
    await chmod(cliPath, 0o755);
  }
  const previousCliPath = process.env.CLAUDE_CLI_PATH;
  process.env.CLAUDE_CLI_PATH = cliPath;
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let released = false;
  let releaseRun = false;

  // Assigned inside createQuery: the registered instance IS the iterator.
  let instance: Harness['instance'] = {};

  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => 'native-provider-session',
    resolveTranscriptPath: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: (({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      void (async () => {
        for await (const _m of prompt) { /* stdin: the CLI reads it */ }
        released = true;
      })();
      const iterator = (async function* () {
        for (;;) {
          if (queue.length === 0) {
            if (ended) return;
            await new Promise<void>((resolve) => { wake = resolve; });
            wake = null;
            continue;
          }
          yield queue.shift();
        }
      })();
      // The registered instance IS this iterator: the test grafts the SDK's
      // undocumented askSideQuestion onto exactly this object, so the native
      // path reads it off the session map.
      Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} });
      instance = iterator as unknown as Harness['instance'];
      return iterator;
    }) as never,
  };

  const sessionId = nextSessionId();
  const runPromise = queryClaudeSDK('go', { sessionId, cwd }, { send: () => {}, userId: null } as never, context);

  // The runtime exposes its session map to tests: the release the run's own
  // end-of-turn path would call is read off the entry, and waiting for the
  // entry to exist is waiting for the run to register itself.
  const entrySeam = (claudeRuntime as unknown as {
    __testSessionEntry?: (sessionId: string) => { releaseInput: (() => void) | null } | undefined;
  }).__testSessionEntry;
  assert.ok(typeof entrySeam === 'function', 'the runtime exposes a test seam to its session entry');
  let entry: { releaseInput: (() => void) | null } | undefined;
  for (let i = 0; i < 100 && !entry; i += 1) {
    entry = entrySeam(sessionId);
    if (!entry) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(entry, 'the run registered its session entry');

  const harness: Harness = {
    instance,
    releaseInput: () => { entrySeam(sessionId)?.releaseInput?.(); },
    released: () => released,
    releaseRun: () => releaseRun,
    endStream: () => {
      ended = true;
      wake?.();
    },
    end: async () => {
      ended = true;
      wake?.();
      // Close stdin too: the run's prompt consumer only ends when the held
      // stream does, and the run settles only after both loops return.
      entrySeam(sessionId)?.releaseInput?.();
      await Promise.race([runPromise, new Promise((resolve) => setTimeout(resolve, 1000))]);
    },
  };

  try {
    await runTest(harness, context, sessionId);
  } finally {
    if (previousCliPath === undefined) {
      delete process.env.CLAUDE_CLI_PATH;
    } else {
      process.env.CLAUDE_CLI_PATH = previousCliPath;
    }
    await harness.end().catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
}

const ask = (sessionId: string, question: string, signal?: AbortSignal): SideQuestionRequest => ({
  appSessionId: sessionId,
  providerSessionId: 'native-provider-session',
  projectPath: '/work/project',
  question,
  model: null,
  signal: signal ?? new AbortController().signal,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test('a live query with the SDK method answers natively, on the session it was asked', { timeout: 10_000 }, async () => {
  await withRun(async (harness, context, sessionId) => {
    // Graft the SDK's undocumented method onto the registered instance.
    harness.instance.askSideQuestion = async (question) => {
      assert.equal(question, 'What file holds the router?');
      return { response: 'src/router.ts', synthetic: false };
    };

    const deltas: string[] = [];
    const outcome = await claudeRuntime.askSideQuestion!(ask(sessionId, 'What file holds the router?'), { delta: (t) => deltas.push(t) }, context);

    assert.deepEqual(outcome, { status: 'done', answer: 'src/router.ts' });
    assert.deepEqual(deltas, ['src/router.ts']);
    assert.equal(harness.released(), false, 'stdin stays open — nothing was forked');
  });
});

test('a session whose stdin was already released falls back to the read-only fork', { timeout: 10_000 }, async () => {
  await withRun(async (harness, context, sessionId) => {
    // The instance still carries the method, but the release already ran.
    harness.instance.askSideQuestion = async () => ({ response: 'never', synthetic: false });
    harness.releaseInput();
    for (let i = 0; i < 100 && !harness.released(); i += 1) await settle();

    // The fork fallback consumes the same scripted stream: end it so the
    // fork's consumer returns instead of waiting forever.
    const pending = claudeRuntime.askSideQuestion!(ask(sessionId, 'any question'), { delta: () => {} }, context);
    harness.endStream();
    const outcome = await pending;

    assert.equal(outcome.status, 'error', 'the fork path ran (and failed on the ended stream), not the native one');
    assert.notEqual(outcome.error, 'never', 'the native instance was never called');
  });
});

test('a release requested while a native question is outstanding is deferred until it settles', { timeout: 15_000 }, async () => {
  await withRun(async (harness, context, sessionId) => {
    const holder: { resolve: ((result: { response: string; synthetic: boolean }) => void) | null } = { resolve: null };
    harness.instance.askSideQuestion = (question, options) => new Promise((resolve) => {
      // The dismissal signal must reach the SDK call, not just the wrapper.
      options?.signal?.addEventListener('abort', () => { /* the SDK rejects; the test resolves instead */ });
      holder.resolve = resolve;
    });

    const controller = new AbortController();
    const pending = claudeRuntime.askSideQuestion!(ask(sessionId, 'still needed', controller.signal), { delta: () => {} }, context);
    for (let i = 0; i < 100 && !holder.resolve; i += 1) await settle();
    assert.ok(holder.resolve, 'the native call is in flight');

    // The turn ends and asks for the release; it must be deferred.
    harness.releaseInput();
    for (let i = 0; i < 20; i += 1) await settle();
    assert.equal(harness.released(), false, 'stdin stays open while the question is outstanding');

    holder.resolve?.({ response: 'answered', synthetic: false });
    const outcome = await pending;
    assert.deepEqual(outcome, { status: 'done', answer: 'answered' });

    // The deferred release runs once the count drops to zero.
    harness.releaseInput();
    for (let i = 0; i < 100 && !harness.released(); i += 1) await settle();
    assert.equal(harness.released(), true, 'the release goes through after the question settled');
  });
});
