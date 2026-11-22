import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

import { createAgentRouter } from '../agent.routes.js';

// Resolved so the route's own `path.resolve` agrees with it on Windows too,
// where a rooted POSIX path gains the current drive letter.
const PROJECT_PATH = path.resolve('/home/test/project');

/**
 * `POST /api/agent` runs a provider for an API-key caller. Until now it wrote
 * the run's events straight to the HTTP response and nothing else knew: the
 * session was not on the running-sessions list, no tab could subscribe to
 * it, and a second request could start a second run on the same session. It
 * now registers the run with the chat run registry the way a `chat.send`
 * does, with the HTTP response as the run's first audience.
 */

type AgentDependencies = Parameters<typeof createAgentRouter>[0];
type RunFunction = AgentDependencies['queryClaude'];

async function withIsolatedDatabase(run: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'agent-run-registration-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await run();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function createDependencies(
  queryClaude: RunFunction,
  runtimeOverrides: Partial<AgentDependencies['runtime']> = {},
  history: NormalizedMessage[] = [],
): AgentDependencies {
  const unexpected = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const sessionIdsByClientRequestId = new Map<string, string>();
  return {
    fileSystem: { access: async () => undefined } as unknown as AgentDependencies['fileSystem'],
    crypto: nodeCrypto,
    homeDirectory: () => '/home/test',
    spawnProcess: (() => { throw new Error('spawn should not run'); }) as unknown as AgentDependencies['spawnProcess'],
    platformMode: true,
    users: { getFirstUser: () => ({ id: 1, username: 'test-user' }) },
    apiKeys: { validateApiKey: () => undefined },
    githubTokens: { getActiveGithubToken: () => null },
    projects: { createProjectPath: () => ({ outcome: 'created' }) },
    models: {
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default-model' }),
      setSessionModel: () => null,
      setSessionEffort: () => null,
    } as unknown as AgentDependencies['models'],
    sessions: {
      getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
      getSessionByProviderSessionId: (providerSessionId) => sessionsDb.getSessionByProviderSessionId(providerSessionId),
      createAppSession: (provider, projectPath, initialMessage, options) => {
        const clientRequestId = options?.clientRequestId ?? null;
        const existing = clientRequestId ? sessionIdsByClientRequestId.get(clientRequestId) : undefined;
        if (existing) return { sessionId: existing };
        const sessionId = `app-${initialMessage.length}-${nodeCrypto.randomUUID()}`;
        sessionsDb.createAppSession(sessionId, provider, projectPath, initialMessage);
        if (clientRequestId) sessionIdsByClientRequestId.set(clientRequestId, sessionId);
        return { sessionId };
      },
      fetchHistory: async (_sessionId, options = {}) => {
        const limit = options.limit ?? null;
        const offset = options.offset ?? 0;
        const end = Math.max(0, history.length - offset);
        const start = limit === null ? 0 : Math.max(0, end - limit);
        return {
          messages: history.slice(start, end),
          total: history.length,
          hasMore: start > 0,
          offset,
          limit,
        };
      },
    },
    runs: chatRunRegistry,
    runtime: {
      abort: async () => true,
      hasBackgroundWork: () => false,
      ...runtimeOverrides,
    },
    queryClaude,
    queryCursor: unexpected as RunFunction,
    queryCodex: unexpected as RunFunction,
    queryOpenCode: unexpected as RunFunction,
    GithubClient: class {} as unknown as AgentDependencies['GithubClient'],
  };
}

