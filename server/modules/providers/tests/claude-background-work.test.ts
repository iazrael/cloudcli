import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBackgroundWorkTracker,
  extractBackgroundTasks,
  startsBackgroundWork,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';

test('task cards expose the engine stop handle separately from the launching call id', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', {
    type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { run_in_background: true } }] },
  });
  assert.equal(tracker.apply('s1', {
    type: 'system', subtype: 'task_started', task_id: 'bash-task', tool_use_id: 'toolu_bash', task_type: 'local_bash',
  }), true, 'learning the stop handle must broadcast an updated task card');
  assert.equal(tracker.activeTasks('s1')[0].id, 'toolu_bash');
  assert.equal(tracker.activeTasks('s1')[0].taskId, 'bash-task');
});

for (const [toolName, acknowledgement] of [
  ['Bash', { backgroundTaskId: 'engine-task' }],
  ['Agent', { agentId: 'engine-task' }],
  ['Workflow', { taskId: 'engine-task' }],
] as const) {
  test(`${toolName} acknowledgements expose a stop handle without task_started`, () => {
    const tracker = createBackgroundWorkTracker();
    tracker.apply('s1', {
      type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_launch', name: toolName, input: { run_in_background: true } }] },
    });
    assert.equal(tracker.apply('s1', {
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_launch', content: 'started' }] },
      tool_use_result: acknowledgement,
    }), true);
    assert.equal(tracker.activeTasks('s1')[0].id, 'toolu_launch');
    assert.equal(tracker.activeTasks('s1')[0].taskId, 'engine-task');
    assert.equal(tracker.has('s1', 'engine-task'), true);
  });
}

// Only turns that start work outliving the turn hold their CLI process open. A
// turn scored `false` here has its stdin released the moment `result` arrives,
// and the CLI reads that EOF as print wind-down — so anything still running dies.
const turn = (...blocks: Array<{ name: string; input?: Record<string, unknown> }>) => ({
  type: 'assistant',
  message: { content: blocks.map((block) => ({ type: 'tool_use', input: {}, ...block })) },
});

test('a backgrounded Bash holds the process open', () => {
  assert.equal(startsBackgroundWork(turn({ name: 'Bash', input: { run_in_background: true } })), true);
});

test('a foreground Bash does not', () => {
  assert.equal(startsBackgroundWork(turn({ name: 'Bash', input: { run_in_background: false } })), false);
});

test('a backgrounded legacy Task spawn holds the process open like an Agent', () => {
  assert.equal(startsBackgroundWork(turn({ name: 'Task', input: { run_in_background: true } })), true);
  assert.equal(startsBackgroundWork(turn({ name: 'Task', input: { run_in_background: false } })), false);
  assert.equal(startsBackgroundWork(turn({ name: 'TaskCreate' })), false, 'a to-do item launches nothing');
});

test('a legacy Task launch is listed on the strip under the Agent name', () => {
  const [task] = extractBackgroundTasks({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_legacy', name: 'Task', input: { run_in_background: true, description: 'Survey' } }] },
  });
  assert.equal(task.toolName, 'Agent');
  assert.equal(task.id, 'toolu_legacy');
});

test('a backgrounded Agent holds the process open', () => {
  // The gap this suite exists for: a background agent used to be scored as
  // nothing outstanding, so the CLI wound down and killed it mid-run.
  assert.equal(startsBackgroundWork(turn({ name: 'Agent', input: { run_in_background: true } })), true);
});

test('an Agent with no run_in_background holds the process open', () => {
  // `run_in_background` is optional on AgentInput and agents background by
  // default, so an omitted field means background, not foreground.
  assert.equal(startsBackgroundWork(turn({ name: 'Agent', input: { prompt: 'Investigate' } })), true);
});

test('a foreground Agent does not', () => {
  // It never pushes a follow-up turn, so holding for it would pin the process
  // for the full BG_WAIT_CEILING_MS.
  assert.equal(startsBackgroundWork(turn({ name: 'Agent', input: { run_in_background: false } })), false);
});

test('a Workflow holds the process open', () => {
  // WorkflowInput has no foreground option: every call returns a task id
  // immediately and reports back in a later turn.
  assert.equal(startsBackgroundWork(turn({ name: 'Workflow', input: { script: 'export const meta = {}' } })), true);
});

test('a deferred-work tool holds the process open', () => {
  assert.equal(startsBackgroundWork(turn({ name: 'Monitor' })), true);
});

test('a turn that starts nothing lasting does not', () => {
  assert.equal(startsBackgroundWork(turn({ name: 'Read' })), false);
});

