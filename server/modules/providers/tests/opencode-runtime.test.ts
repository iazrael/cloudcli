import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { createOpenCodeRuntime } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import type {
  AnyRecord,
  NormalizedMessage,
  ProviderModelsDefinition,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

// Run notifications consult the app database; give the suite a throwaway one.
// The home directory is redirected too: token-budget frames read opencode's
// own database and model cache, which must not be whatever the developer has.
let databaseDirectory = '';
let homeDirectory = '';
const previousDatabasePath = process.env.DATABASE_PATH;
const originalHomedir = os.homedir;
before(async () => {
  databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-opencode-runtime-db-'));
  homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-opencode-runtime-home-'));
  const cacheDirectory = path.join(homeDirectory, '.cache', 'opencode');
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(
    path.join(cacheDirectory, 'models.json'),
    JSON.stringify({ 'opencode-go': { models: { 'glm-5.3': { limit: { context: 200_000 } } } } }),
  );
  (os as any).homedir = () => homeDirectory;

  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();
});
after(async () => {
  (os as any).homedir = originalHomedir;
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(databaseDirectory, { recursive: true, force: true });
  await rm(homeDirectory, { recursive: true, force: true });
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
  /** What the service's form/permission list routes report as still pending. */
  forms: unknown[];
  permissions: unknown[];
  emit: (event: Record<string, unknown>) => void;
  /** Ends the live event feed the way a dropped subscription does. */
  dropFeeds: () => void;
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
    forms: [],
    permissions: [],
    emit: (event) => {
      for (const feed of feeds) {
        feed.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    },
    dropFeeds: () => {
      for (const feed of [...feeds]) {
        feeds.delete(feed);
        feed.destroy();
      }
    },
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
        reply(200, { interrupted: true });
      } else if (request.method === 'GET' && url.endsWith('/form')) {
        reply(200, { data: service.forms });
      } else if (request.method === 'GET' && url.endsWith('/permission')) {
        reply(200, { data: service.permissions });
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

const makeContext = (providerSessionId: string | null): ProviderRuntimeContext => ({
  resolveProviderSessionId: () => providerSessionId,
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
 * Invokes the runtime's compaction facet. It is optional on the interface —
 * and present here, which is the capability that puts `/compact` in the
 * composer menu — so the test asserts it before calling.
 */
const compactSession = (
  runtime: ReturnType<typeof createOpenCodeRuntime>,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<unknown> => {
  assert.ok(runtime.compact, 'the opencode runtime must expose the compact facet');
  return runtime.compact(options, writer, context);
};

const withRuntime = async (
  run: (input: { service: FakeService; runtime: ReturnType<typeof createOpenCodeRuntime> }) => Promise<void>,
  runtimeDependencies: {
    adoptExternalRun?: (input: { providerSessionId: string }) => { appSessionId: string; writer: ProviderRuntimeWriter } | null;
  } = {},
) => {
  const service = await startFakeService();
  const endpoint = { url: service.url, authorization: 'Basic dGVzdA==' };
  const runtime = createOpenCodeRuntime({
    supervisor: {
      // currentEndpoint backs the event stream's re-resolver: after a boot it
      // must hand out the same endpoint the supervisor does.
      ensureEndpoint: async () => endpoint,
      onExit: () => () => {},
      currentEndpoint: () => endpoint,
    },
    abortSettleGraceMs: 300,
    ...runtimeDependencies,
  });
  try {
    await run({ service, runtime });
  } finally {
    service.close();
  }
};

/** Polls until `predicate` holds; adopted-run settlement is fire-and-forget. */
const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not met before the timeout');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
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
    // The step's own occupancy rides the budget frame; the session snapshot's
    // lifetime totals are deliberately never read as occupancy.
    service.emit(session('session.step.ended', {
      assistantMessageID: 'msg_a',
      tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
    }));
    service.emit(session('session.execution.succeeded', {}));
    await running;

    assert.deepEqual(service.requests.map((request) => [request.method, request.path]), [
      ['POST', '/api/session'],
      ['POST', '/api/session/ses_new/agent'],
      ['PATCH', '/api/session/ses_new'],
      ['POST', '/api/session/ses_new/model'],
      ['POST', '/api/session/ses_new/prompt'],
    ]);
    assert.deepEqual(service.requests[0].body, { location: { directory: '/tmp/project-a' }, title: 'Greeting' });
    assert.deepEqual(service.requests[1].body, { agent: 'build' });
    assert.deepEqual(service.requests[2].body, {
      permissions: ['shell', 'edit', 'write', 'patch'].map((action) => ({ action, resource: '*', effect: 'ask' })),
    });
    assert.deepEqual(service.requests[3].body, { model: { providerID: 'opencode-go', id: 'glm-5.3', variant: 'high' } });
    assert.deepEqual(service.requests[4].body, { text: 'hello there' });

    assert.deepEqual(sessionIds, ['ses_new']);
    assert.deepEqual(frames.map((frame) => frame.kind), ['session_created', 'stream_delta', 'stream_end', 'status', 'complete']);
    assert.equal(frames[0].newSessionId, 'ses_new');
    assert.equal(frames[1].content, 'Hi!');
    assert.equal(frames[1].sessionId, 'app-1');
    // Step occupancy: prompt 10 + 2 cache, output 5 + 1 reasoning, against the
    // model cache's declared 200k window.
    assert.deepEqual(frames[3].tokenBudget, {
      used: 18,
      total: 200_000,
      inputTokens: 12,
      outputTokens: 6,
      breakdown: { input: 12, output: 6 },
    });
    assert.equal(frames[4].success, true);
    assert.equal(frames[4].exitCode, 0);
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

test('compact posts the service compaction request and ends on the execution terminal', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const compacting = compactSession(runtime, { sessionId: 'app-1' }, writer, makeContext('ses_new'));
    const request = await service.waitForRequest((candidate) => candidate.path.endsWith('/compact'));
    assert.equal(request.method, 'POST');
    // No prompt, model or permission mode: the engine compacts the stored
    // conversation with whatever model the session already runs with.
    assert.deepEqual(request.body, {});

    service.emit(session('session.compaction.started', { reason: 'manual', recent: '', inputID: 'msg_compact' }));
    service.emit(session('session.execution.succeeded', {}));
    await compacting;

    assert.deepEqual(frames.map((frame) => frame.kind), ['complete']);
    assert.equal(frames[0].success, true);
    assert.equal(frames[0].exitCode, 0);
  });
});

test('compact fails the run when the engine reports the compaction failed', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const compacting = compactSession(runtime, { sessionId: 'app-1' }, writer, makeContext('ses_new'));
    await service.waitForRequest((candidate) => candidate.path.endsWith('/compact'));

    service.emit(session('session.compaction.failed', {
      reason: 'manual',
      inputID: 'msg_compact',
      error: { type: 'provider.no-route', message: 'Model unavailable: opencode/gpt-5.6-terra' },
    }));
    // The engine still ends that execution normally; the run must neither
    // wait for it nor paint success over the failure it was told about.
    service.emit(session('session.execution.succeeded', {}));

    await assert.rejects(compacting, /Model unavailable/);
    // Like a failed turn, the run ends with a failed `complete` and the
    // notification; the transcript's own failed-compaction row is what says
    // why (the gateway renders the thrown reason as its fallback card).
    assert.deepEqual(frames.map((frame) => frame.kind), ['complete']);
    assert.equal(frames[0].success, false);
  });
});

test('compact refuses a session that has no stored conversation yet', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    await assert.rejects(
      compactSession(runtime, { sessionId: 'app-1' }, writer, makeContext(null)),
      /no stored conversation/,
    );
    assert.deepEqual(frames.map((frame) => frame.kind), ['error', 'complete']);
    assert.equal(service.requests.length, 0, 'nothing is asked of the service');
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
  });
});

