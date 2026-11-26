/**
 * Antigravity Runtime Provider
 *
 * Implements IProviderRuntime for Google Antigravity CLI (`agy`).
 * Spawns `agy` in print/stream-json mode and maps stdout events into CloudCLI NormalizedMessage stream.
 *
 * @module antigravity-runtime.provider
 */

import type { ChildProcess } from 'node:child_process';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped, rememberSessionReplyPreview } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors,
} from '@/shared/image-attachments.js';
import {
  LOCAL_AGENT_TASK_TYPE,
  LOCAL_BASH_TASK_TYPE,
  createBackgroundTasksStatusMessage,
  createTaskStatusMessage,
} from '@/modules/providers/shared/background-work/task-status.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AcpCardOutcome,
  ActiveBackgroundTask,
  AnyRecord,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  readOptionalString,
  sanitizeLeafDirectoryName,
} from '@/shared/utils.js';

import { getAntigravityAcpDataRoot, getAntigravityDataRoot, getAntigravityTranscriptCandidates } from './antigravity-data-root.js';
import { tryResolveEnginePath } from './antigravity-engine-path.js';
import { buildAntigravitySubprocessEnv } from './antigravity-subprocess-env.js';
import { createAgentTranscriptTail } from './antigravity-agent-tail.js';
import { AntigravitySessionsProvider } from './antigravity-sessions.provider.js';
import { readCanonicalAntigravityTranscript } from './antigravity-transcript.provider.js';
import {
  antigravityBackgroundWork,
  buildAntigravityAgentToolId,
  createAntigravityAgentRow,
  extractAntigravitySubagents,
  judgeAntigravityAgent,
  parseCreatedSubagentIds,
  readAgentReports,
  readInvokedAgentSpecs,
  SPAWN_RECEIPT_PATTERN,
} from './antigravity-subagent.js';
import {
  findCatalogOptionForModelString,
  resolveAntigravityModelArgs,
} from './antigravity-model-effort.js';
import type { AntigravityAcpClient } from './antigravity-acp-client.js';
import { AntigravityAcpSessionManager } from './antigravity-acp-session-manager.js';
import { AntigravityAcpTranslator } from './antigravity-acp-translator.js';
import { antigravityAcpCards, formatQuestionAnswers } from './antigravity-acp-bridge.js';
import { ANTIGRAVITY_QUESTION_TOOL as QUESTION_TOOL_NAME } from './antigravity-question.js';

const PROVIDER = 'antigravity';

/**
 * Serializes each session's snapshot writes: the step and result persists can
 * be issued a few milliseconds apart, and two concurrent `writeFile` calls on
 * one path interleave into a torn file that JSON parsing then rejects. The
 * entry drops once it is the settled tail, so the map stays at in-flight
 * chains only.
 */
const tokenUsagePersistChains = new Map<string, Promise<void>>();

/**
 * Persists token usage snapshot into session's brain directory for offline / reloaded queries.
 */
async function persistAntigravityTokenUsage(sessionId: string, tokenBudget: unknown): Promise<void> {
  const safeId = sanitizeLeafDirectoryName(sessionId, 'antigravity session id');
  // ACP sessions keep their brain under the managed data directory; the first
  // root that already holds this session's brain wins.
  const brainDir = [getAntigravityDataRoot(), getAntigravityAcpDataRoot()]
    .map((root) => path.join(root, 'brain', safeId))
    .find((dir) => fsSync.existsSync(dir));
  if (!brainDir) return;
  const usageFile = path.join(brainDir, 'token_usage.json');
  const content = JSON.stringify(tokenBudget, null, 2);
  const write = (tokenUsagePersistChains.get(safeId) ?? Promise.resolve())
    .then(() => fsp.writeFile(usageFile, content, 'utf8'));
  tokenUsagePersistChains.set(safeId, write);
  try {
    await write;
  } catch {
    // Best-effort persistence
  } finally {
    if (tokenUsagePersistChains.get(safeId) === write) {
      tokenUsagePersistChains.delete(safeId);
    }
  }
}

/**
 * Reads one engine usage record (`step_update.usage` or `result.usage`) into
 * the used/input/output triplet shared by the token budget frames and the
 * persisted snapshot. Missing numbers count as zero; `total_tokens` wins as
 * the used value, otherwise input + output.
 */
function readAntigravityUsageRecord(usage: AnyRecord | null): { used: number; inputTokens: number; outputTokens: number } {
  const inputTokens = Number(usage?.input_tokens ?? usage?.inputTokens ?? usage?.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(usage?.output_tokens ?? usage?.outputTokens ?? usage?.completion_tokens ?? usage?.candidates_tokens ?? 0) || 0;
  const used = Number(usage?.total_tokens ?? usage?.totalTokens ?? (inputTokens + outputTokens)) || 0;
  return { used, inputTokens, outputTokens };
}

/**
 * Maps CloudCLI permission modes onto `agy` CLI flags. `default` maps to no
 * flags and relies on the CLI's own permission prompting; every other mode
 * maps to the native flag combination verified against `agy --help`.
 */
const PERMISSION_MODE_ARGS: Record<string, string[]> = {
  acceptEdits: ['--mode', 'accept-edits'],
  plan: ['--mode', 'plan'],
  bypassPermissions: ['--dangerously-skip-permissions'],
};

/**
 * How long a run may go without any stdout activity before it is considered
 * hung and killed. 30 minutes leaves room for a deep subagent review: while
 * the root agent waits on a subagent its own stream is completely silent.
 *
 * agy itself is never given a limit. Its `--print-timeout` caps the whole
 * turn, and on expiry agy emits a SUCCESS result while subagents and
 * background commands are still running; closing stdin on that result then
 * makes agy kill them (measured on agy 1.3.1). Its default of 0 waits for the
 * turn, so this watchdog is the only bound.
 */
const DEFAULT_IDLE_TIMEOUT = '30m';

/**
 * Parses a Go duration string (`30m`, `90s`, `1h30m`, `500ms`) into
 * milliseconds. Returns null when the string carries no recognizable unit, so
 * an unparsable override degrades to the default rather than to no timeout at
 * all. `0` is preserved as "no limit", matching agy's own `--print-timeout 0`.
 */
function parseGoDurationMs(value: string): number | null {
  const trimmed = value.trim();
  if (/^0[a-z]*$/i.test(trimmed)) return 0;
  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const matches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/gi)];
  if (matches.length === 0) return null;
  return matches.reduce((total, [, amount, unit]) => total + Number(amount) * units[unit.toLowerCase()], 0);
}

/**
 * Active process map keyed by session ID.
 */
const activeProcesses = new Map<string, ChildProcess>();

/**
 * Monotonic counter for process keys of runs without a session ID, so
 * concurrent keyless runs can never collide on `agy_<timestamp>`.
 */
let keylessRunCounter = 0;

/**
 * Process keys killed by `abort()`. Their `close` event resolves the run
 * quietly and notifies with `stopReason: 'aborted'` instead of completed.
 */
const abortedProcessKeys = new Set<string>();

/**
 * Session keys a keyless run is also reachable by once the engine names its
 * conversation: `backgroundTasks.list` is asked by app or conversation id,
 * while the run's tasks are registered under the key it started with.
 */
const backgroundKeyAliases = new Map<string, string>();

/** Number of live key aliases; the tests use it to prove a finished run leaves none behind. */
export function getAntigravityBackgroundKeyAliasCount(): number {
  return backgroundKeyAliases.size;
}

/**
 * The agents a session is waiting on, in the shape the composer's strip lists.
 * `id` is the id of each agent's `Agent` card.
 */
export function getAntigravityBackgroundTasksForSession(sessionId: string): ActiveBackgroundTask[] {
  return antigravityBackgroundWork.listStripTasks(backgroundKeyAliases.get(sessionId) ?? sessionId);
}

/**
 * How much of the child's stderr is retained for failure reporting. agy
 * writes actionable errors (auth failures, bad flags, quota) to stderr only;
 * the tail is what the user sees when the run fails.
 */
/** How long a run waits for its agents' final transcript reads before settling. */
const AGENT_TAIL_FINAL_READ_TIMEOUT_MS = 5_000;

/** Retry parent reports after the contentless live notice, including delayed transcript writes. */
const AGENT_REPORT_POLL_INTERVAL_MS = 2_000;

const STDERR_TAIL_LIMIT = 4_000;

/**
 * agy's built-in notice when the backend generation stream breaks mid-turn.
 * agy injects its own continuation prompt into the conversation on this
 * condition, so the backend agent keeps working; the notice is a status
 * update for the user, not a run failure.
 */
const STREAM_INTERRUPTED_NOTICE = 'The stream was interrupted. Please continue the task you were working on.';

/**
 * Neutral transcript copy shown in place of the raw notice, so an
 * interrupted-stream turn does not render as a red error row.
 */
const STREAM_INTERRUPTED_SUMMARY = '会话中断，已自动重试';

/**
 * i18n key paired with {@link STREAM_INTERRUPTED_SUMMARY}: the client renders
 * the notice through `taskNotices.sessionInterruptedRetried` in its own locale
 * (chat namespace); the Chinese literal is the fallback for consumers that do
 * not resolve keys (transcript export, older clients).
 */
const STREAM_INTERRUPTED_SUMMARY_KEY = 'taskNotices.sessionInterruptedRetried';

/**
 * True when a result error is agy's interrupted-stream auto-resume notice
 * rather than a real failure. Matches the bare sentence and its rendered
 * `Error: `-prefixed variant.
 */
const isStreamInterruptedNotice = (message: string | null | undefined): boolean => {
  const trimmed = message?.trim();
  return trimmed === STREAM_INTERRUPTED_NOTICE
    || trimmed === `Error: ${STREAM_INTERRUPTED_NOTICE}`;
};

//----------------- Replay-guard classification (cursor-based) ------------

/** Longest chunk head the classifier matches on (long chunks may drift in their tail). */
const REPLAY_CHUNK_HEAD = 120;
/** How far past the cursor a replayed chunk may sit and still count as continuation. */
const REPLAY_SKIP_WINDOW = 200;
/** Suffix length the buffered-replay verdict aligns against the tail with. */
const REPLAY_BUFFER_PROBE = 400;

/**
 * What the replay guard concluded about a chunk or the buffered stretch:
 * `replay` carries the tail position the replay has consumed up to (the
 * guard resumes consuming from there), `live` ends the guard. Shared by
 * `consumeReplayChunk` and `classifyBufferedReplay`; exported for the runtime
 * tests (consumer: antigravity-acp-runtime.test).
 */
export type ReplayVerdict =
  | { verdict: 'replay'; nextCursor: number }
  | { verdict: 'live' };

/**
 * Consumes one streamed chunk against the tail a resumed session replays,
 * saying whether it is still replay and where the replay has progressed to.
 *
 * Replay is chronological and ends exactly at the tail's end, so a chunk can
 * only be replay when it continues the tail *at the cursor* — a global
 * `includes` misclassified the model's first real chunk whenever that short
 * fragment happened to occur anywhere in the tail, and the lost leading text
 * left the client's streamed placeholder unable to reconcile with the
 * persisted row (a reply shown twice). Rules:
 *
 * - whitespace cannot be classified: it holds as replay without advancing
 *   (the previous matcher's behavior);
 * - a cursor at or past the tail's end means the tail is fully consumed —
 *   everything after is the model's fresh output by definition;
 * - the chunk head (first `REPLAY_CHUNK_HEAD` chars, the previous probe
 *   width) must continue at the cursor, or sit within `REPLAY_SKIP_WINDOW`
 *   of it (history cleaning shifts boundaries by whitespace), or overlap the
 *   tail's end (the engine repeats already-delivered boundary text).
 * Exported for the runtime tests (consumer: antigravity-acp-runtime.test).
 */
