/**
 * ZCode Runtime Provider
 *
 * Implements IProviderRuntime for ZCode integration using the app-server protocol.
 * Handles session lifecycle, permission mode mapping, message streaming, and run completion.
 *
 * Run state (completion, silence watchdog, abort, permission writers) lives in
 * `zcode-run-lifecycle.ts`; this module is the protocol orchestration around
 * it: resolve/subscribe/configure/send, the event-listener wiring, and the
 * terminal reporting.
 *
 * Protocol facts from the Phase 0 spike:
 * - Events only flow after `session/subscribe` (`deliveryKind:
 *   'desktop-continuous'`); subscribe may fail for inactive sessions (-32004)
 *   and is best-effort.
 * - Prompts and stops go through `v4/command` (`sendText` / `stop`), the
 *   command channel the ZCode app itself uses. The legacy `session/send` and
 *   `session/stop` only know turns `session/send` started, while engine 0.17
 *   also runs turns of its own from queued background-task notifications:
 *   the legacy stop leaves those running and the legacy send loses the
 *   prompt to them. Only a session's very first prompt still uses the legacy
 *   send (see `sendUserMessage`). A command answers with an acknowledgement
 *   whose status says whether the engine took it; turn completion is observed
 *   on the event stream (`turn.completed`), so the send itself has no request
 *   timeout.
 * - The gateway keys aborts by the app-facing session id, which arrives in
 *   `options.sessionId`; the ZCode-native `sess_*` id is resolved/created and
 *   announced back via `writer.setSessionId` plus a `session_created` event.
 *
 * @module zcode-runtime.provider
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { ChatAttachmentDescriptor } from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  SessionBackgroundWork,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage, generateMessageId, readObjectRecord, readOptionalString } from '@/shared/utils.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import {
  LOCAL_AGENT_TASK_TYPE,
  createBackgroundTasksStatusMessage,
  createTaskStatusMessage,
} from '@/modules/providers/shared/background-work/task-status.js';

import { zcodeBackgroundWork } from './zcode-background-work.js';
import { SESSION_LOST_METHOD } from './zcode-codec.js';
import { protocolClient } from './zcode-protocol.client.js';
import {
  isZCodeSubagentLifecycleEvent,
  readZCodeSessionEvent,
  ZCODE_CANCELLED_NOTICE,
  ZCODE_CANCELLED_NOTICE_KEY,
} from './zcode-live-event-normalizer.js';
import { buildZCodeSendModelParams } from './zcode-models.provider.js';
import { EngineSilenceTimeoutError, ZCodeRunLifecycle, resolveSilenceTimeoutMs } from './zcode-run-lifecycle.js';
import type { RunHandle, RunSettle } from './zcode-run-lifecycle.js';

/**
 * Permission mode mapping from CloudCLI to ZCode (§5 of integration plan).
 *
 * Maps the application's permission modes to ZCode's native modes:
 * - default → build (zcode default)
 * - acceptEdits → edit
 * - plan → plan
 * - bypassPermissions → yolo (zcode headless default)
 * - auto → auto
 */
const PERMISSION_MODE_MAP: Record<string, string> = {
  default: 'build',
  acceptEdits: 'edit',
  plan: 'plan',
  bypassPermissions: 'yolo',
  auto: 'auto',
};

/**
 * The ZCode mode last pushed to each engine session, so a follow-up turn only
 * calls `session/setMode` when the configured mode actually changed — see
 * `configureSessionMode` for why re-pushing is harmful. Module-level because a
 * run may be served by a fresh provider instance.
 */
const appliedPermissionModes = new Map<string, string>();

/**
 * How many sessions the mode cache tracks. Evicting the oldest entry only
 * costs one redundant push on that session's next turn, so a plain bound is
 * enough to keep a long-lived server from growing the map forever.
 */
const APPLIED_MODE_CACHE_LIMIT = 500;

function rememberAppliedPermissionMode(sessionId: string, zcodeMode: string): void {
  appliedPermissionModes.delete(sessionId);
  appliedPermissionModes.set(sessionId, zcodeMode);
  while (appliedPermissionModes.size > APPLIED_MODE_CACHE_LIMIT) {
    const oldest = appliedPermissionModes.keys().next();
    if (oldest.done) {
      break;
    }
    appliedPermissionModes.delete(oldest.value);
  }
}

/**
 * The run-lifecycle registry shared by the provider class and the
 * permissions facet below. Module-level like the protocol client singleton:
 * `zcodeRuntimePermissions` must answer request ids that any provider
 * instance's runs bridged, so both facets must see the same registries.
 */
const runLifecycle = new ZCodeRunLifecycle();

/**
 * The subagent lifecycle watcher left on each engine session whose
 * background agents outlived their turn, keyed by ZCode-native session id.
 *
 * A run's own listener leaves with the turn, but a background agent keeps
 * working after `turn_complete`, and its `subagent_stopped` lands on the
 * parent session with nobody listening. The watcher stays on the session for
 * exactly the lifecycle events — nothing else, so it never competes with a
 * run's listener for the stream — until the last tracked agent reports or
 * the next run takes the session over.
 */
const subagentWatchers = new Map<string, (notification: AnyRecord) => void>();

/**
 * Engine sessions this runtime created whose first prompt has not reached
 * the engine yet. The engine writes a created session's row only when its
 * first input arrives through the legacy `session/send`; until then a
 * `sendText` fails its foreign key. Keyed by session rather than by "created
 * in this run": a run can fail after creating the session and before its
 * prompt went out, and the next run then resumes the still-unwritten session.
 */
const sessionsAwaitingFirstPrompt = new Set<string>();

/**
 * ZCode permissions facet: answers the engine's pending
 * `interaction/requestPermission` calls and replays pending cards after a
 * page reload.
 *
 * Consumer: `provider-runtime.service.resolveToolApproval` and
 * `chat.subscribe` (`permissions.listPending`) fan decisions and replays out
 * to every provider's permissions facet; zcode only answers request ids it
 * bridged itself.
 */
export const zcodeRuntimePermissions = {
  resolve(requestId: string, decision: ProviderPermissionDecision): void {
    runLifecycle.resolvePermission(requestId, decision);
  },

  listPending(sessionId: string): unknown[] {
    return runLifecycle.listPendingPermissions(sessionId);
  },
};

/**
 * Attachment item of the v4 `sendText` command (strict schema, engine
 * 0.17.1). The engine maps a `ref` that is not a URI to a local file and
 * picks image/video/pdf/file from `mime`; `fileName`, `mime` and `bytes` are
 * all required.
 */
type ZcodeCommandAttachment = {
  ref: string;
  fileName: string;
  mime: string;
  bytes: number;
};

/**
 * Attachment item of the legacy `session/send` (verified against engine
 * 0.16.5). Its mapper reads `kind`/`filename`/`mimeType`/`sizeBytes` plus one
 * source field and silently DROPS any item it cannot map.
 */
type ZcodeLegacySendAttachment = {
  kind: 'image' | 'video' | 'pdf' | 'audio' | 'file';
  filename: string;
  localPath: string;
  mimeType?: string;
  sizeBytes?: number;
};

