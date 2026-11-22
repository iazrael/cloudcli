/**
 * Antigravity ACP Card Bridge Unit Tests
 *
 * Registry behavior for the pending permission/question cards: gateway
 * resolution, session replay, abort retraction and the TTL sweep.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AntigravityAcpCardBridge,
  formatQuestionAnswers,
  PENDING_CARD_TTL_MS,
  type AcpCardOutcome,
  type AcpPendingCard,
} from '../list/antigravity/antigravity-acp-bridge.js';

const buildCard = (overrides: Partial<AcpPendingCard> = {}): AcpPendingCard => ({
  requestId: 'acp_perm_call_1',
  kind: 'permission',
  sessionId: 'sess-1',
  frameSessionId: 'conv-1',
  toolName: 'run_command',
  toolId: 'call_1',
  input: { CommandLine: 'echo hi' },
  receivedAt: new Date(),
  writer: { userId: null, send: () => undefined, setSessionId: () => undefined },
  settle: () => undefined,
  ...overrides,
});

test('resolve settles the card and takes it off the replay list', () => {
  const bridge = new AntigravityAcpCardBridge();
  const settled: AcpCardOutcome[] = [];
  bridge.add(buildCard({ settle: (outcome) => settled.push(outcome) }));

  assert.equal(bridge.listForSession('sess-1').length, 1);
  assert.equal(bridge.resolve('acp_perm_call_1', { allow: true }), true);
  assert.deepEqual(settled, [{ allow: true }]);
  assert.equal(bridge.listForSession('sess-1').length, 0);
  assert.equal(bridge.resolve('acp_perm_call_1', { allow: false }), false, 'second resolve is stale');
});

test('listForSession matches by app session id only', () => {
  const bridge = new AntigravityAcpCardBridge();
  bridge.add(buildCard({ requestId: 'r1', sessionId: 'sess-1' }));
  bridge.add(buildCard({ requestId: 'r2', sessionId: 'sess-2' }));
  const pending = bridge.listForSession('sess-1');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requestId, 'r1');
  assert.equal(pending[0].toolName, 'run_command');
});

test('retractAllForSession denies and retracts every card of the session', () => {
  const bridge = new AntigravityAcpCardBridge();
  const frames: Array<Record<string, unknown>> = [];
  const settled: AcpCardOutcome[] = [];
  const writer = {
    userId: null,
    send: (frame: unknown) => frames.push(frame as Record<string, unknown>),
    setSessionId: () => undefined,
  };
  bridge.add(buildCard({ requestId: 'r1', writer, settle: (outcome) => settled.push(outcome) }));
  bridge.add(buildCard({ requestId: 'r2', sessionId: 'sess-9', writer, settle: () => undefined }));

  const retracted = bridge.retractAllForSession('sess-1', { allow: false, aborted: true });
  assert.deepEqual(retracted, ['r1']);
  assert.deepEqual(settled, [{ allow: false, aborted: true }]);
  const cancelFrames = frames.filter((frame) => frame.kind === 'permission_cancelled');
  assert.equal(cancelFrames.length, 1);
  assert.equal(cancelFrames[0].requestId, 'r1');
  assert.equal(bridge.listForSession('sess-1').length, 0);
  assert.equal(bridge.listForSession('sess-9').length, 1, 'other sessions untouched');
});

test('sweepExpired settles aged cards as expired denials', () => {
  const bridge = new AntigravityAcpCardBridge();
  const settled: AcpCardOutcome[] = [];
  const aged = new Date(Date.now() - PENDING_CARD_TTL_MS - 1_000);
  bridge.add(buildCard({ requestId: 'old', receivedAt: aged, settle: (outcome) => settled.push(outcome) }));
  bridge.add(buildCard({ requestId: 'fresh' }));

  bridge.get('old'); // reads sweep on access
  assert.deepEqual(settled, [{ allow: false, expired: true }]);
  assert.equal(bridge.size, 1, 'the fresh card survives');
});

test('formatQuestionAnswers renders the acknowledgement prose', () => {
  const answered = formatQuestionAnswers({ '你希望使用哪种数据库？': 'PostgreSQL', '为什么？': '熟悉' });
  assert.match(answered, /User has answered your questions:/);
  assert.match(answered, /Q: 你希望使用哪种数据库？\nA: PostgreSQL/);
  assert.match(answered, /Q: 为什么？\nA: 熟悉/);

  const skipped = formatQuestionAnswers({});
  assert.match(skipped, /did not provide answers/);

  const freeText = formatQuestionAnswers(undefined);
  assert.match(freeText, /did not provide answers/);
});
