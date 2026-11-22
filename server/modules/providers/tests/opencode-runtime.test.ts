import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { connectedClients } from '@/modules/websocket/index.js';
import { createOpenCodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { BackgroundWorkRegistry } from '@/modules/providers/shared/background-work/background-work-registry.js';
import type { NormalizedMessage, ProviderModelsDefinition, ProviderRuntimeContext } from '@/shared/types.js';

// Run notifications consult the app database; give the suite a throwaway one.
let databaseDirectory = '';
const previousDatabasePath = process.env.DATABASE_PATH;
before(async () => {
  databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-opencode-runtime-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();
});
after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(databaseDirectory, { recursive: true, force: true });
});

type RecordedRequest = { method: string; path: string; body: unknown };

/**
 * A stand-in for `opencode serve`: answers the endpoints the runtime drives,
 * records every request, and lets the test push SSE events into the feed.
 */
type FakeService = {
  url: string;
  requests: RecordedRequest[];
  snapshot: Record<string, unknown>;
  emit: (event: Record<string, unknown>) => void;
  /** Pushes several events in one chunk, so the runtime dispatches them in one tick. */
  emitBatch: (events: Array<Record<string, unknown>>) => void;
  /** What `/interrupt` answers: false says nothing was running. */
  interruptResult: boolean;
  waitForRequest: (predicate: (request: RecordedRequest) => boolean) => Promise<RecordedRequest>;
  close: () => void;
};

const startFakeService = async (): Promise<FakeService> => {
  const requests: RecordedRequest[] = [];
  const feeds = new Set<http.ServerResponse>();
  const waiters: Array<{ predicate: (request: RecordedRequest) => boolean; resolve: (request: RecordedRequest) => void }> = [];
  const service: FakeService = {
    url: '',
    requests,
    snapshot: { id: 'ses_new', outcome: 'succeeded', time: { idle: Date.now() + 60_000 }, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } } },
    emit: (event) => {
      for (const feed of feeds) {
        feed.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    },
    emitBatch: (events) => {
      for (const feed of feeds) {
        feed.write(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      }
    },
    interruptResult: true,
    waitForRequest: (predicate) => new Promise((resolve) => {
      const existing = requests.find(predicate);
      if (existing) {
        resolve(existing);
        return;
      }
      waiters.push({ predicate, resolve });
    }),
    close: () => {
      for (const feed of feeds) {
        feed.destroy();
      }
      server.close();
    },
  };
  const server = http.createServer((request, response) => {
    const url = request.url ?? '';
    if (request.method === 'GET' && url === '/api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': connected\n\n');
      feeds.add(response);
      response.on('close', () => feeds.delete(response));
      return;
    }
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const recorded: RecordedRequest = { method: request.method ?? '', path: url, body: raw ? JSON.parse(raw) : undefined };
      requests.push(recorded);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(recorded)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(recorded);
        }
      }
      const reply = (status: number, payload?: unknown) => {
        response.writeHead(status, payload === undefined ? {} : { 'content-type': 'application/json' });
        response.end(payload === undefined ? undefined : JSON.stringify(payload));
      };
      if (request.method === 'POST' && url === '/api/session') {
        reply(200, { data: { id: 'ses_new' } });
      } else if (request.method === 'POST' && url.endsWith('/prompt')) {
        reply(200, { data: { id: 'msg_1' } });
      } else if (request.method === 'POST' && url.endsWith('/interrupt')) {
        reply(200, { interrupted: service.interruptResult });
      } else if (request.method === 'GET' && url.startsWith('/api/session/')) {
        reply(200, { data: service.snapshot });
      } else {
        reply(204);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  service.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return service;
};

const MODELS: ProviderModelsDefinition = {
  OPTIONS: [{ value: 'opencode-go/glm-5.3', label: 'GLM 5.3', effort: { values: [{ value: 'high', label: 'High' }] } }],
} as unknown as ProviderModelsDefinition;

const makeContext = (
  providerSessionId: string | null,
  publishSessionEvent?: ProviderRuntimeContext['publishSessionEvent'],
): ProviderRuntimeContext => ({
  resolveProviderSessionId: () => providerSessionId,
  ...(publishSessionEvent ? { publishSessionEvent } : {}),
  resolveResumeModel: async (_sessionId, requested) => requested ?? undefined,
  getProviderModels: async () => MODELS,
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
});

const makeWriter = () => {
  const frames: NormalizedMessage[] = [];
  const sessionIds: string[] = [];
  return {
    frames,
    sessionIds,
    writer: {
      send: (data: unknown) => { frames.push(data as NormalizedMessage); },
      setSessionId: (id: string) => { sessionIds.push(id); },
      // No user: notifications are addressed to nobody, exactly as the SSE
      // writer behaves, so the suite needs no user rows.
      userId: null,
    },
  };
};

const session = (type: string, data: Record<string, unknown>) => ({
  id: `evt_${type}_${Math.random()}`, created: Date.now(), type, data: { sessionID: 'ses_new', ...data },
});

/**
 * Waits until the assertion holds.
 *
 * The runtime handles an engine event in the background, so the effect of the
 * event shows up a tick after the test pushed it into the feed.
 */
const waitFor = async (assertion: () => void, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

type RuntimeHarness = {
  service: FakeService;
  runtime: ReturnType<typeof createOpenCodeRuntime>;
  /** The work this runtime alone tracks, so tests never see each other's tasks. */
  backgroundWork: BackgroundWorkRegistry;
  /** Plays the service process exiting. */
  exitService: () => void;
};

const withRuntime = async (run: (input: RuntimeHarness) => Promise<void>) => {
  const service = await startFakeService();
  const endpoint = { url: service.url, authorization: 'Basic dGVzdA==' };
  const exitListeners: Array<() => void> = [];
  const backgroundWork = new BackgroundWorkRegistry();
  const runtime = createOpenCodeRuntime({
    supervisor: {
      // currentEndpoint backs the event stream's re-resolver: after a boot it
      // must hand out the same endpoint the supervisor does.
      ensureEndpoint: async () => endpoint,
      onExit: (listener) => {
        exitListeners.push(() => listener(endpoint));
        return () => {};
      },
      currentEndpoint: () => endpoint,
    },
    abortSettleGraceMs: 300,
    backgroundWork,
  });
  try {
    await run({ service, runtime, backgroundWork, exitService: () => exitListeners.forEach((listener) => listener()) });
  } finally {
    service.close();
  }
};

test('first send creates the session in the project directory, applies mode and model, streams the reply, and completes', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames, sessionIds } = makeWriter();
    const running = runtime.run('hello there', {
      sessionId: 'app-1', projectPath: '/tmp/project-a', model: 'opencode-go/glm-5.3', effort: 'high',
      permissionMode: 'default', sessionSummary: 'Greeting',
    }, writer, makeContext(null));

    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    service.emit(session('session.text.delta', { assistantMessageID: 'msg_a', ordinal: 0, delta: 'Hi!' }));
    service.emit(session('session.text.ended', { assistantMessageID: 'msg_a', ordinal: 0, text: 'Hi!' }));
    service.emit(session('session.execution.succeeded', {}));
    await running;

    assert.deepEqual(service.requests.map((request) => [request.method, request.path]), [
      ['POST', '/api/session'],
      ['POST', '/api/session/ses_new/agent'],
      ['PATCH', '/api/session/ses_new'],
      ['POST', '/api/session/ses_new/model'],
      ['POST', '/api/session/ses_new/prompt'],
      ['GET', '/api/session/ses_new'],
    ]);
    assert.deepEqual(service.requests[0].body, { location: { directory: '/tmp/project-a' } });
    // No title on the create request: the engine only names a session while it
    // still carries the placeholder it falls back to, and a title handed in
    // here would occupy that placeholder for good.
    assert.deepEqual(service.requests[1].body, { agent: 'build' });
    assert.deepEqual(service.requests[2].body, {
      permissions: ['shell', 'edit', 'write', 'patch'].map((action) => ({ action, resource: '*', effect: 'ask' })),
    });
    assert.deepEqual(service.requests[3].body, { model: { providerID: 'opencode-go', id: 'glm-5.3', variant: 'high' } });
    assert.deepEqual(service.requests[4].body, { text: 'hello there' });

    assert.deepEqual(sessionIds, ['ses_new']);
    assert.deepEqual(frames.map((frame) => frame.kind), ['session_created', 'stream_delta', 'text', 'stream_end', 'status', 'complete']);
    assert.equal(frames[0].newSessionId, 'ses_new');
    assert.equal(frames[1].content, 'Hi!');
    assert.equal(frames[1].sessionId, 'app-1');
    // The finished text row carries the engine-derived id the history reader
    // will re-derive, so the streamed placeholder is adopted and later
    // refreshes cannot render the reply twice.
    assert.equal(frames[2].id, 'msg_a_text_0');
    assert.equal(frames[2].role, 'assistant');
    assert.equal(frames[2].content, 'Hi!');
    assert.deepEqual(frames[4].tokenBudget, { used: 18, inputTokens: 12, outputTokens: 5, total: 1000000, breakdown: { input: 12, output: 5 } });
    assert.equal(frames[5].success, true);
    assert.equal(frames[5].exitCode, 0);
  });
});