/** Derives the legacy send's attachment kind from the descriptor's MIME type. */
function resolveLegacyAttachmentKind(mimeType: string | undefined): ZcodeLegacySendAttachment['kind'] {
  if (!mimeType) {
    return 'file';
  }
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType === 'application/pdf') {
    return 'pdf';
  }
  return 'file';
}

/**
 * Maps app attachment descriptors into the shape of the channel carrying the
 * prompt (see `sendUserMessage`). The gateway (`filterAttachmentsToUploadStore`)
 * only forwards direct children of the upload store, so paths arrive absolute
 * — anything else is dropped here because the engine resolves a relative path
 * against the session workspace and would report a bogus read failure instead
 * of the file. On `sendText`, a descriptor without MIME type or size is sent
 * as a generic file of unknown size, since the schema requires both.
 */
function toEngineAttachments(
  descriptors: ChatAttachmentDescriptor[],
  channel: 'sendText' | 'legacySend',
): Array<ZcodeCommandAttachment | ZcodeLegacySendAttachment> {
  const items: Array<ZcodeCommandAttachment | ZcodeLegacySendAttachment> = [];
  for (const descriptor of descriptors) {
    if (!path.isAbsolute(descriptor.path)) {
      console.warn(`[ZCodeRuntime] Dropping attachment with non-absolute path: ${descriptor.path}`);
      continue;
    }
    const fileName = descriptor.name ?? path.basename(descriptor.path);
    if (channel === 'sendText') {
      items.push({
        ref: descriptor.path,
        fileName,
        mime: descriptor.mimeType || 'application/octet-stream',
        bytes: typeof descriptor.size === 'number' ? descriptor.size : 0,
      });
      continue;
    }
    items.push({
      kind: resolveLegacyAttachmentKind(descriptor.mimeType),
      filename: fileName,
      localPath: descriptor.path,
      ...(descriptor.mimeType ? { mimeType: descriptor.mimeType } : {}),
      ...(typeof descriptor.size === 'number' ? { sizeBytes: descriptor.size } : {}),
    });
  }
  return items;
}

/** How long an abort waits for the engine to admit a prompt still being sent. */
const ABORT_ADMISSION_WAIT_MS = 10_000;

/** Client id the engine records on every command cloudcli issues. */
const ZCODE_COMMAND_CLIENT_ID = 'cloudcli';

/**
 * Issues one `v4/command` and returns its acknowledgement when the engine
 * took it. Any status outside `acceptedStatuses` (`rejected`, `stale`,
 * `failed`, ...) throws with the engine's reason, so a refused command is an
 * error the caller reports instead of a silent no-op.
 */
async function sendZCodeCommand(
  command: { commandId: string; sessionId: string; type: 'sendText' | 'stop'; payload: AnyRecord },
  acceptedStatuses: readonly string[],
  timeoutMs?: number,
): Promise<AnyRecord> {
  const ack = await protocolClient.sendRequest<AnyRecord>('v4/command', {
    commandId: command.commandId,
    clientId: ZCODE_COMMAND_CLIENT_ID,
    sessionId: command.sessionId,
    type: command.type,
    payload: command.payload,
    issuedAt: Date.now(),
  }, timeoutMs);
  const status = readOptionalString(ack?.status);
  if (!status || !acceptedStatuses.includes(status)) {
    const reason = readOptionalString(ack?.message) ?? readOptionalString(ack?.reasonCode) ?? 'no reason given';
    throw new Error(`ZCode ${command.type} ${status ?? 'unacknowledged'}: ${reason}`);
  }
  return ack;
}

/**
 * ZCode Runtime Provider Implementation
 *
 * Manages ZCode session execution using the app-server protocol, handling:
 * - Session creation/resolution
 * - Model and mode configuration
 * - Event subscription, message sending and event streaming
 * - Session abortion and cleanup
 * - Token usage aggregation
 */
export class ZCodeRuntimeProvider implements IProviderRuntime {
  /** execution 模块依赖引擎终态通知和 v4 stop 确认，RPC 失败只发送 error。 */
  readonly supportsTaskExecution = true;
  constructor() {
    // Installed once per process: the bridge is stateless over the lifecycle
    // registries, so a single installation serves every run. (Per-run
    // installation used to overwrite the singleton handler and never restore
    // the default policy.)
    protocolClient.setServerRequestHandler((request) => runLifecycle.handleServerRequest(request));
  }