test('one backgrounded agent among foreground calls is enough', () => {
  assert.equal(
    startsBackgroundWork(
      turn(
        { name: 'Read' },
        { name: 'Agent', input: { run_in_background: false } },
        { name: 'Agent', input: { run_in_background: true } },
      ),
    ),
    true,
  );
});

test('a message carrying no tool calls does not', () => {
  assert.equal(startsBackgroundWork({ type: 'result', message: { content: 'done' } }), false);
  assert.equal(startsBackgroundWork({ type: 'assistant', message: { content: [] } }), false);
  assert.equal(startsBackgroundWork({}), false);
});

// Once the turn's `result` is out, the tracker below is the only record of
// what the held process is still running: the running-sessions list reads it
// and a stop request is refused unless it names one of its tasks. The event
// shapes are the SDK's own, as a real query emits them.
const started = (taskId: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  tool_use_id: `toolu_${taskId}`,
  description: `Task ${taskId}`,
  task_type: 'local_agent',
  ...extra,
});
const notified = (taskId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: `toolu_${taskId}`, status, summary: '', output_file: '',
});
const updated = (taskId: string, patch: Record<string, unknown>) => ({
  type: 'system', subtype: 'task_updated', task_id: taskId, patch,
});

test('a task_started with a tool_use_id adds the task under its session', () => {
  const tracker = createBackgroundWorkTracker();
  const before = Date.now();
  // The session's own turn issued the call, so the task is its own work.
  tracker.apply('s1', {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_t1', name: 'Workflow', input: {} }] },
  });
  tracker.apply('s1', started('t1', { task_type: 'local_workflow', workflow_name: 'spec' }));

  const [entry] = tracker.list();
  assert.equal(tracker.list().length, 1);
  assert.equal(entry.sessionId, 's1');
  assert.equal(entry.tasks.length, 1);
  const { startedAt, ...task } = entry.tasks[0];
  assert.deepEqual(task, {
    taskId: 't1',
    toolUseId: 'toolu_t1',
    taskType: 'local_workflow',
    description: 'Task t1',
    workflowName: 'spec',
  });
  assert.ok(startedAt >= before && startedAt <= Date.now());
  assert.equal(tracker.hasOutstanding('s1'), true);
  assert.equal(tracker.has('s1', 't1'), true);
});

test('a task started for a call the session itself made is its own; one from inside an agent is nested', () => {
  // Verified on a real run: a workflow agent that backgrounds `sleep 60` puts
  // a `task_started` on the parent's stream, with a tool_use_id from the
  // agent's transcript. The parent transcript has no card for it, and the
  // pill would otherwise read "3 tasks" for one workflow.
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_t1', name: 'Workflow', input: {} }] },
  });
  tracker.apply('s1', started('t1', { task_type: 'local_workflow', workflow_name: 'spec' }));
  tracker.apply('s1', started('t2', { task_type: 'local_bash', description: 'Sleep for 60 seconds' }));

  const [entry] = tracker.list();
  assert.deepEqual(entry.tasks.map((task) => [task.taskId, task.nested ?? false]), [['t1', false], ['t2', true]]);
  assert.equal(tracker.has('s1', 't2'), true, 'a nested task can still be stopped');

  // The set of own calls dies with the session, like the tasks.
  tracker.clear('s1');
  tracker.apply('s1', started('t1', { task_type: 'local_workflow' }));
  assert.equal(tracker.list()[0].tasks[0].nested, true);
});

test('a task_started without a tool_use_id is not tracked', () => {
  // Housekeeping tasks the CLI starts on its own have no launching call and
  // nothing in the transcript to show them under.
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', { type: 'system', subtype: 'task_started', task_id: 'ambient', description: 'x' });

  assert.deepEqual(tracker.list(), []);
  assert.equal(tracker.hasOutstanding('s1'), false);
});

test('a task_notification removes the task whatever its status', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', started('t1'));
  tracker.apply('s1', started('t2'));
  tracker.apply('s1', notified('t1', 'completed'));

  assert.equal(tracker.has('s1', 't1'), false);
  assert.equal(tracker.has('s1', 't2'), true);
  assert.equal(tracker.hasOutstanding('s1'), true);

  tracker.apply('s1', notified('t2', 'stopped'));
  assert.equal(tracker.hasOutstanding('s1'), false);
  assert.deepEqual(tracker.list(), []);
});

