/**
 * ZCode Run Lifecycle
 *
 * Owns the state of one ZCode run — from `run()` start to terminal cleanup —
 * plus the permission-bridge registry that outlives single runs.
 *
 * Before this module the per-run state lived in five module-level containers
 * inside the runtime provider (active sessions, abort intents, completion
 * state carrying the silence-watchdog stamp and token usage, permission
 * writers, permission app-session ids). They were created together on every
 * run and had to be cleaned up in sync from two places — the run's finally
 * and the background watcher's finally — with ownership passed between them
 * by a boolean flag plus object-identity comparisons. They are one lifecycle:
 * this module collapses them into a single `RunHandle` per run and makes the
 * ownership explicit on the handle (`owner`), so cleanup exists exactly once
 * (`dispose`) and a detached watcher can never fight the run that spawned it.
 *
 * The permission registry deliberately outlives its run: a pending card that
 * is answered after the run still resolves the engine's parked request
 * instead of leaking it, so only the writer mapping (which needs a live chat
 * stream) is run-scoped.
 *
 * Consumers: zcode-runtime.provider (the only production consumer — the run
 * orchestration, the abort path, the permissions facet) and
 * `server/modules/providers/tests/zcode-run-lifecycle.test.ts`.
 *
 * @module zcode-run-lifecycle
 */

import type { ProviderPermissionDecision, ProviderRuntimeWriter } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readOptionalString } from '@/shared/utils.js';

import type { ProtocolServerRequest } from './zcode-codec.js';
import { defaultServerRequestHandler } from './zcode-request-router.js';
import type { ServerRequestAnswer } from './zcode-request-router.js';

/** How often the settle waits poll the run's state. */
const COMPLETION_POLL_INTERVAL_MS = 100;

/**
 * How long the engine may stay completely silent (no notifications for the
 * session) before a run is reported as stalled. Bounds engine silence, not
 * total run duration — a turn that keeps streaming output never times out,
 * no matter how long it runs. Override for tests via
 * `CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS` (positive integer milliseconds).
 */