async function withAgentServer(dependencies: AgentDependencies, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', createAgentRouter(dependencies));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (baseUrl: string, body: Record<string, unknown>) =>
  fetch(`${baseUrl}/api/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const abortSession = (baseUrl: string, sessionId: string) =>
  fetch(`${baseUrl}/api/agent/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' });

const getSessionStatus = (baseUrl: string, sessionId: string) =>
  fetch(`${baseUrl}/api/agent/${encodeURIComponent(sessionId)}`);

const getSessionResult = (baseUrl: string, sessionId: string) =>
  fetch(`${baseUrl}/api/agent/${encodeURIComponent(sessionId)}/result`);

/** Polls the status route until it reports `expected`, as a `wait:false` caller does. */
async function waitForSessionStatus(baseUrl: string, sessionId: string, expected: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await getSessionStatus(baseUrl, sessionId);
    const body = await response.json() as Record<string, unknown>;
    if (body.status === expected) return body;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  assert.fail(`session ${sessionId} never reached ${expected}`);
}

const readEvents = async (response: Response): Promise<Array<Record<string, unknown>>> =>
  (await response.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>);

/** A runtime that announces its native session id, streams one text event, and waits to be released before completing. */
function createHeldRuntime(nativeSessionId = 'native-1') {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const seen: Array<{ sessionId: unknown; writerIsGateway: boolean }> = [];
  const queryClaude: RunFunction = async (_command, options, writer) => {
    seen.push({ sessionId: (options as { sessionId?: unknown }).sessionId, writerIsGateway: Boolean((writer as { isWebSocketWriter?: boolean }).isWebSocketWriter) });
    // A resumed session announces the id it resumed under; a new one, a fresh id.
    const announced = (writer as { getSessionId?: () => string | null }).getSessionId?.() ?? nativeSessionId;
    writer.send(createNormalizedMessage({ kind: 'session_created', provider: 'claude', sessionId: announced, newSessionId: announced }));
    writer.send(createNormalizedMessage({ kind: 'text', id: 'api-run-hello-row', provider: 'claude', sessionId: announced, role: 'assistant', content: 'hello' }));
    await released;
    writer.send(createNormalizedMessage({ kind: 'complete', provider: 'claude', sessionId: announced, exitCode: 0 }));
  };
  return { queryClaude, release, seen };
}

test('an API run is registered like a chat send: listed while running, streamed decorated, mapped to its native id', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createHeldRuntime();
    await withAgentServer(createDependencies(runtime.queryClaude), async (baseUrl) => {
      const responsePromise = post(baseUrl, { projectPath: '/home/test/project', message: 'Run it' });
      // Wait for the runtime to be entered.
      for (let i = 0; i < 50 && runtime.seen.length === 0; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }

      const [running] = chatRunRegistry.listRunningRuns();
      assert.ok(running, 'the run is on the running-sessions list while the provider works');
      assert.equal(running.provider, 'claude');
      assert.match(running.sessionId, /^app-/, 'listed under the app session id the route allocated');
      assert.deepEqual(runtime.seen, [{ sessionId: running.sessionId, writerIsGateway: true }], 'the runtime gets the app id and the run\'s gateway writer');
      // A tab that opens the session mid-run replays what it missed.
      assert.deepEqual(chatRunRegistry.replayEvents(running.sessionId, 0).events.map((event) => event.kind), ['text']);

      runtime.release();
      const response = await responsePromise;
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
      const events = await readEvents(response);
      assert.deepEqual(events.map((event) => event.type ?? event.kind), ['status', 'session-id', 'text', 'complete', 'done']);
      assert.equal(events[1]?.sessionId, running.sessionId, 'session-id names the app session, not the provider\'s');
      // Provider events reach the stream as a tab would see them: app session id, sequenced, no session_created.
      const text = events[2] as NormalizedMessage;
      assert.equal(text.sessionId, running.sessionId);
      assert.equal(text.seq, 1);

      assert.equal(chatRunRegistry.isProcessing(running.sessionId), false, 'the terminal complete ends the run');
      assert.equal(sessionsDb.getSessionById(running.sessionId)?.provider_session_id, 'native-1', 'the native id the runtime announced is mapped onto the row');
    });
  });
});

test('a second API request on a session mid-run is refused with 409, as the chat socket refuses it', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createHeldRuntime();
    await withAgentServer(createDependencies(runtime.queryClaude), async (baseUrl) => {
      const first = post(baseUrl, { projectPath: '/home/test/project', message: 'Run it' });
      for (let i = 0; i < 50 && runtime.seen.length === 0; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      const [running] = chatRunRegistry.listRunningRuns();
      assert.ok(running);

      const second = await post(baseUrl, { projectPath: '/home/test/project', message: 'Again', sessionId: running.sessionId, stream: false });
      assert.equal(second.status, 409);
      assert.equal(runtime.seen.length, 1, 'the provider is not entered twice');

      runtime.release();
      await first;
    });
  });
});

test('a non-streaming API run answers with the app session id and is off the list once done', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createHeldRuntime();
    runtime.release();
    await withAgentServer(createDependencies(runtime.queryClaude), async (baseUrl) => {
      const response = await post(baseUrl, { projectPath: '/home/test/project', message: 'Run it', stream: false });
      assert.equal(response.status, 200);
      const body = await response.json() as { success: boolean; sessionId: string };
      assert.equal(body.success, true);
      assert.match(body.sessionId, /^app-/);
      assert.deepEqual(chatRunRegistry.listRunningRuns(), []);
    });
  });
});