test('an execution failure surfaces one error frame, a failed complete, and rejects', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('x', { sessionId: 'app-1', projectPath: '/tmp/p' }, writer, makeContext('ses_new'));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    service.emit(session('session.step.ended', {
      assistantMessageID: 'm',
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
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

/** One SSE event for the engine-initiated session the tests adopt. */
const adoptedEvent = (type: string, data: Record<string, unknown> = {}) => ({
  id: `evt_ext_${Math.random()}`,
  created: Date.now(),
  type,
  data: { sessionID: 'ses_external', ...data },
});

test('an execution the engine starts on its own is adopted and rides the run pipeline', async () => {
  const adopted = makeWriter();
  const adoptCalls: string[] = [];
  await withRuntime(async ({ service, runtime }) => {
    // The event feed starts with the first dispatched run and stays open; the
    // engine-initiated execution below then arrives over that live stream.
    const warm = runtime.run('warm up', { sessionId: 'app-warm', projectPath: '/tmp/p' }, makeWriter().writer, makeContext(null));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));
    service.emit(session('session.execution.succeeded', {}));
    await warm;

    service.emit(adoptedEvent('session.execution.started'));
    service.emit(adoptedEvent('session.text.delta', { assistantMessageID: 'msg_ext', ordinal: 0, delta: 'resumed on my own' }));
    service.emit(adoptedEvent('form.created', {
      form: {
        id: 'frm_ext',
        sessionID: 'ses_external',
        title: 'Questions',
        metadata: { kind: 'question', tool: { messageID: 'msg_ext', id: 'call_ext' } },
        fields: [{
          key: 'q0',
          title: 'Beverage',
          description: 'Which one?',
          type: 'string',
          options: [{ value: 'tea', label: 'Tea' }],
        }],
      },
    }));

    // The question card surfaces through the adopted writer and answers route
    // back to the announcing session.
    await waitFor(() => adopted.frames.some((frame) => frame.kind === 'permission_request'));
    runtime.permissions?.resolve('frm_ext', { allow: true, updatedInput: { answers: { 'Which one?': 'Tea' } } });
    const reply = await service.waitForRequest((request) => request.path.endsWith('/form/frm_ext/reply'));
    assert.deepEqual(reply.body, { answer: { q0: 'Tea' } });
    await waitFor(() => adopted.frames.some((frame) => frame.kind === 'permission_resolved'));

    service.emit(adoptedEvent('session.execution.succeeded'));
    await waitFor(() => adopted.frames.some((frame) => frame.kind === 'complete'));

    assert.deepEqual(adoptCalls, ['ses_external']);
    assert.deepEqual(adopted.frames.map((frame) => frame.kind), [
      'stream_delta', 'permission_request', 'permission_resolved', 'complete',
    ]);
    assert.equal(adopted.frames[0].content, 'resumed on my own');
    assert.equal(adopted.frames[0].sessionId, 'app-adopted');
    assert.equal(adopted.frames[3].exitCode, 0);
  }, {
    adoptExternalRun: ({ providerSessionId }) => {
      adoptCalls.push(providerSessionId);
      return providerSessionId === 'ses_external'
        ? { appSessionId: 'app-adopted', writer: adopted.writer }
        : null;
    },
  });
});

test('the permission facet re-reads the service for asks the event feed never delivered', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('hello', { sessionId: 'app-1', projectPath: '/tmp/project' }, writer, makeContext(null));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));

    assert.ok(runtime.permissions?.reconcilePending, 'the facade exposes the reconcile hook');
    // The gap: both asks exist only in the service's pending set, because the
    // events that announced them were emitted while the feed was down.
    service.forms = [{
      id: 'frm_gap',
      sessionID: 'ses_new',
      title: 'Questions',
      metadata: { kind: 'question', tool: { messageID: 'msg_a', id: 'call_gap' } },
      fields: [{
        key: 'q0',
        title: 'Curtain',
        description: 'Which side?',
        type: 'string',
        options: [{ value: 'right', label: 'Right' }],
      }],
    }];
    service.permissions = [{
      id: 'per_gap',
      sessionID: 'ses_new',
      action: 'shell',
      resources: ['echo gap'],
      source: { type: 'tool', messageID: 'msg_a', id: 'call_gap' },
    }];

    runtime.permissions?.reconcilePending?.('app-1');

    await waitFor(() => frames.some((frame) => frame.kind === 'permission_request' && frame.toolName === 'AskUserQuestion'));
    await waitFor(() => frames.some((frame) => frame.kind === 'permission_request' && frame.toolName === 'shell'));
    assert.deepEqual(
      service.requests
        .filter((request) => request.path === '/api/session/ses_new/form' || request.path === '/api/session/ses_new/permission')
        .map((request) => request.path)
        .sort(),
      ['/api/session/ses_new/form', '/api/session/ses_new/permission'],
    );
    assert.equal(runtime.permissions?.listPending('app-1').length, 2);

    // Answering a reconciled card routes the panel's answer back onto the
    // service's field keys, exactly like a card that arrived as an event.
    runtime.permissions?.resolve('frm_gap', { allow: true, updatedInput: { answers: { 'Which side?': 'Right' } } });
    const reply = await service.waitForRequest((request) => request.path.endsWith('/form/frm_gap/reply'));
    assert.deepEqual(reply.body, { answer: { q0: 'Right' } });

    service.emit(session('session.execution.succeeded', {}));
    await running;
  });
});