const DEFAULT_SILENCE_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveSilenceTimeoutMs(): number {
  const raw = Number(process.env.CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SILENCE_TIMEOUT_MS;
}

/**
 * Carries the user-visible silence-stall text. The runtime sends its message
 * to the chat stream when a run (or its detached watcher) exhausts a silence
 * window; the lifecycle only reports the settle kind.
 */
export class EngineSilenceTimeoutError extends Error {
  constructor(timeoutMs: number) {
    const minutes = Math.max(1, Math.round(timeoutMs / 60000));
    super(
      `ZCode engine has been silent for ${minutes} min — the run stays attached in the background and will finish automatically when the engine responds`
    );
    this.name = 'EngineSilenceTimeoutError';
  }
}

/**
 * How a wait on a run ended. `superseded` means a newer run replaced this
 * handle in the registry (same abort key), so the waiter owns neither the
 * event stream nor the completion anymore and must stand down.
 */
export type RunSettle =
  | { kind: 'completed' }
  | { kind: 'aborted' }
  | { kind: 'silent'; timeoutMs: number }
  | { kind: 'superseded' };

/**
 * Completion bookkeeping for one run. `completed` is the terminal latch the
 * settle waits poll; `failed`/`failedMessage` mark runs that ended with a
 * terminal error (turn.failed/fatal/session-lost) so the final complete
 * message reports a non-zero exit code and the notification reports a
 * failure; `tokenUsage` is the run's total used-token count for the final
 * complete message; `lastActivityAt` is the silence-watchdog stamp, refreshed
 * by every engine notification for the session.
 */
type RunState = {
  completed: boolean;
  failed?: boolean;
  failedMessage?: string;
  tokenUsage?: number;
  lastActivityAt: number;
};

export type RunStart = {
  /** App-facing session id, or the ZCode id when the caller had none. */
  abortKey: string;
  /** ZCode-native session id this run drives. */
  sessionId: string;
  appSessionId: string | null;
  writer: ProviderRuntimeWriter;
};

/**
 * One live run. Created by `startRun`, looked up by the abort path and the
 * permission bridge; the state is lifecycle-owned — read it through
 * `completionOf`, write it through the `record*` methods.
 */
export type RunHandle = {
  readonly abortKey: string;
  readonly sessionId: string;
  readonly appSessionId: string | null;
  readonly writer: ProviderRuntimeWriter;
  /** Set when a delivered session/stop confirmed the user's abort. */
  abortRequested: boolean;
  /**
   * Who performs terminal handling and cleanup: the run coroutine until the
   * silence watchdog hands off, the detached watcher afterwards. A handle
   * whose owner is the watcher must not be disposed by the run's finally.
   */
  owner: 'run' | 'watcher';
  readonly state: RunState;
};

type PendingPermissionDetails = {
  toolName: string;
  toolId?: string;
  input: unknown;
  context: unknown;
  sessionId: string;
  /** App-facing session id, when the run knew one — `chat.subscribe` looks pending approvals up by it. */
  appSessionId?: string;
  receivedAt: Date;
  /**
   * When the engine last announced this request. Refreshed on every
   * re-announcement, so the pending TTL bounds how long the engine kept
   * asking — not how long the user took to think.
   */
  lastAnnouncedAt: number;
};

/**
 * What the UI needs to render an answerable card for each pending request.
 * chat.subscribe replays these (via `listPendingPermissions`) after a page
 * reload, so they must be fully shaped — a bare request id renders a dead
 * card whose buttons are dropped for lacking a requestId.
 */
export type PendingPermissionView = {
  requestId: string;
  toolName: string;
  toolId?: string;
  input: unknown;
  context: unknown;
  sessionId: string;
  receivedAt: Date;
};

/**
 * Decisions already delivered to the engine, kept briefly: the engine
 * re-announces a pending permission on an interval under a fresh protocol id,
 * and a re-announcement racing a just-recorded decision must be answered from
 * this record instead of surfacing a second, never-resolvable card. The
 * toolCallId rides along so a reused requestId with different call content is
 * treated as a fresh request rather than silently auto-answered.
 */
const ANSWERED_PERMISSION_TTL_MS = 5 * 60 * 1000;

/**
 * How long a pending permission card stays answerable after the engine's
 * last announcement. The engine's own server-request window is 15s and it
 * re-announces while it still cares, so an entry with no re-announcement for
 * this long is a leftover of a dead run — a zombie card nothing could ever
 * resolve. Generous enough that a card the engine still cares about (it
 * keeps re-announcing, refreshing the stamp) never expires underneath a
 * thinking user.
 */
const PENDING_PERMISSION_TTL_MS = 30 * 60 * 1000;

/**
 * Lifecycle tunables, injectable for tests.
 */
export type ZCodeRunLifecycleOptions = {
  answeredTtlMs?: number;
  pendingTtlMs?: number;
};

/**
 * The state machine and registries for ZCode runs. One instance is shared by
 * the runtime provider class and its permissions facet (module-private in
 * zcode-runtime.provider.ts); tests instantiate their own.
 */
export class ZCodeRunLifecycle {
  /** Live runs by abort key (app-facing session id). Newest run wins. */
  private readonly runs = new Map<string, RunHandle>();
  /** Live runs by ZCode-native session id — what the permission bridge and engine events resolve against. */
  private readonly runsByEngineSession = new Map<string, RunHandle>();

  /**
   * One resolver per in-flight protocol request id: the engine re-announces a
   * pending permission as a *new* server request (fresh protocol id) on an
   * interval, and whichever announcement the engine ends up waiting on must
   * receive the decision — so a user decision answers every stacked resolver
   * for the business-level requestId.
   */
  private readonly pendingPermissionResolvers = new Map<string, Array<(answer: ServerRequestAnswer) => void>>();
  private readonly pendingPermissionDetails = new Map<string, PendingPermissionDetails>();
  private readonly answeredPermissions = new Map<string, { answer: ServerRequestAnswer; toolCallId?: string; expiresAt: number }>();
  private readonly answeredTtlMs: number;
  private readonly pendingTtlMs: number;

  constructor(options: ZCodeRunLifecycleOptions = {}) {
    this.answeredTtlMs = options.answeredTtlMs ?? ANSWERED_PERMISSION_TTL_MS;
    this.pendingTtlMs = options.pendingTtlMs ?? PENDING_PERMISSION_TTL_MS;
  }

  /**
   * Registers a new run, replacing any earlier handle for the same abort key
   * or engine session (a previous run that somehow never settled is thereby
   * marked superseded and stands down).
   */
  startRun(start: RunStart): RunHandle {
    const handle: RunHandle = {
      abortKey: start.abortKey,
      sessionId: start.sessionId,
      appSessionId: start.appSessionId,
      writer: start.writer,
      abortRequested: false,
      owner: 'run',
      state: { completed: false, lastActivityAt: Date.now() },
    };
    this.runs.set(start.abortKey, handle);
    this.runsByEngineSession.set(start.sessionId, handle);
    return handle;
  }

  /** The live run an abort request targets, by app-facing session id. */
  handleOf(abortKey: string): RunHandle | undefined {
    return this.runs.get(abortKey);
  }

  /** Whether this handle is still the run registered for its abort key. */
  isActiveRun(handle: RunHandle): boolean {
    return this.runs.get(handle.abortKey) === handle;
  }

  /** A readonly view of the run's terminal bookkeeping for reporting. */
  completionOf(handle: RunHandle): { failed: boolean; failedMessage?: string; tokenUsage?: number } {
    return {
      failed: handle.state.failed ?? false,
      failedMessage: handle.state.failedMessage,
      tokenUsage: handle.state.tokenUsage,
    };
  }

  /** Refreshes the silence-watchdog stamp — every engine notification for the session is a sign of life. */
  recordActivity(handle: RunHandle): void {
    handle.state.lastActivityAt = Date.now();
  }

  /** Records the engine's turn-completion bookkeeping (token usage + terminal latch). */
  recordCompletion(handle: RunHandle, tokenUsage?: number): void {
    if (typeof tokenUsage === 'number') {
      handle.state.tokenUsage = tokenUsage;
    }
    handle.state.completed = true;
  }

  /** Records a terminal engine error event (turn.failed / fatal). */
  recordEngineError(handle: RunHandle, message?: string): void {
    handle.state.failed = true;
    handle.state.completed = true;
    handle.state.failedMessage = message;
  }

  /**
   * Records engine-process death for this session. Guarded: a run that
   * already reached a terminal state keeps it.
   */
  recordSessionLost(handle: RunHandle): void {
    if (handle.state.completed) {
      return;
    }
    handle.state.failed = true;
    handle.state.completed = true;
    handle.state.failedMessage = 'ZCode engine connection was lost';
  }

  /**
   * Records a user abort that the engine confirmed (a `session/stop` that was
   * actually delivered). The settle wait returns `aborted` promptly, and the
   * terminal notification reports the run as aborted. A stop that failed must
   * NOT be recorded here: the engine keeps working, so the run has to settle
   * on its real terminal event instead.
   */
  requestAbort(handle: RunHandle): void {
    handle.abortRequested = true;
  }

  /**
   * Hands the run to its background watcher: the watcher now owns the
   * terminal handling and the cleanup, so the run's finally must leave the
   * handle alone. The silence window restarts at handoff — the run already
   * waited one full silent window before getting here, so measuring from the
   * stale stamp would immediately re-fire the watchdog.
   */
  detachToWatcher(handle: RunHandle): void {
    handle.owner = 'watcher';
    handle.state.lastActivityAt = Date.now();
  }

  /**
   * Waits until the run reaches a terminal state. `timeoutMs` bounds engine
   * *silence* (no notifications refreshing `lastActivityAt`), not total run
   * duration — a turn that keeps producing output never settles as silent.
   */
  async waitForSettle(handle: RunHandle, timeoutMs: number): Promise<RunSettle> {
    while (true) {
      if (!this.isActiveRun(handle)) {
        return { kind: 'superseded' };
      }
      if (handle.state.completed) {
        return { kind: 'completed' };
      }
      if (handle.abortRequested) {
        return { kind: 'aborted' };
      }
      if (Date.now() - handle.state.lastActivityAt > timeoutMs) {
        return { kind: 'silent', timeoutMs };
      }
      await new Promise(resolve => setTimeout(resolve, COMPLETION_POLL_INTERVAL_MS));
    }
  }

  /**
   * The single cleanup point for a finished run: drops both registry
   * entries. Guarded by registry identity, so a watcher standing down after
   * a newer run claimed the session cannot tear the new run's entries out.
   */
  dispose(handle: RunHandle): void {
    if (this.runs.get(handle.abortKey) === handle) {
      this.runs.delete(handle.abortKey);
    }
    if (this.runsByEngineSession.get(handle.sessionId) === handle) {
      this.runsByEngineSession.delete(handle.sessionId);
    }
  }

  /**
   * Bridges the engine's `interaction/requestPermission` server request to
   * the owning run's chat stream. Installed once over the router's default
   * policy; every other method falls through unchanged.
   */
  handleServerRequest(request: ProtocolServerRequest): ServerRequestAnswer | Promise<ServerRequestAnswer> {
    if (request.method !== 'interaction/requestPermission') {
      return defaultServerRequestHandler(request);
    }

    const params = request.params ?? {};
    const requestId = readOptionalString(params.requestId);
    const sessionId = readOptionalString(params.sessionId);
    if (!requestId) {
      return { error: { code: -32602, message: 'interaction/requestPermission is missing requestId' } };
    }

    // A decision already went out for this requestId (an earlier announcement
    // was answered); serve this late re-announcement from the record instead of
    // surfacing a second card that nothing will ever resolve. A reused
    // requestId carrying different call content is a fresh request and must not
    // inherit the old decision.
    this.sweepExpiredPermissions();
    const answered = this.answeredPermissions.get(requestId);
    if (answered && answered.toolCallId === readOptionalString(params.toolCallId)) {
      return answered.answer;
    }

    const stack = this.pendingPermissionResolvers.get(requestId);

    // The engine re-announces pending requests on an interval as fresh protocol
    // requests (new ids); stack a resolver per announcement so the decision
    // reaches whichever one the engine is waiting on. The re-announcement also
    // proves the engine still cares, so the pending card's freshness stamp
    // restarts instead of expiring under a thinking user.
    if (stack) {
      const pending = this.pendingPermissionDetails.get(requestId);
      if (pending) {
        pending.lastAnnouncedAt = Date.now();
      }
      return new Promise<ServerRequestAnswer>((resolve) => {
        stack.push(resolve);
      });
    }

    const handle = sessionId ? this.runsByEngineSession.get(sessionId) : undefined;
    if (!sessionId || !handle) {
      return { result: { decision: 'deny', reason: 'No active chat stream for this session' } };
    }

    const toolName = readOptionalString(params.toolName) ?? 'Tool';
    const toolId = readOptionalString(params.toolCallId);
    const context = {
      riskLevel: readOptionalString(params.riskLevel),
      reason: readOptionalString(params.reason),
      options: params.options,
      suggestedPermissionUpdates: params.suggestedPermissionUpdates,
    };

    // Register before sending the frame: if the send throws, the parked
    // resolver and details still form a consistent, answerable pending entry
    // (the engine will re-announce, which stacks onto the registered resolver).
    this.pendingPermissionDetails.set(requestId, {
      toolName,
      toolId,
      input: params.input,
      context,
      sessionId,
      appSessionId: handle.appSessionId ?? undefined,
      receivedAt: new Date(),
      lastAnnouncedAt: Date.now(),
    });
    this.pendingPermissionResolvers.set(requestId, []);

    handle.writer.send(createNormalizedMessage({
      id: generateMessageId('zcode'),
      sessionId,
      provider: 'zcode',
      kind: 'permission_request',
      requestId,
      toolName,
      toolId,
      input: params.input,
      context,
      canInterrupt: true,
    }));

    return new Promise<ServerRequestAnswer>((resolve) => {
      this.pendingPermissionResolvers.get(requestId)?.push(resolve);
    });
  }

  /**
   * Answers a pending permission from the chat gateway's
   * `chat.permission-response` flow. Consumer:
   * `provider-runtime.service.resolveToolApproval` fans decisions out to
   * every provider's permissions facet; zcode only answers request ids it
   * bridged itself.
   */
  resolvePermission(requestId: string, decision: ProviderPermissionDecision): void {
    this.sweepExpiredPermissions();
    if (!this.pendingPermissionResolvers.has(requestId)) {
      // A stale response — the card was answered elsewhere, or the run died
      // with the resolver still parked. This used to vanish silently, which
      // made dead-card reports impossible to diagnose.
      console.debug(`[ZCode] permission response for unknown request id: ${requestId}`);
      return;
    }

    const details = this.pendingPermissionDetails.get(requestId);

    if (decision.allow) {
      this.answerPendingPermission(requestId, decision.updatedInput !== undefined
        ? { result: { decision: 'modify', modifiedInput: decision.updatedInput, reason: decision.message } }
        : { result: { decision: 'allow', reason: decision.message } });
      this.retractPendingPermission(requestId, details);
      return;
    }

    this.answerPendingPermission(requestId, { result: { decision: 'deny', reason: decision.message ?? 'Denied by user' } });
    this.retractPendingPermission(requestId, details);
  }

  /**
   * The pending cards for one session, matched in both id spaces: the
   * gateway subscribes by app-facing session id, while the bridge keys its
   * writer by the engine's native id.
   */
  listPendingPermissions(sessionId: string): PendingPermissionView[] {
    this.sweepExpiredPermissions();
    const pending: PendingPermissionView[] = [];
    for (const [requestId, details] of this.pendingPermissionDetails) {
      if (details.sessionId !== sessionId && details.appSessionId !== sessionId) {
        continue;
      }
      pending.push({
        requestId,
        toolName: details.toolName,
        toolId: details.toolId,
        input: details.input,
        context: details.context,
        sessionId: details.appSessionId ?? details.sessionId,
        receivedAt: details.receivedAt,
      });
    }
    return pending;
  }

  private rememberAnsweredPermission(requestId: string, answer: ServerRequestAnswer, toolCallId?: string): void {
    const now = Date.now();
    for (const [key, value] of this.answeredPermissions) {
      if (value.expiresAt <= now) {
        this.answeredPermissions.delete(key);
      }
    }
    this.answeredPermissions.set(requestId, { answer, toolCallId, expiresAt: now + this.answeredTtlMs });
  }

  private answerPendingPermission(requestId: string, answer: ServerRequestAnswer): void {
    const resolvers = this.pendingPermissionResolvers.get(requestId);
    if (!resolvers) {
      return;
    }
    this.pendingPermissionResolvers.delete(requestId);
    this.rememberAnsweredPermission(requestId, answer, this.pendingPermissionDetails.get(requestId)?.toolId);
    this.pendingPermissionDetails.delete(requestId);
    for (const resolve of resolvers) {
      try {
        resolve(answer);
      } catch {
        // A resolver that throws on settle must not block its siblings.
      }
    }
  }

  /**
   * Tells the live chat stream a pending card is gone; without this the card
   * only disappears on a `complete` replay, so a client that (re)subscribes
   * after the decision sees a zombie permission request forever.
   */
  private retractPendingPermission(requestId: string, details: PendingPermissionDetails | undefined): void {
    const sessionId = details?.sessionId;
    if (!sessionId) {
      return;
    }
    const writer = this.runsByEngineSession.get(sessionId)?.writer;
    if (!writer) {
      return;
    }
    writer.send(createNormalizedMessage({
      id: generateMessageId('zcode'),
      sessionId,
      provider: 'zcode',
      kind: 'permission_cancelled',
      requestId,
    }));
  }

  /**
   * Drops expired permission bookkeeping. The answered-decision cache expires
   * by its own TTL; a pending card expires once the engine has not
   * re-announced it for the pending TTL — engine announcements restart that
   * stamp, so anything swept here is a leftover of a run or engine session
   * that died with the card still pending. The parked engine requests are
   * resolved with an explicit deny instead of being dropped: an un-resolved
   * answer promise would leave the router's server-request reply pending
   * forever.
   */
  private sweepExpiredPermissions(): void {
    const now = Date.now();
    for (const [key, value] of this.answeredPermissions) {
      if (value.expiresAt <= now) {
        this.answeredPermissions.delete(key);
      }
    }

    for (const [key, details] of this.pendingPermissionDetails) {
      if (now - details.lastAnnouncedAt <= this.pendingTtlMs) {
        continue;
      }
      this.pendingPermissionDetails.delete(key);
      const resolvers = this.pendingPermissionResolvers.get(key) ?? [];
      this.pendingPermissionResolvers.delete(key);
      for (const resolve of resolvers) {
        try {
          resolve({ result: { decision: 'deny', reason: 'Permission request expired unanswered' } });
        } catch {
          // A resolver that throws on settle must not block its siblings.
        }
      }
    }
  }
}