test('an API run continues a session the caller names by either id, and refuses one that does not exist', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-existing', 'claude', '/home/test/project', 'Existing');
    sessionsDb.assignProviderSessionId('app-existing', 'native-existing');
    const runtime = createHeldRuntime();
    runtime.release();
    await withAgentServer(createDependencies(runtime.queryClaude), async (baseUrl) => {
      const byAppId = await post(baseUrl, { projectPath: '/home/test/project', message: 'More', sessionId: 'app-existing', stream: false });
      assert.equal(byAppId.status, 200);
      assert.equal((await byAppId.json() as { sessionId: string }).sessionId, 'app-existing');

      // A caller that stored the provider-native id an earlier response gave it.
      const byNativeId = await post(baseUrl, { projectPath: '/home/test/project', message: 'More', sessionId: 'native-existing', stream: false });
      assert.equal(byNativeId.status, 200);
      assert.equal((await byNativeId.json() as { sessionId: string }).sessionId, 'app-existing');
      assert.deepEqual(runtime.seen.map((call) => call.sessionId), ['app-existing', 'app-existing']);

      const unknown = await post(baseUrl, { projectPath: '/home/test/project', message: 'More', sessionId: 'nope', stream: false });
      assert.equal(unknown.status, 404);
      assert.equal(runtime.seen.length, 2);
    });
  });
});

test('a sessionId alone continues where the session lives', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-existing', 'claude', PROJECT_PATH, 'Existing');
    const runtime = createHeldRuntime();
    runtime.release();
    await withAgentServer(createDependencies(runtime.queryClaude), async (baseUrl) => {
      const response = await post(baseUrl, { message: 'More', sessionId: 'app-existing', stream: false });
      assert.equal(response.status, 200);
      const body = await response.json() as { sessionId: string; projectPath: string };
      assert.equal(body.sessionId, 'app-existing');
      assert.equal(body.projectPath, PROJECT_PATH);
      assert.deepEqual(runtime.seen.map((call) => call.sessionId), ['app-existing']);
    });
  });
});

test('an abort stops the running turn and the original response reports it', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createHeldRuntime();
    const abortCalls: Array<{ provider: string; sessionId: string }> = [];
    const dependencies = createDependencies(runtime.queryClaude, {
      abort: async (provider, sessionId) => {
        abortCalls.push({ provider, sessionId });
        return true;
      },
    });
    await withAgentServer(dependencies, async (baseUrl) => {
      const pending = post(baseUrl, { projectPath: PROJECT_PATH, message: 'Run it', stream: false });
      for (let i = 0; i < 50 && runtime.seen.length === 0; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      const [running] = chatRunRegistry.listRunningRuns();
      assert.ok(running, 'the held run is listed before the abort');

      const stopped = await abortSession(baseUrl, running.sessionId);
      assert.equal(stopped.status, 200);
      assert.deepEqual(await stopped.json(), {
        success: true,
        sessionId: running.sessionId,
        aborted: true,
      });
      assert.deepEqual(abortCalls, [{ provider: 'claude', sessionId: running.sessionId }]);

      // The provider notices the abort and its run resolves; the original
      // HTTP request reports the aborted turn, as a tab-driven abort does.
      runtime.release();
      const response = await pending;
      const body = await response.json() as { success: boolean; aborted?: boolean };
      assert.equal(body.success, false);
      assert.equal(body.aborted, true);
      assert.deepEqual(chatRunRegistry.listRunningRuns(), []);
    });
  });
});

test('aborting an idle session is idempotent and an unknown one is 404', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-idle', 'claude', PROJECT_PATH, 'Idle');
    const runtime = createHeldRuntime();
    runtime.release();
    await withAgentServer(createDependencies(runtime.queryClaude), async (baseUrl) => {
      const idle = await abortSession(baseUrl, 'app-idle');
      assert.equal(idle.status, 200);
      assert.deepEqual(await idle.json(), {
        success: true,
        sessionId: 'app-idle',
        aborted: false,
      });

      const missing = await abortSession(baseUrl, 'missing');
      assert.equal(missing.status, 404);
    });
  });
});

