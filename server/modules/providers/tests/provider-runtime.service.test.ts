import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { createProviderRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type { IProvider, IProviderRuntime } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

function createRuntime(overrides: Partial<IProviderRuntime> = {}): IProviderRuntime {
  return {
    async run() {
      return undefined;
    },
    abort() {
      return false;
    },
    ...overrides,
  };
}

function createProvider(id: LLMProvider, runtime: IProviderRuntime): IProvider {
  return {
    id,
    runtime,
    auth: {
      async getStatus() {
        return {
          provider: id,
          installed: true,
          authenticated: true,
          method: 'test',
          details: {},
        };
      },
    },
    sessions: {
      normalizeMessage(raw: unknown, sessionId: string | null) {
        return [{ kind: 'assistant', content: String(raw), sessionId, provider: id }];
      },
      async fetchHistory() {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      },
    },
  } as unknown as IProvider;
}

function createService(providers: IProvider[]) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  return createProviderRuntimeService({
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providerMap.get(providerName as LLMProvider);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: (sessionId) => sessionId ? `native-${sessionId}` : null,
    async resolveResumeModel(_provider, _sessionId, requestedModel) {
      return requestedModel?.trim() || undefined;
    },
    async getProviderModels() {
      return {
        OPTIONS: [],
        DEFAULT: 'default-model',
      };
    },
  });
}

test('providerRegistry owns one runtime for every registered provider', () => {
  const providers = providerRegistry.listProviders();

  assert.deepEqual(providers.map((provider) => provider.id), [
    'claude',
    'codex',
    'cursor',
    'opencode',
    'zcode',
    'antigravity',
  ]);
  assert.equal(providers.every((provider) => typeof provider.runtime.run === 'function'), true);
  assert.equal(providers.every((provider) => typeof provider.runtime.abort === 'function'), true);
});

test('dispatches runs and aborts through the runtime owned by providerRegistry', async () => {
  const calls: unknown[][] = [];
  const runtime = createRuntime({
    async run(command, options, writer, context) {
      calls.push(['run', command, options, writer]);
      assert.equal(context.resolveProviderSessionId('session-1'), 'native-session-1');
      assert.equal(await context.resolveResumeModel('session-1', 'sonnet'), 'sonnet');
      assert.deepEqual(await context.getProviderModels(), { OPTIONS: [], DEFAULT: 'default-model' });
      assert.equal(context.normalizeMessage('hello', 'session-1')[0]?.provider, 'claude');
      assert.equal(await context.isProviderInstalled(), true);
      return 'complete';
    },
    async abort(sessionId) {
      calls.push(['abort', sessionId]);
      return true;
    },
  });
  const service = createService([createProvider('claude', runtime)]);
  const writer = { send() {} };

  assert.equal(service.hasRuntime('claude'), true);
  assert.equal(service.hasRuntime('unknown'), false);
  assert.equal(await service.getRunner('claude')('hello', { model: 'sonnet' }, writer), 'complete');
  assert.equal(await service.abort('claude', 'session-1'), true);
  assert.deepEqual(calls, [
    ['run', 'hello', { model: 'sonnet' }, writer],
    ['abort', 'session-1'],
  ]);
});

test('routes permission decisions through provider-owned runtime capabilities', () => {
  const decisions: unknown[][] = [];
  const claudeRuntime = createRuntime({
    permissions: {
      resolve(requestId, decision) {
        decisions.push([requestId, decision]);
      },
      listPending(sessionId) {
        return [{ requestId: 'request-1', sessionId }];
      },
    },
  });
  const service = createService([
    createProvider('claude', claudeRuntime),
    createProvider('cursor', createRuntime()),
  ]);
  const decision = { allow: true, message: 'approved' };

  service.resolveToolApproval('request-1', decision);

  assert.deepEqual(decisions, [['request-1', decision]]);
  assert.deepEqual(service.getPendingApprovalsForSession('session-1'), [
    { requestId: 'request-1', sessionId: 'session-1' },
  ]);
});

test('only runtimes that track the reply phase report background work as pending', () => {
  const service = createService([
    createProvider('claude', createRuntime({
      backgroundTasks: { list: () => [], isPending: (sessionId) => sessionId === 'claude-session' },
    })),
    createProvider('codex', createRuntime({
      listBackgroundWork: () => [{ sessionId: 'codex-session', tasks: [] }],
    })),
  ]);

  assert.equal(service.isBackgroundWorkPending('claude-session'), true);
  // Codex never sends the frame that would clear a pending flag on the client.
  assert.equal(service.isBackgroundWorkPending('codex-session'), false);
  assert.equal(service.hasBackgroundWork('codex-session'), true);
  assert.equal(service.hasBackgroundWork('claude-session'), true);
  assert.equal(service.hasBackgroundWork('idle-session'), false);
});

test('background work is stoppable unless the runtime holding it says it is not', () => {
  const service = createService([
    createProvider('claude', createRuntime({ backgroundTasks: { list: () => [] } })),
    createProvider('zcode', createRuntime({
      backgroundTasks: { list: () => [], canInterrupt: (sessionId) => sessionId !== 'zcode-idle-session' },
    })),
  ]);

  assert.equal(service.canInterruptBackgroundWork('zcode-idle-session'), false);
  assert.equal(service.canInterruptBackgroundWork('zcode-running-session'), true);
  assert.equal(service.canInterruptBackgroundWork('claude-session'), true);
});

test('background work holds back the next message unless the runtime holding it takes turns alongside it', () => {
  const service = createService([
    createProvider('claude', createRuntime({ backgroundTasks: { list: () => [], queuesInput: () => false } })),
    createProvider('zcode', createRuntime({ backgroundTasks: { list: () => [] } })),
  ]);

  assert.equal(service.backgroundWorkQueuesInput('claude', 'claude-session'), false);
  assert.equal(service.backgroundWorkQueuesInput('zcode', 'zcode-session'), true);
});

test('execution discovery reads registered runtimes and installation state without a second engine list', async () => {
  const installed = createProvider('zcode', createRuntime({ supportsTaskExecution: true }));
  const unavailable = createProvider('cursor', createRuntime());
  unavailable.auth.getStatus = async () => ({ provider: 'cursor', installed: false } as Awaited<ReturnType<typeof unavailable.auth.getStatus>>);
  const service = createService([installed, unavailable]);
  assert.deepEqual(await service.listExecutionProviders(), [{ provider: 'zcode', installed: true, supportsTaskExecution: true }, { provider: 'cursor', installed: false, supportsTaskExecution: false }]);
});


test('only ZCode currently declares reliable task execution termination semantics', async () => {
  const providers = providerRegistry.listProviders();
  assert.deepEqual(providers.filter((provider) => provider.runtime.supportsTaskExecution).map((provider) => provider.id), ['zcode']);
});
