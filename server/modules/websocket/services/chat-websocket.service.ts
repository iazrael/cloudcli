import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';

import { isValidReplaySeq, isValidStreamEpoch } from '../../../../shared/protocol/frameNarrowing.js';

import { sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import type {
  ActiveBackgroundTask,
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject, readObjectRecord } from '@/shared/utils.js';
import { AppError, resolveCodexExecutionPolicy } from '@/shared/index.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/** Application boundary for dispatching provider runs and approvals. */
export type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  /** 运行时支持输入确认，无法安全续轮时继续等待，避免停止后台任务。 */
  supportsInputAcceptance?(provider: LLMProvider): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  stopBackgroundTask(provider: LLMProvider, sessionId: string, taskId: string): Promise<boolean>;
  /** Whether a provider runtime still holds background work for the session after its turn ended. */
  hasBackgroundWork(sessionId: string): boolean;
  /** Full provider activity, including resident initialization, reports and approvals. */
  hasSessionWork?(sessionId: string): boolean;
  /** Narrower than `hasBackgroundWork`: only work whose end the runtime broadcasts, including the reply after it. */
  isBackgroundWorkPending(sessionId: string): boolean;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
  getBackgroundTasksForSession?(sessionId: string): ActiveBackgroundTask[];
  /** False when the session's background work is held by a runtime that can no longer stop it. */
  canInterruptBackgroundWork?(sessionId: string): boolean;
  /** False when the provider takes a new turn alongside the session's background work. */
  backgroundWorkQueuesInput?(provider: LLMProvider, sessionId: string): boolean;
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
};

const CLIENT_RESERVED_RUNTIME_OPTIONS = new Set([
  'toolOutput',
  'onInputAccepted',
  'onBeforeInputAccepted',
  'taskContinuation',
  'taskExecutionContext',
  'taskContinuationContext',
  'taskContinuationLifecycle',
  'taskContinuationTarget',
]);


/** Removes options that only the server may use to resume or register tasks. */
function readClientRuntimeOptions(value: unknown): AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !CLIENT_RESERVED_RUNTIME_OPTIONS.has(key)),
  );
}

