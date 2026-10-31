/**
 * The strip cards and the stop entry of host tasks.
 *
 * A card stands for a command a worker is running right now: a task that is
 * registered but not started, finished, failed to report, or whose worker
 * stopped beating draws none. Stopping asks the worker through the task's own
 * directory; the worker's `cancelled` result opens no report turn.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, taskContinuationDb, userDb } from '@/modules/database/index.js';

test('host task cards list only running tasks with a beating worker, and a stopped task opens no report', async (t) => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousTasksRoot = process.env.CLOUDCLI_TASKS_DIR;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-host-cards-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  process.env.CLOUDCLI_TASKS_DIR = path.join(temporaryDirectory, 'tasks');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  closeConnection();
  await initializeDatabase();
  userDb.createUser('host-card-user', 'hashed-password');
  sessionsDb.createSession('card-session', 'codex', temporaryDirectory, 'Card session');
  sessionsDb.createSession('other-session', 'codex', temporaryDirectory, 'Other session');
  t.after(async () => {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousTasksRoot === undefined) delete process.env.CLOUDCLI_TASKS_DIR;
    else process.env.CLOUDCLI_TASKS_DIR = previousTasksRoot;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const {
    handleTaskFinishRequest,
    handleTaskRegisterRequest,
    listRunningHostTasks,
    requestHostTaskStop,
    scanAndRecoverTaskResultsFromDisk,
    setTaskActivityListener,
  } = await import('@/modules/task-continuations/index.js');

  const writeWorkerResult = (taskId: string, title: string, status: string, exitCode: number) => fs.writeFile(
    path.join(process.env.CLOUDCLI_TASKS_DIR!, taskId, 'result.json'),
    JSON.stringify({
      version: 1, taskId, title, status, exitCode, completedAt: new Date().toISOString(),
      summary: `Task "${title}" ${status} (exit code ${exitCode}).`, outputLog: 'output.log', outputTruncated: false,
    }),
  );

  const register = async (sessionId: string, title: string, command: string[]) => {
    const task = await handleTaskRegisterRequest({ userId: 1, sessionId, title, command: JSON.stringify(command), autoNotify: true });
    await fs.mkdir(path.join(process.env.CLOUDCLI_TASKS_DIR!, task.taskId), { recursive: true });
    return task;
  };
  // The worker writes its heartbeat file and touches it while it runs.
  const beat = async (taskId: string, ageMs = 0) => {
    const file = path.join(process.env.CLOUDCLI_TASKS_DIR!, taskId, 'worker.alive');
    await fs.writeFile(file, JSON.stringify({ startedAt: 1_234 }));
    const at = new Date(Date.now() - ageMs);
    await fs.utimes(file, at, at);
  };

  const live = await register('card-session', 'long command', ['/bin/sleep', '120']);
  taskContinuationDb.markTaskRunning(live.taskId);
  await beat(live.taskId);

  // A worker that died while the host was down leaves a stale heartbeat.
  const gone = await register('card-session', 'worker gone', ['/bin/sleep', '1']);
  taskContinuationDb.markTaskRunning(gone.taskId);
  await beat(gone.taskId, 60_000);

  const pending = await register('card-session', 'not started', ['/bin/true']);
  await beat(pending.taskId);

  const broken = await register('card-session', 'lost result', ['/bin/true']);
  taskContinuationDb.markTaskRunning(broken.taskId);
  await beat(broken.taskId);
  taskContinuationDb.updateTaskRecoveryError({ taskId: broken.taskId, error: 'Worker exited after startup without a verified result.' });

  const unrecorded = await register('card-session', 'no worker record', ['/bin/true']);
  taskContinuationDb.markTaskRunning(unrecorded.taskId);

  const elsewhere = await register('other-session', 'other chat', ['/bin/true']);
  taskContinuationDb.markTaskRunning(elsewhere.taskId);
  await beat(elsewhere.taskId);

  assert.deepEqual(listRunningHostTasks('card-session'), [{
    id: live.taskId,
    taskId: live.taskId,
    toolName: 'Bash',
    command: '/bin/sleep 120',
    description: 'long command',
    startedAt: 1_234,
  }]);

  // A stop names its own chat and a task that is still running.
  assert.equal(await requestHostTaskStop('other-session', live.taskId), false);
  assert.equal(await requestHostTaskStop('card-session', pending.taskId), false);
  // Nobody watches a dead worker's directory: the stop is refused, not lost.
  assert.equal(await requestHostTaskStop('card-session', gone.taskId), false);
  assert.equal(await requestHostTaskStop('card-session', 'task_missing'), false);
  assert.equal(await requestHostTaskStop('card-session', '../escape'), false);

  assert.equal(await requestHostTaskStop('card-session', live.taskId), true);
  const stopFile = path.join(process.env.CLOUDCLI_TASKS_DIR!, live.taskId, 'stop');
  assert.equal((await fs.stat(stopFile)).isFile(), true);
  // The report is not cancelled up front: a command that completes before
  // the stop lands still reports its real result.
  assert.equal(taskContinuationDb.getTaskById(live.taskId)?.notification_cancelled_at, null);
  // Pressing stop again while the worker winds down is not an error.
  assert.equal(await requestHostTaskStop('card-session', live.taskId), true);

  // The worker's cancelled result for a stop the host asked for settles the
  // card and opens no report turn; here it arrives through disk recovery.
  const changes: string[] = [];
  setTaskActivityListener((sessionId) => changes.push(sessionId));
  t.after(() => setTaskActivityListener(null));
  await writeWorkerResult(live.taskId, 'long command', 'cancelled', 137);
  await scanAndRecoverTaskResultsFromDisk();
  assert.equal(taskContinuationDb.getTaskById(live.taskId)?.status, 'cancelled');
  assert.deepEqual(changes, ['card-session']);
  assert.equal(taskContinuationDb.getEventByTaskId(live.taskId), null);
  assert.ok(taskContinuationDb.getTaskById(live.taskId)?.notification_cancelled_at);
  assert.deepEqual(listRunningHostTasks('card-session'), []);

  // A cancelled result nobody asked the host for still reports as before.
  await writeWorkerResult(broken.taskId, 'lost result', 'cancelled', 1);
  await handleTaskFinishRequest({
    taskId: broken.taskId,
    taskToken: broken.taskToken!,
    status: 'cancelled',
    exitCode: 1,
    resultSummary: 'cancelled by its own script',
  });
  assert.equal(taskContinuationDb.getEventByTaskId(broken.taskId)?.status, 'pending');
});

test('a result recovered from disk settles the card of its chat', async (t) => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousTasksRoot = process.env.CLOUDCLI_TASKS_DIR;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-host-cards-recovery-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  process.env.CLOUDCLI_TASKS_DIR = path.join(temporaryDirectory, 'tasks');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  closeConnection();
  await initializeDatabase();
  userDb.createUser('host-card-user', 'hashed-password');
  sessionsDb.createSession('recovery-session', 'codex', temporaryDirectory, 'Recovery session');
  t.after(async () => {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousTasksRoot === undefined) delete process.env.CLOUDCLI_TASKS_DIR;
    else process.env.CLOUDCLI_TASKS_DIR = previousTasksRoot;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const {
    handleTaskRegisterRequest,
    scanAndRecoverTaskResultsFromDisk,
    setTaskActivityListener,
  } = await import('@/modules/task-continuations/index.js');

  const task = await handleTaskRegisterRequest({
    userId: 1, sessionId: 'recovery-session', title: 'finished while away', command: '["/bin/true"]', autoNotify: false,
  });
  taskContinuationDb.markTaskRunning(task.taskId);
  const directory = path.join(process.env.CLOUDCLI_TASKS_DIR!, task.taskId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({
    version: 1,
    taskId: task.taskId,
    title: 'finished while away',
    status: 'completed',
    exitCode: 0,
    completedAt: new Date().toISOString(),
    summary: 'Task "finished while away" completed (exit code 0).',
    outputLog: 'output.log',
    outputTruncated: false,
  }));

  const changes: string[] = [];
  setTaskActivityListener((sessionId) => changes.push(sessionId));
  t.after(() => setTaskActivityListener(null));
  await scanAndRecoverTaskResultsFromDisk();
  assert.equal(taskContinuationDb.getTaskById(task.taskId)?.status, 'completed');
  assert.deepEqual(changes, ['recovery-session']);
});
