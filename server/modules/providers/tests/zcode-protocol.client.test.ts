import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionEventListener } from '../list/zcode/zcode-codec.js';
import type { RequestRouter } from '../list/zcode/zcode-request-router.js';
import type { EngineSupervisor } from '../list/zcode/zcode-engine-supervisor.js';
import { ZCodeProtocolClient } from '../list/zcode/zcode-protocol.client.js';

type FakeSupervisor = {
  processId: number | null;
  enginePath: string | null;
  ensureRunningCalls: number;
  crashListeners: ((info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void)[];
  lineListeners: ((line: string) => void)[];
  ensureRunning: () => Promise<void>;
  getProcessId: () => number | null;
  getEnginePath: () => string | null;
  onCrash: (listener: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void) => void;
  onLine: (listener: (line: string) => void) => void;
  writeLine: (line: string) => void;
  shutdown: () => Promise<void>;
  simulateCrash: () => void;
};

type FakeRouter = {
  requests: { method: string; params: Record<string, unknown>; timeout?: number }[];
  failAllPendingCalls: number;
  notifySessionLostCalls: number;
  request: <T = unknown>(method: string, params?: Record<string, unknown>, timeout?: number) => Promise<T>;
  failAllPending: (error: Error) => void;
  notifySessionLost: (code: number | null, signal: NodeJS.Signals | null, stderrTail: string) => void;
  addSessionListener: (sessionId: string, listener: SessionEventListener) => void;
  removeSessionListener: (sessionId: string, listener: SessionEventListener) => void;
  setServerRequestHandler: (handler: unknown) => void;
  handleLine: (line: string) => void;
};

function createMocks() {
  const supervisor: FakeSupervisor = {
    processId: 1234,
    enginePath: '/fake/engine/zcode.cjs',
    ensureRunningCalls: 0,
    crashListeners: [],
    lineListeners: [],
    ensureRunning: async () => {
      supervisor.ensureRunningCalls += 1;
    },
    getProcessId: () => supervisor.processId,
    getEnginePath: () => supervisor.enginePath,
    onCrash: (l) => {
      supervisor.crashListeners.push(l);
    },
    onLine: (l) => {
      supervisor.lineListeners.push(l);
    },
    writeLine: () => {},
    shutdown: async () => {},
    simulateCrash: () => {
      supervisor.processId = null;
      for (const l of supervisor.crashListeners) {
        l({ code: 1, signal: null, stderrTail: 'crashed' });
      }
    },
  };

  const router: FakeRouter = {
    requests: [],
    failAllPendingCalls: 0,
    notifySessionLostCalls: 0,
    request: async <T = unknown>(method: string, params: Record<string, unknown> = {}, timeout?: number): Promise<T> => {
      router.requests.push({ method, params, timeout });
      return { success: true } as T;
    },
    failAllPending: () => {
      router.failAllPendingCalls += 1;
    },
    notifySessionLost: () => {
      router.notifySessionLostCalls += 1;
    },
    addSessionListener: () => {},
    removeSessionListener: () => {},
    setServerRequestHandler: () => {},
    handleLine: () => {},
  };

  return { supervisor, router };
}

test('ZCodeProtocolClient sends provider/updateAccountConfig before first business request if sync payload exists', async () => {
  const { supervisor, router } = createMocks();

  const fakePayload = {
    revision: '1',
    basedOnZCodeBuiltinRevision: 'zcode-builtin:30:abc',
    providers: { 'account:bigmodel-start-plan': { access: { type: 'zhipu-account', entitled: true } } },
  };

  const client = new ZCodeProtocolClient(
    supervisor as unknown as EngineSupervisor,
    router as unknown as RequestRouter,
    {
      findActiveBuiltinConfig: () => '/fake/builtin_config.json',
      buildZCodeAccountSyncPayload: () => fakePayload,
    },
  );

  const res = await client.sendRequest('session/create', { workspace: {} });
  assert.deepEqual(res, { success: true });

  // Must have sent updateAccountConfig first, then session/create
  assert.equal(router.requests.length, 2);
  assert.equal(router.requests[0]?.method, 'provider/updateAccountConfig');
  assert.deepEqual(router.requests[0]?.params, fakePayload);
  assert.equal(router.requests[1]?.method, 'session/create');

  // Second request should not sync again for same process
  await client.sendRequest('session/setModel', { model: 'glm-4' });
  assert.equal(router.requests.length, 3);
  assert.equal(router.requests[2]?.method, 'session/setModel');
});

test('ZCodeProtocolClient skips sync when no payload is returned', async () => {
  const { supervisor, router } = createMocks();

  const client = new ZCodeProtocolClient(
    supervisor as unknown as EngineSupervisor,
    router as unknown as RequestRouter,
    {
      findActiveBuiltinConfig: () => '/fake/builtin_config.json',
      buildZCodeAccountSyncPayload: () => null,
    },
  );

  await client.sendRequest('session/create', { workspace: {} });

  assert.equal(router.requests.length, 1);
  assert.equal(router.requests[0]?.method, 'session/create');
});

test('ZCodeProtocolClient re-syncs after process crash and restart', async () => {
  const { supervisor, router } = createMocks();

  const fakePayload = {
    revision: '1',
    basedOnZCodeBuiltinRevision: 'zcode-builtin:30:abc',
    providers: { 'account:bigmodel-start-plan': { access: { type: 'zhipu-account', entitled: true } } },
  };

  const client = new ZCodeProtocolClient(
    supervisor as unknown as EngineSupervisor,
    router as unknown as RequestRouter,
    {
      findActiveBuiltinConfig: () => '/fake/builtin_config.json',
      buildZCodeAccountSyncPayload: () => fakePayload,
    },
  );

  await client.sendRequest('session/create', {});
  assert.equal(router.requests.length, 2);
  assert.equal(router.requests[0]?.method, 'provider/updateAccountConfig');

  // Crash
  supervisor.simulateCrash();
  supervisor.processId = 5678; // New process

  await client.sendRequest('session/resume', {});
  assert.equal(router.requests.length, 4);
  assert.equal(router.requests[2]?.method, 'provider/updateAccountConfig');
  assert.equal(router.requests[3]?.method, 'session/resume');
});

test('ZCodeProtocolClient swallows sync error without blocking business request', async () => {
  const { supervisor, router } = createMocks();

  router.request = async <T = unknown>(method: string, params: Record<string, unknown> = {}, timeout?: number): Promise<T> => {
    router.requests.push({ method, params, timeout });
    if (method === 'provider/updateAccountConfig') {
      throw new Error('Sync failed');
    }
    return { success: true } as T;
  };

  const client = new ZCodeProtocolClient(
    supervisor as unknown as EngineSupervisor,
    router as unknown as RequestRouter,
    {
      findActiveBuiltinConfig: () => '/fake/builtin_config.json',
      buildZCodeAccountSyncPayload: () => ({ revision: '1' }),
    },
  );

  const res = await client.sendRequest('session/create', {});
  assert.deepEqual(res, { success: true });
  assert.equal(router.requests.length, 2);
  assert.equal(router.requests[0]?.method, 'provider/updateAccountConfig');
  assert.equal(router.requests[1]?.method, 'session/create');
});
