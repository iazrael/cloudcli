import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenCodeApiError } from '@/modules/providers/list/opencode/opencode-api.client.js';
import { OpenCodeRunRegistry, OpenCodeTokenBudgetTracker } from '@/modules/providers/list/opencode/opencode-run-registry.js';
import type { NormalizedMessage } from '@/shared/types.js';

const writerOf = () => {
  const frames: NormalizedMessage[] = [];
  return { frames, writer: { send: (data: unknown) => { frames.push(data as NormalizedMessage); } } };
};

/** Polls until `predicate` holds; deadline re-checks are fire-and-forget. */
const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not met before the timeout');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
};

/**
 * Registers one backgrounded shell the way the service announces it: the call
 * the model made, then its success still saying `running` with the shell id.
 */
const startBackgroundShell = (
  registry: OpenCodeRunRegistry,
  { shellId = 'sh_1', callId = 'call_shell' } = {},
) => {
  registry.dispatch({
    type: 'session.tool.called',
    data: { sessionID: 'ses_parent', id: callId, name: 'shell', input: { command: 'sleep 600' } },
  });
  registry.dispatch({
    type: 'session.tool.success',
    data: { sessionID: 'ses_parent', id: callId, content: [], metadata: { shellID: shellId, status: 'running' } },
  });
};

/**
 * Registers one background child the way the service announces it: the child's
 * own creation, the parent's launch acknowledgement, and a first child frame
 * (which is what flushes the queued link and records the background task).
 */
const startBackgroundChild = (
  registry: OpenCodeRunRegistry,
  { childId = 'ses_child', callId = 'call_subagent', title = 'Audit the repo' } = {},
) => {
  registry.dispatch({
    type: 'session.created',
    data: { sessionID: childId, parentID: 'ses_parent', agent: 'general', title },
  });
  registry.dispatch({
    type: 'session.tool.progress',
    data: { sessionID: 'ses_parent', id: callId, metadata: { sessionID: childId, status: 'running' } },
  });
  registry.dispatch({
    type: 'session.text.delta',
    data: { sessionID: childId, assistantMessageID: 'm_child', ordinal: 0, delta: 'working' },
  });
};

test('dispatch routes events by provider session and settles on the first terminal only', async () => {
  const registry = new OpenCodeRunRegistry();
  const first = writerOf();
  const second = writerOf();
  const runA = registry.create('app-a', 'ses_a', first.writer);
  registry.create('app-b', 'ses_b', second.writer);

  registry.dispatch({ type: 'session.text.delta', data: { sessionID: 'ses_a', assistantMessageID: 'm', ordinal: 0, delta: 'hi' } });
  registry.dispatch({ type: 'session.text.delta', data: { sessionID: 'ses_unknown', assistantMessageID: 'm', ordinal: 0, delta: 'x' } });
  assert.equal(first.frames.length, 1);
  assert.equal(second.frames.length, 0);

  const outcome = { outcome: 'succeeded' as const };
  runA.settle(outcome);
  runA.settle({ outcome: 'failed', error: 'late' });
  registry.dispatch({ type: 'session.execution.failed', data: { sessionID: 'ses_a', error: { message: 'late event' } } });
  assert.deepEqual(await runA.settled, outcome, 'first settlement wins over later terminals');
});

test('child session frames ride the parent run and are stamped with the spawn call id', async () => {
  const registry = new OpenCodeRunRegistry();
  const { frames, writer } = writerOf();
  const run = registry.create('app-parent', 'ses_parent', writer);

  registry.dispatch({
    type: 'session.tool.input.started',
    data: { sessionID: 'ses_parent', id: 'call_subagent', name: 'subagent' },
  });
  registry.dispatch({
    type: 'session.tool.called',
    data: {
      sessionID: 'ses_parent',
      id: 'call_subagent',
      input: { agent: 'general', description: 'Inspect it' },
    },
  });
  registry.dispatch({
    type: 'session.created',
    data: {
      sessionID: 'ses_child',
      parentID: 'ses_parent',
      agent: 'general',
      title: 'Inspect it',
    },
  });

  frames.length = 0;
  registry.dispatch({
    type: 'session.text.delta',
    data: { sessionID: 'ses_child', assistantMessageID: 'm_child', ordinal: 0, delta: 'child says hi' },
  });

  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.sessionId, 'app-parent');
  assert.equal(frames[0]?.parentToolUseId, 'call_subagent');
  assert.equal(frames[0]?.content, 'child says hi');

  // The child's own terminal ends the child, not the parent turn.
  registry.dispatch({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } });
  assert.equal(await Promise.race([run.settled, Promise.resolve('still-open')]), 'still-open');
  registry.dispatch({ type: 'session.execution.succeeded', data: { sessionID: 'ses_parent' } });
  assert.deepEqual(await run.settled, { outcome: 'succeeded' });
});

