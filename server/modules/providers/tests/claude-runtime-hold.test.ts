import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  claudeRuntime,
  closeClaudeResidentSessions,
  getClaudeSDKSessionStartTime,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

const SESSION_ID = 'app-hold-session';

// The tests before the "resident process" section describe the hold for
// background work on its own, so they run with the idle residency off: a turn
// with nothing outstanding lets its process go at `result`, as it did before
// residency. That section turns residency on test by test.
process.env.CLOUDCLI_CLAUDE_RESIDENT_IDLE_MS = '0';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  drain: () => Promise<void>;
  interrupt: () => Promise<void>;
  /** Every user message the CLI read from its stdin, in order. */
  prompts: Array<Record<string, unknown>>;
  /** `setModel` / `setPermissionMode` / `applyFlagSettings` calls, as `[method, value]`. */
  switches: Array<[string, unknown]>;
  /** Makes those calls reject, as a CLI that refuses the switch does. */
  rejectSwitches: boolean;
  /** Makes the stream throw, as a CLI that dies does. */
  fail: (error: Error) => void;
  /** The description of every `generateSessionTitle` call, in order. */
  titleRequests: string[];
  /** What `generateSessionTitle` answers: a title, null, or an error to reject with. */
  titleReply: string | null | Error;
  /** Makes `generateSessionTitle` throw before returning a promise. */
  throwTitleSynchronously: boolean;
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  const drained = new Set<() => void>();
  const stopped: string[] = [];
  const prompts: Array<Record<string, unknown>> = [];
  const switches: Array<[string, unknown]> = [];
  let failure: Error | null = null;

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    stopped,
    prompts,
    switches,
    rejectSwitches: false,
    fail: (error) => { failure = error; wake?.(); },
    titleRequests: [],
    titleReply: null,
    throwTitleSynchronously: false,
    interrupt: async () => {},
    drain: () => {
      if (wake && queue.length === 0) return new Promise((resolve) => setImmediate(resolve));
      return new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timeout); drained.delete(finish); setImmediate(resolve); };
        const timeout = setTimeout(() => {
          drained.delete(finish);
          reject(new Error('Scripted query did not finish processing its queued messages'));
        }, 5_000);
        drained.add(finish);
      });
    },
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const message of prompt) { prompts.push(message as Record<string, unknown>); }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (failure) throw failure;
        if (queue.length === 0) {
          for (const finish of drained) finish();
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          for (const finish of drained) finish();
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: () => script.interrupt(),
      stopTask: async (taskId: string) => { stopped.push(taskId); },
      setModel: async (model?: string) => {
        if (script.rejectSwitches) throw new Error('switch refused');
        switches.push(['setModel', model]);
      },
      setPermissionMode: async (mode: string) => {
        if (script.rejectSwitches) throw new Error('switch refused');
        switches.push(['setPermissionMode', mode]);
      },
      applyFlagSettings: async (settings: Record<string, unknown>) => {
        if (script.rejectSwitches) throw new Error('switch refused');
        switches.push(['applyFlagSettings', settings]);
      },
      generateSessionTitle: (description: string, options?: { persist?: boolean }) => {
        if (script.throwTitleSynchronously) throw new Error('query closed');
        return generateTitle(description, options);
      },
    });
    async function generateTitle(description: string, options?: { persist?: boolean }) {
      assert.equal(options?.persist, true, 'the title must be written to the transcript');
      script.titleRequests.push(description);
      if (script.titleReply instanceof Error) throw script.titleReply;
      return script.titleReply;
    }
  };

  return { createQuery, script };
}

type NextTurn = (command: string, options?: Record<string, unknown>) => { sent: NormalizedMessage[]; done: Promise<unknown> };

async function withRun(
  runTest: (context: {
    script: Scripted;
    sent: NormalizedMessage[];
    done: Promise<unknown>;
    /** Sends the session's next turn through the same runtime, on a writer of its own. */
    nextTurn: NextTurn;
    /** One scripted CLI process per `createQuery` call, the first being `script`. */
    processes: Scripted[];
    queryOptions: Array<Parameters<NonNullable<ProviderRuntimeContext['createQuery']>>[0]['options']>;
    cwd: string;
    /** The session's transcript, as the runtime resolves it. */
    transcriptPath: string;
  }) => Promise<void>,
  /** Options every turn of the run carries, as a caller passes them each time. */
  baseOptions: Record<string, unknown> = {},
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const transcriptPath = path.join(cwd, 'transcript.jsonl');
  const first = createScriptedQuery();
  const script = first.script;
  const processes: Scripted[] = [];
  const queryOptions: Array<Parameters<NonNullable<ProviderRuntimeContext['createQuery']>>[0]['options']> = [];
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = (args) => {
    queryOptions.push(args.options);
    const scripted = processes.length === 0 ? first : createScriptedQuery();
    processes.push(scripted.script);
    return scripted.createQuery(args);
  };
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    resolveTranscriptPath: () => transcriptPath,
    createQuery,
  };
  const turns: Array<Promise<unknown>> = [];
  const nextTurn: NextTurn = (command, options = {}) => {
    const turnSent: NormalizedMessage[] = [];
    const turnWriter = { send: (message: NormalizedMessage) => { turnSent.push(message); }, userId: null };
    const turnDone = queryClaudeSDK(command, { sessionId: SESSION_ID, cwd, ...baseOptions, ...options }, turnWriter as never, context);
    turns.push(turnDone.catch((error: unknown) => {
      if ((error as { code?: string }).code !== 'PROVIDER_INPUT_DEFERRED') throw error;
    }));
    return { sent: turnSent, done: turnDone };
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd, ...baseOptions }, writer as never, context);
    try {
      await runTest({ script, sent, done, nextTurn, processes, queryOptions, cwd, transcriptPath });
    } finally {
      for (const scripted of processes.length ? processes : [script]) scripted.end();
      await done;
      await Promise.all(turns);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test('SDK environment enables Artifact by default and respects an explicit host setting', { concurrency: false }, async () => {
  const previous = process.env.CLAUDE_CODE_ARTIFACT;
  const previousOther = process.env.CLOUDCLI_TEST_ENV;
  process.env.CLOUDCLI_TEST_ENV = 'forwarded';
  try {
    for (const configured of [undefined, '0']) {
      if (configured === undefined) delete process.env.CLAUDE_CODE_ARTIFACT;
      else process.env.CLAUDE_CODE_ARTIFACT = configured;
      await withRun(async ({ script, queryOptions }) => {
        await script.drain();
        assert.equal(queryOptions[0]?.env?.CLAUDE_CODE_ARTIFACT, configured ?? '1');
        assert.equal(queryOptions[0]?.env?.CLOUDCLI_TEST_ENV, 'forwarded');
      });
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ARTIFACT;
    else process.env.CLAUDE_CODE_ARTIFACT = previous;
    if (previousOther === undefined) delete process.env.CLOUDCLI_TEST_ENV;
    else process.env.CLOUDCLI_TEST_ENV = previousOther;
  }
});

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

// A fixed settle can be too short on a loaded machine; the supersede tests
// wait for the run to have actually processed its turn instead.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });

for (const toolName of ['Agent', 'Bash', 'Workflow']) {
  test(`${toolName} completion removes only its card while another task keeps running`, async () => {
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(toolUse('toolu_done', toolName, { run_in_background: true }));
      script.emit(taskStarted('done', 'toolu_done', 'local_agent'));
      script.emit(toolUse('toolu_running', 'Agent', { run_in_background: true }));
      script.emit(taskStarted('running', 'toolu_running', 'local_agent'));
      script.emit(result());
      await script.drain();

      script.emit(taskNotification('done', 'toolu_done', 'completed'));
      await script.drain();

      const statuses = sent.filter((message) => message.kind === 'status' && message.text === 'background_tasks');
      assert.deepEqual(statuses.at(-1)?.backgroundTasks?.map((task) => task.id), ['toolu_running']);
      assert.equal(script.released(), false, 'the other task must keep running');
    });
  });
}