/** The session title the client put in its send options, if any. */
function readSessionSummary(options: unknown): string | null {
  const summary = options && typeof options === 'object' ? (options as AnyRecord).sessionSummary : undefined;
  return typeof summary === 'string' && summary.trim() ? summary.trim() : null;
}

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function readTaskOwnerId(userId: string | number | null): number | null {
  const parsed = typeof userId === 'number' ? userId : Number(userId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Reports a runtime crash to the chat stream when the runtime itself never
 * emitted an error message.
 *
 * Without this, a runtime that throws before producing events leaves the UI
 * with nothing but the synthetic terminal `complete` and the failure stays
 * invisible. Runtimes that already reported an error (buffered in the run's
 * event log) are not duplicated.
 *
 * Consumers: `handleChatSend`'s runtime rejection path and
 * `server/modules/websocket/tests/chat-websocket.service.test.ts` (verifies
 * the dedup contract without a full websocket harness).
 */
export function emitRuntimeFailureFallback(
  run: { events: Array<Pick<NormalizedMessage, 'kind'>>; writer: { send: (data: unknown) => void } },
  input: { provider: LLMProvider; sessionId: string; message: string }
): void {
  if (run.events.some((event) => event.kind === 'error')) {
    return;
  }

  run.writer.send(
    createNormalizedMessage({
      sessionId: input.sessionId,
      provider: input.provider,
      kind: 'error',
      isError: true,
      // `content` is what the chat UI renders; `text` keeps parity with
      // provider-level error messages.
      content: input.message,
      text: input.message,
    })
  );
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.send');
  if (!resolved) {
    return;
  }

  await dispatchRun(ws, userId, resolved.sessionId, resolved.session, data, dependencies);
}

type ResolvedSendTarget = {
  sessionId: string;
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  provider: LLMProvider;
};

/**
 * Shared front half of `chat.send` and `chat.edit-send`: the session row and
 * provider come from the database, never from the client.
 */
function resolveSendTarget(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  frameName: string,
): ResolvedSendTarget | null {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', `${frameName} requires a sessionId.`);
    return null;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return null;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return null;
  }

  return { sessionId, session, provider };
}

/**
 * Registers the run and hands the turn to the provider runtime.
 *
 * `extraRuntimeOptions` is how an edited message asks the provider to resume
 * partway instead of continuing from the tip; a normal send passes nothing.
 */
async function dispatchRun(
  ws: WebSocket | null,
  userId: string | number | null,
  sessionId: string,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  extraRuntimeOptions: AnyRecord = {},
  beforeRun?: (run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>) => void | Promise<void>,
): Promise<{
  started: boolean;
  busy?: boolean;
  error: string | null;
  engineTurnId?: string;
  terminalStatus?: 'completed' | 'failed' | 'interrupted' | 'unknown';
}> {
  const provider = session.provider as LLMProvider;

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
    // The composer sends the title it shows; a stored name is the fallback.
    sessionName: readSessionSummary(data.options) ?? session.custom_name,
  });

  if (!run) {
    if (ws) {
      sendProtocolError(
        ws,
        'RUN_IN_PROGRESS',
        `Session "${sessionId}" already has a run in progress.`,
        sessionId
      );
    }
    return { started: false, busy: true, error: 'A run is already in progress for this session.' };
  }

  sessionsDb.touchSession(sessionId);

  const clientOptions = readClientRuntimeOptions(data.options);
  const command = typeof data.content === 'string' ? data.content : '';

  // Record what this turn runs with so reopening the session later restores the
  // same model and reasoning effort, and so the resume path has a
  // session-scoped model answer to use.
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    ...extraRuntimeOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId,
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    // The conversation's later turns come through here too, so a runtime may
    // keep its engine process alive for them (Claude's idle residency).
    residentBetweenTurns: true,
  };

  const onInputAccepted = extraRuntimeOptions.onInputAccepted;
  let inputAccepted = typeof onInputAccepted !== 'function';
  if (typeof onInputAccepted === 'function') {
    runtimeOptions.onInputAccepted = () => {
      if (inputAccepted) return;
      inputAccepted = true;
      onInputAccepted();
    };
  }
  let deferred = false;
  let failure: string | null = null;
  let runtimeOutcome: unknown;
  let taskRunToken: string | null = null;
  let revokeTaskCapability: ((token: string) => boolean) | null = null;
  try {
    // Runs only now that the session is reserved, because an edit rewinds the
    // conversation here and a rewind for a run that was never admitted cannot
    // be taken back. Inside the try so a rewind that throws still releases the
    // run instead of leaving the session processing forever.
    await beforeRun?.(run);

    if (provider === 'codex') {
      const taskContinuationModule = await import('@/modules/task-continuations/index.js');
      if (taskContinuationModule.areTaskContinuationsEnabled()) {
      const ownerId = readTaskOwnerId(userId);
      if (ownerId !== null) {
        const permissionMode = typeof runtimeOptions.permissionMode === 'string'
          ? runtimeOptions.permissionMode
          : 'default';
        const executionPolicy = resolveCodexExecutionPolicy(permissionMode);
        const capability = taskContinuationModule.createTaskRunCapability({
          userId: ownerId,
          sessionId,
          runId: randomUUID(),
          providerThreadId: session.provider_session_id,
          sessionProjectPath: path.resolve(session.project_path || runtimeOptions.cwd || process.cwd()),
          cwd: path.resolve(typeof runtimeOptions.cwd === 'string' ? runtimeOptions.cwd : process.cwd()),
          sandboxPolicy: executionPolicy.sandboxPolicy,
          approvalPolicy: executionPolicy.approvalPolicy,
        });
        taskRunToken = capability.token;
        revokeTaskCapability = taskContinuationModule.revokeTaskRunCapability;
        runtimeOptions.taskExecutionContext = { token: taskRunToken };
        const trustedLifecycle = readObjectRecord(runtimeOptions.taskContinuationLifecycle);
        const onEngineTurnStarted = typeof trustedLifecycle?.onEngineTurnStarted === 'function'
          ? trustedLifecycle.onEngineTurnStarted as (engineTurnId: string) => boolean
          : undefined;
        runtimeOptions.taskContinuationLifecycle = {
          onNativeThreadResolved: (providerThreadId: string) =>
            taskContinuationModule.setTaskRunProviderThreadId(taskRunToken!, providerThreadId),
          ...(onEngineTurnStarted ? { onEngineTurnStarted } : {}),
        };
      }
      }
    }

    runtimeOutcome = await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    deferred = !inputAccepted && error instanceof AppError && error.code === 'PROVIDER_INPUT_DEFERRED';
    if (!deferred) {
      console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: failure });
      emitRuntimeFailureFallback(run, { provider, sessionId, message: failure });
    }
  } finally {
    if (taskRunToken && revokeTaskCapability) {
      revokeTaskCapability(taskRunToken);
    }
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, deferred ? { exitCode: 0, reason: 'engine_completed' } : { exitCode: 1, reason: 'dispatch_failed' });
    sessionsDb.touchSession(sessionId);
  }

  if (!inputAccepted) {
    return { started: false, ...(deferred ? { busy: true } : {}), error: failure ?? 'The engine did not accept the input.' };
  }
  const outcome = readObjectRecord(runtimeOutcome);
  const terminalStatus = outcome?.terminalStatus;
  if (extraRuntimeOptions.taskContinuation && outcome?.busy === true && !outcome.engineTurnId) {
    return { started: false, busy: true, error: 'The engine is busy; the tool result has not been submitted.' };
  }
  return {
    started: true,
    error: failure,
    ...(typeof outcome?.engineTurnId === 'string' ? { engineTurnId: outcome.engineTurnId } : {}),
    ...(terminalStatus === 'completed' || terminalStatus === 'failed'
      || terminalStatus === 'interrupted' || terminalStatus === 'unknown'
      ? { terminalStatus }
      : {}),
  };
}