test('a running child session is background work for the composer until it settles', async () => {
  const registry = new OpenCodeRunRegistry();
  const { frames, writer } = writerOf();
  registry.create('app-parent', 'ses_parent', writer);

  registry.dispatch({
    type: 'session.tool.input.started',
    data: { sessionID: 'ses_parent', id: 'call_subagent', name: 'subagent' },
  });
  registry.dispatch({
    type: 'session.tool.called',
    data: { sessionID: 'ses_parent', id: 'call_subagent', input: { agent: 'general', description: 'Audit the repo' } },
  });
  registry.dispatch({
    type: 'session.created',
    data: { sessionID: 'ses_child', parentID: 'ses_parent', agent: 'general', title: 'Audit the repo' },
  });

  assert.equal(registry.isBackgroundWorkPending('app-parent'), true);
  assert.deepEqual(registry.listBackgroundWork(), [{
    sessionId: 'app-parent',
    tasks: [{
      taskId: 'ses_child',
      toolUseId: 'call_subagent',
      taskType: 'local_agent',
      description: 'Audit the repo',
      startedAt: registry.backgroundTasksFor('app-parent')[0]?.startedAt,
    }],
  }]);
  assert.equal(registry.backgroundTasksFor('app-parent')[0]?.toolName, 'subagent');
  assert.equal(
    registry.backgroundTasksFor('app-parent')[0]?.id,
    'call_subagent',
    'the strip addresses the spawn call: that is the transcript anchor and the id a per-task stop matches',
  );
  const announced = frames.filter((frame) => frame.kind === 'status' && frame.text === 'background_tasks');
  assert.equal(announced.length, 1, 'the composer learns about the background work live');
  assert.equal(announced[0]?.backgroundTasks?.length, 1);
  assert.equal(announced[0]?.backgroundTasks?.[0]?.id, 'call_subagent');
  assert.equal(announced[0]?.backgroundTasks?.[0]?.taskId, 'ses_child');
  assert.equal(announced[0]?.backgroundWorkPending, true);

  let cleared = false;
  void registry.whenBackgroundWorkClears('app-parent').then(() => { cleared = true; });
  frames.length = 0;
  registry.dispatch({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } });
  await Promise.resolve();

  assert.equal(cleared, true);
  assert.equal(registry.isBackgroundWorkPending('app-parent'), false);
  assert.deepEqual(registry.listBackgroundWork(), []);
  const settled = frames.filter((frame) => frame.kind === 'status' && frame.text === 'background_tasks');
  assert.equal(settled.length, 1, 'the pill clears as soon as the child settles');
  assert.deepEqual(settled[0]?.backgroundTasks, []);
  assert.equal(settled[0]?.backgroundWorkPending, false);
  const cardSettle = frames.filter((frame) => frame.kind === 'task_status');
  assert.equal(cardSettle.length, 1, 'the card is settled by the terminal, not by the next reload');
  assert.equal(cardSettle[0]?.status, 'completed');
  assert.equal(cardSettle[0]?.toolUseId, 'call_subagent');

  // The child's own terminal must not settle the parent turn.
  const parent = registry.get('app-parent');
  assert.ok(parent);
  assert.equal(await Promise.race([parent.settled, Promise.resolve('still-open')]), 'still-open');
});

