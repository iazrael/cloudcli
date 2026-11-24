import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import {
  reconcileOptimisticPrompts,
  upsertToolUseRow,
} from '@/modules/chat/utils/sessionMessageReconciliation';
import type { PendingPrompt } from '@/modules/chat/utils/sessionMessageReconciliation';

/**
 * Which optimistic prompts survive a reconciliation.
 *
 * Nothing here compares message text: a prompt is paired with the first
 * persisted user row that appeared after the transcript position recorded at
 * send time. Pairing on what the prompt says is what used to make two
 * identical prompts fight over one persisted turn.
 */
const survivingPrompts = (
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  pendingPrompts: Map<string, PendingPrompt>,
  runEnded = false,
): string[] => {
  const { retiredAnchors } = reconcileOptimisticPrompts(
    serverMessages,
    realtimeMessages,
    pendingPrompts,
    runEnded,
  );
  return realtimeMessages
    .filter((message) => !retiredAnchors.has(message.id))
    .map((message) => message.id);
};

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('an optimistic prompt retires against the user row that followed its anchor', () => {
  const local = createUserMessage('local_1', '2026-07-28T20:30:21.000Z', { content: 'hello' });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', { content: 'hello' });

  assert.deepEqual(
    survivingPrompts([persisted], [local], new Map([['local_1', { afterRowId: null }]])),
    [],
  );
});

/**
 * The persisted copy is stamped by the engine and the optimistic row by the
 * browser, on two machines whose clocks need not agree. Retirement therefore
 * never consults either one: an engine running a minute behind used to have
 * its row rejected as "too old", leaving the user looking at their own
 * message twice for the rest of the session.
 */
test('retirement survives an engine clock that runs behind the browser', () => {
  const local = createUserMessage('local_1', '2026-01-01T00:01:00.000Z', {
    provider: 'antigravity',
    content: 'answer in two words',
  });
  const persisted = createUserMessage('srv-1', '2026-01-01T00:00:00.000Z', {
    provider: 'antigravity',
    content: 'answer in two words',
  });

  assert.deepEqual(
    survivingPrompts([persisted], [local], new Map([['local_1', { afterRowId: null }]])),
    [],
  );
});

test('a prompt is not retired by a user row that predates it', () => {
  const older = createUserMessage('srv-old', '2026-01-01T00:00:00.000Z', { content: 'continue' });
  const filler = createUserMessage('srv-filler', '2026-01-01T00:00:01.000Z', {
    role: 'assistant',
    content: 'ok',
  });
  const local = createUserMessage('local_2', '2026-01-01T00:01:00.000Z', { content: 'continue' });

  // Sent when `srv-filler` was the transcript's last row, so neither row
  // above it can be this prompt's copy — not even the one that says the same
  // thing.
  assert.deepEqual(
    survivingPrompts([older, filler], [local], new Map([['local_2', { afterRowId: 'srv-filler' }]])),
    ['local_2'],
  );
});

/**
 * The anchor is an id, not a position, because the array it points into is
 * routinely rewritten: an older page is prepended above it, or a refresh
 * replaces the window wholesale. A row-count stamp silently stopped matching
 * after either of those, and the prompt then stayed on screen next to its own
 * persisted copy for the rest of the session — the duplicate this mechanism
 * exists to prevent.
 */
test('an anchor still pairs after older history is prepended above it', () => {
  const anchor = createUserMessage('srv-anchor', '2026-01-01T00:00:10.000Z', {
    role: 'assistant',
    content: 'previous reply',
  });
  const local = createUserMessage('local_3', '2026-01-01T00:00:20.000Z', { content: 'next' });
  const persisted = createUserMessage('srv-new', '2026-01-01T00:00:21.000Z', { content: 'next' });

  const olderPage = Array.from({ length: 40 }, (_, index) =>
    createUserMessage(`srv-old-${index}`, '2026-01-01T00:00:00.000Z', { content: 'next' }));

  assert.deepEqual(
    survivingPrompts(
      [...olderPage, anchor, persisted],
      [local],
      new Map([['local_3', { afterRowId: 'srv-anchor' }]]),
    ),
    [],
    'the pairing follows the anchor row, not its index',
  );
});