for (const status of ['completed', 'failed', 'killed', 'stopped']) {
  test(`a ${status} task patch clears the card even without a tool-use id`, async () => {
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(toolUse('toolu_patch', 'Agent', { run_in_background: true }));
      script.emit(taskStarted('patched', 'toolu_patch', 'local_agent'));
      script.emit(result());
      await script.drain();
      script.emit({ type: 'system', subtype: 'task_updated', task_id: 'patched', patch: { status } });
      await script.drain();
      assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks, []);
    });
  });
}

test('a completion without tool_use_id resolves the card through task_started', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(result());
    await script.drain();
    script.emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' });
    await script.drain();
    assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks, []);
    assert.equal(script.released(), false, 'the follow-up reply must not be cut short');
    assert.equal(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundWorkPending, true);
    assert.ok(listClaudeSDKBackgroundWork().some((entry) => entry.sessionId === SESSION_ID), 'off-screen queue must wait for the reply too');
    script.emit(result());
    await script.drain();
    assert.equal(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundWorkPending, false);
  });
});

test('a new foreground-only run clears cards after explicit cancellation', async () => {
  await withRun(async ({ script: oldScript, done: oldDone }) => {
    oldScript.emit(init());
    oldScript.emit(toolUse('toolu_old', 'Agent', { run_in_background: true }));
    oldScript.emit(taskStarted('old', 'toolu_old', 'local_agent'));
    oldScript.emit(result());
    await oldScript.drain();
    await abortClaudeSDKSession(SESSION_ID);
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(result());
      await script.drain();
      assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks, []);
      oldScript.end();
      await oldDone;
    });
  });
});

test('a rejected background call disappears without hiding a running sibling', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_running', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('running', 'toolu_running', 'local_agent'));
    script.emit(toolUse('toolu_rejected', 'ScheduleWakeup', { delaySeconds: 60 }));
    const rejected = ack('toolu_rejected', 'Permission denied', {});
    rejected.message.content[0] = { ...rejected.message.content[0], is_error: true } as never;
    script.emit(rejected);
    script.emit(result());
    await script.drain();
    assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.map((task) => task.id), ['toolu_running']);
  });
});

test('wakeups expire at the acknowledged time while future wakeups and agents stay active', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_running', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('running', 'toolu_running', 'local_agent'));
    script.emit(toolUse('toolu_expired', 'ScheduleWakeup', { delaySeconds: 1 }));
    script.emit(ack('toolu_expired', 'Scheduled', { scheduledFor: Date.now() - 1 }));
    script.emit(toolUse('toolu_future', 'ScheduleWakeup', { delaySeconds: 1200 }));
    script.emit(ack('toolu_future', 'Scheduled', { scheduledFor: Date.now() + 120_000 }));
    script.emit(result());
    await script.drain();
    assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.map((task) => task.id), ['toolu_running', 'toolu_future']);
    script.emit(taskNotification('running', 'toolu_running', 'completed'));
    script.emit(result());
    await script.drain();
    assert.equal(script.released(), false, 'the pending wakeup still needs the CLI alive');
  });
});

test('nested background calls do not create unlinked parent cards', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_parent', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('parent', 'toolu_parent', 'local_agent'));
    script.emit({ ...toolUse('toolu_child', 'Bash', { run_in_background: true }), parent_tool_use_id: 'toolu_parent' });
    script.emit(taskStarted('child', 'toolu_child', 'local_bash'));
    script.emit(result());
    await script.drain();
    assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.map((task) => task.id), ['toolu_parent']);
  });
});

test('an acknowledged wakeup expires even while the SDK stream is silent', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_timer', 'ScheduleWakeup', { delaySeconds: 60 }));
    script.emit(ack('toolu_timer', 'Scheduled', { scheduledFor: Date.now() + 300 }));
    script.emit(result());
    await script.drain();
    assert.equal(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.length, 1);
    const timeout = Date.now() + 1500;
    while (sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.length && Date.now() < timeout) {
      await script.drain();
    }
    assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks, []);
    assert.equal(script.released(), false, 'deadline expiry must not terminate the wakeup reply');
  });
});

test('superseded streams cannot clear or resurrect the new run\'s task cards', async () => {
  await withRun(async ({ script: oldScript, sent: oldSent, done: oldDone }) => {
    oldScript.emit(init());
    oldScript.emit(toolUse('toolu_old', 'Agent', { run_in_background: true }));
    oldScript.emit(taskStarted('old', 'toolu_old', 'local_agent'));
    oldScript.emit(result());
    await oldScript.drain();
    await abortClaudeSDKSession(SESSION_ID);
    const oldCount = oldSent.length;
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(toolUse('toolu_new', 'Agent', { run_in_background: true }));
      script.emit(taskStarted('new', 'toolu_new', 'local_agent'));
      script.emit(result());
      await script.drain();
      oldScript.emit(toolUse('toolu_late', 'Bash', { run_in_background: true }));
      oldScript.end();
      await oldDone;
      assert.equal(oldSent.length, oldCount, 'the old writer emits no late status or cleanup frame');
      assert.deepEqual(listClaudeSDKBackgroundWork().flatMap((entry) => entry.tasks.map((task) => task.taskId)), ['new']);
      assert.deepEqual(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundTasks?.map((task) => task.id), ['toolu_new']);
    });
  });
});

test('TaskCreate does not hold a finished turn open or block the composer', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_todo', 'TaskCreate', { subject: 'Plan work' }));
    script.emit(ack('toolu_todo', 'Created task', { task: { id: '1', subject: 'Plan work' } }));
    script.emit(result());
    await script.drain();
    assert.equal(script.released(), true);
    assert.equal(sent.some((message) => message.text === 'background_tasks' && message.backgroundTasks?.length), false);
  });
});

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await script.drain();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await script.drain();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    void done;
  });
});

