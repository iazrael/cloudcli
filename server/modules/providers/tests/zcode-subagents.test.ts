import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { ZCodeSessionsProvider } from '@/modules/providers/list/zcode/zcode-sessions.provider.js';
import { zcodeBackgroundWork } from '@/modules/providers/list/zcode/zcode-background-work.js';

import { withZCodeStorage } from './zcode-storage-fixture.js';

// Payloads as the engine emits them on the PARENT session (`emitSubagentEvent`
// → `emitParentEvent`): the spawn carries the launch details, the stop the
// outcome and totals. Both name the launching tool call.
const spawnedPayload = {
  agentId: 'agent_a',
  agentType: 'general-purpose',
  background: true,
  childSessionId: 'sess_subagent_agent_a',
  description: 'Review the fix',
  prompt: 'Review the diff and report',
  parentToolCallId: 'call_agent',
  status: 'running',
  allowedTools: ['Read'],
  model: 'bigmodel/GLM-5.3',
};

const stoppedPayload = {
  agentId: 'agent_a',
  agentType: 'general-purpose',
  background: true,
  childSessionId: 'sess_subagent_agent_a',
  parentToolCallId: 'call_agent',
  status: 'completed',
  outputFile: '/tmp/agents/sess_1/agent_a/output.txt',
  totalDurationMs: 854566,
  totalToolUseCount: 40,
  totalTokens: 2216983,
};

const liveEvent = (type: string, payload: Record<string, unknown>) => ({
  method: 'session/event',
  params: { id: `evt_${type}`, sessionId: 'sess_1', type, timestamp: '2026-10-18T02:00:27.398Z', payload },
});

test('subagent_spawned becomes a running task_status on the launching call', () => {
  const provider = new ZCodeSessionsProvider();
  const messages = provider.normalizeMessage(liveEvent('subagent_spawned', spawnedPayload), 'sess_1');

  assert.equal(messages.length, 1);
  const [status] = messages;
  assert.equal(status.kind, 'task_status');
  assert.equal(status.event, 'started');
  assert.equal(status.taskId, 'agent_a');
  assert.equal(status.toolUseId, 'call_agent');
  assert.equal(status.taskType, 'local_agent');
  assert.equal(status.description, 'Review the fix');
  assert.equal(status.sessionId, 'sess_1');
});

test('subagent_stopped settles the task with the agent totals', () => {
  const provider = new ZCodeSessionsProvider();
  const [completed] = provider.normalizeMessage(liveEvent('subagent_stopped', stoppedPayload), 'sess_1');

  assert.equal(completed.kind, 'task_status');
  assert.equal(completed.event, 'notification');
  assert.equal(completed.taskId, 'agent_a');
  assert.equal(completed.toolUseId, 'call_agent');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outputFile, '/tmp/agents/sess_1/agent_a/output.txt');
  assert.deepEqual(completed.usage, { totalTokens: 2216983, toolUses: 40, durationMs: 854566 });

  const [failed] = provider.normalizeMessage(
    liveEvent('subagent_stopped', { ...stoppedPayload, status: 'failed', error: 'child runtime failed', totalTokens: undefined, totalToolUseCount: undefined }),
    'sess_1',
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.summary, 'child runtime failed');
  // The engine's failure stop carries no token or tool-call totals; leaving
  // them out says "not reported", where a 0 would claim a measured zero.
  assert.deepEqual(failed.usage, { durationMs: 854566 });

  const [bare] = provider.normalizeMessage(
    liveEvent('subagent_stopped', { agentId: 'agent_a', parentToolCallId: 'call_agent', status: 'stopped' }),
    'sess_1',
  );
  assert.equal(bare.status, 'stopped');
  assert.equal(bare.usage, undefined, 'a stop that reports no totals at all carries no usage');
});

test('a subagent event without the launching call is dropped rather than sent unattached', () => {
  const provider = new ZCodeSessionsProvider();
  const { parentToolCallId: _omitted, ...orphan } = spawnedPayload;
  assert.deepEqual(provider.normalizeMessage(liveEvent('subagent_spawned', orphan), 'sess_1'), []);
});

