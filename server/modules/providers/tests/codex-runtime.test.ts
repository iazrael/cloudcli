/**
 * The Codex runtime drives one turn over `codex app-server`.
 *
 * The fake below answers the three requests a turn makes and replays the
 * notifications a real turn sends, in the order and shape captured from a
 * live `codex app-server` session.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  codexAppServerTransport,
  type CodexAppServerHandlers,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import {
  codexRuntime,
  executeCodexSandboxCommand,
} from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { setCodexHostTaskSource } from '@/modules/providers/list/codex/codex-background-work.js';
import { closeCodexResidentSessions, listCodexResidentSessions } from '@/modules/providers/list/codex/codex-session-manager.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

import { isVolatileMessageId } from '../../../../shared/protocol/messageKinds.js';
import { codexSessionTitleService } from '../services/codex-session-title.service.js';

test.beforeEach((t) => { if ('mock' in t) t.mock.method(codexSessionTitleService, 'enqueue', async () => {}); });

const THREAD_ID = '01a0c4d2-a3c3-7510-8e3f-c36245fa5d9d';

// The tests below cover the short connection path, the one a conversation
// falls back to when the resident path is turned off. The resident path has
// its own tests, which turn it on for the duration of one test.
process.env.CLOUDCLI_CODEX_RESIDENT = '0';
const TURN_ID = '01a0c4d2-a3fe-7330-bb87-5a99871777d0';

type FakeServer = {
  calls: Array<{ method: string; params: any; options?: unknown }>;
  handlers: CodexAppServerHandlers;
  openOptions?: { env?: NodeJS.ProcessEnv; inheritEnv?: boolean };
  /** Whether the run closed the connection, which kills the real app-server process. */
  closed?: boolean;
  /** The inputs the fake engine holds in its queue, keyed by client message id. */
  queue: Map<string, { id: string; clientUserMessageId: string }>;
  /** Set when the engine is busy and keeps the input queued. */
  holdQueue?: boolean;
};

/**
 * Installs a fake app-server for the duration of one test and returns what it
 * was asked to do.
 */
function installFakeAppServer(
  t: any,
  script: (server: FakeServer) => void = replayOneTurn,
): FakeServer {
  const server: FakeServer = { calls: [], handlers: {}, closed: false, queue: new Map() };

  t.mock.method(codexAppServerTransport, 'open', async (
    handlers: CodexAppServerHandlers,
    openOptions?: { env?: NodeJS.ProcessEnv; inheritEnv?: boolean },
  ) => {
    server.handlers = handlers;
    server.openOptions = openOptions;
    return {
      async call(method: string, params: any, options?: unknown) {
        server.calls.push({ method, params, options });
        if (method === 'thread/start' || method === 'thread/resume') {
          // A thread takes the sandbox mode as a string; the policy object
          // belongs to a turn, and the engine ignores it here.
          assert.ok(
            params.sandbox === 'workspace-write' || params.sandbox === 'danger-full-access',
            `thread/${method} needs a sandbox mode, got ${JSON.stringify(params.sandbox)}`,
          );
          assert.equal(params.sandboxPolicy, undefined);
          return { thread: { id: THREAD_ID } };
        }
        if (method === 'thread/settings/update') {
          // A turn's settings take the policy object, which is tagged by its
          // type; a mode string is rejected by the engine.
          assert.ok(params.sandboxPolicy, 'thread/settings/update needs a sandbox policy');
          assert.equal(typeof params.sandboxPolicy.type, 'string');
          assert.equal(params.sandboxPolicy.mode, undefined);
          return {};
        }
        if (method === 'config/read') {
          return { config: { shell_environment_policy: { exclude: ['TEST_EXISTING_EXCLUDE'] } } };
        }
        if (method === 'command/exec') {
          return { exitCode: 0, stdout: 'sandbox output', stderr: '' };
        }
        if (method === 'turn/start') {
          // The server answers immediately and reports the turn's progress
          // through notifications.
          queueMicrotask(() => script(server));
          return { turn: { id: TURN_ID, status: 'inProgress' } };
        }
        if (method === 'thread/queue/add') {
          // The engine takes the input and, when the thread is idle, starts it
          // as a turn of its own: the consumption is reported before the turn.
          const id = `queued-${server.queue.size + 1}`;
          server.queue.set(params.clientUserMessageId, { id, clientUserMessageId: params.clientUserMessageId });
          if (server.holdQueue) {
            // A busy engine keeps the input queued.
            return { queuedSubmission: { id, input: params.input, clientUserMessageId: params.clientUserMessageId } };
          }
          queueMicrotask(() => {
            server.queue.delete(params.clientUserMessageId);
            server.handlers.onNotification?.('thread/queue/changed', { threadId: THREAD_ID } as any);
            script(server);
          });
          return { queuedSubmission: { id, input: params.input, clientUserMessageId: params.clientUserMessageId } };
        }
        if (method === 'thread/queue/list') {
          return { data: [...server.queue.values()], nextCursor: null };
        }
        if (method === 'thread/compact/start') {
          // codex-cli 0.163.0 answers with an empty object, then runs the
          // compaction as a turn of its own.
          queueMicrotask(() => replayCompaction(server));
          return {};
        }
        if (method === 'thread/queue/start') {
          // A busy engine refuses to start a queued input, and an input the
          // engine already took is no longer there to start.
          throw new Error('thread already has an active or pending turn');
        }
        if (method === 'thread/queue/delete') {
          for (const [key, item] of server.queue) {
            if (item.id === params.queuedSubmissionId) {
              server.queue.delete(key);
            }
          }
          return {};
        }
        return {};
      },
      close() { server.closed = true; },
    };
  });

  return server;
}

/** The notification sequence one short turn produces. */
function replayOneTurn(server: FakeServer): void {
  const notify = (method: string, params: unknown) => server.handlers.onNotification?.(method, params as any);
  notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
  notify('item/completed', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: {
      type: 'agentMessage',
      id: 'msg_02c8dbf5b38a0554016ab15ce008f487d08eeca161bae5821c',
      text: 'done',
      phase: 'final_answer',
    },
  });
  notify('thread/tokenUsage/updated', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    tokenUsage: { total: { totalTokens: 15620, inputTokens: 15614, outputTokens: 6 }, modelContextWindow: 258400 },
  });
  notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
}

/** The notification sequence of a compaction turn, as captured from codex-cli 0.163.0. */
function replayCompaction(server: FakeServer): void {
  const notify = (method: string, params: unknown) => server.handlers.onNotification?.(method, params as any);
  notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
  notify('item/started', { threadId: THREAD_ID, turnId: TURN_ID, item: { type: 'contextCompaction', id: 'compaction-1' } });
  notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: { type: 'contextCompaction', id: 'compaction-1' } });
  notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
}

/** Waits for something the run produces asynchronously. */
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the expected value never arrived');
}

function runtimeContext(resumed: boolean): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => resumed ? THREAD_ID : null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    // The runtime's rows are already normalized shapes; passing them straight
    // through keeps this test about the transport, not the renderer.
    normalizeMessage: (row: any) => [row],
    isProviderInstalled: async () => true,
  };
}

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      const server = installFakeAppServer(t);
      const messages: any[] = [];

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(resumed));

      const opener = server.calls.find((call) => call.method === 'thread/start' || call.method === 'thread/resume');
      assert.ok(opener);
      assert.equal(opener.method, resumed ? 'thread/resume' : 'thread/start');
      assert.equal(opener.params.sandbox, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(
        opener.params.approvalPolicy,
        permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request',
      );

      const turn = server.calls.find((call) => call.method === 'turn/start');
      assert.ok(turn);
      assert.deepEqual(turn.params.input, [{ type: 'text', text: 'hey there', text_elements: [] }]);

      assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message) => message.kind === 'error'));
    });
  }
}

test('a resident round is written to the engine queue instead of starting a turn', async (t) => {
  const server = installFakeAppServer(t);
  const messages: any[] = [];
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  try {
    await codexRuntime.run('hey there', {
      sessionId: 'resident-session',
      cwd: process.cwd(),
    }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(false));

    assert.ok(!server.calls.some((call) => call.method === 'turn/start'));
    const added = server.calls.find((call) => call.method === 'thread/queue/add');
    assert.ok(added, 'the round must be queued');
    assert.deepEqual(added.params.input, [{ type: 'text', text: 'hey there', text_elements: [] }]);

    assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 0));
    assert.ok(!messages.some((message) => message.kind === 'error'));
  } finally {
    process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    closeCodexResidentSessions();
  }
});

test('a resident round announces that it waits for the engine and that it started', async (t) => {
  const server = installFakeAppServer(t);
  // The engine is busy with something else, so it holds the input.
  server.holdQueue = true;
  const messages: any[] = [];
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  try {
    const run = codexRuntime.run('hey there', {
      sessionId: 'resident-activity-session',
      cwd: process.cwd(),
    }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(false));

    // The announcement follows the submission, so it arrives with the round.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (messages.some((message) => message.kind === 'status' && message.text === 'activity_state')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const queued = messages
      .filter((message) => message.kind === 'status' && message.text === 'activity_state')
      .map((message) => message.activityState);
    assert.equal(queued[0].queued, true, 'the engine holds the round before its turn');

    // The engine takes the input and starts the round's turn.
    server.queue.clear();
    server.handlers.onNotification?.('thread/queue/changed', { threadId: THREAD_ID } as any);
    server.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'inProgress' },
    } as any);
    server.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'completed', error: null },
    } as any);
    await run;

    const states = messages
      .filter((message) => message.kind === 'status' && message.text === 'activity_state')
      .map((message) => message.activityState);
    assert.equal(states.at(-1).queued, false, 'the engine took the round');
  } finally {
    process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    closeCodexResidentSessions();
  }
});