  /**
   * Executes a command in a ZCode session.
   *
   * Flow per §3.2.3 of integration plan:
   * 1. Resolve existing session via context.resolveProviderSessionId()
   * 2. Create session if needed and announce it back to the gateway
   * 3. Subscribe to session events so the event stream starts flowing
   * 4. Resolve the window's model and reasoning selection for this turn
   * 5. Map permission mode and call session/setMode
   * 6. Send user message (v4 sendText; a new session's first one via session/send)
   * 7. Wait for the run end event, then send exactly one complete with tokens
   */
  async run(
    command: string,
    options: AnyRecord = {},
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<unknown> {
    const appSessionId = readOptionalString(options.sessionId) ?? null;
    const sessionSummary = readOptionalString(options.sessionSummary);

    // Runs before the main try block below; without its own error emission a
    // session/create failure would never reach the chat stream and the page
    // would stay silent (the gateway only logs runtime rejections).
    let zcodeSessionId: string;
    try {
      const resolved = await this.resolveOrCreateSession(appSessionId, options, context, writer);
      zcodeSessionId = resolved.sessionId;
    } catch (error) {
      this.sendRuntimeError(writer, appSessionId, error);
      this.notifyRunOutcome({
        userId: writer.userId,
        sessionId: appSessionId,
        sessionSummary,
        outcome: { failed: true, error },
      });
      throw error;
    }

    // Abort is requested with the app-facing id; fall back to the ZCode id
    // for callers (e.g. tests) that never supplied one.
    const abortKey = appSessionId ?? zcodeSessionId;
    const notifySessionId = appSessionId ?? zcodeSessionId;
    const silenceTimeoutMs = resolveSilenceTimeoutMs();
    const handle = runLifecycle.startRun({ abortKey, sessionId: zcodeSessionId, appSessionId, writer });

    try {
      // The run's listener owns the whole stream from the moment the run
      // starts, lifecycle events included. Stand the previous turn's watcher
      // down and attach it before any await: while the three setup awaits
      // below are pending, an event for this session (a background agent's
      // late stop, a delta) would otherwise reach the watcher — and through
      // it the previous turn's writer — instead of this run's.
      const eventListener = this.createSessionEventListener(handle, writer, context);
      this.standDownSubagentWatcher(zcodeSessionId);
      protocolClient.addSessionListener(zcodeSessionId, eventListener);

      let modelParams: Awaited<ReturnType<ZCodeRuntimeProvider['resolveSendModelParams']>>;
      try {
        await this.subscribeToSessionEvents(zcodeSessionId);
        await this.configureSessionMode(zcodeSessionId, options);
        modelParams = await this.resolveSendModelParams(options, context);
      } catch (error) {
        this.releaseSessionListener(handle, eventListener, writer, context);
        throw error;
      }

      let settle: RunSettle | null = null;
      try {
        handle.promptDispatched = true;
        // A stop that landed during setup found nothing of this run to stop;
        // sending the prompt now would start a turn nothing stops.
        if (!handle.abortRequested) {
          handle.promptSend = this.sendUserMessage(handle, command, options, modelParams);
          await handle.promptSend;
        }
        settle = await runLifecycle.waitForSettle(handle, silenceTimeoutMs);

        if (settle.kind === 'silent') {
          // The engine went quiet, but quiet does not mean dead: it may be
          // grinding on a tool call that emits no live events. Report the
          // stall to the chat stream and hand the still-attached stream to a
          // background watcher instead of tearing the run down — late output
          // keeps streaming and the real completion still reaches the client.
          runLifecycle.detachToWatcher(handle);
          this.sendRuntimeError(writer, zcodeSessionId, new EngineSilenceTimeoutError(settle.timeoutMs));
          this.watchSilentRun({
            handle,
            eventListener,
            writer,
            context,
            silenceTimeoutMs,
            notifySessionId,
            sessionSummary,
          });
          return { sessionId: zcodeSessionId, success: false };
        }

        this.releaseSessionListener(handle, eventListener, writer, context);

        if (settle.kind === 'aborted') {
          // A delivered stop settles the run here: report it as
          // stopped with an `aborted` reason instead of a failure, matching
          // the other runtimes. The complete frame is still emitted so the
          // client ends the turn immediately.
          this.sendCompletionEvent(handle, writer);
          this.notifyRunOutcome({
            userId: writer.userId,
            sessionId: notifySessionId,
            sessionSummary,
            outcome: { failed: false, stopReason: 'aborted' },
          });
          return { sessionId: zcodeSessionId, success: false };
        }

        if (settle.kind === 'completed') {
          this.sendCompletionEvent(handle, writer);
          const completion = runLifecycle.completionOf(handle);
          this.notifyRunOutcome({
            userId: writer.userId,
            sessionId: notifySessionId,
            sessionSummary,
            outcome: completion.failed
              ? { failed: true, error: completion.failedMessage ?? 'ZCode run failed' }
              : { failed: false, stopReason: 'completed' },
          });
          return { sessionId: zcodeSessionId, success: !completion.failed };
        }

        throw new Error('ZCode run was superseded by a newer run for this session');
      } catch (error) {
        this.releaseSessionListener(handle, eventListener, writer, context);

        // Surface the failure to the chat stream before propagating.
        this.sendRuntimeError(writer, zcodeSessionId, error);

        this.notifyRunOutcome({
          userId: writer.userId,
          sessionId: notifySessionId,
          sessionSummary,
          outcome: { failed: true, error },
        });

        throw error;
      }
    } finally {
      // Once detached, the watcher owns the handle's cleanup (see
      // `watchSilentRun`); the run must not reclaim it out from under it.
      if (handle.owner === 'run') {
        context.resetLiveMessageState?.(zcodeSessionId);
        runLifecycle.dispose(handle);
      }
    }
  }

  /**
   * Reports one run's terminal state to the notification channels.
   *
   * Mirrors the terminal-state notifications every other provider runtime
   * emits: completed runs notify as stopped, engine-reported failures and
   * runtime errors as failed, user aborts as stopped with an `aborted`
   * reason. `sessionId` only feeds the notification envelope.
   */
  private notifyRunOutcome(options: {
    userId: string | number | null | undefined;
    sessionId: string | null;
    sessionSummary: string | null | undefined;
    outcome:
      | { failed: false; stopReason: 'completed' | 'aborted' }
      | { failed: true; error: unknown };
  }): void {
    const userId = options.userId != null ? String(options.userId) : null;
    if (options.outcome.failed) {
      notifyRunFailed({
        userId,
        provider: 'zcode',
        sessionId: options.sessionId,
        sessionName: options.sessionSummary,
        error: options.outcome.error,
      });
      return;
    }

    notifyRunStopped({
      userId,
      provider: 'zcode',
      sessionId: options.sessionId,
      sessionName: options.sessionSummary,
      stopReason: options.outcome.stopReason,
    });
  }

  /**
   * Emits a `kind: 'error'` message to the chat stream before a failure
   * propagates out of `run`.
   *
   * `sessionId` only feeds the message envelope — the gateway writer remaps it
   * to the app-facing id — so callers pass whichever id they currently hold.
   */
  private sendRuntimeError(
    writer: ProviderRuntimeWriter,
    sessionId: string | null,
    error: unknown,
  ): void {
    const errorMessage = createNormalizedMessage({
      id: generateMessageId('zcode'),
      sessionId,
      provider: 'zcode',
      kind: 'error',
      isError: true,
      // Both fields carry the text: `content` is what the chat UI renders,
      // `text` is what earlier zcode error consumers read.
      content: error instanceof Error ? error.message : 'Unknown ZCode runtime error',
      text: error instanceof Error ? error.message : 'Unknown ZCode runtime error',
    });
    writer.send(errorMessage);
  }

  /**
   * Aborts an active ZCode session.
   *
   * Issues the v4 `stop` command for the ZCode session mapped to the given
   * app-facing session id (no SIGINT fallback per §3.2.3 - the app-server
   * process is shared across sessions). Unlike the legacy `session/stop`, it
   * stops whatever turn is in the foreground, including one the engine
   * started itself from a queued background notification. `noop` means
   * nothing was running, which leaves nothing to wait for either. Uses
   * protocol-level retry on failure.
   *
   * Only a stop that was actually delivered settles the run as aborted: the
   * run then reports `aborted` and ends promptly. When every stop attempt
   * fails, the run keeps waiting for the engine's real terminal event (the
   * silence watchdog still bounds it) — reporting an abort the engine never
   * performed would hide a turn that is in fact still running.
   *
   * @param sessionId - CloudCLI app session ID to abort
   * @returns boolean indicating if abort was successful
   */
  async abort(sessionId: string): Promise<boolean> {
    const handle = runLifecycle.handleOf(sessionId);

    if (!handle) {
      console.warn(`[ZCodeRuntime] No active session found for ${sessionId}`);
      return false;
    }

    // While the engine is still admitting the prompt (winding a preempted
    // turn down), a stop would hit that turn and the prompt's own turn would
    // start afterwards with nothing to stop it. Let the admission finish
    // first; how the send ended is the run's to report.
    if (handle.promptSend && !handle.promptAcknowledged) {
      let admissionTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([handle.promptSend]),
        // An engine that never acknowledges must not leave the stop button
        // hanging: past the bound, stop whatever is running.
        new Promise<void>((resolve) => { admissionTimer = setTimeout(resolve, ABORT_ADMISSION_WAIT_MS); }),
      ]);
      clearTimeout(admissionTimer);
      if (!runLifecycle.isActiveRun(handle)) {
        return false;
      }
    }