export function consumeReplayChunk(
  tailText: string | null,
  cursor: number,
  chunkText: string,
): ReplayVerdict {
  if (!chunkText.trim()) return { verdict: 'replay', nextCursor: cursor };
  if (!tailText || cursor >= tailText.length) return { verdict: 'live' };
  const head = chunkText.length > REPLAY_CHUNK_HEAD ? chunkText.slice(0, REPLAY_CHUNK_HEAD) : chunkText;
  if (tailText.startsWith(head, cursor)) {
    return { verdict: 'replay', nextCursor: Math.min(cursor + chunkText.length, tailText.length) };
  }
  const driftIndex = tailText.indexOf(head, cursor);
  if (driftIndex >= 0 && driftIndex - cursor <= REPLAY_SKIP_WINDOW) {
    return { verdict: 'replay', nextCursor: Math.min(driftIndex + chunkText.length, tailText.length) };
  }
  if (tailText.endsWith(head.slice(0, 40))) {
    return { verdict: 'replay', nextCursor: tailText.length };
  }
  return { verdict: 'live' };
}

/**
 * Classifies the text buffered while the tail was still being read, once the
 * tail is known. The buffer holds the resumed session's replayed history,
 * which ends at the tail's end — when the buffer's own ending aligns with the
 * tail, everything buffered is replay (the common path: the tail read
 * finishes after the replay has streamed past). A buffer whose ending sits
 * mid-tail means the replay stopped partway and later chunks must keep
 * consuming from there; a buffer whose ending aligns with nothing is already
 * carrying the model's fresh text. Exported for the runtime tests
 * (consumer: antigravity-acp-runtime.test).
 */
export function classifyBufferedReplay(
  tailText: string | null,
  bufferText: string,
): ReplayVerdict {
  if (!tailText) return { verdict: 'live' };
  // Align on the longest suffix both texts share: a tail shorter than the
  // probe window still aligns (the replay's final chars are the tail's).
  const probeLength = Math.min(REPLAY_BUFFER_PROBE, bufferText.length, tailText.length);
  const bufferSuffix = bufferText.slice(-probeLength);
  if (!bufferSuffix.trim()) {
    // Whitespace cannot be classified: hold as replay, cursor unmoved.
    return { verdict: 'replay', nextCursor: 0 };
  }
  if (tailText.endsWith(bufferSuffix)) {
    return { verdict: 'replay', nextCursor: tailText.length };
  }
  const midTailIndex = tailText.indexOf(bufferSuffix);
  if (midTailIndex >= 0) {
    return { verdict: 'replay', nextCursor: midTailIndex + bufferSuffix.length };
  }
  if (tailText.endsWith(bufferSuffix.slice(0, 40))) {
    return { verdict: 'replay', nextCursor: tailText.length };
  }
  return { verdict: 'live' };
}

//----------------- /Replay-guard classification ------------

/**
 * The ACP runtime is the default since its real-machine acceptance; setting
 * `CLOUDCLI_ANTIGRAVITY_ACP=0` falls back to the print path below (kept as
 * the untouched fallback; docs/design/agyACP运行时.md 灰度开关).
 */
const isAcpRuntimeEnabled = (): boolean => process.env.CLOUDCLI_ANTIGRAVITY_ACP !== '0';

/**
 * The resident ACP session manager. One instance serves every session; the
 * engine path is resolved on first construction and kept for the process's
 * lifetime (an engine reinstall takes effect on restart).
 */
let acpManagerInstance: AntigravityAcpSessionManager | null = null;
const getAcpManager = (): AntigravityAcpSessionManager => {
  if (!acpManagerInstance) {
    const enginePath = tryResolveEnginePath() ?? '';
    acpManagerInstance = new AntigravityAcpSessionManager({
      hasPendingCards: (appSessionId) => antigravityAcpCards.hasForSession(appSessionId),
      onSessionExit: (appSessionId, info, client) => {
        console.info(`[AntigravityAcp] Session ${appSessionId} engine exited (code: ${info.code}, signal: ${info.signal})`);
        if (acpRoutedClients.get(appSessionId) !== client) return;
        acpRoutedClients.delete(appSessionId);
        acpRoutedTranslators.delete(appSessionId);
        antigravityAcpCards.retractAllForSession(appSessionId, { allow: false, message: 'The ACP connection closed.' });
      },
    }, enginePath);
  }
  return acpManagerInstance;
};

/**
 * Agent conversation ids already bound to spawn calls, per session. Receipts
 * accumulate in the transcript forever, so later turns must not rebind an
 * earlier turn's ids onto their own spawn calls.
 */
const acpBoundSpawnIds = new Map<string, Set<string>>();

/**
 * Sessions whose between-turns listener is installed, and the ones holding a
 * live run pump. The engine keeps streaming after a turn ends — a daemon
 * `run_command` completing is announced only there — so a resident listener
 * forwards those frames onto the session channel (through the run context's
 * `publishSessionEvent`, which the composition root wires to the websocket
 * layer) while no run owns the session's writer.
 */
const acpAnnouncedClients = new WeakSet<AntigravityAcpClient>();
const acpRoutedClients = new Map<string, AntigravityAcpClient>();
const acpLiveRunPumps = new Set<string>();
const acpRoutedTranslators = new Map<string, AntigravityAcpTranslator>();
const acpActiveTurns = new Map<string, AbortController>();

/**
 * Installs the between-turns router for the session's current process: every
 * frame the engine pushes while no run pump is subscribed is translated and
 * published through the run context's `publishSessionEvent`, so
 * background-task completions reach a connected client the same way the
 * turn's own frames do. Re-installs on a respawned process — the previous
 * subscription died with it.
 */
function installAcpSessionRouter(
  sessionKey: string,
  context: ProviderRuntimeContext,
  client: AntigravityAcpClient,
): void {
  const publish = context.publishSessionEvent;
  if (!publish || acpRoutedClients.get(sessionKey) === client) return;
  acpRoutedClients.set(sessionKey, client);
  client.onNotification((notification) => {
    if (acpLiveRunPumps.has(sessionKey)) return;
    if (notification.method !== 'session/update') return;
    let translator = acpRoutedTranslators.get(sessionKey);
    if (!translator) {
      translator = new AntigravityAcpTranslator();
      const frameSessionId = readOptionalString(readObjectRecord(notification.params)?.sessionId) ?? null;
      translator.setSessionId(frameSessionId);
      acpRoutedTranslators.set(sessionKey, translator);
    }
    for (const message of translator.translate(notification).messages) {
      publish(sessionKey, message);
    }
  });
}

/**
 * Kills every resident ACP session process. Server shutdown and the tests
 * both need this: the children hold the event loop open otherwise.
 */
export async function closeAntigravityAcpSessions(): Promise<void> {
  const manager = acpManagerInstance;
  try {
    await manager?.destroyAll();
  } finally {
    if (acpManagerInstance === manager) acpManagerInstance = null;
  }
}

export class AntigravityRuntimeProvider implements IProviderRuntime {
  readonly backgroundTasks = {
    list: (sessionId: string) => getAntigravityBackgroundTasksForSession(sessionId),
  };

  /**
   * The pending-card gateway: `chat_subscribed` replays the cards and the
   * gateway's permission-response flow settles them, so the ACP question and
   * permission cards ride exactly the plumbing the other providers use.
   */
  readonly permissions = {
    resolve: (requestId: string, decision: ProviderPermissionDecision) => {
      antigravityAcpCards.resolve(requestId, decision);
    },
    listPending: (sessionId: string) => antigravityAcpCards.listForSession(sessionId),
  };

