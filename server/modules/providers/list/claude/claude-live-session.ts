/**
 * Claude Live Session
 *
 * Session-scoped pieces for a Claude CLI process that outlives its turn.
 *
 * A turn normally ends with the process exiting, but a turn that leaves
 * background work running holds the process open (stdin stays open) so the
 * work can finish and report back. That hold is what makes the next user
 * message dangerous: spawning a fresh process for it closes the held stdin
 * and the CLI's print wind-down kills every background task the model had
 * started. These helpers let the runtime keep one process per session and
 * feed later turns into it instead:
 *
 * - `createClaudeHeldPromptStream` is the pushable input stream. The SDK
 *   consumes it for the life of the process, so pushing a message starts a
 *   new turn without ending the process the background work lives in.
 * - `createClaudeBackgroundWorkTracker` answers "is anything still running in
 *   the background" from the CLI's own task lifecycle frames. It is
 *   session-scoped on purpose: work started two turns ago must still hold the
 *   process open when the current turn ends.
 * - `buildClaudeProcessFingerprint` / `canReuseClaudeLiveProcess` decide when
 *   a live process may carry a new turn. Only an exact match of every spawn
 *   option qualifies — silently running a turn under a model, effort, or
 *   permission mode the user did not pick is worse than restarting the
 *   process — and a history-rewriting edit never qualifies, because it needs
 *   a fresh resume at the anchor.
 *
 * Consumers: `server/modules/providers/list/claude/claude-runtime.provider.js`
 * (the only production consumer) and
 * `server/modules/providers/tests/claude-live-session.test.ts`.
 *
 * @module claude-live-session
 */

import { readJsonRecord, readOptionalString } from '@/shared/utils.js';

/**
 * One user-message record as the Claude Agent SDK expects it on the input
 * stream. Structurally identical to `SDKUserMessage`; kept local so this
 * module stays free of SDK type imports (the runtime that feeds it is a
 * plain JavaScript file).
 */
export type ClaudeInputMessage = {
  type: 'user';
  message: { role: 'user'; content: unknown };
  parent_tool_use_id: null;
  timestamp: string;
};

/**
 * The input stream handed to `query()`, plus the controls the runtime needs to
 * drive it across turns.
 */
export type ClaudeHeldPromptStream = {
  stream: AsyncIterable<ClaudeInputMessage>;
  /**
   * Queues one message for the SDK to consume as its own turn. Returns false
   * once the stream has been released — the caller must then fall back to a
   * fresh process instead of assuming the turn will run.
   */
  push(message: ClaudeInputMessage): boolean;
  /** Ends the stream, which makes the SDK close the CLI's stdin so it can exit. */
  release(): void;
  /** True after `release()`; a released stream can never accept another turn. */
  isReleased(): boolean;
};

/**
 * Creates the pushable input stream for one live process.
 *
 * The stream yields the initial prompt messages, then parks. The SDK keeps
 * reading it until it ends, so every later `push()` is delivered to the CLI
 * as a new user turn on the same process; only `release()` closes stdin.
 * @param initialMessages - The first turn's SDK user messages
 */