for (const completedWork of ['Agent', 'ScheduleWakeup']) {
  test(`stopping a sibling must not cut short an already pending ${completedWork} reply`, async () => {
    await withRun(async ({ script }) => {
      script.emit(init());
      for (const id of ['a', 'b']) {
        const tool = id === 'a' ? completedWork : 'Agent';
        script.emit(toolUse(`toolu_${id}`, tool, { run_in_background: true }));
        if (tool === 'Agent') script.emit(taskStarted(id, `toolu_${id}`, 'local_agent'));
      }
      script.emit(result());
      if (completedWork === 'Agent') script.emit(taskNotification('a', 'toolu_a', 'completed'));
      else script.emit(ack('toolu_a', 'Scheduled', { scheduledFor: Date.now() - 1 }));
      script.emit(taskNotification('b', 'toolu_b', 'stopped'));
      await script.drain();
      assert.equal(script.released(), false, 'A still needs its follow-up reply');
      script.emit(result());
      await script.drain();
      assert.equal(script.released(), true);
    });
  });
}

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await script.drain();

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await script.drain();
    assert.equal(script.released(), false);

    script.emit(result());
    await script.drain();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    await script.drain();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
  });
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await script.drain();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});

const lastStatus = (sent: NormalizedMessage[]) => sent.filter((message) => message.text === 'background_tasks').at(-1);

test('a late duplicate abort and the old stream cleanup cannot remove a newer run', async () => {
  await withRun(async ({ script: oldScript, done: oldDone }) => {
    oldScript.emit(init());
    oldScript.emit(toolUse('toolu_old', 'Agent', { run_in_background: true }));
    oldScript.emit(taskStarted('old', 'toolu_old', 'local_agent'));
    oldScript.emit(result());
    await oldScript.drain();
    let releaseInterrupt!: () => void;
    const delayedInterrupt = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
    let interrupts = 0;
    oldScript.interrupt = () => ++interrupts === 1 ? Promise.resolve() : delayedInterrupt;
    const firstAbort = abortClaudeSDKSession(SESSION_ID);
    const lateAbort = abortClaudeSDKSession(SESSION_ID);
    assert.equal(await firstAbort, true);
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(toolUse('toolu_new', 'Agent', { run_in_background: true }));
      script.emit(taskStarted('new', 'toolu_new', 'local_agent'));
      script.emit(result());
      await script.drain();
      assert.ok(sent.some((message) => message.kind === 'complete'), 'an old abort flag must not suppress the new turn complete');
      releaseInterrupt();
      assert.equal(await lateAbort, true);
      assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['new']]);
      oldScript.end();
      await oldDone;
      assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['new']]);
      assert.equal(await stopClaudeSDKTask(SESSION_ID, 'new'), true, 'the new run must retain its stop handle');
    });
  });
});

test('late messages from an aborted old stream cannot settle a new run cron', async () => {
  await withRun(async ({ script: oldScript, done: oldDone }) => {
    oldScript.emit(init());
    oldScript.emit(result());
    await oldScript.drain();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await withRun(async ({ script }) => {
      script.emit(init());
      script.emit(toolUse('toolu_cron', 'CronCreate', { cron: '* * * * *', prompt: 'ping' }));
      script.emit(ack('toolu_cron', 'created', { id: 'cron-new' }));
      script.emit(result());
      await script.drain();
      assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.sessionId), [SESSION_ID]);
      oldScript.emit(result());
      oldScript.end();
      await oldDone;
      assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.sessionId), [SESSION_ID]);
      assert.equal(script.released(), false, 'the new cron still needs its held process');
    });
  });
});

test('a rejected SDK interrupt leaves its tasks stoppable and allows the turn to report completion', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    await script.drain();
    script.interrupt = async () => { throw new Error('interrupt rejected'); };
    assert.equal(await abortClaudeSDKSession(SESSION_ID), false);
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'a1'), true);
    script.emit(result());
    await script.drain();
    assert.ok(sent.some((message) => message.kind === 'complete'), 'a failed cancel must not suppress completion');
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['a1']]);
  });
});

test('aborting a held background reply releases stdin and broadcasts the cleared queue gate', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(result());
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    await script.drain();
    assert.equal(lastStatus(sent)?.backgroundWorkPending, true);
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    script.end();
    await done;
    assert.equal(script.released(), true);
    assert.deepEqual(lastStatus(sent)?.backgroundTasks, []);
    assert.equal(lastStatus(sent)?.backgroundWorkPending, false);
  });
});

test('a nested task finishing does not keep the process waiting after its parent is stopped', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_parent', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('parent', 'toolu_parent', 'local_agent'));
    script.emit(result());
    await script.drain();
    script.emit(taskStarted('child', 'toolu_child', 'local_bash'));
    script.emit(taskNotification('child', 'toolu_child', 'completed'));
    script.emit(taskNotification('parent', 'toolu_parent', 'stopped'));
    await script.drain();
    assert.equal(script.released(), true);
    assert.equal(lastStatus(sent)?.backgroundWorkPending, false);
  });
});

test('an untracked CLI task finishing does not keep the process waiting', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_a', 'Agent', { run_in_background: true }));
    script.emit(taskStarted('a', 'toolu_a', 'local_agent'));
    script.emit(result());
    await script.drain();
    script.emit({ type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: 'housekeeping', status: 'completed' });
    script.emit(taskNotification('a', 'toolu_a', 'stopped'));
    await script.drain();
    assert.equal(script.released(), true);
    assert.equal(lastStatus(sent)?.backgroundWorkPending, false);
  });
});

for (const [toolName, input, output] of [
  ['CronCreate', { cron: '* * * * *', prompt: 'ping', recurring: false }, { id: 'job1', recurring: false }],
  ['CronCreate', { cron: '* * * * *', prompt: 'ping', recurring: true }, { id: 'job1', recurring: true }],
  ['ScheduleWakeup', { delaySeconds: 60 }, {}],
] as const) {
  test(`${toolName} ${JSON.stringify(output)} lets go after the turn it triggers`, async () => {
    await withRun(async ({ script, sent }) => {
      script.emit(init());
      script.emit(toolUse('toolu_x', toolName, input));
      script.emit(ack('toolu_x', 'ok', output));
      script.emit(result());
      await script.drain();
      assert.equal(script.released(), false, 'the launching turn holds for it');
      script.emit(result());
      await script.drain();
      assert.equal(script.released(), true);
      assert.deepEqual(lastStatus(sent)?.backgroundTasks, []);
      assert.equal(lastStatus(sent)?.backgroundWorkPending, false);
    });
  });
}

// Measured against claude CLI via the agent SDK: `interrupt()` mid-turn ends
// the turn at once with a `result` of subtype `error_during_execution`, and a
// background Bash launched earlier in that turn keeps running — it reports
// `task_notification completed` later and the CLI relays it in a turn of its
// own. Only closing stdin would kill it, which is what Esc in the CLI never does.
const interruptedResult = () => ({ type: 'result', subtype: 'error_during_execution', session_id: NATIVE_ID, duration_ms: 1, num_turns: 1 });

