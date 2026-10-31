/**
 * The live and persisted readings of one Codex thread item must agree.
 *
 * Every record below is captured verbatim from a real run: the `APP_SERVER`
 * side from `codex app-server`'s `item/completed` notifications, the `ROLLOUT`
 * side from the `event_msg` → `item_completed` entries the same turn wrote to
 * `~/.codex/sessions`. They are paired by Codex's own item id.
 *
 * Fixtures are captured rather than written by hand on purpose. The previous
 * guard against this class of bug invented a live frame carrying a `msg_…` id,
 * which `codex exec` never emits — the test passed while the product rendered
 * every reply twice.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexThreadItemToRows,
  readCodexAppServerItem,
  readCodexRolloutItem,
} from '@/modules/providers/list/codex/codex-thread-items.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';

const TIMESTAMP = '2026-09-21T16:35:41.044Z';

/** One logical item, as each transport spells it. */
type PairedItem = { label: string; appServer: unknown; rollout: unknown };

const PAIRED_ITEMS: readonly PairedItem[] = [
  {
    label: 'user message',
    appServer: {
      type: 'userMessage',
      id: '01a0c4d2-b0a4-7991-85e5-931b865e6ed0',
      clientId: null,
      content: [{ type: 'text', text: 'run `echo hello` in the shell', text_elements: [] }],
    },
    rollout: {
      type: 'UserMessage',
      id: '01a0c4d2-b0a4-7991-85e5-931b865e6ed0',
      content: [{ type: 'text', text: 'run `echo hello` in the shell', text_elements: [] }],
    },
  },
  {
    label: 'assistant text',
    appServer: {
      type: 'agentMessage',
      id: 'msg_02c8dbf5b38a0554016ab15cdac32487d0b8c41f91c58a05b0',
      text: '我会按顺序执行。',
      phase: 'commentary',
      memoryCitation: null,
      delivery: null,
      questions: null,
    },
    rollout: {
      type: 'AgentMessage',
      id: 'msg_02c8dbf5b38a0554016ab15cdac32487d0b8c41f91c58a05b0',
      content: [{ type: 'Text', text: '我会按顺序执行。' }],
      phase: 'commentary',
    },
  },
  {
    label: 'shell command',
    appServer: {
      type: 'commandExecution',
      id: 'exec-894d4147-e8aa-4799-8578-6cc60ce7bbd0',
      pluginId: null,
      scriptPath: null,
      command: "/bin/zsh -lc 'echo hello'",
      cwd: '/tmp/cxprobe/ws2',
      processId: '55360',
      source: 'unifiedExecStartup',
      status: 'completed',
      commandActions: [{ type: 'unknown', command: 'echo hello' }],
      aggregatedOutput: 'hello\n',
      exitCode: 0,
      durationMs: 0,
    },
    rollout: {
      type: 'CommandExecution',
      id: 'exec-894d4147-e8aa-4799-8578-6cc60ce7bbd0',
      process_id: '55360',
      command: ['/bin/zsh', '-lc', 'echo hello'],
      cwd: 'file:///tmp/cxprobe/ws2',
      parsed_cmd: [{ type: 'unknown', cmd: 'echo hello' }],
      source: 'unified_exec_startup',
      status: 'completed',
      stdout: 'hello\n',
      stderr: '',
      aggregated_output: 'hello\n',
      exit_code: 0,
      duration: { secs: 0, nanos: 2208 },
      formatted_output: 'hello\n',
    },
  },
  {
    label: 'file created',
    appServer: {
      type: 'fileChange',
      id: 'exec-5d642a46-2f48-49ec-baa8-4562a919dabb',
      changes: [{ path: '/tmp/cxprobe/ws2/notes.txt', kind: { type: 'add' }, diff: 'ok\n' }],
      status: 'completed',
    },
    rollout: {
      type: 'FileChange',
      id: 'exec-5d642a46-2f48-49ec-baa8-4562a919dabb',
      changes: { '/tmp/cxprobe/ws2/notes.txt': { type: 'add', content: 'ok\n' } },
      status: 'completed',
      stdout: 'Success. Updated the following files:\nA /tmp/cxprobe/ws2/notes.txt\n',
      stderr: '',
    },
  },
];

test('both transports read one item into the same rows', () => {
  for (const { label, appServer, rollout } of PAIRED_ITEMS) {
    const live = readCodexAppServerItem(appServer);
    const persisted = readCodexRolloutItem(rollout);
    assert.ok(live, `${label}: app-server item was not recognized`);
    assert.ok(persisted, `${label}: rollout item was not recognized`);

    assert.deepEqual(
      codexThreadItemToRows(live, TIMESTAMP),
      codexThreadItemToRows(persisted, TIMESTAMP),
      `${label}: the live rows and the persisted rows differ`,
    );
  }
});

test('every row id is derived from the id Codex gave the item', () => {
  for (const { label, rollout } of PAIRED_ITEMS) {
    const item = readCodexRolloutItem(rollout);
    assert.ok(item, `${label}: rollout item was not recognized`);
    for (const row of codexThreadItemToRows(item, TIMESTAMP)) {
      assert.ok(
        String(row.uuid).startsWith(item.id),
        `${label}: row id ${String(row.uuid)} is not derived from item id ${item.id}`,
      );
    }
  }
});