test('a resident conversation keeps its process and reuses it for the next round', async (t) => {
  const server = installFakeAppServer(t);
  const messages: any[] = [];
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  try {
    for (const command of ['first message', 'second message']) {
      await codexRuntime.run(command, {
        sessionId: 'resident-session',
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(false));
    }

    assert.equal(server.calls.filter((call) => call.method === 'thread/start').length, 1);
    assert.equal(server.closed, false, 'the process must stay alive between rounds');
    const queued = server.calls.filter((call) => call.method === 'thread/queue/add');
    assert.equal(queued.length, 2);
    assert.equal(queued[0].params.input[0].text, 'first message');
    assert.equal(queued[1].params.input[0].text, 'second message');
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 2);
  } finally {
    process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    closeCodexResidentSessions();
  }
});

test('stopping a finished round reports that there is nothing to stop', async (t) => {
  const server = installFakeAppServer(t);
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  try {
    await codexRuntime.run('hey there', {
      sessionId: 'resident-stop-session',
      cwd: process.cwd(),
    }, { isWebSocketWriter: true, send: () => {} }, runtimeContext(false));

    assert.equal(await codexRuntime.abort('resident-stop-session'), false);
  } finally {
    process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    closeCodexResidentSessions();
  }
});

test('stopping a running resident round interrupts the turn the engine started', async (t) => {
  const server = installFakeAppServer(t, (fake) => {
    // The turn stays in flight, so the stop has a turn to interrupt.
    fake.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'inProgress' },
    } as any);
  });
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  try {
    const run = codexRuntime.run('hey there', {
      sessionId: 'resident-running-session',
      cwd: process.cwd(),
    }, { isWebSocketWriter: true, send: () => {} }, runtimeContext(false));

    await waitFor(() => server.calls.some((call) => call.method === 'thread/queue/add'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(await codexRuntime.abort('resident-running-session'), true);
    await waitFor(() => server.calls.some((call) => call.method === 'turn/interrupt'));
    assert.equal(
      server.calls.find((call) => call.method === 'turn/interrupt')?.params.turnId,
      TURN_ID,
    );

    // The engine reports the interrupted turn, which ends the round.
    server.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'interrupted', error: null },
    } as any);
    await run;
  } finally {
    process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    closeCodexResidentSessions();
  }
});

test('an approval the engine asks for with no round in flight is answered', async (t) => {
  const server = installFakeAppServer(t);
  const published: any[] = [];
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  try {
    await codexRuntime.run('hey there', {
      sessionId: 'resident-approval-session',
      cwd: process.cwd(),
    }, { isWebSocketWriter: true, send: () => {} }, {
      ...runtimeContext(false),
      publishSessionEvent: (_appSessionId: string, message: any) => published.push(message),
    } as never);

    // The engine asks for an approval while no round waits: the request must
    // not be answered as "not implemented".
    const answer = server.handlers.onRequest?.('item/commandExecution/requestApproval', {
      itemId: 'item-1',
      command: 'ls -la',
    } as any);

    assert.ok(answer !== undefined, 'the request must get an answer');
    const card = published.find((message) => message.kind === 'permission_request');
    assert.ok(card, 'the approval card must reach the session');
    assert.equal(card.toolName, 'Bash');
    codexRuntime.permissions.resolve(card.requestId, { allow: true });
    assert.deepEqual(await answer, { decision: 'accept' });
  } finally {
    process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    closeCodexResidentSessions();
  }
});

test('a turn the engine starts by itself is published to the session, not to the round', async (t) => {
  const server = installFakeAppServer(t);
  const messages: any[] = [];
  const published: Array<{ appSessionId: string; message: any }> = [];
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  try {
    await codexRuntime.run('hey there', {
      sessionId: 'resident-engine-session',
      cwd: process.cwd(),
    }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, {
      ...runtimeContext(false),
      publishSessionEvent: (appSessionId, message) => published.push({ appSessionId, message }),
    });

    // The engine reports in the background, after the round is over.
    server.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: 'engine-turn', status: 'inProgress' },
    } as any);
    server.handlers.onNotification?.('item/agentMessage/delta', {
      threadId: THREAD_ID,
      turnId: 'engine-turn',
      delta: 'the background report',
    } as any);

    assert.ok(published.length > 0, 'the report must reach the session');
    assert.equal(published[0].appSessionId, 'resident-engine-session');
    assert.equal(published[0].message.kind, 'stream_delta');
    assert.equal(published[0].message.content, 'the background report');
    // The round's own events stay in the round.
    assert.ok(!messages.some((message) => message.content === 'the background report'));
  } finally {
    process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    closeCodexResidentSessions();
  }
});

test('an image-only turn sends a fallback prompt with the attachment', async (t) => {
  const server = installFakeAppServer(t);
  const messages: any[] = [];
  // Image sources must sit inside the run's working directory (the trust
  // boundary buildCodexInputItems enforces), so the fixture lives under cwd.
  const imageDirectory = await mkdtemp(path.join(process.cwd(), '.codex-image-test-'));
  const imagePath = path.join(imageDirectory, 'shot.png');
  await writeFile(imagePath, 'png');

  try {
    await codexRuntime.run('', {
      cwd: process.cwd(),
      images: [{ path: imagePath, mimeType: 'image/png' }],
    }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(false));

    const turn = server.calls.find((call) => call.method === 'turn/start');
    assert.ok(turn, 'the turn must start');
    assert.deepEqual(turn.params.input, [
      { type: 'text', text: 'Please analyze the attached image(s).', text_elements: [] },
      { type: 'localImage', path: imagePath },
    ]);
    assert.ok(!messages.some((message) => message.kind === 'error'));
  } finally {
    await rm(imageDirectory, { recursive: true, force: true });
  }
});

test('the live reply carries the item id the rollout will record', async (t) => {
  installFakeAppServer(t);
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const reply = messages.find((message) => message.type === 'assistant');
  assert.ok(reply, 'the turn must produce an assistant row');
  assert.equal(reply.uuid, 'msg_02c8dbf5b38a0554016ab15ce008f487d08eeca161bae5821c');
});

test('streamed prose rides stream_delta and lands as exactly one row', async (t) => {
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/started', { item: { type: 'agentMessage', id: 'msg_stream', text: '' } });
    notify('item/agentMessage/delta', { itemId: 'msg_stream', delta: 'par' });
    notify('item/agentMessage/delta', { itemId: 'msg_stream', delta: 'tial' });
    notify('item/completed', { item: { type: 'agentMessage', id: 'msg_stream', text: 'partial answer' } });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  // The fragments are stream frames, which the client grows into one
  // placeholder. Sending them as text rows instead appends one message per
  // fragment — which is exactly what shipped and had to be undone.
  assert.deepEqual(
    messages.filter((message) => message.kind === 'stream_delta').map((message) => message.content),
    ['par', 'tial'],
  );
  const replies = messages.filter((message) => message.type === 'assistant');
  assert.equal(replies.length, 1, 'a streamed reply must produce exactly one transcript row');
  assert.equal(replies[0].uuid, 'msg_stream');
  assert.equal(replies[0].message.content, 'partial answer');
});

test('an item that starts empty is not announced before it has content', async (t) => {
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    // A prompt echo announced on both start and completion would be appended
    // twice; only the completion is forwarded.
    const userMessage = {
      type: 'userMessage',
      id: '01a0c4d2-b0a4-7991-85e5-931b865e6ed0',
      content: [{ type: 'text', text: 'hey there', text_elements: [] }],
    };
    notify('item/started', { item: userMessage });
    notify('item/completed', { item: userMessage });
    // A shell command is worth showing while it runs, so both are forwarded
    // and the client merges them on the shared tool id.
    const command = { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'ls'" };
    notify('item/started', { item: { ...command, status: 'inProgress' } });
    notify('item/completed', { item: { ...command, status: 'completed', aggregatedOutput: 'a.txt\n', exitCode: 0 } });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  assert.equal(messages.filter((message) => message.type === 'user').length, 1);
  assert.equal(messages.filter((message) => message.type === 'tool_use').length, 2);
  assert.deepEqual(
    [...new Set(messages.filter((message) => message.type === 'tool_use').map((row) => row.toolCallId))],
    ['exec-1'],
  );
});

test('retry notifications keep the turn running and do not poison a successful completion', async (t) => {
  installFakeAppServer(t, (fake) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      fake.handlers.onNotification?.('error', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        error: { message: `Reconnecting... ${attempt}/5` },
        willRetry: true,
      });
    }
    replayOneTurn(fake);
  });
  const messages: any[] = [];
  await codexRuntime.run('hey there', { sessionId: 'app-session' }, {
    send: (message) => messages.push(message),
  }, runtimeContext(true));

  assert.equal(messages.filter((message) => message.kind === 'error').length, 0);
  assert.ok(messages.some((message) => message.type === 'assistant'));
  assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 0));
});

test('a non-retry error and failed completion surface the original cause only once', async (t) => {
  installFakeAppServer(t, (fake) => {
    const error = { message: 'usage limit reached' };
    for (let attempt = 0; attempt < 2; attempt++) {
      fake.handlers.onNotification?.('error', {
        threadId: THREAD_ID, turnId: TURN_ID, error, willRetry: false,
      });
    }
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'failed', error },
    });
  });
  const messages: any[] = [];
  await codexRuntime.run('hey there', { sessionId: 'app-session' }, {
    send: (message) => messages.push(message),
  }, runtimeContext(true));

  assert.deepEqual(messages.filter((message) => message.kind === 'error').map((message) => message.content),
    ['usage limit reached']);
  assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 1));
});

