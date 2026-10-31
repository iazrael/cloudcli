/**
 * Host tasks on the Codex composer strip.
 *
 * A command a Codex chat hands to `cloudcli_task_run` runs in a host worker,
 * not in the engine. Its card shares the strip with the engine's agents, but
 * it is not engine background work: it must not hold the chat's input back,
 * it cannot be stopped through the session's abort, and it stops through the
 * host's own entry.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import {
  CODEX_BACKGROUND_TASK_TYPE,
  codexBackgroundWork,
  setCodexHostTaskSource,
} from '@/modules/providers/list/codex/codex-background-work.js';
import type { ActiveBackgroundTask } from '@/shared/types.js';

const hostTask: ActiveBackgroundTask = {
  id: 'task_host-1',
  taskId: 'task_host-1',
  toolName: 'Bash',
  command: 'sleep 120',
  description: 'long command',
  startedAt: 1_000,
};

test('a host task joins the strip without holding input or offering the session abort', async (t) => {
  const stopped: Array<[string, string]> = [];
  setCodexHostTaskSource({
    list: (sessionId) => (sessionId === 'host-session' ? [hostTask] : []),
    stop: async (sessionId, taskId) => {
      stopped.push([sessionId, taskId]);
      return sessionId === 'host-session' && taskId === hostTask.taskId;
    },
  });
  t.after(() => {
    setCodexHostTaskSource(null);
    codexBackgroundWork.clearSession('host-session');
  });

  assert.deepEqual(codexRuntime.backgroundTasks.list('host-session'), [hostTask]);
  // Only host tasks: the chat can take a message now, and there is no engine
  // run for the session's stop to cancel.
  assert.equal(codexRuntime.backgroundTasks.queuesInput('host-session'), false);
  assert.equal(codexRuntime.backgroundTasks.canInterrupt('host-session'), false);
  // The host task is not engine work: continuations and queued messages do
  // not wait for it.
  assert.equal(codexRuntime.listBackgroundWork().some((entry) => entry.sessionId === 'host-session'), false);

  // An engine agent next to it keeps the engine's own rules.
  codexBackgroundWork.start('host-session', {
    taskId: 'agent-thread-1',
    toolUseId: 'agent-call-1',
    taskType: CODEX_BACKGROUND_TASK_TYPE,
    description: 'explorer',
  });
  const merged = codexRuntime.backgroundTasks.list('host-session');
  assert.deepEqual(merged.map((task) => task.id), ['agent-call-1', hostTask.id]);
  assert.equal(codexRuntime.backgroundTasks.queuesInput('host-session'), true);
  assert.equal(codexRuntime.backgroundTasks.canInterrupt('host-session'), true);

  assert.equal(await codexRuntime.stopBackgroundTask('host-session', hostTask.taskId!), true);
  assert.equal(await codexRuntime.stopBackgroundTask('host-session', 'task_other'), false);
  assert.deepEqual(stopped, [['host-session', hostTask.taskId], ['host-session', 'task_other']]);
});

test('without a host task source the strip lists engine work only and nothing stops', async () => {
  setCodexHostTaskSource(null);
  assert.deepEqual(codexRuntime.backgroundTasks.list('quiet-session'), []);
  assert.equal(codexRuntime.backgroundTasks.queuesInput('quiet-session'), true);
  assert.equal(codexRuntime.backgroundTasks.canInterrupt('quiet-session'), true);
  assert.equal(await codexRuntime.stopBackgroundTask('quiet-session', 'task_any'), false);
});
