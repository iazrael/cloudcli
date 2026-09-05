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

import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage, generateMessageId, readOptionalString } from '@/shared/utils.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';

import { sessionsDb } from '@/modules/database/index.js';

import { SESSION_LOST_METHOD } from './zcode-codec.js';
import { protocolClient } from './zcode-protocol.client.js';
import { buildZCodeRuntimeModel, readZCodeSessionModelInfoFromDb, resolveZCodeModelRef } from './zcode-models.provider.js';
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
    const appSessionId = readOptionalString(options.sessionId) ?? null;
    const sessionSummary = readOptionalString(options.sessionSummary);
    // Seed the engine's workspace model catalog with every session request:
    // remote clients start with an empty catalog, and a cold resume of a
    // session whose transcript references unresolvable models would
    // otherwise be poisoned with a permanent "model unavailable" warning
    // (-32031 on every send).
    const runtimeModel = await this.resolveRuntimeModelPayload(options, context);

    // Runs before the main try block below; without its own error emission a
    // session/create failure would never reach the chat stream and the page
    // would stay silent (the gateway only logs runtime rejections).
    let zcodeSessionId: string;
    let resumedSession = false;
    try {
      const resolved = await this.resolveOrCreateSession(appSessionId, options, context, writer, runtimeModel);
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
      await this.configureSessionModel(zcodeSessionId, options, context, resumedSession);
      await this.configureSessionMode(zcodeSessionId, options);

      const eventListener = this.createSessionEventListener(handle, writer, context);
      protocolClient.addSessionListener(zcodeSessionId, eventListener);

      let settle: RunSettle | null = null;
      try {
        await this.sendUserMessage(zcodeSessionId, command, options, runtimeModel);
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
              ? { failed: true, error: completion.failedMessage ?? 'ZCode run failed' }
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
   * Both requests carry `runtimeModel` when a model selection is available:
   * it seeds the engine's workspace model catalog (remote clients start with
   * an empty one) and prevents the cold-resume "model unavailable" warning
   * from poisoning sessions whose transcripts reference other provider ids.
   */
  private async resolveOrCreateSession(
    appSessionId: string | null,
    options: AnyRecord,
    context: ProviderRuntimeContext,
    writer: ProviderRuntimeWriter,
    runtimeModel?: Record<string, unknown>,
  ): Promise<{ sessionId: string; resumed: boolean }> {
    const existingSessionId = appSessionId
      ? context.resolveProviderSessionId(appSessionId)
      : null;

    if (existingSessionId) {
      const resumed = await this.tryResumeSession(existingSessionId, runtimeModel);
      if (resumed) {
        console.debug(`[ZCodeRuntime] Resumed existing session: ${existingSessionId}`);
        return { sessionId: existingSessionId, resumed: true };
      }
      console.info(
        `[ZCodeRuntime] Session ${existingSessionId} is no longer available engine-side; creating a replacement session`
      );
    }

    const workspacePath = readOptionalString(options.workspacePath)
      ?? readOptionalString(options.cwd)
      ?? process.cwd();

    console.info(`[ZCodeRuntime] Creating new session for workspace: ${workspacePath}`);

    try {
      const result = await protocolClient.sendRequest<AnyRecord>(
        'session/create',
        {
          workspace: {
            workspacePath,
            workspaceKey: workspacePath,
          },
          ...(runtimeModel ? { runtimeModel } : {}),
        }
      );

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
  private async tryResumeSession(
    sessionId: string,
    runtimeModel?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await protocolClient.sendRequest('session/resume', {
        sessionId,
        ...(runtimeModel ? { runtimeModel } : {}),
      });
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

    const modelObj = resolveZCodeModelRef(requestedModel, normalizedVariant);

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
   * Maps CloudCLI permission modes to ZCode modes and calls session/setMode.
   */
  private async configureSessionMode(
    sessionId: string,
    options: AnyRecord,
  ): Promise<void> {
    const permissionMode = readOptionalString(options.permissionMode) ?? 'default';

    const zcodeMode = PERMISSION_MODE_MAP[permissionMode] ?? 'build';

    try {
      await protocolClient.sendRequest('session/setMode', {
        sessionId,
        mode: zcodeMode,
      });

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
   * by the engine (validated against engine 0.16.3 and 0.16.5), so only
   * `sessionId`, `content`, `attachments`, and the `runtimeModel` catalog
   * seed are sent.
   */
  private async sendUserMessage(
    sessionId: string,
    command: string,
    options: AnyRecord,
    runtimeModel?: Record<string, unknown>,
  ): Promise<void> {
    const messagePayload: AnyRecord = {
      sessionId,
      // Message content field: content (not message) per protocol findings
      content: command,
    };

    if (Array.isArray(options.attachments)) {
      messagePayload.attachments = options.attachments;
    }

    if (runtimeModel) {
      // Refreshes the engine's workspace model catalog and clears any
      // lingering "model unavailable" restore warning before the turn starts.
      messagePayload.runtimeModel = runtimeModel;
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
   * Resolves the model selection carried by a run into the engine's
   * `runtimeModel` catalog payload, or undefined when nothing was requested
   * and no recorded/default model exists.
   *
   * Mirrors the resolution order of `configureSessionModel`: the composer's
   * explicit choice, then the model recorded on the app session row.
   */
  private async resolveRuntimeModelPayload(
    options: AnyRecord,
    context: ProviderRuntimeContext,
  ): Promise<Record<string, unknown> | undefined> {
    const appSessionId = readOptionalString(options.sessionId);
    const requestedModel = readOptionalString(options.model)
      ?? await context.resolveResumeModel(appSessionId ?? undefined, undefined);
    if (!requestedModel) {
      return undefined;
    }

    const effort = readOptionalString(options.effort);
    const variant = effort && effort !== 'default' ? effort.toLowerCase().trim() : undefined;
    return buildZCodeRuntimeModel(requestedModel, variant);
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
          runLifecycle.recordSessionLost(handle);
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
            // Terminal error events (turn.failed / fatal) end the turn; mark
            // the run completed-as-failed so the settle wait and the final
            // complete message reflect it instead of timing out after 10 min.
            runLifecycle.recordEngineError(handle, readOptionalString(message.text) ?? undefined);
          }

          writer.send(message);
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