test('the name the engine generated reaches the app row and is announced as a name-only update', async () => {
  const sent: unknown[] = [];
  const connection = {
    readyState: 1,
    send: (payload: string) => { sent.push(JSON.parse(payload)); },
  };
  connectedClients.add(connection as never);
  try {
    await withRuntime(async ({ service, runtime }) => {
      // The row the chat run leaves behind: the app's own session, mapped to
      // the engine's session id, still carrying the first message as its name.
      sessionsDb.createAppSession('app-1', 'opencode', '/tmp/project-a', 'The first message');
      sessionsDb.assignProviderSessionId('app-1', 'ses_new');

      // A chat has to have run for the runtime to be listening to the
      // engine's event feed, which is where the name arrives.
      const { writer } = makeWriter();
      const running = runtime.run('hello', { sessionId: 'app-1', projectPath: '/tmp/project-a' }, writer, makeContext('ses_new'));
      await service.waitForRequest((request) => request.path.endsWith('/prompt'));
      service.emit(session('session.execution.succeeded', {}));
      await running;

      service.emit({
        id: 'evt_renamed',
        created: 1_700_000_009_000,
        type: 'session.renamed',
        data: { sessionID: 'ses_new', title: 'The name the engine chose' },
      });

      await waitFor(() => {
        assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'The name the engine chose');
      });

      const upserts = sent.filter((payload): payload is { kind: string; metadataOnly?: boolean; session: { summary: string } } =>
        (payload as { kind?: string }).kind === 'session_upserted');
      assert.equal(upserts.length, 1);
      assert.equal(upserts[0].metadataOnly, true);
      assert.equal(upserts[0].session.summary, 'The name the engine chose');
    });
  } finally {
    connectedClients.delete(connection as never);
  }
});

test('a name the user chose is not replaced by the engine', async () => {
  await withRuntime(async ({ service, runtime }) => {
    sessionsDb.createAppSession('app-locked', 'opencode', '/tmp/project-a', 'The name I chose');
    sessionsDb.assignProviderSessionId('app-locked', 'ses_new');
    sessionsDb.updateSessionCustomName('app-locked', 'The name I chose', { lockName: true });

    const { writer } = makeWriter();
    const running = runtime.run('hello', { sessionId: 'app-locked', projectPath: '/tmp/project-a' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    service.emit(session('session.execution.succeeded', {}));
    await running;

    service.emit({
      id: 'evt_renamed',
      created: 1_700_000_009_000,
      type: 'session.renamed',
      data: { sessionID: 'ses_new', title: 'The name the engine chose' },
    });

    await waitFor(() => {
      assert.equal(sessionsDb.getSessionById('app-locked')?.custom_name, 'The name I chose');
    });
  });
});

test('a resumed session skips creation and only re-applies settings that changed', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const first = makeWriter();
    const run1 = runtime.run('one', { sessionId: 'app-1', projectPath: '/tmp/p', permissionMode: 'plan' }, first.writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    service.emit(session('session.execution.succeeded', {}));
    await run1;

    const second = makeWriter();
    const run2 = runtime.run('two', { sessionId: 'app-1', projectPath: '/tmp/p', permissionMode: 'acceptEdits' }, second.writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt') && request.body !== undefined && (request.body as { text: string }).text === 'two');
    service.emit(session('session.execution.succeeded', {}));
    await run2;

    const writes = service.requests.filter((request) => request.method !== 'GET').map((request) => [request.path.replace('/api/session/ses_new', ''), request.body]);
    assert.deepEqual(writes, [
      ['/agent', { agent: 'plan' }],
      ['', { permissions: ['shell', 'edit', 'write', 'patch'].map((action) => ({ action, resource: '*', effect: 'ask' })) }],
      ['/prompt', { text: 'one' }],
      ['/agent', { agent: 'build' }],
      ['', { permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] }],
      ['/prompt', { text: 'two' }],
    ]);
    assert.equal(first.sessionIds.length, 0, 'no session_created on resume');
    assert.ok(!first.frames.some((frame) => frame.kind === 'session_created'));
  });
});