test('stopping a reply stops only the turn; background work it launched keeps running and reports back', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_bg', 'Bash', { command: 'sleep 25', run_in_background: true }));
    script.emit(taskStarted('b1', 'toolu_bg', 'local_bash'));
    script.emit(ack('toolu_bg', 'Running in background with ID: b1', { backgroundTaskId: 'b1' }));
    await script.drain();

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    script.emit(interruptedResult());
    await script.drain();

    assert.equal(script.released(), false, 'the process stays up for the background Bash');
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['b1']]);
    assert.equal(sent.some((message) => message.kind === 'complete'), false, 'the abort path reports the stopped turn, not the runtime');
    assert.deepEqual(lastStatus(sent)?.backgroundTasks?.map((task) => task.taskId), ['b1'], 'the strip keeps the task and its stop handle');

    // The task finishes and the CLI relays it; that turn ends the hold.
    script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
    script.emit(result());
    await script.drain();
    assert.equal(script.released(), true);
    assert.equal(sent.some((message) => message.kind === 'complete'), false, 'the relay turn is not a second completion');
  });
});

test('stopping a reply with no background work still lets the process go', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_fg', 'Bash', { command: 'sleep 60' }));
    await script.drain();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    // The held prompt stream notices its release on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(script.released(), true);
  });
});

test('a second stop while the first is still waiting for its result changes nothing', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(toolUse('toolu_bg', 'Bash', { command: 'sleep 25', run_in_background: true }));
    script.emit(taskStarted('b1', 'toolu_bg', 'local_bash'));
    await script.drain();

    let interrupts = 0;
    script.interrupt = async () => {
      interrupts += 1;
      if (interrupts > 1) throw new Error('already interrupting');
    };
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.equal(interrupts, 1, 'the turn is interrupted once');

    script.emit(interruptedResult());
    await script.drain();
    assert.equal(sent.some((message) => message.kind === 'complete'), false, 'the stopped turn is not reported complete');
    assert.equal(script.released(), false);
  });
});

test('a stopped reply whose result never arrives still lets the process go', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_bg', 'Bash', { command: 'sleep 25', run_in_background: true }));
    script.emit(taskStarted('b1', 'toolu_bg', 'local_bash'));
    await script.drain();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    assert.equal(script.released(), false);

    t.mock.timers.tick(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(script.released(), true, 'a CLI that never ends the interrupted turn is not left running');
  });
});

// ---------------------------------------------------------------------------
// Turns continued on the held process
// ---------------------------------------------------------------------------
// Measured against claude CLI via the agent SDK (2026-10-19): one process
// takes message after message on its stdin, each becoming a turn of its own
// with its own `init` and `result`, and a background Bash started in the
// first turn survives the turns after it. A message written while a turn is
// still running is folded into that turn. `setModel` / `setPermissionMode`
// mid-process take effect from the next turn's `init`.

const assistantText = (text: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const promptText = (message: Record<string, unknown> | undefined) => JSON.stringify(message ?? {});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const completes = (messages: NormalizedMessage[]) => messages.filter((message) => message.kind === 'complete');
/** Waits (up to 2s) for the runtime's file reads and handover to reach `condition`. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Ends the first turn with a background Bash still running, so the process is held. */
async function holdForBackgroundBash(script: Scripted): Promise<void> {
  script.emit(init());
  script.emit(toolUse('toolu_bg', 'Bash', { command: 'npm run dev', run_in_background: true }));
  script.emit(taskStarted('b1', 'toolu_bg', 'local_bash'));
  script.emit(ack('toolu_bg', 'Running in background with ID: b1', { backgroundTaskId: 'b1' }));
  script.emit(result());
  await script.drain();
  assert.equal(script.released(), false, 'the process is held for the background Bash');
}

test('a turn sent while the process is held goes into that process, and the background work survives it', async () => {
  await withRun(async ({ script, sent, nextTurn, processes }) => {
    await holdForBackgroundBash(script);
    let acceptedAt = 0;
    const second = nextTurn('change direction', { onInputAccepted: () => { acceptedAt = script.prompts.length; } });
    await until(() => script.prompts.length >= 2);

    assert.equal(processes.length, 1, 'no second CLI process');
    assert.match(promptText(script.prompts[1]), /change direction/);
    assert.equal(acceptedAt, 2, 'acceptance follows SDK consumption of the input');

    script.emit(init());
    script.emit(assistantText('on it'));
    script.emit(result());
    await second.done;

    assert.equal(completes(second.sent).length, 1, 'the second turn completes on its own writer');
    assert.ok(second.sent.some((message) => message.kind === 'text' && message.content === 'on it'));
    assert.equal(completes(sent).length, 1, 'the first writer saw only its own turn complete');
    assert.equal(script.released(), false, 'still held for the background Bash');
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => entry.tasks.map((task) => task.taskId)), [['b1']]);
  });
});

test('every turn asks the engine to title the session from its prompt, since a resumed CLI never does', async () => {
  await withRun(async ({ script, sent }) => {
    script.emit(init());
    script.emit(result());
    await script.drain();
    assert.deepEqual(script.titleRequests, ['hello']);
    assert.equal(completes(sent).length, 1);
  });
});

test('a held process stops asking for a title once the engine has one', async () => {
  await withRun(async ({ script, nextTurn }) => {
    script.titleReply = 'Dev server work';
    await holdForBackgroundBash(script);
    const second = nextTurn('change direction');
    await until(() => script.prompts.length >= 2);
    script.emit(init());
    script.emit(result());
    await second.done;
    assert.deepEqual(script.titleRequests, ['hello'], 'the second turn does not ask again');
  });
});

test('a held process keeps asking while the engine has no title yet', async () => {
  await withRun(async ({ script, nextTurn }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('a real topic');
    await until(() => script.prompts.length >= 2);
    script.emit(init());
    script.emit(result());
    await second.done;
    assert.deepEqual(script.titleRequests, ['hello', 'a real topic']);
  });
});

const titledAs: Array<[string, string, string | null]> = [
  ['a known command is titled from its arguments', '/archify  生成一下 core 的整体架构图\n要中文', '生成一下 core 的整体架构图\n要中文'],
  ['arguments on the next line count too', '/archify\n生成架构图', '生成架构图'],
  ['a plugin command is titled from its arguments', '/vercel:deploy 上线预览环境', '上线预览环境'],
  ['leading whitespace does not hide a command', '  /compact ', null],
  ['a short path that is no command is kept as typed', '/tmp 里面的日志怎么清', '/tmp 里面的日志怎么清'],
  ['an absolute path is kept as typed', '/Users/me/docs/ 看看这里的文档', '/Users/me/docs/ 看看这里的文档'],
];

for (const [name, prompt, expected] of titledAs) {
  test(`session title: ${name}`, async () => {
    await withRun(async ({ script, nextTurn }) => {
      await holdForBackgroundBash(script);
      const second = nextTurn(prompt);
      await until(() => script.prompts.length >= 2);
      script.emit({ ...init(), slash_commands: ['archify', 'compact', 'vercel:deploy'] });
      script.emit(result());
      await second.done;
      assert.deepEqual(script.titleRequests, expected === null ? ['hello'] : ['hello', expected]);
    });
  });
}

