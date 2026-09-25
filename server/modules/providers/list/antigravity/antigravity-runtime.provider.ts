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
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
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

import { getAntigravityDataRoot } from './antigravity-data-root.js';
import { tryResolveEnginePath } from './antigravity-engine-path.js';
import {
  resolveAntigravityModelArgs,
  splitModelEffortSuffix,
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
 * hung. 30 minutes leaves room for a deep subagent review to think between
 * events while still bounding a wedged process.
 *
 * The value is passed to `agy --print-timeout` too, but that flag is inert
 * under `--input-format stream-json` (measured: a run with
 * `--print-timeout 20s` stayed alive long past its result event and only
 * exited when stdin closed). The CLI therefore offers no upper bound of its
 * own and the watchdog below is the real one.
 */
const DEFAULT_PRINT_TIMEOUT = '30m';

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
 * How much of the child's stderr is retained for failure reporting. agy
 * writes actionable errors (auth failures, bad flags, quota) to stderr only;
 * the tail is what the user sees when the run fails.
 */
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
          ? `Antigravity CLI produced no output for ${printTimeout} and was terminated.`
          : code === null
            ? 'Antigravity CLI terminated by signal.'
            : `Antigravity CLI exited with code ${code}`;
        const stderr = stderrTail.trim();
        return stderr ? `${base}\nstderr:\n${stderr}` : base;
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
      };

      const enginePath = tryResolveEnginePath();
      if (!enginePath) {
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

      const printTimeout = readOptionalString(options.printTimeout)
        ?? process.env.CLOUDCLI_ANTIGRAVITY_PRINT_TIMEOUT
        ?? DEFAULT_PRINT_TIMEOUT;

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
        args.push('--print-timeout', printTimeout);
      }

      // Resume existing conversation
      if (providerSessionId) {
        args.push('--conversation', providerSessionId);
      }

      // Model configuration and reasoning effort share one resolution: the
      // merged-catalog entry for the model's base id decides the channel —
      // variant-family ids get their tier appended, cataloged models without
      // effort support run with their id verbatim, and models missing from
      // the catalog (custom ones) take the --effort flag. The lookup by base
      // id also validates legacy suffixed ids from old session rows against
      // the family's real tiers.
      const requestedBase = model ? splitModelEffortSuffix(model).base : undefined;
      const modelArgs = resolveAntigravityModelArgs(
        model,
        effort,
        catalog?.OPTIONS.find((option) => option.value === requestedBase),
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

          // Context occupancy comes from step_update usage only: each one
          // reports a single model call, i.e. the live context size. The
          // result event's usage sums every call of the turn and would
          // overstate the context (easily past 100%) in agentic loops.
          const stepUpdateRecord = readObjectRecord(rawRecord?.step_update);
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

            // A finished turn releases the stdin that was holding the CLI
            // open: agy exits on EOF and `close` settles the run. An
            // interrupted-stream result is deliberately excluded — agy has
            // injected its own continuation prompt and is still working, so
            // closing stdin here would EOF the CLI mid-task and resurrect the
            // very "async work silently killed" bug stdin ownership exists to
            // prevent. Its eventual real result closes stdin instead, and the
            // watchdog bounds the wait if that result never comes.
            if (!(isError && isStreamInterruptedNotice(errorMessage))) {
              closeStdinTurn();
            }

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
      const watchdogMs = parseGoDurationMs(printTimeout) ?? parseGoDurationMs(DEFAULT_PRINT_TIMEOUT) ?? 0;
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
            `[AntigravityRuntime] No output for ${printTimeout}; terminating wedged run ${processKey}`,
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

      agyProcess.on('close', (code: number | null) => {
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

        if (!completeSent) {
          completeSent = true;
          writer.send(createCompleteMessage({
            provider: PROVIDER,
            sessionId: capturedSessionId || sessionId || null,
            exitCode: code ?? 0,
          }));
        }

        // A SIGTERM from abort() closes with code null after the chat gateway
        // already completed the run: resolve quietly and notify 'aborted'
        // instead of reporting a failure or a completion.
        const wasAborted = abortedProcessKeys.delete(processKey);
        if (wasAborted) {
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
        if (!watchdogExpired && (code === 0 || (streamInterruptedResult && !sawErrorResult))) {
          settleOnce(() => resolve({ sessionId: capturedSessionId || sessionId, success: true }));
        } else {
          settleOnce(() => reject(new Error(describeFailure(code))));
        }
      });

      agyProcess.on('error', (err: Error) => {
        clearWatchdog();
        activeProcesses.delete(processKey);
        console.error('[Antigravity CLI error]:', err);

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