for (const scenario of [
  { name: 'retry exhaustion', params: { error: { message: 'connection failed' }, willRetry: true },
    turn: { status: 'failed', error: { message: 'retry limit reached' } }, expected: ['retry limit reached'], exitCode: 1 },
  { name: 'missing completion cause', params: { error: { message: 'connection failed' }, willRetry: false },
    turn: { status: 'failed', error: null }, expected: ['connection failed'], exitCode: 1 },
  { name: 'interruption after a terminal error', params: { error: { message: 'usage limit reached' }, willRetry: false },
    turn: { status: 'interrupted', error: null }, expected: ['usage limit reached'], exitCode: 1 },
  { name: 'legacy flat error', params: { message: 'legacy failure' },
    turn: { status: 'failed', error: null }, expected: ['legacy failure'], exitCode: 1 },
  { name: 'malformed error', params: { error: { message: ' ' }, message: '' },
    turn: { status: 'failed', error: null }, expected: ['Codex reported an error.'], exitCode: 1 },
  { name: 'subagent error', params: { threadId: 'another-thread', error: { message: 'subagent failure' }, willRetry: false },
    turn: { status: 'completed', error: null }, expected: [], exitCode: 0 },
]) {
  test(`Codex handles ${scenario.name} without hiding or duplicating failures`, async (t) => {
    installFakeAppServer(t, (fake) => {
      fake.handlers.onNotification?.('error', { threadId: THREAD_ID, turnId: TURN_ID, ...scenario.params });
      fake.handlers.onNotification?.('turn/completed', {
        threadId: THREAD_ID, turn: { id: TURN_ID, ...scenario.turn },
      });
    });
    const messages: any[] = [];
    await codexRuntime.run('hey there', { sessionId: 'app-session' }, {
      send: (message) => messages.push(message),
    }, runtimeContext(true));

    assert.deepEqual(messages.filter((message) => message.kind === 'error').map((message) => message.content), scenario.expected);
    assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === scenario.exitCode));
  });
}

test('a failed turn surfaces the error and exits non-zero', async (t) => {
  installFakeAppServer(t, (fake) => {
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'failed', error: { message: 'usage limit reached' } },
    } as any);
  });
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const errors = messages.filter((message) => message.kind === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].content, 'usage limit reached');
  assert.equal(
    errors[0].id,
    `${TURN_ID}_error`,
    'the failure row is named after the turn, so the persisted copy replaces it',
  );
  assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 1));
});

/**
 * The failure row is named after the turn it belongs to.
 *
 * The rollout records the same failure on the turn's closing record, and the
 * history read turns it into a row with this id. Both sides must agree, or
 * the transcript shows the failure twice — once live, once from the file —
 * and the client cannot tell them apart.
 */
test('the failure notification names its row after the turn', async (t) => {
  installFakeAppServer(t, (fake) => {
    fake.handlers.onNotification?.('error', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      error: { message: 'connection failed' },
      willRetry: false,
    });
    // The closing report carries no cause of its own, so the row can only
    // have come from the notification.
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'failed', error: null },
    });
  });
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const errors = messages.filter((message) => message.kind === 'error');
  assert.equal(errors.length, 1, 'the failure is reported once');
  assert.equal(errors[0].content, 'connection failed');
  assert.equal(errors[0].id, `${TURN_ID}_error`);
});

test('an interrupted turn surfaces as an error, not a silent success', async (t) => {
  // Codex reports a usage-limit, user, or engine-internal interrupt as status
  // "interrupted" rather than "failed" — on codex 0.155 a spawned agent
  // finishing mid-turn aborted the whole agent tree this way. Treating it as a
  // normal completion hid the abort from the user and recorded the run as
  // engine_completed.
  installFakeAppServer(t, (fake) => {
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'interrupted', error: null },
    } as any);
  });
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  assert.ok(messages.some((message) => message.kind === 'error' && /interrupted/i.test(String(message.content))));
  assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 1));

  // An interrupted turn is recorded as an abort, and an abort carries no
  // cause: there is no persisted failure row to replace the live one. The live
  // row must therefore not claim the turn's identity.
  const errors = messages.filter((message) => message.kind === 'error');
  assert.equal(errors.length, 1);
  assert.notEqual(errors[0].id, `${TURN_ID}_error`, 'an abort is not a recorded failure');
  assert.ok(isVolatileMessageId(errors[0].id), 'the row belongs to this run alone');
});

test('a stop the user asked for stays silent when codex reports the interrupt back', async (t) => {
  // `turn/interrupt` comes back as status "interrupted" too. The abort path
  // already flagged the session, so this must not raise the usage-limit error
  // (or a failed-run notification) for a stop the user made themselves. The
  // aborted-session guard swallows every later notification, and the run
  // settles through the connection teardown — replayed here as onExit.
  installFakeAppServer(t, (fake) => {
    fake.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'inProgress' },
    } as any);
    codexRuntime.abort('app-session');
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'interrupted', error: null },
    } as any);
    fake.handlers.onExit?.('connection closed after abort');
  });
  const messages: any[] = [];

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  assert.ok(!messages.some((message) => message.kind === 'error'), 'a user stop must not surface the usage-limit error');
});

test('a user stop that closes the app-server connection resolves as interrupted', async (t) => {
  installFakeAppServer(t, (fake) => {
    fake.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'inProgress' },
    } as any);
    codexRuntime.abort('app-session-normal-close');
    fake.handlers.onExit?.('connection closed after abort');
  });

  const result = await codexRuntime.run('hey there', {
    sessionId: 'app-session-normal-close',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: () => {} }, runtimeContext(true));

  assert.deepEqual(result, { engineTurnId: TURN_ID, terminalStatus: 'interrupted' });
});

test('a delayed aborted run does not read or complete over its successor session', async (t) => {
  const runs: Array<{ handlers: CodexAppServerHandlers; connectionIndex: number }> = [];
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
  const secondStartedPromise = new Promise<void>((resolve) => { secondStarted = resolve; });
  t.mock.method(codexAppServerTransport, 'open', async (handlers: CodexAppServerHandlers) => {
    const connectionIndex = runs.length;
    runs.push({ handlers, connectionIndex });
    return {
      async call(method: string) {
        if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: THREAD_ID } };
        if (method === 'turn/start') {
          queueMicrotask(() => {
            handlers.onNotification?.('turn/started', {
              threadId: THREAD_ID,
              turn: { id: `turn-${connectionIndex}`, status: 'inProgress' },
            } as any);
            if (connectionIndex === 0) firstStarted();
            else secondStarted();
          });
          return { turn: { id: `turn-${connectionIndex}`, status: 'inProgress' } };
        }
        return {};
      },
      close() {
        handlers.onExit?.('connection closed after abort');
      },
    };
  });
  const firstMessages: any[] = [];
  const firstRun = codexRuntime.run('first', {
    sessionId: 'app-session-successor', cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => firstMessages.push(message) }, runtimeContext(true));
  await firstStartedPromise;

  assert.equal(await codexRuntime.abort('app-session-successor'), true);
  const secondMessages: any[] = [];
  const secondRun = codexRuntime.run('second', {
    sessionId: 'app-session-successor', cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => secondMessages.push(message) }, runtimeContext(true));
  await secondStartedPromise;

  const firstResult = await firstRun;
  assert.equal(firstResult.terminalStatus, 'interrupted');
  assert.ok(!firstMessages.some((message) => message.kind === 'complete'), 'aborted predecessor must not send a second completion');

  assert.equal(await codexRuntime.abort('app-session-successor'), true);
  const secondResult = await secondRun;
  assert.equal(secondResult.terminalStatus, 'interrupted');
  assert.ok(!secondMessages.some((message) => message.kind === 'complete'));
});

test('Codex runtime returns the actual failed turn id and terminal status', async (t) => {
  installFakeAppServer(t, (fake) => {
    fake.handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' },
    } as any);
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'failed', error: { message: 'engine rejected the turn' } },
    } as any);
  });

  const acceptedTurnIds: string[] = [];
  const result = await codexRuntime.run('hey there', {
    sessionId: 'app-session-terminal-result',
    cwd: process.cwd(),
    taskContinuationLifecycle: { onEngineTurnStarted: (turnId: string) => acceptedTurnIds.push(turnId) },
  }, { isWebSocketWriter: true, send: () => {} }, runtimeContext(true));

  assert.deepEqual(result, { engineTurnId: TURN_ID, terminalStatus: 'failed' });
  assert.deepEqual(acceptedTurnIds, [TURN_ID]);
});

test('an approval waits for the user and carries the command it is about', async (t) => {
  let answer: Promise<unknown> | undefined;
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    // A command approval is asked before the item is ever announced, and
    // carries the command it wants to run (captured from a real request).
    answer = Promise.resolve(fake.handlers.onRequest?.('item/commandExecution/requestApproval', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'exec-1',
      startedAtMs: 0,
      kind: 'command',
      reason: 'needs network access',
      command: "/bin/zsh -lc 'rm -rf /etc'",
      cwd: '/tmp',
    } as any));
    // The turn only ends once the approval has been answered.
    void answer.then(() => notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'completed', error: null },
    }));
  });
  const messages: any[] = [];

  const run = codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  // The prompt reaches the client before anything answers it.
  const prompt = await waitFor(() => messages.find((message) => message.kind === 'permission_request'));
  assert.equal(prompt.toolName, 'Bash');
  assert.deepEqual(JSON.parse(String(prompt.input)), { command: 'rm -rf /etc' });
  assert.equal(prompt.context.reason, 'needs network access');
  assert.equal(prompt.canInterrupt, true);

  // It is listed as pending for the session until it is answered.
  assert.equal(codexRuntime.permissions.listPending('app-session').length, 1);

  codexRuntime.permissions.resolve(prompt.requestId, { allow: true });
  await run;

  assert.deepEqual(await answer, { decision: 'accept' });
  assert.ok(messages.some((message) => message.kind === 'permission_resolved' && message.requestId === prompt.requestId));
  assert.equal(codexRuntime.permissions.listPending('app-session').length, 0);
});