test('bypassPermissions clears the rule list so the engine default (allow all) applies', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer } = makeWriter();
    const running = runtime.run('go', { sessionId: 'app-1', projectPath: '/tmp/p', permissionMode: 'bypassPermissions' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    service.emit(session('session.execution.succeeded', {}));
    await running;
    assert.deepEqual(service.requests.find((request) => request.method === 'PATCH')?.body, { permissions: [] });
  });
});

test('abort interrupts the service, retracts cards, and resolves without its own complete', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('slow task', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    service.emit(session('session.tool.input.started', { assistantMessageID: 'm', id: 'call-1', name: 'shell' }));
    service.emit(session('session.tool.called', { assistantMessageID: 'm', id: 'call-1', input: { command: 'sleep 10' } }));
    service.emit({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_new', action: 'shell', resources: ['sleep 10'], source: { type: 'tool', messageID: 'm', id: 'call-1' } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runtime.permissions?.listPending('app-1').length, 1);

    assert.equal(runtime.abort('app-1'), true);
    await service.waitForRequest((request) => request.path.endsWith('/interrupt'));
    service.emit(session('session.execution.interrupted', { reason: 'user' }));
    await running;

    assert.equal(runtime.abort('app-1'), false, 'nothing left to abort');
    assert.equal(runtime.permissions?.listPending('app-1').length, 0);
    const kinds = frames.map((frame) => frame.kind);
    assert.ok(!kinds.includes('complete'), 'the gateway emits the aborted complete');
    assert.ok(kinds.includes('permission_request'));
    assert.ok(kinds.includes('permission_cancelled'));
  });
});

test('a permission card answered through the facet reaches the service and is retracted', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('run it', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    service.emit(session('session.tool.input.started', { assistantMessageID: 'm', id: 'call-1', name: 'shell' }));
    service.emit({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_new', action: 'shell', resources: ['echo hi'], source: { type: 'tool', messageID: 'm', id: 'call-1' } } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    runtime.permissions?.resolve('per_1', { allow: true, rememberEntry: { toolName: 'shell' } });
    const reply = await service.waitForRequest((request) => request.path.endsWith('/permission/per_1/reply'));
    assert.deepEqual(reply.body, { decision: 'always' });

    service.emit(session('session.execution.succeeded', {}));
    await running;
    const permissionFrames = frames.filter((frame) => frame.kind.startsWith('permission_')).map((frame) => frame.kind);
    assert.deepEqual(permissionFrames, ['permission_request', 'permission_resolved']);
    assert.equal(frames.find((frame) => frame.kind === 'permission_request')?.toolName, 'shell');
    const mainCard = frames.find((frame) => frame.kind === 'permission_request');
    assert.equal((mainCard?.context as { subagent?: unknown } | undefined)?.subagent, undefined, 'a main-thread card names no subagent');
  });
});

test('an execution failure surfaces one error frame, a failed complete, and rejects', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('x', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    service.emit(session('session.execution.failed', { error: { type: 'provider.quota', message: 'Insufficient account funds' } }));
    await assert.rejects(running, /Insufficient account funds/);
    assert.deepEqual(frames.map((frame) => frame.kind), ['status', 'complete']);
    assert.equal(frames[1].success, false);
  });
});

test('a service that cannot start fails the run with an error and a failed complete', async () => {
  const runtime = createOpenCodeRuntime({
    supervisor: {
      ensureEndpoint: async () => { throw new Error('OpenCode CLI is not installed.'); },
      onExit: () => () => {},
      currentEndpoint: () => null,
    },
  });
  const { writer, frames } = makeWriter();
  await assert.rejects(
    runtime.run('hi', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext(null)),
    /not installed/,
  );
  assert.deepEqual(frames.map((frame) => frame.kind), ['error', 'complete']);
  assert.equal(frames[0].content, 'OpenCode CLI is not installed.');
});

test('attachments ride along as data-URI file parts next to the path tags', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-opencode-attach-'));
  await writeFile(path.join(dir, 'note.txt'), 'attached-file-says-hi');
  try {
    await withRuntime(async ({ service, runtime }) => {
      const { writer } = makeWriter();
      const running = runtime.run('read this', {
        sessionId: 'app-1', projectPath: dir, files: [{ path: 'note.txt', name: 'note.txt' }],
      }, writer, makeContext('ses_new'));
      const prompt = await service.waitForRequest((request) => request.path.endsWith('/prompt'));
      service.emit(session('session.execution.succeeded', {}));
      await running;
      const body = prompt.body as { text: string; files: Array<{ uri: string; filename: string; mime: string }> };
      assert.match(body.text, /^read this/);
      assert.match(body.text, /<files_input>/);
      assert.deepEqual(body.files, [{
        uri: `data:text/plain;base64,${Buffer.from('attached-file-says-hi').toString('base64')}`,
        filename: 'note.txt',
        mime: 'text/plain',
      }]);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run that ends on an unfinished subagent call settles the card as stopped before it completes', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('delegate', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    service.emit(session('session.tool.called', {
      assistantMessageID: 'm', id: 'call-sub', name: 'subagent',
      input: { agent: 'general', description: 'Review', prompt: 'go' },
    }));
    service.emit(session('session.execution.interrupted', { reason: 'user' }));
    await running;

    const launch = frames.find((frame) => frame.kind === 'tool_use');
    assert.equal(launch?.toolName, 'Agent');
    const settle = frames.find((frame) => frame.kind === 'task_status');
    assert.equal(settle?.toolUseId, 'call-sub');
    assert.equal(settle?.status, 'stopped');
    assert.ok(frames.indexOf(settle!) < frames.findIndex((frame) => frame.kind === 'complete' || frame.kind === 'status'));
  });
});