test('a running command keeps its card open until output arrives', () => {
  const item = readCodexAppServerItem({
    type: 'commandExecution',
    id: 'exec-1',
    command: "/bin/zsh -lc 'sleep 5'",
    status: 'inProgress',
    aggregatedOutput: '',
    exitCode: null,
  });
  assert.ok(item);
  assert.deepEqual(codexThreadItemToRows(item, TIMESTAMP).map((row) => row.type), ['tool_use']);

  const streaming = readCodexAppServerItem({
    type: 'commandExecution',
    id: 'exec-1',
    command: "/bin/zsh -lc 'sleep 5'",
    status: 'inProgress',
    aggregatedOutput: 'partial',
    exitCode: null,
  });
  assert.ok(streaming);
  const rows = codexThreadItemToRows(streaming, TIMESTAMP);
  assert.deepEqual(rows.map((row) => row.type), ['tool_use', 'tool_result']);
  // The in-flight result keeps the same id it will have once the command ends,
  // so the finished output replaces the partial one instead of stacking.
  assert.equal(rows[1].uuid, 'exec-1_result');
});

test('a patch reconstructs the before/after text of every file it touched', () => {
  const item = readCodexRolloutItem({
    type: 'FileChange',
    id: 'exec-2',
    status: 'completed',
    changes: {
      '/repo/a.ts': { type: 'update', unified_diff: '@@ -1,3 +1,3 @@\n keep\n-old\n+new\n', move_path: null },
      '/repo/b.ts': { type: 'delete', content: 'gone\n' },
    },
  });
  assert.ok(item);
  const rows = codexThreadItemToRows(item, TIMESTAMP);
  assert.deepEqual(rows.map((row) => row.uuid), [
    'exec-2_0', 'exec-2_0_result', 'exec-2_1', 'exec-2_1_result',
  ]);
  assert.deepEqual(JSON.parse(String(rows[0].toolInput)), {
    file_path: '/repo/a.ts',
    old_string: 'keep\nold',
    new_string: 'keep\nnew',
  });
  assert.equal(rows[2].toolName, 'Edit');
  assert.equal(JSON.parse(String(rows[2].toolInput)).deleted, true);
});

test('orchestration-only collaboration calls never reach the transcript', () => {
  for (const tool of ['wait', 'sendMessage', 'listAgents']) {
    assert.equal(readCodexAppServerItem({ type: 'collabAgentToolCall', id: 'call_1', tool, status: 'completed' }), null);
  }
  const spawn = readCodexAppServerItem({
    type: 'collabAgentToolCall',
    id: 'call_2',
    tool: 'spawnAgent',
    status: 'inProgress',
    prompt: 'audit the reader',
    agentsStates: { '/root/audit': { status: 'running' } },
  });
  assert.ok(spawn);
  const rows = codexThreadItemToRows(spawn, TIMESTAMP);
  assert.deepEqual(rows.map((row) => row.toolName), ['Agent']);
  assert.equal(JSON.parse(String(rows[0].toolInput)).description, 'Audit');
});

test('a context compaction is the shared compaction row, the same from history and live', () => {
  const rows = codexThreadItemToRows({ kind: 'context_compaction', id: 'cmp-1' }, '2026-10-23T00:00:00.000Z');
  assert.deepEqual(rows, [{ uuid: 'cmp-1', type: 'compaction', timestamp: '2026-10-23T00:00:00.000Z' }]);

  const provider = new CodexSessionsProvider();
  const [done] = provider.normalizeMessage(rows[0], 'thread-1');
  assert.equal(done.id, 'cmp-1');
  assert.equal(done.kind, 'text');
  assert.equal(done.role, 'assistant');
  assert.equal(done.content, 'Compacted');
  assert.deepEqual(done.compact, { phase: 'done' });

  const [running] = provider.normalizeMessage({ ...rows[0], phase: 'running' }, 'thread-1');
  assert.equal(running.id, 'cmp-1');
  assert.deepEqual(running.compact, { phase: 'running' });
});

test('a completed spawn acknowledgement keeps its child running in live and rollout records', () => {
  for (const [reader, type] of [[readCodexAppServerItem, 'collabAgentToolCall'], [readCodexRolloutItem, 'CollabAgentToolCall']] as const) {
    const item = reader({ type, id: 'spawn-ack', tool: 'spawn_agent', status: 'completed', receiver_thread_ids: ['child-1'], receiver_agents: [{ thread_id: 'child-1', agent_nickname: 'Boole' }], agents_states: { 'child-1': 'pending_init' } });
    assert.ok(item && item.kind === 'collab_spawn');
    assert.deepEqual(item.receiverThreadIds, ['child-1']);
    const rows = codexThreadItemToRows(item, TIMESTAMP);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'in_progress');
    assert.deepEqual(rows[1].toolUseResult, { isAsync: true, agentId: 'child-1' });
  }
});
