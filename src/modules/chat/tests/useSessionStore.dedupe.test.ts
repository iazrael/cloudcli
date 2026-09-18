/**
 * Turn-level echo dedupe tests for the session message store.
 *
 * Guards `isAssistantTextEchoedInSameTurnOnServer` — the reconciliation
 * predicate that decides whether a finalized streaming row (a synthetic
 * assistant text built from live deltas) must be dropped because the
 * persisted transcript already carries the same reply in the same user turn.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { isAssistantTextEchoedInSameTurnOnServer } from '@/modules/chat/utils/sessionMessageTurnDedupe';
import type { NormalizedMessage } from '@/modules/chat/hooks/useSessionStore';

const sessionId = 'session-1';

function msg(
  kind: NormalizedMessage['kind'],
  role: 'user' | 'assistant' | undefined,
  content: string,
  timestamp: string,
): NormalizedMessage {
  return {
    id: `${kind}-${role}-${timestamp}`,
    sessionId,
    timestamp,
    provider: 'antigravity',
    kind,
    role,
    content,
  };
}

function toolUse(timestamp: string): NormalizedMessage {
  return {
    id: `tool-${timestamp}`,
    sessionId,
    timestamp,
    provider: 'antigravity',
    kind: 'tool_use',
    toolName: 'shell',
    toolId: `tool_1`,
  };
}

test('a finalized row matching one persisted segment verbatim is an echo', () => {
  const server = [
    msg('text', 'user', 'hello', '2026-01-01T00:00:01Z'),
    msg('text', 'assistant', 'First segment.', '2026-01-01T00:00:02Z'),
  ];
  const realtime = [
    msg('text', 'assistant', 'First segment.', '2026-01-01T00:00:03Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime), true);
});

test('a concatenated bubble over a multi-segment turn is an echo', () => {
  // The persisted shape of one antigravity turn: text, tool, text.
  const server = [
    msg('text', 'user', 'hello', '2026-01-01T00:00:01Z'),
    msg('text', 'assistant', 'First segment.\n\n', '2026-01-01T00:00:02Z'),
    toolUse('2026-01-01T00:00:03Z'),
    msg('text', 'assistant', 'Second segment.', '2026-01-01T00:00:04Z'),
  ];
  // The live shape of the same turn: one bubble holding both segments
  // concatenated (inter-segment whitespace preserved by the delta stream).
  const realtime = [
    msg('text', 'assistant', 'First segment.\n\nSecond segment.', '2026-01-01T00:00:05Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime), true);
});

test('text equal to a different turn segment is not an echo', () => {
  const server = [
    msg('text', 'user', 'first turn', '2026-01-01T00:00:01Z'),
    msg('text', 'assistant', 'repeated answer', '2026-01-01T00:00:02Z'),
    msg('text', 'user', 'second turn', '2026-01-01T00:00:03Z'),
  ];
  const realtime = [
    msg('text', 'user', 'second turn', '2026-01-01T00:00:04Z'),
    msg('text', 'assistant', 'repeated answer', '2026-01-01T00:00:05Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[1], server, realtime), false);
});

test('a bubble that differs from the persisted turn is kept', () => {
  const server = [
    msg('text', 'user', 'hello', '2026-01-01T00:00:01Z'),
    msg('text', 'assistant', 'Server answer', '2026-01-01T00:00:02Z'),
  ];
  const realtime = [
    msg('text', 'assistant', 'A different live answer', '2026-01-01T00:00:03Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime), false);
});

test('empty content is never an echo', () => {
  const server = [
    msg('text', 'user', 'hello', '2026-01-01T00:00:01Z'),
    msg('text', 'assistant', 'answer', '2026-01-01T00:00:02Z'),
  ];
  const realtime = [
    msg('text', 'assistant', '   ', '2026-01-01T00:00:03Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime), false);
});

test('a bubble with no matching user turn on the server is kept', () => {
  const server: NormalizedMessage[] = [];
  const realtime = [
    msg('text', 'assistant', 'orphan bubble', '2026-01-01T00:00:03Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime), false);
});

test('a finalized row is recognised as echo even when older user turns are paginated away', () => {
  // Server only carries the latest page (1 user message from turn 3)
  const server = [
    msg('text', 'user', 'third turn prompt', '2026-01-01T00:00:20Z'),
    msg('text', 'assistant', 'third turn reply', '2026-01-01T00:00:21Z'),
  ];
  // Realtime or client session store contains earlier turns and redundant user message
  const realtime = [
    msg('text', 'user', 'first turn prompt', '2026-01-01T00:00:01Z'),
    msg('text', 'user', 'second turn prompt', '2026-01-01T00:00:10Z'),
    msg('text', 'user', 'third turn prompt', '2026-01-01T00:00:20Z'),
    msg('text', 'assistant', 'third turn reply', '2026-01-01T00:00:22Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[3], server, realtime), true);
});

test('a finalized row is an echo when every user turn was paginated away', () => {
  // A long tool-heavy turn pushed the prompt off the tail page, so the server
  // slice holds no user row at all. Everything on it therefore belongs to one
  // turn — this one — and the reply is already there.
  const server = [
    msg('tool_use', undefined, '', '2026-01-01T00:00:20Z'),
    msg('text', 'assistant', 'long detailed summary of accomplished work', '2026-01-01T00:00:25Z'),
  ];
  const realtime = [
    msg('text', 'user', 'prompt that triggered tools', '2026-01-01T00:00:01Z'),
    msg('tool_use', undefined, '', '2026-01-01T00:00:10Z'),
    msg('text', 'assistant', 'long detailed summary of accomplished work', '2026-01-01T00:00:24Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[2], server, realtime), true);
});

test('a finalized row is recognised as echo when streaming loses whitespace at token boundaries', () => {
  const server = [
    msg('text', 'user', '提交代码和push', '2026-01-01T00:00:01Z'),
    msg('text', 'assistant', '提交并推送完成 ✅\n\n两个 commit：\n1. **`35b663e`** — `fix: improve app robustness and auth error handling`', '2026-01-01T00:00:05Z'),
  ];
  const realtime = [
    msg('text', 'user', '提交代码和push', '2026-01-01T00:00:01Z'),
    // Streaming delta boundary dropped a space: "app robustness" -> "approbustness"
    msg('text', 'assistant', '提交并推送完成 ✅\n\n两个 commit：\n1. **`35b663e`** — `fix: improve approbustness and auth error handling`', '2026-01-01T00:00:06Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[1], server, realtime), true);
});

test('identical assistant replies across different user turns are not treated as echoes', () => {
  const server = [
    msg('text', 'user', 'turn 1 question', '2026-01-01T00:00:01Z'),
    msg('text', 'assistant', 'Done.', '2026-01-01T00:00:02Z'),
    msg('text', 'user', 'turn 2 question', '2026-01-01T00:00:10Z'),
  ];
  const realtime = [
    msg('text', 'assistant', 'Done.', '2026-01-01T00:00:12Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime), false);
});

/**
 * This case used to assert the row was retained.
 *
 * It was written when the turn lookup went through the clock: with the engine
 * an hour ahead, the scan broke out empty and the ordinal landed on an older
 * turn, so the code could not tell which turn owned the row and kept it. That
 * is the duplicate-reply symptom — the same answer rendered twice, once live
 * and once from history.
 *
 * Arrival order removes the uncertainty. Nothing sits above this row, so it
 * belongs to the newest persisted turn, and that turn already carries this
 * exact text. It is the same row, and one of the two has to go.
 */