// ---------------------------------------------------------------------------
// Child sessions: the events and requests of a subagent's own session belong
// to the root run (shapes captured from OpenCode 2.0.31).
// ---------------------------------------------------------------------------

const CHILD = 'ses_child';
const GRANDCHILD = 'ses_grandchild';
const SPAWN_CALL = 'call_spawn';

const spawnChild = (service: FakeService, options: { child?: string; parent?: string; call?: string } = {}) => {
  const child = options.child ?? CHILD;
  const parent = options.parent ?? 'ses_new';
  const call = options.call ?? SPAWN_CALL;
  service.emit(session('session.tool.called', {
    sessionID: parent, assistantMessageID: 'm_p', id: call, name: 'subagent',
    input: { agent: 'general', description: 'Create the file', prompt: 'make probe.txt' },
  }));
  service.emit(session('session.created', { sessionID: child, parentID: parent, title: 'Create the file' }));
  service.emit(session('session.tool.progress', { sessionID: parent, assistantMessageID: 'm_p', id: call, metadata: { sessionID: child, status: 'running' } }));
};

test('a subagent\'s permission request reaches the page under the parent session and is answered on the child session', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('delegate', { sessionId: 'app-1', projectPath: '/tmp/p', permissionMode: 'default' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));

    spawnChild(service);
    service.emit(session('session.tool.called', { sessionID: CHILD, assistantMessageID: 'm_c', id: 'call_shell', name: 'shell', input: { command: 'echo hi' } }));
    service.emit({ type: 'permission.asked', data: { id: 'per_child', sessionID: CHILD, action: 'shell', resources: ['echo hi'], source: { type: 'tool', messageID: 'm_c', id: 'call_shell' } } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const card = frames.find((frame) => frame.kind === 'permission_request');
    assert.ok(card, 'the approval card must reach the writer');
    assert.equal(card.requestId, 'per_child');
    assert.equal(card.sessionId, 'app-1');
    assert.equal(card.toolName, 'shell', 'labelled by the child\'s own tool call');
    assert.deepEqual((card.context as { subagent?: unknown }).subagent, { toolUseId: SPAWN_CALL, description: 'Create the file' });
    assert.equal(runtime.permissions?.listPending('app-1').length, 1);

    runtime.permissions?.resolve('per_child', { allow: true });
    const reply = await service.waitForRequest((request) => request.path.endsWith('/permission/per_child/reply'));
    assert.equal(reply.path, `/api/session/${CHILD}/permission/per_child/reply`);
    assert.deepEqual(reply.body, { decision: 'once' });

    service.emit(session('session.tool.success', { sessionID: CHILD, assistantMessageID: 'm_c', id: 'call_shell', content: [{ type: 'text', text: 'hi\n' }] }));
    service.emit(session('session.tool.success', { sessionID: 'ses_new', assistantMessageID: 'm_p', id: SPAWN_CALL, content: [{ type: 'text', text: 'done' }], metadata: { sessionID: CHILD } }));
    service.emit(session('session.execution.succeeded', {}));
    await running;
    assert.ok(frames.some((frame) => frame.kind === 'permission_resolved'));
  });
});

test('a subagent\'s steps arrive as rows tied to its Agent card, and its end does not end the parent run', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    let finished = false;
    const running = runtime.run('delegate', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'))
      .then(() => { finished = true; });
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));

    spawnChild(service);
    service.emit(session('session.tool.called', { sessionID: CHILD, assistantMessageID: 'm_c', id: 'call_shell', name: 'shell', input: { command: 'ls' } }));
    service.emit(session('session.tool.success', { sessionID: CHILD, assistantMessageID: 'm_c', id: 'call_shell', content: [{ type: 'text', text: 'a.txt' }] }));
    service.emit(session('session.text.delta', { sessionID: CHILD, assistantMessageID: 'm_c2', ordinal: 0, delta: 'Listing' }));
    service.emit(session('session.text.ended', { sessionID: CHILD, assistantMessageID: 'm_c2', ordinal: 0, text: 'Listing done.' }));
    service.emit(session('session.execution.succeeded', { sessionID: CHILD }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(finished, false, 'the child\'s terminal event must not settle the parent run');
    const childRows = frames.filter((frame) => frame.parentToolUseId === SPAWN_CALL);
    assert.deepEqual(childRows.map((frame) => frame.kind), ['tool_use', 'tool_result', 'text']);
    assert.equal(childRows[0].toolName, 'shell');
    assert.equal(childRows[2].content, 'Listing done.');
    assert.equal(childRows[0].sessionId, 'app-1');
    assert.equal(frames.some((frame) => frame.kind === 'stream_delta'), false, 'a child\'s streaming deltas stay out of the main thread');

    service.emit(session('session.tool.success', { sessionID: 'ses_new', assistantMessageID: 'm_p', id: SPAWN_CALL, content: [{ type: 'text', text: 'ok' }], metadata: { sessionID: CHILD } }));
    service.emit(session('session.execution.succeeded', {}));
    await running;
    assert.equal(finished, true);
  });
});

