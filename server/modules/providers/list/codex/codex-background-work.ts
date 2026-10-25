import type { ActiveBackgroundTask } from '@/shared/types.js';

import { BackgroundWorkRegistry } from '../../shared/background-work/background-work-registry.js';

/**
 * Codex agents still running, keyed by app session id and agent thread id.
 *
 * Fed by the runtime from the `SubAgentActivity` records of the turn in flight
 * and emptied when that turn ends: the app-server is a child process that
 * `connection.close()` kills at the end of every turn, and its agents die
 * with it. Read by the runtime's `listBackgroundWork()` and by the sessions
 * provider, which uses it to tell an agent that is genuinely still running
 * (its turn is in flight) from one whose rollout simply has no end record.
 *
 * Process-wide by design: an agent nobody here tracks cannot be running.
 */
export const codexBackgroundWork = new BackgroundWorkRegistry();

/** The `taskType` Codex's spawned agents report as. */
export const CODEX_BACKGROUND_TASK_TYPE = 'collab_agent';

/**
 * Where the host's own tasks for a chat come from.
 *
 * A command a Codex chat hands to `cloudcli_task_run` runs in a host worker,
 * not in the engine, so the engine never reports it. Its card shares the
 * composer strip with the engine's agents, and its stop goes back to the host.
 * The composition root installs the source, so this module never imports the
 * task-continuations module.
 */
type CodexHostTaskSource = {
  /** The chat's tasks a worker is running now, in the strip's shape. */
  list(appSessionId: string): ActiveBackgroundTask[];
  /** Asks the task's worker to stop; false when the chat has no such running task. */
  stop(appSessionId: string, taskId: string): Promise<boolean>;
};

let hostTaskSource: CodexHostTaskSource | null = null;

/**
 * Installs the host task source; `null` removes it.
 *
 * Consumer: server composition (`server/index.ts`), which connects it to the
 * task-continuations module.
 */
export function setCodexHostTaskSource(source: CodexHostTaskSource | null): void {
  hostTaskSource = source;
}

/**
 * The chat's running host tasks.
 *
 * Consumer: the Codex runtime, which merges them into the strip's list.
 */
export function listCodexHostTasks(appSessionId: string): ActiveBackgroundTask[] {
  return hostTaskSource?.list(appSessionId) ?? [];
}

/**
 * Stops one host task of the chat.
 *
 * Consumer: the Codex runtime's `stopBackgroundTask`.
 */
export async function stopCodexHostTask(appSessionId: string, taskId: string): Promise<boolean> {
  return hostTaskSource ? hostTaskSource.stop(appSessionId, taskId) : false;
}
