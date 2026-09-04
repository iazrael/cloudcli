/**
 * Tests for realtime thinking-frame merging: id-based upsert of streaming
 * reasoning frames and the persisted-transcript echo check used when a run's
 * history refresh lands.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { isThinkingRowEchoOnServer, upsertThinkingRow } from '@/modules/chat/utils/sessionThinkingRows';
import type { NormalizedMessage } from '@/shared/types';

const sessionId = 'session-1';

function thinkingFrame(id: string, content: string, timestamp: string): NormalizedMessage {
  return {
    id,
    sessionId,
    timestamp,
    provider: 'zcode',
    kind: 'thinking',
    content,
  };
}

test('upsertThinkingRow appends frames sharing a block id into one row', () => {
  let rows = upsertThinkingRow([], thinkingFrame('zcode_reasoning_1', 'Let me start', '2026-01-01T00:00:01Z'));
  rows = upsertThinkingRow(rows, thinkingFrame('zcode_reasoning_1', ' and check', '2026-01-01T00:00:02Z'));
  rows = upsertThinkingRow(rows, thinkingFrame('zcode_reasoning_1', ' the files', '2026-01-01T00:00:03Z'));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'Let me start and check the files');
  assert.equal(rows[0].timestamp, '2026-01-01T00:00:01Z');
});

test('upsertThinkingRow keeps distinct block ids as separate rows', () => {
  let rows = upsertThinkingRow([], thinkingFrame('zcode_reasoning_1', 'first thought', '2026-01-01T00:00:01Z'));
  rows = upsertThinkingRow(rows, thinkingFrame('zcode_reasoning_2', 'second thought', '2026-01-01T00:00:02Z'));

  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, 'first thought');
  assert.equal(rows[1].content, 'second thought');
});

test('upsertThinkingRow leaves non-thinking rows untouched and appends new ids at the end', () => {
  const userRow: NormalizedMessage = {
    id: 'text_user_1',
    sessionId,
    timestamp: '2026-01-01T00:00:00Z',
    provider: 'zcode',
    kind: 'text',
    role: 'user',
    content: 'hi',
  };
  let rows = upsertThinkingRow([userRow], thinkingFrame('zcode_reasoning_1', 'thought', '2026-01-01T00:00:01Z'));
  assert.equal(rows.length, 2);

  rows = upsertThinkingRow(rows, thinkingFrame('zcode_reasoning_1', ' more', '2026-01-01T00:00:02Z'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0], userRow);
  assert.equal(rows[1].content, 'thought more');
});

test('a finished realtime thinking row matching a persisted block is an echo', () => {
  const serverMessages = [
    thinkingFrame('msg_a_part_r', 'Let me check\n the directory', '2026-01-01T00:00:05Z'),
  ];
  const realtimeRow = thinkingFrame('zcode_reasoning_1', 'Let me check  the directory', '2026-01-01T00:00:03Z');

  assert.equal(isThinkingRowEchoOnServer(realtimeRow, serverMessages), true);
});

test('an in-flight thinking row (content prefix of the block) is not an echo', () => {
  const serverMessages = [
    thinkingFrame('msg_a_part_r', 'Let me check the directory and list files', '2026-01-01T00:00:05Z'),
  ];
  const realtimeRow = thinkingFrame('zcode_reasoning_1', 'Let me check the', '2026-01-01T00:00:03Z');

  assert.equal(isThinkingRowEchoOnServer(realtimeRow, serverMessages), false);
});

test('thinking echo check ignores empty content and non-thinking rows', () => {
  assert.equal(isThinkingRowEchoOnServer(thinkingFrame('r1', '', '2026-01-01T00:00:01Z'), []), false);
  const textRow: NormalizedMessage = {
    id: 'text_a',
    sessionId,
    timestamp: '2026-01-01T00:00:01Z',
    provider: 'zcode',
    kind: 'text',
    role: 'assistant',
    content: 'some thought',
  };
  assert.equal(isThinkingRowEchoOnServer(textRow, []), false);
});