test('events that precede the spawn call\'s progress event are held and then tied to the card', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('delegate', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));

    service.emit(session('session.created', { sessionID: CHILD, parentID: 'ses_new' }));
    service.emit(session('session.tool.called', { sessionID: CHILD, assistantMessageID: 'm_c', id: 'call_early', name: 'read', input: { path: '/tmp/a' } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(frames.some((frame) => frame.toolId === 'call_early'), false, 'nothing is sent without a card to attach to');

    service.emit(session('session.tool.progress', { sessionID: 'ses_new', id: SPAWN_CALL, metadata: { sessionID: CHILD } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const early = frames.find((frame) => frame.toolId === 'call_early');
    assert.equal(early?.parentToolUseId, SPAWN_CALL);

    service.emit(session('session.execution.succeeded', {}));
    await running;
  });
});

test('a grandchild session belongs to the same root run and its rows tie to the outer card', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('delegate', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));

    spawnChild(service);
    spawnChild(service, { child: GRANDCHILD, parent: CHILD, call: 'call_inner' });
    service.emit(session('session.tool.called', { sessionID: GRANDCHILD, assistantMessageID: 'm_g', id: 'call_deep', name: 'read', input: { path: '/x' } }));
    service.emit({ type: 'permission.asked', data: { id: 'per_deep', sessionID: GRANDCHILD, action: 'read', resources: ['/x'], source: { type: 'tool', messageID: 'm_g', id: 'call_deep' } } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const deep = frames.find((frame) => frame.toolId === 'call_deep');
    assert.equal(deep?.parentToolUseId, SPAWN_CALL, 'nested rows tie to the card the user sees');
    assert.equal(frames.find((frame) => frame.kind === 'permission_request')?.sessionId, 'app-1');
    const deepCard = frames.find((frame) => frame.kind === 'permission_request');
    assert.equal((deepCard?.context as { subagent?: { toolUseId: string } } | undefined)?.subagent?.toolUseId, SPAWN_CALL);

    service.emit(session('session.execution.succeeded', {}));
    await running;
  });
});

test('a session nobody here owns is still ignored', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('go', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));

    service.emit(session('session.created', { sessionID: 'ses_other_child', parentID: 'ses_other_parent' }));
    service.emit(session('session.tool.called', { sessionID: 'ses_other_child', id: 'call_x', name: 'shell', input: {} }));
    service.emit({ type: 'permission.asked', data: { id: 'per_x', sessionID: 'ses_other_child', action: 'shell', resources: [], source: { id: 'call_x' } } });
    service.emit(session('session.execution.succeeded', {}));
    await running;

    assert.equal(frames.some((frame) => frame.kind === 'permission_request' || frame.toolId === 'call_x'), false);
  });
});

test('a grandchild adopted before its ancestor\'s card is known ties to the outer card once that is known', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('delegate', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));

    // The child exists, but the call that spawned it has not been reported.
    service.emit(session('session.created', { sessionID: CHILD, parentID: 'ses_new' }));
    service.emit(session('session.created', { sessionID: GRANDCHILD, parentID: CHILD }));
    service.emit(session('session.tool.progress', { sessionID: CHILD, id: 'call_inner', metadata: { sessionID: GRANDCHILD } }));
    service.emit(session('session.tool.called', { sessionID: GRANDCHILD, assistantMessageID: 'm_g', id: 'call_deep', name: 'read', input: { path: '/x' } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(frames.some((frame) => frame.toolId === 'call_deep'), false, 'held while the outer card is unknown');

    service.emit(session('session.tool.progress', { sessionID: 'ses_new', id: SPAWN_CALL, metadata: { sessionID: CHILD } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(frames.find((frame) => frame.toolId === 'call_deep')?.parentToolUseId, SPAWN_CALL, 'not the nested call');

    service.emit(session('session.execution.succeeded', {}));
    await running;
  });
});

test('a child session spawned again by a later call follows the newest call', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('delegate', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));

    spawnChild(service, { call: 'call_first' });
    service.emit(session('session.tool.called', { sessionID: CHILD, assistantMessageID: 'm_1', id: 'step_one', name: 'read', input: {} }));
    // The agent is resumed through its session id by a second call.
    service.emit(session('session.tool.progress', { sessionID: 'ses_new', id: 'call_second', metadata: { sessionID: CHILD } }));
    service.emit(session('session.tool.called', { sessionID: CHILD, assistantMessageID: 'm_2', id: 'step_two', name: 'read', input: {} }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(frames.find((frame) => frame.toolId === 'step_one')?.parentToolUseId, 'call_first');
    assert.equal(frames.find((frame) => frame.toolId === 'step_two')?.parentToolUseId, 'call_second');

    service.emit(session('session.execution.succeeded', {}));
    await running;
  });
});

test('steps dropped because the card never became known are logged once', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  await withRuntime(async ({ service, runtime }) => {
    const { writer } = makeWriter();
    const running = runtime.run('delegate', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));

    service.emit(session('session.created', { sessionID: CHILD, parentID: 'ses_new' }));
    for (let index = 0; index < 520; index += 1) {
      service.emit(session('session.tool.called', { sessionID: CHILD, assistantMessageID: `m_${index}`, id: `step_${index}`, name: 'read', input: {} }));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(warnings.filter((line) => /dropping steps of a subagent/.test(line)).length, 1);

    service.emit(session('session.execution.succeeded', {}));
    await running;
  });
});

// ---------------------------------------------------------------------------
// Background work: a `subagent` or `shell` call made with `background: true`
// returns at once and keeps running after the run ends; the engine then posts
// a synthetic notice into the parent's inbox and starts a report turn of its
// own (shapes captured from OpenCode 2.0.31).
// ---------------------------------------------------------------------------

const BG_CALL = 'call_bg_agent';
const SHELL_CALL = 'call_bg_shell';
const SHELL_ID = 'sh_bg_1';

const makeSessionChannel = () => {
  const published: NormalizedMessage[] = [];
  return {
    published,
    publish: (appSessionId: string, message: NormalizedMessage) => {
      published.push({ ...message, sessionId: message.sessionId ?? appSessionId });
    },
  };
};

const launchBackgroundAgent = (service: FakeService) => {
  service.emit(session('session.tool.called', {
    assistantMessageID: 'm_p', id: BG_CALL, name: 'subagent',
    input: { agent: 'general', description: 'Independent review', prompt: 'review it', background: true },
  }));
  service.emit(session('session.created', { sessionID: CHILD, parentID: 'ses_new', title: 'Independent review' }));
  service.emit(session('session.tool.progress', { assistantMessageID: 'm_p', id: BG_CALL, metadata: { sessionID: CHILD, status: 'running' } }));
  service.emit(session('session.tool.success', {
    assistantMessageID: 'm_p', id: BG_CALL,
    content: [{ type: 'text', text: `The subagent is working in the background (sessionID: ${CHILD}).` }],
    metadata: { sessionID: CHILD, status: 'running', truncated: false },
  }));
};

