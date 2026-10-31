import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, afterEach, test } from 'node:test';

import { initializeDatabase, closeConnection, sessionsDb, userDb } from '@/modules/database/index.js';
import { providerModelsService, providerRuntimeService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { LLMProvider, ProviderRuntimeWriter } from '@/shared/types.js';

import { createExecutionModule } from '../execution.module.js';

const directory = mkdtempSync(join(tmpdir(), 'execution-module-'));
const previous = { ...process.env };
process.env.DATABASE_PATH = join(directory, 'auth.db');
process.env.CLOUDCLI_EXECUTION_ROOTS = JSON.stringify([directory]);
process.env.CLOUDCLI_EXECUTION_TOKEN = 'module-test-token-at-least-32-characters';
const providers: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'zcode', 'antigravity'];
let serial = 0;
before(async () => { await initializeDatabase(); userDb.createUser('execution-test', 'test-hash'); });
afterEach(() => chatRunRegistry.clearAll());
after(() => { closeConnection(); process.env = previous; rmSync(directory, { recursive: true, force: true }); });
function service(run: typeof providerRuntimeService.run, overrides: Partial<typeof providerRuntimeService> = {}) {
  process.env.CLOUDCLI_EXECUTION_DIR = join(directory, `records-${serial++}`);
  return createExecutionModule({
    runtime: { ...providerRuntimeService, listExecutionProviders: async () => providers.map((provider) => ({ provider, installed: true, supportsTaskExecution: true })),
      run, hasSessionWork: () => false, hasBackgroundWork: () => false, abort: async () => false, ...overrides },
    models: { ...providerModelsService, getProviderModels: async () => ({ DEFAULT: 'test-model', OPTIONS: [{ value: 'test-model', label: 'Test' }] }) },
  }).service();
}
const request = (provider: LLMProvider, id: string) => ({ requestId: id, provider, model: 'test-model', cwd: directory, prompt: 'test', permissionMode: 'default' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 130));

test('every registered provider shares dispatch, model, permission and original-session continuation', async () => {
  const seen: unknown[] = [];
  const execution = service(async (provider, _prompt, options, writer) => {
    seen.push({ provider, permissionMode: options.permissionMode, skipPermissions: options.skipPermissions });
    writer.setSessionId?.(`native-${String(options.sessionId)}`);
    writer.send({ kind: 'stream_delta', role: 'assistant', content: 'done' });
    writer.send({ kind: 'complete', exitCode: 0 });
    return { success: true };
  });
  for (const provider of providers) {
    const first = await execution.start(request(provider, `${provider}-first`));
    await tick();
    assert.equal(execution.get({ runId: first.runId }).state, 'succeeded');
    const next = await execution.continue({ ...request(provider, `${provider}-next`), sessionId: first.sessionId });
    await tick();
    assert.equal(next.sessionId, first.sessionId);
    assert.equal(execution.get({ runId: next.runId }).stopConfirmed, true);
  }
  assert.equal(seen.length, 12);
  assert.ok(seen.every((entry) => (entry as { skipPermissions: boolean }).skipPermissions === false));
});

test('runtime rejection after dispatch is not proof of stop', async () => {
  const execution = service(async () => { throw new Error('response lost after session/send'); });
  const run = await execution.start(request('zcode', 'response-lost'));
  const gatewayRun = chatRunRegistry.getRun(run.sessionId)!;
  await tick();
  const state = execution.get({ runId: run.runId });
  assert.equal(state.stopConfirmed, false);
  assert.equal(state.state, 'interrupted');
  assert.match(state.error!, /response lost/);
  assert.equal((await execution.cancel({ requestId: 'response-lost' })).stopConfirmed, false);
  // 网关侧同样必须收口：运行时没发 complete 就结束时，run 不能永远占着会话，
  // 否则 chat.send、定时消息和后续派发都被卡死，只能靠用户手点停止恢复。
  assert.equal(chatRunRegistry.isProcessing(run.sessionId), false);
  assert.equal(gatewayRun.endReason, 'dispatch_failed');
  assert.ok(gatewayRun.events.some((event) => event.kind === 'error'));
});

test('background work keeps both the execution and chat admission busy after turn complete', async () => {
  let background = true;
  const execution = service(async (_provider, _prompt, _options, writer) => {
    writer.send({ kind: 'complete', exitCode: 0 });
    return { success: true };
  }, { hasBackgroundWork: () => background });
  const run = await execution.start(request('zcode', 'background'));
  await tick();
  assert.equal(execution.get({ runId: run.runId }).stopConfirmed, false);
  assert.equal(chatRunRegistry.isProcessing(run.sessionId), true);
  background = false;
  await tick();
  assert.equal(execution.get({ runId: run.runId }).stopConfirmed, true);
  assert.equal(chatRunRegistry.isProcessing(run.sessionId), false);
});

test('continuation refuses a replacement native identity and preserves the original mapping', async () => {
  let replacement = false;
  let stops = 0;
  const execution = service(async (_provider, _prompt, options, writer) => {
    writer.setSessionId?.(replacement ? 'different-native' : `native-${String(options.sessionId)}`);
    writer.send({ kind: 'complete', exitCode: 0 });
    return { success: true };
  }, { abort: async () => { stops++; return true; } });
  const first = await execution.start(request('zcode', 'identity-first'));
  await tick();
  const original = sessionsDb.getSessionById(first.sessionId)?.provider_session_id;
  replacement = true;
  const next = await execution.continue({ ...request('zcode', 'identity-next'), sessionId: first.sessionId });
  await tick();
  assert.equal(execution.get({ runId: next.runId }).state, 'failed');
  assert.equal(sessionsDb.getSessionById(first.sessionId)?.provider_session_id, original);
  assert.equal(stops, 1);
});


test('a chat UI abort remains a cancellation in the execution record', async () => {
  let writer!: ProviderRuntimeWriter;
  let settle!: () => void;
  const execution = service(async (_provider, _prompt, _options, output) => {
    writer = output;
    await new Promise<void>((resolve) => { settle = resolve; });
    return { success: false };
  });
  const started = await execution.start(request('zcode', 'ui-abort'));
  const run = chatRunRegistry.getRun(started.sessionId)!;
  chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0, aborted: true, reason: 'client_abort' });
  writer.send({ kind: 'complete', exitCode: 0 });
  settle();
  await tick();
  const result = execution.get({ runId: started.runId });
  assert.equal(result.state, 'cancelled');
  assert.equal(result.stopConfirmed, true);
});