test('an approval asked by a running agent says which agent asked', async (t) => {
  let answer: Promise<unknown> | undefined;
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    // The request comes from the agent's own thread on the shared connection.
    answer = Promise.resolve(fake.handlers.onRequest?.('item/commandExecution/requestApproval', {
      threadId: 'thread_child_1', turnId: 'child-turn', itemId: 'child-exec', command: "/bin/zsh -lc 'rm x'",
    } as any));
    void answer.then(() => notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } }));
  });
  const messages: any[] = [];
  const run = codexRuntime.run('go', { sessionId: 'app-session-origin', cwd: process.cwd() },
    { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const prompt = await waitFor(() => messages.find((message) => message.kind === 'permission_request'));
  assert.deepEqual(prompt.context.subagent, { toolUseId: 'call_spawn_1', description: 'Standards' });
  codexRuntime.permissions.resolve(prompt.requestId, { allow: true });
  await run;
});

test('remembering an approval grants it for the whole session', async (t) => {
  let answer: Promise<unknown> | undefined;
  installFakeAppServer(t, (fake) => {
    answer = Promise.resolve(fake.handlers.onRequest?.('item/fileChange/requestApproval', {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'exec-2', startedAtMs: 0,
    } as any));
    void answer.then(() => fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null },
    } as any));
  });
  const messages: any[] = [];

  const run = codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const prompt = await waitFor(() => messages.find((message) => message.kind === 'permission_request'));
  codexRuntime.permissions.resolve(prompt.requestId, { allow: true, rememberEntry: 'codex:fileChange' });
  await run;

  assert.deepEqual(await answer, { decision: 'acceptForSession' });
});

test('a denied approval is declined, and one nobody answers is retracted', async (t) => {
  let denied: Promise<unknown> | undefined;
  installFakeAppServer(t, (fake) => {
    denied = Promise.resolve(fake.handlers.onRequest?.('item/commandExecution/requestApproval', {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'exec-3', startedAtMs: 0, kind: 'command',
    } as any));
    void denied.then(() => fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null },
    } as any));
  });
  const messages: any[] = [];

  const run = codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const prompt = await waitFor(() => messages.find((message) => message.kind === 'permission_request'));
  codexRuntime.permissions.resolve(prompt.requestId, { allow: false });
  await run;
  assert.deepEqual(await denied, { decision: 'decline' });

  // A run that ends with a prompt still open must retract it, or the card
  // hangs in the transcript forever.
  let orphan: Promise<unknown> | undefined;
  const second: any[] = [];
  installFakeAppServer(t, (fake) => {
    orphan = Promise.resolve(fake.handlers.onRequest?.('item/commandExecution/requestApproval', {
      threadId: THREAD_ID, turnId: TURN_ID, itemId: 'exec-4', startedAtMs: 0, kind: 'command',
    } as any));
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null },
    } as any);
  });

  await codexRuntime.run('hey there', {
    sessionId: 'app-session-2',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => second.push(message) }, runtimeContext(true));

  assert.ok(second.some((message) => message.kind === 'permission_cancelled'));
  assert.deepEqual(await orphan, { decision: 'decline' });
  assert.equal(codexRuntime.permissions.listPending('app-session-2').length, 0);
});

test('a request that is not an approval is reported as unimplemented', async (t) => {
  let answer: unknown = 'unset';
  installFakeAppServer(t, (fake) => {
    answer = fake.handlers.onRequest?.('mcpServer/elicitation/request', { threadId: THREAD_ID } as any);
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null },
    } as any);
  });

  await codexRuntime.run('hey there', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: () => {} }, runtimeContext(true));

  assert.equal(await answer, undefined);
});

test('task MCP form elicitation is declined instead of treating yes/no as form input', async (t) => {
  let answer: Promise<unknown> | undefined;
  installFakeAppServer(t, (fake) => {
    answer = Promise.resolve(fake.handlers.onRequest?.('mcpServer/elicitation/request', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: 'cloudcli_task_continuations',
      mode: 'form',
      message: 'Provide the deployment confirmation code.',
      requestedSchema: {
        type: 'object',
        properties: { confirmation: { type: 'string' } },
        required: ['confirmation'],
      },
    } as any));
    void answer.then(() => fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null },
    } as any));
  });
  const messages: any[] = [];
  const run = codexRuntime.run('hey there', {
    sessionId: 'app-session-mcp-approval',
    cwd: process.cwd(),
    taskExecutionContext: { token: 'test-run-capability' },
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));
  await run;

  assert.deepEqual(await answer, { action: 'decline', content: null });
  assert.equal(messages.some((message) => message.kind === 'permission_request'), false);
});

test('an unrelated MCP server elicitation is not accepted as task approval', async (t) => {
  let answer: unknown = 'unset';
  installFakeAppServer(t, (fake) => {
    answer = fake.handlers.onRequest?.('mcpServer/elicitation/request', {
      threadId: THREAD_ID,
      serverName: 'external_server',
      mode: 'url',
      message: 'Open external URL?',
    } as any);
    fake.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null },
    } as any);
  });
  const messages: any[] = [];
  await codexRuntime.run('hey there', {
    sessionId: 'app-session-external-elicitation',
    cwd: process.cwd(),
    taskExecutionContext: { token: 'test-run-capability' },
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  assert.equal(await answer, undefined);
  assert.equal(messages.some((message) => message.kind === 'permission_request'), false);
});

test('thread/start and thread/resume supply defer_mailbox_preemption config', async (t) => {
  const startServer = installFakeAppServer(t);
  await codexRuntime.run('test start', {
    sessionId: 'session-start',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: () => {} }, runtimeContext(false));

  const startCall = startServer.calls.find((c) => c.method === 'thread/start');
  assert.ok(startCall, 'thread/start was called');
  assert.equal(startCall.params?.config?.['features.defer_mailbox_preemption'], true);

  const resumeServer = installFakeAppServer(t);
  await codexRuntime.run('test resume', {
    sessionId: 'session-resume',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: () => {} }, runtimeContext(true));

  const resumeCall = resumeServer.calls.find((c) => c.method === 'thread/resume');
  assert.ok(resumeCall, 'thread/resume was called');
  assert.equal(resumeCall.params?.config?.['features.defer_mailbox_preemption'], true);
});

test('resumed Codex turns pass a task capability only to stdio MCP and exclude it from shell commands', async (t) => {
  const server = installFakeAppServer(t);
  const rawToken = 'trc_fake_run_capability_only_for_this_test';
  const previousApiKey = process.env.API_KEY;
  process.env.API_KEY = 'fake-api-key-for-task-MCP-test';

  try {
    await codexRuntime.run('continue', {
    sessionId: 'app-session',
    cwd: process.cwd(),
    taskExecutionContext: {
      token: rawToken,
      context: {
        userId: 5,
        sessionId: 'app-session',
        runId: 'run-bound-to-host',
        cwd: process.cwd(),
        sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
        approvalPolicy: 'on-request',
      },
    },
    }, { isWebSocketWriter: true, send: () => {} }, runtimeContext(true));

    const resume = server.calls.find((call) => call.method === 'thread/resume');
    assert.ok(resume);
    assert.equal(JSON.stringify(resume.params).includes(rawToken), false);
    assert.equal(JSON.stringify(resume.params).includes('fake-api-key-for-task-MCP-test'), false);
    assert.deepEqual(
      resume.params.config['mcp_servers.cloudcli_task_continuations'].env_vars,
      ['CLOUDCLI_TASK_API_URL', 'CLOUDCLI_TASK_API_KEY', 'CLOUDCLI_TASK_RUN_CONTEXT'],
    );
    const mcpCommand = resume.params.config['mcp_servers.cloudcli_task_continuations'];
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
    assert.ok([
      path.join(repositoryRoot, 'server/modules/task-continuations/cli/task-continuations-mcp.ts'),
      path.join(repositoryRoot, 'server/modules/task-continuations/cli/task-continuations-mcp.js'),
    ].includes(mcpCommand.args.at(-1)));
    assert.ok(resume.params.config['shell_environment_policy.exclude'].includes('TEST_EXISTING_EXCLUDE'));
    assert.ok(resume.params.config['shell_environment_policy.exclude'].includes('CLOUDCLI_TASK_API_KEY'));
    assert.ok(resume.params.config['shell_environment_policy.exclude'].includes('CLOUDCLI_TASK_RUN_CONTEXT'));
    const configRead = server.calls.find((call) => call.method === 'config/read');
    assert.deepEqual(configRead?.params, { includeLayers: false, cwd: process.cwd() });
    assert.equal(server.openOptions?.env?.CLOUDCLI_TASK_RUN_CONTEXT, rawToken);
    assert.equal(server.openOptions?.env?.CLOUDCLI_TASK_API_KEY, 'fake-api-key-for-task-MCP-test');
  } finally {
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
  }
});