test("the engine's Agent tool keeps its name on every live shape", () => {
  const provider = new ZCodeSessionsProvider();

  const [snapshot] = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_call', toolCallId: 'call_1', toolName: 'Agent', input: { description: 'Review' } } },
    'sess_1',
  );
  assert.equal(snapshot.kind, 'tool_use');
  assert.equal(snapshot.toolName, 'Agent');

  const [announced] = provider.normalizeMessage(
    { type: 'tool.updated', payload: { kind: 'scheduled', toolCallId: 'call_2', toolName: 'Agent', input: { description: 'Audit' } } },
    'sess_1',
  );
  assert.equal(announced.toolName, 'Agent');

  provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_start', toolCallId: 'call_3', toolName: 'Agent' } },
    'sess_1',
  );
  const [streamed] = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_end', toolCallId: 'call_3', input: { description: 'Scan' } } },
    'sess_1',
  );
  assert.equal(streamed.toolName, 'Agent');

  // Every other tool keeps its engine name.
  const [bash] = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_call', toolCallId: 'call_4', toolName: 'Bash', input: { command: 'ls' } } },
    'sess_1',
  );
  assert.equal(bash.toolName, 'Bash');
});

// Captured from the real engine (ZCode 0.16.x): while an agent runs, its tool
// calls are mirrored onto the PARENT session's stream as `tool.updated` events
// whose payload names the agent's card as `parentToolCallId`.
const childScheduled = {
  toolCallId: 'tool_subagent_agent_a_call_child',
  assistantMessageId: 'msg_child',
  toolName: 'Bash',
  input: { command: 'echo hello-from-agent', description: 'Print hello' },
  kind: 'scheduled',
  source: 'subagent',
  agentId: 'agent_a',
  agentType: 'general-purpose',
  childSessionId: 'sess_subagent_agent_a',
  childToolCallId: 'call_child',
  parentToolCallId: 'call_agent',
};

test('a tool call an agent makes is tied to the agent\'s card, not shown in the main thread', () => {
  const provider = new ZCodeSessionsProvider();
  const [row] = provider.normalizeMessage({ method: 'session/event', params: { sessionId: 'sess_1', type: 'tool.updated', payload: childScheduled } }, 'sess_1');
  assert.equal(row.kind, 'tool_use');
  assert.equal(row.toolName, 'Bash');
  assert.equal(row.toolId, 'tool_subagent_agent_a_call_child');
  assert.equal(row.parentToolUseId, 'call_agent');
});

test('a main-thread tool call is not tied to any card', () => {
  const provider = new ZCodeSessionsProvider();
  const { source: _s, agentId: _a, agentType: _t, childSessionId: _c, childToolCallId: _k, parentToolCallId: _p, ...mainThread } = childScheduled;
  const [row] = provider.normalizeMessage({ method: 'session/event', params: { sessionId: 'sess_1', type: 'tool.updated', payload: mainThread } }, 'sess_1');
  assert.equal(row.kind, 'tool_use');
  assert.equal(row.parentToolUseId, undefined);
});

// ---------------------------------------------------------------------------
// History: the Agent row reads its outcome off the engine's agent sidecar
// ---------------------------------------------------------------------------

type AgentMetadata = Record<string, unknown>;

/**
 * A parent session whose assistant turn launched one agent, in the engine's
 * SQLite shape, plus the child session that agent ran in (its first assistant
 * row names the model).
 */
