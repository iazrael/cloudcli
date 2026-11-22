/**
 * Antigravity ACP Card Bridge Unit Tests
 *
 * Registry behavior for the pending permission/question cards: gateway
 * resolution, session replay, abort retraction and card deadlines.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AcpCardOutcome } from '@/shared/types.js';

import {
  AntigravityAcpCardBridge,
  formatQuestionAnswers,
} from '../list/antigravity/antigravity-acp-bridge.js';

type AcpPendingCard = Parameters<AntigravityAcpCardBridge['add']>[0];

const buildCard = (overrides: Partial<AcpPendingCard> = {}): AcpPendingCard => ({
  requestId: 'acp_perm_call_1',
  sessionId: 'sess-1',
  frameSessionId: 'conv-1',
  toolName: 'run_command',
  toolId: 'call_1',
  input: { CommandLine: 'echo hi' },
  receivedAt: new Date(),
  writer: { send: () => undefined },
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

test('a decision for an already expired card is rejected', () => {
  const bridge = new AntigravityAcpCardBridge(25);
  const settled: AcpCardOutcome[] = [];
  bridge.add(buildCard({ requestId: 'old', receivedAt: new Date(0), settle: (outcome) => settled.push(outcome) }));
  assert.equal(bridge.resolve('old', { allow: true }), false);
  assert.deepEqual(settled, [{ allow: false, expired: true }]);
  assert.equal(bridge.listForSession('sess-1').length, 0);
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

test('an unanswered permission expires without another gateway action', async () => {
  const bridge = new AntigravityAcpCardBridge(25);
  let receive: (outcome: AcpCardOutcome) => void = () => {};
  const delivered = new Promise<AcpCardOutcome>((resolve) => { receive = resolve; });
  const frames: Array<Record<string, unknown>> = [];
  bridge.add(buildCard({
    settle: receive,
    writer: { send: (frame) => frames.push(frame as Record<string, unknown>) },
  }));
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      delivered,
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still pending'), 500); }),
    ]);
    assert.deepEqual(result, { allow: false, expired: true });
    assert.equal(frames[0]?.kind, 'permission_cancelled');
  } finally {
    clearTimeout(timer);
  }
});
