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
 * - `session/send` takes `content` (not `message`). Its own response returns
 *   immediately and says nothing about the turn; turn completion is observed
 *   on the event stream (`turn.completed`), so the send request itself is
 *   issued without a request timeout.
 * - The gateway keys aborts by the app-facing session id, which arrives in
 *   `options.sessionId`; the ZCode-native `sess_*` id is resolved/created and
 *   announced back via `writer.setSessionId` plus a `session_created` event.
 *
 * @module zcode-runtime.provider
 */

import fsSync from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { ChatAttachmentDescriptor } from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  ProviderTokenUsageResult,
} from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage, generateMessageId, readObjectRecord, readOptionalString } from '@/shared/utils.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { sessionsDb } from '@/modules/database/index.js';

import { SESSION_LOST_METHOD } from './zcode-codec.js';
import { protocolClient } from './zcode-protocol.client.js';
import { readZCodeContextUsage } from './zcode-context-usage.js';
import { getZCodeDatabasePath } from './zcode-data-root.js';
import { ZCODE_CANCELLED_NOTICE, ZCODE_CANCELLED_NOTICE_KEY } from './zcode-live-event-normalizer.js';
import { ingestZCodeModelCatalog, readZCodeSessionModelInfoFromDb, resolveZCodeModelDefaultReasoningLevel, resolveZCodeModelRef } from './zcode-models.provider.js';
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
/**
 * Shortest gap between two mid-turn `token_budget` frames. Each frame costs one
 * read-only read of the engine store, and tool results arrive in bursts (one per
 * parallel call), so the refresh is bounded on the way in rather than on the
 * number of events.
 */
const LIVE_CONTEXT_MIN_INTERVAL_MS = 1500;

/**
 * How long the engine may take to accept a `session/compact` request. The
 * response carries a session snapshot but no turn result, so this only bounds
 * the acceptance handshake — the summarization that follows is watched through
 * the session's event stream like any other turn.
 */
const COMPACT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Reads one session's current context occupancy straight from the engine store.
 *
 * The runtime cannot ask the engine for this mid-turn (no usage event exists
 * before `turn.completed`), but every finished step is already persisted with
 * its own request usage. Returns null when the store or session is unreadable,
 * and never throws into an event listener.
 *
 * Consumers: `ZCodeRuntimeProvider.publishLiveContextUsage`.
 */