test('a terminal task_updated removes the task', () => {
  const tracker = createBackgroundWorkTracker();
  for (const [taskId, status] of [['a', 'completed'], ['b', 'failed'], ['c', 'killed']]) {
    tracker.apply('s1', started(taskId));
    tracker.apply('s1', updated(taskId, { status, end_time: 1 }));
    assert.equal(tracker.has('s1', taskId), false, `${status} settles the task`);
  }
  assert.equal(tracker.hasOutstanding('s1'), false);
});

test('a non-terminal task_updated keeps the task', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', started('t1'));
  tracker.apply('s1', updated('t1', { status: 'running' }));
  tracker.apply('s1', updated('t1', { is_backgrounded: true }));
  tracker.apply('s1', updated('t1', { status: 'paused' }));

  assert.equal(tracker.has('s1', 't1'), true);
  assert.equal(tracker.hasOutstanding('s1'), true);
});

test('clearing a session empties it and leaves the others alone', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', started('t1'));
  tracker.apply('s2', started('t2'));
  tracker.clear('s1');

  assert.equal(tracker.hasOutstanding('s1'), false);
  assert.equal(tracker.has('s1', 't1'), false);
  assert.deepEqual(tracker.list().map((entry) => entry.sessionId), ['s2']);
});

test('messages that are not task events leave the set untouched', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', started('t1'));
  tracker.apply('s1', { type: 'assistant', message: { content: [] } });
  tracker.apply('s1', { type: 'system', subtype: 'task_progress', task_id: 't1', description: 'x', usage: {} });
  tracker.apply('s1', { type: 'result', task_id: 't1' });

  assert.equal(tracker.has('s1', 't1'), true);
});

const ownCall = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, output: Record<string, unknown>, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'Result' }] },
  tool_use_result: output,
});

test('a successful wakeup replaces the previous one and expires only at its acknowledged time', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', ownCall('wake1', 'ScheduleWakeup', { delaySeconds: 1 }));
  tracker.apply('s1', toolResult('wake1', { scheduledFor: 5000 }));
  tracker.apply('s1', ownCall('wake2', 'ScheduleWakeup', { delaySeconds: 1 }));
  tracker.apply('s1', toolResult('wake2', { scheduledFor: 9000 }));
  assert.deepEqual(tracker.activeTasks('s1').map((task) => task.id), ['wake2']);
  assert.equal(tracker.nextWakeupAt('s1'), 9000);
  assert.equal(tracker.expireWakeups('s1', 4999), false);
  assert.equal(tracker.expireWakeups('s1', 5000), false);
  assert.deepEqual(tracker.activeTasks('s1').map((task) => task.id), ['wake2']);
  assert.equal(tracker.nextWakeupAt('s1'), 9000);
  assert.equal(tracker.hasPending('s1'), true);
  assert.equal(tracker.expireWakeups('s1', 9000), true);
  assert.equal(tracker.hasPending('s1'), false);
  assert.equal(tracker.nextWakeupAt('s1'), undefined);
  assert.equal(tracker.expireWakeups('missing', 9000), false);
});

test('a failed reschedule retains the pending wakeup, while stop and aged-out results clear it', () => {
  const tracker = createBackgroundWorkTracker();
  for (const stopped of [false, true]) {
    tracker.apply('s1', ownCall('wake1', 'ScheduleWakeup'));
    tracker.apply('s1', toolResult('wake1', { scheduledFor: 9000 }));
    tracker.apply('s1', ownCall('failed', 'ScheduleWakeup'));
    tracker.apply('s1', toolResult('failed', {}, true));
    assert.deepEqual(tracker.activeTasks('s1').map((task) => task.id), ['wake1']);
    tracker.apply('s1', ownCall('end', 'ScheduleWakeup', { stop: stopped }));
    tracker.apply('s1', toolResult('end', { scheduledFor: 0, stopped }));
    assert.deepEqual(tracker.activeTasks('s1'), []);
    assert.equal(tracker.hasPending('s1'), false);
    tracker.clear('s1');
  }
});

test('a Monitor returning a task id can be settled without task_started', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', ownCall('monitor', 'Monitor'));
  tracker.apply('s1', toolResult('monitor', { taskId: 'm1', timeoutMs: 5000 }));
  assert.equal(tracker.has('s1', 'm1'), true);
  assert.equal(tracker.hasPending('s1'), true);
  assert.equal(tracker.apply('s1', { type: 'system', subtype: 'task_notification', task_id: 'm1', status: 'completed' }), true);
  assert.deepEqual(tracker.activeTasks('s1'), []);
  assert.equal(tracker.hasPending('s1'), false);
});

