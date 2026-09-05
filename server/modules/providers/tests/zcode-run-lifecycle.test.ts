/**
 * ZCode Run Lifecycle Unit Tests
 *
 * Drives the run state machine and the permission registry directly — no
 * engine process. Sequences here mirror the runtime's real flows: a run
 * completing or going silent, a watcher standing down after a newer run,
 * stacked permission re-announcements answered by one decision, and the
 * answered-decision cache keeping late re-announcements from resurrecting
 * cards.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NormalizedMessage, ProviderRuntimeWriter } from '@/shared/types.js';

import { EngineSilenceTimeoutError, ZCodeRunLifecycle } from '../list/zcode/zcode-run-lifecycle.js';
import type { ProtocolServerRequest } from '../list/zcode/zcode-codec.js';

const createWriter = (): { messages: NormalizedMessage[]; writer: ProviderRuntimeWriter } => {
  const messages: NormalizedMessage[] = [];
  const writer: ProviderRuntimeWriter = {
    userId: null,
    send: (data: unknown) => messages.push(data as NormalizedMessage),
    setSessionId: () => undefined,
  };
  return { messages, writer };
};

const permissionRequest = (id: number, params: Record<string, unknown>): ProtocolServerRequest => ({
  id,
  method: 'interaction/requestPermission',
  params: {
    requestId: 'perm_req_1',
    sessionId: 'sess_engine_1',
    toolCallId: 'call_1',
    toolName: 'Bash',
    input: { command: 'echo hi' },
    ...params,
  },
});

test('a run settles completed and dispose clears both registries', async () => {
  const lifecycle = new ZCodeRunLifecycle();
  const { writer } = createWriter();
  const handle = lifecycle.startRun({ abortKey: 'app-1', sessionId: 'sess_engine_1', appSessionId: 'app-1', writer });

  assert.equal(lifecycle.handleOf('app-1'), handle);

  lifecycle.recordCompletion(handle, 42);
  assert.deepEqual(await lifecycle.waitForSettle(handle, 1000), { kind: 'completed' });
  assert.deepEqual(lifecycle.completionOf(handle), { failed: false, failedMessage: undefined, tokenUsage: 42 });

  lifecycle.dispose(handle);
  assert.equal(lifecycle.handleOf('app-1'), undefined);
  assert.equal(lifecycle.isActiveRun(handle), false);
});

test('a fully silent run settles as silent for watcher handoff', async () => {
  const lifecycle = new ZCodeRunLifecycle();
  const { writer } = createWriter();
  const handle = lifecycle.startRun({ abortKey: 'app-silent', sessionId: 'sess_engine_1', appSessionId: 'app-silent', writer });

  const settle = await lifecycle.waitForSettle(handle, 120);
  assert.equal(settle.kind, 'silent');
  assert.equal(settle.kind === 'silent' ? settle.timeoutMs : 0, 120);

  // The stall message is user-visible chat text; it must keep its shape.
  const error = new EngineSilenceTimeoutError(120);
  assert.match(error.message, /silent/);

  lifecycle.dispose(handle);
});

test('a newer run for the same abort key supersedes the old waiter and shields dispose', async () => {
  const lifecycle = new ZCodeRunLifecycle();
  const { writer } = createWriter();
  const first = lifecycle.startRun({ abortKey: 'app-1', sessionId: 'sess_engine_1', appSessionId: 'app-1', writer });
  const second = lifecycle.startRun({ abortKey: 'app-1', sessionId: 'sess_engine_1', appSessionId: 'app-1', writer });

  assert.deepEqual(await lifecycle.waitForSettle(first, 5000), { kind: 'superseded' });

  // The stale watcher's dispose must not tear the new run's registrations out.
  lifecycle.dispose(first);
  assert.equal(lifecycle.handleOf('app-1'), second);
  assert.equal(lifecycle.isActiveRun(second), true);

  lifecycle.dispose(second);
  assert.equal(lifecycle.handleOf('app-1'), undefined);
});

test('a delivered abort settles the run as aborted', async () => {
  const lifecycle = new ZCodeRunLifecycle();
  const { writer } = createWriter();
  const handle = lifecycle.startRun({ abortKey: 'app-abort', sessionId: 'sess_engine_1', appSessionId: 'app-abort', writer });

  lifecycle.requestAbort(handle);
  assert.deepEqual(await lifecycle.waitForSettle(handle, 5000), { kind: 'aborted' });
  assert.equal(lifecycle.completionOf(handle).failed, false, 'an abort is not an engine failure');

  lifecycle.dispose(handle);
});

test('session-lost fails a waiting run but never overwrites a reached terminal state', () => {
  const lifecycle = new ZCodeRunLifecycle();
  const { writer } = createWriter();

  const lost = lifecycle.startRun({ abortKey: 'app-lost', sessionId: 'sess_engine_1', appSessionId: 'app-lost', writer });
  lifecycle.recordSessionLost(lost);
  assert.deepEqual(lifecycle.completionOf(lost), {
    failed: true,
    failedMessage: 'ZCode engine connection was lost',
    tokenUsage: undefined,
  });

  const completedFirst = lifecycle.startRun({ abortKey: 'app-done', sessionId: 'sess_engine_1', appSessionId: 'app-done', writer });
  lifecycle.recordCompletion(completedFirst, 7);
  lifecycle.recordSessionLost(completedFirst);
  assert.deepEqual(lifecycle.completionOf(completedFirst).failed, false);
  assert.equal(lifecycle.completionOf(completedFirst).tokenUsage, 7);
});

test('one decision satisfies every stacked permission announcement', async () => {
  const lifecycle = new ZCodeRunLifecycle();
  const { messages, writer } = createWriter();
  const handle = lifecycle.startRun({ abortKey: 'app-perm', sessionId: 'sess_engine_1', appSessionId: 'app-perm', writer });

  const first = lifecycle.handleServerRequest(permissionRequest(1, {}));
  const second = lifecycle.handleServerRequest(permissionRequest(2, {}));

  assert.ok(messages.some((msg) => msg.kind === 'permission_request'), 'the first announcement must reach the chat stream');
  assert.equal(messages.filter((msg) => msg.kind === 'permission_request').length, 1, 're-announcements must not spawn a second card');

  const pending = lifecycle.listPendingPermissions('app-perm');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sessionId, 'app-perm', 'the card must be found by app session id');
  assert.equal(lifecycle.listPendingPermissions('sess_engine_1').length, 1, 'the native session id must also resolve');

  lifecycle.resolvePermission('perm_req_1', { allow: true, message: 'ok' });

  assert.deepEqual(await first, { result: { decision: 'allow', reason: 'ok' } });
  assert.deepEqual(await second, { result: { decision: 'allow', reason: 'ok' } });
  assert.deepEqual(lifecycle.listPendingPermissions('app-perm'), []);
  assert.ok(
    messages.some((msg) => msg.kind === 'permission_cancelled' && msg.requestId === 'perm_req_1'),
    'resolving must retract the card'
  );

  lifecycle.dispose(handle);
});

test('a late re-announcement after the decision is served from the record; a reused id with new content is fresh', async () => {
  const lifecycle = new ZCodeRunLifecycle();
  const { messages, writer } = createWriter();
  const handle = lifecycle.startRun({ abortKey: 'app-cache', sessionId: 'sess_engine_1', appSessionId: 'app-cache', writer });

  const first = lifecycle.handleServerRequest(permissionRequest(1, {}));
  lifecycle.resolvePermission('perm_req_1', { allow: true });
  await first;

  // Late re-announcement: same requestId, same toolCallId → answered directly.
  const lateAnswer = await lifecycle.handleServerRequest(permissionRequest(2, {}));
  assert.deepEqual(lateAnswer, { result: { decision: 'allow', reason: undefined } });
  assert.equal(messages.filter((msg) => msg.kind === 'permission_request').length, 1, 'no second card may appear');

  // Same requestId, different call content → a genuinely new request.
  const fresh = lifecycle.handleServerRequest(permissionRequest(3, { toolCallId: 'call_2' }));
  const pending = lifecycle.listPendingPermissions('app-cache');
  assert.equal(pending.length, 1, 'the reused-id request must surface as its own card');
  lifecycle.resolvePermission('perm_req_1', { allow: false, message: 'Denied by user' });
  assert.deepEqual(await fresh, { result: { decision: 'deny', reason: 'Denied by user' } });

  lifecycle.dispose(handle);
});

test('a permission for a session without a live run is denied outright', async () => {
  const lifecycle = new ZCodeRunLifecycle();
  const answer = await lifecycle.handleServerRequest(permissionRequest(1, { sessionId: 'sess_unknown' }));
  assert.deepEqual(answer, { result: { decision: 'deny', reason: 'No active chat stream for this session' } });
  assert.deepEqual(lifecycle.listPendingPermissions('sess_unknown'), []);
});

test('a pending card expires after its TTL and its parked engine request is denied', async () => {
  const lifecycle = new ZCodeRunLifecycle({ pendingTtlMs: 20 });
  const { writer } = createWriter();
  const handle = lifecycle.startRun({ abortKey: 'app-ttl', sessionId: 'sess_engine_1', appSessionId: 'app-ttl', writer });

  const parked = lifecycle.handleServerRequest(permissionRequest(1, {}));
  assert.equal(lifecycle.listPendingPermissions('app-ttl').length, 1);

  await new Promise((resolve) => setTimeout(resolve, 60));

  // The sweep runs inside listPendingPermissions, so read it first — reading
  // is what resolves the parked engine request below.
  assert.deepEqual(lifecycle.listPendingPermissions('app-ttl'), [], 'the expired card must be swept');
  // The parked engine request must not dangle forever: it resolves with an
  // explicit deny so the router can answer the engine.
  assert.deepEqual(await parked, { result: { decision: 'deny', reason: 'Permission request expired unanswered' } });

  // The expired entry must not haunt later announcements: a fresh request
  // under the same id is surfaced again, answerable on its own.
  const fresh = lifecycle.handleServerRequest(permissionRequest(2, {}));
  assert.equal(lifecycle.listPendingPermissions('app-ttl').length, 1);
  lifecycle.resolvePermission('perm_req_1', { allow: true });
  assert.deepEqual(await fresh, { result: { decision: 'allow', reason: undefined } });

  lifecycle.dispose(handle);
});

test('a re-announcement refreshes the pending card freshness instead of expiring it', async () => {
  const lifecycle = new ZCodeRunLifecycle({ pendingTtlMs: 60 });
  const { writer } = createWriter();
  const handle = lifecycle.startRun({ abortKey: 'app-refresh', sessionId: 'sess_engine_1', appSessionId: 'app-refresh', writer });

  lifecycle.handleServerRequest(permissionRequest(1, {}));
  // Wait out most of the TTL, then let the engine re-announce: the stamp must
  // restart so the card stays answerable past the original window.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const restack = lifecycle.handleServerRequest(permissionRequest(2, {}));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(lifecycle.listPendingPermissions('app-refresh').length, 1, 'the refreshed card must still be pending');

  lifecycle.resolvePermission('perm_req_1', { allow: true });
  assert.deepEqual(await restack, { result: { decision: 'allow', reason: undefined } });

  lifecycle.dispose(handle);
});

test('non-permission server requests fall through to the default policy', () => {
  const lifecycle = new ZCodeRunLifecycle();
  assert.deepEqual(
    lifecycle.handleServerRequest({ id: 'server-1', method: 'session/requestRuntimePreferences', params: {} }),
    { result: { nativeSearchEnhancementsEnabled: false } }
  );
  assert.deepEqual(
    lifecycle.handleServerRequest({ id: 'server-2', method: 'session/unknownCallback', params: {} }),
    { error: { code: -32601, message: 'Method not found: session/unknownCallback' } }
  );
});
