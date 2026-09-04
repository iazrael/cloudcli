/**
 * ZCode Runtime Provider
 *
 * Implements IProviderRuntime for ZCode integration using the app-server protocol.
 * Handles session lifecycle, permission mode mapping, message streaming, and run completion.
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
import type { ProtocolServerRequest } from './zcode-codec.js';
import { defaultServerRequestHandler } from './zcode-request-router.js';
import type { ServerRequestAnswer } from './zcode-request-router.js';
import { protocolClient } from './zcode-protocol.client.js';
import { buildZCodeRuntimeModel, readZCodeSessionModelInfoFromDb, resolveZCodeModelRef } from './zcode-models.provider.js';

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
 * Active session tracking for abort capability.
 * Keys are app-facing session ids (what `abort` receives from the chat
 * gateway); values are ZCode-native session ids passed to `session/stop`.
 */
const activeSessions = new Map<string, string>();

/**
 * Abort keys whose run was terminated by a user-requested abort, so the
 * terminal notification reports "aborted" instead of a failure when the
 * aborted run unwinds through `waitForCompletion`.
 */
const abortedRunKeys = new Set<string>();

/**
 * Session completion tracking to ensure exactly one complete event per run.
 * Maps ZCode session IDs to completion state; `tokenUsage` is the run's
 * total used-token count carried on the final complete message, `failed`
 * marks runs that ended with a terminal error event (turn.failed/fatal) so
 * the complete message reports a non-zero exit code, and `failedMessage`
 * carries the last engine error text for the run-failure notification.
 */
const sessionCompletionState = new Map<string, {
  completed: boolean;
  failed?: boolean;
  failedMessage?: string;
  tokenUsage?: number;
}>();

/**
 * Permission bridge state.
 *
 * The engine asks for tool approval through a blocking
 * `interaction/requestPermission` server-initiated request. The bridge turns
 * it into a `permission_request` message on the owning run's chat stream and
 * keeps the engine waiting until the user answers through
 * `chat.permission-response` → `zcodeRuntimePermissions.resolve`.
 *
 * `permissionWriters` maps the engine-side session id to the run's writer so
 * the bridge can forward the request even though the protocol client is a
 * singleton shared across runs; entries live for the run's duration, while
 * pending resolvers outlive it so a card answered after the run still
 * resolves cleanly instead of leaking the engine's request.
 */
type PermissionBridgeAnswer = ServerRequestAnswer;

const permissionWriters = new Map<string, ProviderRuntimeWriter>();
const pendingPermissionResolvers = new Map<string, (answer: PermissionBridgeAnswer) => void>();

/**
 * Bridges the engine's `interaction/requestPermission` server request to the
 * chat stream. Installed once over the router's default policy; every other
 * method falls through unchanged.
 */
function permissionBridgeRequestHandler(
  request: ProtocolServerRequest,
): ServerRequestAnswer | Promise<ServerRequestAnswer> {
  if (request.method !== 'interaction/requestPermission') {
    return defaultServerRequestHandler(request);
  }

  const params = request.params ?? {};
  const requestId = readOptionalString(params.requestId);
  const sessionId = readOptionalString(params.sessionId);
  if (!requestId) {
    return { error: { code: -32602, message: 'interaction/requestPermission is missing requestId' } };
  }

  // The engine re-announces pending requests on an interval; answer each
  // re-announcement with the same pending promise instead of stacking.
  if (pendingPermissionResolvers.has(requestId)) {
    return new Promise<PermissionBridgeAnswer>((resolve) => {
      pendingPermissionResolvers.set(requestId, resolve);
    });
  }

  const writer = sessionId ? permissionWriters.get(sessionId) : undefined;
  if (!writer) {
    return { result: { decision: 'deny', reason: 'No active chat stream for this session' } };
  }

  writer.send(createNormalizedMessage({
    id: generateMessageId('zcode'),
    sessionId,
    provider: 'zcode',
    kind: 'permission_request',
    requestId,
    toolName: readOptionalString(params.toolName) ?? 'Tool',
    toolId: readOptionalString(params.toolCallId),
    input: params.input,
    context: {
      riskLevel: readOptionalString(params.riskLevel),
      reason: readOptionalString(params.reason),
      options: params.options,
      suggestedPermissionUpdates: params.suggestedPermissionUpdates,
    },
    canInterrupt: true,
  }));

  return new Promise<PermissionBridgeAnswer>((resolve) => {
    pendingPermissionResolvers.set(requestId, resolve);
  });
}