/**
 * Handles `chat.edit-send`: replaces an already-sent message and everything
 * after it with a new turn.
 *
 * Nothing is deleted. The provider resumes the conversation partway and
 * appends the replacement, so the abandoned attempt stays in the transcript
 * file and is simply no longer part of the live conversation — the same shape
 * Claude Code's rewind and Codex's fork-with-cut-point produce.
 */
async function handleChatEditSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.edit-send');
  if (!resolved) {
    return;
  }

  const { sessionId, session, provider } = resolved;
  const anchorId = typeof data.anchorId === 'string' ? data.anchorId.trim() : '';
  if (!anchorId) {
    sendProtocolError(ws, 'ANCHOR_REQUIRED', 'chat.edit-send requires the anchorId of the message being replaced.', sessionId);
    return;
  }

  let resumeThroughId: string | null;
  try {
    const anchor = await sessionsService.resolveEditAnchor(sessionId, anchorId);
    if (!anchor) {
      sendProtocolError(
        ws,
        'EDIT_NOT_SUPPORTED',
        `Provider "${provider}" cannot replace an already-sent message.`,
        sessionId
      );
      return;
    }
    if (!anchor.found) {
      sendProtocolError(ws, 'ANCHOR_NOT_FOUND', 'That message is no longer in the transcript.', sessionId);
      return;
    }
    resumeThroughId = anchor.resumeThroughId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(ws, 'ANCHOR_LOOKUP_FAILED', `Could not read the transcript: ${message}`, sessionId);
    return;
  }

  // Providers split here on what their runtime can do. Claude resumes its
  // transcript partway, so the anchor rides along as a run option. Codex
  // cannot — a thread only grows — so the conversation is rewound on disk and
  // the run that follows is an ordinary resume of whatever the session then
  // points at. Which of the two applies is decided here; the rewind itself
  // waits until the run has actually been admitted.
  const rewinds = sessionsService.providerRewindsForEdit(sessionId);

  await dispatchRun(
    ws,
    userId,
    sessionId,
    session,
    data,
    dependencies,
    // `null` is meaningful: the edited turn was the first prompt, so the
    // conversation starts over instead of resuming.
    rewinds
      ? {}
      : { resumeAnchorId: resumeThroughId ?? undefined, resumeFromScratch: resumeThroughId === null },
    async (run) => {
      // Emitted through the run's writer so it is sequenced and replayed like
      // any other event — a second tab watching this session has to truncate
      // too.
      //
      // Before the rewind, not after it. A rewind that has to branch spawns a
      // process and waits on a JSON-RPC round trip, and holding the frame
      // until that came back left the message the user had just edited away
      // sitting on screen for about a second — the very flicker this feature
      // exists to avoid. Announcing first is safe because a rewind that fails
      // still ends the run, and the terminal `complete` makes every client
      // re-read the transcript, which puts back anything that turned out not
      // to have been replaced after all.
      run.writer.send({
        kind: 'history_truncated',
        provider,
        sessionId,
        anchorId,
      });

      if (rewinds) {
        try {
          await sessionsService.rewindSessionForEdit(sessionId, resumeThroughId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendProtocolError(ws, 'EDIT_REWIND_FAILED', `Could not rewind the conversation: ${message}`, sessionId);
          // Ends the run before the provider is asked to continue a
          // conversation that was not rewound after all.
          throw error;
        }
      }
    },
  );
}