test('session status reports a running turn and then idle', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createHeldRuntime();
    await withAgentServer(createDependencies(runtime.queryClaude), async (baseUrl) => {
      const pending = post(baseUrl, { projectPath: PROJECT_PATH, message: 'Run it', stream: false });
      for (let i = 0; i < 50 && runtime.seen.length === 0; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      const [running] = chatRunRegistry.listRunningRuns();
      assert.ok(running);

      const whileRunning = await getSessionStatus(baseUrl, running.sessionId);
      assert.equal(whileRunning.status, 200);
      const runningBody = await whileRunning.json() as {
        status: string;
        provider: string;
        projectPath: string;
        run: { startedAt: string; lastSeq: number } | null;
      };
      assert.equal(runningBody.status, 'running');
      assert.equal(runningBody.provider, 'claude');
      assert.equal(runningBody.projectPath, PROJECT_PATH);
      assert.ok(runningBody.run);
      assert.match(runningBody.run.startedAt, /^\d{4}-\d{2}-\d{2}T/);

      runtime.release();
      await pending;

      const after = await getSessionStatus(baseUrl, 'native-1');
      assert.equal(after.status, 200);
      const idleBody = await after.json() as { sessionId: string; status: string; run: unknown };
      assert.equal(idleBody.sessionId, running.sessionId, 'the provider-native id resolves to the app session');
      assert.equal(idleBody.status, 'idle');
      assert.equal(idleBody.run, null);

      const missing = await getSessionStatus(baseUrl, 'missing');
      assert.equal(missing.status, 404);
    });
  });
});

test('wait:false answers with the session id before the run ends, and the result route reads its reply from history', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createHeldRuntime();
    const history = [
      createNormalizedMessage({ kind: 'text', id: 'history-user-run-it', provider: 'claude', sessionId: 'native-1', role: 'user', content: 'Run it' }),
      createNormalizedMessage({ kind: 'text', id: 'history-assistant-hello', provider: 'claude', sessionId: 'native-1', role: 'assistant', content: 'hello' }),
    ];
    await withAgentServer(createDependencies(runtime.queryClaude, {}, history), async (baseUrl) => {
      const response = await post(baseUrl, { projectPath: PROJECT_PATH, message: 'Run it', wait: false });
      assert.equal(response.status, 202);
      const body = await response.json() as {
        success: boolean;
        sessionId: string;
        status: string;
        run: { startedAt: string; lastSeq: number } | null;
      };
      assert.equal(body.success, true);
      assert.match(body.sessionId, /^app-/);
      assert.equal(body.status, 'running');
      assert.ok(body.run, 'the answer names the run it just registered');

      assert.equal((await (await getSessionStatus(baseUrl, body.sessionId)).json() as { status: string }).status, 'running');

      // The provider is still held, but the stored transcript already has the
      // reply the result route serves (the caller normally polls until idle).
      const whileRunning = await getSessionResult(baseUrl, body.sessionId);
      assert.equal(whileRunning.status, 200);
      const partial = await whileRunning.json() as { status: string; reply: string };
      assert.equal(partial.status, 'running');
      assert.equal(partial.reply, 'hello');

      runtime.release();
      assert.equal((await waitForSessionStatus(baseUrl, body.sessionId, 'idle')).status, 'idle');

      const result = await getSessionResult(baseUrl, body.sessionId);
      assert.equal(result.status, 200);
      const done = await result.json() as {
        status: string;
        reply: string;
        messages: Array<{ content: string }>;
        providerSessionId: string;
      };
      assert.equal(done.status, 'idle');
      assert.equal(done.reply, 'hello');
      assert.deepEqual(done.messages.map((message) => message.content), ['hello']);
      assert.equal(done.providerSessionId, 'native-1');
    });
  });
});

test('a wait:false retry with the same clientRequestId gets the same session and the running run', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createHeldRuntime();
    await withAgentServer(createDependencies(runtime.queryClaude), async (baseUrl) => {
      const first = await post(baseUrl, {
        projectPath: PROJECT_PATH, message: 'Run it', wait: false, clientRequestId: 'dispatch-1',
      });
      assert.equal(first.status, 202);
      const firstBody = await first.json() as { sessionId: string };

      const retry = await post(baseUrl, {
        projectPath: PROJECT_PATH, message: 'Run it', wait: false, clientRequestId: 'dispatch-1',
      });
      assert.equal(retry.status, 202);
      const retryBody = await retry.json() as { sessionId: string; status: string; run: unknown };
      assert.equal(retryBody.sessionId, firstBody.sessionId, 'the retry reuses the session the first attempt allocated');
      assert.equal(retryBody.status, 'running');
      assert.ok(retryBody.run, 'the retry names the run that is still going');
      assert.equal(runtime.seen.length, 1, 'the provider was entered once');

      runtime.release();
      await waitForSessionStatus(baseUrl, firstBody.sessionId, 'idle');
    });
  });
});