export function createClaudeHeldPromptStream(
  initialMessages: ClaudeInputMessage[],
): ClaudeHeldPromptStream {
  const queue = [...initialMessages];
  let wake: (() => void) | null = null;
  let released = false;

  const stream = (async function* () {
    while (!released) {
      while (queue.length > 0) {
        yield queue.shift() as ClaudeInputMessage;
      }
      if (released) {
        break;
      }
      // Parks until a message arrives or the stream is released.
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  })();

  return {
    stream,
    push(message) {
      if (released) {
        return false;
      }
      queue.push(message);
      wake?.();
      return true;
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      wake?.();
    },
    isReleased: () => released,
  };
}

/**
 * Tracks the CLI's live background tasks for one process.
 *
 * Fed every raw stream message, it keeps the set of non-ambient task ids the
 * CLI last reported. The set is the authoritative "the process must stay
 * alive" signal: the per-turn tool-use heuristic only sees work a single turn
 * started, while this survives turn boundaries.
 */
export type ClaudeBackgroundWorkTracker = {
  /** Observes one raw SDK stream message; unrelated shapes are ignored. */
  observe(message: unknown): void;
  /** True while at least one non-ambient background task has not reported back. */
  hasOutstanding(): boolean;
  /**
   * True once the CLI proved it reports background tasks through task
   * lifecycle frames. The completion notification uses it to decide whether
   * the tracked set is authoritative: a CLI that never reports frames keeps
   * the historical "a follow-up result means the work finished" reading.
   */
  hasObservations(): boolean;
};

/**
 * Creates the session-scoped background-work tracker.
 *
 * Three CLI frames keep the set honest:
 * - `background_tasks_changed` carries the full live set after every change
 *   (replace semantics), so it self-heals any drift.
 * - `task_started` with `is_backgrounded` adds a task on CLIs that predate
 *   the change frame.
 * - `task_notification` removes a task when it settles (any status).
 *
 * `ambient` tasks (housekeeping and live-update watchers) are excluded: they
 * are not user work and must not keep a session's process alive.
 */
export function createClaudeBackgroundWorkTracker(): ClaudeBackgroundWorkTracker {
  const taskIds = new Set<string>();
  let observed = false;

  return {
    observe(message) {
      const record = readJsonRecord(message);
      if (!record || record.type !== 'system') {
        return;
      }

      if (record.subtype === 'background_tasks_changed' && Array.isArray(record.tasks)) {
        observed = true;
        taskIds.clear();
        for (const task of record.tasks) {
          const entry = readJsonRecord(task);
          const taskId = readOptionalString(entry?.task_id);
          if (taskId && entry?.ambient !== true) {
            taskIds.add(taskId);
          }
        }
        return;
      }

      if (record.subtype === 'task_started' && record.is_backgrounded === true && record.ambient !== true) {
        observed = true;
        const taskId = readOptionalString(record.task_id);
        if (taskId) {
          taskIds.add(taskId);
        }
        return;
      }

      if (record.subtype === 'task_notification') {
        const taskId = readOptionalString(record.task_id);
        if (taskId) {
          taskIds.delete(taskId);
        }
      }
    },
    hasOutstanding: () => taskIds.size > 0,
    hasObservations: () => observed,
  };
}

/**
 * Reads the client uuids a reply frame or result attributes itself to.
 *
 * The CLI stamps the turn's first reply frame and its result with the client
 * uuid of the user message that triggered it (`user_message_uuid` plus, when a
 * prompt batch was merged, `user_message_uuids`). Frames from synthetic turns
 * (background-task follow-ups, scheduled wake-ups) carry neither.
 * @param message - Raw SDK message
 */
export function readClaudeClaimedUserMessageUuids(message: unknown): string[] {
  const record = readJsonRecord(message);
  const claimed = new Set<string>();

  if (Array.isArray(record?.user_message_uuids)) {
    for (const uuid of record.user_message_uuids) {
      const normalized = readOptionalString(uuid);
      if (normalized) {
        claimed.add(normalized);
      }
    }
  }

  const single = readOptionalString(record?.user_message_uuid);
  if (single) {
    claimed.add(single);
  }

  return [...claimed];
}

/**
 * First CLI release known to echo client uuids on reply frames and results: the
 * build bundled with the SDK whose types introduced `user_message_uuid(s)`.
 */
const FIRST_UUID_ECHOING_CLI_VERSION = [2, 1, 259];

/**
 * Reads, from the CLI's `system/init` frame, whether this process echoes client
 * uuids — known before the first result, so that result never has to be used
 * to guess.
 *
 * The guess is unsafe: a resumed session can open with a CLI-pushed turn (the
 * "background task stopped" task-notification) whose unstamped result arrives
 * first. Reading it as "this CLI never stamps" binds that result to the user's
 * turn, which ends the run and closes stdin while the real turn is still
 * running — its background work is then killed at the turn's end.
 *
 * Returns true for a known-stamping version, null when the frame is not an
 * init frame or the version is older/unparseable (the caller keeps its
 * fallback reading).
 * Consumers: `claude-runtime.provider.js` (sets its stamping flag from init).
 * @param message - Raw SDK message
 */
export function readClaudeInitUuidStampingSupport(message: unknown): true | null {
  const record = readJsonRecord(message);
  if (record?.type !== 'system' || record.subtype !== 'init') {
    return null;
  }

  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(readOptionalString(record.claude_code_version) ?? '');
  if (!match) {
    return null;
  }

  const version = match.slice(1, 4).map(Number);
  for (let index = 0; index < FIRST_UUID_ECHOING_CLI_VERSION.length; index += 1) {
    if (version[index] !== FIRST_UUID_ECHOING_CLI_VERSION[index]) {
      return version[index] > FIRST_UUID_ECHOING_CLI_VERSION[index] ? true : null;
    }
  }
  return true;
}

/**
 * Decides whether a result finishes the given turn.
 *
 * A result that names a different client uuid belongs to a queued or
 * CLI-pushed turn that ran while this one was still waiting. When the CLI
 * stamps uuids at all, a result without ours is likewise not ours (synthetic
 * follow-up turns are never stamped); only a CLI that never stamps leaves
 * attribution to arrival order, as it always did.
 * @param input - The turn's identity plus the result's claimed uuids
 */
export function claudeResultFinishesTurn(input: {
  /** Client uuid of the turn's prompt, or null for a CLI-pushed turn. */
  turnUuid: string | null;
  /** Whether the turn is one a caller submitted (vs. a follow-up). */
  turnExplicit: boolean;
  /** Uuids the result attributed itself to. */
  claimedUuids: string[];
  /** Whether this CLI was observed echoing client uuids; null until observed. */
  uuidStampingSupported: boolean | null;
}): boolean {
  if (input.turnUuid && input.claimedUuids.includes(input.turnUuid)) {
    return true;
  }
  if (input.claimedUuids.length > 0) {
    return false;
  }
  if (input.uuidStampingSupported === true) {
    return input.turnExplicit === false;
  }
  return true;
}

/**
 * Every spawn option a later turn must still match before it may be fed into
 * the same process. Values are pre-serialized so comparison is a plain field
 * check and cannot be fooled by array identity.
 */
export type ClaudeProcessFingerprint = {
  model: string | null;
  effort: string | null;
  /** `settings.ultracode` — a session-scoped behavior flag, not an effort level. */
  ultracode: boolean;
  permissionMode: string;
  cwd: string | null;
  allowedTools: string;
  disallowedTools: string;
  /** Serialized MCP server config; a config change needs a process that loads it. */
  mcpServers: string;
};

/**
 * Builds the reuse fingerprint from the SDK options a process is spawned with.
 *
 * Deliberately reads the effective SDK options (after model resolution and
 * effort expansion) rather than the raw client options, so two turns that
 * resolve to the same behavior compare equal even when they spell it
 * differently.
 * @param sdkOptions - The mapped options handed to `query()`
 */
export function buildClaudeProcessFingerprint(sdkOptions: {
  model?: unknown;
  effort?: unknown;
  settings?: unknown;
  permissionMode?: unknown;
  cwd?: unknown;
  allowedTools?: unknown;
  disallowedTools?: unknown;
  mcpServers?: unknown;
}): ClaudeProcessFingerprint {
  const settings = readJsonRecord(sdkOptions.settings);

  return {
    model: readOptionalString(sdkOptions.model) ?? null,
    effort: readOptionalString(sdkOptions.effort) ?? null,
    ultracode: settings?.ultracode === true,
    permissionMode: readOptionalString(sdkOptions.permissionMode) ?? 'default',
    cwd: readOptionalString(sdkOptions.cwd) ?? null,
    allowedTools: serializeStringList(sdkOptions.allowedTools),
    disallowedTools: serializeStringList(sdkOptions.disallowedTools),
    mcpServers: JSON.stringify(sdkOptions.mcpServers ?? null),
  };
}

/**
 * Decides whether a live process may carry the incoming turn.
 *
 * `liveFingerprint` is null when the session has no live process at all, which
 * fails the check. A released stream is already winding down, a turn in flight
 * would interleave two conversations, and a history rewrite (edit send) must
 * resume at its anchor on a fresh process.
 * @param input - Live-process state plus the incoming turn's fingerprint
 */
export function canReuseClaudeLiveProcess(input: {
  liveFingerprint: ClaudeProcessFingerprint | null;
  turnFingerprint: ClaudeProcessFingerprint;
  released: boolean;
  turnActive: boolean;
  rewritesHistory: boolean;
}): boolean {
  if (input.released || input.turnActive || input.rewritesHistory) {
    return false;
  }

  const live = input.liveFingerprint;
  if (!live) {
    return false;
  }

  return live.model === input.turnFingerprint.model
    && live.effort === input.turnFingerprint.effort
    && live.ultracode === input.turnFingerprint.ultracode
    && live.permissionMode === input.turnFingerprint.permissionMode
    && live.cwd === input.turnFingerprint.cwd
    && live.allowedTools === input.turnFingerprint.allowedTools
    && live.disallowedTools === input.turnFingerprint.disallowedTools
    && live.mcpServers === input.turnFingerprint.mcpServers;
}

/** Serializes a tool list order-independently for fingerprint comparison. */
function serializeStringList(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice()
    .sort()
    .join('\u0000');
}