test('background frames use the session publisher when one is supplied', () => {
  const registry = new OpenCodeRunRegistry();
  const { frames, writer } = writerOf();
  registry.create('app-parent', 'ses_parent', writer);
  const published: NormalizedMessage[] = [];
  registry.setSessionPublisher('app-parent', (message) => published.push(message));

  startBackgroundChild(registry, { title: 'Audit the repo' });

  assert.ok(
    published.some((frame) => frame.kind === 'status' && frame.text === 'background_tasks'
      && frame.backgroundTasks?.[0]?.toolName === 'subagent'),
    'the strip goes down the session channel so a tab opened later sees it',
  );
  assert.equal(
    frames.some((frame) => frame.kind === 'status' && frame.text === 'background_tasks'),
    false,
    'the run writer is not used for session-level status frames',
  );

  registry.dispatch({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } });
  assert.ok(
    published.some((frame) => frame.kind === 'status' && frame.text === 'background_tasks'
      && (frame.backgroundTasks?.length ?? 0) === 0),
    'the channel also hears that the work ended',
  );
});

test('the background hold times out so a lost child terminal cannot pin the run', async () => {
  const registry = new OpenCodeRunRegistry();
  const { frames, writer } = writerOf();
  registry.create('app-parent', 'ses_parent', writer);
  // The launch call is identified by the parent's progress event, which also
  // flushes the queued `session.created` and records the background task.
  startBackgroundChild(registry, { title: 'Lost child' });
  assert.equal(registry.isBackgroundWorkPending('app-parent'), true);

  // No reader is wired here, so the deadline cannot judge the child and drops
  // it — the backstop for a terminal (and a service) that is simply gone.
  await registry.whenBackgroundWorkClears('app-parent', 10);
  assert.equal(registry.isBackgroundWorkPending('app-parent'), false);

  const announced = frames.filter((frame) => frame.kind === 'status' && frame.text === 'background_tasks');
  assert.equal(announced.at(-1)?.backgroundWorkPending, false, 'the composer is told the work is gone');
  assert.deepEqual(announced.at(-1)?.backgroundTasks, []);
});

test('a deadline verdict from the child\'s own row settles it with the engine outcome', async () => {
  const registry = new OpenCodeRunRegistry({
    readChildSnapshot: async () => ({ outcome: 'succeeded', idleAt: Date.now() + 1_000, tokens: null }),
  });
  const { frames, writer } = writerOf();
  registry.create('app-parent', 'ses_parent', writer);
  startBackgroundChild(registry);
  frames.length = 0;

  await registry.whenBackgroundWorkClears('app-parent', 10);

  assert.equal(registry.isBackgroundWorkPending('app-parent'), false);
  const settled = frames.filter((frame) => frame.kind === 'task_status');
  assert.equal(settled.length, 1, 'the card is settled without waiting for a history refresh');
  assert.equal(settled[0]?.status, 'completed');
  assert.equal(settled[0]?.toolUseId, 'call_subagent');
  assert.equal(settled[0]?.taskId, 'ses_child');
});

test('a child the engine still reports mid-turn survives its deadline and settles on a later verdict', async () => {
  // The session row keeps its previous idle stamp while the child is woken
  // again and works, so a verdict older than the launch means "still running".
  let idleAt: number | null = Date.now() - 60_000;
  const registry = new OpenCodeRunRegistry({
    readChildSnapshot: async () => ({ outcome: 'succeeded', idleAt, tokens: null }),
  });
  const { frames, writer } = writerOf();
  registry.create('app-parent', 'ses_parent', writer);
  startBackgroundChild(registry);

  const cleared = registry.whenBackgroundWorkClears('app-parent', 10);
  let resolved = false;
  void cleared.then(() => { resolved = true; });
  await new Promise((resolve) => { setTimeout(resolve, 40); });

  assert.equal(resolved, false, 'a mid-turn child is not dropped at the deadline');
  assert.equal(registry.isBackgroundWorkPending('app-parent'), true);

  frames.length = 0;
  idleAt = Date.now();
  await Promise.race([cleared, new Promise((resolve) => { setTimeout(resolve, 1_000); })]);

  assert.equal(resolved, true);
  assert.equal(registry.isBackgroundWorkPending('app-parent'), false);
  assert.equal(frames.filter((frame) => frame.kind === 'task_status').length, 1);
});