test('wait:false refuses branch/PR creation instead of answering before it exists', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createHeldRuntime();
    await withAgentServer(createDependencies(runtime.queryClaude), async (baseUrl) => {
      const response = await post(baseUrl, { projectPath: PROJECT_PATH, message: 'Run it', wait: false, createBranch: true });
      assert.equal(response.status, 400);
      assert.match((await response.json() as { error: string }).error, /wait:false/);
      assert.equal(runtime.seen.length, 0, 'nothing ran');
    });
  });
});

test('the result route returns only the last turn of a continued session, and 404s an unknown one', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-continued', 'claude', PROJECT_PATH, 'Continued');
    const history = [
      createNormalizedMessage({ kind: 'text', id: 'history-user-first', provider: 'claude', sessionId: 'native-1', role: 'user', content: 'First' }),
      createNormalizedMessage({ kind: 'text', id: 'history-assistant-one', provider: 'claude', sessionId: 'native-1', role: 'assistant', content: 'one' }),
      createNormalizedMessage({ kind: 'text', id: 'history-user-second', provider: 'claude', sessionId: 'native-1', role: 'user', content: 'Second' }),
      createNormalizedMessage({ kind: 'text', id: 'history-assistant-two', provider: 'claude', sessionId: 'native-1', role: 'assistant', content: 'two' }),
    ];
    const runtime = createHeldRuntime();
    runtime.release();
    await withAgentServer(createDependencies(runtime.queryClaude, {}, history), async (baseUrl) => {
      const response = await getSessionResult(baseUrl, 'app-continued');
      assert.equal(response.status, 200);
      const body = await response.json() as { status: string; reply: string; messages: Array<{ content: string }> };
      assert.equal(body.status, 'idle');
      assert.equal(body.reply, 'two');
      assert.deepEqual(body.messages.map((message) => message.content), ['two']);

      const missing = await getSessionResult(baseUrl, 'missing');
      assert.equal(missing.status, 404);
    });
  });
});

test('a runtime that throws leaves no run behind', async () => {
  await withIsolatedDatabase(async () => {
    const queryClaude: RunFunction = async () => { throw new Error('provider exploded'); };
    await withAgentServer(createDependencies(queryClaude), async (baseUrl) => {
      const response = await post(baseUrl, { projectPath: '/home/test/project', message: 'Run it', stream: false });
      assert.equal(response.status, 500);
      assert.deepEqual(chatRunRegistry.listRunningRuns(), [], 'the safety net completes the run');
    });
  });
});

test('a sessionId that is not a string is refused, not bound to a query', async () => {
  // The lookup runs before the handler's try: a throw there is an unhandled
  // rejection, and better-sqlite3 throws on binding an object.
  await withIsolatedDatabase(async () => {
    const runtime = createHeldRuntime();
    await withAgentServer(createDependencies(runtime.queryClaude), async (baseUrl) => {
      const response = await post(baseUrl, { projectPath: '/home/test/project', message: 'Run', sessionId: { $ne: null }, stream: false });
      assert.equal(response.status, 400);
      assert.equal(runtime.seen.length, 0);
    });
  });
});

test('a continued session runs under its own provider and project, as a chat send does', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-codex', 'codex', '/home/test/project', 'Codex one');
    const claudeCalls: unknown[] = [];
    const codexCalls: unknown[] = [];
    const dependencies = createDependencies(async (_command, options, writer) => {
      claudeCalls.push(options);
      writer.send(createNormalizedMessage({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0 }));
    });
    dependencies.queryCodex = async (_command, options, writer) => {
      codexCalls.push(options);
      writer.send(createNormalizedMessage({ kind: 'complete', provider: 'codex', sessionId: null, exitCode: 0 }));
    };
    await withAgentServer(dependencies, async (baseUrl) => {
      // No provider named: the row's, not the default.
      const continued = await post(baseUrl, { projectPath: '/home/test/project', message: 'More', sessionId: 'app-codex', stream: false });
      assert.equal(continued.status, 200);
      assert.deepEqual([claudeCalls.length, codexCalls.length], [0, 1]);

      // Another provider named: refused, not re-homed.
      const mismatched = await post(baseUrl, { projectPath: '/home/test/project', message: 'More', sessionId: 'app-codex', provider: 'claude', stream: false });
      assert.equal(mismatched.status, 400);
      assert.equal(claudeCalls.length, 0);

      // Another directory named: not that session.
      const elsewhere = await post(baseUrl, { projectPath: '/home/test/other', message: 'More', sessionId: 'app-codex', stream: false });
      assert.equal(elsewhere.status, 500);
      assert.match((await elsewhere.json() as { error: string }).error, /belongs to project/);
      assert.equal(codexCalls.length, 1);
    });
  });
});