const launchBackgroundShell = (service: FakeService) => {
  service.emit(session('session.tool.called', {
    assistantMessageID: 'm_p', id: SHELL_CALL, name: 'shell', input: { command: 'npm test', background: true },
  }));
  service.emit({ type: 'shell.created', data: { info: { id: SHELL_ID, status: 'running', command: 'npm test', metadata: { sessionID: 'ses_new' } } } });
  service.emit(session('session.tool.progress', { assistantMessageID: 'm_p', id: SHELL_CALL, metadata: { shellID: SHELL_ID } }));
  service.emit(session('session.tool.success', {
    assistantMessageID: 'm_p', id: SHELL_CALL,
    content: [{ type: 'text', text: `Command moved to the background (shell ID: ${SHELL_ID}).` }],
    metadata: { status: 'running', truncated: false, shellID: SHELL_ID },
  }));
};

const inboxNotice = (metadata: Record<string, unknown>, text = '<notice/>') => session('session.inbox.enqueued', {
  inboxID: `msg_notice_${Math.random()}`,
  item: { type: 'synthetic', payload: { text, metadata }, delivery: 'steer' },
});

test('a background agent keeps its card running and the session working after the run completes', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const channel = makeSessionChannel();
    const running = runtime.run('review in the background', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new', channel.publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    service.emit(session('session.text.ended', { assistantMessageID: 'm_p2', ordinal: 0, text: 'Started the review.' }));
    service.emit(session('session.execution.succeeded', {}));
    await running;

    const statuses = frames.filter((frame) => frame.kind === 'task_status' && frame.toolUseId === BG_CALL);
    assert.deepEqual(statuses.map((frame) => frame.status), ['running'], 'the launch acknowledgement is not the agent finishing');
    assert.equal(statuses[0].taskId, CHILD);
    assert.ok(frames.some((frame) => frame.kind === 'complete'), 'the run itself still completes');

    assert.deepEqual(runtime.listBackgroundWork?.().map((entry) => [entry.sessionId, entry.tasks.map((task) => [task.taskId, task.toolUseId, task.taskType])]), [
      ['app-1', [[CHILD, BG_CALL, 'local_agent']]],
    ]);
    assert.equal(runtime.hasSessionWork?.('app-1'), true, 'a session with a running agent cannot be archived or deleted');
    assert.deepEqual(runtime.backgroundTasks?.list('app-1').map((task) => [task.id, task.toolName, task.description]), [
      [BG_CALL, 'Agent', 'Independent review'],
    ]);
    assert.equal(runtime.backgroundTasks?.queuesInput?.('app-1'), false, 'the engine takes a new message without disturbing the agent');
    const strip = frames.filter((frame) => frame.kind === 'status' && frame.text === 'background_tasks');
    assert.equal(strip.at(-1)?.backgroundTasks?.length, 1);
    // The live strip says what the subscribe ack says, or the page queues the
    // next message until the work and the report are over.
    assert.ok(strip.every((frame) => frame.backgroundWorkQueuesInput === false));

    // The agent keeps working after the run: its steps reach the page through
    // the session channel, still tied to the card.
    service.emit(session('session.tool.called', { sessionID: CHILD, assistantMessageID: 'm_c', id: 'call_read', name: 'read', input: { path: 'a.ts' } }));
    await waitFor(() => assert.ok(channel.published.some((frame) => frame.kind === 'tool_use' && frame.toolId === 'call_read')));
    const childRow = channel.published.find((frame) => frame.toolId === 'call_read');
    assert.equal(childRow?.parentToolUseId, BG_CALL);
    assert.equal(childRow?.sessionId, 'app-1');
  });
});

test('the engine\'s notice settles the agent, and the report turn it starts reaches the page', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer } = makeWriter();
    const channel = makeSessionChannel();
    const running = runtime.run('review in the background', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new', channel.publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    service.emit(session('session.execution.succeeded', {}));
    await running;

    service.emit(session('session.execution.succeeded', { sessionID: CHILD }));
    service.emit(inboxNotice({ source: 'subagent', childID: CHILD, agent: 'General', state: 'completed' }));
    service.emit(session('session.execution.started', {}));
    await waitFor(() => assert.ok(channel.published.some((frame) => frame.kind === 'task_status' && frame.status === 'completed')));
    const settled = channel.published.find((frame) => frame.kind === 'task_status' && frame.status === 'completed');
    assert.equal(settled?.toolUseId, BG_CALL);
    assert.deepEqual(runtime.backgroundTasks?.list('app-1'), []);
    const strip = channel.published.filter((frame) => frame.kind === 'status' && frame.text === 'background_tasks');
    assert.deepEqual(strip.at(-1)?.backgroundTasks, [], 'an emptied strip is announced, or it never clears');

    // The report turn the engine started on its own: the session is working
    // and the reply streams in through the session channel.
    await waitFor(() => assert.deepEqual(runtime.getSessionActivity?.('app-1'), { queued: false, reporting: true }));
    const [reportEntry] = runtime.listBackgroundWork?.() ?? [];
    assert.equal(reportEntry?.sessionId, 'app-1');
    assert.deepEqual(reportEntry?.tasks, []);
    assert.ok(reportEntry?.startedAt && Date.now() - reportEntry.startedAt < 2_000, 'the report\'s clock starts with the report');
    assert.equal(runtime.hasSessionWork?.('app-1'), true);
    assert.equal(runtime.backgroundTasks?.canInterrupt?.('app-1'), true, 'abort can stop the report turn');
    service.emit(session('session.text.ended', { assistantMessageID: 'm_report', ordinal: 0, text: 'The review found two problems.' }));
    service.emit(session('session.execution.succeeded', {}));
    await waitFor(() => assert.ok(channel.published.some((frame) => frame.kind === 'text' && frame.content === 'The review found two problems.')));

    await waitFor(() => assert.equal(runtime.getSessionActivity?.('app-1') ?? null, null));
    assert.deepEqual(runtime.listBackgroundWork?.(), []);
    assert.equal(runtime.hasSessionWork?.('app-1'), false);
  });
});