  /**
   * Executes a command using the Antigravity CLI.
   */
  async run(
    command: string,
    options: AnyRecord = {},
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<unknown> {
    if (isAcpRuntimeEnabled()) {
      return this.runViaAcp(command, options, writer, context);
    }

    // The merged catalog decides whether a base model id encodes effort as an
    // id suffix. A catalog lookup failure degrades to flag-based effort.
    const catalog = await context.getProviderModels().catch(() => null);

    return new Promise((resolve, reject) => {
      const sessionId = readOptionalString(options.sessionId);
      // An explicit workspace (chat gateway sends cwd + projectPath) is kept
      // separate from the spawn fallback: only an explicitly requested
      // directory may become a declared agy workspace via --add-dir.
      const explicitWorkspace = readOptionalString(options.cwd)
        ?? readOptionalString(options.projectPath);
      const cwd = explicitWorkspace ? path.resolve(explicitWorkspace) : process.cwd();
      const model = readOptionalString(options.model);
      const effort = readOptionalString(options.effort);
      const permissionMode = readOptionalString(options.permissionMode);
      const skipPermissions = Boolean(options.skipPermissions || options.toolsSettings?.skipPermissions);
      const sessionSummary = readOptionalString(options.sessionSummary);

      const providerSessionId = sessionId
        ? context.resolveProviderSessionId(sessionId)
        : null;

      let capturedSessionId = providerSessionId;
      let sessionCreatedSent = false;
      let completeSent = false;
      let settled = false;
      let sawErrorResult = false;
      let errorResultMessage: string | null = null;
      /**
       * Set when the only error result was agy's interrupted-stream notice.
       * The run then settles as a non-failure: agy has already asked the
       * backend conversation to continue, so failing the run (error row,
       * failure notification, rejected promise) would contradict the engine's
       * own recovery.
       */
      let streamInterruptedResult = false;
      let stderrTail = '';
      /**
       * Whether an agent_response text segment is currently streaming. agy
       * interleaves pure-text steps with tool steps inside one turn without
       * any end-of-text marker, so the segment boundary is derived here:
       * the first non-text event after text deltas closes the segment.
       */
      let agentResponseSegmentOpen = false;
      /**
       * Per-run token accounting for the `/cost` detail's cumulative block.
       * Each step reports one model call, so their sum is the run's bill
       * until the result's usage — the authoritative turn total — replaces
       * it. `lastContextReading` keeps the newest step for the result frame:
       * the context occupancy must stay the last call, never the turn sum.
       */
      let runCumulative = { used: 0, inputTokens: 0, outputTokens: 0 };
      let lastContextReading: { used: number; inputTokens: number; outputTokens: number } | null = null;
      /**
       * Set when the watchdog killed a wedged run, so `close` reports the
       * timeout instead of a bare signal termination.
       */
      let watchdogExpired = false;

      const processKey = sessionId || capturedSessionId || `agy_${Date.now()}_${keylessRunCounter += 1}`;
      const sessionKey = sessionId || capturedSessionId || processKey;
      const broadcastBackgroundTasks = () => {
        writer.send(createBackgroundTasksStatusMessage(
          { provider: PROVIDER, sessionId: capturedSessionId || sessionId || null },
          getAntigravityBackgroundTasksForSession(sessionKey),
        ));
      };

      // The agents' own work lives in their transcripts, not in `agy`'s
      // stream; following those puts their steps into their cards as they
      // happen, in the same shape history gives them.
      const historyReader = new AntigravitySessionsProvider();
      /** The turn-end work a `result` event started; `close` and `error` wait for it. */
      let turnEnding: Promise<void> | null = null;
      let agentTailsClosed = false;
      const agentTail = createAgentTranscriptTail({
        readTimeline: async (conversationId) => (await historyReader.fetchHistory(conversationId, {})).messages,
        emit: (message) => { if (!agentTailsClosed) writer.send(message); },
      });
      // A launch can be replayed after its agent has already returned.
      const startedAgentIds = new Set<string>();
      let reportTimer: NodeJS.Timeout | undefined;
      let reportRead: Promise<void> | null = null;
      let reportsClosed = false;
      let reportFingerprint: string | undefined;
      let agentReports = new Map<string, string>();
      /**
       * agy omits report bodies from its live system_message steps. Read the
       * parent's canonical transcript instead; only a report addressed by an
       * outstanding agent's id finishes it, never the parent's prose or an
       * intermediate DONE response in the child's transcript.
       */
      const settleReportedAgents = (): Promise<void> | null => {
        if (reportsClosed || reportRead || !antigravityBackgroundWork.hasSession(sessionKey)) return reportRead;
        reportRead = (async () => {
          try {
            const parentId = capturedSessionId || providerSessionId;
            if (!parentId) return;
            const safeId = sanitizeLeafDirectoryName(parentId, 'antigravity session id');
            const compact = getAntigravityTranscriptCandidates(safeId).find((candidate) => fsSync.existsSync(candidate));
            if (!compact) return;
            // Poll metadata only while unchanged; long parent transcripts need
            // no repeated parsing. Full transcripts can catch up independently.
            const files = [compact, path.join(path.dirname(compact), 'transcript_full.jsonl')];
            const stamps = await Promise.all(files.map(async (file) => {
              try {
                const stat = await fsp.stat(file);
                return [file, stat.size, stat.mtimeMs];
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [file, null];
                throw error;
              }
            }));
            const fingerprint = JSON.stringify(stamps);
            if (reportFingerprint !== fingerprint) {
              const rows = await readCanonicalAntigravityTranscript(parentId);
              const contents = rows.flatMap(({ entry }) => {
                if (entry.status !== 'DONE' || entry.source === 'USER_EXPLICIT' || entry.type === 'USER_INPUT') return [];
                const content = readOptionalString(entry.content) ?? '';
                return Array.from(content.matchAll(/<SYSTEM_MESSAGE>\s*([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/gi), (match) => match[1]);
              });
              agentReports = readAgentReports(contents);
              reportFingerprint = fingerprint;
            }
            // A report can precede the live launch; apply cached receipts too.
            for (const id of agentReports.keys()) {
              if (reportsClosed) return;
              const task = antigravityBackgroundWork.get(sessionKey, id);
              if (!task) continue;
              await agentTail.stop(id);
              // A result, abort or process exit can win while the final read waits.
              if (reportsClosed || !antigravityBackgroundWork.end(sessionKey, id)) continue;
              writer.send(createTaskStatusMessage(
                { provider: PROVIDER, sessionId: capturedSessionId || sessionId || null,
                  taskId: id, toolUseId: task.toolUseId, taskType: LOCAL_AGENT_TASK_TYPE },
                { event: 'notification', status: 'completed' },
              ));
              broadcastBackgroundTasks();
            }
          } catch (error) {
            console.warn('[AntigravityRuntime] Could not reconcile agent reports:', error);
          }
        })().finally(() => { reportRead = null; });
        return reportRead;
      };
      /**
       * Stops following every agent after one last read, bounded so a stuck
       * transcript read cannot hold the run open forever; a failure is
       * reported and the run still settles.
       */
      const finishAgentTails = async (): Promise<void> => {
        reportsClosed = true;
        clearInterval(reportTimer);
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.all([reportRead, agentTail.stopAll()]),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                console.warn('[AntigravityRuntime] Final agent transcript reads did not finish in time; settling without them.');
                resolve();
              }, AGENT_TAIL_FINAL_READ_TIMEOUT_MS);
            }),
          ]);
        } catch (error) {
          console.error('[AntigravityRuntime] Failed to finish agent transcript tails:', error);
        } finally {
          // A timed-out read may finish later; it must not write past complete.
          agentTailsClosed = true;
          clearTimeout(timer);
        }
      };

      /**
       * Settles every agent the session still waits on: one `task_status`
       * per agent so its card stops running, then the registry empties. At the
       * turn's result each agent settles by how its own transcript ended (the
       * same judgement history uses, so a refresh shows the same card); a
       * process that ends without a result settles them `stopped`, because
       * nothing is left to report on them.
       */
      const settleOutstandingAgents = (judge: 'transcript' | 'stopped') => {
        const outstanding = antigravityBackgroundWork.list().find((entry) => entry.sessionId === sessionKey)?.tasks ?? [];
        for (const task of outstanding) {
          writer.send(createTaskStatusMessage(
            {
              provider: PROVIDER,
              sessionId: capturedSessionId || sessionId || null,
              taskId: task.taskId,
              toolUseId: task.toolUseId,
              taskType: LOCAL_AGENT_TASK_TYPE,
            },
            { event: 'notification', status: judge === 'stopped' ? 'stopped' : judgeAntigravityAgent(task.taskId) },
          ));
        }
        antigravityBackgroundWork.clearSession(sessionKey);
        return outstanding.length > 0;
      };

      // Numbers the interrupted-stream notices of this run so two of them
      // cannot collide on one id.
      let streamInterruptedNoticeCount = 0;

      /**
       * Builds the user-facing failure description for a non-zero or
       * signal-terminated exit, appending the captured stderr tail because
       * agy reports actionable errors there.
       */
      const describeFailure = (code: number | null): string => {
        const base = watchdogExpired
          ? `Antigravity CLI produced no output for ${idleTimeout} and was terminated.`
          : code === null
            ? 'Antigravity CLI terminated by signal.'
            : `Antigravity CLI exited with code ${code}`;
        const stderr = stderrTail.trim();
        return stderr ? `${base}\nstderr:\n${stderr}` : base;
      };

      /** Forgets the run's registered agents and the aliases that reached them. */
      const releaseBackgroundKeys = () => {
        antigravityBackgroundWork.clearSession(sessionKey);
        if (capturedSessionId && backgroundKeyAliases.get(capturedSessionId) === sessionKey) {
          backgroundKeyAliases.delete(capturedSessionId);
        }
      };

      const settleOnce = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };

      const notifyTerminalState = ({ code = null, error = null }: { code?: number | null; error?: string | Error | null } = {}) => {
        const finalSessionId = sessionId || capturedSessionId || processKey;
        const normalizedUserId = writer.userId != null ? String(writer.userId) : null;
        // An interrupted-stream notice is agy's auto-resume handshake: only a
        // real error result, a spawn error, or a non-interrupted non-zero
        // exit counts as a failure.
        const failed = sawErrorResult
          || error !== null
          || (code !== 0 && !streamInterruptedResult);
        if (!failed) {
          notifyRunStopped({
            userId: normalizedUserId,
            provider: PROVIDER,
            sessionId: finalSessionId,
            sessionName: sessionSummary,
            stopReason: 'completed',
          });
        } else {
          notifyRunFailed({
            userId: normalizedUserId,
            provider: PROVIDER,
            sessionId: finalSessionId,
            sessionName: sessionSummary,
            error: error
              || (sawErrorResult
                ? (errorResultMessage || 'Antigravity CLI reported an error result.')
                : describeFailure(code)),
          });
        }
        releaseBackgroundKeys();
      };

      const enginePath = tryResolveEnginePath();
      if (!enginePath) {
        releaseBackgroundKeys();

        const notInstalledMsg = createNormalizedMessage({
          id: generateMessageId(PROVIDER),
          kind: 'error',
          content: 'Antigravity CLI (agy) is not installed. Please install it first.',
          sessionId: processKey,
          provider: PROVIDER,
          isError: true,
        });
        writer.send(notInstalledMsg);
        settleOnce(() => reject(new Error('Antigravity CLI is not installed.')));
        return;
      }

      // Build CLI arguments
      const args: string[] = [];

      // agy (≤1.1.24) registers the spawn cwd as workspace metadata but still
      // runs its shell tool in ~/.gemini/antigravity-cli/scratch; only an
      // explicit --add-dir makes the agent actually operate in the project
      // directory. Absolute path required (see path.resolve above).
      if (explicitWorkspace) {
        args.push('--add-dir', cwd);
      }

      const idleTimeout = readOptionalString(options.idleTimeout)
        ?? process.env.CLOUDCLI_ANTIGRAVITY_IDLE_TIMEOUT
        ?? DEFAULT_IDLE_TIMEOUT;

      // Prompt with attachments
      const hasAttachments =
        normalizeAttachmentDescriptors(options.images).length > 0
        || normalizeAttachmentDescriptors(options.files).length > 0;

      // The prompt travels over stdin as one NDJSON line rather than as an
      // argv entry. `agy -p "<prompt>"` runs the turn in one-shot print mode,
      // where the CLI shuts itself down a few seconds after the root agent
      // goes idle — it logs `root agent idle; waiting up to 5s for N
      // background task(s)` and then `terminating N background task(s) on
      // exit`. Every asynchronous task the agent dispatches (a subagent, a
      // backgrounded run_command) dies there, and agy still reports
      // `status: SUCCESS`, so the run looks finished while its real result is
      // never produced. Feeding the turn through `--input-format stream-json`
      // keeps stdin open, which keeps the CLI alive until we close it, so
      // those tasks run to completion and their output streams back in.
      let stdinTurn: string | null = null;
      if ((command && command.trim()) || hasAttachments) {
        const promptWithAttachments = appendFilesInputTag(
          appendImagesInputTag(command || '', options.images),
          options.files,
        );
        // Over stdin the prompt is JSON-encoded, so newlines survive as-is
        // and no shell flattening is needed.
        stdinTurn = `${JSON.stringify({ event: 'user', message: { content: promptWithAttachments } })}\n`;
        args.push('-p=');
        args.push('--input-format', 'stream-json');
        args.push('--output-format', 'stream-json');
      }

      // Resume existing conversation
      if (providerSessionId) {
        args.push('--conversation', providerSessionId);
      }

      // Model configuration and reasoning effort share one resolution: the
      // merged-catalog entry for the model decides the channel — variant
      // families get their tier appended, cataloged models without effort
      // support run with their catalog id, and models missing from the
      // catalog (custom ones) take the --effort flag. The lookup also
      // resolves display labels and legacy suffixed ids from old session rows
      // onto the family's real tiers; agy's own picker writes labels into
      // settings.json, and rows created under such a default store them
      // verbatim. A label's own tier is the intent recorded by that picker,
      // so it applies when the session has no explicit effort choice.
      const resolvedModel = model && catalog
        ? findCatalogOptionForModelString(model, catalog.OPTIONS)
        : null;
      const modelArgs = resolveAntigravityModelArgs(
        model,
        effort ?? resolvedModel?.labelTier ?? undefined,
        resolvedModel?.option,
      );

      if (modelArgs.model) {
        args.push('--model', modelArgs.model);
      }

      if (modelArgs.effort) {
        args.push('--effort', modelArgs.effort);
      }

      // Permission mode (acceptEdits / plan / bypassPermissions); 'default'
      // adds no flags. Chat and headless callers both pass `permissionMode`.
      const permissionModeArgs = permissionMode ? PERMISSION_MODE_ARGS[permissionMode] : undefined;
      if (permissionModeArgs) {
        args.push(...permissionModeArgs);
      }

      // The independent tools-settings toggle forces skip-permissions even
      // when the selected permission mode would not.
      if (skipPermissions && !args.includes('--dangerously-skip-permissions')) {
        args.push('--dangerously-skip-permissions');
      }

      // Flag names only: `-p` carries the user prompt verbatim and must never
      // reach the server console.
      console.debug(`[AntigravityRuntime] Spawning agy with flags: ${args.filter((arg) => arg.startsWith('--')).join(' ')}`);

      let stdoutBuffer = '';

      /**
       * Closes the child's stdin once, bound to the process spawned below.
       * Assigned after spawn; the no-op default covers the (unreachable)
       * window before that, and the idempotence keeps a duplicated result
       * event from writing to a finished stream.
       */
      let closeStdinTurn = (): void => {};

      /**
       * Re-arms the inactivity watchdog. Assigned after spawn.
       */
      let touchWatchdog = (): void => {};

      const processLine = (line: string) => {
        if (!line || !line.trim()) return;

        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          // Not JSON: agy occasionally prints plain progress/notice text on
          // stdout even in stream-json mode; surface it as a text delta.
          const deltaMsg = createNormalizedMessage({
            id: generateMessageId(PROVIDER),
            kind: 'stream_delta',
            content: line,
            sessionId: capturedSessionId || sessionId || null,
            provider: PROVIDER,
          });
          writer.send(deltaMsg);
          agentResponseSegmentOpen = true;
          return;
        }

        try {
          const rawRecord = readObjectRecord(raw);

          // Handle init event for session ID capture. Fully handled here:
          // normalizeMessage's init branch would emit a second session_created
          // for the same event (both flat conversation_id and nested init
          // coexist in real agy output), so return instead of falling through.
          if (rawRecord?.event === 'init' && rawRecord?.conversation_id) {
            const convId = readOptionalString(rawRecord.conversation_id);
            if (convId && !capturedSessionId) {
              capturedSessionId = convId;
              // A run keyed by its own process (no app session id) is also
              // reached by the conversation id the engine names; a run keyed
              // by the app session id needs no alias.
              if (capturedSessionId !== sessionKey) {
                backgroundKeyAliases.set(capturedSessionId, sessionKey);
              }
              writer.setSessionId?.(capturedSessionId);

              if (!providerSessionId && !sessionCreatedSent) {
                sessionCreatedSent = true;
                writer.send(createNormalizedMessage({
                  id: generateMessageId(PROVIDER),
                  kind: 'session_created',
                  newSessionId: capturedSessionId,
                  sessionId: capturedSessionId,
                  provider: PROVIDER,
                  content: `Antigravity session created: ${capturedSessionId}`,
                }));
              }
            }
            return;
          }

          const stepUpdateRecord = readObjectRecord(rawRecord?.step_update);
          if (stepUpdateRecord) {
            const startedAgents = extractAntigravitySubagents(stepUpdateRecord);
            if (startedAgents.length > 0) {
              for (const agent of startedAgents) {
                if (startedAgentIds.has(agent.conversationId)) continue;
                startedAgentIds.add(agent.conversationId);
                antigravityBackgroundWork.start(sessionKey, {
                  taskId: agent.conversationId,
                  toolUseId: agent.toolUseId,
                  taskType: LOCAL_AGENT_TASK_TYPE,
                  description: agent.role ?? 'Subagent',
                });
                agentTail.follow(agent.conversationId, agent.toolUseId);
                writer.send(createTaskStatusMessage(
                  {
                    provider: PROVIDER,
                    sessionId: capturedSessionId || sessionId || null,
                    taskId: agent.conversationId,
                    toolUseId: agent.toolUseId,
                    taskType: LOCAL_AGENT_TASK_TYPE,
                  },
                  { event: 'started', description: agent.role },
                ));
              }
              broadcastBackgroundTasks();
              reportTimer ??= setInterval(() => { void settleReportedAgents(); }, AGENT_REPORT_POLL_INTERVAL_MS);
              reportTimer.unref();
            }
            if (stepUpdateRecord.step_type === 'system_message') void settleReportedAgents();
          }

          // Context occupancy comes from step_update usage only: each one
          // reports a single model call, i.e. the live context size. The
          // result event's usage sums every call of the turn and would
          // overstate the context (easily past 100%) in agentic loops.
          const usageRecord = readObjectRecord(stepUpdateRecord?.usage);

          // Segment boundary for streaming text: the first event that is not
          // an agent_response text delta (a tool step, a text-less DONE, the
          // terminal result, ...) closes the open text segment with a
          // stream_end. The persisted transcript stores one row per segment,
          // so closing each live segment keeps the client's concatenated
          // bubble shape aligned with history and lets the existing exact-
          // match echo dedupe do its job.
          const stepEvent = rawRecord?.event === 'step_update' ? stepUpdateRecord : null;
          const isTextDeltaStep = Boolean(
            stepEvent
            && readOptionalString(stepEvent.step_type) === 'agent_response'
            && readOptionalString(stepEvent.text_delta),
          );
          if (agentResponseSegmentOpen && !isTextDeltaStep) {
            agentResponseSegmentOpen = false;
            writer.send(createNormalizedMessage({
              id: generateMessageId(PROVIDER),
              kind: 'stream_end',
              sessionId: capturedSessionId || sessionId || null,
              provider: PROVIDER,
            }));
          }
          if (isTextDeltaStep) {
            agentResponseSegmentOpen = true;
          }

          if (usageRecord) {
            const usage = readAntigravityUsageRecord(usageRecord);
            const { inputTokens, outputTokens } = usage;
            const { used } = usage;
            if (used > 0 || inputTokens > 0 || outputTokens > 0) {
              runCumulative = {
                used: runCumulative.used + used,
                inputTokens: runCumulative.inputTokens + inputTokens,
                outputTokens: runCumulative.outputTokens + outputTokens,
              };
              lastContextReading = { ...usage };
              const tokenBudget = {
                used,
                total: 1048576,
                inputTokens,
                outputTokens,
                breakdown: {
                  input: inputTokens,
                  output: outputTokens,
                },
                cumulative: { ...runCumulative },
              };
              writer.send(createNormalizedMessage({
                id: generateMessageId(PROVIDER),
                kind: 'status',
                text: 'token_budget',
                tokenBudget,
                sessionId: capturedSessionId || sessionId || null,
                provider: PROVIDER,
              }));

              const activeSessionId = capturedSessionId || sessionId;
              if (activeSessionId) {
                void persistAntigravityTokenUsage(activeSessionId, tokenBudget);
              }
            }
          }

          // Handle result event (terminal)
          if (rawRecord?.event === 'result') {
            const resultData = readObjectRecord(rawRecord.result);
            const usageData = readObjectRecord(resultData?.usage);
            const totalTokens = typeof usageData?.total_tokens === 'number' ? usageData.total_tokens : undefined;
            const isError = resultData?.status === 'ERROR' || Boolean(resultData?.error);
            const errorMessage = readOptionalString(resultData?.error);

            if (isError && isStreamInterruptedNotice(errorMessage)) {
              // agy reports a broken backend stream with this canned error and
              // simultaneously injects a continuation prompt into the
              // conversation, so the task resumes server-side. Degrade the
              // notice to a quiet transcript line instead of a hard error.
              streamInterruptedResult = true;
              writer.send(createNormalizedMessage({
                // One notice per interrupted result, named after the run that
                // produced it: a replay re-announces the same row rather than
                // stacking a second copy on top of the first.
                id: `${processKey}_stream_interrupted_${streamInterruptedNoticeCount += 1}`,
                kind: 'task_notification',
                summary: STREAM_INTERRUPTED_SUMMARY,
                summaryKey: STREAM_INTERRUPTED_SUMMARY_KEY,
                status: 'interrupted',
                sessionId: capturedSessionId || sessionId || null,
                provider: PROVIDER,
              }));
            } else if (isError) {
              sawErrorResult = true;
              errorResultMessage = errorMessage ?? null;
              writer.send(createNormalizedMessage({
                id: generateMessageId(PROVIDER),
                kind: 'error',
                content: errorMessage || 'Antigravity CLI reported an error result.',
                sessionId: capturedSessionId || sessionId || null,
                provider: PROVIDER,
                isError: true,
              }));
            }

            // An interrupted-stream result is not the end of the turn: agy has
            // injected its own continuation prompt and is still working, so
            // closing stdin here would EOF the CLI mid-task and resurrect the
            // very "async work silently killed" bug stdin ownership exists to
            // prevent. Its eventual real result closes stdin instead, and the
            // watchdog bounds the wait if that result never comes. The client
            // keeps the turn busy too.
            const turnContinues = isError && isStreamInterruptedNotice(errorMessage);
            if (turnContinues) {
              return;
            }

            // The result's usage is the run's authoritative bill: it replaces
            // the step accumulation in one final `token_budget` frame, which
            // also lands in `token_usage.json` so `/cost` reads the cumulative
            // block back without a transcript pass. Context stays the last
            // step's reading; with no step usage at all the run bill is also
            // the best context answer — the transcript reader's same fallback.
            const resultUsage = readAntigravityUsageRecord(usageData);
            if (resultUsage.used > 0 || resultUsage.inputTokens > 0 || resultUsage.outputTokens > 0) {
              runCumulative = { ...resultUsage };
              const contextReading = lastContextReading ?? { ...resultUsage };
              const tokenBudget = {
                used: contextReading.used,
                total: 1048576,
                inputTokens: contextReading.inputTokens,
                outputTokens: contextReading.outputTokens,
                breakdown: {
                  input: contextReading.inputTokens,
                  output: contextReading.outputTokens,
                },
                cumulative: { ...runCumulative },
              };
              writer.send(createNormalizedMessage({
                id: generateMessageId(PROVIDER),
                kind: 'status',
                text: 'token_budget',
                tokenBudget,
                sessionId: capturedSessionId || sessionId || null,
                provider: PROVIDER,
              }));
              const activeSessionId = capturedSessionId || sessionId;
              if (activeSessionId) {
                void persistAntigravityTokenUsage(activeSessionId, tokenBudget);
              }
            }

            // agy reports a turn only after its subagents are back, so their
            // cards settle before the client sees the turn complete — and only
            // after each agent's last steps were read from its transcript, so
            // none of them lands behind the settle frames or the `complete`.
            // `close` waits for this before it speaks for the run.
            turnEnding = (async () => {
              // A failed or stuck final read must not keep the turn from
              // ending: `close` waits on this, and the run only settles after.
              await finishAgentTails();
              try {
                if (settleOutstandingAgents(isError ? 'stopped' : 'transcript')) {
                  broadcastBackgroundTasks();
                }
              } catch (error) {
                console.error('[AntigravityRuntime] Failed to settle agent cards at turn end:', error);
              }

              // A finished turn releases the stdin that was holding the CLI
              // open: agy exits on EOF and `close` settles the run.
              closeStdinTurn();

              if (!completeSent) {
                completeSent = true;
                const completeMsg = createCompleteMessage({
                  provider: PROVIDER,
                  sessionId: capturedSessionId || sessionId || null,
                  exitCode: isError && !streamInterruptedResult ? 1 : 0,
                });
                if (totalTokens !== undefined) {
                  completeMsg.tokens = totalTokens;
                }
                writer.send(completeMsg);
              }
            })();
            return;
          }

          // Normalize message and send to writer
          const normalized = context.normalizeMessage(raw, capturedSessionId || sessionId || null);
          for (const msg of normalized) {
            writer.send(msg);
          }
        } catch (error) {
          // The event WAS valid JSON, so a throw here is a normalization bug
          // or an unexpected payload shape — report it as an error instead of
          // masquerading raw JSON as assistant text.
          const detail = error instanceof Error ? error.message : String(error);
          console.error('[AntigravityRuntime] Failed to process provider event:', detail, line);
          writer.send(createNormalizedMessage({
            id: generateMessageId(PROVIDER),
            kind: 'error',
            content: `Antigravity event could not be processed: ${detail}`,
            sessionId: capturedSessionId || sessionId || null,
            provider: PROVIDER,
            isError: true,
          }));
        }
      };

      const agyProcess = crossSpawn(enginePath, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildAntigravitySubprocessEnv(),
        windowsHide: true,
      });

      activeProcesses.set(processKey, agyProcess);

      let stdinClosed = false;
      closeStdinTurn = () => {
        if (stdinClosed) return;
        stdinClosed = true;
        agyProcess.stdin?.end();
      };

      // Holding stdin open is the only thing keeping the CLI alive, and
      // --print-timeout does not apply in this mode, so a run whose result
      // event never arrives (crashed CLI, truncated stdout, a result line
      // mangled by agy's interleaved plain-text notices) would otherwise hang
      // forever with the session stuck in "processing". The watchdog bounds
      // that: every stdout chunk re-arms it, and expiry terminates the child
      // so `close` can settle the run as a failure.
      const watchdogMs = parseGoDurationMs(idleTimeout) ?? parseGoDurationMs(DEFAULT_IDLE_TIMEOUT) ?? 0;
      let watchdogTimer: NodeJS.Timeout | null = null;
      const clearWatchdog = () => {
        if (watchdogTimer) {
          clearTimeout(watchdogTimer);
          watchdogTimer = null;
        }
      };
      touchWatchdog = () => {
        if (watchdogMs <= 0) return;
        clearWatchdog();
        watchdogTimer = setTimeout(() => {
          watchdogTimer = null;
          watchdogExpired = true;
          console.error(
            `[AntigravityRuntime] No output for ${idleTimeout}; terminating wedged run ${processKey}`,
          );
          closeStdinTurn();
          agyProcess.kill('SIGTERM');
        }, watchdogMs);
        // A pending watchdog must never be the reason the server stays alive.
        watchdogTimer.unref?.();
      };
      touchWatchdog();

      // stdin errors are reported, never swallowed: a failed prompt write
      // means agy never receives the turn, which would otherwise present as a
      // silent hang with nothing in the log. EPIPE against an already-dead
      // child is the one benign case — its exit is reported through
      // `close`/`error` anyway.
      agyProcess.stdin?.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') return;
        console.error('[Antigravity CLI stdin error]:', err);
      });
      if (stdinTurn) {
        agyProcess.stdin?.write(stdinTurn, (err) => {
          if (!err) return;
          // The turn never reached agy, so no result will ever arrive: fail
          // the run now rather than waiting out the watchdog.
          console.error('[AntigravityRuntime] Failed to deliver the turn over stdin:', err);
          clearWatchdog();
          agyProcess.kill('SIGTERM');
        });
      } else {
        closeStdinTurn();
      }

      agyProcess.stdout?.on('data', (data: Buffer) => {
        touchWatchdog();
        stdoutBuffer += data.toString('utf8');
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          processLine(line.trim());
        }
      });

      agyProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf8');
        console.warn('[Antigravity CLI stderr]:', text);
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      });

      agyProcess.on('close', async (code: number | null) => {
        clearWatchdog();
        activeProcesses.delete(processKey);

        if (stdoutBuffer.trim()) {
          processLine(stdoutBuffer.trim());
          stdoutBuffer = '';
        }

        // stdout truncation can swallow the event that would have closed the
        // last text segment; close it before the terminal complete so the
        // client never keeps a synthetic streaming row alive.
        if (agentResponseSegmentOpen) {
          agentResponseSegmentOpen = false;
          writer.send(createNormalizedMessage({
            id: generateMessageId(PROVIDER),
            kind: 'stream_end',
            sessionId: capturedSessionId || sessionId || null,
            provider: PROVIDER,
          }));
        }

        // Agents that never reported are gone with the process; what they did
        // last is still read from their transcripts first.
        await turnEnding;
        await finishAgentTails();
        if (settleOutstandingAgents('stopped')) {
          broadcastBackgroundTasks();
        }

        // An exit right after an interrupted-stream notice settles as a
        // success below, so its complete must not report a failure either.
        const succeeded = !watchdogExpired && (code === 0 || (streamInterruptedResult && !sawErrorResult));
        if (!completeSent) {
          completeSent = true;
          writer.send(createCompleteMessage({
            provider: PROVIDER,
            sessionId: capturedSessionId || sessionId || null,
            exitCode: succeeded ? 0 : code ?? 0,
          }));
        }

        // A SIGTERM from abort() closes with code null after the chat gateway
        // already completed the run: resolve quietly and notify 'aborted'
        // instead of reporting a failure or a completion.
        const wasAborted = abortedProcessKeys.delete(processKey);
        if (wasAborted) {
          releaseBackgroundKeys();
          notifyRunStopped({
            userId: writer.userId != null ? String(writer.userId) : null,
            provider: PROVIDER,
            sessionId: sessionId || capturedSessionId || processKey,
            sessionName: sessionSummary,
            stopReason: 'aborted',
          });
          settleOnce(() => resolve({ sessionId: capturedSessionId || sessionId, success: true, aborted: true }));
          return;
        }

        // agy reports actionable errors (auth, quota, bad flags) on stderr
        // only; surface the captured tail to the user instead of leaving it
        // in the server console.
        // A watchdog kill leaves stderr empty and, when the child exits on
        // SIGTERM cleanly, a zero code too — so it gets its own arm: the user
        // must see why the run stopped, not just a bare complete.
        if (watchdogExpired || (code !== 0 && stderrTail.trim())) {
          writer.send(createNormalizedMessage({
            id: generateMessageId(PROVIDER),
            kind: 'error',
            content: describeFailure(code),
            sessionId: capturedSessionId || sessionId || null,
            provider: PROVIDER,
            isError: true,
          }));
        }

        notifyTerminalState({ code });
        if (succeeded) {
          settleOnce(() => resolve({ sessionId: capturedSessionId || sessionId, success: true }));
        } else {
          settleOnce(() => reject(new Error(describeFailure(code))));
        }
      });

      agyProcess.on('error', async (err: Error) => {
        clearWatchdog();
        activeProcesses.delete(processKey);
        console.error('[Antigravity CLI error]:', err);

        await turnEnding;
        await finishAgentTails();
        if (settleOutstandingAgents('stopped')) {
          broadcastBackgroundTasks();
        }

        writer.send(createNormalizedMessage({
          id: generateMessageId(PROVIDER),
          kind: 'error',
          content: err.message,
          sessionId: capturedSessionId || sessionId || null,
          provider: PROVIDER,
          isError: true,
        }));

        if (!completeSent) {
          completeSent = true;
          writer.send(createCompleteMessage({
            provider: PROVIDER,
            sessionId: capturedSessionId || sessionId || null,
            exitCode: 1,
          }));
        }

        notifyTerminalState({ error: err });
        settleOnce(() => reject(err));
      });
    });
  }

  /**
   * Runs one turn against the resident ACP session (`CLOUDCLI_ANTIGRAVITY_ACP=1`).
   *
   * Contract parity with the print path: resolves `{sessionId, success}` (plus
   * `aborted` after a `session/cancel`) or rejects with the failure
   * description; NormalizedMessage frames stream through the writer; terminal
   * notifications go out once.
   *
   * Questions resume on the same run. Permission decisions use the
   * pending-card gateway and keep approval state outside the engine process.
   */
  private async runViaAcp(
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<unknown> {
    const sessionId = readOptionalString(options.sessionId);
    const explicitWorkspace = readOptionalString(options.cwd)
      ?? readOptionalString(options.projectPath);
    const cwd = explicitWorkspace ? path.resolve(explicitWorkspace) : process.cwd();
    const legacySkipPermissions = options.skipPermissions === true || options.toolsSettings?.skipPermissions === true;
    // Older callers may send only the legacy flag. An explicit mode is the current turn's choice.
    const permissionMode = readOptionalString(options.permissionMode)
      ?? (legacySkipPermissions ? 'bypassPermissions' : 'default');
    const sessionSummary = readOptionalString(options.sessionSummary);
    const providerSessionId = sessionId ? context.resolveProviderSessionId(sessionId) : null;

    const enginePath = tryResolveEnginePath();
    if (!enginePath) {
      writer.send(createNormalizedMessage({
        id: generateMessageId(PROVIDER),
        kind: 'error',
        content: 'Antigravity CLI (agy) is not installed. Please install it first.',
        sessionId: sessionId ?? null,
        provider: PROVIDER,
        isError: true,
      }));
      throw new Error('Antigravity CLI is not installed.');
    }

    const manager = getAcpManager();
    const sessionKey = sessionId ?? `agy_acp_${Date.now()}_${keylessRunCounter += 1}`;
    if (acpActiveTurns.has(sessionKey)) {
      throw new Error(`Antigravity session ${sessionKey} is busy with another turn`);
    }
    const cancellation = new AbortController();
    acpActiveTurns.set(sessionKey, cancellation);

    const idleTimeout = readOptionalString(options.idleTimeout)
      ?? process.env.CLOUDCLI_ANTIGRAVITY_IDLE_TIMEOUT
      ?? DEFAULT_IDLE_TIMEOUT;
    const watchdogMs = parseGoDurationMs(idleTimeout) ?? parseGoDurationMs(DEFAULT_IDLE_TIMEOUT) ?? 0;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let watchdogExpired = false;
    // A card the user is thinking about must not count as engine silence:
    // while one holds the run the watchdog stays disarmed (the card registry's
    // own TTL bounds the wait), and engine frames do not re-arm it.
    let cardHold = 0;
    // Tool calls of this run the engine has not reported finished. agy holds
    // the prompt open while a command it moved to the background
    // (`WaitMsBeforeAsync`) still runs and streams nothing meanwhile, so a
    // long build or training job is silent for hours by design; killing the
    // engine there also kills the job. Silence only counts as a wedge while
    // no call is outstanding; a stuck tool stays visible as a running card
    // the user can stop.
    const openToolCalls = new Set<string>();
    let reportedToolWait = false;
    const clearWatchdog = () => {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };
    const touchWatchdog = () => {
      if (watchdogMs <= 0 || cardHold > 0) return;
      clearWatchdog();
      watchdogTimer = setTimeout(() => {
        watchdogTimer = null;
        if (openToolCalls.size > 0) {
          if (!reportedToolWait) {
            reportedToolWait = true;
            console.info(`[AntigravityAcp] No output for ${idleTimeout} while ${openToolCalls.size} tool call(s) run; still waiting on session ${sessionKey}`);
          }
          touchWatchdog();
          return;
        }
        watchdogExpired = true;
        console.error(`[AntigravityAcp] No output for ${idleTimeout}; terminating session ${sessionKey}`);
        manager.destroy(sessionKey);
      }, watchdogMs);
      watchdogTimer.unref?.();
    };

    const broadcastBackgroundTasks = () => {
      writer.send(createBackgroundTasksStatusMessage(
        { provider: PROVIDER, sessionId: sessionId ?? null },
        getAntigravityBackgroundTasksForSession(sessionKey),
      ));
    };

    let settled = false;
    let completeSent = false;
    let runCumulative = { used: 0, inputTokens: 0, outputTokens: 0 };
    let lastContextReading: { used: number; inputTokens: number; outputTokens: number } | null = null;
    let unsubscribe: (() => void) | undefined;
    let release: (() => void) | undefined;
    let finishAgentTails: (() => Promise<void>) | undefined;
    let stopAbortedOutput: (() => Promise<void>) | undefined;
    let capturedSessionId = sessionId ?? null;
    const finishAborted = async () => {
      clearWatchdog();
      await stopAbortedOutput?.();
      if (!completeSent) {
        completeSent = true;
        writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: capturedSessionId, exitCode: 0, aborted: true }));
      }
      notifyRunStopped({
        userId: writer.userId != null ? String(writer.userId) : null,
        provider: PROVIDER,
        sessionId,
        sessionName: sessionSummary,
        stopReason: 'aborted',
      });
      settled = true;
      return { sessionId: capturedSessionId, success: true, aborted: true };
    };

    try {
      const handle = await manager.acquire(sessionKey, {
        cwd,
        resumeProviderSessionId: providerSessionId,
        skipPermissions: permissionMode === 'bypassPermissions',
      });
      release = () => manager.release(sessionKey, handle);
      capturedSessionId = handle.sessionId;

      // agy's session/load replays the whole conversation history as live
      // session/update frames (probes: dozens of tool frames plus every old
      // reply, streaming for a long time). The client already shows that
      // history from its own fetch, so replayed text would glue the previous
      // replies into the new turn's bubble. Guard: buffer resumed-turn text
      // until the transcript tail is known, then consume the replay off the
      // tail with a cursor (`classifyBufferedReplay`/`consumeReplayChunk`) —
      // replay ends at the tail's end, so text past the cursor is always the
      // model's fresh output. A global substring match used to misclassify a
      // short first real chunk that happened to occur anywhere in the tail,
      // dropping it and leaving the client's streamed placeholder unable to
      // reconcile with the persisted row (docs/design/agy回放守卫游标判定.md).
      let replayGuard: {
        tailText: string | null;
        tailReady: boolean;
        bufferText: string;
        mode: 'buffering' | 'replay' | 'live';
        /** How much of the tail the replay has already quoted (`classifyBufferedReplay`/`consumeReplayChunk`). */
        tailCursor: number;
      } | null = handle.continuity === 'resumed'
        ? { tailText: null, tailReady: false, bufferText: '', mode: 'buffering', tailCursor: 0 }
        : null;
      cancellation.signal.throwIfAborted();
      installAcpSessionRouter(sessionKey, context, handle.client);

      writer.setSessionId?.(handle.sessionId);
      if (handle.continuity === 'started' && !providerSessionId && !acpAnnouncedClients.has(handle.client)) {
        acpAnnouncedClients.add(handle.client);
        writer.send(createNormalizedMessage({
          id: generateMessageId(PROVIDER),
          kind: 'session_created',
          newSessionId: handle.sessionId,
          sessionId: handle.sessionId,
          provider: PROVIDER,
          content: `Antigravity session created: ${handle.sessionId}`,
        }));
      }

      // Model and effort resolution, shared with the print path's flag
      // building: the merged catalog decides whether a base model id encodes
      // effort as an id suffix. A catalog lookup failure degrades to raw ids.
      const model = readOptionalString(options.model);
      const effort = readOptionalString(options.effort);
      const catalog = model ? await new Promise<Awaited<ReturnType<ProviderRuntimeContext['getProviderModels']>> | null>((resolve) => {
        const onAbort = () => resolve(null);
        cancellation.signal.addEventListener('abort', onAbort, { once: true });
        void context.getProviderModels().then(resolve, () => resolve(null)).finally(() => {
          cancellation.signal.removeEventListener('abort', onAbort);
        });
      }) : null;
      cancellation.signal.throwIfAborted();
      const resolvedModel = model && catalog
        ? findCatalogOptionForModelString(model, catalog.OPTIONS)
        : null;
      const modelArgs = resolveAntigravityModelArgs(
        model,
        effort ?? resolvedModel?.labelTier ?? undefined,
        resolvedModel?.option,
      );

      // Only launch flags can enable bypass mode. A mode change must be
      // acknowledged before the engine can receive the prompt.
      const targetMode = permissionMode === 'acceptEdits' ? 'accept-edits'
        : permissionMode === 'plan' ? 'plan'
        : permissionMode === 'default' ? 'default'
        : null;
      if (!targetMode && permissionMode !== 'bypassPermissions') {
        throw new Error(`Antigravity does not support permission mode ${permissionMode}`);
      }
      if (targetMode) {
        if (!handle.availableModeIds.includes(targetMode)) {
          throw new Error(`Antigravity ACP did not offer permission mode ${targetMode}`);
        }
        // A slash command or a previous turn can change the engine's mode.
        await handle.client.request('session/set_mode', { sessionId: handle.sessionId, modeId: targetMode });
      }
      cancellation.signal.throwIfAborted();

      // Model selection, best effort: agy's ACP model ids carry the effort
      // tier as a suffix, so the catalog-resolved family and tier are joined
      // and matched against the session's available list; an unknown
      // combination keeps the engine's current model. The real-engine
      // acceptance pass verifies the switch actually takes effect.
      if (modelArgs.model) {
        const candidates = [
          modelArgs.effort ? `${modelArgs.model}-${modelArgs.effort}` : null,
          modelArgs.model,
        ].filter((id): id is string => Boolean(id));
        const target = handle.availableModelIds.length > 0
          ? candidates.find((id) => handle.availableModelIds.includes(id)) ?? null
          : null;
        if (target && handle.currentModelId !== target) {
          try {
            await handle.client.request('session/set_model', { sessionId: handle.sessionId, modelId: target });
            handle.currentModelId = target;
          } catch (error) {
            if (handle.client.isClosed()) throw error;
            console.warn(`[AntigravityAcp] set_model ${target} failed; keeping ${handle.currentModelId}:`, error);
          }
        }
      }

      cancellation.signal.throwIfAborted();
      // The run writer already publishes to the session channel. Once the
      // run settles, use the session publisher for late cards and retractions.
      const cardWriter = {
        send: (frame: NormalizedMessage) => {
          if (settled && context.publishSessionEvent) context.publishSessionEvent(sessionKey, frame);
          else writer.send(frame);
        },
      };

      // The permission bridge: agy parks the tool on this JSON-RPC request
      // and waits for the gateway's decision or the card's own expiry.
      handle.client.handleServerRequest('session/request_permission', (request) => {
        if (cancellation.signal.aborted) return { outcome: { outcome: 'cancel' } };
        const params = readObjectRecord(request.params);
        const toolCall = readObjectRecord(params?.toolCall) ?? {};
        const toolCallId = readOptionalString(toolCall.toolCallId) ?? `req_${request.id}`;
        const optionList = Array.isArray(params?.options) ? params.options : [];
        const allowOption = optionList
          .map((option) => readObjectRecord(option))
          .find((option) => option?.kind === 'allow_once');
        const requestId = generateMessageId('acp_perm');
        const toolName = readOptionalString(toolCall.name) ?? 'tool';
        const cardInput = toolCall.args ?? toolCall.rawInput ?? {};
        const cardContext = {
          title: readOptionalString(toolCall.title) ?? undefined,
          kind: readOptionalString(toolCall.kind) ?? undefined,
          locations: Array.isArray(toolCall.locations) ? toolCall.locations : undefined,
          diff: Array.isArray(toolCall.content) ? toolCall.content : undefined,
        };
        const requestFrame = createNormalizedMessage({
          id: generateMessageId(PROVIDER),
          kind: 'permission_request',
          requestId,
          toolName,
          toolId: toolCallId,
          input: cardInput,
          context: cardContext,
          canInterrupt: true,
          sessionId: capturedSessionId,
          provider: PROVIDER,
        });
        cardHold += 1;
        clearWatchdog();
        return new Promise((resolveAnswer) => {
          antigravityAcpCards.add({
            requestId,
            sessionId: sessionKey,
            frameSessionId: capturedSessionId,
            toolName,
            toolId: toolCallId,
            input: cardInput,
            context: cardContext,
            receivedAt: new Date(),
            writer: cardWriter,
            settle: (outcome) => {
              cardHold -= 1;
              // A settled run must not re-arm a watchdog nobody will clear
              // (this settle can fire from the finally's retraction after an
              // abnormal exit).
              if (!settled) touchWatchdog();
              const optionId = readOptionalString(allowOption?.optionId);
              if (outcome.allow && optionId) {
                resolveAnswer({ outcome: { outcome: 'selected_once', optionId } });
              } else {
                resolveAnswer({ outcome: { outcome: 'cancel' } });
              }
            },
          });
          cardWriter.send(requestFrame);
        });
      });

      const translator = new AntigravityAcpTranslator();
      translator.setSessionId(capturedSessionId);

      // Subagent wiring: ACP frames never carry an agent's conversation id,
      // so cards, registry entries and transcript tails bind from the parent
      // transcript's spawn receipt — the same source history reads. Prints'
      // step_update events carried the ids live; here a poll bridges the gap.
      const pendingSpawnCalls = new Map<string, { specs: ReturnType<typeof readInvokedAgentSpecs> }>();
      const boundSpawnIds = acpBoundSpawnIds.get(capturedSessionId) ?? new Set<string>();
      acpBoundSpawnIds.set(capturedSessionId, boundSpawnIds);
      const isDaemonCommandCall = (message: NormalizedMessage): boolean =>
        message.toolName === 'run_command'
        && readObjectRecord(message.toolInput)?.IsDaemon === true
        && !antigravityBackgroundWork.get(sessionKey, String(message.toolId));
      const outstandingBackgroundWork = (): boolean =>
        pendingSpawnCalls.size > 0
        || antigravityBackgroundWork.list().some((entry) => entry.sessionId === sessionKey && entry.tasks.length > 0);
      const historyReader = new AntigravitySessionsProvider();
      if (replayGuard) {
        void (async () => {
          try {
            const history = await historyReader.fetchHistory(capturedSessionId, { limit: 6 });
            const tail = history.messages
              .slice(-4)
              .map((message) => String(message.content ?? ''))
              .filter((text) => text.length > 0)
              .join('\n')
              .slice(-12_000);
            if (replayGuard) {
              replayGuard.tailText = tail;
              replayGuard.tailReady = true;
            }
          } catch (error) {
            console.warn('[AntigravityAcp] transcript tail for the replay guard unavailable:', error);
            if (replayGuard) replayGuard.tailReady = true;
          }
        })();
      }
      const agentTail = createAgentTranscriptTail({
        readTimeline: async (conversationId) => (await historyReader.fetchHistory(conversationId, {})).messages,
        emit: (message) => { if (!settled) writer.send(message); },
      });

      let reportFingerprint: string | undefined;
      let agentReports = new Map<string, string>();
      let reportsClosed = false;
      let reportRead: Promise<void> | null = null;

      /**
       * One transcript pass that binds unbound spawn calls (new agent ids →
       * cards, registry, tail) and settles agents whose reports arrived —
       * print does both from live events plus the same transcript reads.
       */
      const reconcileSpawnsAndReports = (): Promise<void> => {
        if (reportRead || reportsClosed) return reportRead ?? Promise.resolve();
        reportRead = (async () => {
          try {
            const safeId = sanitizeLeafDirectoryName(handle.sessionId, 'antigravity session id');
            const compact = getAntigravityTranscriptCandidates(safeId).find((candidate) => fsSync.existsSync(candidate));
            if (!compact) return;
            const files = [compact, path.join(path.dirname(compact), 'transcript_full.jsonl')];
            const stamps = await Promise.all(files.map(async (file) => {
              try {
                const stat = await fsp.stat(file);
                return [file, stat.size, stat.mtimeMs];
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [file, null];
                throw error;
              }
            }));
            const fingerprint = JSON.stringify(stamps);
            if (fingerprint === reportFingerprint) {
              // Metadata unchanged; cached receipts already applied below.
            } else {
              reportFingerprint = fingerprint;
              const rows = await readCanonicalAntigravityTranscript(handle.sessionId);
              if (reportsClosed) return;
              const contents = rows.flatMap(({ entry }) => {
                if (entry.status !== 'DONE' || entry.source === 'USER_EXPLICIT' || entry.type === 'USER_INPUT') return [];
                const content = readOptionalString(entry.content) ?? '';
                return Array.from(content.matchAll(/<SYSTEM_MESSAGE>\s*([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/gi), (match) => match[1]);
              });
              const receiptIds = contents
                .filter((content) => SPAWN_RECEIPT_PATTERN.test(content))
                .flatMap((receipt) => parseCreatedSubagentIds(receipt));
              // Multiple parallel spawn calls would share one receipt; ids
              // bind FIFO in creation order (parallel spawns over ACP are
              // rare, and the receipt itself does not name its call). A call
              // whose receipt has not landed yet stays pending for the next
              // poll instead of being dropped.
              for (const [callToolId, { specs }] of [...pendingSpawnCalls.entries()]) {
                let boundForCall = 0;
                while (receiptIds.length > 0) {
                  const conversationId = receiptIds.shift()!;
                  if (boundSpawnIds.has(conversationId)) continue;
                  boundSpawnIds.add(conversationId);
                  const spec = specs[0];
                  const toolUseId = `${callToolId}:${conversationId}`;
                  antigravityBackgroundWork.start(sessionKey, {
                    taskId: conversationId,
                    toolUseId,
                    taskType: LOCAL_AGENT_TASK_TYPE,
                    description: spec?.role ?? 'Subagent',
                  });
                  agentTail.follow(conversationId, toolUseId);
                  writer.send(createTaskStatusMessage(
                    {
                      provider: PROVIDER,
                      sessionId: capturedSessionId,
                      taskId: conversationId,
                      toolUseId,
                      taskType: LOCAL_AGENT_TASK_TYPE,
                    },
                    { event: 'started', description: spec?.role },
                  ));
                  // The Agent card, keyed the way history keys it, so a
                  // refresh rebuilds the same row.
                  writer.send(createAntigravityAgentRow({
                    sessionId: capturedSessionId,
                    toolId: buildAntigravityAgentToolId(callToolId, conversationId),
                    spec: spec ?? {},
                  }));
                  boundForCall += 1;
                }
                if (boundForCall > 0) pendingSpawnCalls.delete(callToolId);
              }
              agentReports = readAgentReports(contents);
            }

            // Agents that reported are done: one task_status per report, the
            // same judgement history applies at refresh.
            for (const [agentId] of agentReports) {
              if (reportsClosed) return;
              const task = antigravityBackgroundWork.get(sessionKey, agentId);
              if (!task) continue;
              await agentTail.stop(agentId);
              if (reportsClosed || !antigravityBackgroundWork.end(sessionKey, agentId)) continue;
              writer.send(createTaskStatusMessage(
                {
                  provider: PROVIDER,
                  sessionId: capturedSessionId,
                  taskId: agentId,
                  toolUseId: task.toolUseId,
                  taskType: LOCAL_AGENT_TASK_TYPE,
                },
                { event: 'notification', status: 'completed' },
              ));
              broadcastBackgroundTasks();
            }
          } catch (error) {
            console.warn('[AntigravityAcp] Could not reconcile spawn receipts and agent reports:', error);
          }
        })().finally(() => { reportRead = null; });
        return reportRead;
      };

      const reportTimer = setInterval(() => { void reconcileSpawnsAndReports(); }, AGENT_REPORT_POLL_INTERVAL_MS);
      reportTimer.unref();

      /**
       * The question the engine parked the turn on, if any. agy ends the turn
       * with a pending ask; the card rides the pending-permission flow (the
       * AskUserQuestion panel answers it through the shared resolve path),
       * and the run stays parked here until the answer arrives — the answer
       * turn then continues on this run's writer.
       */
      const seenQuestions = new Set<string>();
      const askAcknowledgements = new Map<string, string>();
      let pendingAskCallId: string | null = null;
      let replyText = '';
      const pendingAskHolder: { current: Promise<AcpCardOutcome> | null } = { current: null };
      acpLiveRunPumps.add(sessionKey);
      unsubscribe = handle.client.onNotification((notification) => {
        if (notification.method !== 'session/update') return;
        const params = readObjectRecord(notification.params);
        if (params?.sessionId !== handle.sessionId) return;
        touchWatchdog();
        const update = readObjectRecord(params.update);
        const updateKind = readOptionalString(update?.sessionUpdate);
        const toolCallId = readOptionalString(update?.toolCallId);
        if (toolCallId && (updateKind === 'tool_call' || updateKind === 'tool_call_update')) {
          const toolStatus = readOptionalString(update?.status);
          if (toolStatus === 'completed' || toolStatus === 'failed' || toolStatus === 'cancelled') {
            openToolCalls.delete(toolCallId);
          } else {
            openToolCalls.add(toolCallId);
          }
        }
        // The live context occupancy: usage_update frames carry the session's
        // used tokens directly (the response usage sums the whole turn and
        // would overstate the context — the same accounting the print path
        // applies between step usage and the result).
        if (readOptionalString(update?.sessionUpdate) === 'usage_update' && typeof update?.used === 'number') {
          lastContextReading = { used: update.used, inputTokens: 0, outputTokens: 0 };
        }
        const translation = translator.translate(notification);
        for (const message of translation.messages) {
          // Replay-guard buffering: resumed sessions replay history text
          // before the model's real output; hold the text until the guard
          // can tell them apart.
          if (
            replayGuard
            && !replayGuard.tailReady
            && message.kind === 'stream_delta'
            && typeof message.content === 'string'
          ) {
            replayGuard.bufferText += message.content;
            continue;
          }
          if (replayGuard && message.kind === 'stream_delta' && typeof message.content === 'string' && message.content) {
            if (replayGuard.mode === 'buffering' && replayGuard.tailReady) {
              // Tail known: the buffered text is replay when its ending
              // aligns with the transcript tail (the replay ends there);
              // otherwise it was the model's real prose that arrived while
              // the tail was being read.
              const bufferedVerdict = classifyBufferedReplay(replayGuard.tailText, replayGuard.bufferText);
              if (bufferedVerdict.verdict === 'replay') {
                replayGuard.mode = 'replay';
                replayGuard.tailCursor = bufferedVerdict.nextCursor;
                replayGuard.bufferText = '';
              } else {
                replayGuard.mode = 'live';
                writer.send(createNormalizedMessage({
                  id: generateMessageId(PROVIDER),
                  kind: 'stream_delta',
                  content: replayGuard.bufferText,
                  sessionId: capturedSessionId,
                  provider: PROVIDER,
                }));
                replyText += replayGuard.bufferText;
                rememberSessionReplyPreview(sessionKey, replyText);
                replayGuard.bufferText = '';
              }
            }
            if (replayGuard && replayGuard.mode === 'replay') {
              const chunkVerdict = consumeReplayChunk(replayGuard.tailText, replayGuard.tailCursor, message.content);
              if (chunkVerdict.verdict === 'replay') {
                replayGuard.tailCursor = chunkVerdict.nextCursor;
                continue;
              }
              replayGuard.mode = 'live'; // first novel chunk: live from here
            }
            if (replayGuard && replayGuard.mode === 'live') {
              replayGuard = null; // everything after is the model's real output
            }
          }
          // The engine's own ask_question result does not match the
          // acknowledgement format the question card folds, so the live card
          // would keep showing unanswered radio options after the user
          // picked answers. Rewrite it with the exact acknowledgement text
          // the answer prompt carried.
          if (message.kind === 'tool_result' && askAcknowledgements.has(String(message.toolId))) {
            const ack = askAcknowledgements.get(String(message.toolId));
            askAcknowledgements.delete(String(message.toolId));
            if (!message.isError) {
              message.content = ack ?? '';
            }
          }
          writer.send(message);
          // The terminal push carries the run's last reply text. antigravity
          // streams reply prose as stream_delta rows, which the shared
          // writer-side capture (text rows only) never sees, so the runtime
          // records the accumulated reply itself. A closed segment (the
          // translator emits stream_end where a tool step or any non-text
          // update splits the prose) ends the accumulator, so the registry
          // keeps the LAST segment — what the text-row engines' capture ends
          // up holding for the same reply shape.
          if (message.kind === 'stream_end') {
            replyText = '';
          }
          if (message.kind === 'stream_delta' && typeof message.content === 'string' && message.content) {
            replyText += message.content;
            rememberSessionReplyPreview(sessionKey, replyText);
          }
          // Backgrounded commands (run_command IsDaemon) are tracked like
          // subagents: the strip shows them while they run, their completion
          // settles the strip entry, and an end_turn that leaves one
          // outstanding holds the run open (drain below) — without this a
          // daemon-only wait looked like a finished turn on the client.
          if (message.kind === 'tool_use' && isDaemonCommandCall(message)) {
            const callId = String(message.toolId);
            if (!antigravityBackgroundWork.get(sessionKey, callId)) {
              const input = readObjectRecord(message.toolInput);
              antigravityBackgroundWork.start(sessionKey, {
                taskId: callId,
                toolUseId: callId,
                taskType: LOCAL_BASH_TASK_TYPE,
                description: readOptionalString(input?.toolSummary)
                  ?? readOptionalString(input?.CommandLine)
                  ?? 'Background command',
              });
              broadcastBackgroundTasks();
            }
          }
          if (message.kind === 'tool_result' && !message.isError && antigravityBackgroundWork.get(sessionKey, String(message.toolId))?.taskType === LOCAL_BASH_TASK_TYPE) {
            const callId = String(message.toolId);
            const task = antigravityBackgroundWork.get(sessionKey, callId);
            if (task && antigravityBackgroundWork.end(sessionKey, callId)) {
              writer.send(createTaskStatusMessage(
                {
                  provider: PROVIDER,
                  sessionId: capturedSessionId,
                  taskId: callId,
                  toolUseId: task.toolUseId,
                  taskType: LOCAL_BASH_TASK_TYPE,
                },
                { event: 'notification', status: 'completed' },
              ));
              broadcastBackgroundTasks();
            }
          }
          if (message.kind === 'tool_result' && message.isError && antigravityBackgroundWork.get(sessionKey, String(message.toolId))?.taskType === LOCAL_BASH_TASK_TYPE) {
            const callId = String(message.toolId);
            const task = antigravityBackgroundWork.get(sessionKey, callId);
            if (task && antigravityBackgroundWork.end(sessionKey, callId)) {
              writer.send(createTaskStatusMessage(
                {
                  provider: PROVIDER,
                  sessionId: capturedSessionId,
                  taskId: callId,
                  toolUseId: task.toolUseId,
                  taskType: LOCAL_BASH_TASK_TYPE,
                },
                { event: 'notification', status: 'failed' },
              ));
              broadcastBackgroundTasks();
            }
          }
        }
        if (translation.spawnStarted) pendingSpawnCalls.set(translation.spawnStarted.toolCallId, { specs: translation.spawnStarted.specs });
        if (translation.spawnSettled) pendingSpawnCalls.delete(translation.spawnSettled.toolCallId);
        const pendingTool = translation.toolPending;
        const cardToolName = pendingTool?.cardToolName;
        if (pendingTool?.toolName === QUESTION_TOOL_NAME && cardToolName) {
          const { toolCallId, cardInput } = pendingTool;
          if (!pendingAskHolder.current && !seenQuestions.has(toolCallId) && !cancellation.signal.aborted) {
            seenQuestions.add(toolCallId);
            pendingAskCallId = toolCallId;
            const requestId = generateMessageId('acp_ask');
            const questionFrame = createNormalizedMessage({
              id: generateMessageId(PROVIDER),
              kind: 'permission_request',
              requestId,
              toolName: cardToolName,
              toolId: toolCallId,
              input: cardInput,
              context: undefined,
              canInterrupt: false,
              sessionId: capturedSessionId,
              provider: PROVIDER,
            });
            cardHold += 1;
            clearWatchdog();
            // The engine echoes the question text as a message chunk beside
            // the card; hold those chunks until the answer prompt goes out.
            translator.holdQuestionEcho();
            pendingAskHolder.current = new Promise<AcpCardOutcome>((resolveAnswer) => {
              antigravityAcpCards.add({
                requestId,
                sessionId: sessionKey,
                frameSessionId: capturedSessionId,
                toolName: cardToolName,
                toolId: toolCallId,
                input: cardInput,
                receivedAt: new Date(),
                writer: cardWriter,
                settle: (outcome) => {
                  cardHold -= 1;
                  if (!settled) touchWatchdog();
                  resolveAnswer(outcome);
                },
              });
            });
            cardWriter.send(questionFrame);
          }
        }
        if (translation.spawnStarted) void reconcileSpawnsAndReports();
      });

      finishAgentTails = async (): Promise<void> => {
        if (reportsClosed) return;
        reportsClosed = true;
        clearInterval(reportTimer);
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.all([reportRead, agentTail.stopAll()]),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                console.warn('[AntigravityAcp] Final agent transcript reads did not finish in time; settling without them.');
                resolve();
              }, AGENT_TAIL_FINAL_READ_TIMEOUT_MS);
            }),
          ]);
        } catch (error) {
          console.error('[AntigravityAcp] Failed to finish agent transcript tails:', error);
        } finally {
          clearTimeout(timer);
        }
      };

      // The turn travels as one text block with the same attachment tags the
      // print path embeds, so prompt contents stay identical between modes.
      const hasAttachments =
        normalizeAttachmentDescriptors(options.images).length > 0
        || normalizeAttachmentDescriptors(options.files).length > 0;
      const promptWithAttachments = appendFilesInputTag(
        appendImagesInputTag(command || '', options.images),
        options.files,
      );

      const settleAgentsAtTurnEnd = (judge: 'transcript' | 'stopped') => {
        const outstanding = antigravityBackgroundWork.list().find((entry) => entry.sessionId === sessionKey)?.tasks ?? [];
        for (const task of outstanding) {
          writer.send(createTaskStatusMessage(
            {
              provider: PROVIDER,
              sessionId: capturedSessionId,
              taskId: task.taskId,
              toolUseId: task.toolUseId,
              taskType: LOCAL_AGENT_TASK_TYPE,
            },
            { event: 'notification', status: judge === 'stopped' ? 'stopped' : judgeAntigravityAgent(task.taskId) },
          ));
        }
        antigravityBackgroundWork.clearSession(sessionKey);
      };

      stopAbortedOutput = async () => {
        const closed = translator.closeOpenSegment();
        if (closed) writer.send(closed);
        await finishAgentTails?.();
        if (antigravityBackgroundWork.hasSession(sessionKey)) {
          settleAgentsAtTurnEnd('stopped');
          broadcastBackgroundTasks();
        }
      };

      touchWatchdog();

      if (!(command && command.trim()) && !hasAttachments) {
        // Nothing to run (parity: the print path exits its process at once).
        if (!completeSent) {
          completeSent = true;
          writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: capturedSessionId, exitCode: 0 }));
        }
        settled = true;
        return { sessionId: capturedSessionId, success: true };
      }

      const promptFailure: { error: Error | null } = { error: null };
      const sendPrompt = (text: string) => {
        cancellation.signal.throwIfAborted();
        touchWatchdog();
        return handle.client.request('session/prompt', {
          sessionId: handle.sessionId,
          prompt: [{ type: 'text', text }],
        }).catch((error: Error) => {
          promptFailure.error = error;
          return null;
        });
      };
      let promptPromise = sendPrompt(promptWithAttachments);

      type AcpRaceOutcome =
        | { ended: 'response'; result: unknown }
        | { ended: 'exit'; info: { code: number | null; signal: NodeJS.Signals | null } };
      const awaitTurnEnd = (): Promise<AcpRaceOutcome> =>
        Promise.race([
          promptPromise.then((result) => ({ ended: 'response' as const, result })),
          handle.client.whenExit().then((info) => ({ ended: 'exit' as const, info })),
        ]);

      /**
       * Fails the run once its frames and notifications have gone out. Always
       * throws, so callers fall into the catch's settled short-circuit.
       */
      const settleTurnFailure = async (description: string): Promise<never> => {
        clearWatchdog();
        const failure = watchdogExpired
          ? `Antigravity CLI produced no output for ${idleTimeout} and was terminated.`
          : description;
        const closed = translator.closeOpenSegment();
        if (closed) writer.send(closed);
        await finishAgentTails?.();
        settleAgentsAtTurnEnd('stopped');
        if (!completeSent) {
          completeSent = true;
          writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: capturedSessionId, exitCode: 1 }));
        }
        writer.send(createNormalizedMessage({
          id: generateMessageId(PROVIDER),
          kind: 'error',
          content: failure,
          sessionId: capturedSessionId,
          provider: PROVIDER,
          isError: true,
        }));
        notifyRunFailed({
          userId: writer.userId != null ? String(writer.userId) : null,
          provider: PROVIDER,
          sessionId,
          sessionName: sessionSummary,
          error: failure,
        });
        settled = true;
        throw new Error(failure);
      };

      /**
       * Fails the run after the engine died mid-turn — shared by the first
       * race, the answer rounds and the parked question, which all race
       * against the same exit. Delegates to {@link settleTurnFailure}, which
       * always throws; callers throw their own unreachable guard after it.
       */
      const settleFromEngineExit = async (info: { code: number | null; signal: NodeJS.Signals | null }): Promise<void> => {
        const failure = promptFailure.error?.message ?? `Antigravity CLI exited (code: ${info.code ?? info.signal}).`;
        await settleTurnFailure(failure);
      };

      // The turn loop: each round races the prompt response against an engine
      // exit, and an end_turn that parked on a question holds the run until
      // the card answers — the answer prompt continues on this same run, so
      // its frames stream through the writer that showed the card.
      let race = await awaitTurnEnd();
      let wasCancelled = false;
      let endedWithEndTurn = false;
      let resultUsage = { used: 0, inputTokens: 0, outputTokens: 0 };
      for (;;) {
        if (cancellation.signal.aborted && (race.ended === 'exit' || promptFailure.error)) {
          cancellation.signal.throwIfAborted();
        }
        if (race.ended === 'exit') {
          await settleFromEngineExit(race.info);
          throw new Error('unreachable: settleFromEngineExit always throws');
        }

        // The engine answered the prompt itself with a JSON-RPC error (auth
        // expired, conversation gone, overloaded) while staying alive: the
        // user's message would otherwise vanish into a success-shaped settle.
        if (promptFailure.error instanceof Error) {
          await settleTurnFailure(promptFailure.error.message);
          throw new Error('unreachable: settleTurnFailure always throws');
        }

        clearWatchdog();
        const response = readObjectRecord(race.result);
        const stopReason = readOptionalString(response?.stopReason);
        wasCancelled = stopReason === 'cancelled';
        endedWithEndTurn = stopReason === 'end_turn';

        // Any stop reason outside the two known ones (an engine upgrade
        // inventing a new terminal state, a refusal) is not a success.
        if (stopReason !== 'end_turn' && stopReason !== 'cancelled') {
          await settleTurnFailure(`Antigravity turn ended unexpectedly (stop reason: ${stopReason ?? 'unknown'}).`);
          throw new Error('unreachable: settleTurnFailure always throws');
        }

        // The response usage is the round's authoritative bill; context stays
        // the last usage_update reading (identical accounting to the print
        // path).
        resultUsage = readAntigravityUsageRecord(response?.usage ?? null);
        if (resultUsage.used > 0 || resultUsage.inputTokens > 0 || resultUsage.outputTokens > 0) {
          runCumulative = { ...resultUsage };
          const contextReading = lastContextReading ?? { ...resultUsage };
          const tokenBudget = {
            used: contextReading.used,
            total: 1048576,
            inputTokens: contextReading.inputTokens,
            outputTokens: contextReading.outputTokens,
            breakdown: { input: contextReading.inputTokens, output: contextReading.outputTokens },
            cumulative: { ...runCumulative },
          };
          writer.send(createNormalizedMessage({
            id: generateMessageId(PROVIDER),
            kind: 'status',
            text: 'token_budget',
            tokenBudget,
            sessionId: capturedSessionId,
            provider: PROVIDER,
          }));
          void persistAntigravityTokenUsage(capturedSessionId, tokenBudget);
        }

        const parkedAsk = pendingAskHolder.current;
        if (stopReason === 'end_turn' && parkedAsk) {
          // Keep the promise even if the gateway already removed the card.
          // A fast answer can arrive before agy returns end_turn.
          const parkRace = await Promise.race([
            parkedAsk.then((outcome) => ({ ended: 'answer' as const, outcome })),
            handle.client.whenExit().then((info) => ({ ended: 'exit' as const, info })),
          ]);
          pendingAskHolder.current = null;
          cancellation.signal.throwIfAborted();
          if (parkRace.ended === 'exit') {
            await settleFromEngineExit(parkRace.info);
            throw new Error('unreachable: settleFromEngineExit always throws');
          }
          const outcome = parkRace.outcome;
          translator.releaseQuestionEcho();
          const settledAskCallId = pendingAskCallId;
          pendingAskCallId = null;
          const denialText = formatQuestionAnswers({});
          if (settledAskCallId) askAcknowledgements.set(settledAskCallId, denialText);
          if (outcome.expired || !outcome.allow) {
            // Denied or timed out: the engine's next input would be read as
            // the answer, so tell it the user declined and let it finish on
            // its own judgment instead of leaving the ask parked under the
            // session. The judgment turn streams here and settles the run.
            promptPromise = sendPrompt(denialText);
            race = await awaitTurnEnd();
            continue;
          }
          const updatedInput = outcome.updatedInput;
          const answerText = updatedInput && typeof updatedInput === 'object' && 'answers' in (updatedInput as AnyRecord)
            ? formatQuestionAnswers((updatedInput as AnyRecord).answers)
            : outcome.message?.trim() || 'Continue.';
          // The answer travels as the next prompt; the engine folds it into
          // the parked ask and continues the same conversation, so this loop
          // round streams the continuation's frames through the same writer.
          translator.releaseQuestionEcho();
          if (settledAskCallId) askAcknowledgements.set(settledAskCallId, answerText);
          promptPromise = sendPrompt(answerText);
          race = await awaitTurnEnd();
          continue;
        }

        break;
      }

      // agy's ACP prompt response does not wait for spawned subagents the
      // way print mode does: the model may yield end_turn while its reviewer
      // agents are still running, and their reports (plus the parent's own
      // follow-up prose) keep arriving on the stream afterwards. When spawn
      // calls or bound agents are still outstanding, hold the run open until
      // the report reconciliation empties the registry — print's
      // wait-for-agents behaviour, adapted to the early end_turn. The engine
      // keeps streaming during the drain, so the watchdog stays armed and an
      // abort or engine exit ends it immediately.
          if (!wasCancelled && endedWithEndTurn && outstandingBackgroundWork()) {
        console.info(`[AntigravityAcp] end_turn with outstanding background work; draining session ${sessionKey}`);
        while (
          outstandingBackgroundWork()
          && !handle.client.isClosed()
          && !cancellation.signal.aborted
        ) {
          // A daemon wait is silent by design; each poll counts as activity
          // so the idle watchdog cannot kill a long background run (Godot
          // import + full regression suites routinely outlast 30 quiet
          // minutes). A truly wedged daemon shows as a running strip entry
          // the user can abort.
          touchWatchdog();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, AGENT_REPORT_POLL_INTERVAL_MS);
            timer.unref?.();
          });
        }
        cancellation.signal.throwIfAborted();
        // A short grace for the parent's final summary prose, which trails
        // the last report on the same stream.
        if (!handle.client.isClosed()) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 3_000);
            timer.unref?.();
          });
        }
      }

      const closed = translator.closeOpenSegment();
      if (closed) writer.send(closed);
      await finishAgentTails();
      if (antigravityBackgroundWork.hasSession(sessionKey)) {
        settleAgentsAtTurnEnd('transcript');
        broadcastBackgroundTasks();
      }

      if (wasCancelled || cancellation.signal.aborted) return await finishAborted();
      if (!completeSent) {
        completeSent = true;
        const completeMsg = createCompleteMessage({
          provider: PROVIDER,
          sessionId: capturedSessionId,
          exitCode: 0,
        });
        if (resultUsage.used > 0) completeMsg.tokens = resultUsage.used;
        writer.send(completeMsg);
      }

      notifyRunStopped({
        userId: writer.userId != null ? String(writer.userId) : null,
        provider: PROVIDER,
        sessionId,
        sessionName: sessionSummary,
        stopReason: 'completed',
      });
      settled = true;
      return {
        sessionId: capturedSessionId,
        success: true,
      };
    } catch (error) {
      clearWatchdog();
      // Paths that already reported their failure (exit race, watchdog) mark
      // themselves settled before throwing; only unexpected errors report
      // here, exactly once.
      if (settled) throw error;
      if (cancellation.signal.aborted) return await finishAborted();
      const failure = error instanceof Error ? error.message : String(error);
      writer.send(createNormalizedMessage({
        id: generateMessageId(PROVIDER),
        kind: 'error',
        content: failure,
        sessionId: sessionId ?? null,
        provider: PROVIDER,
        isError: true,
      }));
      if (!completeSent) {
        completeSent = true;
        writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: sessionId ?? null, exitCode: 1 }));
      }
      notifyRunFailed({
        userId: writer.userId != null ? String(writer.userId) : null,
        provider: PROVIDER,
        sessionId,
        sessionName: sessionSummary,
        error: failure,
      });
      settled = true;
      throw error instanceof Error ? error : new Error(failure);
    } finally {
      settled = true;
      clearWatchdog();
      unsubscribe?.();
      try {
        if (release) {
          acpLiveRunPumps.delete(sessionKey);
          acpRoutedTranslators.delete(sessionKey);
          antigravityAcpCards.retractAllForSession(sessionKey, { allow: false, message: 'The turn was closed.' });
          await finishAgentTails?.();
        }
      } finally {
        release?.();
        acpActiveTurns.delete(sessionKey);
      }
    }
  }

  /**
   * Aborts an active Antigravity session.
   */
  async abort(sessionId: string): Promise<boolean> {
    // A resident ACP session aborts through the protocol: pending cards are
    // denied first (a parked question run must wake so it can settle as
    // aborted; an in-flight permission is answered with a cancel), then the
    // in-flight turn is cancelled. The process kill below stays for print
    // runs and for ACP sessions whose engine already died.
    if (isAcpRuntimeEnabled()) {
      const cancellation = acpActiveTurns.get(sessionId);
      const cancelled = acpManagerInstance?.cancelTurn(sessionId);
      cancellation?.abort();
      const settledCards = antigravityAcpCards.retractAllForSession(sessionId, { allow: false, aborted: true }).length;
      if (cancellation || cancelled || settledCards > 0) {
        return true;
      }
    }
    const process = activeProcesses.get(sessionId);
    if (process) {
      console.info(`[AntigravityRuntime] Aborting session: ${sessionId}`);
      abortedProcessKeys.add(sessionId);
      process.kill('SIGTERM');
      activeProcesses.delete(sessionId);
      return true;
    }
    return false;
  }
}

export const antigravityRuntime = new AntigravityRuntimeProvider();