test('a busy session is refused before anything is cloned', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createHeldRuntime();
    const dependencies = createDependencies(runtime.queryClaude);
    let clones = 0;
    dependencies.spawnProcess = (() => { clones += 1; throw new Error('no clone expected'); }) as unknown as AgentDependencies['spawnProcess'];
    await withAgentServer(dependencies, async (baseUrl) => {
      const first = post(baseUrl, { projectPath: '/home/test/project', message: 'Run it' });
      for (let i = 0; i < 50 && runtime.seen.length === 0; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      const [running] = chatRunRegistry.listRunningRuns();
      assert.ok(running);

      const retry = await post(baseUrl, { githubUrl: 'https://github.com/owner/repo.git', projectPath: '/home/test/project', message: 'Again', sessionId: running.sessionId, stream: false });
      assert.equal(retry.status, 409);
      assert.equal(clones, 0, 'the refusal comes before the clone step');

      runtime.release();
      await first;
    });
  });
});

test('a run a tab aborted ends without branching or opening a PR, and says so', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createHeldRuntime();
    let gitCalls = 0;
    const dependencies = createDependencies(async (command, options, writer) => {
      await runtime.queryClaude(command, options, writer);
    });
    dependencies.spawnProcess = (() => { gitCalls += 1; throw new Error('git should not run after an abort'); }) as unknown as AgentDependencies['spawnProcess'];
    await withAgentServer(dependencies, async (baseUrl) => {
      const responsePromise = post(baseUrl, { projectPath: '/home/test/project', message: 'Run it', createBranch: true, stream: false });
      for (let i = 0; i < 50 && runtime.seen.length === 0; i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      const [running] = chatRunRegistry.listRunningRuns();
      assert.ok(running);
      // What chat.abort does: the run completes as aborted; the runtime then returns.
      chatRunRegistry.completeRun(running.sessionId, { exitCode: 1, aborted: true, reason: 'engine_failed' });
      runtime.release();

      const response = await responsePromise;
      const body = await response.json() as { success: boolean; aborted?: boolean; branch?: unknown };
      assert.equal(body.success, false);
      assert.equal(body.aborted, true);
      assert.equal(body.branch, undefined);
      assert.equal(gitCalls, 0);
    });
  });
});

test('a non-streaming run answers with the assistant\'s replies, its token usage and the provider id', async () => {
  await withIsolatedDatabase(async () => {
    const dependencies = createDependencies(async (_command, _options, writer) => {
      writer.send(createNormalizedMessage({ kind: 'session_created', provider: 'claude', sessionId: 'native-7', newSessionId: 'native-7' }));
      writer.send(createNormalizedMessage({ kind: 'text', id: 'api-run-pong-row', provider: 'claude', sessionId: 'native-7', role: 'assistant', content: 'pong' }));
      writer.send(createNormalizedMessage({
        kind: 'status', text: 'token_budget', provider: 'claude', sessionId: 'native-7',
        tokenBudget: { used: 130, total: 160_000, inputTokens: 100, outputTokens: 30, cacheReadTokens: 60, cacheCreationTokens: 10, cacheTokens: 70, breakdown: { input: 100, output: 30 } },
      }));
      writer.send(createNormalizedMessage({ kind: 'complete', provider: 'claude', sessionId: 'native-7', exitCode: 0 }));
    });
    await withAgentServer(dependencies, async (baseUrl) => {
      const response = await post(baseUrl, { projectPath: '/home/test/project', message: 'ping', stream: false });
      const body = await response.json() as { providerSessionId: string; messages: Array<{ content: string }>; tokens: Record<string, number> };
      assert.equal(body.providerSessionId, 'native-7');
      assert.deepEqual(body.messages.map((message) => message.content), ['pong']);
      assert.deepEqual(body.tokens, { inputTokens: 100, outputTokens: 30, cacheReadTokens: 60, cacheCreationTokens: 10, totalTokens: 130 });
    });
  });
});