test('detached Codex command execution keeps the original sandbox and strips task credentials', async (t) => {
  const server = installFakeAppServer(t);
  const previousContext = process.env.CLOUDCLI_TASK_RUN_CONTEXT;
  const previousRegistrationToken = process.env.CLOUDCLI_REGISTRATION_TOKEN;
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousApiKey = process.env.API_KEY;
  process.env.API_KEY = 'fake-api-key-for-detached-task-test';
  process.env.CLOUDCLI_TASK_RUN_CONTEXT = 'fake-task-run-capability';
  process.env.CLOUDCLI_REGISTRATION_TOKEN = 'fake-registration-token';
  process.env.JWT_SECRET = 'fake-jwt-secret';
  try {
    const result = await executeCodexSandboxCommand({
      command: ['node', '-e', 'console.log("sandbox output")'],
      cwd: process.cwd(),
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });

    assert.deepEqual(result, { exitCode: 0, stdout: 'sandbox output', stderr: '' });
    const call = server.calls.find((entry) => entry.method === 'command/exec');
    assert.deepEqual(call?.options, { timeoutMs: 24 * 60 * 60 * 1000 });
    assert.deepEqual(call?.params, {
      command: ['node', '-e', 'console.log("sandbox output")'],
      cwd: process.cwd(),
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      env: {
        API_KEY: null,
        CLOUDCLI_TASK_API_KEY: null,
        CLOUDCLI_TASK_BRIDGE: null,
        CLOUDCLI_TASK_RUN_CONTEXT: null,
        CLOUDCLI_REGISTRATION_TOKEN: null,
        CLOUDCLI_TASK_TOKEN: null,
        JWT_SECRET: null,
      },
      timeoutMs: 24 * 60 * 60 * 1000,
      // The id a host stop names in `command/exec/terminate`.
      processId: 'cloudcli-task',
    });
    assert.equal(server.openOptions?.inheritEnv, false);
    assert.equal(server.openOptions?.env?.CLOUDCLI_TASK_RUN_CONTEXT, undefined);
    assert.equal(server.openOptions?.env?.API_KEY, undefined);
    assert.equal(server.openOptions?.env?.CLOUDCLI_TASK_API_KEY, undefined);
    assert.equal(server.openOptions?.env?.CLOUDCLI_REGISTRATION_TOKEN, undefined);
    assert.equal(server.openOptions?.env?.JWT_SECRET, undefined);
  } finally {
    if (previousContext === undefined) delete process.env.CLOUDCLI_TASK_RUN_CONTEXT;
    else process.env.CLOUDCLI_TASK_RUN_CONTEXT = previousContext;
    if (previousRegistrationToken === undefined) delete process.env.CLOUDCLI_REGISTRATION_TOKEN;
    else process.env.CLOUDCLI_REGISTRATION_TOKEN = previousRegistrationToken;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
  }
});

test('subagent notifications with different threadId are ignored and do not settle parent turn', async (t) => {
  const SUBAGENT_THREAD_ID = 'subagent-thread-123';
  const SUBAGENT_TURN_ID = 'subagent-turn-456';
  let parentTurnSettledEarly = false;
  let parentTurnFinished = false;

  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);

    // 1. Parent turn starts
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });

    // 2. Subagent starts its turn
    notify('turn/started', { threadId: SUBAGENT_THREAD_ID, turn: { id: SUBAGENT_TURN_ID, status: 'inProgress' } });

    // 3. Subagent emits deltas (both camelCase and snake_case), completed item, and token usage
    notify('item/agentMessage/delta', { threadId: SUBAGENT_THREAD_ID, turnId: SUBAGENT_TURN_ID, delta: 'subagent typing...' });
    notify('item/agentMessage/delta', { thread_id: SUBAGENT_THREAD_ID, turnId: SUBAGENT_TURN_ID, delta: 'subagent snake typing...' });
    notify('item/completed', {
      threadId: SUBAGENT_THREAD_ID,
      item: {
        id: 'msg_subagent_item_1',
        type: 'agentMessage',
        text: 'subagent private summary',
      },
    });
    notify('thread/tokenUsage/updated', { threadId: SUBAGENT_THREAD_ID, turnId: SUBAGENT_TURN_ID, tokenUsage: { total: { totalTokens: 999 } } });

    // 4. Subagent completes (with interrupted status, which previously killed the whole parent session!)
    notify('turn/completed', { threadId: SUBAGENT_THREAD_ID, turn: { id: SUBAGENT_TURN_ID, status: 'interrupted', error: null } });

    // Queue a check to ensure run hasn't prematurely settled
    setTimeout(() => {
      assert.equal(parentTurnSettledEarly, false, 'parent turn settled before parent completed');
      parentTurnFinished = true;
      // 5. Parent turn actually completes later
      notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
    }, 50);
  });

  const messages: any[] = [];
  const runPromise = codexRuntime.run('collab test', {
    sessionId: 'parent-session',
    cwd: process.cwd(),
  }, {
    isWebSocketWriter: true,
    send: (message) => messages.push(message),
  }, runtimeContext(true));

  runPromise.then(() => {
    if (!parentTurnFinished) {
      parentTurnSettledEarly = true;
    }
  });

  await runPromise;

  // The subagent's stream deltas, completed item, and token budget must NOT have been sent to parent
  assert.ok(!messages.some((m) => m.kind === 'stream_delta' && m.content === 'subagent typing...'), 'subagent stream delta leaked to parent');
  assert.ok(!messages.some((m) => m.kind === 'stream_delta' && m.content === 'subagent snake typing...'), 'subagent snake stream delta leaked to parent');
  assert.ok(!messages.some((m) => m.content === 'subagent private summary'), 'subagent completed item leaked to parent');
  assert.ok(!messages.some((m) => m.kind === 'status' && m.tokenBudget?.totalTokens === 999), 'subagent token budget leaked to parent');
  // Subagent interrupted status must NOT have triggered a terminal error
  assert.ok(!messages.some((m) => m.kind === 'error' && String(m.content).includes('interrupted')), 'subagent interrupt surfaced as parent error');
  // Final message should be clean exitCode 0
  const completeMsg = messages.find((m) => m.kind === 'complete');
  assert.ok(completeMsg, 'complete message was sent');
  assert.equal(completeMsg.exitCode, 0, 'parent turn finished successfully');
});


// ---------------------------------------------------------------------------
// Background work tracking (collab agents that outlive their turn)
// ---------------------------------------------------------------------------

// Real engines never announce a spawn as a collab tool-call item: every
// recorded `CollabAgentToolCall` is a `wait`. The only word of a new agent is
// its `subAgentActivity` record, whose item id differs between the start and
// the end of the same agent; the thread id is what pairs them.
const spawnActivity = { type: 'subAgentActivity', id: 'call_spawn_1', kind: 'started', agentThreadId: 'thread_child_1', agentPath: '/root/standards' };
const doneActivity = { type: 'subAgentActivity', id: 'call_done_1', kind: 'completed', agentThreadId: 'thread_child_1', agentPath: '/root/standards' };

test('an agent still running when the turn ends is settled as stopped, because closing the connection kills it', async (t) => {
  const midTurn: Array<ReturnType<typeof codexRuntime.listBackgroundWork>> = [];
  const server = installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    // The agent starts; no terminal event arrives before the turn settles.
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    midTurn.push(codexRuntime.listBackgroundWork());
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });

  assert.deepEqual(codexRuntime.listBackgroundWork(), []);

  const messages: any[] = [];
  await codexRuntime.run('go', {
    sessionId: 'app-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  // The harness passes rows through un-normalized, so the card is the raw
  // `tool_use` row the renderer would receive.
  const launch = messages.find((message) => message.type === 'tool_use');
  assert.equal(launch?.toolName, 'Agent', 'the activity record becomes the subagent card');
  assert.equal(launch?.toolCallId, 'call_spawn_1');
  assert.match(JSON.stringify(launch?.toolInput), /Standards/);
  const started = messages.find((message) => message.kind === 'task_status' && message.event === 'started');
  assert.equal(started?.taskId, 'thread_child_1');
  assert.equal(started?.toolUseId, 'call_spawn_1');
  assert.equal(started?.taskType, 'collab_agent');

  // While the turn runs, the agent is listed as background work.
  assert.equal(midTurn[0].length, 1, 'the session appears on the background-work list');
  assert.equal(midTurn[0][0].sessionId, 'app-session');
  assert.deepEqual(midTurn[0][0].tasks.map((task) => [task.taskId, task.toolUseId, task.taskType, task.description]), [
    ['thread_child_1', 'call_spawn_1', 'collab_agent', 'Standards'],
  ]);

  // The run closed the connection, which kills the app-server and the agent
  // with it: no completion will ever arrive, so the card settles as stopped
  // and nothing stays listed.
  assert.equal(server.closed, true);
  const stopped = messages.filter((message) => message.kind === 'task_status' && message.event === 'notification');
  assert.deepEqual(stopped.map((message) => [message.toolUseId, message.taskId, message.status]), [
    ['call_spawn_1', 'thread_child_1', 'stopped'],
  ]);
  assert.ok(
    messages.indexOf(stopped[0]) < messages.findIndex((message) => message.kind === 'complete'),
    'the card settles before the page sees the turn complete',
  );
  assert.deepEqual(codexRuntime.listBackgroundWork(), []);
});

test('the composer strip lists a running agent while the turn waits on it and empties when it settles', async (t) => {
  const midTurn: unknown[] = [];
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    midTurn.push(codexRuntime.backgroundTasks.list('app-session-strip'));
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: doneActivity });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });

  const messages: any[] = [];
  await codexRuntime.run('go', { sessionId: 'app-session-strip', cwd: process.cwd() },
    { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  // The strip names the agent by its card; there is no handle to stop it on
  // its own, so the frame carries no `taskId`.
  const stripTask = { id: 'call_spawn_1', toolName: 'Agent', command: 'Standards', description: 'Standards' };
  const strips = messages.filter((message) => message.kind === 'status' && message.text === 'background_tasks');
  assert.deepEqual(
    strips.map((message) => message.backgroundTasks.map(({ startedAt: _startedAt, ...task }: any) => task)),
    [[stripTask], []],
  );
  // The turn is in flight while the agent runs, so the strip's work stops
  // with the turn.
  assert.ok(strips.every((message) => message.canInterrupt === true));
  assert.deepEqual((midTurn[0] as any[]).map(({ startedAt: _startedAt, ...task }) => task), [stripTask]);
  assert.deepEqual(codexRuntime.backgroundTasks.list('app-session-strip'), []);
});

