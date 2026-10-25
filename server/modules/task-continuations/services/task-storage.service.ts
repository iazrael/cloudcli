import os from 'node:os';
import path from 'node:path';

const TASK_ROOT_ENV = 'CLOUDCLI_TASKS_DIR';

/** Returns the configured task output root shared by workers and recovery scans. */
export function getTaskContinuationTasksRoot(): string {
  return path.resolve(process.env[TASK_ROOT_ENV] || path.join(os.homedir(), '.cloudcli', 'tasks'));
}

/**
 * The worker's heartbeat: the worker writes `{ "startedAt": number }` into
 * this file in the task directory before it starts the command and touches
 * it every TASK_WORKER_HEARTBEAT_INTERVAL_MS while the command runs. The
 * strip draws a card only while the file is fresh, so a worker that died
 * while the host was down — or a pid some other process reused — never
 * keeps a card alive.
 */
export const TASK_WORKER_HEARTBEAT_FILE = 'worker.alive';

/** How often a running worker touches its heartbeat. */
export const TASK_WORKER_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * A heartbeat older than this means the worker is gone. Generous on purpose:
 * a card that goes stale while the machine sleeps only comes back with the
 * next strip frame.
 */
export const TASK_WORKER_HEARTBEAT_STALE_MS = 60_000;

/**
 * The stop request: the host creates this empty file in the task directory
 * and the worker, which watches for it, terminates the command. A file rather
 * than a signal keeps working across host restarts and never reaches a
 * process that merely reused the worker's pid.
 */
export const TASK_STOP_REQUEST_FILE = 'stop';
