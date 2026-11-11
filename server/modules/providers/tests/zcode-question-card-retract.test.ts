/**
 * ZCode zombie question-card retraction tests
 *
 * When the engine's AskUserQuestion times out, it resolves the tool call on
 * its own (the transcript shows "Skipped") and stops re-announcing — without
 * telling the server. These tests pin the two retraction paths that keep the
 * pending card from haunting later subscribes: a tool result for the same
 * toolCallId retracts the card at once, and the TTL sweep broadcasts the
 * retraction so connected clients drop the card instead of waiting for a
 * replay.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NormalizedMessage, ProviderRuntimeWriter } from '@/shared/types.js';

import { ZCodeRunLifecycle } from '../list/zcode/zcode-run-lifecycle.js';
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

const userInputRequest = (id: number, params: Record<string, unknown>): ProtocolServerRequest => ({
  id,
  method: 'interaction/requestUserInput',
  params: {
    requestId: 'perm_req_1',
    sessionId: 'sess_engine_1',
    toolCallId: 'call_1',
    toolName: 'AskUserQuestion',
    prompt: 'Tool AskUserQuestion requires approval',
    input: {
      questions: [{
        question: 'Which scope?',
        header: 'Scope',
        multiSelect: false,
        options: [{ label: 'All 19', description: 'Fill every title' }],
      }],
    },
    ...params,
  },
});

test('a tool result for the question retracts the pending card and answers the parked request', async () => {
  const lifecycle = new ZCodeRunLifecycle();
  const { messages, writer } = createWriter();
  const handle = lifecycle.startRun({ abortKey: 'app-zombie', sessionId: 'sess_engine_1', appSessionId: 'app-zombie', writer });

  const parked = lifecycle.handleServerRequest(userInputRequest(1, {}));
  assert.equal(lifecycle.listPendingPermissions('app-zombie').length, 1);

  // The engine timed the question out: the tool call completed on its own.
  lifecycle.retractPermissionByToolId('sess_engine_1', 'call_1');

  assert.deepEqual(lifecycle.listPendingPermissions('app-zombie'), [], 'the zombie card must be retracted');
  assert.ok(
    messages.some((msg) => msg.kind === 'permission_cancelled' && msg.requestId === 'perm_req_1'),
    'the retraction must reach the chat stream so clients drop the card'
  );
  // requestUserInput answers reach the engine reshaped: a deny becomes `decline`.
  assert.deepEqual(await parked, { result: { action: 'decline', reason: 'The engine resolved this call without waiting for an answer.' } });

  lifecycle.dispose(handle);
});

test('a tool result for another call leaves the pending card alone', async () => {
  const lifecycle = new ZCodeRunLifecycle();
  const { messages, writer } = createWriter();
  const handle = lifecycle.startRun({ abortKey: 'app-other', sessionId: 'sess_engine_1', appSessionId: 'app-other', writer });

  lifecycle.handleServerRequest(userInputRequest(1, {}));
  lifecycle.retractPermissionByToolId('sess_engine_1', 'call_other');

  assert.equal(lifecycle.listPendingPermissions('app-other').length, 1, 'an unrelated tool result must not retract the card');
  assert.equal(messages.filter((msg) => msg.kind === 'permission_cancelled').length, 0);

  lifecycle.dispose(handle);
});

test('the TTL sweep broadcasts the retraction, not just drops the entry', async () => {
  const lifecycle = new ZCodeRunLifecycle({ pendingTtlMs: 20 });
  const { messages, writer } = createWriter();
  const handle = lifecycle.startRun({ abortKey: 'app-sweep', sessionId: 'sess_engine_1', appSessionId: 'app-sweep', writer });

  lifecycle.handleServerRequest(userInputRequest(1, {}));
  assert.equal(lifecycle.listPendingPermissions('app-sweep').length, 1);

  await new Promise((resolve) => setTimeout(resolve, 60));
  lifecycle.listPendingPermissions('app-sweep');

  assert.ok(
    messages.some((msg) => msg.kind === 'permission_cancelled' && msg.requestId === 'perm_req_1'),
    'the sweep must tell connected clients the card is gone'
  );

  lifecycle.dispose(handle);
});