test('an agent the turn leaves running is cleared from the strip before the turn completes', async (t) => {
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });

  const messages: any[] = [];
  await codexRuntime.run('go', { sessionId: 'app-session-strip-left', cwd: process.cwd() },
    { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const strips = messages.filter((message) => message.kind === 'status' && message.text === 'background_tasks');
  assert.deepEqual(strips.map((message) => message.backgroundTasks.length), [1, 0]);
  assert.ok(
    messages.indexOf(strips.at(-1)) < messages.findIndex((message) => message.kind === 'complete'),
    'the strip empties before the page sees the turn complete',
  );
});

test('a running agent\'s own steps arrive tied to its card, without its prompt or lifecycle items', async (t) => {
  installFakeAppServer(t, (server) => {
    const notify = (method: string, params: unknown) => server.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    // The agent works on its own thread of the same connection.
    const childPrompt = { type: 'userMessage', id: 'child-user', content: [{ type: 'text', text: 'review it', text_elements: [] }] };
    const command = { type: 'commandExecution', id: 'child-exec', command: "/bin/zsh -lc 'ls'", status: 'completed', aggregatedOutput: 'a.txt\n', exitCode: 0 };
    notify('item/completed', { threadId: 'thread_child_1', item: childPrompt });
    notify('item/completed', { threadId: 'thread_child_1', item: command });
    // A thread nobody here spawned stays out.
    notify('item/completed', { threadId: 'thread_stranger', item: { ...command, id: 'stranger-exec' } });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });
  const messages: any[] = [];
  await codexRuntime.run('go', { sessionId: 'app-session-child', cwd: process.cwd() },
    { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const childRows = messages.filter((message) => message.parentToolUseId === 'call_spawn_1');
  assert.deepEqual(childRows.map((row) => [row.type, row.toolCallId]), [['tool_use', 'child-exec'], ['tool_result', 'child-exec']]);
  assert.equal(messages.some((message) => message.toolCallId === 'stranger-exec'), false);
  assert.equal(messages.some((message) => message.type === 'user'), false, 'the agent\'s prompt is the card\'s task, not a thread row');
});

test('an agent that reports back during the turn is settled once, as completed', async (t) => {
  installFakeAppServer(t, (server) => {
    const notify = (method: string, params: unknown) => server.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: doneActivity });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });

  const messages: any[] = [];
  await codexRuntime.run('go', {
    sessionId: 'app-session-completed',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const settled = messages.filter((message) => message.kind === 'task_status' && message.event === 'notification');
  assert.deepEqual(settled.map((message) => message.status), ['completed']);
  assert.deepEqual(codexRuntime.listBackgroundWork(), []);
});

test('an aborted run settles its running agents as stopped', async (t) => {
  installFakeAppServer(t, (server) => {
    const notify = (method: string, params: unknown) => server.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    // The user stops the run; the aborted-session guard swallows every later
    // notification, and the run settles through the connection teardown.
    codexRuntime.abort('app-session-aborted');
    server.handlers.onExit?.('connection closed after abort');
  });

  const messages: any[] = [];
  await codexRuntime.run('go', {
    sessionId: 'app-session-aborted',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const settled = messages.filter((message) => message.kind === 'task_status' && message.event === 'notification');
  assert.deepEqual(settled.map((message) => message.status), ['stopped']);
  assert.deepEqual(codexRuntime.listBackgroundWork(), []);
});

test('a failed turn settles its running agents as stopped before the failed complete', async (t) => {
  installFakeAppServer(t, (server) => {
    const notify = (method: string, params: unknown) => server.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'failed', error: { message: 'boom' } } });
  });
  const messages: any[] = [];
  await codexRuntime.run('go', { sessionId: 'app-session-failed', cwd: process.cwd() },
    { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const stopped = messages.find((message) => message.kind === 'task_status' && message.status === 'stopped');
  const complete = messages.find((message) => message.kind === 'complete');
  assert.ok(stopped && complete);
  assert.equal(complete.exitCode, 1);
  assert.ok(messages.indexOf(stopped) < messages.indexOf(complete));
  assert.deepEqual(codexRuntime.listBackgroundWork(), []);
});

test('a run that throws after an agent started settles it as stopped before the failed complete', async (t) => {
  t.mock.method(codexAppServerTransport, 'open', async (handlers: CodexAppServerHandlers) => ({
    async call(method: string) {
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: THREAD_ID } };
      if (method === 'turn/start') {
        handlers.onNotification?.('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity } as any);
        throw new Error('turn/start rejected');
      }
      return {};
    },
    close() {},
  }));
  const messages: any[] = [];
  await codexRuntime.run('go', { sessionId: 'app-session-threw', cwd: process.cwd() },
    { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  const stopped = messages.find((message) => message.kind === 'task_status' && message.status === 'stopped');
  const complete = messages.find((message) => message.kind === 'complete');
  assert.ok(stopped && complete);
  assert.ok(messages.indexOf(stopped) < messages.indexOf(complete));
  assert.deepEqual(codexRuntime.listBackgroundWork(), []);
});

test('an interrupted agent settles its card as stopped', async (t) => {
  installFakeAppServer(t, (server) => {
    const notify = (method: string, params: unknown) => server.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: { ...doneActivity, id: 'call_int_1', kind: 'interrupted' } });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });

  const messages: any[] = [];
  await codexRuntime.run('go', {
    sessionId: 'app-session-interrupted',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  assert.equal(messages.filter((message) => message.type === 'tool_use').length, 1);
  const stopped = messages.find((message) => message.kind === 'task_status' && message.status === 'stopped');
  assert.equal(stopped?.toolUseId, 'call_spawn_1');
  assert.deepEqual(codexRuntime.listBackgroundWork(), []);
});

for (const payload of ['taskContinuation', 'toolOutput'] as const) {
  test(`a resident ${payload} receives its own terminal event`, async (t) => {
    installFakeAppServer(t);
    const previous = process.env.CLOUDCLI_CODEX_RESIDENT;
    process.env.CLOUDCLI_CODEX_RESIDENT = '1';
    const messages: any[] = [];
    try {
      const running = codexRuntime.run('', {
        sessionId: `resident-${payload}`,
        [payload]: payload === 'taskContinuation'
          ? { taskId: 'task-test', eventId: 'event-test', summary: 'done' }
          : { name: 'cloudcli_task_result', output: '{"summary":"done"}' },
      }, { send: (message) => messages.push(message) }, runtimeContext(false));
      const result = await Promise.race([
        running.then(() => 'finished'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
      ]);
      assert.equal(result, 'finished');
      assert.equal(listCodexResidentSessions().length, 0);
      assert.equal(messages.filter((message) => message.kind === 'complete' && message.exitCode === 0).length, 1);
    } finally {
      if (previous === undefined) process.env.CLOUDCLI_CODEX_RESIDENT = '0';
      else process.env.CLOUDCLI_CODEX_RESIDENT = previous;
      closeCodexResidentSessions();
    }
  });
}

test('an unconfirmed withdrawal remains unknown after a user stop', async (t) => {
  const server = installFakeAppServer(t, () => {});
  const previous = process.env.CLOUDCLI_CODEX_RESIDENT;
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  const messages: any[] = [];
  try {
    const running = codexRuntime.run('do work', { sessionId: 'stop-unknown' }, { send: (message) => messages.push(message) }, runtimeContext(false));
    await waitFor(() => server.calls.find((call) => call.method === 'thread/queue/add'));
    assert.equal(await codexRuntime.abort('stop-unknown'), true);
    const result = await running;
    assert.equal(result.terminalStatus, 'unknown');
    const error = messages.find((message) => message.kind === 'error');
    assert.match(error?.content ?? '', /could not confirm.*queued message/i);
    assert.match(error?.content ?? '', /background agents/i);
    assert.equal(server.closed, true);
  } finally {
    if (previous === undefined) process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    else process.env.CLOUDCLI_CODEX_RESIDENT = previous;
    closeCodexResidentSessions();
  }
});

test('a stop with no round in flight closes the process that still holds agents and settles them', async (t) => {
  // The round fails (here on the usage limit) while its agents are still
  // tracked. A resident process keeps them past the round, and the engine
  // never reports their end, so the strip's stop is the only way out.
  const server = installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'failed', error: { message: 'You’ve hit your usage limit.' } },
    });
  });
  const previous = process.env.CLOUDCLI_CODEX_RESIDENT;
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  const published: any[] = [];
  const context = { ...runtimeContext(false), publishSessionEvent: (_sessionId: string, message: any) => published.push(message) };
  try {
    await codexRuntime.run('go', { sessionId: 'stop-held-agents' }, { send() {} }, context);
    assert.equal(server.closed, false, 'the resident process outlives the failed round');
    assert.deepEqual(codexRuntime.listBackgroundWork().map((entry) => entry.sessionId), ['stop-held-agents']);

    assert.equal(await codexRuntime.abort('stop-held-agents'), true);

    assert.equal(server.closed, true, 'the stop closes the process the agents run in');
    assert.deepEqual(codexRuntime.listBackgroundWork(), []);
    const stopped = published.filter((message) => message.kind === 'task_status' && message.event === 'notification');
    assert.deepEqual(stopped.map((message) => [message.taskId, message.status]), [['thread_child_1', 'stopped']]);
    assert.equal(await codexRuntime.abort('stop-held-agents'), false, 'a second stop has nothing left to stop');
  } finally {
    closeCodexResidentSessions();
    if (previous === undefined) process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    else process.env.CLOUDCLI_CODEX_RESIDENT = previous;
  }
});

