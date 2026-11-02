import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage, ServerEvent } from '@/shared/types';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { SessionTimelineStore } from '@/modules/chat/utils/sessionTimelineStore';

/**
 * While a subagent runs, its rows stream in stamped with the spawning call's
 * tool id (`parentToolUseId`). They must fold into that call's container, not
 * render as the session's own tool calls only to jump inside after a refresh,
 * when the server ships the same timeline as `subagentTools` on the row.
 *
 * This projection was introduced in 99ea0525/557109a2 and lost in the
 * upstream merge, which is why these cases pin every source it carries.
 */

function message(
  id: string,
  overrides: Partial<NormalizedMessage>,
): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1',
    timestamp: '2026-08-26T12:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: id,
    ...overrides,
  };
}

// The spawn row carries the engine-neutral name every adapter translates to;
// a legacy Claude `Task` row is canonicalized to this before it reaches the page.
const taskRow = (overrides: Partial<NormalizedMessage> = {}) => message('task', {
  kind: 'tool_use',
  toolId: 'task-1',
  toolName: 'Agent',
  toolInput: { description: 'demo', prompt: 'do things' },
  ...overrides,
});

const subagentBash = (id: string, toolId: string) => message(id, {
  kind: 'tool_use',
  toolId,
  toolName: 'Bash',
  toolInput: { command: `echo ${id}` },
  parentToolUseId: 'task-1',
});

test('live subagent rows fold into the container instead of rendering top-level', () => {
  const converted = normalizedToChatMessages([
    taskRow(),
    subagentBash('step-1', 'bash-1'),
    message('note', { parentToolUseId: 'task-1', content: 'Running step 2' }),
    subagentBash('step-2', 'bash-2'),
    message('result-1', {
      kind: 'tool_result',
      toolId: 'bash-1',
      content: 'step 1 done',
      parentToolUseId: 'task-1',
    }),
  ]);

  assert.equal(converted.length, 1, 'subagent rows must not render as top-level messages');
  const container = converted[0];
  assert.equal(container.isSubagentContainer, true);

  const activity = container.subagentActivity ?? [];
  assert.deepEqual(
    activity.map((entry) => entry.kind),
    ['tool', 'text', 'tool'],
  );
  assert.equal(activity[0].toolName, 'Bash');
  assert.equal(activity[0].toolResult?.content, 'step 1 done');
  assert.equal(activity[2].toolResult, undefined, 'unfinished tool must stay pending');
});

test('the echoed task prompt does not appear in the timeline', () => {
  const converted = normalizedToChatMessages([
    taskRow(),
    message('echo', { role: 'user', content: 'do things', parentToolUseId: 'task-1' }),
  ]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0].subagentActivity, undefined);
});

test('a growing live timeline invalidates the cached container projection', () => {
  const task = taskRow();
  const first = subagentBash('step-1', 'bash-1');

  const initial = normalizedToChatMessages([task, first]);
  assert.equal(initial[0].subagentActivity?.length, 1);

  const updated = normalizedToChatMessages([task, first, subagentBash('step-2', 'bash-2')]);
  assert.equal(
    updated[0].subagentActivity?.length,
    2,
    'the container must pick up rows that arrived after it was cached',
  );
});

test('the longer of the live and server timelines wins', () => {
  const serverTimeline = [
    { kind: 'tool' as const, toolId: 'bash-1', toolName: 'Bash' },
    { kind: 'tool' as const, toolId: 'bash-2', toolName: 'Bash' },
  ];
  const taskWithServerTimeline = taskRow({ subagentTools: serverTimeline });

  const stale = normalizedToChatMessages([
    taskWithServerTimeline,
    subagentBash('step-1', 'bash-1'),
  ]);
  assert.equal(stale[0].subagentActivity, serverTimeline);

  const fresher = normalizedToChatMessages([
    taskWithServerTimeline,
    subagentBash('step-1', 'bash-1'),
    subagentBash('step-2', 'bash-2'),
    subagentBash('step-3', 'bash-3'),
  ]);
  assert.equal(fresher[0].subagentActivity?.length, 3);
});