const createParentWithAgent = async (
  storageDir: string,
  parentSessionId: string,
  options: { output: string; childModelId?: string },
): Promise<void> => {
  const dbDir = path.join(storageDir, 'cli', 'db');
  await mkdir(dbDir, { recursive: true });
  const db = new Database(path.join(dbDir, 'db.sqlite'));
  try {
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER);
    `);
    const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)');
    const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)');

    insertMessage.run('msg_user', parentSessionId, 1000, 1000, JSON.stringify({ role: 'user', text: 'Review this' }), 0);
    insertMessage.run('msg_asst', parentSessionId, 2000, 2000, JSON.stringify({ role: 'assistant', modelID: 'GLM-5.3' }), 1);
    insertPart.run('part_agent', 'msg_asst', parentSessionId, 2100, 2100, JSON.stringify({
      type: 'tool',
      callID: 'call_agent',
      tool: 'Agent',
      state: {
        status: 'completed',
        input: { description: 'Review the fix', prompt: 'Review the diff', run_in_background: true, subagent_type: 'general-purpose' },
        output: options.output,
      },
    }), 0);

    if (options.childModelId) {
      insertMessage.run('msg_child_user', 'sess_subagent_agent_a', 2200, 2200, JSON.stringify({ role: 'user', text: 'Review the diff' }), 0);
      insertMessage.run('msg_child_asst', 'sess_subagent_agent_a', 2300, 2300, JSON.stringify({ role: 'assistant', modelId: options.childModelId }), 1);
      // What the agent did: a sentence, then one tool call with its result.
      insertPart.run('part_child_text', 'msg_child_asst', 'sess_subagent_agent_a', 2310, 2310, JSON.stringify({ type: 'text', text: 'Reading the diff.' }), 0);
      insertPart.run('part_child_tool', 'msg_child_asst', 'sess_subagent_agent_a', 2320, 2320, JSON.stringify({
        type: 'tool', callID: 'call_child_read', tool: 'Read',
        state: { status: 'completed', input: { path: '/tmp/a.ts' }, output: 'file body' },
      }), 1);
    }
  } finally {
    db.close();
  }
};

/** Writes the sidecar the engine keeps at `cli/agents/<parent>/<agent>/metadata.json`. */
const writeAgentMetadata = async (storageDir: string, parentSessionId: string, agentId: string, metadata: AgentMetadata): Promise<void> => {
  const dir = path.join(storageDir, 'cli', 'agents', parentSessionId, agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({
    agentId,
    childSessionId: `sess_subagent_${agentId}`,
    createdAt: '2026-10-18T02:00:27.398Z',
    description: 'Review the fix',
    parentSessionId,
    parentToolUseId: 'call_agent',
    profileId: 'general-purpose',
    prompt: 'Review the diff',
    ...metadata,
  }));
};

const backgroundLaunchOutput = 'Async agent launched successfully.\nagentId: agent_a (internal ID - do not mention to user.)';

test('history keeps the Agent row and reads the finished agent off its sidecar', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: backgroundLaunchOutput, childModelId: 'GLM-5.3-Flash' });
    await writeAgentMetadata(storageDir, 'sess_parent', 'agent_a', {
      status: 'completed',
      completedAt: '2026-10-18T02:14:42.142Z',
      totalDurationMs: 854566,
      totalTokens: 2216983,
      totalToolUseCount: 40,
    });

    const provider = new ZCodeSessionsProvider();
    const { messages } = await provider.fetchHistory('sess_parent');
    const task = messages.find((message) => message.kind === 'tool_use');

    assert.ok(task, 'the launch row is kept');
    assert.equal(task.toolName, 'Agent');
    assert.equal(task.toolId, 'call_agent');
    assert.deepEqual(task.subagent, {
      id: 'agent_a',
      name: 'general-purpose',
      type: 'general-purpose',
      description: 'Review the fix',
      status: 'completed',
      model: 'GLM-5.3-Flash',
      activityCount: 2,
    });

    // The agent's own work, from its child session, in the shape Claude and
    // Codex cards use.
    assert.equal(task.subagentTools?.length, 2);
    assert.equal(task.subagentTools?.[0].kind, 'text');
    assert.equal(task.subagentTools?.[0].content, 'Reading the diff.');
    assert.equal(task.subagentTools?.[1].kind, 'tool');
    assert.equal(task.subagentTools?.[1].toolName, 'Read');
    assert.equal(task.subagentTools?.[1].toolResult?.content, 'file body');
  });
});

test('an agent whose child session is not in the database keeps its card without a timeline', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: backgroundLaunchOutput });
    await writeAgentMetadata(storageDir, 'sess_parent', 'agent_a', { status: 'completed' });

    const { messages } = await new ZCodeSessionsProvider().fetchHistory('sess_parent');
    const task = messages.find((message) => message.kind === 'tool_use');
    assert.equal(task?.subagent?.status, 'completed');
    assert.equal(task?.subagentTools, undefined);
  });
});

test('history reports a failed agent as failed', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: backgroundLaunchOutput });
    await writeAgentMetadata(storageDir, 'sess_parent', 'agent_a', { status: 'failed', error: 'child runtime failed' });

    const provider = new ZCodeSessionsProvider();
    const { messages } = await provider.fetchHistory('sess_parent');
    const task = messages.find((message) => message.kind === 'tool_use');
    assert.equal(task?.subagent?.status, 'failed');
  });
});

test('an agent the sidecar still calls running is running only while the runtime tracks it', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: backgroundLaunchOutput });
    await writeAgentMetadata(storageDir, 'sess_parent', 'agent_a', { status: 'running' });

    const tracked = new ZCodeSessionsProvider({ isSubagentRunning: (agentId) => agentId === 'agent_a' });
    const live = await tracked.fetchHistory('sess_parent');
    assert.equal(live.messages.find((message) => message.kind === 'tool_use')?.subagent?.status, 'running');

    // The process that ran it is gone (server restart, engine crash): nothing
    // can still report, so the card must not spin forever.
    const untracked = new ZCodeSessionsProvider({ isSubagentRunning: () => false });
    const stale = await untracked.fetchHistory('sess_parent');
    assert.equal(stale.messages.find((message) => message.kind === 'tool_use')?.subagent?.status, 'stopped');
  });
});

test('the default liveness check consults the runtime background-work registry', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: backgroundLaunchOutput });
    await writeAgentMetadata(storageDir, 'sess_parent', 'agent_a', { status: 'running' });

    zcodeBackgroundWork.start('app_parent', { taskId: 'agent_a', toolUseId: 'call_agent', taskType: 'local_agent', description: 'Review the fix' });
    try {
      const provider = new ZCodeSessionsProvider();
      const { messages } = await provider.fetchHistory('sess_parent');
      assert.equal(messages.find((message) => message.kind === 'tool_use')?.subagent?.status, 'running');
    } finally {
      zcodeBackgroundWork.end('app_parent', 'agent_a');
    }

    const provider = new ZCodeSessionsProvider();
    const { messages } = await provider.fetchHistory('sess_parent');
    assert.equal(messages.find((message) => message.kind === 'tool_use')?.subagent?.status, 'stopped');
  });
});

test('an Agent row without a sidecar keeps rendering from its own input and result', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: 'The review found no blockers.' });

    const provider = new ZCodeSessionsProvider();
    const { messages } = await provider.fetchHistory('sess_parent');
    const task = messages.find((message) => message.kind === 'tool_use');
    assert.equal(task?.toolName, 'Agent');
    assert.equal(task?.subagent, undefined);
    assert.equal(task?.toolResult?.content, 'The review found no blockers.');
  });
});

test('an unreadable agent sidecar directory is logged, and the row still renders without agent metadata', async (t) => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: 'The review found no blockers.' });
    // A file where the directory should be: readdir fails with ENOTDIR, which
    // is not the "no sidecars yet" case (ENOENT) and must not pass silently.
    const agentsDir = path.join(storageDir, 'cli', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(path.join(agentsDir, 'sess_parent'), 'not a directory');

    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });

    const { messages } = await new ZCodeSessionsProvider().fetchHistory('sess_parent');
    const task = messages.find((message) => message.kind === 'tool_use');

    assert.equal(task?.subagent, undefined);
    assert.equal(task?.toolResult?.content, 'The review found no blockers.');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /sess_parent/);
    assert.match(logged[0], /ENOTDIR/);
  });
});

test('a session that never spawned an agent has no sidecar directory and logs nothing', async (t) => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: 'ok' });

    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });

    await new ZCodeSessionsProvider().fetchHistory('sess_parent');
    assert.deepEqual(logged, []);
  });
});

// ---------------------------------------------------------------------------
// SendMessage resuming a stopped agent: the engine rewrites the sidecar's
// `parentToolUseId` to the SendMessage call and reports the resumed run on it.
// The card is still the original Agent call's, as in the engine's own UI.
// ---------------------------------------------------------------------------

test('history pairs the Agent row with its agent even after a resume rewrote the sidecar', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: backgroundLaunchOutput, childModelId: 'GLM-5.3-Flash' });
    await writeAgentMetadata(storageDir, 'sess_parent', 'agent_a', { status: 'completed', parentToolUseId: 'call_send' });

    const { messages } = await new ZCodeSessionsProvider().fetchHistory('sess_parent');
    const task = messages.find((message) => message.kind === 'tool_use');
    assert.equal(task?.toolId, 'call_agent');
    assert.equal(task?.subagent?.id, 'agent_a');
    assert.equal(task?.subagent?.status, 'completed');
    assert.equal(task?.subagentTools?.length, 2);
  });
});

test('history falls back to the sidecar\'s launching call when the result names no agent', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: 'The review found no blockers.' });
    await writeAgentMetadata(storageDir, 'sess_parent', 'agent_a', { status: 'completed' });

    const { messages } = await new ZCodeSessionsProvider().fetchHistory('sess_parent');
    assert.equal(messages.find((message) => message.kind === 'tool_use')?.subagent?.id, 'agent_a');
  });
});

test('history does not pair an Agent row with another call\'s agent', async () => {
  await withZCodeStorage(async (storageDir) => {
    // The result names agent_a, whose sidecar is missing; agent_b's sidecar
    // was launched by another call and must not be borrowed.
    await createParentWithAgent(storageDir, 'sess_parent', { output: backgroundLaunchOutput });
    await writeAgentMetadata(storageDir, 'sess_parent', 'agent_b', { status: 'completed', parentToolUseId: 'call_other' });

    const { messages } = await new ZCodeSessionsProvider().fetchHistory('sess_parent');
    assert.equal(messages.find((message) => message.kind === 'tool_use')?.subagent, undefined);
  });
});

const parentLiveEvent = (type: string, payload: Record<string, unknown>) => ({
  method: 'session/event',
  params: { id: `evt_${type}`, sessionId: 'sess_parent', type, timestamp: '2026-11-11T01:56:20.181Z', payload },
});

const resumedRun = { agentId: 'agent_a', agentType: 'general-purpose', background: true, childSessionId: 'sess_subagent_agent_a', parentToolCallId: 'call_send' };

test('a resumed agent\'s live events land on the Agent call that launched it', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: backgroundLaunchOutput });
    const provider = new ZCodeSessionsProvider();

    const [started] = provider.normalizeMessage(
      parentLiveEvent('subagent_spawned', { ...resumedRun, resumed: true, description: 'Review the fix', status: 'running' }),
      'sess_parent',
    );
    assert.equal(started.kind, 'task_status');
    assert.equal(started.event, 'started');
    assert.equal(started.toolUseId, 'call_agent');
    assert.equal(started.resumed, true);

    // The turn that resumed it ends; the agent keeps running.
    provider.normalizeMessage(parentLiveEvent('turn_complete', {}), 'sess_parent');

    const [childCall] = provider.normalizeMessage(
      parentLiveEvent('tool.updated', { ...childScheduled, parentToolCallId: 'call_send' }),
      'sess_parent',
    );
    assert.equal(childCall.parentToolUseId, 'call_agent', 'the resumed run\'s tool calls fold into the original card');

    const [stopped] = provider.normalizeMessage(
      parentLiveEvent('subagent_stopped', { ...resumedRun, status: 'completed', totalDurationMs: 10 }),
      'sess_parent',
    );
    assert.equal(stopped.toolUseId, 'call_agent');
    assert.equal(stopped.status, 'completed');
    assert.equal(stopped.resumed, undefined);
  });
});

test('a resumed agent whose launch cannot be found stays on the call that resumed it', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createParentWithAgent(storageDir, 'sess_parent', { output: 'The review found no blockers.' });
    const provider = new ZCodeSessionsProvider();

    const [started] = provider.normalizeMessage(
      parentLiveEvent('subagent_spawned', { ...resumedRun, resumed: true, status: 'running' }),
      'sess_parent',
    );
    assert.equal(started.toolUseId, 'call_send');
    assert.equal(started.resumed, true);
  });
});

test('a first spawn is reported on its own call without a database lookup', () => {
  const provider = new ZCodeSessionsProvider();
  const [started] = provider.normalizeMessage(liveEvent('subagent_spawned', spawnedPayload), 'sess_1');
  assert.equal(started.toolUseId, 'call_agent');
  assert.equal(started.resumed, undefined);
});