test('an event-stream reconnect re-reads the asks raised inside the gap', async () => {
  await withRuntime(async ({ service, runtime }) => {
    const { writer, frames } = makeWriter();
    const running = runtime.run('hello', { sessionId: 'app-1', projectPath: '/tmp/project' }, writer, makeContext(null));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));

    service.forms = [{
      id: 'frm_after_gap',
      sessionID: 'ses_new',
      title: 'Questions',
      metadata: { kind: 'question', tool: { messageID: 'msg_a', id: 'call_gap' } },
      fields: [{
        key: 'q0',
        title: 'Curtain',
        description: 'Which side?',
        type: 'string',
        options: [{ value: 'right', label: 'Right' }],
      }],
    }];
    // The run is still working: the session row has no idle timestamp, which is
    // what the reconnect's run reconcile reads before leaving it open.
    service.snapshot = { ...service.snapshot, time: { idle: null } };
    // Dropping the feed is what a slow-consumer overflow or a restart looks
    // like from here: the connection ends and the gap's events are gone.
    service.dropFeeds();

    await waitFor(() => service.requests.some((request) => request.path === '/api/session/ses_new/form'), 5_000);
    await waitFor(() => frames.some((frame) => frame.kind === 'permission_request' && frame.toolName === 'AskUserQuestion'));

    service.emit(session('session.execution.succeeded', {}));
    await running;
  });
});