test('settling the agents of a closed process keeps the host task cards on the strip', async (t) => {
  // An agent and a host command share the strip. The process that ran the
  // agent closes; the frame that settles the agent replaces the whole list,
  // so it must still carry the host's card and its input rules.
  const hostTask = { id: 'task_host-kept', taskId: 'task_host-kept', toolName: 'Bash', command: 'sleep 120', description: 'kept', startedAt: 1 };
  setCodexHostTaskSource({
    list: (sessionId) => (sessionId === 'settle-host-tasks' ? [hostTask] : []),
    stop: async () => false,
  });
  t.after(() => setCodexHostTaskSource(null));
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'failed', error: { message: 'You’ve hit your usage limit.' } },
    });
  });
  const previous = process.env.CLOUDCLI_CODEX_RESIDENT;
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  const published: any[] = [];
  const context = { ...runtimeContext(false), publishSessionEvent: (_sessionId: string, message: any) => published.push(message) };
  try {
    await codexRuntime.run('go', { sessionId: 'settle-host-tasks' }, { send() {} }, context);
    assert.equal(await codexRuntime.abort('settle-host-tasks'), true);

    const strips = published.filter((message) => message.kind === 'status' && message.text === 'background_tasks');
    const last = strips.at(-1);
    assert.deepEqual(last?.backgroundTasks, [hostTask]);
    assert.equal(last?.canInterrupt, false);
    assert.equal(last?.backgroundWorkQueuesInput, false);
  } finally {
    closeCodexResidentSessions();
    if (previous === undefined) process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    else process.env.CLOUDCLI_CODEX_RESIDENT = previous;
  }
});

test('a second stop while the first waits for the engine does not close the process', async (t) => {
  // The turn runs with an agent, and the engine never confirms the interrupt.
  const server = installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
  });
  const previous = process.env.CLOUDCLI_CODEX_RESIDENT;
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  try {
    const running = codexRuntime.run('go', { sessionId: 'stop-twice' }, { send() {} }, runtimeContext(false));
    await waitFor(() => server.calls.find((call) => call.method === 'thread/queue/add'));
    await waitFor(() => codexRuntime.listBackgroundWork().length > 0 || undefined);

    const first = codexRuntime.abort('stop-twice');
    await waitFor(() => server.calls.find((call) => call.method === 'turn/interrupt'));
    assert.equal(await codexRuntime.abort('stop-twice'), false, 'the first stop still owns the turn');
    assert.equal(server.closed, false, 'the graceful interrupt is not cut short');

    server.handlers.onNotification?.('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'interrupted', error: null },
    } as any);
    assert.equal(await first, true);
    await running;
  } finally {
    closeCodexResidentSessions();
    if (previous === undefined) process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    else process.env.CLOUDCLI_CODEX_RESIDENT = previous;
  }
});

test('a stop during a report the engine started by itself closes the process, and the next message resumes', async (t) => {
  const server = installFakeAppServer(t);
  const previous = process.env.CLOUDCLI_CODEX_RESIDENT;
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  try {
    await codexRuntime.run('first', { sessionId: 'stop-report' }, { send() {} }, runtimeContext(false));
    server.handlers.onNotification?.('turn/started', { threadId: THREAD_ID, turn: { id: 'engine-report' } } as any);
    assert.deepEqual(codexRuntime.listBackgroundWork().map((entry) => entry.sessionId), ['stop-report']);

    assert.equal(await codexRuntime.abort('stop-report'), true);
    assert.equal(server.closed, true);
    assert.deepEqual(codexRuntime.listBackgroundWork(), []);

    server.closed = false;
    const messages: any[] = [];
    await codexRuntime.run('second', { sessionId: 'stop-report' }, { send: (message) => messages.push(message) }, runtimeContext(true));
    assert.ok(server.calls.some((call) => call.method === 'thread/resume'), 'the next message resumes the thread in a new process');
    assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 0));
  } finally {
    closeCodexResidentSessions();
    if (previous === undefined) process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    else process.env.CLOUDCLI_CODEX_RESIDENT = previous;
  }
});

// An agent works in turns on its own thread, and the parent can wake it for
// another turn later. The engine reports an agent's end only through the
// parent's records, which a failed parent turn never writes, so the agent's
// own turn decides whether it runs.
const AGENT_THREAD = 'thread_child_1';
const AGENT_TURN = 'agent-turn-1';

async function withResidentCodex(run: () => Promise<void>): Promise<void> {
  const previous = process.env.CLOUDCLI_CODEX_RESIDENT;
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  try {
    await run();
  } finally {
    closeCodexResidentSessions();
    if (previous === undefined) process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    else process.env.CLOUDCLI_CODEX_RESIDENT = previous;
  }
}

test('an agent whose own turn fails on the usage limit stops running with that cause', async (t) => {
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    notify('turn/started', { threadId: AGENT_THREAD, turn: { id: AGENT_TURN, status: 'inProgress' } });
    notify('turn/completed', {
      threadId: AGENT_THREAD,
      turn: { id: AGENT_TURN, status: 'failed', error: { message: 'You’ve hit your usage limit.' } },
    });
    notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'failed', error: { message: 'You’ve hit your usage limit.' } },
    });
  });
  await withResidentCodex(async () => {
    const messages: any[] = [];
    await codexRuntime.run('go', { sessionId: 'agent-usage-limit' }, { send: (message) => messages.push(message) }, runtimeContext(false));

    assert.deepEqual(codexRuntime.listBackgroundWork(), [], 'nothing is left running behind the failed round');
    const ended = messages.filter((message) => message.kind === 'task_status' && message.event === 'notification');
    assert.deepEqual(ended.map((message) => [message.taskId, message.toolUseId, message.status]), [
      ['thread_child_1', 'call_spawn_1', 'failed'],
    ]);
    assert.match(ended[0].summary ?? '', /usage limit/);
  });
});

test('an agent the parent wakes again runs on its card again, and idles when its turn ends', async (t) => {
  const server = installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    notify('turn/started', { threadId: AGENT_THREAD, turn: { id: AGENT_TURN, status: 'inProgress' } });
    notify('turn/completed', { threadId: AGENT_THREAD, turn: { id: AGENT_TURN, status: 'completed', error: null } });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });
  await withResidentCodex(async () => {
    const published: any[] = [];
    const context = { ...runtimeContext(false), publishSessionEvent: (_sessionId: string, message: any) => published.push(message) };
    await codexRuntime.run('go', { sessionId: 'agent-woken' }, { send() {} }, context);
    assert.deepEqual(codexRuntime.listBackgroundWork(), []);

    // With no round in flight, the engine wakes the agent for another turn.
    const notify = (method: string, params: unknown) => server.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: AGENT_THREAD, turn: { id: 'agent-turn-2', status: 'inProgress' } });
    assert.deepEqual(
      codexRuntime.listBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]),
      [['agent-woken', ['thread_child_1']]],
    );
    const revived = published.find((message) => message.kind === 'task_status' && message.event === 'started');
    assert.equal(revived?.toolUseId, 'call_spawn_1', 'the woken agent runs on the card it was spawned with');

    notify('turn/completed', { threadId: AGENT_THREAD, turn: { id: 'agent-turn-2', status: 'completed', error: null } });
    assert.deepEqual(codexRuntime.listBackgroundWork(), []);
    const ended = published.filter((message) => message.kind === 'task_status' && message.event === 'notification');
    assert.deepEqual(ended.map((message) => message.status), ['completed']);
  });
});

test('an agent stopped with its process runs on its card again when the next process wakes it', async (t) => {
  let spawn = true;
  const server = installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    if (spawn) notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });
  await withResidentCodex(async () => {
    const published: any[] = [];
    const context = { ...runtimeContext(false), publishSessionEvent: (_sessionId: string, message: any) => published.push(message) };
    await codexRuntime.run('go', { sessionId: 'agent-stopped-woken' }, { send() {} }, context);
    assert.equal(await codexRuntime.abort('agent-stopped-woken'), true);
    assert.deepEqual(codexRuntime.listBackgroundWork(), []);

    spawn = false;
    await codexRuntime.run('again', { sessionId: 'agent-stopped-woken' }, { send() {} }, { ...context, ...runtimeContext(true), publishSessionEvent: context.publishSessionEvent });
    server.handlers.onNotification?.('turn/started', { threadId: AGENT_THREAD, turn: { id: 'agent-turn-2', status: 'inProgress' } } as any);
    assert.deepEqual(
      codexRuntime.listBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.toolUseId)]),
      [['agent-stopped-woken', ['call_spawn_1']]],
    );
  });
});

test('a wake the parent records before or after the agent\'s own turn leaves the card in step with that turn', async (t) => {
  const server = installFakeAppServer(t);
  await withResidentCodex(async () => {
    const context = { ...runtimeContext(false), publishSessionEvent: () => {} };
    await codexRuntime.run('go', { sessionId: 'agent-wake-order' }, { send() {} }, context);
    const notify = (method: string, params: unknown) => server.handlers.onNotification?.(method, params as any);
    const running = () => codexRuntime.listBackgroundWork().filter((entry) => entry.tasks.length > 0)
      .map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: 'engine-turn', status: 'inProgress' } });

    // The agent's turn runs and ends before the parent's spawn record arrives.
    notify('turn/started', { threadId: AGENT_THREAD, turn: { id: AGENT_TURN, status: 'inProgress' } });
    notify('turn/completed', { threadId: AGENT_THREAD, turn: { id: AGENT_TURN, status: 'completed', error: null } });
    notify('item/completed', { threadId: THREAD_ID, turnId: 'engine-turn', item: spawnActivity });
    assert.deepEqual(running(), [], 'a spawn record after the turn ended does not leave the agent running');

    // The parent records a wake before the agent's next turn starts: the card
    // runs again from the turn's start and settles at its end.
    notify('item/completed', { threadId: THREAD_ID, turnId: 'engine-turn', item: { ...spawnActivity, id: 'call_spawn_2' } });
    notify('turn/started', { threadId: AGENT_THREAD, turn: { id: 'agent-turn-2', status: 'inProgress' } });
    assert.deepEqual(running(), [['agent-wake-order', ['thread_child_1']]]);
    notify('turn/completed', { threadId: AGENT_THREAD, turn: { id: 'agent-turn-2', status: 'completed', error: null } });
    assert.deepEqual(running(), []);
  });
});