test('the hold cap drops a child the engine keeps reporting mid-turn', async () => {
  const registry = new OpenCodeRunRegistry({
    readChildSnapshot: async () => ({ outcome: 'succeeded', idleAt: Date.now() - 60_000, tokens: null }),
    maxBackgroundHoldMs: 1,
  });
  const { frames, writer } = writerOf();
  registry.create('app-parent', 'ses_parent', writer);
  startBackgroundChild(registry);
  frames.length = 0;

  await registry.whenBackgroundWorkClears('app-parent', 10);

  assert.equal(registry.isBackgroundWorkPending('app-parent'), false, 'the cap is the last backstop');
  assert.equal(frames.filter((frame) => frame.kind === 'task_status').length, 0, 'nothing knew how it ended');
  const announced = frames.filter((frame) => frame.kind === 'status' && frame.text === 'background_tasks');
  assert.deepEqual(announced.at(-1)?.backgroundTasks, []);
});

test('a child event that arrives before its launch call is held, then delivered in order', async () => {
  const registry = new OpenCodeRunRegistry();
  const { frames, writer } = writerOf();
  registry.create('app-parent', 'ses_parent', writer);

  // The session link is known from `session.created`, but its description did
  // not match the launch (no `called` event was seen), so the tool call id is
  // still unknown. The frame must not leak untagged to the top level.
  registry.dispatch({
    type: 'session.created',
    data: { sessionID: 'ses_child', parentID: 'ses_parent', agent: 'general', title: 'Renamed child' },
  });
  registry.dispatch({
    type: 'session.text.delta',
    data: { sessionID: 'ses_child', assistantMessageID: 'm_child', ordinal: 0, delta: 'early' },
  });
  assert.equal(frames.length, 0);

  registry.dispatch({
    type: 'session.tool.progress',
    data: {
      sessionID: 'ses_parent',
      id: 'call_subagent',
      metadata: { sessionID: 'ses_child', status: 'running' },
    },
  });
  registry.dispatch({
    type: 'session.text.delta',
    data: { sessionID: 'ses_child', assistantMessageID: 'm_child', ordinal: 0, delta: ' late' },
  });

  assert.deepEqual(
    frames
      .filter((frame) => frame.parentToolUseId)
      .map((frame) => [frame.content, frame.parentToolUseId]),
    [['early', 'call_subagent'], [' late', 'call_subagent']],
  );
});

test('dispatch fails a compact run on a failed compaction, and leaves a chat run alone', async () => {
  const registry = new OpenCodeRunRegistry();
  const compactWriter = writerOf();
  const compactRun = registry.create('app-compact', 'ses_1', compactWriter.writer, 'compact');
  const chatWriter = writerOf();
  const chatRun = registry.create('app-chat', 'ses_2', chatWriter.writer);

  const failedEvent = {
    type: 'session.compaction.failed',
    data: {
      sessionID: 'ses_1',
      reason: 'manual',
      inputID: 'msg_1',
      error: { type: 'provider.no-route', message: 'Model unavailable: opencode/gpt-5.6-terra' },
    },
  };
  registry.dispatch(failedEvent);
  assert.deepEqual(await compactRun.settled, {
    outcome: 'failed',
    error: 'Model unavailable: opencode/gpt-5.6-terra',
  });
  assert.equal(compactWriter.frames.length, 0, 'the runtime renders the failure, not the registry');

  // The same event for an ordinary turn (the engine compacted its own
  // context) must not fail the user's run — it ends on its execution
  // terminal like any other.
  registry.dispatch({ ...failedEvent, data: { ...failedEvent.data, sessionID: 'ses_2' } });
  assert.equal(await Promise.race([chatRun.settled, Promise.resolve('still-open')]), 'still-open');
  registry.dispatch({ type: 'session.execution.succeeded', data: { sessionID: 'ses_2' } });
  assert.deepEqual(await chatRun.settled, { outcome: 'succeeded' });
});

test('reconcile settles a run whose session went idle after the prompt', async () => {
  const registry = new OpenCodeRunRegistry();
  const { writer } = writerOf();
  const run = registry.create('app-1', 'ses_1', writer);
  run.promptAccepted = true;
  run.startedAt = 1_000;

  await registry.reconcile({ getSession: async () => ({ outcome: 'succeeded', idleAt: 1_500, tokens: null }) });
  assert.deepEqual(await run.settled, { outcome: 'succeeded' });
});