test('an unanchored live row is an echo of the newest turn that already carries it', () => {
  const server = [
    msg('text', 'user', 'first question', '2026-01-01T01:00:00Z'),
    msg('text', 'assistant', 'older reply', '2026-01-01T01:00:01Z'),
    msg('text', 'user', 'second question', '2026-01-01T01:20:00Z'),
    msg('text', 'assistant', 'the actual reply', '2026-01-01T01:20:01Z'),
  ];
  const realtime = [
    msg('text', 'assistant', 'the actual reply', '2026-01-01T00:20:05Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime), true);
});

test('anchored turns match accurately using transcriptAnchorId', () => {
  const serverUser: NormalizedMessage = {
    ...msg('text', 'user', 'anchor question', '2026-01-01T00:00:01Z'),
    transcriptAnchorId: 'anchor-123',
  };
  const serverAssistant = msg('text', 'assistant', 'Anchored response.', '2026-01-01T00:00:02Z');
  const server = [serverUser, serverAssistant];

  const realtime: NormalizedMessage[] = [
    {
      ...msg('text', 'assistant', 'Anchored response.', '2026-01-01T00:00:03Z'),
      transcriptAnchorId: 'anchor-123',
    },
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime), true);
});

/**
 * Which turn a live row belongs to is a causal question, not a clock one.
 *
 * The turn lookup used to merge both sources and sort them on wall clock, then
 * take the last user row at or before the live row's timestamp. Those
 * timestamps come from two machines — the live row is stamped by the browser,
 * the persisted rows by the engine — so a browser running behind stops the
 * walk early and lands on an older turn. When that older turn happens to
 * contain the same words, a real reply is judged an echo and disappears.
 *
 * A tab that did not send the message has no optimistic user row to sit above
 * the live row, which is exactly when the clock was the only thing deciding.
 * With nothing above it, the live row belongs to the newest persisted turn.
 */
test('a live reply is not judged an echo of an older turn when the browser clock lags', () => {
  const server = [
    msg('text', 'user', 'first question', '2026-01-01T00:00:00Z'),
    msg('text', 'assistant', 'Shared answer.', '2026-01-01T00:00:01Z'),
    msg('text', 'user', 'second question', '2026-01-01T00:00:20Z'),
  ];
  // The reply to "second question", stamped by a browser eight seconds behind
  // the engine, and observed by a tab that never created an optimistic row.
  const realtime = [
    msg('text', 'assistant', 'Shared answer.', '2026-01-01T00:00:12Z'),
  ];

  assert.equal(
    isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime),
    false,
    'the newest turn has nothing persisted yet, so this reply is new',
  );
});

/**
 * The same shape with the turn genuinely already persisted still dedupes: the
 * fix must not turn every live row into a keeper.
 */
test('a live reply IS an echo when the newest persisted turn already carries it', () => {
  const server = [
    msg('text', 'user', 'first question', '2026-01-01T00:00:00Z'),
    msg('text', 'assistant', 'An older answer.', '2026-01-01T00:00:01Z'),
    msg('text', 'user', 'second question', '2026-01-01T00:00:20Z'),
    msg('text', 'assistant', 'Shared answer.', '2026-01-01T00:00:21Z'),
  ];
  const realtime = [
    msg('text', 'assistant', 'Shared answer.', '2026-01-01T00:00:12Z'),
  ];

  assert.equal(isAssistantTextEchoedInSameTurnOnServer(realtime[0], server, realtime), true);
});
