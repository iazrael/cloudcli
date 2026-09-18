/**
 * Narrowing behaviour, and the compile-time half of it.
 *
 * The runtime assertions below are the cheap part. The type-level assertions
 * are the point: they fail the build if a predicate stops telling the compiler
 * which fields a kind has, which is the whole reason these exist.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';

import {
  isCompleteMessage,
  isTextMessage,
  isToolUseMessage,
} from '../../../shared/protocol/messageNarrowing.js';

const toolUse: NormalizedMessage = {
  id: 'm1',
  sessionId: 's1',
  timestamp: '2026-01-01T00:00:00.000Z',
  provider: 'claude',
  kind: 'tool_use',
  toolName: 'Read',
  toolId: 'call-1',
};

const text: NormalizedMessage = {
  id: 'm2',
  sessionId: 's1',
  timestamp: '2026-01-01T00:00:01.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content: 'done',
};

test('a predicate accepts its own kind and rejects the others', () => {
  assert.equal(isToolUseMessage(toolUse), true);
  assert.equal(isToolUseMessage(text), false);
  assert.equal(isTextMessage(text), true);
  assert.equal(isCompleteMessage(text), false);
});

test('narrowing exposes the kind fields and hides the other kinds', () => {
  assert.ok(isToolUseMessage(toolUse));
  if (isToolUseMessage(toolUse)) {
    // Available because the narrowing says so — reading `toolName` off an
    // unnarrowed message compiles too, but reading it off a narrowed `text`
    // message does not, which is the discipline being introduced.
    assert.equal(toolUse.toolName, 'Read');
  }

  if (isTextMessage(text)) {
    assert.equal(text.content, 'done');
    // @ts-expect-error a narrowed text message has no tool fields
    void text.toolName;
  }
});

test('a narrowed message of one kind cannot be read as another', () => {
  const rows: NormalizedMessage[] = [toolUse, text];

  for (const row of rows) {
    if (isCompleteMessage(row)) {
      // @ts-expect-error a narrowed complete message carries no `toolName`
      void row.toolName;
      assert.equal(row.kind, 'complete');
    }
  }
});