test('reconcile maps outcome and ignores a session that went idle before the prompt', async () => {
  const registry = new OpenCodeRunRegistry();
  const { writer } = writerOf();
  const stale = registry.create('app-1', 'ses_stale', writer);
  stale.promptAccepted = true;
  stale.startedAt = 5_000;
  const fresh = writerOf();
  const interrupted = registry.create('app-2', 'ses_int', fresh.writer);
  interrupted.promptAccepted = true;
  interrupted.startedAt = 1_000;
  const failedRunWriter = writerOf();
  const failed = registry.create('app-3', 'ses_failed', failedRunWriter.writer);
  failed.promptAccepted = true;
  failed.startedAt = 1_000;

  const snapshots: Record<string, { outcome: string | null; idleAt: number | null; tokens: null }> = {
    ses_stale: { outcome: 'succeeded', idleAt: 2_000, tokens: null },
    ses_int: { outcome: 'interrupted', idleAt: 2_000, tokens: null },
    ses_failed: { outcome: 'failed', idleAt: 2_000, tokens: null },
  };
  await registry.reconcile({ getSession: async (id) => snapshots[id] });
  assert.equal(
    await Promise.race([stale.settled, Promise.resolve('still-open')]),
    'still-open',
    'an idle BEFORE the prompt is the previous run: keep waiting',
  );
  assert.deepEqual(await interrupted.settled, { outcome: 'interrupted', reason: 'reconciled after a stream drop' });
  assert.deepEqual(await failed.settled, { outcome: 'failed', error: 'The run failed while the event stream was disconnected.' });
});

test('reconcile: 404 loses the run, other errors keep it open, unaccepted prompts are skipped', async () => {
  const registry = new OpenCodeRunRegistry();
  const gone = writerOf();
  const lost = registry.create('app-1', 'ses_gone', gone.writer);
  lost.promptAccepted = true;
  const flaky = writerOf();
  const waiting = registry.create('app-2', 'ses_flaky', flaky.writer);
  waiting.promptAccepted = true;
  const early = writerOf();
  const notAccepted = registry.create('app-3', 'ses_early', early.writer);
  notAccepted.promptAccepted = false;

  let calls = 0;
  await registry.reconcile({
    getSession: async (id) => {
      calls += 1;
      if (id === 'ses_gone') {
        throw new OpenCodeApiError('GET', '/api/session/ses_gone', 404, { message: 'not found' });
      }
      throw new OpenCodeApiError('GET', '/api/session/x', 500, { message: 'boom' });
    },
  });
  assert.equal(calls, 2, 'both accepted runs are probed; the unaccepted one is skipped');
  assert.deepEqual(await lost.settled, { outcome: 'lost', error: 'The OpenCode session no longer exists.' });
  assert.equal(await Promise.race([waiting.settled, Promise.resolve('still-open')]), 'still-open', 'a 500 keeps the run open for the next reconnect');
  assert.equal(notAccepted.promptAccepted, false);
});

test('dispatch publishes a budget frame from a step.ended event when a tracker is registered', () => {
  const registry = new OpenCodeRunRegistry();
  const { frames, writer } = writerOf();
  const run = registry.create('app-a', 'ses_a', writer);
  run.budgetTracker = new OpenCodeTokenBudgetTracker(null, null);

  registry.dispatch({
    type: 'session.step.ended',
    data: {
      sessionID: 'ses_a',
      tokens: { input: 2798, output: 509, reasoning: 711, cache: { read: 488192, write: 0 } },
    },
  });

  const budgetFrames = frames.filter((frame) => frame.kind === 'status' && frame.text === 'token_budget');
  assert.equal(budgetFrames.length, 1);
  assert.deepEqual(budgetFrames[0]?.tokenBudget, {
    used: 492210,
    inputTokens: 490990,
    outputTokens: 1220,
    breakdown: { input: 490990, output: 1220 },
  });
});