test('a background command shows in the strip as a command and its notice clears it', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const channel = makeSessionChannel();
    const running = runtime.run('run the tests in the background', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new', channel.publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundShell(service);
    service.emit(session('session.execution.succeeded', {}));
    await running;

    assert.deepEqual(runtime.backgroundTasks?.list('app-1').map((task) => [task.id, task.toolName, task.command]), [
      [SHELL_CALL, 'Bash', 'npm test'],
    ]);
    assert.equal(runtime.listBackgroundWork?.()[0]?.tasks[0]?.taskType, 'local_bash');
    // No request stops one backgrounded command, and no run is left to abort.
    assert.equal(runtime.backgroundTasks?.canInterrupt?.('app-1'), false);
    assert.equal(frames.filter((frame) => frame.kind === 'task_status').every((frame) => frame.status === 'running'), true);
    // The page keeps the last word a poll gave, so "not reporting" is said outright.
    assert.deepEqual(runtime.getSessionActivity?.('app-1'), { queued: false, reporting: false });

    service.emit({ type: 'shell.exited', data: { id: SHELL_ID, exit: 0, status: 'exited' } });
    service.emit(inboxNotice({ source: 'shell', shellID: SHELL_ID, jobID: SHELL_ID, state: 'completed', exit: 0 }));
    await waitFor(() => assert.deepEqual(runtime.backgroundTasks?.list('app-1'), []));
    assert.deepEqual(channel.published.filter((frame) => frame.text === 'background_tasks').at(-1)?.backgroundTasks, []);
  });
});

test('a cancelled agent reads as stopped', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer } = makeWriter();
    const channel = makeSessionChannel();
    const running = runtime.run('review', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new', channel.publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    service.emit(session('session.execution.succeeded', {}));
    await running;

    service.emit(inboxNotice({ source: 'subagent', childID: CHILD, state: 'cancelled' }));
    await waitFor(() => assert.equal(channel.published.find((frame) => frame.kind === 'task_status')?.status, 'stopped'));
  });
});

test('stopping one background agent interrupts its own session', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer } = makeWriter();
    const running = runtime.run('review', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new', makeSessionChannel().publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    service.emit(session('session.execution.succeeded', {}));
    await running;

    assert.equal(runtime.backgroundTasks?.list('app-1')[0]?.taskId, CHILD, 'an agent offers its own stop');
    assert.equal(await runtime.stopBackgroundTask?.('app-1', CHILD), true);
    await service.waitForRequest((request) => request.path === `/api/session/${CHILD}/interrupt`);
    assert.equal(await runtime.stopBackgroundTask?.('app-1', 'ses_unknown'), false);
  });
});

test('abort with no run stops the background agents and the report turn', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer } = makeWriter();
    const running = runtime.run('review', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new', makeSessionChannel().publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    service.emit(session('session.execution.succeeded', {}));
    await running;
    service.emit(session('session.execution.started', {}));
    await waitFor(() => assert.equal(runtime.getSessionActivity?.('app-1')?.reporting, true));

    assert.equal(await runtime.abort('app-1'), true);
    await service.waitForRequest((request) => request.path === `/api/session/${CHILD}/interrupt`);
    await service.waitForRequest((request) => request.path === '/api/session/ses_new/interrupt');
  });
});

test('a message sent during the report turn takes the turn over and ends with it', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const first = makeWriter();
    const channel = makeSessionChannel();
    const running = runtime.run('review', { sessionId: 'app-1', projectPath: '/tmp/p' }, first.writer, makeContext('ses_new', channel.publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    service.emit(session('session.execution.succeeded', {}));
    await running;
    service.emit(inboxNotice({ source: 'subagent', childID: CHILD, state: 'completed' }));
    service.emit(session('session.execution.started', {}));
    await waitFor(() => assert.equal(runtime.getSessionActivity?.('app-1')?.reporting, true));

    const second = makeWriter();
    const prompts = service.requests.filter((request) => request.path.endsWith('/prompt')).length;
    const followUp = runtime.run('and fix them', { sessionId: 'app-1', projectPath: '/tmp/p' }, second.writer, makeContext('ses_new', channel.publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt') && service.requests.filter((entry) => entry.path.endsWith('/prompt')).length > prompts);
    // The engine steers the message into the execution it is running.
    service.emit(session('session.text.ended', { assistantMessageID: 'm_fix', ordinal: 0, text: 'Fixing both.' }));
    service.emit(session('session.execution.succeeded', {}));
    await followUp;

    assert.ok(second.frames.some((frame) => frame.kind === 'text' && frame.content === 'Fixing both.'), 'the run owns the turn now');
    assert.equal(channel.published.some((frame) => frame.content === 'Fixing both.'), false);
    assert.ok(second.frames.some((frame) => frame.kind === 'complete'));
    assert.equal(runtime.getSessionActivity?.('app-1') ?? null, null);
  });
});

test('the service exiting settles every background task as stopped', async () => {
  await withRuntime(async ({ service, runtime, exitService }) => {
    const { writer } = makeWriter();
    const channel = makeSessionChannel();
    const running = runtime.run('review', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new', channel.publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    launchBackgroundShell(service);
    service.emit(session('session.execution.succeeded', {}));
    await running;

    exitService();
    const stopped = channel.published.filter((frame) => frame.kind === 'task_status' && frame.status === 'stopped');
    assert.deepEqual(stopped.map((frame) => frame.toolUseId).sort(), [BG_CALL, SHELL_CALL].sort());
    assert.deepEqual(runtime.listBackgroundWork?.(), []);
    assert.equal(runtime.hasSessionWork?.('app-1'), false);
  });
});

test('a background agent\'s permission request after the run still reaches the page', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer } = makeWriter();
    const channel = makeSessionChannel();
    const running = runtime.run('review', { sessionId: 'app-1', projectPath: '/tmp/p', permissionMode: 'default' }, writer, makeContext('ses_new', channel.publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    service.emit(session('session.execution.succeeded', {}));
    await running;

    service.emit(session('session.tool.called', { sessionID: CHILD, assistantMessageID: 'm_c', id: 'call_shell', name: 'shell', input: { command: 'rm x' } }));
    service.emit({ type: 'permission.asked', data: { id: 'per_bg', sessionID: CHILD, action: 'shell', resources: ['rm x'], source: { type: 'tool', messageID: 'm_c', id: 'call_shell' } } });
    await waitFor(() => assert.ok(channel.published.some((frame) => frame.kind === 'permission_request' && frame.requestId === 'per_bg')));
    runtime.permissions?.resolve('per_bg', { allow: false });
    const reply = await service.waitForRequest((request) => request.path.endsWith('/permission/per_bg/reply'));
    assert.equal(reply.path, `/api/session/${CHILD}/permission/per_bg/reply`);
  });
});

