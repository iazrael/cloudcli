/**
 * The composer strip's cards for host tasks, and their stop.
 *
 * A card stands for a command a worker is running right now: the task is
 * `running`, no trouble is recorded for it, and the worker's heartbeat is
 * fresh. Stopping asks the worker, through the task directory, to terminate
 * the command; the worker's `cancelled` result settles the card like any
 * other result and opens no report turn. A command that completes before the
 * stop lands reports its real result as usual.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { taskContinuationDb } from '@/modules/database/index.js';
import {
  getTaskContinuationTasksRoot,
  TASK_STOP_REQUEST_FILE,
  TASK_WORKER_HEARTBEAT_FILE,
  TASK_WORKER_HEARTBEAT_STALE_MS,
} from '@/modules/task-continuations/services/task-storage.service.js';
import type { ActiveBackgroundTask, AsyncTaskRecord } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

/** Task ids the host issues; anything else never names a task directory. */
const TASK_ID_PATTERN = /^task_[A-Za-z0-9_-]{1,180}$/;

/** A heartbeat is a few dozen bytes; a larger file is not one. */
const MAX_HEARTBEAT_BYTES = 4096;

let activityListener: ((sessionId: string) => void) | null = null;

/**
 * Installs the listener told whenever a chat's host task cards may have
 * changed; `null` removes it.
 *
 * Consumer: server composition (`server/index.ts`), which re-sends the chat's
 * strip on every change.
 */
export function setTaskActivityListener(listener: ((sessionId: string) => void) | null): void {
  activityListener = listener;
}

/**
 * Tells the listener that a chat's host task cards may have changed: a task
 * started, finished, or its worker failed to report.
 *
 * Consumers: the worker manager, the finish handler and the disk recovery.
 */
export function notifyTaskActivity(sessionId: string): void {
  if (!activityListener) {
    return;
  }
  try {
    activityListener(sessionId);
  } catch (error) {
    // The listener only refreshes cards; a failure there must not undo a
    // task's start or its recorded result.
    console.error(`[TaskContinuation] Could not refresh the task cards of session ${sessionId}:`, error);
  }
}

/**
 * The worker's heartbeat, when it is fresh: the worker is alive and still
 * watching its task directory for a stop.
 */
function readFreshHeartbeat(taskId: string): { startedAt: number | null } | null {
  const heartbeatPath = path.join(getTaskContinuationTasksRoot(), taskId, TASK_WORKER_HEARTBEAT_FILE);
  try {
    const info = lstatSync(heartbeatPath);
    if (!info.isFile() || info.size > MAX_HEARTBEAT_BYTES || Date.now() - info.mtimeMs > TASK_WORKER_HEARTBEAT_STALE_MS) {
      return null;
    }
    const record = readObjectRecord(JSON.parse(readFileSync(heartbeatPath, 'utf8')));
    const startedAt = typeof record?.startedAt === 'number' && Number.isFinite(record.startedAt) ? record.startedAt : null;
    return { startedAt };
  } catch {
    // No heartbeat, or not a readable one: nothing vouches for a live worker.
    return null;
  }
}

/** The argv as one readable line; an argument with spaces is quoted. */
function formatCommand(command: string | null): string | undefined {
  if (!command) {
    return undefined;
  }
  try {
    const argv = JSON.parse(command) as unknown;
    if (Array.isArray(argv) && argv.every((argument) => typeof argument === 'string')) {
      return argv.map((argument) => (/\s|^$/.test(argument) ? JSON.stringify(argument) : argument)).join(' ');
    }
  } catch {
    // Fall through to the stored text.
  }
  return command;
}

/** The task's card, when a live worker is running its command. */
function toStripTask(task: AsyncTaskRecord): ActiveBackgroundTask | null {
  const worker = readFreshHeartbeat(task.task_id);
  if (!worker) {
    return null;
  }
  return {
    id: task.task_id,
    taskId: task.task_id,
    toolName: 'Bash',
    command: formatCommand(task.command),
    description: task.title,
    startedAt: worker.startedAt ?? Date.parse(task.created_at),
  };
}

/**
 * The chat's host tasks a worker is running now, in the strip's shape.
 *
 * Consumer: the Codex runtime, through the host task source installed by
 * server composition.
 */
export function listRunningHostTasks(sessionId: string): ActiveBackgroundTask[] {
  return taskContinuationDb.listRunningTasksForSession(sessionId)
    .flatMap((task) => toStripTask(task) ?? []);
}

/**
 * Keeps a user's stop from reopening the chat.
 *
 * Called with a worker's result before it is recorded: a `cancelled` result
 * for a task whose directory holds the host's stop request is the stop the
 * user pressed, so its report is cancelled. Any other result — including a
 * `cancelled` one nobody asked the host for — reports as usual.
 *
 * Consumers: the worker manager's result callback and the disk recovery,
 * the two paths a worker's result takes into the task records.
 */
export function suppressReportOfStoppedTask(taskId: string, status: string): void {
  if (status !== 'cancelled' || !TASK_ID_PATTERN.test(taskId)
    || !existsSync(path.join(getTaskContinuationTasksRoot(), taskId, TASK_STOP_REQUEST_FILE))) {
    return;
  }
  const cancellation = taskContinuationDb.cancelNotificationForTask(taskId, 'Stopped by user');
  if (cancellation !== 'cancelled') {
    console.warn(`[TaskContinuation] The stopped task ${taskId} could not drop its report (${cancellation}).`);
  }
}

/**
 * Stops one host task of the chat by asking its worker to terminate the
 * command. Resolves false when the chat shows no card for the task — it is
 * another chat's, not started, already over, or its worker is gone, so
 * nobody would read the request. A second stop while the worker winds down
 * resolves true.
 *
 * Consumer: the Codex runtime's `stopBackgroundTask`, through the host task
 * source installed by server composition.
 */
export async function requestHostTaskStop(sessionId: string, taskId: string): Promise<boolean> {
  if (!TASK_ID_PATTERN.test(taskId)) {
    return false;
  }
  const task = taskContinuationDb.getTaskById(taskId);
  if (!task || task.session_id !== sessionId || task.status !== 'running' || task.last_error || !toStripTask(task)) {
    return false;
  }

  const taskDirectory = path.join(getTaskContinuationTasksRoot(), taskId);
  const directoryInfo = await lstat(taskDirectory).catch(() => null);
  if (!directoryInfo?.isDirectory()) {
    return false;
  }

  try {
    await writeFile(path.join(taskDirectory, TASK_STOP_REQUEST_FILE), '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  return true;
}
