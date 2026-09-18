import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import {
  claimMatchingServerToolCall,
  collectServerToolCalls,
} from '@/modules/chat/utils/toolIdentity';

/**
 * Pins the tool_use echo-matching contract: the realtime and persisted paths
 * mint different ids for the same logical call (engine payload fallbacks vs
 * transcript part ids), so a live card must retire when the exact id matches
 * or when the full call fingerprint matches an unclaimed persisted row —
 * one-to-one, in order.
 */

let nextRowId = 0;

function toolUse(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  nextRowId += 1;
  return {
    id: `row-${nextRowId}`,
    sessionId: 'sess-a',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, nextRowId)).toISOString(),
    provider: 'zcode',
    kind: 'tool_use',
    toolName: 'Write',
    toolInput: { file_path: '/a.ts', content: 'hello' },
    toolId: `tool-${nextRowId}`,
    ...overrides,
  };
}

test('an exact toolId match claims without any user-turn anchor regardless of differing input', () => {
  const server = toolUse({ toolId: 'msg_1_part_2', toolInput: { file_path: '/a.ts', content: 'changed' } });
  const index = collectServerToolCalls([server]);
  const claimed = new Set<string>();

  assert.equal(claimMatchingServerToolCall(toolUse({ toolId: 'msg_1_part_2' }), index, claimed), true);
  assert.deepEqual([...claimed], [server.id]);
});

test('a fingerprint match claims when the ids diverge', () => {
  const server = toolUse({ toolId: 'msg_1_part_2' });
  const index = collectServerToolCalls([server]);
  const claimed = new Set<string>();

  assert.equal(claimMatchingServerToolCall(toolUse({ toolId: 'live_zcode_1' }), index, claimed), true);
  assert.deepEqual([...claimed], [server.id]);
});

test('a different call is not an echo', () => {
  const index = collectServerToolCalls([toolUse({ toolInput: { file_path: '/other.ts', content: 'x' } })]);

  assert.equal(claimMatchingServerToolCall(toolUse({ toolId: 'live_zcode_1' }), index, new Set()), false);
});

test('tool name is part of the identity', () => {
  const index = collectServerToolCalls([toolUse()]);
  const claimed = new Set<string>();

  assert.equal(claimMatchingServerToolCall(toolUse({ toolName: 'Edit', toolId: 'live_2' }), index, claimed), false);
});

test('input key order never changes identity', () => {
  const server = toolUse({ toolInput: { content: 'hello', file_path: '/a.ts' } });
  const index = collectServerToolCalls([server]);

  assert.equal(claimMatchingServerToolCall(toolUse({ toolId: 'live_zcode_1' }), index, new Set()), true);
});

test('a JSON-encoded string input matches the object-shaped row', () => {
  const server = toolUse();
  const index = collectServerToolCalls([server]);

  assert.equal(
    claimMatchingServerToolCall(
      toolUse({ toolId: 'live_zcode_1', toolInput: JSON.stringify({ file_path: '/a.ts', content: 'hello' }) }),
      index,
      new Set(),
    ),
    true,
  );
});

test('claims are one-to-one: two identical live cards need two server rows', () => {
  const only = toolUse({ toolId: 'msg_1_part_2' });
  const index = collectServerToolCalls([only]);
  const claimed = new Set<string>();

  assert.equal(claimMatchingServerToolCall(toolUse({ toolId: 'live_1' }), index, claimed), true);
  assert.equal(claimMatchingServerToolCall(toolUse({ toolId: 'live_2' }), index, claimed), false);
  assert.deepEqual([...claimed], [only.id]);
});

test('repeated identical calls pair nth-to-nth across the two paths', () => {
  const index = collectServerToolCalls([
    toolUse({ toolId: 'msg_1_part_2' }),
    toolUse({ toolId: 'msg_3_part_4' }),
  ]);
  const claimed = new Set<string>();

  assert.equal(claimMatchingServerToolCall(toolUse({ toolId: 'live_1' }), index, claimed), true);
  assert.equal(claimMatchingServerToolCall(toolUse({ toolId: 'live_2' }), index, claimed), true);
  assert.equal(claimed.size, 2);
});

test('a card without a tool name only matches by exact id', () => {
  const server = toolUse({ toolId: 'msg_1_part_2', toolName: undefined });
  const index = collectServerToolCalls([server]);
  const claimed = new Set<string>();

  assert.equal(claimMatchingServerToolCall(toolUse({ toolId: 'msg_1_part_2', toolName: undefined }), index, claimed), true);
  assert.equal(claimMatchingServerToolCall(toolUse({ toolName: undefined, toolId: 'live_9' }), index, claimed), false);
});