test('a background agent that finishes before the run ends is settled within the run', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('review', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new', makeSessionChannel().publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    service.emit(inboxNotice({ source: 'subagent', childID: CHILD, state: 'completed' }));
    service.emit(session('session.execution.succeeded', {}));
    await running;

    assert.deepEqual(frames.filter((frame) => frame.kind === 'task_status').map((frame) => frame.status), ['running', 'completed']);
    assert.deepEqual(runtime.listBackgroundWork?.(), []);
    assert.equal(runtime.hasSessionWork?.('app-1'), false);
  });
});

test('the report turn the engine starts in the same tick the run ends is not lost', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer } = makeWriter();
    const channel = makeSessionChannel();
    const running = runtime.run('review', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new', channel.publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    await waitFor(() => assert.equal(runtime.backgroundTasks?.list('app-1').length, 1));
    // The agent finishes as the run ends: the run's terminal, the notice and
    // the engine's report turn arrive together, before the run is released.
    service.emitBatch([
      session('session.execution.succeeded', {}),
      inboxNotice({ source: 'subagent', childID: CHILD, state: 'completed' }),
      session('session.execution.started', {}),
    ]);
    await running;

    assert.deepEqual(runtime.getSessionActivity?.('app-1'), { queued: false, reporting: true });
    service.emit(session('session.text.ended', { assistantMessageID: 'm_report', ordinal: 0, text: 'Reported.' }));
    await waitFor(() => assert.ok(channel.published.some((frame) => frame.kind === 'text' && frame.content === 'Reported.')));
  });
});

test('a notice that arrives before its launch is acknowledged still ends the work', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer } = makeWriter();
    const running = runtime.run('quick command', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new', makeSessionChannel().publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    service.emit(session('session.tool.called', { assistantMessageID: 'm_p', id: SHELL_CALL, name: 'shell', input: { command: 'true', background: true } }));
    service.emit(inboxNotice({ source: 'shell', shellID: SHELL_ID, state: 'completed', exit: 0 }));
    service.emit(session('session.tool.success', {
      assistantMessageID: 'm_p', id: SHELL_CALL, content: [{ type: 'text', text: 'Command moved to the background.' }],
      metadata: { status: 'running', truncated: false, shellID: SHELL_ID },
    }));
    service.emit(session('session.execution.succeeded', {}));
    await running;

    assert.deepEqual(runtime.listBackgroundWork?.(), []);
    assert.equal(runtime.hasSessionWork?.('app-1'), false);
  });
});

test('a finished background agent\'s card does not outlive the conversation', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer } = makeWriter();
    const running = runtime.run('review', { sessionId: 'app-1', projectPath: '/tmp/p', permissionMode: 'default' }, writer, makeContext('ses_new', makeSessionChannel().publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    service.emit({ type: 'permission.asked', data: { id: 'per_stale', sessionID: CHILD, action: 'shell', resources: ['x'], source: { type: 'tool', messageID: 'm_c', id: 'call_x' } } });
    await waitFor(() => assert.equal(runtime.permissions?.listPending('app-1').length, 1));
    // The agent ends while the run still runs, so nothing keeps its card.
    service.emit(inboxNotice({ source: 'subagent', childID: CHILD, state: 'completed' }));
    service.emit(session('session.execution.succeeded', {}));
    await running;

    assert.deepEqual(runtime.permissions?.listPending('app-1'), []);
  });
});

test('the service exiting leaves no background agent\'s card pending', async () => {
  await withRuntime(async ({ service, runtime, exitService }) => {
    const { writer } = makeWriter();
    const running = runtime.run('review', { sessionId: 'app-1', projectPath: '/tmp/p', permissionMode: 'default' }, writer, makeContext('ses_new', makeSessionChannel().publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    service.emit({ type: 'permission.asked', data: { id: 'per_dead', sessionID: CHILD, action: 'shell', resources: ['x'], source: { type: 'tool', messageID: 'm_c', id: 'call_x' } } });
    await waitFor(() => assert.equal(runtime.permissions?.listPending('app-1').length, 1));
    exitService();
    await running.catch(() => undefined);

    assert.deepEqual(runtime.permissions?.listPending('app-1'), []);
  });
});

test('abort reports failure when nothing it asked to stop was running', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer } = makeWriter();
    const running = runtime.run('review', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new', makeSessionChannel().publish));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    launchBackgroundAgent(service);
    service.emit(session('session.execution.succeeded', {}));
    await running;

    service.interruptResult = false;
    assert.equal(await runtime.abort('app-1'), false);
    assert.equal(await runtime.stopBackgroundTask?.('app-1', CHILD), false);
  });
});

test('/compact compacts the session through its endpoint instead of prompting the model', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('/compact', { sessionId: 'app-1', projectPath: '/tmp/p', permissionMode: 'bypassPermissions' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/compact'));
    service.emit(session('session.execution.started', {}));
    service.emit(session('session.compaction.started', { reason: 'manual', inputID: 'msg_c' }));
    service.emit(session('session.compaction.ended', { reason: 'manual', inputID: 'msg_c' }));
    service.emit(session('session.execution.succeeded', {}));
    await running;

    assert.ok(!service.requests.some((request) => request.path.endsWith('/prompt')));
    const compact = service.requests.find((request) => request.path.endsWith('/compact'));
    assert.equal(compact?.path, '/api/session/ses_new/compact');
    const rows = frames.filter((frame) => frame.compact);
    assert.deepEqual(rows.map((row) => row.compact?.phase), ['running', 'done']);
    assert.equal(rows[1].content, 'Compacted · manual');
    assert.equal(frames.at(-1)?.kind, 'complete');
    assert.equal(frames.at(-1)?.exitCode, 0);
  });
});

test('/compact with instructions fails the run without touching the session', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    await assert.rejects(
      runtime.run('/compact keep the API notes', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new')),
      /without instructions/,
    );
    assert.ok(!service.requests.some((request) => request.path.endsWith('/compact') || request.path.endsWith('/prompt')));
    assert.ok(frames.some((frame) => frame.kind === 'error' && /without instructions/.test(String(frame.content))));
  });
});