test('backend subagent, tool status and workflow metadata reach the card', () => {
  const subagent = {
    id: 'ses_child',
    name: 'general',
    type: 'general',
    description: 'Inspect the repository',
    status: 'running' as const,
    activityCount: 4,
  };
  const converted = normalizedToChatMessages([
    message('opencode-task', {
      kind: 'tool_use',
      toolId: 'call_subagent',
      toolName: 'subagent',
      toolInput: { agent: 'general', description: 'Inspect the repository' },
      status: 'running',
      subagent,
      subagentTools: [{ kind: 'text', content: 'working' }],
    }),
    message('workflow', {
      kind: 'tool_use',
      toolId: 'call_workflow',
      toolName: 'Workflow',
      toolInput: {},
      workflow: {
        runId: 'run-1',
        name: 'audit',
        status: 'running',
        agents: [],
        agentCounts: { total: 0, completed: 0, failed: 0, running: 0, stopped: 0 },
      },
    }),
    message('workflow-result', { kind: 'tool_result', toolId: 'call_workflow', content: 'running' }),
  ]);

  const row = converted.find((entry) => entry.toolId === 'call_subagent');
  assert.equal(row?.isSubagentContainer, true, 'opencode subagent is a container by name alone');
  assert.deepEqual(row?.subagent, subagent);
  assert.equal(row?.toolStatus, 'running');
  assert.deepEqual(row?.subagentActivity, [{ kind: 'text', content: 'working' }]);

  const workflowRow = converted.find((entry) => entry.toolId === 'call_workflow');
  assert.equal(workflowRow?.workflow?.runId, 'run-1');
});

test('streamed subagent text deltas share one timeline entry', () => {
  const delta = (content: string) => message('text-block', {
    kind: 'stream_delta',
    content,
    parentToolUseId: 'task-1',
  });

  const converted = normalizedToChatMessages([taskRow(), delta('Hello'), delta(' world')]);
  assert.equal(converted.length, 1);
  assert.deepEqual(converted[0].subagentActivity, [
    { kind: 'text', content: 'Hello world', timestamp: '2026-08-26T12:00:00.000Z' },
  ]);
});

test('a subagent streamed through the timeline store stays inside its container', async () => {
  // The store buffers deltas before they reach the fold. That buffer used to
  // drop `parentToolUseId`, so a running subagent's prose rendered as the
  // session's own messages until a reload moved it into the card — the
  // vanishing-fragments report this pins shut.
  const store = new SessionTimelineStore();

  store.applyServerEvent({
    kind: 'tool_use',
    id: 'spawn-card',
    sessionId: 'session-1',
    provider: 'opencode',
    timestamp: '2026-08-26T12:00:00.000Z',
    toolId: 'call_subagent',
    toolName: 'subagent',
    toolInput: { description: 'demo' },
  } as unknown as ServerEvent, { provider: 'opencode' });
  store.applyServerEvent({
    kind: 'stream_delta',
    id: 'child-text',
    sessionId: 'session-1',
    provider: 'opencode',
    timestamp: '2026-08-26T12:00:01.000Z',
    content: 'Now the hooks — tellPlan, slowFlare, onHit:',
    providerRowKey: 'opencode-part:msg_child_text_0',
    parentToolUseId: 'call_subagent',
  } as unknown as ServerEvent, { provider: 'opencode' });
  await new Promise((resolve) => setTimeout(resolve, 130));

  const converted = normalizedToChatMessages(store.getMessages('session-1'));
  assert.equal(converted.length, 1, 'the subagent stream must not become a top-level message');
  assert.equal(converted[0].isSubagentContainer, true);
  assert.equal(
    converted[0].subagentActivity?.[0]?.content,
    'Now the hooks — tellPlan, slowFlare, onHit:',
  );
});