test('a same-turn scoped Edit index matches an empty live diff by canonical path', () => {
  // Persisted row reconstructed from patch rollout: carries real diff content
  const serverEdit = toolUse({
    toolName: 'Edit',
    toolId: 'call_patch_1#0',
    toolInput: JSON.stringify({
      file_path: '/repo/docs/AGENTS.md',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    }),
  });
  const index = collectServerToolCalls([serverEdit]);
  const claimed = new Set<string>();

  // Live row from Codex SDK file_change event: carries path but empty strings before rollout
  const liveEdit = toolUse({
    toolName: 'Edit',
    toolId: 'item_file_change_0',
    toolInput: { file_path: '/repo/docs/AGENTS.md', old_string: '', new_string: '' },
  });

  assert.equal(claimMatchingServerToolCall(liveEdit, index, claimed), true);
  assert.deepEqual([...claimed], [serverEdit.id]);
});

test('a same-turn insertion with an empty old string still requires its complete diff fingerprint', () => {
  const serverEdit = toolUse({
    toolName: 'Edit',
    toolId: 'call_insert_1',
    toolInput: { file_path: '/repo/src/config.ts', old_string: '', new_string: 'enabled: true' },
  });
  const index = collectServerToolCalls([serverEdit]);

  const liveDifferentInsertion = toolUse({
    toolName: 'Edit',
    toolId: 'live_insert_1',
    toolInput: { file_path: '/repo/src/config.ts', old_string: '', new_string: 'enabled: false' },
  });

  assert.equal(claimMatchingServerToolCall(liveDifferentInsertion, index, new Set()), false);
});

test('a same-turn deletion with an empty new string still requires its complete diff fingerprint', () => {
  const serverEdit = toolUse({
    toolName: 'Edit',
    toolId: 'call_delete_1',
    toolInput: { file_path: '/repo/src/config.ts', old_string: 'enabled: true', new_string: '' },
  });
  const index = collectServerToolCalls([serverEdit]);

  const liveDifferentDeletion = toolUse({
    toolName: 'Edit',
    toolId: 'live_delete_1',
    toolInput: { file_path: '/repo/src/config.ts', old_string: 'enabled: false', new_string: '' },
  });

  assert.equal(claimMatchingServerToolCall(liveDifferentDeletion, index, new Set()), false);
});

test('different target files on Edit do not match', () => {
  const serverEdit = toolUse({
    toolName: 'Edit',
    toolId: 'call_patch_1#0',
    toolInput: JSON.stringify({
      file_path: '/repo/docs/AGENTS.md',
      old_string: 'old',
      new_string: 'new',
    }),
  });
  const index = collectServerToolCalls([serverEdit]);

  const liveOther = toolUse({
    toolName: 'Edit',
    toolId: 'item_file_change_0',
    toolInput: { file_path: '/repo/docs/README.md', old_string: '', new_string: '' },
  });

  assert.equal(claimMatchingServerToolCall(liveOther, index, new Set()), false);
});

test('path aliases alone cannot match an Edit without its change payload', () => {
  const serverEdit = toolUse({
    toolName: 'Edit',
    toolId: 'call_1',
    toolInput: { TargetFile: 'C:\\project\\src\\index.ts', content: 'new code' },
  });
  const index = collectServerToolCalls([serverEdit]);
  const claimed = new Set<string>();

  const liveEdit = toolUse({
    toolName: 'apply_patch',
    toolId: 'live_1',
    toolInput: { file_path: 'C:/project/src/index.ts', old_string: '', new_string: '' },
  });

  assert.equal(claimMatchingServerToolCall(liveEdit, index, claimed), false);
  assert.deepEqual([...claimed], []);
});

test('Edit and Write for the same path do not cross-claim', () => {
  const serverWrite = toolUse({
    toolName: 'Write',
    toolId: 'call_write_1',
    toolInput: { file_path: '/repo/README.md', content: 'hello' },
  });
  const index = collectServerToolCalls([serverWrite]);

  const liveEdit = toolUse({
    toolName: 'Edit',
    toolId: 'live_edit_1',
    toolInput: { file_path: '/repo/README.md', old_string: '', new_string: '' },
  });

  assert.equal(claimMatchingServerToolCall(liveEdit, index, new Set()), false);
});