test('a process that lists no commands keeps a slash prompt as typed, for the engine to judge', async () => {
  await withRun(async ({ script, nextTurn }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('/archify 生成架构图');
    await until(() => script.prompts.length >= 2);
    script.emit(init());
    script.emit(result());
    await second.done;
    assert.deepEqual(script.titleRequests, ['hello', '/archify 生成架构图']);
  });
});

test('a failed title request does not disturb the turn', async () => {
  await withRun(async ({ script, sent }) => {
    script.titleReply = new Error('Control request aborted');
    script.emit(init());
    script.emit(assistantText('done'));
    script.emit(result());
    await script.drain();
    assert.deepEqual(script.titleRequests, ['hello']);
    assert.equal(completes(sent).length, 1);
    assert.ok(sent.some((message) => message.kind === 'text' && message.content === 'done'));
  });
});

test('a held process asks again on the next turn after a failed title request', async () => {
  await withRun(async ({ script, nextTurn }) => {
    script.titleReply = new Error('Control request aborted');
    await holdForBackgroundBash(script);
    script.titleReply = 'Dev server work';
    const second = nextTurn('change direction');
    await until(() => script.prompts.length >= 2);
    script.emit(init());
    script.emit(result());
    await second.done;
    assert.deepEqual(script.titleRequests, ['hello', 'change direction']);
  });
});

test('a title request that throws synchronously does not disturb the turn', async () => {
  await withRun(async ({ script, sent }) => {
    script.throwTitleSynchronously = true;
    script.emit(init());
    script.emit(assistantText('done'));
    script.emit(result());
    await script.drain();
    assert.equal(completes(sent).length, 1);
    assert.ok(sent.some((message) => message.kind === 'text' && message.content === 'done'));
  });
});

test('a model or permission change switches the held process instead of replacing it', async () => {
  await withRun(async ({ script, nextTurn, processes }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('again', { model: 'haiku', permissionMode: 'acceptEdits' });
    await until(() => script.prompts.length >= 2);

    assert.equal(processes.length, 1);
    assert.deepEqual(script.switches, [['setModel', 'haiku'], ['setPermissionMode', 'acceptEdits']]);
    script.emit(init());
    script.emit(result());
    await second.done;
  });
});

for (const [label, options] of [
  ['another working directory', { cwd: '/tmp' }],
  ['an edited message', { resumeAnchorId: 'uuid-keep' }],
] as const) {
  test(`a turn with ${label} waits for background work before starting a new process`, async () => {
    await withRun(async ({ script, nextTurn, processes }) => {
      await holdForBackgroundBash(script);
      await assert.rejects(nextTurn('again', options).done, { code: 'PROVIDER_INPUT_DEFERRED' });
      assert.equal(script.released(), false);
      assert.deepEqual(script.stopped, []);
      script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
      script.emit(result());
      await script.drain();
      const second = nextTurn('again', options);
      await until(() => processes.length >= 2);

      assert.equal(processes.length, 2, 'a fresh CLI process');
      await until(() => script.released());
      assert.equal(script.released(), true, 'the held process is let go');
      processes[1].emit(init());
      processes[1].emit(result());
      // The stand-in CLI exits when told to, not when its stdin closes.
      processes[1].end();
      await second.done;
      assert.equal(completes(second.sent).length, 1);
    });
  });
}

test('a turn sent while the CLI relays a finished task waits for that relay to end', async () => {
  await withRun(async ({ script, sent, nextTurn }) => {
    await holdForBackgroundBash(script);
    script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
    script.emit(init());
    await script.drain();

    const second = nextTurn('next');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(script.prompts.length, 1, 'not written into the relay turn');

    script.emit(result());
    await script.drain();
    await until(() => script.prompts.length >= 2);
    assert.match(promptText(script.prompts[1]), /next/);
    assert.equal(completes(second.sent).length, 0, 'the relay turn ending is not the new turn ending');

    script.emit(init());
    script.emit(result());
    await second.done;
    assert.equal(completes(second.sent).length, 1);
    assert.equal(completes(sent).length, 1);
  });
});

test('a CLI that dies during a continued turn reports to that turn and ends it', async () => {
  await withRun(async ({ script, nextTurn }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('next');
    await until(() => script.prompts.length >= 2);

    script.fail(new Error('CLI crashed'));
    await second.done;
    assert.ok(second.sent.some((message) => message.kind === 'error' && String(message.content).includes('CLI crashed')));
    assert.equal(completes(second.sent).length, 1);
  });
});

test('stopping a continued reply stops only that turn while the background work runs', async () => {
  await withRun(async ({ script, nextTurn }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('next');
    await until(() => script.prompts.length >= 2);
    script.emit(init());
    await script.drain();

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    script.emit(interruptedResult());
    await second.done;
    await script.drain();
    assert.equal(script.released(), false, 'the background Bash keeps the process');
    assert.equal(completes(second.sent).length, 0, 'the abort path reports the stopped turn');
  });
});

test('the strip keeps Claude input queued until the held process accepts it', async () => {
  await withRun(async ({ script, sent }) => {
    await holdForBackgroundBash(script);
    const strip = lastStatus(sent);
    assert.equal(strip?.backgroundWorkQueuesInput, true, 'the queue waits for confirmed input acceptance');
  });
});

// Measured through a logging proxy in front of the API (2026-10-19): a
// process started with `--effort low` sends `output_config.effort: "low"`;
// `applyFlagSettings({ effortLevel })` mid-process changes the next request's
// effort (`high`, `max` both honoured); after `setModel('haiku')` the CLI
// drops `output_config` on its own; `effortLevel: null` falls back to what the
// process started with, which is the CLI default only when it started with
// no `--effort`.

test('another effort level is applied to the held process instead of replacing it', async () => {
  await withRun(async ({ script, nextTurn, processes }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('again', { model: 'opus', effort: 'low' });
    await until(() => script.prompts.length >= 2);
    assert.equal(processes.length, 1);
    assert.deepEqual(script.switches, [['setModel', 'opus'], ['applyFlagSettings', { effortLevel: 'low' }]]);
    script.emit(init());
    script.emit(result());
    await second.done;
  });
});

test('a model without effort tiers keeps the held process and leaves the effort to the CLI', async () => {
  await withRun(async ({ script, nextTurn, processes }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('again', { model: 'haiku', effort: 'high' });
    await until(() => script.prompts.length >= 2);
    assert.equal(processes.length, 1);
    assert.deepEqual(script.switches, [['setModel', 'haiku']]);
    script.emit(init());
    script.emit(result());
    await second.done;
  });
});

test('a model the catalog does not list keeps its effort, as an older session\'s opusplan does', async () => {
  await withRun(async ({ script, nextTurn, processes }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('again', { model: 'opusplan', effort: 'low' });
    await until(() => script.prompts.length >= 2);
    assert.equal(processes.length, 1);
    assert.deepEqual(script.switches, [['setModel', 'opusplan'], ['applyFlagSettings', { effortLevel: 'low' }]]);
    script.emit(init());
    script.emit(result());
    await second.done;
  });
});