test('sessions with an active run or no app mapping are never adopted', async () => {
  const adopted = makeWriter();
  const adoptCalls: string[] = [];
  await withRuntime(async ({ service, runtime }) => {
    const warm = runtime.run('warm up', { sessionId: 'app-warm', projectPath: '/tmp/p' }, makeWriter().writer, makeContext(null));
    await service.waitForRequest((request) => request.path.endsWith('/prompt'));

    // The warm session has a run of ours: the adopter must never be consulted.
    service.emit(session('session.step.started', {}));
    // A session the adopter declines (no app session row) plus lifecycle
    // chatter that fires outside executions; only the step event may trigger.
    service.emit({ id: 'x1', created: Date.now(), type: 'session.step.started', data: { sessionID: 'ses_foreign' } });
    service.emit({ id: 'x2', created: Date.now(), type: 'session.inbox.enqueued', data: { sessionID: 'ses_foreign' } });

    service.emit(session('session.execution.succeeded', {}));
    await warm;
    await waitFor(() => adoptCalls.length > 0);

    assert.deepEqual(adoptCalls, ['ses_foreign']);
    assert.equal(adopted.frames.length, 0);
  }, {
    adoptExternalRun: ({ providerSessionId }) => {
      adoptCalls.push(providerSessionId);
      return providerSessionId === 'ses_external'
        ? { appSessionId: 'app-adopted', writer: adopted.writer }
        : null;
    },
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