/**
 * Handles `chat.abort`: cancels a foreground run or a held background reply.
 * Only foreground runs need a terminal `complete`; held runtimes clear their
 * background state through the existing status stream on release.
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    // A turn's complete does not end the held process that relays background
    // results. There is no task id during that reply, so stop the runtime.
    const session = sessionsDb.getSessionById(sessionId);
    if (session && dependencies.runtime.hasBackgroundWork(sessionId)) {
      const success = await dependencies.runtime.abort(session.provider as LLMProvider, sessionId);
      if (!success) {
        sendProtocolError(ws, 'ABORT_FAILED', `Could not stop background work for session "${sessionId}".`, sessionId);
      }
      return;
    }
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  console.log(
    `[ChatWebSocket] chat.abort received for session ${sessionId} (${run.provider}), `
    + `run started ${Date.now() - run.startedAt}ms ago`,
  );
  const success = await dependencies.runtime.abort(run.provider, sessionId);
  if (!success) {
    sendProtocolError(ws, 'ABORT_FAILED', `Could not stop the active run for session "${sessionId}".`, sessionId);
    return;
  }

  chatRunRegistry.completeRunIfCurrent(run, {
    exitCode: 0,
    aborted: true,
    reason: 'client_abort',
  });
}

/**
 * Handles `chat.stop-task`: stops one background task of a session — an
 * agent, a workflow or a backgrounded command that is still going after its
 * turn ended. Unlike `chat.abort` there is no run to consult: the task lives
 * in the provider's held process, which is the only thing that can stop it.
 * The provider then reports the task as stopped on the session's stream, so
 * nothing is echoed back here on success.
 */
async function handleChatStopTask(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.stop-task requires a sessionId.');
    return;
  }

  const taskId = typeof data.taskId === 'string' ? data.taskId.trim() : '';
  if (!taskId) {
    sendProtocolError(ws, 'TASK_ID_REQUIRED', 'chat.stop-task requires a taskId.', sessionId);
    return;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(ws, 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, sessionId);
    return;
  }

  const stopped = await dependencies.runtime.stopBackgroundTask(
    session.provider as LLMProvider,
    sessionId,
    taskId,
  );
  if (!stopped) {
    sendProtocolError(
      ws,
      'NO_SUCH_TASK',
      `Session "${sessionId}" has no running background task "${taskId}".`,
      sessionId,
    );
  }
}