test('entering plan mode keeps the held process', async () => {
  await withRun(async ({ script, nextTurn, processes }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('plan it', { permissionMode: 'plan' });
    await until(() => script.prompts.length >= 2);
    assert.equal(processes.length, 1, 'plan mode adds auto-allowed tools, but that is not a reason to restart');
    assert.deepEqual(script.switches, [['setPermissionMode', 'plan']]);
    script.emit(init());
    script.emit(result());
    await second.done;
  });
});

test('a refused settings switch defers input without stopping background work', async () => {
  await withRun(async ({ script, nextTurn, processes }) => {
    await holdForBackgroundBash(script);
    script.rejectSwitches = true;
    let accepted = false;
    const second = nextTurn('again', { model: 'haiku', onInputAccepted: () => { accepted = true; } });
    let settled = false;
    void second.done.then(() => { settled = true; }, () => { settled = true; });
    await until(() => processes.length > 1 || settled);
    assert.equal(processes.length, 1, 'a failed switch must not start another process');
    await assert.rejects(second.done, { code: 'PROVIDER_INPUT_DEFERRED' });
    assert.equal(accepted, false);
    assert.equal(processes.length, 1);
    assert.equal(script.released(), false);
    assert.deepEqual(script.stopped, []);
    assert.equal(script.prompts.length, 1);

    script.rejectSwitches = false;
    const retry = nextTurn('again', { model: 'haiku', onInputAccepted: () => { accepted = true; } });
    await until(() => script.prompts.length === 2);
    assert.equal(accepted, true);
    script.emit(init());
    script.emit(result());
    await retry.done;
  });
});

for (const options of [
  { toolsSettings: { allowedTools: ['Read'] } },
  { permissionMode: 'bypassPermissions' },
  { skipHeldProcess: true },
  { onBeforeInputAccepted: () => false },
]) {
  test(`an incompatible turn preserves background work: ${JSON.stringify(options)}`, async () => {
    await withRun(async ({ script, nextTurn, processes }) => {
      await holdForBackgroundBash(script);
      let accepted = false;
      const next = nextTurn('wait for the task', { ...options, onInputAccepted: () => { accepted = true; } });
      let settled = false;
      void next.done.then(() => { settled = true; }, () => { settled = true; });
      await until(() => processes.length > 1 || settled);
      assert.equal(processes.length, 1, 'an incompatible turn must not replace the live process');
      await assert.rejects(next.done, { code: 'PROVIDER_INPUT_DEFERRED' });
      assert.equal(accepted, false);
      assert.equal(processes.length, 1);
      assert.equal(script.released(), false);
      assert.deepEqual(script.stopped, []);
    });
  });
}

test('stopping a turn that still waits for the relay withdraws only that turn', async () => {
  await withRun(async ({ script, nextTurn }) => {
    await holdForBackgroundBash(script);
    script.emit(taskStarted('b2', 'toolu_bg2', 'local_bash'));
    script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
    script.emit(init());
    await script.drain();
    const second = nextTurn('next');
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await second.done;
    script.emit(result());
    await script.drain();
    await tick();
    assert.equal(script.prompts.length, 1, 'the withdrawn message never reaches the CLI');
    assert.equal(script.released(), false, 'the other background Bash keeps the process');
  });
});

test('a message sent right after stopping a reply joins the process once the interrupted turn ends', async () => {
  await withRun(async ({ script, nextTurn, processes }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('next');
    await until(() => script.prompts.length >= 2);
    script.emit(init());
    await script.drain();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    void second.done;

    // The page already shows the turn stopped, so the user sends again
    // before the CLI has ended the interrupted turn.
    const third = nextTurn('correction');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(processes.length, 1);
    assert.equal(script.prompts.length, 2, 'held back until the interrupted turn ends');
    script.emit(interruptedResult());
    await until(() => script.prompts.length >= 3);
    assert.match(promptText(script.prompts[2]), /correction/);
    script.emit(init());
    script.emit(result());
    await third.done;
    assert.equal(completes(third.sent).length, 1);
    assert.equal(script.released(), false);
  });
});

test('an earlier stop\'s fallback timer cannot release the process during a later stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withRun(async ({ script, nextTurn }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('next');
    for (let i = 0; i < 50 && script.prompts.length < 2; i += 1) { t.mock.timers.tick(10); await tick(); }
    script.emit(init());
    await script.drain();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    script.emit(interruptedResult());
    await script.drain();
    await second.done;

    const third = nextTurn('again');
    for (let i = 0; i < 50 && script.prompts.length < 3; i += 1) { t.mock.timers.tick(10); await tick(); }
    script.emit(init());
    await script.drain();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    void third.done;

    // The first stop's 30s timer comes due while the second (started at
    // least 10ms later) still waits for its result.
    t.mock.timers.tick(29_995);
    await tick();
    assert.equal(script.released(), false);
    script.emit(interruptedResult());
    await script.drain();
  });
});

test('stopping a message sent right after a stop withdraws it before the interrupted turn ends', async () => {
  await withRun(async ({ script, nextTurn }) => {
    await holdForBackgroundBash(script);
    const second = nextTurn('next');
    await until(() => script.prompts.length >= 2);
    script.emit(init());
    await script.drain();
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    void second.done;

    const third = nextTurn('sent by mistake');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await abortClaudeSDKSession(SESSION_ID), true);
    await third.done;

    script.emit(interruptedResult());
    await script.drain();
    await tick();
    assert.equal(script.prompts.length, 2, 'the withdrawn message never reaches the CLI');
    assert.equal(script.released(), false);
  });
});

// Measured against claude CLI (2026-10-19): `setPermissionMode('bypassPermissions')`
// throws "Cannot set permission mode to bypassPermissions because the session
// was not launched with --dangerously-skip-permissions".
test('turning on bypass permissions waits for background work before starting a new process', async () => {
  await withRun(async ({ script, nextTurn, processes }) => {
    await holdForBackgroundBash(script);
    const options = { toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true } };
    await assert.rejects(nextTurn('again', options).done, { code: 'PROVIDER_INPUT_DEFERRED' });
    assert.deepEqual(script.stopped, []);
    script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
    script.emit(result());
    await script.drain();
    const second = nextTurn('again', options);
    await until(() => processes.length >= 2);
    assert.equal(processes.length, 2);
    assert.deepEqual(script.switches, [], 'no switch is attempted on the held process');
    processes[1].emit(init());
    processes[1].emit(result());
    processes[1].end();
    await second.done;
  });
});

test('a held process outlasts two hours of silence minus a minute, and is let go after two', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withRun(async ({ script }) => {
    await holdForBackgroundBash(script);

    // A dev server left running prints nothing back to the CLI for long stretches.
    t.mock.timers.tick(119 * 60 * 1000);
    await tick();
    assert.equal(script.released(), false, 'still held after 1h59m of silence');

    t.mock.timers.tick(2 * 60 * 1000);
    await tick();
    assert.equal(script.released(), true, 'released once two silent hours have passed');
  });
});

