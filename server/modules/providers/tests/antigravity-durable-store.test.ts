/**
 * Antigravity durable summary-store cleanup tests.
 *
 * `conversation_summaries.db` is rebuilt from `jetbox_summaries_proto.pb` on
 * every engine startup, so a hard delete must also prune the protobuf record
 * (and the workspace's last-conversation pointer) or the session comes back.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  pruneAntigravityConversationPointers,
  pruneAntigravitySummaryRecords,
} from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';

/** Encodes one protobuf varint. */
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

/** Encodes one length-delimited protobuf field. */
function encodeField(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(payload.length), payload]);
}

/** Minimal protobuf message whose only field is a string id, as the engine writes it. */
function conversationRecord(id: string): Buffer {
  return encodeField(1, Buffer.from(id, 'utf8'));
}

/** Reads the top-level field numbers of a protobuf buffer. */
function topLevelFieldNumbers(buffer: Buffer): number[] {
  const numbers: number[] = [];
  let cursor = 0;
  let value = 0;
  let shift = 0;

  const nextVarint = (): number => {
    value = 0;
    shift = 0;
    for (;;) {
      const byte = buffer[cursor];
      cursor += 1;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return value;
      }
      shift += 7;
    }
  };

  while (cursor < buffer.length) {
    const key = nextVarint();
    const fieldNumber = Math.floor(key / 8);
    const wireType = key % 8;
    numbers.push(fieldNumber);
    if (wireType === 0) {
      nextVarint();
    } else if (wireType === 2) {
      const length = nextVarint();
      cursor += length;
    } else {
      throw new Error(`unexpected wire type ${wireType}`);
    }
  }

  return numbers;
}

test('pruning a summary record drops only the matching conversation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-pb-'));
  try {
    const filePath = path.join(dir, 'jetbox_summaries_proto.pb');
    const keepId = 'd1dc89e8-2b6a-4e3a-b5a9-c9132a6a49e5';
    const dropId = '197c5eb5-4626-478c-a002-693bed71c98a';
    await writeFile(filePath, Buffer.concat([
      encodeField(1, conversationRecord(keepId)),
      encodeField(1, conversationRecord(dropId)),
      encodeField(2, Buffer.from('unrelated', 'utf8')),
    ]));

    const pruned = pruneAntigravitySummaryRecords(filePath, new Set([dropId]));

    assert.equal(pruned, true);
    const rewritten = await readFile(filePath);
    assert.deepEqual(topLevelFieldNumbers(rewritten), [1, 2]);
    const text = rewritten.toString('latin1');
    assert.ok(text.includes(keepId));
    assert.equal(text.includes(dropId), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a malformed protobuf is left untouched', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-pb-bad-'));
  try {
    const filePath = path.join(dir, 'jetbox_summaries_proto.pb');
    const original = Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x01, 0x02]);
    await writeFile(filePath, original);

    const pruned = pruneAntigravitySummaryRecords(filePath, new Set(['some-id']));

    assert.equal(pruned, false);
    assert.deepEqual(await readFile(filePath), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pruning conversation pointers removes only the deleted workspace entries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-cache-'));
  try {
    const filePath = path.join(dir, 'last_conversations.json');
    const dropId = '197c5eb5-4626-478c-a002-693bed71c98a';
    const keepId = 'd1dc89e8-2b6a-4e3a-b5a9-c9132a6a49e5';
    await writeFile(filePath, JSON.stringify({
      'E:\\Projects': keepId,
      'C:\\Temp\\test': dropId,
    }));

    const pruned = pruneAntigravityConversationPointers(filePath, new Set([dropId]));

    assert.equal(pruned, true);
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, string>;
    assert.deepEqual(parsed, { 'E:\\Projects': keepId });

    // A second pass has nothing left to change.
    assert.equal(pruneAntigravityConversationPointers(filePath, new Set([dropId])), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