test('two prompts waiting at once pair with their own turns, in order', () => {
  const first = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', { content: 'same text' });
  const second = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', { content: 'same text' });
  const firstPersisted = createUserMessage('srv-first', '2026-07-28T20:30:22.000Z', { content: 'same text' });

  assert.deepEqual(
    survivingPrompts(
      [firstPersisted],
      [first, second],
      new Map([
        ['local_first', { afterRowId: null }],
        ['local_second', { afterRowId: null }],
      ]),
    ),
    ['local_second'],
    'one persisted turn retires one prompt, never both',
  );
});

/**
 * A fork or an edit can rewrite the transcript under a prompt and take its
 * anchor row with it. Waiting for an anchor that will never come back is how
 * a duplicate becomes permanent, so the end of the run is the deadline: after
 * it, the prompt pairs with whatever user row is available.
 */
test('a vanished anchor blocks pairing only until the run ends', () => {
  const local = createUserMessage('local_4', '2026-01-01T00:01:00.000Z', { content: 'go' });
  const persisted = createUserMessage('srv-1', '2026-01-01T00:01:01.000Z', { content: 'go' });
  const pending = new Map([['local_4', { afterRowId: 'srv-gone' }]]);

  assert.deepEqual(survivingPrompts([persisted], [local], pending), ['local_4']);
  assert.deepEqual(survivingPrompts([persisted], [local], pending, true), []);
});

/**
 * A long session only keeps the newest page of the transcript loaded. Once
 * the first prompts' persisted copies scroll out of that page, re-pairing
 * them from scratch let each one take the next turn's row instead: every
 * pairing slid down two turns and the newest prompt, left with nothing to
 * claim, rendered next to its own copy. A pairing already made is a fact
 * about the transcript and stays made.
 */
test('prompts paired earlier keep their pairing after their copies leave the window', () => {
  const user = (id: string) => createUserMessage(id, '2026-10-22T00:00:00.000Z');
  const reply = (id: string) => createUserMessage(id, '2026-10-22T00:00:00.000Z', { role: 'assistant' });
  const prompts = ['local_t1', 'local_t2', 'local_t3', 'local_t4', 'local_t5']
    .map((id) => createUserMessage(id, '2026-10-22T00:00:00.000Z'));
  const pendingPrompts = new Map<string, PendingPrompt>([
    ['local_t1', { afterRowId: null }],
    ['local_t2', { afterRowId: 'srv-r1' }],
    ['local_t3', { afterRowId: 'srv-r2' }],
    ['local_t4', { afterRowId: 'srv-r3' }],
    ['local_t5', { afterRowId: 'srv-r4' }],
  ]);
  // Paired while every turn was still loaded.
  const priorPairings = new Map([
    ['local_t1', 'srv-u1'],
    ['local_t2', 'srv-u2'],
    ['local_t3', 'srv-u3'],
    ['local_t4', 'srv-u4'],
  ]);
  // The newest page now starts at turn 3; turns 1 and 2 are not loaded.
  const window = [user('srv-u3'), reply('srv-r3'), user('srv-u4'), reply('srv-r4'), user('srv-u5')];

  const { retiredAnchors, provenAnchors } = reconcileOptimisticPrompts(
    window,
    prompts,
    pendingPrompts,
    true,
    priorPairings,
  );

  assert.equal(retiredAnchors.get('local_t3'), 'srv-u3');
  assert.equal(retiredAnchors.get('local_t4'), 'srv-u4');
  assert.equal(retiredAnchors.get('local_t5'), 'srv-u5', 'the newest prompt still finds its own copy');
  assert.equal(retiredAnchors.get('local_t1'), 'srv-u1');
  assert.equal(retiredAnchors.get('local_t2'), 'srv-u2');
  assert.equal(provenAnchors.get('local_t5'), 'srv-u5');
  assert.equal(provenAnchors.get('local_t4'), 'srv-u4');
  assert.equal(provenAnchors.has('local_t1'), false, 'a pairing whose row is not loaded proves no turn');
});