// ---------------------------------------------------------------------------
// Resident process: kept between turns with nothing outstanding
// ---------------------------------------------------------------------------
// Measured against claude CLI via the agent SDK (2026-10-21,
// scripts/probe/claude-resident.probe.mjs): an idle process writes nothing to
// its transcript; it does not see a CLAUDE.md written while it was idle (a
// fresh process does); a terminal `claude -p --resume` of the same session
// appends its own user and assistant lines to the same file; the stream
// reports the uuid of every assistant line the process writes.

/** Turns idle residency on for one test. */
async function withResidency(settings: { idleMs: number; max?: number }, body: () => Promise<void>): Promise<void> {
  const saved = { idle: process.env.CLOUDCLI_CLAUDE_RESIDENT_IDLE_MS, max: process.env.CLOUDCLI_CLAUDE_RESIDENT_MAX };
  process.env.CLOUDCLI_CLAUDE_RESIDENT_IDLE_MS = String(settings.idleMs);
  if (settings.max === undefined) delete process.env.CLOUDCLI_CLAUDE_RESIDENT_MAX;
  else process.env.CLOUDCLI_CLAUDE_RESIDENT_MAX = String(settings.max);
  try {
    await body();
  } finally {
    for (const [name, value] of [['CLOUDCLI_CLAUDE_RESIDENT_IDLE_MS', saved.idle], ['CLOUDCLI_CLAUDE_RESIDENT_MAX', saved.max]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The chat gateway asks for residency on every turn it sends. */
const RESIDENT = { residentBetweenTurns: true };
const withResidentRun: typeof withRun = (runTest, baseOptions = {}) => withRun(runTest, { ...RESIDENT, ...baseOptions });

const TEN_MINUTES = 10 * 60 * 1000;
const appendLines = async (file: string, entries: Array<Record<string, unknown>>) => {
  await appendFile(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
};
/** Ends a plain turn and waits until the process has settled into idle residency. */
async function endTurnIdle(script: Scripted, done?: Promise<unknown>): Promise<void> {
  script.emit(init());
  script.emit(assistantText('ok'));
  script.emit(result());
  await script.drain();
  await done;
}

test('resident: a turn with nothing outstanding keeps its process for the next turn', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script, sent, done, nextTurn, processes }) => {
      await endTurnIdle(script, done);
      assert.equal(completes(sent).length, 1, 'the turn reported complete');
      assert.equal(script.released(), false, 'the process stays for the next turn');
      assert.deepEqual(listClaudeSDKBackgroundWork(), [], 'an idle process is no background work');
      assert.equal(sent.filter((message) => message.text === 'background_tasks').at(-1)?.backgroundWorkPending ?? false, false);

      const second = nextTurn('again');
      await until(() => script.prompts.length >= 2);
      assert.equal(processes.length, 1, 'no second CLI process');
      assert.match(promptText(script.prompts[1]), /again/);
      script.emit(init());
      script.emit(assistantText('again ok'));
      script.emit(result());
      await second.done;
      assert.ok(second.sent.some((message) => message.kind === 'text' && message.content === 'again ok'));
      assert.equal(completes(second.sent).length, 1);
    });
  });
});

test('resident: the call that started the process returns when its turn ends', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script, done }) => {
      let returned = false;
      void done.then(() => { returned = true; });
      script.emit(init());
      script.emit(result());
      await until(() => returned);
      assert.equal(returned, true, 'the gateway is not kept waiting for the process to exit');
      assert.equal(script.released(), false);
    });
  });
});

test('resident: an idle process is let go once the idle time has passed', async () => {
  await withResidency({ idleMs: 30 }, async () => {
    await withResidentRun(async ({ script }) => {
      await endTurnIdle(script);
      await until(() => script.released());
      assert.equal(script.released(), true);
    });
  });
});

test('resident: residency off lets the process go at result', async () => {
  await withResidency({ idleMs: 0 }, async () => {
    await withResidentRun(async ({ script }) => {
      await endTurnIdle(script);
      assert.equal(script.released(), true);
    });
  });
});

test('resident: background work that reports back leaves the process idle, not gone', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script }) => {
      await holdForBackgroundBash(script);
      script.emit(taskNotification('b1', 'toolu_bg', 'completed'));
      script.emit(init());
      script.emit(assistantText('the dev server exited'));
      script.emit(result());
      await script.drain();
      assert.equal(script.released(), false, 'kept for the next turn');
      assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    });
  });
});

test('resident: an idle process does not mark unreported agents as running', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script }) => {
      script.emit(init());
      await script.drain();
      assert.notEqual(getClaudeSDKSessionStartTime(SESSION_ID), null, 'a turn in flight has a live run');
      script.emit(result());
      await script.drain();
      assert.equal(getClaudeSDKSessionStartTime(SESSION_ID), null, 'an idle process can report nothing more');
    });
  });
});

test('resident: a CLAUDE.md written while idle sends the next turn to a fresh process', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script, done, nextTurn, processes, cwd }) => {
      await endTurnIdle(script, done);
      await writeFile(path.join(cwd, 'CLAUDE.md'), 'Always answer in French.\n');
      const second = nextTurn('again');
      await until(() => processes.length >= 2);
      assert.equal(processes.length, 2, 'the idle process cannot see the new instructions');
      await until(() => script.released());
      assert.equal(script.released(), true, 'the stale process is let go');
      processes[1].emit(init());
      processes[1].emit(result());
      processes[1].end();
      await second.done;
    });
  });
});

for (const [name, entry] of [
  ['a user line written by another process', { type: 'user', uuid: 'terminal-user', message: { role: 'user', content: 'hi' } }],
  ['an assistant line written by another process', { type: 'assistant', uuid: 'terminal-assistant', message: { role: 'assistant', content: [] } }],
  ['a continued-in record', { type: 'continued-in', continuedInSessionId: 'background-copy' }],
] as const) {
  test(`resident: ${name} sends the next turn to a fresh process`, async () => {
    await withResidency({ idleMs: TEN_MINUTES }, async () => {
      await withResidentRun(async ({ script, done, nextTurn, processes, transcriptPath }) => {
        await writeFile(transcriptPath, `${JSON.stringify({ type: 'user', uuid: 'first', message: { content: 'hello' } })}\n`);
        await endTurnIdle(script, done);
        await appendLines(transcriptPath, [entry]);
        const second = nextTurn('again');
        await until(() => processes.length >= 2);
        assert.equal(processes.length, 2);
        processes[1].emit(init());
        processes[1].emit(result());
        processes[1].end();
        await second.done;
      });
    });
  });
}