/**
 * ZCode permissions facet: answers the engine's pending
 * `interaction/requestPermission` calls from the chat gateway's
 * `chat.permission-response` flow.
 *
 * Consumer: `provider-runtime.service.resolveToolApproval` fans decisions out
 * to every provider's permissions facet; zcode only answers request ids it
 * bridged itself.
 */
export const zcodeRuntimePermissions = {
  resolve(requestId: string, decision: ProviderPermissionDecision): void {
    const resolve = pendingPermissionResolvers.get(requestId);
    if (!resolve) {
      return;
    }
    pendingPermissionResolvers.delete(requestId);

    if (decision.allow) {
      resolve(decision.updatedInput !== undefined
        ? { result: { decision: 'modify', modifiedInput: decision.updatedInput, reason: decision.message } }
        : { result: { decision: 'allow', reason: decision.message } });
      return;
    }

    resolve({ result: { decision: 'deny', reason: decision.message ?? 'Denied by user' } });
  },

  listPending(): unknown[] {
    return [...pendingPermissionResolvers.keys()];
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
    activeSessions.set(abortKey, zcodeSessionId);
    sessionCompletionState.set(zcodeSessionId, { completed: false });
    // Route the engine's permission server-requests for this session to this
    // run's chat stream; installed once, but the writer map is per-run.
    permissionWriters.set(zcodeSessionId, writer);
    protocolClient.setServerRequestHandler(permissionBridgeRequestHandler);

    try {
      await this.subscribeToSessionEvents(zcodeSessionId);
      await this.configureSessionModel(zcodeSessionId, options, context, resumedSession);
      await this.configureSessionMode(zcodeSessionId, options);

      const eventListener = this.createSessionEventListener(zcodeSessionId, writer, context);
      protocolClient.addSessionListener(zcodeSessionId, eventListener);

      try {
        await this.sendUserMessage(zcodeSessionId, command, options, runtimeModel);
        await this.waitForCompletion(zcodeSessionId, abortKey);
        this.sendCompletionEvent(zcodeSessionId, writer);

        const completionState = sessionCompletionState.get(zcodeSessionId);
        this.notifyRunOutcome({
          userId: writer.userId,
          sessionId: notifySessionId,
          sessionSummary,
          outcome: completionState?.failed
            ? { failed: true, error: completionState.failedMessage ?? 'ZCode run failed' }
            : { failed: false, stopReason: 'completed' },
        });

        return { sessionId: zcodeSessionId, success: !completionState?.failed };
      } finally {
        protocolClient.removeSessionListener(zcodeSessionId, eventListener);
      }
    } catch (error) {
      // A user-requested abort removes the abort key, so the resulting
      // "Session was aborted" error lands here: report it as stopped with an
      // `aborted` reason instead of a failure, matching the other runtimes.
      const wasAborted = abortedRunKeys.delete(abortKey);

      // Surface non-abort failures to the chat stream before propagating.
      // Aborted runs skip the error bubble so users don't see false-alarm errors.
      if (!wasAborted) {
        this.sendRuntimeError(writer, zcodeSessionId, error);
      }

      this.notifyRunOutcome({
        userId: writer.userId,
        sessionId: notifySessionId,
        sessionSummary,
        outcome: wasAborted
          ? { failed: false, stopReason: 'aborted' }
          : { failed: true, error },
      });

      throw error;
    } finally {
      activeSessions.delete(abortKey);
      sessionCompletionState.delete(zcodeSessionId);
      abortedRunKeys.delete(abortKey);
      // Keep pendingPermissionResolvers: a permission card answered after the
      // run still resolves the engine's request instead of leaking it. Only
      // the writer mapping is run-scoped.
      permissionWriters.delete(zcodeSessionId);
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
   * @param sessionId - CloudCLI app session ID to abort
   * @returns boolean indicating if abort was successful
   */
  async abort(sessionId: string): Promise<boolean> {
    const zcodeSessionId = activeSessions.get(sessionId);

    if (!zcodeSessionId) {
      console.warn(`[ZCodeRuntime] No active session found for ${sessionId}`);
      return false;
    }

    // Record the user-requested abort so the run's terminal notification
    // reports "aborted" instead of a failure when waitForCompletion unwinds.
    abortedRunKeys.add(sessionId);

    try {
      // Mark session as completed to prevent duplicate complete events
      const completionState = sessionCompletionState.get(zcodeSessionId);
      if (completionState) {
        completionState.completed = true;
      }

      await this.callWithRetry(
        async () => {
          await protocolClient.sendRequest('session/stop', {
            sessionId: zcodeSessionId,
          });
        },
        'session/stop',
        3
      );

      console.info(`[ZCodeRuntime] Aborted session ${zcodeSessionId}`);
      return true;
    } catch (error) {
      console.error(`[ZCodeRuntime] Failed to abort session ${zcodeSessionId}:`, error);
      return false;
    } finally {
      activeSessions.delete(sessionId);
    }
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
    sessionId: string,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): (notification: AnyRecord) => void {
    return (notification: AnyRecord) => {
      try {
        const method = readOptionalString(notification.method);

        // Synthetic client-originated notification: the engine process died,
        // so this session no longer exists engine-side. Mark the run failed
        // (once) so waitForCompletion returns instead of timing out against a
        // dead engine.
        if (method === SESSION_LOST_METHOD) {
          const completionState = sessionCompletionState.get(sessionId);
          if (completionState && !completionState.completed) {
            completionState.failed = true;
            completionState.completed = true;
            completionState.failedMessage = 'ZCode engine connection was lost';
          }
          return;
        }

        if (method && method !== 'session/event') {
          console.debug(`[ZCodeRuntime] Received non-session notification: ${method}`);
          return;
        }

        const normalizedMessages: NormalizedMessage[] = context.normalizeMessage(
          notification.params ?? notification,
          sessionId,
        );

        for (const message of normalizedMessages) {
          if (message.kind === 'complete') {
            const completionState = sessionCompletionState.get(sessionId);
            if (completionState) {
              completionState.tokenUsage = message.tokens;
              completionState.completed = true;
            }
            continue;
          }

          if (message.kind === 'error') {
            // Terminal error events (turn.failed / fatal) end the turn; mark
            // the run completed-as-failed so waitForCompletion and the final
            // complete message reflect it instead of timing out after 10 min.
            const completionState = sessionCompletionState.get(sessionId);
            if (completionState) {
              completionState.failed = true;
              completionState.completed = true;
              completionState.failedMessage = readOptionalString(message.text) ?? undefined;
            }
          }

          writer.send(message);
        }      } catch (error) {
        console.error(`[ZCodeRuntime] Error processing session event:`, error);
      }
    };
  }

  /**
   * Waits for session completion event.
   *
   * Polls sessionCompletionState until the completed flag is set, the run is
   * aborted (abort key removed), or the timeout elapses.
   */
  private async waitForCompletion(
    sessionId: string,
    abortKey: string,
    timeout: number = 10 * 60 * 1000,
  ): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < timeout) {
      if (sessionCompletionState.get(sessionId)?.completed) {
        return;
      }

      if (!activeSessions.has(abortKey)) {
        throw new Error('Session was aborted');
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Session completion timeout after ${timeout}ms`);
  }

  /**
   * Sends completion event with aggregated token usage.
   *
   * Ensures exactly ONE complete event per run per §3.2.3 requirements.
   * The shared `complete` envelope carries success/exit semantics; the run's
   * total used-token count rides the `tokens` field.
   */
  private sendCompletionEvent(
    sessionId: string,
    writer: ProviderRuntimeWriter,
  ): void {
    const completionState = sessionCompletionState.get(sessionId);
    const tokenUsage = completionState?.tokenUsage;

    const completeMessage = createCompleteMessage({
      provider: 'zcode',
      sessionId,
      exitCode: completionState?.failed ? 1 : 0,
    });
    if (typeof tokenUsage === 'number') {
      completeMessage.tokens = tokenUsage;
    }

    writer.send(completeMessage);
    console.debug(`[ZCodeRuntime] Sent completion event for session ${sessionId}`);
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