function readZCodeSessionContextUsage(providerSessionId: string): ProviderTokenUsageResult | null {
  const dbPath = getZCodeDatabasePath();
  if (!providerSessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return readZCodeContextUsage(db, providerSessionId) ?? null;
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

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
 * Attachment item shape the engine's `session/send` mapper accepts (verified
 * against engine 0.16.5). The mapper reads `kind`/`filename`/`mimeType`/
 * `sizeBytes` plus exactly one source field — `localPath`, `dataBase64` or
 * `textContent` — and silently DROPS any item it cannot map, so a wrong shape
 * never errors: the model just receives plain text without the attachment.
 */
type ZcodeEngineAttachment = {
  kind: 'image' | 'video' | 'pdf' | 'audio' | 'file';
  filename: string;
  localPath: string;
  mimeType?: string;
  sizeBytes?: number;
};

/** Derives the engine's attachment kind from the descriptor's MIME type. */
function resolveEngineAttachmentKind(mimeType: string | undefined): ZcodeEngineAttachment['kind'] {
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
 * Maps app attachment descriptors into the engine's native `session/send`
 * item shape. The gateway (`filterAttachmentsToUploadStore`) only forwards
 * direct children of the upload store, so paths arrive absolute — anything
 * else is dropped here because the engine resolves relative `localPath`
 * values against the session workspace and would report a bogus read failure
 * instead of the file.
 */
function toEngineAttachments(descriptors: ChatAttachmentDescriptor[]): ZcodeEngineAttachment[] {
  const items: ZcodeEngineAttachment[] = [];
  for (const descriptor of descriptors) {
    if (!path.isAbsolute(descriptor.path)) {
      console.warn(`[ZCodeRuntime] Dropping attachment with non-absolute path: ${descriptor.path}`);
      continue;
    }
    const item: ZcodeEngineAttachment = {
      kind: resolveEngineAttachmentKind(descriptor.mimeType),
      filename: descriptor.name ?? path.basename(descriptor.path),
      localPath: descriptor.path,
    };
    if (descriptor.mimeType) {
      item.mimeType = descriptor.mimeType;
    }
    if (typeof descriptor.size === 'number') {
      item.sizeBytes = descriptor.size;
    }
    items.push(item);
  }
  return items;
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
   * 4. Set model if different from the session's current model
   * 5. Map permission mode and call session/setMode
   * 6. Send user message via session/send
   * 7. Wait for the run end event, then send exactly one complete with tokens
   */
  async run(
    command: string,
    options: AnyRecord = {},
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<unknown> {
    return this.driveSessionTurn({
      options,
      writer,
      context,
      configureSession: true,
      failureMessage: 'ZCode run failed',
      startTurn: (zcodeSessionId) => this.sendUserMessage(zcodeSessionId, command, options),
    });
  }

  /**
   * Compacts a session's carried conversation into a summary the next turn
   * builds on (`/compact`).
   *
   * `session/compact` answers as soon as the engine accepts the work
   * (`compact.state === 'accepted'`) and then runs the summarization as a
   * background prompt turn, so the turn's own terminal event — not that
   * response — ends this run; that is why the request rides the same plumbing
   * as `run` (subscribe → listener → settle → exactly one `complete`).
   *
   * `expectedRevision` is deliberately omitted: the engine only validates it
   * when present (-32009 on a stale value), and the app never tracks a
   * session's revision. The engine compacts with the session's current model
   * and refuses while a prompt is running, which is why the request reports
   * that state instead of starting a second turn.
   */
  async compact(
    options: AnyRecord = {},
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<unknown> {
    return this.driveSessionTurn({
      options,
      writer,
      context,
      // Summarization uses whatever model the session already runs with and
      // needs no permission mode, so the engine's session is left untouched.
      configureSession: false,
      failureMessage: 'ZCode compaction failed',
      startTurn: (zcodeSessionId) => this.requestCompaction(zcodeSessionId),
    });
  }

  /**
   * Drives one engine turn to its terminal event and reports it.
   *
   * Shared by `run` (a user prompt via `session/send`) and `compact` (a
   * summarization turn via `session/compact`): resolve or create the session,
   * register the run, subscribe to its event stream, hand the turn to
   * `startTurn`, then translate the settle result into exactly one terminal
   * `complete` frame plus the notification every other runtime emits.
   */
  private async driveSessionTurn(input: {
    options: AnyRecord;
    writer: ProviderRuntimeWriter;
    context: ProviderRuntimeContext;
    /** Whether the app's model/effort and permission mode are applied first. */
    configureSession: boolean;
    /** Failure text for the run notification when the engine ends the turn as failed. */
    failureMessage: string;
    /** Issues the turn itself; the settle wait observes its terminal event. */
    startTurn: (zcodeSessionId: string) => Promise<void>;
  }): Promise<unknown> {
    const { options, writer, context, configureSession, failureMessage, startTurn } = input;
    const appSessionId = readOptionalString(options.sessionId) ?? null;
    const sessionSummary = readOptionalString(options.sessionSummary);

    // Runs before the main try block below; without its own error emission a
    // session/create failure would never reach the chat stream and the page
    // would stay silent (the gateway only logs runtime rejections).
    let zcodeSessionId: string;
    let resumedSession = false;
    try {
      const resolved = await this.resolveOrCreateSession(appSessionId, options, context, writer);
      zcodeSessionId = resolved.sessionId;
      resumedSession = resolved.resumed;
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
      await this.subscribeToSessionEvents(zcodeSessionId);
      if (configureSession) {
        await this.configureSessionModel(zcodeSessionId, options, context, resumedSession);
        await this.configureSessionMode(zcodeSessionId, options);
      }

      const eventListener = this.createSessionEventListener(handle, writer, context);
      protocolClient.addSessionListener(zcodeSessionId, eventListener);

      let settle: RunSettle | null = null;
      try {
        await startTurn(zcodeSessionId);
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

        protocolClient.removeSessionListener(zcodeSessionId, eventListener);

        if (settle.kind === 'aborted') {
          // A delivered session/stop settles the run here: report it as
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
              ? { failed: true, error: completion.failedMessage ?? failureMessage }
              : { failed: false, stopReason: 'completed' },
          });
          return { sessionId: zcodeSessionId, success: !completion.failed };
        }

        throw new Error('ZCode run was superseded by a newer run for this session');
      } catch (error) {
        protocolClient.removeSessionListener(zcodeSessionId, eventListener);

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
   * Calls `session/stop` for the ZCode session mapped to the given app-facing
   * session id (no SIGINT fallback per §3.2.3 - the app-server process is
   * shared across sessions). Uses protocol-level retry on failure.
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

    try {
      await this.callWithRetry(
        async () => {
          await protocolClient.sendRequest('session/stop', {
            sessionId: handle.sessionId,
          });
        },
        'session/stop',
        3
      );
    } catch (error) {
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
   * Both requests send only the fields the engine's strict schema declares
   * (`session/resume` takes nothing but `sessionId`; `session/create` takes the
   * workspace descriptor). The model is applied afterwards through
   * `session/setModel`, which is what clears the cold-resume "model
   * unavailable" warning (-32031) without the strict-schema -32602 rejection
   * that an extra `runtimeModel` key produces on engine 0.16.9.
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

    if (existingSessionId) {
      const resumed = await this.tryResumeSession(existingSessionId);
      if (resumed) {
        console.debug(`[ZCodeRuntime] Resumed existing session: ${existingSessionId}`);
        return { sessionId: existingSessionId, resumed: true };
      }
      console.info(
        `[ZCodeRuntime] Session ${existingSessionId} is no longer available engine-side; creating a replacement session`
      );
    }

    // No spawn-cwd fallback: the server's own cwd is the deployed build's
    // install directory, and silently creating sessions there registered
    // engine-internal directories as projects. A run that carries neither
    // workspacePath nor cwd fails visibly instead.
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

      // `session/create` also carries the engine's resolved model catalog; feed
      // it to the models provider so `session/setModel` can supply the
      // reasoning level the engine requires without a second catalog request.
      ingestZCodeModelCatalog(result);

      const newSessionId = readOptionalString(result?.sessionId)
        ?? readOptionalString((result?.session as AnyRecord)?.id)
        ?? readOptionalString((result?.session as AnyRecord)?.sessionId);

      if (!newSessionId) {
        throw new Error('session/create returned no sessionId');
      }

      writer.setSessionId?.(newSessionId);

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
   * Only "session is gone" failures (-32004, method missing on older engines)
   * justify falling back to a replacement session: anything else (timeouts,
   * transport errors) must propagate so the run surfaces the real cause
   * instead of silently forking a fresh session on every send.
   */
  private async tryResumeSession(sessionId: string): Promise<boolean> {
    try {
      // Engine 0.16.9 validates resume against a strict schema that accepts
      // `sessionId` alone; any extra key is rejected with -32602.
      const result = await protocolClient.sendRequest<AnyRecord>('session/resume', {
        sessionId,
      });
      // A resumed session carries the same settings payload as create; capture
      // the catalog for the reasoning level required by session/setModel.
      ingestZCodeModelCatalog(result);
      return true;
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
      return false;
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
   * Configures session model and reasoning effort when it differs from the session's current configuration.
   *
   * The current model and variant are read from ZCode's own database (most recent
   * `message.data.modelID` / `model.variant`).
   *
   * `forceModelSync` skips the database early-return: a resumed session's
   * stored model reference may name a provider that no longer exists in the
   * engine's config (provider ids drift across engine lifetimes), which makes
   * the next send fail with -32031 until the model is explicitly re-selected.
   */
  private async configureSessionModel(
    sessionId: string,
    options: AnyRecord,
    context: ProviderRuntimeContext,
    forceModelSync = false,
  ): Promise<void> {
    const appSessionId = readOptionalString(options.sessionId);
    // The composer's explicit choice wins; without one, fall back to the model
    // recorded on the app session row, and finally to the provider's default —
    // a forced sync (resumed session) must always re-select *some* valid model
    // instead of silently keeping a dead engine-side reference.
    const requestedModel = readOptionalString(options.model)
      ?? await context.resolveResumeModel(appSessionId ?? undefined, undefined)
      ?? (forceModelSync ? (await context.getProviderModels()).DEFAULT : undefined);
    let requestedEffort = readOptionalString(options.effort);
    if ((!requestedEffort || requestedEffort === 'default') && appSessionId) {
      const sessionRow = sessionsDb.getSessionById(appSessionId);
      if (sessionRow?.effort && sessionRow.effort !== 'default') {
        requestedEffort = sessionRow.effort;
      }
    }

    if (!requestedModel) {
      return; // No model change requested
    }

    const normalizedVariant = requestedEffort && requestedEffort !== 'default'
      ? requestedEffort.toLowerCase().trim()
      : undefined;

    const currentModelInfo = readZCodeSessionModelInfoFromDb(sessionId);
    if (
      !forceModelSync
      && currentModelInfo
      && currentModelInfo.modelId === requestedModel
      && (currentModelInfo.variant || undefined) === normalizedVariant
    ) {
      return; // Session already runs the requested model and effort variant
    }

    const resolvedRef = resolveZCodeModelRef(requestedModel, normalizedVariant);

    // The engine's setModel schema is strict: the reasoning level lives under
    // `model.options.reasoningLevel` (a bare `variant` key is rejected), and a
    // model with reasoning levels is refused when none is supplied. The user's
    // explicit effort wins; otherwise use the default captured from the
    // session/create (or session/resume) response. A resumed session created
    // outside the app may carry no defaults yet, so fall back to the provider
    // catalog (which resolves the engine catalog on demand).
    let reasoningLevel = resolvedRef.variant ?? resolveZCodeModelDefaultReasoningLevel(requestedModel);
    if (!reasoningLevel) {
      await context.getProviderModels().catch(() => null);
      reasoningLevel = resolveZCodeModelDefaultReasoningLevel(requestedModel);
    }
    const modelObj: AnyRecord = {
      providerId: resolvedRef.providerId,
      modelId: resolvedRef.modelId,
      ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
    };

    try {
      await protocolClient.sendRequest('session/setModel', {
        sessionId,
        model: modelObj,
      });

      console.debug(`[ZCodeRuntime] Set model for session ${sessionId}: ${JSON.stringify(modelObj)}`);
    } catch (error) {
      console.warn(`[ZCodeRuntime] Failed to set model ${requestedModel} for session ${sessionId}:`, error);
      // Continue anyway - use session's existing model
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
   * Sends user message to ZCode session.
   *
   * `session/send` is issued without a request timeout: the response only
   * acknowledges acceptance (observed immediate on engine 0.16.5), while the
   * turn itself completes on the event stream — a timeout here could fire
   * after acceptance on slow engines. The params are strict-schema validated
   * by the engine (validated against engine 0.16.3 and 0.16.9), so only
   * `sessionId`, `content`, and `attachments` are sent.
   *
   * Attachments arrive as app descriptors `{path, name, mimeType, size}` and
   * must be re-shaped into the engine's native items before sending — the
   * engine silently drops items it cannot map, which used to make every
   * attachment invisible to the model.
   */
  private async sendUserMessage(
    sessionId: string,
    command: string,
    options: AnyRecord,
  ): Promise<void> {
    const messagePayload: AnyRecord = {
      sessionId,
      // Message content field: content (not message) per protocol findings
      content: command,
    };

    if (Array.isArray(options.attachments)) {
      const engineAttachments = toEngineAttachments(options.attachments as ChatAttachmentDescriptor[]);
      if (engineAttachments.length > 0) {
        messagePayload.attachments = engineAttachments;
      }
    }

    try {
      await protocolClient.sendRequest('session/send', messagePayload, 0);
      console.debug(`[ZCodeRuntime] Sent message to session ${sessionId}`);
    } catch (error) {
      console.error(`[ZCodeRuntime] Failed to send message to session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Asks the engine to compact one session's carried conversation.
   *
   * The response only reports acceptance (`compact.state`), so this resolves as
   * soon as the engine has taken the work; the following `turn.completed` (or
   * `compact.failed`) is what ends the run. `already_running` is reported as an
   * error rather than waited out: the user asked for a compaction that is
   * already in flight, and silently attaching to it would leave the UI unable
   * to tell whose progress it is showing.
   */
  private async requestCompaction(sessionId: string): Promise<void> {
    try {
      const result = await protocolClient.sendRequest<AnyRecord>(
        'session/compact',
        { sessionId },
        COMPACT_REQUEST_TIMEOUT_MS,
      );
      const state = readOptionalString(readObjectRecord(result?.compact)?.state);
      if (state === 'already_running') {
        throw new Error('A compaction is already running for this session.');
      }
      console.debug(`[ZCodeRuntime] Requested compaction for session ${sessionId} (state: ${state ?? 'unknown'})`);
    } catch (error) {
      console.error(`[ZCodeRuntime] Failed to request compaction for session ${sessionId}:`, error);
      throw error;
    }
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
        // Any notification from the engine for this session is a sign of
        // life: refresh the silence-watchdog stamp before anything else.
        runLifecycle.recordActivity(handle);

        const method = readOptionalString(notification.method);

        // Synthetic client-originated notification: the engine process died,
        // so this session no longer exists engine-side. Mark the run failed
        // (once) so the settle wait returns instead of timing out against a
        // dead engine.
        if (method === SESSION_LOST_METHOD) {
          const stderrTail = readOptionalString(
            (notification.params as Record<string, unknown> | undefined)?.stderrTail,
          );
          runLifecycle.recordSessionLost(handle, stderrTail);
          return;
        }

        if (method && method !== 'session/event') {
          console.debug(`[ZCodeRuntime] Received non-session notification: ${method}`);
          return;
        }

        const normalizedMessages: NormalizedMessage[] = context.normalizeMessage(
          notification.params ?? notification,
          handle.sessionId,
        );

        for (const message of normalizedMessages) {
          if (message.kind === 'complete') {
            runLifecycle.recordCompletion(handle, message.tokens);
            continue;
          }

          if (message.kind === 'error') {
            // A terminal error can outlive its run: the engine's cancelled
            // echo (or any late turn.failed) may arrive after this run
            // settled and a newer run already owns the session. Attributing
            // it to the live run would fail or finish someone else's turn.
            if (!runLifecycle.isActiveRun(handle)) {
              continue;
            }
            if (message.isCancelledError) {
              // A cancelled model request is not an engine failure. When the
              // user's own stop is on record the echo is expected noise —
              // drop the frame and let the settle wait report the abort. An
              // engine-side cancellation the user did not ask for degrades
              // to a quiet transcript line and ends the run as a non-failure
              // instead of a red error bubble plus a "run failed" notice.
              if (handle.abortRequested) {
                continue;
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
              continue;
            }
            // Terminal error events (turn.failed / fatal) end the turn; mark
            // the run completed-as-failed so the settle wait and the final
            // complete message reflect it instead of timing out after 10 min.
            runLifecycle.recordEngineError(handle, readOptionalString(message.text) ?? undefined);
          }

          writer.send(message);

          if (message.kind === 'tool_result') {
            // A tool result closes a step: that step's usage is already
            // persisted, so the composer's context badge can move now instead
            // of waiting for the completion refresh — which is what a long
            // tool-heavy turn needs.
            this.publishLiveContextUsage(handle, writer);
          }
        }
      } catch (error) {
        console.error(`[ZCodeRuntime] Error processing session event:`, error);
      }
    };
  }

  /**
   * Pushes one mid-turn `token_budget` frame when the session's context
   * occupancy has moved since the last one.
   *
   * Deliberately silent about everything else: an unchanged reading (several
   * tool results of the same step), an aborted or already-finished run, and a
   * reading taken inside the rate-limit window all publish nothing. The payload
   * is the same shape the `/token-usage` endpoint returns, so the badge, the
   * percentage it derives, and a reloaded transcript cannot disagree.
   */
  private publishLiveContextUsage(handle: RunHandle, writer: ProviderRuntimeWriter): void {
    if (handle.abortRequested || handle.state.completed) {
      return;
    }

    const now = Date.now();
    if (now - (handle.state.contextPublishedAt ?? 0) < LIVE_CONTEXT_MIN_INTERVAL_MS) {
      return;
    }
    handle.state.contextPublishedAt = now;

    const usage = readZCodeSessionContextUsage(handle.sessionId);
    if (!usage || usage.used <= 0 || usage.used === handle.state.publishedContextUsed) {
      return;
    }

    handle.state.publishedContextUsed = usage.used;
    writer.send(createNormalizedMessage({
      id: generateMessageId('zcode'),
      sessionId: handle.sessionId,
      provider: 'zcode',
      kind: 'status',
      text: 'token_budget',
      tokenBudget: usage,
    }));
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
        protocolClient.removeSessionListener(handle.sessionId, eventListener);
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
   * Protocol-level retry per §3.2.3 for operations like session/stop.
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
