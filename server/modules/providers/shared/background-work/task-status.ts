import type { ActiveBackgroundTask, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

/**
 * The `taskType` for an agent the engine runs as a child of the session,
 * matching what Claude's SDK names its local agents so the client labels
 * every engine's agent the same way.
 *
 * Consumers: the ZCode, OpenCode and Antigravity adapters.
 */
export const LOCAL_AGENT_TASK_TYPE = 'local_agent';

/**
 * The `taskType` for a shell command the engine moved to the background,
 * matching Claude's SDK name, so the client calls it a command rather than an
 * agent.
 *
 * Consumers: the OpenCode adapter and `BackgroundWorkRegistry.listStripTasks`.
 */
export const LOCAL_BASH_TASK_TYPE = 'local_bash';

/** The `task_status` fields an engine adapter supplies per event. */
export type TaskStatusFields = Pick<NormalizedMessage, 'event' | 'description' | 'status' | 'summary' | 'usage' | 'outputFile' | 'resumed'>
  & { id?: string; timestamp?: string };

/** What identifies the task a `task_status` event reports on. */
export type TaskStatusSubject = {
  provider: NormalizedMessage['provider'];
  sessionId: string | null;
  /** The engine's handle for the task (agent thread id, child session id, ...). */
  taskId: string;
  /** The `Agent` call that launched the task; the client folds the event onto that card. */
  toolUseId: string;
  taskType: string;
};

/**
 * Builds one `task_status` frame: the live word on a background task, which
 * the client folds onto the card of the call named by `toolUseId`.
 *
 * Consumers: the Codex, ZCode, OpenCode and Antigravity adapters, so every
 * engine speaks the same event shape and none keeps a private constructor.
 */
export function createTaskStatusMessage(subject: TaskStatusSubject, fields: TaskStatusFields): NormalizedMessage {
  return createNormalizedMessage({
    kind: 'task_status',
    ...subject,
    ...fields,
  });
}

/**
 * Builds one `background_tasks` status frame: the full list of what the
 * composer's background-task strip shows for a session, replacing whatever the
 * client held. A runtime sends it every time that list changes, an empty list
 * included, because nothing else clears the strip.
 *
 * `canInterrupt` says whether `chat.abort` can still stop that work. Omitted,
 * the client treats it as stoppable; a runtime whose turn has ended without a
 * process left to stop sends `false`, so the strip offers no stop button that
 * would only fail.
 *
 * `queuesInput` says whether a message sent meanwhile has to wait for the
 * work; it must match the runtime's `backgroundTasks.queuesInput`, which the
 * subscribe ack reports, or the live page and a reloaded one disagree.
 * Omitted, the client queues.
 *
 * Consumers: the Codex, ZCode, Antigravity and OpenCode runtime providers.
 */
export function createBackgroundTasksStatusMessage(
  subject: { provider: NormalizedMessage['provider']; sessionId: string | null },
  backgroundTasks: ActiveBackgroundTask[],
  canInterrupt?: boolean,
  queuesInput?: boolean,
): NormalizedMessage {
  return createNormalizedMessage({
    kind: 'status',
    text: 'background_tasks',
    ...subject,
    backgroundTasks,
    ...(canInterrupt === undefined ? {} : { canInterrupt }),
    ...(queuesInput === undefined ? {} : { backgroundWorkQueuesInput: queuesInput }),
  });
}