/** Whether the session's provider holds a new message back while background work runs; true when unknown. */
function readBackgroundWorkQueuesInput(sessionId: string, dependencies: ChatWebSocketDependencies): boolean {
  const provider = sessionsDb.getSessionById(sessionId)?.provider;
  if (!provider || !dependencies.runtime.backgroundWorkQueuesInput) {
    return true;
  }
  return dependencies.runtime.backgroundWorkQueuesInput(provider as LLMProvider, sessionId);
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const epoch = (target as AnyRecord).streamEpoch;
    if ((lastSeqRaw !== undefined && !isValidReplaySeq(lastSeqRaw, true))
      || ('streamEpoch' in target && !isValidStreamEpoch(epoch))) {
      sendProtocolError(ws, 'INVALID_SUBSCRIPTION', 'Invalid replay cursor.', sessionId);
      continue;
    }
    const lastSeq = lastSeqRaw ?? 0;

    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    // A session whose turn ended but whose background work is still going
    // keeps producing events through the same writer (task progress, the
    // turn the CLI pushes when a task reports), so a tab opened during that
    // work attaches too; the registry keeps the run while the work lasts.
    // The socket joins the session's audience whenever there is one: a
    // resident engine can report after its run is over, and that report
    // travels on the session's channel. The run itself only keeps the socket
    // while it is running or while its session still has background work.
    chatRunRegistry.attachConnection(sessionId, ws, {
      includeRun: isProcessing || dependencies.runtime.hasBackgroundWork(sessionId),
    });

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);
    const backgroundTasks = dependencies.runtime.getBackgroundTasksForSession?.(sessionId) || [];

    // `lastSeq` is the session's authoritative watermark (clients realign to
    // it); `stale` tells the client its `lastSeq` predates the replay buffer
    // and it must refresh history over REST instead of trusting the replay.
    let replay = chatRunRegistry.replayEvents(sessionId, lastSeq);
    const changedEpoch = epoch !== undefined && epoch !== replay.streamEpoch;
    if (changedEpoch) replay = chatRunRegistry.replayEvents(sessionId, 0);

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: replay.lastSeq,
      streamEpoch: replay.streamEpoch,
      replayFromSeq: isProcessing ? replay.replayFromSeq : replay.lastSeq + 1,
      stale: changedEpoch || replay.stale || (!isProcessing && lastSeq < replay.lastSeq),
      pendingPermissions,
      backgroundTasks,
      backgroundWorkPending: dependencies.runtime.isBackgroundWorkPending(sessionId),
      backgroundCanInterrupt: dependencies.runtime.canInterruptBackgroundWork?.(sessionId) ?? true,
      backgroundWorkQueuesInput: readBackgroundWorkQueuesInput(sessionId, dependencies),
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of replay.events) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.runtime.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.stop-task`           { sessionId, taskId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
/**
 * Runs a turn for a session with no client attached.
 *
 * Used by scheduled messages, which fire from a timer: there is no socket to
 * report errors to and no audience to stream to. The run is registered exactly
 * like an interactive one, so anyone who opens the session while it is going
 * subscribes and replays it from the start, and the session shows as busy
 * everywhere in the meantime.
 *
 * Resolves when the provider run settles. Returns false when the session has
 * gone away or is busy without `interruptActiveRun`, which the caller reports
 * on the schedule.
 */
export async function runDetachedChatTurn(
  input: {
    sessionId: string;
    userId: string | number | null;
    content: string;
    options?: AnyRecord;
    /**
     * Aborts a run already in progress instead of refusing to start. A
     * scheduled message sets this: the user picked the time knowing it might
     * land mid-run, so the timer outranks whatever is running.
     */
    interruptActiveRun?: boolean;
    /** 可信的原子领取回调，在运行时提交输入前核对排队消息是否仍有效。 */
    onBeforeInputAccepted?: () => boolean;
    /** 支持输入确认时在 SDK 消费后调用，否则在登记运行后调用。 */
    onRunStarted?: () => void;
    taskContinuation?: AnyRecord;
    onEngineTurnStarted?: (engineTurnId: string) => boolean;
    taskContinuationTarget?: {
      providerThreadId: string;
      sessionProjectPath: string;
      workingDirectory: string;
      sandboxPolicyType: 'workspaceWrite' | 'dangerFullAccess';
      networkAccess: boolean;
      approvalPolicy: 'never' | 'on-request';
    };
  },
  dependencies: ChatWebSocketDependencies,
): Promise<{
  started: boolean;
  busy?: boolean;
  error: string | null;
  engineTurnId?: string;
  terminalStatus?: 'completed' | 'failed' | 'interrupted' | 'unknown';
}> {
  const session = sessionsDb.getSessionById(input.sessionId);
  if (!session) {
    return { started: false, error: 'The session no longer exists.' };
  }

  const taskTarget = input.taskContinuationTarget;
  if (taskTarget && (session.provider !== 'codex'
    || session.isArchived
    || session.provider_session_id !== taskTarget.providerThreadId
    || !session.project_path
    || path.resolve(session.project_path) !== path.resolve(taskTarget.sessionProjectPath))) {
    return { started: false, error: 'The original conversation is archived or its thread/workspace has changed.' };
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    return { started: false, error: `Provider "${provider}" is not available.` };
  }

  if (input.taskContinuation && dependencies.runtime.hasSessionWork?.(input.sessionId)) {
    return { started: false, busy: true, error: 'The conversation still has engine work; task delivery will wait.' };
  }

  const activeRun = chatRunRegistry.getRun(input.sessionId);
  if (activeRun && activeRun.status === 'running') {
    if (!input.interruptActiveRun) {
      return { started: false, busy: true, error: 'A run was already in progress for this session.' };
    }
    // Same shape as `chat.abort`: cancel the provider run and emit the
    // terminal `complete` on its behalf, so every watching client sees the
    // interrupted run end before this turn's stream begins. The interrupted
    // run's own dispatch settles later through completeRunIfCurrent, which is
    // scoped to that run and cannot touch the one started here.
    const aborted = await dependencies.runtime.abort(activeRun.provider, input.sessionId);
    chatRunRegistry.completeRun(input.sessionId, {
      exitCode: aborted ? 0 : 1,
      aborted: true,
      reason: 'superseded',
    });
  }

  const waitForInputAcceptance = dependencies.runtime.supportsInputAcceptance?.(provider) === true;
  return dispatchRun(
    null,
    input.userId,
    input.sessionId,
    session,
    { sessionId: input.sessionId, content: input.content, options: input.options ?? {} },
    dependencies,
    {
      ...(waitForInputAcceptance ? {
        onBeforeInputAccepted: input.onBeforeInputAccepted,
        onInputAccepted: () => input.onRunStarted?.(),
      } : {}),
      ...(input.taskContinuation ? { taskContinuation: input.taskContinuation } : {}),
      ...(taskTarget ? { taskContinuationTarget: taskTarget } : {}),
      ...(input.onEngineTurnStarted ? {
        taskContinuationLifecycle: { onEngineTurnStarted: input.onEngineTurnStarted },
      } : {}),
    },
    !waitForInputAcceptance && input.onRunStarted ? () => input.onRunStarted?.() : undefined,
  );
}

export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    let data: AnyRecord | undefined;
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.edit-send':
          await handleChatEditSend(ws, userId, data, dependencies);
          return;
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.stop-task':
          await handleChatStopTask(ws, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      // Stop failures belong to an existing session and do not finish its run.
      // Preserve the request kind so clients show the error without dropping
      // live activity or releasing queued messages.
      const code = data?.type === 'chat.stop-task' ? 'TASK_STOP_FAILED'
        : data?.type === 'chat.abort' ? 'ABORT_FAILED' : 'INTERNAL_ERROR';
      sendProtocolError(ws, code, message, data ? readRequiredSessionId(data) ?? undefined : undefined);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