    handle.stopSent = true;
    try {
      await this.callWithRetry(
        async () => {
          await sendZCodeCommand(
            { commandId: randomUUID(), sessionId: handle.sessionId, type: 'stop', payload: {} },
            ['accepted', 'noop'],
          );
        },
        'v4 stop',
        3
      );
    } catch (error) {
      handle.stopSent = false;
      console.error(`[ZCodeRuntime] Failed to abort session ${handle.sessionId}:`, error);
      this.sendRuntimeError(
        handle.writer,
        handle.sessionId,
        new Error(`Failed to stop ZCode session: ${error instanceof Error ? error.message : 'unknown error'}`),
      );
      return false;
    }

    console.info(`[ZCodeRuntime] Aborted session ${handle.sessionId}`);
    runLifecycle.requestAbort(handle);
    return true;
  }

  /**
   * Sessions with spawned agents still running, for the running-sessions
   * poll. The engine outlives turns, so an agent launched in the background
   * keeps working after the turn's `complete` — this is how the sidebar
   * and the activity indicator learn it is still going.
   */
  listBackgroundWork(): SessionBackgroundWork[] {
    return zcodeBackgroundWork.list();
  }

  /**
   * What the composer's strip shows for a session that subscribes, and
   * whether that work can still be stopped: `abort` stops the run on the
   * session, so once the turn has ended its agents keep running with nothing
   * left to cancel. A session whose agents this runtime does not hold is none
   * of its business and answers true.
   */
  readonly backgroundTasks = {
    list: (sessionId: string) => zcodeBackgroundWork.listStripTasks(sessionId),
    canInterrupt: (sessionId: string) => !zcodeBackgroundWork.hasSession(sessionId)
      || Boolean(runLifecycle.handleOf(sessionId)),
  };

  /**
   * Re-sends the composer strip's list for an app session; called after
   * every change to its tracked agents. `canInterrupt` is true while a run
   * is on the session and false once only the lifecycle watcher is left
   * (see `backgroundTasks.canInterrupt`).
   */
  private broadcastBackgroundTasks(
    appSessionKey: string,
    engineSessionId: string | null,
    writer: ProviderRuntimeWriter,
    canInterrupt: boolean,
  ): void {
    writer.send(createBackgroundTasksStatusMessage(
      { provider: 'zcode', sessionId: engineSessionId },
      zcodeBackgroundWork.listStripTasks(appSessionKey),
      canInterrupt,
    ));
  }

  /**
   * Keeps the background-work registry in step with the lifecycle events
   * the stream translated: a spawn registers the agent on the app session,
   * a settled status retires it. `taskId` and `toolUseId` are guaranteed by
   * the normalizer (an event naming neither never becomes a message).
   */
  private recordSubagentLifecycle(
    appSessionKey: string,
    message: NormalizedMessage,
    writer: ProviderRuntimeWriter,
    runOnSession: boolean,
  ): void {
    if (!message.taskId || !message.toolUseId) {
      return;
    }
    if (message.event === 'started') {
      zcodeBackgroundWork.start(appSessionKey, {
        taskId: message.taskId,
        toolUseId: message.toolUseId,
        taskType: message.taskType ?? LOCAL_AGENT_TASK_TYPE,
        description: message.description ?? '',
      });
      this.broadcastBackgroundTasks(appSessionKey, message.sessionId || null, writer, runOnSession);
      return;
    }
    if (message.status === 'completed' || message.status === 'failed' || message.status === 'stopped') {
      if (zcodeBackgroundWork.end(appSessionKey, message.taskId)) {
        this.broadcastBackgroundTasks(appSessionKey, message.sessionId || null, writer, runOnSession);
      }
      // Its unanswered approval cards have nobody left to answer them.
      if (message.sessionId) {
        runLifecycle.retractSubagentPermissions(message.sessionId, message.taskId);
      }
    }
  }

  /**
   * Detaches a run's listener from the engine session and, when agents it
   * launched are still running, leaves the lifecycle watcher behind so their
   * stops still reach the page and retire them from the background list.
   *
   * A superseded run leaves nothing behind: the newer run's listener owns
   * the stream, and a watcher armed beside it would forward every lifecycle
   * event twice.
   */
  private releaseSessionListener(
    handle: RunHandle,
    eventListener: (notification: AnyRecord) => void,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): void {
    protocolClient.removeSessionListener(handle.sessionId, eventListener);
    if (zcodeBackgroundWork.hasSession(handle.abortKey) && runLifecycle.isNewestRunForEngineSession(handle)) {
      this.armSubagentWatcher(handle.sessionId, handle.abortKey, writer, context);
      // The agents outlive the turn with no run left to stop them.
      this.broadcastBackgroundTasks(handle.abortKey, handle.sessionId, writer, false);
    }
  }

  /**
   * Settles every agent the session still tracks as `stopped`, then forgets
   * them. The engine died with its agents, so nothing can report them any
   * more; without this their cards keep spinning for ever. Shared by the
   * run's listener and the lifecycle watcher, whichever hears the engine go.
   */
  private settleAgentsOfLostEngine(appSessionKey: string, engineSessionId: string, writer: ProviderRuntimeWriter): void {
    runLifecycle.retractSubagentPermissions(engineSessionId);
    const outstanding = zcodeBackgroundWork.clearSession(appSessionKey);
    if (outstanding.length > 0) {
      this.broadcastBackgroundTasks(appSessionKey, engineSessionId, writer, false);
    }
    for (const task of outstanding) {
      writer.send(createTaskStatusMessage(
        { provider: 'zcode', sessionId: engineSessionId, taskId: task.taskId, toolUseId: task.toolUseId, taskType: LOCAL_AGENT_TASK_TYPE },
        { event: 'notification', status: 'stopped' },
      ));
    }
  }

  /**
   * Installs (or re-installs, on the latest run's writer) the narrow
   * listener that forwards only subagent lifecycle events while the session
   * has agents outstanding. It stands itself down once the last one reports,
   * or when the engine dies and takes the agents with it.
   */
  private armSubagentWatcher(
    zcodeSessionId: string,
    appSessionKey: string,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): void {
    this.standDownSubagentWatcher(zcodeSessionId);

    const watcher = (notification: AnyRecord): void => {
      try {
        const method = readOptionalString(notification.method);
        if (method === SESSION_LOST_METHOD) {
          this.settleAgentsOfLostEngine(appSessionKey, zcodeSessionId, writer);
          this.standDownSubagentWatcher(zcodeSessionId);
          return;
        }
        if (method && method !== 'session/event') {
          return;
        }

        // Only lifecycle events pass: the watcher must never normalize the
        // rest of the stream, whose state belongs to the next run.
        const event = readZCodeSessionEvent(notification.params ?? notification, zcodeSessionId);
        if (!event || !isZCodeSubagentLifecycleEvent(event.type)) {
          return;
        }

        // Same exit as the run's listener, so a lifecycle event becomes the
        // same frame whoever hears it.
        for (const message of context.normalizeMessage(notification.params ?? notification, zcodeSessionId)) {
          if (message.kind !== 'task_status') {
            continue;
          }
          this.recordSubagentLifecycle(appSessionKey, message, writer, false);
          writer.send(message);
        }
        if (!zcodeBackgroundWork.hasSession(appSessionKey)) {
          this.standDownSubagentWatcher(zcodeSessionId);
        }
      } catch (error) {
        console.error('[ZCodeRuntime] Error processing subagent lifecycle event:', error);
      }
    };

    subagentWatchers.set(zcodeSessionId, watcher);
    protocolClient.addSessionListener(zcodeSessionId, watcher);
    // The agents may still ask for approval; their cards go to this writer.
    runLifecycle.adoptIdleTarget(zcodeSessionId, { writer, appSessionId: appSessionKey });
  }

  private standDownSubagentWatcher(zcodeSessionId: string): void {
    const watcher = subagentWatchers.get(zcodeSessionId);
    if (!watcher) {
      return;
    }
    subagentWatchers.delete(zcodeSessionId);
    protocolClient.removeSessionListener(zcodeSessionId, watcher);
    runLifecycle.releaseIdleTarget(zcodeSessionId);
  }

  /**
   * Optional permission gateway (first version uses mode mapping only).
   *
   * Per §3.2.3: first version uses mode mapping instead of per-tool approval.
   * ZCode headless defaults to yolo mode. Can map toolsSettings to protocol
   * equivalents in future (Phase 0.1 to confirm structure).
   */
  permissions?: undefined;

  /**
   * Resolves existing session or creates new one.
   *
   * Implements session resolution flow from §3.2.3:
   * 1. Resolve existing session via context.resolveProviderSessionId() with
   *    the app-facing session id
   * 2. Resume it engine-side — an engine restart orphans its in-memory
   *    sessions while the DB mapping survives, and a send against an orphaned
   *    session fails with -32004 "Session is not active"
   * 3. When the session is gone engine-side entirely (resume fails), create a
   *    replacement session for the run's workspace and report it back to the
   *    gateway (setSessionId plus a session_created event, matching the
   *    claude-runtime pattern). `writer.setSessionId` updates the stored
   *    mapping, so the replacement is sticky across subsequent sends.
   *
   * ZCode 0.16.9 validates all session requests strictly. Resume sends only
   * the session id, while create sends only the workspace descriptor.
   */
  private async resolveOrCreateSession(
    appSessionId: string | null,
    options: AnyRecord,
    context: ProviderRuntimeContext,
    writer: ProviderRuntimeWriter,
  ): Promise<{ sessionId: string; resumed: boolean }> {
    const existingSessionId = appSessionId
      ? context.resolveProviderSessionId(appSessionId)
      : null;

    if (options.strictResume === true && !existingSessionId) {
      throw new Error('原会话缺少引擎映射，拒绝创建替代会话');
    }

    if (existingSessionId) {
      const resumed = await this.tryResumeSession(existingSessionId);
      if (resumed) {
        console.debug(`[ZCodeRuntime] Resumed existing session: ${existingSessionId}`);
        await this.repairSessionModelSelection(existingSessionId, resumed, options, context);
        return { sessionId: existingSessionId, resumed: true };
      }
      if (options.strictResume === true) {
        throw new Error('原会话已丢失，拒绝创建替代会话');
      }
      console.info(
        `[ZCodeRuntime] Session ${existingSessionId} is no longer available engine-side; creating a replacement session`
      );
    }

    // No spawn-cwd fallback: the server's own cwd is the pnpm virtual store
    // of the deployed build, and a session created there gets indexed by the
    // synchronizer as a garbage project. A run without a workspace is a
    // caller bug — fail it visibly instead.
    const workspacePath = readOptionalString(options.workspacePath)
      ?? readOptionalString(options.cwd);
    if (!workspacePath) {
      throw new Error('ZCode session needs a workspace: the run carried neither workspacePath nor cwd.');
    }

    console.info(`[ZCodeRuntime] Creating new session for workspace: ${workspacePath}`);

    try {
      const result = await protocolClient.sendRequest<AnyRecord>(
        'session/create',
        {
          workspace: {
            workspacePath,
            workspaceKey: workspacePath,
          },
        }
      );

      const newSessionId = readOptionalString(result?.sessionId)
        ?? readOptionalString((result?.session as AnyRecord)?.id)
        ?? readOptionalString((result?.session as AnyRecord)?.sessionId);

      if (!newSessionId) {
        throw new Error('session/create returned no sessionId');
      }

      writer.setSessionId?.(newSessionId);
      sessionsAwaitingFirstPrompt.add(newSessionId);

      const sessionCreatedEvent = createNormalizedMessage({
        id: generateMessageId('zcode'),
        sessionId: newSessionId,
        provider: 'zcode',
        kind: 'session_created',
        content: `Session created: ${newSessionId}`,
      });
      writer.send(sessionCreatedEvent);

      console.info(`[ZCodeRuntime] Created new session: ${newSessionId}`);
      return { sessionId: newSessionId, resumed: false };
    } catch (error) {
      console.error('[ZCodeRuntime] Failed to create session:', error);
      throw new Error(`Failed to create ZCode session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Attempts to reactivate an existing session engine-side.
   *
   * An engine process restart forgets its in-memory sessions, so a stored
   * `provider_session_id` can point at a session the current engine no longer
   * considers active. `session/resume` reloads it from ZCode's own database.
   *
   * Returns the engine's resume response on success (its
   * `settings.model.current` tells the caller whether the session kept a
   * usable model selection), or null when the session is gone engine-side.
   *
   * Only "session is gone" failures (-32004, method missing on older engines)
   * justify falling back to a replacement session: anything else (timeouts,
   * transport errors) must propagate so the run surfaces the real cause
   * instead of silently forking a fresh session on every send.
   */
  private async tryResumeSession(sessionId: string): Promise<AnyRecord | null> {
    try {
      const response = await protocolClient.sendRequest<AnyRecord>('session/resume', { sessionId });
      return response ?? {};
    } catch (error) {
      const code = (error as AnyRecord | undefined)?.code;
      const message = error instanceof Error ? error.message : String(error);
      const sessionGone = code === -32004
        || /not active|not found|does not exist/i.test(message)
        || code === -32601; // engine without session/resume support
      if (!sessionGone) {
        throw error;
      }
      console.warn(`[ZCodeRuntime] Session ${sessionId} is gone engine-side (${message}); will create a replacement`);
      return null;
    }
  }

  /**
   * Repairs the engine-side session model selection after a resume.
   *
   * The engine keeps a per-session model selection, and subagent spawns
   * resolve their model from it: a spawn against a session without one fails
   * with "Cannot start subagent: No model selected / 未选择模型
   * [reason=selection-missing]" even though the main turn carries its own
   * per-turn `modelSelection`. Resume restores that selection from the
   * engine's database but silently drops it when the current engine's
   * registry cannot validate the stored selection. It can also keep a valid
   * legacy provider selection while this turn resolves to a native account
   * provider. A resumed session never receives the default selection a fresh
   * create would.
   *
   * The resume response carries `settings.model.current` when the session
   * has a usable selection. Re-apply this run's resolved model when that
   * selection is missing or differs, so the next subagent spawn inherits
   * the same provider as the main turn. Best-effort by design: a refused repair
   * must not block the send — the turn itself still carries its per-turn
   * selection; only subagent spawns would keep failing.
   */
  private async repairSessionModelSelection(
    sessionId: string,
    resumeResponse: AnyRecord | undefined,
    options: AnyRecord,
    context: ProviderRuntimeContext,
  ): Promise<void> {
    const settings = readObjectRecord(resumeResponse?.settings);
    const model = readObjectRecord(settings?.model);
    const current = readObjectRecord(model?.current);
    const modelParams = await this.resolveSendModelParams(options, context);
    const selection = modelParams?.modelSelection;
    if (!selection) {
      console.debug(
        `[ZCodeRuntime] Session ${sessionId} has no engine-side model selection and this run resolves no model; subagent spawns may fail with selection-missing until a modeled send.`
      );
      return;
    }
    const currentOptions = readObjectRecord(current?.options);
    if (readOptionalString(current?.providerId) === selection.providerId
        && readOptionalString(current?.modelId) === selection.modelId
        && readOptionalString(currentOptions?.reasoningLevel) === selection.options?.reasoningLevel) {
      return;
    }

    try {
      // A short timeout: the repair is an optimization, not a prerequisite —
      // a wedged engine must not hold the send hostage for the default
      // request timeout when the turn itself is ready to go.
      await protocolClient.sendRequest('session/setModel', {
        sessionId,
        model: selection,
      }, 5000);
      console.info(`[ZCodeRuntime] Repaired session model selection for ${sessionId} -> ${selection.providerId}/${selection.modelId}`);
    } catch (error) {
      console.warn(`[ZCodeRuntime] Failed to repair model selection for session ${sessionId}:`, error);
    }
  }

  /**
   * Subscribes to the session's event stream.
   *
   * `session/subscribe` with `deliveryKind: 'desktop-continuous'` is what
   * turns on `session/event` notifications (Phase 0.1 validation). It can
   * legitimately fail for inactive sessions (-32004), so failures are logged
   * and the run continues - the completion wait falls back to its timeout.
   */
  private async subscribeToSessionEvents(sessionId: string): Promise<void> {
    try {
      await protocolClient.sendRequest('session/subscribe', {
        sessionId,
        deliveryKind: 'desktop-continuous',
      });
      console.debug(`[ZCodeRuntime] Subscribed to events for session ${sessionId}`);
    } catch (error) {
      console.warn(`[ZCodeRuntime] Subscribe failed for session ${sessionId}:`, error);
    }
  }

  /**
   * Configures session permission mode using mapping from §5.
   *
   * Maps CloudCLI permission modes to ZCode modes and calls session/setMode —
   * but only when the mode is actually new to the session, because the engine
   * owns the live mode from there on. ZCode persists it per session
   * (`session.permission`) and the model moves the session into plan mode by
   * itself mid-turn; a per-turn reassertion of the configured mode cancels
   * that plan mode between turns, and the model's next `ExitPlanMode` then
   * fails with "can only be used while plan mode is active" instead of raising
   * the approval card — an error the model is free to misread as approval.
   *
   * The cache lives in the process, so the first send after a server restart
   * pushes again (and can still cancel a plan mode entered before the
   * restart). That is the deliberate trade: a cold cache must not swallow a
   * mode the user changed while the server was down.
   */
  private async configureSessionMode(
    sessionId: string,
    options: AnyRecord,
  ): Promise<void> {
    const permissionMode = readOptionalString(options.permissionMode) ?? 'default';

    const zcodeMode = PERMISSION_MODE_MAP[permissionMode] ?? 'build';

    if (appliedPermissionModes.get(sessionId) === zcodeMode) {
      return;
    }

    try {
      await protocolClient.sendRequest('session/setMode', {
        sessionId,
        mode: zcodeMode,
      });

      rememberAppliedPermissionMode(sessionId, zcodeMode);
      console.debug(`[ZCodeRuntime] Set mode for session ${sessionId}: ${permissionMode} → ${zcodeMode}`);
    } catch (error) {
      console.warn(`[ZCodeRuntime] Failed to set mode ${zcodeMode} for session ${sessionId}:`, error);
      // Continue with default mode
    }
  }

  /**
   * Sends the user's prompt, tagged with a fresh input id that the engine
   * copies onto the turn it starts (`turn.started`/`turn.completed` payload
   * `inputId`). The id is recorded on the handle before sending so the
   * listener can recognise the turn as this run's.
   *
   * The prompt normally goes out as a v4 `sendText` command. `startNow` makes
   * it take over at once: when the engine is busy with a turn it started
   * itself (a queued background-task notification — the gateway never lets
   * two cloudcli runs share a session), that turn is cancelled and the
   * prompt's turn starts. `keepQueueAndSend` leaves the other queued
   * notifications in place, to be delivered afterwards. A refused command
   * throws instead of vanishing.
   *
   * The first prompt of a session this runtime created goes through the
   * legacy `session/send` instead (`sessionsAwaitingFirstPrompt`): the engine
   * writes a new session's row only when its first input arrives through
   * that path, and `sendText` on an unwritten session fails with a
   * foreign-key error (engine 0.17.1). A session that never ran a turn has no
   * background work, so no engine-started turn can compete with the prompt.
   *
   * No request timeout: the acknowledgement only comes once a preempted turn
   * has wound down, and the turn itself completes on the event stream.
   * `modelSelection`/`modelExecution` are optional on both channels: when the
   * local config cannot build them the engine runs the turn on its own
   * default model.
   */
  private async sendUserMessage(
    handle: RunHandle,
    command: string,
    options: AnyRecord,
    modelParams: ReturnType<typeof buildZCodeSendModelParams>,
  ): Promise<void> {
    const channel = sessionsAwaitingFirstPrompt.has(handle.sessionId) ? 'legacySend' : 'sendText';
    const attachments = Array.isArray(options.attachments)
      ? toEngineAttachments(options.attachments as ChatAttachmentDescriptor[], channel)
      : [];
    const inputId = randomUUID();
    handle.promptInputId = inputId;

    try {
      if (channel === 'legacySend') {
        await protocolClient.sendRequest('session/send', {
          sessionId: handle.sessionId,
          content: command,
          inputId,
          ...(modelParams ?? {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        }, 0);
        sessionsAwaitingFirstPrompt.delete(handle.sessionId);
      } else {
        await sendZCodeCommand({
          commandId: inputId,
          sessionId: handle.sessionId,
          type: 'sendText',
          payload: {
            text: command,
            requestedDelivery: 'startNow',
            heldQueueDisposition: 'keepQueueAndSend',
            ...(modelParams ?? {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          },
        }, ['accepted'], 0);
      }
      handle.promptAcknowledged = true;
      console.debug(`[ZCodeRuntime] Sent message to session ${handle.sessionId} via ${channel}`);
    } catch (error) {
      console.error(`[ZCodeRuntime] Failed to send message to session ${handle.sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Resolves the chat window's model and reasoning controls into the per-turn
   * `modelSelection`/`modelExecution` fields for `sendText`, or null to
   * let the engine's default model take the turn.
   *
   * Explicit composer values win, followed by the app session's saved values
   * and finally the provider catalog default. The model config supplies its
   * own default reasoning level when the window has no explicit selection.
   * A model that cannot be resolved into a complete executable selection is
   * not a send-blocking error — both fields are optional in 0.16.9 (verified
   * live) — so it degrades to a plain send with a warning.
   */
  private async resolveSendModelParams(
    options: AnyRecord,
    context: ProviderRuntimeContext,
  ): Promise<ReturnType<typeof buildZCodeSendModelParams>> {
    const appSessionId = readOptionalString(options.sessionId);
    const requestedModel = readOptionalString(options.model)
      ?? await context.resolveResumeModel(appSessionId ?? undefined, undefined)
      ?? (await context.getProviderModels()).DEFAULT;
    if (!requestedModel?.trim()) {
      return null;
    }

    let requestedEffort = readOptionalString(options.effort);
    if ((!requestedEffort || requestedEffort === 'default') && appSessionId) {
      const sessionRow = sessionsDb.getSessionById(appSessionId);
      if (sessionRow?.effort && sessionRow.effort !== 'default') {
        requestedEffort = sessionRow.effort;
      }
    }

    const modelParams = buildZCodeSendModelParams(
      requestedModel,
      requestedEffort && requestedEffort !== 'default' ? requestedEffort : undefined,
    );
    if (!modelParams) {
      console.warn(
        `[ZCodeRuntime] Model ${requestedModel} is not fully configured in cli/config.json; sending without a per-turn model selection so the engine default applies.`,
      );
    }
    return modelParams;
  }

  /**
   * Whose turn an engine event belongs to: this run's (`own`), another turn
   * (`foreign`), or not yet decidable (`undecided`).
   *
   * The run claims its turn from the first event whose `inputId` is the
   * prompt's input id (`turn.started`, or `turn.completed` if the start was
   * missed); once claimed, every other turn id is foreign, and so is any
   * event naming another input. Before the claim, a turn-tagged event naming
   * no input is undecided: it is a preempted turn winding down if it came
   * before the engine acknowledged the prompt, and the prompt's own turn
   * failing before it announced itself if it came after. Events without a
   * turn id (session-level, or engines that do not tag turns) are always
   * `own`, keeping the first-terminal-event rule for them.
   */
  private classifyTurnEvent(
    handle: RunHandle,
    event: ReturnType<typeof readZCodeSessionEvent>,
  ): 'own' | 'foreign' | 'undecided' {
    const turnId = event?.turnId;
    if (!event || !turnId) {
      return 'own';
    }
    const inputId = readOptionalString(event.payload.inputId);
    if (handle.promptInputId && inputId === handle.promptInputId) {
      handle.ownTurnId = turnId;
      return 'own';
    }
    if (handle.ownTurnId) {
      return turnId === handle.ownTurnId ? 'own' : 'foreign';
    }
    if (inputId !== undefined) {
      return 'foreign';
    }
    return handle.promptAcknowledged ? 'own' : 'undecided';
  }

  /**
   * Applies one normalized message of this run's own turn: a completion or a
   * terminal error settles the run (a cancelled completion while a stop is in
   * flight settles it as the abort), everything else streams to the writer.
   */
  private deliverRunMessage(
    handle: RunHandle,
    message: NormalizedMessage,
    sessionEvent: ReturnType<typeof readZCodeSessionEvent>,
    writer: ProviderRuntimeWriter,
  ): void {
    if (message.kind === 'complete') {
      // The stop just sent cancelled this turn: settle as the abort it
      // is, even though the acknowledgement has not arrived yet.
      if (handle.stopSent && readOptionalString(sessionEvent?.payload.resultType) === 'cancelled') {
        runLifecycle.requestAbort(handle);
        return;
      }
      runLifecycle.recordCompletion(handle, message.tokens);
      return;
    }

    if (message.kind === 'error') {
      // A terminal error can outlive its run: the engine's cancelled
      // echo (or any late turn.failed) may arrive after this run
      // settled and a newer run already owns the session. Attributing
      // it to the live run would fail or finish someone else's turn.
      if (!runLifecycle.isActiveRun(handle)) {
        return;
      }
      if (message.isCancelledError) {
        // A cancelled model request is not an engine failure. When the
        // user's own stop is on record the echo is expected noise —
        // drop the frame and let the settle wait report the abort. An
        // engine-side cancellation the user did not ask for degrades
        // to a quiet transcript line and ends the run as a non-failure
        // instead of a red error bubble plus a "run failed" notice.
        if (handle.abortRequested) {
          return;
        }
        writer.send(createNormalizedMessage({
          // Derived from the engine event this notice reports, so a
          // replayed run re-announces the same row instead of a new one.
          id: `${message.id}_cancelled_notice`,
          sessionId: handle.sessionId,
          provider: 'zcode',
          kind: 'task_notification',
          summary: ZCODE_CANCELLED_NOTICE,
          summaryKey: ZCODE_CANCELLED_NOTICE_KEY,
          status: 'interrupted',
        }));
        runLifecycle.recordCompletion(handle);
        return;
      }
      // Terminal error events (turn.failed / fatal) end the turn; mark
      // the run completed-as-failed so the settle wait and the final
      // complete message reflect it instead of timing out after 10 min.
      runLifecycle.recordEngineError(handle, readOptionalString(message.text) ?? undefined);
    }

    if (message.kind === 'task_status') {
      this.recordSubagentLifecycle(handle.abortKey, message, writer, true);
    }

    writer.send(message);
  }

  /**
   * Creates session event listener for normalizing protocol events to writer.
   *
   * Normalization goes through `context.normalizeMessage` (bound to the
   * provider's sessions facet) so live events and SQLite history share one
   * mapping. Internal `complete` messages only record token usage; the final
   * complete is emitted once by `sendCompletionEvent`.
   */
  private createSessionEventListener(
    handle: RunHandle,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): (notification: AnyRecord) => void {
    return (notification: AnyRecord) => {
      try {
        const method = readOptionalString(notification.method);

        // A newer run on this engine session owns the stream and forwards
        // every event itself; this one lingers only until its own wait notices
        // it was superseded (a poll tick away), and anything it forwarded in
        // that gap would reach its writer a second time. The engine's death is
        // the exception: it must still release this run's wait. The newest
        // run settles the agents, because they belong on its writer.
        if (!runLifecycle.isNewestRunForEngineSession(handle)) {
          if (method === SESSION_LOST_METHOD) {
            runLifecycle.recordSessionLost(handle, readOptionalString(
              (notification.params as Record<string, unknown> | undefined)?.stderrTail,
            ));
          }
          return;
        }

        // Any notification from the engine for this session is a sign of
        // life: refresh the silence-watchdog stamp before anything else.
        runLifecycle.recordActivity(handle);

        // Synthetic client-originated notification: the engine process died,
        // so this session no longer exists engine-side. Mark the run failed
        // (once) so the settle wait returns instead of timing out against a
        // dead engine.
        if (method === SESSION_LOST_METHOD) {
          const stderrTail = readOptionalString(
            (notification.params as Record<string, unknown> | undefined)?.stderrTail,
          );
          runLifecycle.recordSessionLost(handle, stderrTail);
          this.settleAgentsOfLostEngine(handle.abortKey, handle.sessionId, writer);
          return;
        }

        if (method && method !== 'session/event') {
          console.debug(`[ZCodeRuntime] Received non-session notification: ${method}`);
          return;
        }

        const rawEvent = notification.params ?? notification;
        const sessionEvent = readZCodeSessionEvent(rawEvent, handle.sessionId);
        const turnOwner = this.classifyTurnEvent(handle, sessionEvent);
        const normalizedMessages: NormalizedMessage[] = context.normalizeMessage(rawEvent, handle.sessionId);

        for (const message of normalizedMessages) {
          const terminal = message.kind === 'complete' || message.kind === 'error';
          // The run listens from its start, but until its prompt is out a
          // turn-ending event can only belong to the turn before it. After
          // that, the end of a turn the engine started itself (one the prompt
          // preempted, or one that ran before the prompt's turn began) is not
          // this run's end either, nor its error.
          if (terminal && (!handle.promptDispatched || turnOwner === 'foreign')) {
            continue;
          }
          if (terminal && turnOwner === 'undecided') {
            // The engine's acknowledgement may sit in the same batch of output
            // as this event, and the send only records it once that batch has
            // been handled. Decide then: still unclaimed after the
            // acknowledgement means this run's turn failed early; anything
            // else was the preempted turn.
            setImmediate(() => {
              if (!handle.promptAcknowledged || handle.ownTurnId) {
                return;
              }
              try {
                this.deliverRunMessage(handle, message, sessionEvent, writer);
              } catch (error) {
                console.error(`[ZCodeRuntime] Error processing session event:`, error);
              }
            });
            continue;
          }
          this.deliverRunMessage(handle, message, sessionEvent, writer);
        }
      } catch (error) {
        console.error(`[ZCodeRuntime] Error processing session event:`, error);
      }
    };
  }

  /**
   * Background continuation for a run that hit the engine-silence watchdog.
   *
   * `run` has already reported the stall to the chat stream and resolved; this
   * watcher keeps the session's event listener attached so any late engine
   * output still streams to the client, then performs the run's real terminal
   * handling (complete event + outcome notification + run-state cleanup) when
   * the engine eventually finishes, dies (session-lost), or is aborted.
   *
   * A second full silence window (engine alive but hung for good) gives up:
   * the stall is reported again and the run is failed. If a newer run claims
   * the session first, the watcher stands down and only detaches its
   * listener — the new run owns the stream and the completion.
   */
  private watchSilentRun(options: {
    handle: RunHandle;
    eventListener: (notification: AnyRecord) => void;
    writer: ProviderRuntimeWriter;
    context: ProviderRuntimeContext;
    silenceTimeoutMs: number;
    notifySessionId: string | null;
    sessionSummary: string | undefined;
  }): void {
    const {
      handle, eventListener, writer, context,
      silenceTimeoutMs, notifySessionId, sessionSummary,
    } = options;

    void (async () => {
      try {
        const settle = await runLifecycle.waitForSettle(handle, silenceTimeoutMs);

        if (settle.kind === 'superseded') {
          // A newer run replaced this one: it owns the stream and the
          // completion from here on, so this watcher only detaches its
          // listener (in the finally).
          return;
        }

        if (settle.kind === 'silent') {
          // Still silent for another full window: report and give up on the
          // live stream. If the engine ever wakes after this, its output only
          // lands in the session history (visible on refresh).
          const error = new EngineSilenceTimeoutError(settle.timeoutMs);
          this.sendRuntimeError(writer, handle.sessionId, error);
          this.notifyRunOutcome({
            userId: writer.userId,
            sessionId: notifySessionId,
            sessionSummary,
            outcome: { failed: true, error },
          });
          return;
        }

        if (settle.kind === 'aborted') {
          // User-requested abort while detached: same contract as the
          // attached abort path — complete frame + aborted notification.
          this.sendCompletionEvent(handle, writer);
          this.notifyRunOutcome({
            userId: writer.userId,
            sessionId: notifySessionId,
            sessionSummary,
            outcome: { failed: false, stopReason: 'aborted' },
          });
          return;
        }

        this.sendCompletionEvent(handle, writer);
        const completion = runLifecycle.completionOf(handle);
        this.notifyRunOutcome({
          userId: writer.userId,
          sessionId: notifySessionId,
          sessionSummary,
          outcome: completion.failed
            ? { failed: true, error: completion.failedMessage ?? 'ZCode run failed' }
            : { failed: false, stopReason: 'completed' },
        });
      } finally {
        this.releaseSessionListener(handle, eventListener, writer, context);
        if (runLifecycle.isActiveRun(handle)) {
          context.resetLiveMessageState?.(handle.sessionId);
          runLifecycle.dispose(handle);
        }
      }
    })();
  }

  /**
   * Sends completion event with aggregated token usage.
   *
   * Ensures exactly ONE complete event per run per §3.2.3 requirements.
   * The shared `complete` envelope carries success/exit semantics; the run's
   * total used-token count rides the `tokens` field.
   */
  private sendCompletionEvent(
    handle: RunHandle,
    writer: ProviderRuntimeWriter,
  ): void {
    const completion = runLifecycle.completionOf(handle);

    const completeMessage = createCompleteMessage({
      provider: 'zcode',
      sessionId: handle.sessionId,
      exitCode: completion.failed ? 1 : 0,
    });
    if (typeof completion.tokenUsage === 'number') {
      completeMessage.tokens = completion.tokenUsage;
    }

    writer.send(completeMessage);
    console.debug(`[ZCodeRuntime] Sent completion event for session ${handle.sessionId}`);
  }

  /**
   * Calls protocol method with retry on failure.
   *
   * Protocol-level retry per §3.2.3 for operations like the v4 stop.
   */
  private async callWithRetry(
    fn: () => Promise<void>,
    operation: string,
    maxRetries: number = 3,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await fn();
        return;
      } catch (error) {
        if (attempt === maxRetries) {
          throw error;
        }
        console.warn(`[ZCodeRuntime] ${operation} attempt ${attempt} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
}

/**
 * Singleton instance of the ZCode runtime provider.
 * Consumer: zcode provider class (exposed as the provider's runtime facet).
 * `permissions` wires the permission bridge into the chat gateway's
 * `chat.permission-response` flow (see `zcodeRuntimePermissions` above).
 */
export const zcodeRuntime: IProviderRuntime = Object.assign(
  new ZCodeRuntimeProvider(),
  { permissions: zcodeRuntimePermissions },
);
