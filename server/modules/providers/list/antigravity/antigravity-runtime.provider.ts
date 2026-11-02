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

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors,
} from '@/shared/image-attachments.js';
import {
  LOCAL_AGENT_TASK_TYPE,
  createBackgroundTasksStatusMessage,
  createTaskStatusMessage,
} from '@/modules/providers/shared/background-work/task-status.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  ActiveBackgroundTask,
  AnyRecord,
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

import { getAntigravityDataRoot, getAntigravityTranscriptCandidates } from './antigravity-data-root.js';
import { tryResolveEnginePath } from './antigravity-engine-path.js';
import { createAgentTranscriptTail } from './antigravity-agent-tail.js';
import { AntigravitySessionsProvider } from './antigravity-sessions.provider.js';
import { readCanonicalAntigravityTranscript } from './antigravity-transcript.provider.js';
import { antigravityBackgroundWork, extractAntigravitySubagents, judgeAntigravityAgent, readAgentReports } from './antigravity-subagent.js';
import {
  findCatalogOptionForModelString,
  resolveAntigravityModelArgs,
} from './antigravity-model-effort.js';

const PROVIDER = 'antigravity';

/**
 * Persists token usage snapshot into session's brain directory for offline / reloaded queries.
 */
async function persistAntigravityTokenUsage(sessionId: string, tokenBudget: unknown): Promise<void> {
  try {
    const safeId = sanitizeLeafDirectoryName(sessionId, 'antigravity session id');
    const brainDir = path.join(getAntigravityDataRoot(), 'brain', safeId);
    if (fsSync.existsSync(brainDir)) {
      const usageFile = path.join(brainDir, 'token_usage.json');
      await fsp.writeFile(usageFile, JSON.stringify(tokenBudget, null, 2), 'utf8');
    }
  } catch {
    // Best-effort persistence
  }
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

export class AntigravityRuntimeProvider implements IProviderRuntime {
  readonly backgroundTasks = {
    list: (sessionId: string) => getAntigravityBackgroundTasksForSession(sessionId),
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
    // The merged catalog decides whether a base model id encodes effort as an
    // id suffix. A catalog lookup failure must degrade to flag-based effort,
    // never block the run.
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

          // Extract and broadcast token budget from step_update or result
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
            const inputTokens = Number(usageRecord.input_tokens ?? usageRecord.inputTokens ?? usageRecord.prompt_tokens ?? 0) || 0;
            const outputTokens = Number(usageRecord.output_tokens ?? usageRecord.outputTokens ?? usageRecord.completion_tokens ?? usageRecord.candidates_tokens ?? 0) || 0;
            const used = Number(usageRecord.total_tokens ?? usageRecord.totalTokens ?? (inputTokens + outputTokens)) || 0;
            if (used > 0 || inputTokens > 0 || outputTokens > 0) {
              const tokenBudget = {
                used,
                total: 1048576,
                inputTokens,
                outputTokens,
                breakdown: {
                  input: inputTokens,
                  output: outputTokens,
                },
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
        env: { ...process.env },
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
   * Aborts an active Antigravity session.
   */
  async abort(sessionId: string): Promise<boolean> {
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