test('a resident run without an app session leaves no agent behind', async (t) => {
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });
  await withResidentCodex(async () => {
    await codexRuntime.run('go', { cwd: process.cwd() }, { send() {} }, runtimeContext(false));
    assert.deepEqual(codexRuntime.listBackgroundWork(), []);
  });
});

test('an agent whose turn ends before the parent records its spawn is not left running', async (t) => {
  installFakeAppServer(t, (fake) => {
    const notify = (method: string, params: unknown) => fake.handlers.onNotification?.(method, params as any);
    notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } });
    notify('turn/started', { threadId: AGENT_THREAD, turn: { id: AGENT_TURN, status: 'inProgress' } });
    notify('turn/completed', {
      threadId: AGENT_THREAD,
      turn: { id: AGENT_TURN, status: 'failed', error: { message: 'You’ve hit your usage limit.' } },
    });
    notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, item: spawnActivity });
    notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'completed', error: null } });
  });
  await withResidentCodex(async () => {
    const messages: any[] = [];
    await codexRuntime.run('go', { sessionId: 'agent-early-end' }, { send: (message) => messages.push(message) }, runtimeContext(false));

    assert.deepEqual(codexRuntime.listBackgroundWork(), []);
    const ended = messages.filter((message) => message.kind === 'task_status' && message.event === 'notification');
    assert.deepEqual(ended.map((message) => [message.taskId, message.status]), [['thread_child_1', 'failed']]);
  });
});

test('a session approval survives the next round and is retracted when its process closes', async (t) => {
  const server = installFakeAppServer(t);
  const previous = process.env.CLOUDCLI_CODEX_RESIDENT;
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  const published: any[] = [];
  const context = { ...runtimeContext(false), publishSessionEvent: (_sessionId: string, message: any) => published.push(message) };
  try {
    const run = () => codexRuntime.run('hey', { sessionId: 'session-approval-lifetime' }, { send() {} }, context);
    await run();
    const answer = server.handlers.onRequest?.('item/commandExecution/requestApproval', { command: 'pwd', itemId: 'background-command' });
    assert.equal(codexRuntime.permissions.listPending('session-approval-lifetime').length, 1);
    await run();
    assert.equal(codexRuntime.permissions.listPending('session-approval-lifetime').length, 1);
    closeCodexResidentSessions();
    assert.deepEqual(await answer, { decision: 'decline' });
    assert.equal(codexRuntime.permissions.listPending('session-approval-lifetime').length, 0);
    assert.ok(published.some((message) => message.kind === 'permission_cancelled'));
  } finally {
    closeCodexResidentSessions();
    if (previous === undefined) process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    else process.env.CLOUDCLI_CODEX_RESIDENT = previous;
  }
});

test('a reporting conversation defers a task result without touching the process or emitting an error', async (t) => {
  const server = installFakeAppServer(t);
  const previous = process.env.CLOUDCLI_CODEX_RESIDENT;
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  const messages: any[] = [];
  try {
    await codexRuntime.run('normal', { sessionId: 'deferred-result' }, { send() {} }, runtimeContext(false));
    server.handlers.onNotification?.('turn/started', { threadId: THREAD_ID, turn: { id: 'active-report' } });
    const result = await codexRuntime.run('', {
      sessionId: 'deferred-result', taskContinuation: { taskId: 'task-ready', summary: 'done' },
    }, { send: (message) => messages.push(message) }, runtimeContext(false));
    assert.equal((result as { busy?: boolean }).busy, true);
    assert.equal(result.engineTurnId, null);
    assert.equal(server.closed, false);
    assert.equal(server.calls.filter((call) => call.method === 'thread/start' || call.method === 'thread/resume').length, 1);
    assert.equal(messages.some((message) => message.kind === 'error'), false);
  } finally {
    closeCodexResidentSessions();
    if (previous === undefined) process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    else process.env.CLOUDCLI_CODEX_RESIDENT = previous;
  }
});


test('a successful user turn submits a title job without waiting for it', async (t) => {
  installFakeAppServer(t);
  const submitted: any[] = [];
  t.mock.method(codexSessionTitleService, 'enqueue', (target: unknown) => {
    submitted.push(target);
    return new Promise<void>(() => {});
  });
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = codexRuntime.run('排查重复消息', { sessionId: 'title-user-turn', cwd: '/tmp' }, { isWebSocketWriter: true, send() {} }, runtimeContext(false));
    await Promise.race([run, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('chat waited for title')), 500); })]);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].appSessionId, 'title-user-turn');
    assert.equal(submitted[0].nativeThreadId, THREAD_ID);
    assert.equal(submitted[0].initialPrompt, '排查重复消息');
  } finally {
    clearTimeout(timer);
    process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    closeCodexResidentSessions();
  }
});

for (const resumed of [false, true]) {
  test(`short connection submits title after ${resumed ? 'resumed' : 'new'} successful user turn`, async (t) => {
    installFakeAppServer(t);
    const submitted: any[] = [];
    t.mock.method(codexSessionTitleService, 'enqueue', async (target: unknown) => { submitted.push(target); });
    await codexRuntime.run('short title', { sessionId: 'short-title' }, { send() {} }, runtimeContext(resumed));
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].generation, 0);
    assert.equal(submitted[0].initialPrompt, resumed ? undefined : 'short title');
  });
}

test('capacity fallback closes its short connection and submits a transient title job', async (t) => {
  const server = installFakeAppServer(t);
  const submitted: any[] = [];
  t.mock.method(codexSessionTitleService, 'enqueue', async (target: unknown) => { submitted.push(target); });
  const { acquireCodexResidentSession } = await import('../list/codex/codex-session-manager.js');
  const previousMax = process.env.CLOUDCLI_CODEX_RESIDENT_MAX;
  process.env.CLOUDCLI_CODEX_RESIDENT_MAX = '1';
  process.env.CLOUDCLI_CODEX_RESIDENT = '1';
  try {
    await acquireCodexResidentSession({ appSessionId: 'capacity-busy', nativeThreadId: null, workingDirectory: process.cwd(), approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false }, isBusy: () => true });
    await codexRuntime.run('capacity title', { sessionId: 'capacity-title' }, { send() {} }, runtimeContext(false));
    assert.equal(server.closed, true, 'the fallback connection must close after the chat');
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].generation, 0);
  } finally {
    closeCodexResidentSessions();
    process.env.CLOUDCLI_CODEX_RESIDENT = '0';
    if (previousMax === undefined) delete process.env.CLOUDCLI_CODEX_RESIDENT_MAX;
    else process.env.CLOUDCLI_CODEX_RESIDENT_MAX = previousMax;
  }
});

for (const status of ['failed', 'interrupted']) {
  test(`${status} user turns never submit a title job`, async (t) => {
    installFakeAppServer(t, (server) => {
      server.handlers.onNotification?.('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID } });
      server.handlers.onNotification?.('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, status, error: status === 'failed' ? { message: 'fixture failure' } : null } });
    });
    const enqueue = t.mock.method(codexSessionTitleService, 'enqueue', async () => {});
    await codexRuntime.run('unsuccessful', { sessionId: 'title-unsuccessful' }, { send() {} }, runtimeContext(false));
    assert.equal(enqueue.mock.callCount(), 0);
  });
}

test('successful tool output continuation never submits a title job', async (t) => {
  installFakeAppServer(t);
  const enqueue = t.mock.method(codexSessionTitleService, 'enqueue', async () => {});
  await codexRuntime.run('', { sessionId: 'title-tool', toolOutput: { name: 'cloudcli_task_result', output: 'done' } }, { send() {} }, runtimeContext(true));
  assert.equal(enqueue.mock.callCount(), 0);
});

for (const resident of [true, false]) {
  test(`/compact compacts the thread instead of sending text to the model (${resident ? 'resident' : 'short connection'})`, async (t) => {
    const server = installFakeAppServer(t);
    const messages: any[] = [];
    process.env.CLOUDCLI_CODEX_RESIDENT = resident ? '1' : '0';
    try {
      await codexRuntime.run('/compact', {
        sessionId: 'compact-session',
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

      const compacted = server.calls.find((call) => call.method === 'thread/compact/start');
      assert.ok(compacted, 'the thread must be compacted');
      assert.equal(compacted.params.threadId, THREAD_ID);
      assert.ok(!server.calls.some((call) => call.method === 'turn/start' || call.method === 'thread/queue/add'));
      assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message) => message.kind === 'error'));
      // The compaction item is one row (this context passes rows through
      // unnormalized): running while it works, then the finished row.
      const compactionRows = messages.filter((message) => message.type === 'compaction');
      assert.deepEqual(compactionRows.map((row) => [row.uuid, row.phase ?? 'done']), [['compaction-1', 'running'], ['compaction-1', 'done']]);
    } finally {
      process.env.CLOUDCLI_CODEX_RESIDENT = '0';
      closeCodexResidentSessions();
    }
  });
}

test('/compact with instructions is refused, because Codex compacts without them', async (t) => {
  const server = installFakeAppServer(t);
  const messages: any[] = [];
  await codexRuntime.run('/compact keep the API notes', {
    sessionId: 'compact-session',
    cwd: process.cwd(),
  }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, runtimeContext(true));

  assert.ok(!server.calls.some((call) => ['thread/compact/start', 'turn/start', 'thread/queue/add'].includes(call.method)));
  assert.ok(messages.some((message) => message.kind === 'error' && /without instructions/.test(message.content)));
  assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 1));
});
