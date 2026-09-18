import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { reconcileOptimisticUserEchoes, upsertToolUseRow } from '@/modules/chat/utils/sessionMessageReconciliation';

/** These cases assert which rows survive; the pairing has its own coverage. */
const retireOptimisticUserEchoes = (
  serverMessages: Parameters<typeof reconcileOptimisticUserEchoes>[0],
  realtimeMessages: Parameters<typeof reconcileOptimisticUserEchoes>[1],
) => reconcileOptimisticUserEchoes(serverMessages, realtimeMessages).messages;

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

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(retireOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(retireOptimisticUserEchoes([persisted], [local]), [local]);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = retireOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(retireOptimisticUserEchoes([persisted], [local]), []);
});

test('a replacement echo survives a kept turn that repeats its text', () => {
  // The exact shape a rewind that branches produces: the turn that survived
  // the cut is re-stamped to the moment of the copy, one second before the
  // replacement was typed, and happens to say the same thing the user just
  // corrected their message to.
  const userRow = (id: string, content: string, timestamp: string) => ({
    id,
    kind: 'text',
    role: 'user',
    provider: 'codex',
    sessionId: 's1',
    content,
    timestamp,
  }) as NormalizedMessage;

  const kept = [userRow('kept', 'continue', '2026-01-01T00:00:21.000Z')];
  const echo = {
    ...userRow('local_1', 'continue', '2026-01-01T00:00:20.000Z'),
    replacesAnchorId: 'turn-b',
    replacesAfterRowCount: kept.length,
  } as NormalizedMessage;

  assert.deepEqual(retireOptimisticUserEchoes(kept, [echo]), [echo]);

  // Once the provider has written the replacement, it is a row the cut did not
  // keep, so it retires the echo.
  const persisted = [...kept, userRow('persisted', 'continue', '2026-01-01T00:00:25.000Z')];
  assert.deepEqual(retireOptimisticUserEchoes(persisted, [echo]), []);
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

/**
 * Retiring the optimistic echo must not depend on the two clocks agreeing.
 *
 * The persisted copy of a prompt is stamped by the engine, the optimistic row
 * by the browser. The match used to require the persisted row to land inside a
 * window around the local timestamp, so an engine running more than ten
 * seconds behind had its row rejected as "too old" — the optimistic echo
 * survived and the user saw their own message twice.
 *
 * `replacesAfterRowCount` already records how much transcript existed when the
 * row was sent, which answers the same question causally: only a row that
 * appeared afterwards can be this prompt's persisted copy.
 */
test('an optimistic prompt retires against its persisted copy despite clock skew', () => {
  const local: NormalizedMessage = {
    id: 'local_1',
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:01:00.000Z',
    provider: 'antigravity',
    kind: 'text',
    role: 'user',
    content: 'answer in two words',
    replacesAfterRowCount: 0,
  };
  // The engine stamped its copy a full minute earlier than the browser did.
  const persisted: NormalizedMessage = {
    id: 'srv-1',
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'antigravity',
    kind: 'text',
    role: 'user',
    content: 'answer in two words',
  };

  assert.deepEqual(retireOptimisticUserEchoes([persisted], [local]), []);
});

test('an optimistic prompt is not retired by transcript that predates it', () => {
  const local: NormalizedMessage = {
    id: 'local_2',
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:01:00.000Z',
    provider: 'antigravity',
    kind: 'text',
    role: 'user',
    content: 'continue',
    // Two rows were already on screen when this was sent, so neither of them
    // can be its persisted copy.
    replacesAfterRowCount: 2,
  };
  const older: NormalizedMessage = {
    id: 'srv-old',
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'antigravity',
    kind: 'text',
    role: 'user',
    content: 'continue',
  };
  const filler: NormalizedMessage = { ...older, id: 'srv-filler', role: 'assistant', content: 'ok' };

  assert.deepEqual(retireOptimisticUserEchoes([older, filler], [local]), [local]);
});