test('Bash backgroundTaskId links completion notices when task_started is missing', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', ownCall('bash', 'Bash', { run_in_background: true }));
  tracker.apply('s1', toolResult('bash', { backgroundTaskId: 'b1' }));
  tracker.apply('s1', { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' });
  assert.deepEqual(tracker.activeTasks('s1'), []);
  assert.equal(tracker.hasPending('s1'), false);
});

test('successful CronDelete removes only the matching cron, and a failed deletion removes none', () => {
  const tracker = createBackgroundWorkTracker();
  for (const id of ['cron1', 'cron2']) {
    tracker.apply('s1', ownCall(id, 'CronCreate'));
    tracker.apply('s1', toolResult(id, { id: `${id}-job`, recurring: true }));
  }
  tracker.apply('s1', ownCall('delete1', 'CronDelete'));
  tracker.apply('s1', toolResult('delete1', { id: 'cron1-job' }, true));
  assert.equal(tracker.activeTasks('s1').length, 2);
  assert.equal(tracker.apply('s1', toolResult('delete1', { id: 'cron1-job' })), true);
  assert.deepEqual(tracker.activeTasks('s1').map((task) => task.id), ['cron2']);
  assert.equal(tracker.hasPending('s1'), true);
});

test('completed tool results and errors retire provisional cards without task events', () => {
  const tracker = createBackgroundWorkTracker();
  for (const [name, output, isError] of [
    ['Agent', { status: 'completed', agentId: 'a1' }, false],
    ['Bash', { status: 'failed' }, false],
    ['Workflow', {}, true],
  ] as const) {
    tracker.apply('s1', ownCall('call', name, { run_in_background: true }));
    assert.equal(tracker.hasPending('s1'), true);
    assert.equal(tracker.apply('s1', toolResult('call', output, isError)), true);
    assert.deepEqual(tracker.activeTasks('s1'), []);
    assert.equal(tracker.hasPending('s1'), false);
    tracker.clear('s1');
  }
});

test('duplicate assistant blocks do not resurrect settled calls or reset their start time', () => {
  const tracker = createBackgroundWorkTracker();
  const call = ownCall('toolu_t1', 'Agent');
  tracker.apply('s1', call);
  const first = tracker.activeTasks('s1')[0];
  assert.equal(tracker.apply('s1', call), false);
  assert.equal(tracker.activeTasks('s1')[0], first);
  tracker.apply('s1', started('t1'));
  tracker.apply('s1', notified('t1', 'completed'));
  tracker.apply('s1', call);
  tracker.apply('s1', started('t1'));
  assert.deepEqual(tracker.activeTasks('s1'), []);
  assert.equal(tracker.hasPending('s1'), false);
});

test('a task started before its own tool block is reclassified as main-thread work', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', started('t1'));
  tracker.apply('s1', ownCall('toolu_t1', 'Agent'));
  assert.equal(tracker.list()[0].tasks[0].nested, undefined);
  assert.equal(tracker.activeTasks('s1').length, 1);
});

test('malformed and nested results do not expire or clear unrelated calls', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', ownCall('wake', 'ScheduleWakeup'));
  for (const value of [null, '123', NaN, Infinity, -1]) {
    tracker.apply('s1', toolResult('wake', { scheduledFor: value }));
    assert.equal(tracker.nextWakeupAt('s1'), undefined);
  }
  tracker.apply('s1', { ...toolResult('wake', { status: 'completed' }), parent_tool_use_id: 'other' });
  tracker.apply('s1', { type: 'system', subtype: 'task_notification', task_id: 'unrelated', status: 'completed' });
  tracker.apply('s1', null);
  tracker.apply('s1', { type: 'assistant', message: { content: [null, 1, 'x'] } });
  tracker.apply('s1', { type: 'user', message: { content: [{ type: 'tool_result' }] } });
  assert.deepEqual(tracker.activeTasks('s1').map((task) => task.id), ['wake']);
  assert.deepEqual(tracker.activeTasks('missing'), []);
});