test('an earlier pairing that sits above its own anchor proves no turn', () => {
  const older = createUserMessage('srv-older', '2026-10-22T00:00:00.000Z');
  const anchor = createUserMessage('srv-anchor', '2026-10-22T00:00:01.000Z', { role: 'assistant' });
  const local = createUserMessage('local_p', '2026-10-22T00:00:02.000Z');

  // Paired on the run-ended escape hatch while the anchor was out of the
  // window; paging older history back in must not turn that guess into proof.
  const { retiredAnchors, provenAnchors } = reconcileOptimisticPrompts(
    [older, anchor],
    [local],
    new Map([['local_p', { afterRowId: 'srv-anchor' }]]),
    true,
    new Map([['local_p', 'srv-older']]),
  );

  assert.equal(retiredAnchors.get('local_p'), 'srv-older');
  assert.equal(provenAnchors.has('local_p'), false);
});

/**
 * A prompt sent before the session's first page loaded has no anchor, so its
 * pairing is only a reading of the transcript — until the run ends. A fresh
 * pairing gets that escape hatch; a kept one must get it too, or the pairing
 * recorded mid-run (the common case: the first page lands while the turn is
 * still streaming) can never be proven afterwards and the turn it opened can
 * never reconcile its unkeyed reply.
 */
test('a kept pairing sent with no history is proven once the run ends', () => {
  const user = createUserMessage('srv-u1', '2026-10-22T00:00:00.000Z');
  const local = createUserMessage('local_p', '2026-10-22T00:00:01.000Z');
  const pending = new Map([['local_p', { afterRowId: null }]]);
  const prior = new Map([['local_p', 'srv-u1']]);

  const midRun = reconcileOptimisticPrompts([user], [local], pending, false, prior);
  assert.equal(midRun.provenAnchors.has('local_p'), false, 'a guess is not a proof while the run is going');

  const finished = reconcileOptimisticPrompts([user], [local], pending, true, prior);
  assert.equal(finished.provenAnchors.get('local_p'), 'srv-u1');
});

/**
 * The run-ended proof is a fact about a finished turn, so it must survive the
 * next send clearing the slot's `runEnded`: the transcript can index the
 * reply after the completion refresh, and the proof is the only thing that
 * still names the turn it belongs to.
 */
test('a latched proof survives the next send clearing the run flag', () => {
  const user = createUserMessage('srv-u1', '2026-10-22T00:00:00.000Z');
  const local = createUserMessage('local_p', '2026-10-22T00:00:01.000Z');
  const nextPrompt = createUserMessage('local_p2', '2026-10-22T00:05:00.000Z');
  const pending = new Map([
    ['local_p', { afterRowId: null }],
    ['local_p2', { afterRowId: null }],
  ]);

  const { provenAnchors } = reconcileOptimisticPrompts(
    [user],
    [local, nextPrompt],
    pending,
    false,
    new Map([['local_p', 'srv-u1']]),
    new Set(['local_p']),
  );

  assert.equal(provenAnchors.get('local_p'), 'srv-u1');
  assert.equal(provenAnchors.has('local_p2'), false, 'latching one pairing must not prove another');
});

test('upsertToolUseRow: a blank re-announce frame never blanks a populated card', () => {
  const toolRow = (id: string, toolId: string, toolInput: Record<string, unknown>) => ({
    id,
    kind: 'tool_use',
    provider: 'zcode',
    sessionId: 's1',
    toolName: 'Bash',
    toolId,
    toolInput,
    timestamp: '2026-01-01T00:00:00.000Z',
  }) as NormalizedMessage;

  const rows = [toolRow('row_1', 'call_1', { command: 'echo hello' })];

  // zcode's post-stream `scheduled` frame arrives last with empty arguments.
  const blanked = upsertToolUseRow(rows, toolRow('row_2', 'call_1', {}));
  assert.deepEqual(blanked[0].toolInput, { command: 'echo hello' });

  // A real snapshot with different arguments still overwrites.
  const updated = upsertToolUseRow(blanked, toolRow('row_3', 'call_1', { command: 'pwd' }));
  assert.deepEqual(updated[0].toolInput, { command: 'pwd' });

  // A fresh toolId appends as before.
  const appended = upsertToolUseRow(updated, toolRow('row_4', 'call_2', {}));
  assert.equal(appended.length, 2);
});