test('dispatch drops step tokens when no tracker is registered, and throttles repeats', () => {
  const registry = new OpenCodeRunRegistry();
  const { frames, writer } = writerOf();
  const run = registry.create('app-a', 'ses_a', writer);
  const stepEvent = {
    type: 'session.step.ended',
    data: { sessionID: 'ses_a', tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } },
  };

  // No tracker: nothing is emitted from step events.
  registry.dispatch(stepEvent);
  assert.equal(frames.length, 0);

  run.budgetTracker = new OpenCodeTokenBudgetTracker(null, null);
  registry.dispatch(stepEvent);
  registry.dispatch(stepEvent);
  const budgetFrames = frames.filter((frame) => frame.kind === 'status' && frame.text === 'token_budget');
  assert.equal(budgetFrames.length, 1, 'an unchanged value inside the interval must not repaint');
});

test('concurrent runs each publish occupancy through their own tracker', () => {
  const registry = new OpenCodeRunRegistry();
  const first = writerOf();
  const second = writerOf();
  const runA = registry.create('app-a', 'ses_a', first.writer);
  const runB = registry.create('app-b', 'ses_b', second.writer);
  runA.budgetTracker = new OpenCodeTokenBudgetTracker(null, null);
  // A run started later must not take over the earlier run's publisher.
  runB.budgetTracker = new OpenCodeTokenBudgetTracker(null, null);
  const tokens = { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } };

  registry.dispatch({ type: 'session.step.ended', data: { sessionID: 'ses_a', tokens } });
  registry.dispatch({ type: 'session.step.ended', data: { sessionID: 'ses_b', tokens } });

  const budgetsOf = (frames: typeof first.frames) => frames.filter((frame) => frame.text === 'token_budget');
  assert.equal(budgetsOf(first.frames).length, 1);
  assert.equal(budgetsOf(second.frames).length, 1, "B's equal reading is not throttled by A's");
  assert.equal(budgetsOf(first.frames)[0]?.sessionId, 'app-a');
});

test('the service exiting clears the composer strip live, not only on the next reload', () => {
  const registry = new OpenCodeRunRegistry();
  const { frames, writer } = writerOf();
  registry.create('app-parent', 'ses_parent', writer);
  startBackgroundChild(registry);
  frames.length = 0;

  registry.settleAll({ outcome: 'lost', error: 'The OpenCode service exited.' });

  assert.equal(registry.isBackgroundWorkPending('app-parent'), false);
  const announced = frames.filter((frame) => frame.kind === 'status' && frame.text === 'background_tasks');
  assert.equal(announced.length, 1);
  assert.deepEqual(announced[0]?.backgroundTasks, []);
  assert.equal(announced[0]?.backgroundWorkPending, false);
});

test('reconcile retires a background child whose terminal fell in the stream gap', async () => {
  const registry = new OpenCodeRunRegistry();
  const { frames, writer } = writerOf();
  registry.create('app-parent', 'ses_parent', writer);
  startBackgroundChild(registry, { childId: 'ses_done', callId: 'call_done' });
  startBackgroundChild(registry, { childId: 'ses_busy', callId: 'call_busy' });
  startBackgroundChild(registry, { childId: 'ses_unreadable', callId: 'call_unreadable' });
  frames.length = 0;

  await registry.reconcile({
    getSession: async (id) => {
      if (id === 'ses_done') return { outcome: 'failed', idleAt: Date.now() + 1_000, tokens: null };
      if (id === 'ses_busy') return { outcome: null, idleAt: null, tokens: null };
      throw new Error('unreadable');
    },
  });

  assert.deepEqual(
    registry.backgroundTasksFor('app-parent').map((task) => task.id).sort(),
    ['call_busy', 'call_unreadable'],
    'only the child the engine reports idle is retired; a failed read proves nothing',
  );
  const settled = frames.filter((frame) => frame.kind === 'task_status');
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.toolUseId, 'call_done');
  assert.equal(settled[0]?.status, 'failed');
  const announced = frames.filter((frame) => frame.kind === 'status' && frame.text === 'background_tasks');
  assert.equal(announced.at(-1)?.backgroundTasks?.length, 2);
});