test('only a main-thread task that finishes on its own asks for a follow-up reply', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', ownCall('toolu_own', 'Agent'));
  tracker.apply('s1', started('own'));
  tracker.apply('s1', started('child', { tool_use_id: 'toolu_inside_agent' }));
  assert.equal(tracker.settlesMainThreadWork('s1', notified('own', 'completed')), true);
  assert.equal(tracker.settlesMainThreadWork('s1', updated('own', { status: 'failed' })), true);
  assert.equal(tracker.settlesMainThreadWork('s1', notified('own', 'stopped')), false, 'a stop gets no reply turn');
  assert.equal(tracker.settlesMainThreadWork('s1', notified('child', 'completed')), false, 'nested work reports to its agent');
  assert.equal(tracker.settlesMainThreadWork('s1', {
    type: 'system', subtype: 'task_notification', task_id: 'housekeeping', status: 'completed',
  }), false, 'untracked CLI tasks have no reply in this transcript');
  assert.equal(tracker.settlesMainThreadWork('s1', started('own')), false);
});

test('work with no completion event lapses at the end of the turn after the one that launched it', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', ownCall('cron', 'CronCreate'));
  tracker.apply('s1', toolResult('cron', { id: 'job', recurring: false }));
  tracker.apply('s1', ownCall('wake', 'ScheduleWakeup'));
  tracker.apply('s1', toolResult('wake', { clampedDelaySeconds: 60 }));
  tracker.apply('s1', ownCall('timed', 'ScheduleWakeup'));
  tracker.apply('s1', toolResult('timed', { scheduledFor: Date.now() + 60_000 }));
  tracker.apply('s1', ownCall('toolu_agent', 'Agent'));
  assert.equal(tracker.endTurn('s1'), false, 'the launching turn keeps everything');
  assert.deepEqual(tracker.activeTasks('s1').map((task) => task.id), ['cron', 'timed', 'toolu_agent']);
  assert.equal(tracker.endTurn('s1'), true);
  // The timed wakeup replaced the untimed one; it and the agent have their own endings.
  assert.deepEqual(tracker.activeTasks('s1').map((task) => task.id), ['timed', 'toolu_agent']);
  assert.equal(tracker.endTurn('missing'), false);
});

test('an untimed wakeup alone lapses after the turn it triggers', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', ownCall('wake', 'ScheduleWakeup'));
  tracker.apply('s1', toolResult('wake', {}));
  tracker.endTurn('s1');
  assert.equal(tracker.hasPending('s1'), true);
  assert.equal(tracker.endTurn('s1'), true);
  assert.equal(tracker.hasPending('s1'), false);
});

test('a foreground Bash the CLI moves to the background after its timeout gets a card', () => {
  // Seen live: a `find ~` that ran past Bash's 120s timeout was backgrounded
  // by the CLI with only a `task_started`. Without a card the strip listed no
  // task while the session still read as pending, so the page drew the
  // background phase as a reply in flight until the command died.
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', ownCall('toolu_find', 'Bash', { command: 'find ~ -name auth.db' }));
  assert.deepEqual(tracker.activeTasks('s1'), [], 'a foreground Bash launches nothing yet');

  assert.equal(tracker.apply('s1', started('find', {
    tool_use_id: 'toolu_find', task_type: 'local_bash', description: 'find ~ -name auth.db',
  })), true, 'the new card must be broadcast');
  const [card] = tracker.activeTasks('s1');
  assert.equal(card.id, 'toolu_find');
  assert.equal(card.taskId, 'find');
  assert.equal(card.toolName, 'Bash');
  assert.equal(card.command, 'find ~ -name auth.db');
  assert.equal(card.startedAt, tracker.list()[0].tasks[0].startedAt);
  assert.equal(tracker.settlesMainThreadWork('s1', notified('find', 'completed')), true,
    'the CLI reports on the finished command in a reply turn');

  tracker.apply('s1', notified('find', 'completed'));
  assert.deepEqual(tracker.activeTasks('s1'), []);
  assert.equal(tracker.hasPending('s1'), false);
});

test('a task started before its own non-background call still gets a card once the call is seen', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', started('late', { task_type: 'local_bash', description: 'sleep 999' }));
  assert.deepEqual(tracker.activeTasks('s1'), [], 'without its call the task may be an agent\'s');
  assert.equal(tracker.apply('s1', ownCall('toolu_late', 'Bash', { command: 'sleep 999' })), true);
  assert.deepEqual(tracker.activeTasks('s1').map((card) => [card.id, card.taskId, card.toolName]), [['toolu_late', 'late', 'Bash']]);
});

test('a task started inside an agent stays off the strip and asks for no reply', () => {
  const tracker = createBackgroundWorkTracker();
  tracker.apply('s1', started('child', { tool_use_id: 'toolu_inside_agent', task_type: 'local_bash' }));
  assert.deepEqual(tracker.activeTasks('s1'), []);
  assert.equal(tracker.settlesMainThreadWork('s1', notified('child', 'completed')), false);
});
