import type { ActiveBackgroundTask, BackgroundTaskSummary, SessionBackgroundWork } from '@/shared/types.js';
import { SUBAGENT_TOOL_NAME, canonicalClaudeSubagentToolName } from '@/shared/utils.js';

// TaskCreate writes a to-do item; it does not launch an execution task.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'Workflow']);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);
// Terminal patch statuses the CLI follows with a reply turn; a stop gets none.
const REPLY_TASK_STATUSES = new Set(['completed', 'failed']);

type TaskRecord = {
  card?: ActiveBackgroundTask;
  summary?: BackgroundTaskSummary;
  taskId?: string;
  wakeAt?: number;
  cronId?: string;
  /** Set at the launching turn's end; the next turn's end settles the record. */
  turnEnded?: boolean;
};

type SessionWork = {
  records: Map<string, TaskRecord>;
  ownCalls: Map<string, string>;
  settledCalls: Set<string>;
};

// Keep the card's launch identity stable and replace its snapshot when the
// engine supplies a stop handle, so the runtime broadcasts the updated card.
function setStopHandle(record: TaskRecord, taskId: unknown): boolean {
  if (typeof taskId !== 'string' || !taskId) return false;
  record.taskId = taskId;
  if (!record.card || record.card.taskId === taskId) return false;
  record.card = { ...record.card, taskId };
  return true;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function content(message: Record<string, unknown>): Record<string, unknown>[] {
  const blocks = object(message.message)?.content;
  return Array.isArray(blocks) ? blocks.flatMap((block) => {
    const entry = object(block);
    return entry ? [entry] : [];
  }) : [];
}

// A main-thread call the CLI moved to the background on its own — a Bash past
// its timeout — shows no sign of it in the call, only in its `task_started`.
// It is the session's own work all the same, so it gets the card a call
// launched in the background would have had. Returns whether a card was added.
function cardFromTask(state: SessionWork, toolUseId: string, record: TaskRecord): boolean {
  const toolName = state.ownCalls.get(toolUseId);
  if (record.card || !record.summary || !toolName) return false;
  record.card = {
    id: toolUseId,
    taskId: record.summary.taskId,
    toolName: canonicalClaudeSubagentToolName(toolName),
    ...(record.summary.description ? { command: record.summary.description } : {}),
    startedAt: record.summary.startedAt,
  };
  return true;
}

// Crons and wakeups without an acknowledged time never report back on their
// own; the turn they trigger is the only sign they ran.
function lapsesAfterNextTurn(record: TaskRecord): boolean {
  return record.card?.toolName === 'CronCreate'
    || (record.card?.toolName === 'ScheduleWakeup' && record.wakeAt === undefined);
}

/** Used by Claude's runtime and provider tests to identify main-thread calls that outlive a turn. */
export function extractBackgroundTasks(raw: unknown): ActiveBackgroundTask[] {
  const message = object(raw);
  if (!message || message.type !== 'assistant' || message.parent_tool_use_id) {
    return [];
  }
  return content(message).flatMap((block) => {
    const input = object(block.input);
    const name = block.name;
    if (block.type !== 'tool_use' || typeof name !== 'string'
      || (name === 'ScheduleWakeup' && input?.stop === true)
      || !(DEFERRED_WORK_TOOLS.has(name)
        || (canonicalClaudeSubagentToolName(name) === SUBAGENT_TOOL_NAME && input?.run_in_background !== false)
        || (name === 'Bash' && input?.run_in_background === true))) {
      return [];
    }
    const command = name === 'Bash' ? input?.command
      : input?.description ?? input?.prompt ?? input?.command;
    return [{
      id: typeof block.id === 'string' ? block.id : '',
      toolName: canonicalClaudeSubagentToolName(name),
      command: typeof command === 'string' ? command : undefined,
      startedAt: Date.now(),
    }];
  });
}

/** Used by provider tests to pin the static fallback for SDK streams without task events. */
export function startsBackgroundWork(message: unknown): boolean {
  return extractBackgroundTasks(message).length > 0;
}

/**
 * Used by Claude's runtime to own both task stop handles and the UI projection.
 * Task ids resolve back to launching call ids; settling either identity removes
 * the same record. Pending calls without task events retain their fallback hold.
 * Wakeup deadlines only remove waiting cards, never terminate the CLI's reply.
 * Crons and untimed wakeups have no completion event, so they settle when the
 * turn after their launching turn ends.
 */
export function createBackgroundWorkTracker() {
  const sessions = new Map<string | null, SessionWork>();

  function settle(state: SessionWork, toolUseId: string): boolean {
    const record = state.records.get(toolUseId);
    state.settledCalls.add(toolUseId);
    state.records.delete(toolUseId);
    return Boolean(record?.card);
  }

  function findCall(state: SessionWork, taskId: unknown): string | undefined {
    if (typeof taskId !== 'string') return undefined;
    for (const [id, record] of state.records) {
      if (record.taskId === taskId) return id;
    }
    return undefined;
  }

  function resolveCall(state: SessionWork, message: Record<string, unknown>): string | undefined {
    return typeof message.tool_use_id === 'string' ? message.tool_use_id : findCall(state, message.task_id);
  }

  return {
    apply(sessionKey: string | null, raw: unknown): boolean {
      const message = object(raw);
      if (!message) return false;
      let state = sessions.get(sessionKey);
      if (!state) {
        state = { records: new Map(), ownCalls: new Map(), settledCalls: new Set() };
        sessions.set(sessionKey, state);
      }
      let changed = false;
      if (message.type === 'assistant' && !message.parent_tool_use_id) {
        for (const block of content(message)) {
          if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            state.ownCalls.set(block.id, block.name);
            const record = state.records.get(block.id);
            if (record?.summary) delete record.summary.nested;
          }
        }
        for (const card of extractBackgroundTasks(message)) {
          if (!card.id || state.settledCalls.has(card.id)) continue;
          const record = state.records.get(card.id) ?? {};
          if (!record.card) {
            record.card = record.taskId ? { ...card, taskId: record.taskId } : card;
            state.records.set(card.id, record);
            changed = true;
          }
        }
        for (const block of content(message)) {
          const record = typeof block.id === 'string' ? state.records.get(block.id) : undefined;
          if (record) changed = cardFromTask(state, block.id as string, record) || changed;
        }
      } else if (message.type === 'system' && typeof message.task_id === 'string') {
        const toolUseId = resolveCall(state, message);
        if (!toolUseId) return false;
        if (message.subtype === 'task_started') {
          if (state.settledCalls.has(toolUseId)) return false;
          const record = state.records.get(toolUseId) ?? {};
          changed = setStopHandle(record, message.task_id) || changed;
          record.summary = {
            taskId: message.task_id,
            toolUseId,
            taskType: typeof message.task_type === 'string' ? message.task_type : '',
            description: typeof message.description === 'string' ? message.description : '',
            startedAt: record.card?.startedAt ?? Date.now(),
            ...(typeof message.workflow_name === 'string' ? { workflowName: message.workflow_name } : {}),
            ...(!state.ownCalls.has(toolUseId) ? { nested: true } : {}),
          };
          state.records.set(toolUseId, record);
          changed = cardFromTask(state, toolUseId, record) || changed;
        } else if (message.subtype === 'task_notification'
          || (message.subtype === 'task_updated' && TERMINAL_TASK_STATUSES.has(String(object(message.patch)?.status)))) {
          changed = settle(state, toolUseId);
        }
      } else if (message.type === 'user' && !message.parent_tool_use_id) {
        const results = content(message).filter((block) => block.type === 'tool_result');
        // The SDK's structured result belongs to a single tool call, not every block.
        const output = results.length === 1 ? object(message.tool_use_result) : undefined;
        for (const block of results) {
          if (typeof block.tool_use_id !== 'string') continue;
          const id = block.tool_use_id;
          const record = state.records.get(id);
          if (block.is_error === true || TERMINAL_TASK_STATUSES.has(String(output?.status))) {
            changed = settle(state, id) || changed;
            continue;
          }
          const name = state.ownCalls.get(id);
          if (name === 'CronDelete' && typeof output?.id === 'string') {
            for (const [callId, pending] of state.records) {
              if (pending.cronId === output.id) changed = settle(state, callId) || changed;
            }
          }
          if (name === 'ScheduleWakeup'
            && (output?.stopped === true || (typeof output?.scheduledFor === 'number'
              && Number.isFinite(output.scheduledFor) && output.scheduledFor >= 0))) {
            // CLI dynamic loops have one pending wakeup: a successful schedule
            // replaces it; zero is a stopped/aged-out loop, not an invalid time.
            const stopped = output.stopped === true || output.scheduledFor === 0;
            for (const [callId, pending] of state.records) {
              if (pending.card?.toolName === 'ScheduleWakeup' && (callId !== id || stopped)) {
                changed = settle(state, callId) || changed;
              }
            }
            if (!stopped && record) record.wakeAt = output.scheduledFor as number;
          }
          if (!record) continue;
          for (const taskId of [output?.taskId, output?.agentId, output?.backgroundTaskId]) {
            changed = setStopHandle(record, taskId) || changed;
          }
          if (name === 'CronCreate' && typeof output?.id === 'string') record.cronId = output.id;
        }
      }
      return changed;
    },

    /**
     * Whether a task event ends main-thread work the CLI then reports on in a
     * reply turn. Ask before `apply`, which forgets the settled record.
     */
    settlesMainThreadWork(sessionKey: string | null, raw: unknown): boolean {
      const message = object(raw);
      const state = sessions.get(sessionKey);
      if (!message || !state || message.type !== 'system' || typeof message.task_id !== 'string') return false;
      const finished = message.subtype === 'task_notification'
        ? message.status !== 'stopped'
        : message.subtype === 'task_updated' && REPLY_TASK_STATUSES.has(String(object(message.patch)?.status));
      const toolUseId = resolveCall(state, message);
      return finished && Boolean(toolUseId && state.records.get(toolUseId)?.card);
    },

    /** Called at each `result`: settles work whose triggered turn has now ended. */
    endTurn(sessionKey: string | null): boolean {
      const state = sessions.get(sessionKey);
      if (!state) return false;
      let changed = false;
      for (const [id, record] of state.records) {
        if (!lapsesAfterNextTurn(record)) continue;
        if (record.turnEnded) changed = settle(state, id) || changed;
        else record.turnEnded = true;
      }
      return changed;
    },

    expireWakeups(sessionKey: string | null, now = Date.now()): boolean {
      const state = sessions.get(sessionKey);
      if (!state) return false;
      let changed = false;
      for (const [id, record] of state.records) {
        if (record.wakeAt !== undefined && record.wakeAt <= now) changed = settle(state, id) || changed;
      }
      return changed;
    },

    nextWakeupAt(sessionKey: string | null): number | undefined {
      const deadlines = Array.from(sessions.get(sessionKey)?.records.values() ?? [])
        .flatMap((record) => record.wakeAt === undefined ? [] : [record.wakeAt]);
      return deadlines.length ? Math.min(...deadlines) : undefined;
    },

    activeTasks(sessionKey: string | null): ActiveBackgroundTask[] {
      return Array.from(sessions.get(sessionKey)?.records.values() ?? [])
        .flatMap((record) => record.card ? [record.card] : []);
    },

    hasPending(sessionKey: string | null): boolean {
      return Boolean(sessions.get(sessionKey)?.records.size);
    },

    hasOutstanding(sessionKey: string | null): boolean {
      return Array.from(sessions.get(sessionKey)?.records.values() ?? []).some((record) => Boolean(record.summary));
    },

    has(sessionKey: string | null, taskId: string): boolean {
      const state = sessions.get(sessionKey);
      return Boolean(state && findCall(state, taskId));
    },

    clear(sessionKey: string | null): void {
      sessions.delete(sessionKey);
    },

    list(): SessionBackgroundWork[] {
      return Array.from(sessions).flatMap(([sessionId, state]) => {
        // Legacy direct-API runs track work under a null key until their
        // provider id lands; no consumer can address a null session, so the
        // public list leaves those out.
        if (sessionId === null) return [];
        const tasks = Array.from(state.records.values()).flatMap((record) => record.summary ? [record.summary] : []);
        return tasks.length ? [{ sessionId, tasks }] : [];
      });
    },
  };
}