test('a background shell is listed with its stop handle and its checkout', () => {
  const registry = new OpenCodeRunRegistry();
  const { writer } = writerOf();
  registry.create('app-shell', 'ses_parent', writer, 'chat', '/tmp/project');
  startBackgroundShell(registry);

  const [task] = registry.backgroundTasksFor('app-shell');
  assert.equal(task?.id, 'call_shell', 'the card is anchored by the launching call');
  assert.equal(task?.taskId, 'sh_1', 'the engine handle is what a stop sends');
  assert.deepEqual(registry.backgroundStopRoute('app-shell', 'sh_1'), {
    kind: 'shell',
    directory: '/tmp/project',
  });
  assert.equal(registry.backgroundStopRoute('another-app', 'sh_1'), null, 'a handle belongs to its launcher only');
  registry.settleBackgroundTask('app-shell', 'sh_1', 'stopped');
});

test('stopping a shell drops it at once and tells the card how it ended', () => {
  const registry = new OpenCodeRunRegistry();
  const { frames, writer } = writerOf();
  registry.create('app-shell', 'ses_parent', writer, 'chat', '/tmp/project');
  startBackgroundShell(registry);
  frames.length = 0;

  registry.settleBackgroundTask('app-shell', 'sh_1', 'stopped');

  assert.equal(registry.isBackgroundWorkPending('app-shell'), false);
  assert.equal(registry.backgroundTasksFor('app-shell').length, 0);
  const settled = frames.filter((frame) => frame.kind === 'task_status');
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.status, 'stopped');
  assert.equal(settled[0]?.taskId, 'sh_1');
  const announced = frames.filter((frame) => frame.kind === 'status' && frame.text === 'background_tasks');
  assert.equal(announced.at(-1)?.backgroundTasks?.length, 0);
});

test('a shell job the engine reports finished is retired at the deadline', async () => {
  const registry = new OpenCodeRunRegistry({
    backgroundWorkTimeoutMs: 5,
    readShellSnapshot: async () => ({ status: 'completed', exitCode: 0 }),
  });
  const { frames, writer } = writerOf();
  registry.create('app-shell', 'ses_parent', writer, 'chat', '/tmp/project');
  startBackgroundShell(registry);
  frames.length = 0;

  await waitFor(() => registry.backgroundTasksFor('app-shell').length === 0);

  const settled = frames.filter((frame) => frame.kind === 'task_status');
  assert.equal(settled.at(-1)?.status, 'completed');
  assert.equal(settled.at(-1)?.taskId, 'sh_1');
  const announced = frames.filter((frame) => frame.kind === 'status' && frame.text === 'background_tasks');
  assert.equal(announced.at(-1)?.backgroundTasks?.length, 0);
});

test('a shell job the engine keeps reporting running is dropped at the hold cap', async () => {
  const registry = new OpenCodeRunRegistry({
    backgroundWorkTimeoutMs: 5,
    maxBackgroundHoldMs: 0,
    readShellSnapshot: async () => ({ status: 'running', exitCode: null }),
  });
  const { frames, writer } = writerOf();
  registry.create('app-shell', 'ses_parent', writer, 'chat', '/tmp/project');
  startBackgroundShell(registry);
  frames.length = 0;

  await waitFor(() => registry.backgroundTasksFor('app-shell').length === 0);

  assert.equal(registry.isBackgroundWorkPending('app-shell'), false);
  const announced = frames.filter((frame) => frame.kind === 'status' && frame.text === 'background_tasks');
  assert.equal(announced.at(-1)?.backgroundTasks?.length, 0);
});

test('a shell the service no longer holds is retired as stopped', async () => {
  const registry = new OpenCodeRunRegistry({
    backgroundWorkTimeoutMs: 5,
    readShellSnapshot: async () => {
      throw new OpenCodeApiError('GET', '/api/shell/sh_1', 404, 'not found');
    },
  });
  const { frames, writer } = writerOf();
  registry.create('app-shell', 'ses_parent', writer, 'chat', '/tmp/project');
  startBackgroundShell(registry);
  frames.length = 0;

  await waitFor(() => registry.backgroundTasksFor('app-shell').length === 0);

  const settled = frames.filter((frame) => frame.kind === 'task_status');
  assert.equal(settled.at(-1)?.status, 'stopped');
});