test('resident: the process\'s own lines and metadata written while idle do not count as another writer', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script, done, nextTurn, processes, transcriptPath }) => {
      await writeFile(transcriptPath, `${JSON.stringify({ type: 'user', uuid: 'first', message: { content: 'hello' } })}\n`);
      script.emit(init());
      script.emit({ ...assistantText('ok'), uuid: 'own-assistant' });
      script.emit(result());
      await script.drain();
      await done;
      // The CLI flushes the turn's last assistant line and its metadata late.
      await appendLines(transcriptPath, [
        { type: 'assistant', uuid: 'own-assistant', message: { role: 'assistant', content: [] } },
        { type: 'ai-title', aiTitle: 'Greeting' },
        { type: 'cost-state' },
      ]);
      const second = nextTurn('again');
      await until(() => script.prompts.length >= 2);
      assert.equal(processes.length, 1);
      script.emit(init());
      script.emit(result());
      await second.done;
    });
  });
});

test('resident: the oldest idle process is let go beyond the maximum, while one held for background work stays', async () => {
  await withResidency({ idleMs: TEN_MINUTES, max: 1 }, async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-resident-'));
    const scripts = new Map<string, Scripted>();
    const contextFor = (sessionId: string): ProviderRuntimeContext => {
      const scripted = createScriptedQuery();
      scripts.set(sessionId, scripted.script);
      const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
      return {
        resolveProviderSessionId: () => null,
        resolveResumeModel: async () => undefined,
        getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
        normalizeMessage: (raw, sid) => sessions.normalizeMessage(raw, sid),
        isProviderInstalled: async () => true,
        createQuery: scripted.createQuery,
      };
    };
    const writer = { send: () => {}, userId: null };
    const start = (sessionId: string) => queryClaudeSDK('hello', { sessionId, cwd, ...RESIDENT }, writer as never, contextFor(sessionId));
    try {
      const background = start('app-resident-bg');
      await holdForBackgroundBash(scripts.get('app-resident-bg')!);
      const first = start('app-resident-a');
      await endTurnIdle(scripts.get('app-resident-a')!, first);
      const second = start('app-resident-b');
      await endTurnIdle(scripts.get('app-resident-b')!, second);

      await until(() => scripts.get('app-resident-a')!.released());
      assert.equal(scripts.get('app-resident-a')!.released(), true, 'the oldest idle process is let go');
      assert.equal(scripts.get('app-resident-b')!.released(), false, 'the newest idle process stays');
      assert.equal(scripts.get('app-resident-bg')!.released(), false, 'background work is never evicted');
      void background;
    } finally {
      for (const scripted of scripts.values()) scripted.end();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test('resident: lifecycle — an idle process is no work, and releasing the session lets it go', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script }) => {
      script.emit(init());
      await script.drain();
      assert.equal(claudeRuntime.hasSessionWork(SESSION_ID), true, 'a turn in flight is work');
      script.emit(result());
      await script.drain();
      assert.equal(claudeRuntime.hasSessionWork(SESSION_ID), false, 'an idle process is not');
      claudeRuntime.releaseSession(SESSION_ID);
      await until(() => script.released());
      assert.equal(script.released(), true);
    });
  });
});

test('resident: lifecycle — background work counts as work', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script }) => {
      await holdForBackgroundBash(script);
      assert.equal(claudeRuntime.hasSessionWork(SESSION_ID), true);
    });
  });
});

test('resident: a closed admission refuses a new turn without starting a process', async () => {
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  let started = 0;
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    createQuery: () => { started += 1; throw new Error('must not start'); },
  };
  claudeRuntime.closeSessionAdmission('app-closed-session');
  try {
    await queryClaudeSDK('hello', { sessionId: 'app-closed-session', cwd: os.tmpdir() }, writer as never, context);
  } finally {
    claudeRuntime.openSessionAdmission('app-closed-session');
  }
  assert.equal(started, 0);
  assert.ok(sent.some((message) => message.kind === 'error'));
  assert.equal(completes(sent).length, 1);
});

test('resident: closing the resident sessions at shutdown lets every process go', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script }) => {
      await endTurnIdle(script);
      closeClaudeResidentSessions();
      await until(() => script.released());
      assert.equal(script.released(), true);
    });
  });
});

test('resident: a caller that does not ask for residency lets the process go at result', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    // One-shot callers (the agent API, commit-message generation) send a
    // single turn; a process kept for a next turn that never comes would
    // linger, and the agent API removes its working directory right after.
    await withRun(async ({ script }) => {
      await endTurnIdle(script);
      await until(() => script.released());
      assert.equal(script.released(), true);
    });
  });
});

test('resident: a CLAUDE.md change does not end a process held for background work', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script, nextTurn, processes, cwd }) => {
      await holdForBackgroundBash(script);
      await writeFile(path.join(cwd, 'CLAUDE.md'), 'Remember the dev server port.\n');
      const second = nextTurn('again');
      await until(() => script.prompts.length >= 2);
      assert.equal(processes.length, 1, 'the background dev server keeps running in the same process');
      script.emit(init());
      script.emit(result());
      await second.done;
    });
  });
});

test('resident: an idle process that dies is not reported as a failed run', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script, sent, done }) => {
      await endTurnIdle(script, done);
      const before = sent.length;
      script.fail(new Error('Claude Code process exited with code 137'));
      await until(() => !claudeRuntime.hasSessionWork(SESSION_ID) && getClaudeSDKSessionStartTime(SESSION_ID) === null);
      await tick();
      assert.deepEqual(sent.slice(before).filter((message) => message.kind === 'error' || message.kind === 'complete'), [],
        'the user left long ago; nothing failed on their side');
    });
  });
});

test('resident: a turn on the idle process counts its agents from that turn on', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script, done, nextTurn }) => {
      await endTurnIdle(script, done);
      const resumedAt = Date.now();
      const second = nextTurn('again');
      await until(() => script.prompts.length >= 2);
      script.emit(init());
      await script.drain();
      const startedAt = getClaudeSDKSessionStartTime(SESSION_ID);
      assert.ok(startedAt !== null && startedAt >= resumedAt, 'an agent launched in an earlier turn reads as stopped');
      script.emit(result());
      await second.done;
    });
  });
});

test('resident: editing a skill\'s SKILL.md while idle sends the next turn to a fresh process', async () => {
  await withResidency({ idleMs: TEN_MINUTES }, async () => {
    await withResidentRun(async ({ script, done, nextTurn, processes, cwd }) => {
      const skillFile = path.join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md');
      await mkdir(path.dirname(skillFile), { recursive: true });
      await writeFile(skillFile, 'Deploy with npm run deploy.\n');
      // The process starts on this turn, so it read the skill as written above.
      await endTurnIdle(script, done);
      // Only the file inside the skill's folder changes; the folders keep their times.
      await writeFile(skillFile, 'Deploy with pnpm run deploy.\n');
      const later = new Date(Date.now() + 5_000);
      await utimes(skillFile, later, later);
      const second = nextTurn('deploy again');
      await until(() => processes.length >= 2);
      assert.equal(processes.length, 2, 'the idle process still has the old skill');
      processes[1].emit(init());
      processes[1].emit(result());
      processes[1].end();
      await second.done;
    });
  });
});
