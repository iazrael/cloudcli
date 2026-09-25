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

test('upsertToolUseRow: a completion snapshot settles the card it re-announces', () => {
  const toolRow = (id: string, overrides: Partial<NormalizedMessage> = {}) => ({
    id,
    kind: 'tool_use',
    provider: 'opencode',
    sessionId: 's1',
    toolName: 'bash',
    toolId: 'call_1',
    toolInput: { command: 'sleep 90' },
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as NormalizedMessage;

  const announced = upsertToolUseRow([], toolRow('row_1'));

  // opencode re-announces the running call with its outcome attached; the
  // replayed snapshot must settle the card instead of leaving it spinning.
  const completed = upsertToolUseRow(announced, toolRow('row_2', {
    toolInput: {},
    status: 'completed',
    toolResult: { content: 'done', isError: false },
  }));

  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].toolInput, { command: 'sleep 90' });
  assert.deepEqual(completed[0].toolResult, { content: 'done', isError: false });
  assert.equal(completed[0].status, 'completed');

  // A later blank snapshot must not erase the stored outcome.
  const echoed = upsertToolUseRow(completed, toolRow('row_3', { toolInput: {} }));
  assert.deepEqual(echoed[0].toolResult, { content: 'done', isError: false });
  assert.equal(echoed[0].status, 'completed');
});
