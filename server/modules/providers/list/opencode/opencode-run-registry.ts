/**
 * OpenCode Run Registry
 *
 * Bookkeeping for chat runs in flight against the service: which app
 * session maps to which provider session, the per-run event translator,
 * first-settlement-wins outcome tracking, event dispatch, and the
 * reconciliation that rescues a run whose terminal event was lost during a
 * stream drop (the session row's `time.idle`/`outcome`, verified live
 * against v2.0.31, say whether it already finished).
 *
 * It also tracks work the engine moved to the background past its turn: a
 * child session until its own terminal (or a deadline verdict), and a shell
 * job until the engine's synthetic notice names it — or until the service's
 * own shell record contradicts it. The shell job does not hold the parent run
 * — the report turn the engine starts when it ends is adopted as a run of its
 * own — and it is stopped through `DELETE /api/shell/:id`.
 *
 * @module opencode-run-registry
 */

import type {
  ActiveBackgroundTask,
  BackgroundTaskStatus,
  BackgroundTaskSummary,
  NormalizedMessage,
  ProviderRuntimeWriter,
  ProviderTokenUsageResult,
} from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { createBackgroundTasksStatusMessage, LOCAL_BASH_TASK_TYPE } from '../../shared/background-work/task-status.js';

import { OpenCodeApiError, type OpenCodeApiClient, type OpenCodeSessionSnapshot, type OpenCodeShellSnapshot } from './opencode-api.client.js';
import {
  readBackgroundNotice,
  type OpenCodeBackgroundLaunch,
  type OpenCodeBackgroundNotice,
} from './opencode-background-work.js';
import {
  buildOpenCodeTokenBudget,
  readOpenCodeStepTokens,
  resolveOpenCodeContextWindow,
  type OpenCodeStepTokens,
} from './opencode-context-usage.js';
import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';
import { OpenCodeSessionEventTranslator, type OpenCodeRunOutcome } from './opencode-event-translator.js';
import { OpenCodeSubagentIndex } from './opencode-subagent-index.js';

const PROVIDER = 'opencode' as const;
const MIN_BUDGET_FRAME_INTERVAL_MS = 1500;
/**
 * How long a completed run's bookkeeping is kept alive for a child session
 * that never reported a terminal, and the interval its tracking is re-judged
 * at. The engine reports a terminal on its own, so a deadline only backstops a
 * lost stream — or a child that legitimately runs longer than the window, in
 * which case the re-check below keeps it tracked instead of dropping it.
 */
const BACKGROUND_WORK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Total wall-clock one background child may stay tracked before its deadline
 * drops it regardless of what the engine says.
 *
 * The re-check settles a child the engine reports idle and leaves one that is
 * mid-turn alone, which bounds tracking to a live run — except when the engine
 * is gone but its session row still reads mid-turn. Nothing else would stop
 * the runtime from holding the run's writer for that child, so this cap is the
 * last backstop.
 */
const BACKGROUND_WORK_MAX_HOLD_MS = 6 * 60 * 60 * 1000;

/**
 * Live context-occupancy publisher for one opencode run.
 *
 * `session.step.ended` carries the step's own token usage (see
 * `opencode-context-usage.ts` for why the session columns cannot stand in),
 * and every report may emit a `token_budget` frame. Frames are deduplicated by
 * value and floored at 1.5s apart, the same contract zcode's live refresher
 * uses, so a long tool loop does not spam the composer with repaints.
 *
 * The window is resolved once at construction from the run's model reference;
 * a model the cache does not know simply yields windowless frames (no
 * percentage) rather than guessing one.
 *
 * Consumer: opencode runtime (`createOpenCodeRuntime`).
 */
export class OpenCodeTokenBudgetTracker {
  private readonly contextWindow: number | undefined;
  private lastSentAt = 0;
  private lastSentUsed: number | null = null;

  constructor(providerId: string | null, modelId: string | null) {
    this.contextWindow = providerId && modelId
      ? resolveOpenCodeContextWindow(providerId, modelId)
      : undefined;
  }

  /** Live frame from a step event's tokens; throttled by value and time. */
  report(tokens: OpenCodeStepTokens, writer: ProviderRuntimeWriter, appSessionId: string): void {
    this.emit(buildOpenCodeTokenBudget(tokens, this.contextWindow), writer, appSessionId);
  }

  /** Publishes one frame, applying the throttle. Public so the runtime can push the authoritative end-of-run reading. */
  emit(budget: ProviderTokenUsageResult, writer: ProviderRuntimeWriter, appSessionId: string): void {
    if (this.lastSentUsed === budget.used && Date.now() - this.lastSentAt < MIN_BUDGET_FRAME_INTERVAL_MS) {
      return;
    }

    this.lastSentUsed = budget.used;
    this.lastSentAt = Date.now();
    writer.send(createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      sessionId: appSessionId,
      provider: PROVIDER,
      kind: 'status',
      text: 'token_budget',
      tokenBudget: budget,
    }));
  }
}

/** How a run ended: an engine outcome, or `lost` when the service/session vanished under it. */
export type OpenCodeRunSettlement =
  | OpenCodeRunOutcome
  | { outcome: 'lost'; error: string };

/**
 * One chat run in flight.
 *
 * Consumer: opencode runtime (orchestration) via the registry.
 */
export type OpenCodeActiveRun = {
  appSessionId: string;
  providerSessionId: string;
  writer: ProviderRuntimeWriter;
  translator: OpenCodeSessionEventTranslator;
  /**
   * What the run was asked to do: an ordinary turn, or a `/compact`. A
   * compaction the user asked for must report its own failure, while the
   * engine compacting a normal turn's context on its own must not fail that
   * turn — see `dispatch`.
   */
  purpose: 'chat' | 'compact';
  /** Epoch ms right before the prompt was posted; `time.idle` at or after it means the run finished. */
  startedAt: number;
  aborted: boolean;
  /** Set once the prompt was accepted; only then can reconciliation judge the run. */
  promptAccepted: boolean;
  /**
   * This run's live occupancy publisher. Per run, never shared: the window
   * belongs to the run's model, so concurrent sessions on different models
   * must not divide each other's tokens by the wrong window.
   */
  budgetTracker?: OpenCodeTokenBudgetTracker;
  /** Resolves on the first settlement; later settlements are ignored. */
  settled: Promise<OpenCodeRunSettlement>;
  settle: (settlement: OpenCodeRunSettlement) => void;
  /**
   * Checkout this run was sent to. Shell jobs the run moves to the background
   * are scoped to it, so stopping or re-checking one addresses the service
   * instance that owns the job rather than its default workspace.
   */
  directory?: string;
};

/**
 * How the registry judges one child at its deadline: the runtime wires the
 * service's `GET /api/session/:id` reader here, the same row the run
 * reconciliation reads for a lost parent terminal. Tests pass their own.
 */
export type OpenCodeRunRegistryOptions = {
  readChildSnapshot?: (childSessionId: string) => Promise<OpenCodeSessionSnapshot>;
  /**
   * The service's `GET /api/shell/:id` reader, wired by the runtime: a shell
   * job has no session row, so its own record is the only verdict available.
   */
  readShellSnapshot?: (shellId: string, directory?: string) => Promise<OpenCodeShellSnapshot>;
  /** Total wall-clock one background task may stay tracked before its deadline drops it. */
  maxBackgroundHoldMs?: number;
  /** Interval a tracked task is re-judged at; default 30 minutes. Tests shorten it. */
  backgroundWorkTimeoutMs?: number;
};

/**
 * Tracks the runs of one runtime instance.
 *
 * Consumer: opencode runtime.
 */
export class OpenCodeRunRegistry {
  private readonly byApp = new Map<string, OpenCodeActiveRun>();
  private readonly byProvider = new Map<string, OpenCodeActiveRun>();
  /** Child session → spawning run links, learned from session lifecycle events. */
  private readonly subagents = new OpenCodeSubagentIndex();
  /** Child events that arrived before their parent tool call was identifiable. */
  private readonly deferredChildEvents = new Map<string, OpenCodeEventEnvelope[]>();
  /**
   * Background child sessions still running per app session, and the writer
   * that carries their status frames. They outlive the parent turn — a
   * completed run is kept registered while this map names its session, so the
   * composer can show the work and the child can still ask a question.
   */
  private readonly backgroundByApp = new Map<string, Map<string, BackgroundTaskSummary>>();
  /**
   * Backgrounded shell jobs per app session. The engine ends one by reporting
   * it, and the record behind `GET /api/shell/:id` is the only thing that can
   * contradict a job whose notice never came.
   */
  private readonly shellBackgroundByApp = new Map<string, Map<string, BackgroundTaskSummary>>();
  /** Checkout a shell job was launched from, for the directory-scoped shell routes. */
  private readonly backgroundDirectoryByTask = new Map<string, string>();
  private readonly backgroundWriterByApp = new Map<string, ProviderRuntimeWriter>();
  /**
   * Session-channel publisher per app session, supplied by the runtime when a
   * run starts. Status frames sent after that run ends must use it: the run
   * writer's audience is the sockets that watched the round, while the session
   * channel reaches a tab that subscribed later.
   */
  private readonly sessionPublisherByApp = new Map<string, (message: NormalizedMessage) => void>();
  /** Engine handle (a child session id or a shell id) → the app session that launched it. */
  private readonly backgroundAppByTask = new Map<string, string>();
  /** Resolvers waiting for one app session's background work to clear. */
  private readonly backgroundClearWaiters = new Map<string, Set<() => void>>();
  /** The one pending deadline per app session whose background work is tracked. */
  private readonly backgroundDeadlineTimers = new Map<string, NodeJS.Timeout>();
  private readonly readChildSnapshot: (childSessionId: string) => Promise<OpenCodeSessionSnapshot>;
  private readonly readShellSnapshot: (shellId: string, directory?: string) => Promise<OpenCodeShellSnapshot>;
  private readonly maxBackgroundHoldMs: number;
  private readonly backgroundWorkTimeoutMs: number;

  constructor(options: OpenCodeRunRegistryOptions = {}) {
    this.readChildSnapshot = options.readChildSnapshot ?? (async () => {
      // No reader wired: nothing can judge a child, so its deadline drops it —
      // the backstop's original behavior, kept for tests and host-less use.
      throw new Error('No child session reader is configured.');
    });
    this.readShellSnapshot = options.readShellSnapshot ?? (async () => {
      // Same backstop for a shell job: without a reader the hold cap is the
      // only verdict, so an unreadable job is kept until then.
      throw new Error('No shell reader is configured.');
    });
    this.maxBackgroundHoldMs = options.maxBackgroundHoldMs ?? BACKGROUND_WORK_MAX_HOLD_MS;
    this.backgroundWorkTimeoutMs = options.backgroundWorkTimeoutMs ?? BACKGROUND_WORK_TIMEOUT_MS;
  }

  create(
    appSessionId: string,
    providerSessionId: string,
    writer: ProviderRuntimeWriter,
    purpose: OpenCodeActiveRun['purpose'] = 'chat',
    directory?: string,
  ): OpenCodeActiveRun {
    let settle!: (settlement: OpenCodeRunSettlement) => void;
    const settled = new Promise<OpenCodeRunSettlement>((resolve) => {
      settle = resolve;
    });
    const run: OpenCodeActiveRun = {
      appSessionId,
      providerSessionId,
      writer,
      translator: new OpenCodeSessionEventTranslator(appSessionId),
      purpose,
      startedAt: Date.now(),
      aborted: false,
      promptAccepted: false,
      settled,
      settle,
      ...(directory ? { directory } : {}),
    };
    this.byApp.set(appSessionId, run);
    this.byProvider.set(providerSessionId, run);
    return run;
  }

  /** Looks a run up by either the app session id or the provider session id. */
  get(sessionId: string): OpenCodeActiveRun | null {
    return this.byApp.get(sessionId) ?? this.byProvider.get(sessionId) ?? null;
  }

  all(): OpenCodeActiveRun[] {
    return [...this.byApp.values()];
  }

  release(run: OpenCodeActiveRun): void {
    if (this.byApp.get(run.appSessionId) === run) {
      this.byApp.delete(run.appSessionId);
    }
    if (this.byProvider.get(run.providerSessionId) === run) {
      this.byProvider.delete(run.providerSessionId);
      for (const childSessionId of this.deferredChildEvents.keys()) {
        if (this.subagents.resolve(childSessionId)?.parentProviderSessionId === run.providerSessionId) {
          this.deferredChildEvents.delete(childSessionId);
        }
      }
      this.subagents.forgetParent(run.providerSessionId);
    }
  }

  settleAll(settlement: OpenCodeRunSettlement): void {
    for (const run of this.all()) {
      run.settle(settlement);
    }
    this.clearBackgroundWork();
  }

  /**
   * Records the gateway's session-channel publisher for one app session.
   * Consumer: the runtime's `run()`/`compact()`, so frames that outlive their
   * run still reach a tab that subscribed after it ended.
   */
  setSessionPublisher(appSessionId: string, publisher: (message: NormalizedMessage) => void): void {
    this.sessionPublisherByApp.set(appSessionId, publisher);
  }

  /** The active background work of one app session, in the wire shape the composer ack uses. */
  backgroundTasksFor(appSessionId: string): ActiveBackgroundTask[] {
    const tasks = this.allBackgroundTasks(appSessionId);
    return tasks.map((task) => ({
      // The card's identity is the launch call, not the engine's handle: the
      // transcript anchors its card by the call and `chat.stop-task` is keyed
      // by the tool-use id the client compares against, so one handle on the
      // strip both reveals the card and stops exactly this task.
      id: task.toolUseId || task.taskId,
      // Both kinds carry a stop handle: an agent is interrupted by its child
      // session id, a shell job by `DELETE /api/shell/:id` (see the runtime's
      // `stopBackgroundTask`).
      taskId: task.taskId,
      toolName: task.taskType === LOCAL_BASH_TASK_TYPE ? 'Bash' : 'subagent',
      ...(task.taskType === LOCAL_BASH_TASK_TYPE ? { command: task.description } : {}),
      description: task.description,
      startedAt: task.startedAt,
    }));
  }

  /** True while any background work (an agent or a shell job) of this app session still runs. */
  isBackgroundWorkPending(appSessionId: string): boolean {
    return this.backgroundByApp.has(appSessionId) || this.shellBackgroundByApp.has(appSessionId);
  }

  /**
   * True while a background agent (a child session) still runs. The runtime
   * holds a run's writer for this; a shell job does not hold the parent run,
   * because the engine starts its report turn as a run of its own.
   */
  hasAgentBackgroundWork(appSessionId: string): boolean {
    return this.backgroundByApp.has(appSessionId);
  }

  /** The same work in the shape the running-sessions list consumes. */
  listBackgroundWork(): Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> {
    const sessionIds = new Set([...this.backgroundByApp.keys(), ...this.shellBackgroundByApp.keys()]);
    return [...sessionIds].map((sessionId) => ({
      sessionId,
      tasks: this.allBackgroundTasks(sessionId),
    }));
  }

  /**
   * Child sessions this app session still tracks as background agents.
   *
   * Consumer: the runtime's pending-interaction reconcile, which re-reads each
   * child's forms and permissions. A shell job is no session to ask, so its
   * id must not be queried as one.
   */
  backgroundChildSessionIds(appSessionId: string): string[] {
    return [...(this.backgroundByApp.get(appSessionId)?.keys() ?? [])];
  }

  /**
   * How the engine ends one tracked handle, or null when this session does not
   * track it:
   * - `agent`: `POST /api/session/:id/interrupt` on the child session id;
   * - `shell`: `DELETE /api/shell/:id`, scoped to the checkout it was launched
   *   from.
   *
   * Consumer: the runtime's `stopBackgroundTask` (the strip's ✕).
   */
  backgroundStopRoute(
    appSessionId: string,
    taskId: string,
  ): { kind: 'agent' | 'shell'; directory?: string } | null {
    if (this.backgroundAppByTask.get(taskId) !== appSessionId) {
      return null;
    }
    if (this.backgroundByApp.get(appSessionId)?.has(taskId)) {
      return { kind: 'agent' };
    }
    if (this.shellBackgroundByApp.get(appSessionId)?.has(taskId)) {
      const directory = this.backgroundDirectoryByTask.get(taskId);
      return { kind: 'shell', ...(directory ? { directory } : {}) };
    }
    return null;
  }

  /**
   * Drops one tracked task on the caller's verdict — a stop the engine
   * confirmed, or a handle it no longer knows. The card reads the matching
   * `task_status` frame, so its spinner stops without waiting for a refresh.
   *
   * Consumer: the runtime's `stopBackgroundTask`.
   */
  settleBackgroundTask(appSessionId: string, taskId: string, status: BackgroundTaskStatus): void {
    if (this.backgroundAppByTask.get(taskId) !== appSessionId) {
      return;
    }
    this.finishBackgroundWork(taskId, status);
  }

  /** Every agent and shell task of one app session, oldest first. */
  private allBackgroundTasks(appSessionId: string): BackgroundTaskSummary[] {
    return [
      ...(this.backgroundByApp.get(appSessionId)?.values() ?? []),
      ...(this.shellBackgroundByApp.get(appSessionId)?.values() ?? []),
    ].sort((left, right) => left.startedAt - right.startedAt);
  }

  /**
   * Resolves once every child of this app session has settled, or once a
   * deadline gives up on one that cannot be judged (see `recheckBackgroundWork`).
   * Consumer: the runtime, which keeps the run's writer/bridge alive for that
   * long after the parent turn ends.
   */
  whenBackgroundWorkClears(
    appSessionId: string,
    timeoutMs: number = BACKGROUND_WORK_TIMEOUT_MS,
  ): Promise<void> {
    if (!this.backgroundByApp.has(appSessionId)) {
      return Promise.resolve();
    }
    this.armBackgroundDeadline(appSessionId, timeoutMs);
    return new Promise<void>((resolve) => {
      let waiters = this.backgroundClearWaiters.get(appSessionId);
      if (!waiters) {
        waiters = new Set();
        this.backgroundClearWaiters.set(appSessionId, waiters);
      }
      waiters.add(resolve);
    });
  }

  /**
   * Arms an app session's deadline timer, if none is pending.
   *
   * One deadline per session is enough: every waiter shares the verdict of the
   * next one, and a child settling naturally resolves them all.
   */
  private armBackgroundDeadline(appSessionId: string, intervalMs: number): void {
    if (this.backgroundDeadlineTimers.has(appSessionId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.backgroundDeadlineTimers.delete(appSessionId);
      this.recheckBackgroundWork(appSessionId, intervalMs);
    }, intervalMs);
    // Not unref'd: the caller is awaiting this deadline to settle or drop the
    // work, so the timer is what keeps that wait alive. The server's other
    // handles keep the process up in production either way.
    this.backgroundDeadlineTimers.set(appSessionId, timer);
  }

  private clearBackgroundDeadline(appSessionId: string): void {
    const timer = this.backgroundDeadlineTimers.get(appSessionId);
    if (timer) {
      clearTimeout(timer);
      this.backgroundDeadlineTimers.delete(appSessionId);
    }
  }

  /**
   * Judges one app session's background work at a deadline instead of dropping
   * it blindly.
   *
   * A child that has gone idle since it was launched has settled — its card
   * gets the outcome the engine reports, and tracking ends. A child still
   * mid-turn is left alone and re-judged at the next deadline, so work that
   * legitimately outlives the window (an hour-long batch monitor, say) keeps
   * its composer entry, its card's live frames and its question cards. A
   * backgrounded shell is judged the same way through its own service record.
   * The hold cap is the last backstop for a record that reads live forever —
   * the engine lost the process, or died under it — and covers both kinds, so
   * a phantom can never pin the strip for good.
   */
  private recheckBackgroundWork(appSessionId: string, intervalMs: number): void {
    const tasks = this.allBackgroundTasks(appSessionId);
    if (tasks.length === 0) {
      // Settled naturally while the timer was pending; waiters are resolved.
      return;
    }

    const oldestStartedAt = Math.min(...tasks.map((task) => task.startedAt));
    if (Date.now() - oldestStartedAt >= this.maxBackgroundHoldMs) {
      for (const task of tasks) {
        this.finishBackgroundWork(task.taskId);
      }
      return;
    }

    void this.judgeBackgroundWork(appSessionId, intervalMs);
  }

  /**
   * Judges every tracked kind in one pass: a child by its session row, a shell
   * job by the service's shell record. Whatever is still alive is re-judged at
   * the next deadline.
   */
  private async judgeBackgroundWork(appSessionId: string, intervalMs: number): Promise<void> {
    await Promise.all([
      this.recheckChildren(appSessionId),
      this.recheckShells(appSessionId),
    ]);
    if (this.isBackgroundWorkPending(appSessionId)) {
      this.armBackgroundDeadline(appSessionId, intervalMs);
    }
  }

  private async recheckChildren(appSessionId: string): Promise<void> {
    const tasks = this.backgroundByApp.get(appSessionId);
    if (!tasks) {
      return;
    }

    for (const [childSessionId, task] of [...tasks]) {
      let snapshot: OpenCodeSessionSnapshot;
      try {
        snapshot = await this.readChildSnapshot(childSessionId);
      } catch {
        // Nothing can be said about this child anymore; drop just it, so a
        // verdict for its siblings is not thrown away with it.
        this.finishBackgroundWork(childSessionId);
        continue;
      }
      if (snapshot.idleAt !== null && snapshot.idleAt >= task.startedAt) {
        this.finishBackgroundWork(childSessionId, settledStatusFromSnapshot(snapshot));
      }
      // Otherwise it is mid-turn: still running, re-judged next deadline.
    }
  }

  /**
   * Re-judges backgrounded shell jobs by the service's own record. A handle the
   * service no longer holds (404) is over — that is the stale entry a lost
   * completion notice leaves behind — and a job it reports finished is settled
   * with that verdict. One it still reports running keeps its place; the hold
   * cap above bounds a record the engine itself never updates. A read that
   * merely failed says nothing either way, so the job is kept for the next
   * deadline rather than dropped on a transient error.
   */
  private async recheckShells(appSessionId: string): Promise<void> {
    const tasks = this.shellBackgroundByApp.get(appSessionId);
    if (!tasks) {
      return;
    }

    for (const shellId of [...tasks.keys()]) {
      let snapshot: OpenCodeShellSnapshot;
      try {
        snapshot = await this.readShellSnapshot(shellId, this.backgroundDirectoryByTask.get(shellId));
      } catch (error) {
        if (error instanceof OpenCodeApiError && error.status === 404) {
          this.finishBackgroundWork(shellId, 'stopped');
        }
        continue;
      }
      if (snapshot.status === 'running') {
        continue;
      }
      this.finishBackgroundWork(shellId, shellStatusToOutcome(snapshot));
    }
  }

  /**
   * Routes one service event to the run that owns its session: frames to the
   * writer, step occupancy to the budget tracker when one is registered, and
   * terminals to settle.
   *
   * A `session.compaction.failed` is the run's own failure only when the run
   * asked for it: an explicit `/compact` has nothing else to report it
   * through, while a normal turn that auto-compacted carries on — the engine
   * reports that turn's outcome separately, and a compaction it decided to run
   * must not fail the user's turn.
   */
  dispatch(event: OpenCodeEventEnvelope): void {
    this.subagents.note(event);
    const data = readObjectRecord(event.data) ?? {};
    const providerSessionId = readOptionalString(data.sessionID);
    if (!providerSessionId) {
      return;
    }

    // A backgrounded shell ends outside any run of ours, so its notice must be
    // read before the run lookup: the parent turn has long completed and its
    // writer is held by the background-work maps.
    const notice = readInboxBackgroundNotice(event);
    if (notice) {
      this.finishBackgroundWork(notice.taskId, notice.outcome);
    }

    const isChildTerminal = event.type === 'session.execution.succeeded'
      || event.type === 'session.execution.failed'
      || event.type === 'session.execution.interrupted';
    if (isChildTerminal) {
      // No-ops for the parent; this is the child's own terminal, which must
      // clear its background entry even when the parent run is already gone.
      // The terminal is also what settles the child's card without waiting for
      // a history refresh.
      this.finishBackgroundWork(providerSessionId, terminalStatusForEvent(event.type));
    }

    // A child session's events belong to the run that spawned it, not to a
    // run of their own: their frames are stamped with the spawn call id so
    // the transcript folds them into the subagent container. Step occupancy
    // and terminals stay with the child — the parent turn is settled by its
    // own execution events.
    const parent = this.subagents.resolve(providerSessionId);
    if (parent) {
      const run = this.byProvider.get(parent.parentProviderSessionId);
      if (!run) {
        this.deferredChildEvents.delete(providerSessionId);
        return;
      }
      if (!parent.parentToolCallId) {
        // The link exists but its launch call is still being resolved; hold
        // the frames rather than leaking them to the top level untagged.
        const queue = this.deferredChildEvents.get(providerSessionId) ?? [];
        queue.push(event);
        this.deferredChildEvents.set(providerSessionId, queue);
        return;
      }
      const deferred = this.deferredChildEvents.get(providerSessionId);
      if (deferred) {
        this.deferredChildEvents.delete(providerSessionId);
        for (const queued of deferred) {
          const queuedTerminal = queued.type === 'session.execution.succeeded'
            || queued.type === 'session.execution.failed'
            || queued.type === 'session.execution.interrupted';
          if (!queuedTerminal) {
            this.startBackgroundWork(run, providerSessionId, readObjectRecord(queued.data) ?? {});
          }
          this.deliverChildEvent(queued, run, parent.parentToolCallId);
        }
      }
      if (!isChildTerminal) {
        // The first delivered event of a child is its `session.created` (or
        // the queued head once the launch call resolved): that is the
        // title/agent the composer names the background work with.
        this.startBackgroundWork(run, providerSessionId, data);
      }
      this.deliverChildEvent(event, run, parent.parentToolCallId);
      return;
    }

    const run = this.byProvider.get(providerSessionId);
    if (!run) {
      return;
    }
    this.deliverEvent(event, run);
  }

  /** Forwards a child session's translated frames under its spawn call id. */
  private deliverChildEvent(
    event: OpenCodeEventEnvelope,
    run: OpenCodeActiveRun,
    parentToolUseId: string,
  ): void {
    const { frames } = run.translator.translate(event);
    for (const frame of frames) {
      run.writer.send({ ...frame, parentToolUseId });
    }
  }

  /**
   * Records a child session as background work of its parent's app session.
   *
   * A subagent outlives the parent turn: the composer must keep showing the
   * purple background pill after `complete`, and `chat.subscribe`/the
   * running-sessions poll read the same list. One entry per child.
   */
  private startBackgroundWork(
    run: OpenCodeActiveRun,
    childSessionId: string,
    data: Record<string, unknown>,
  ): void {
    if (this.backgroundAppByTask.has(childSessionId)) {
      return;
    }
    let tasks = this.backgroundByApp.get(run.appSessionId);
    if (!tasks) {
      tasks = new Map();
      this.backgroundByApp.set(run.appSessionId, tasks);
    }
    tasks.set(childSessionId, {
      taskId: childSessionId,
      toolUseId: this.subagents.resolve(childSessionId)?.parentToolCallId ?? '',
      taskType: 'local_agent',
      description: readOptionalString(data.title) ?? readOptionalString(data.agent) ?? childSessionId,
      startedAt: Date.now(),
    });
    this.backgroundAppByTask.set(childSessionId, run.appSessionId);
    this.backgroundWriterByApp.set(run.appSessionId, run.writer);
    this.broadcastBackgroundWork(run.appSessionId);
  }

  /**
   * Records a shell job the engine moved to the background.
   *
   * The job has no child session: the engine's synthetic notice is the live
   * word that it ended, and `GET /api/shell/:id` is the record a missed notice
   * can be judged against. The parent run is deliberately not held for it —
   * the report the engine starts when the job ends is adopted as a new run.
   */
  private startShellBackgroundWork(run: OpenCodeActiveRun, launch: OpenCodeBackgroundLaunch): void {
    if (this.backgroundAppByTask.has(launch.taskId)) {
      return;
    }
    let tasks = this.shellBackgroundByApp.get(run.appSessionId);
    if (!tasks) {
      tasks = new Map();
      this.shellBackgroundByApp.set(run.appSessionId, tasks);
    }
    tasks.set(launch.taskId, {
      taskId: launch.taskId,
      toolUseId: launch.callId,
      taskType: launch.taskType,
      description: launch.description,
      startedAt: Date.now(),
    });
    this.backgroundAppByTask.set(launch.taskId, run.appSessionId);
    if (run.directory) {
      this.backgroundDirectoryByTask.set(launch.taskId, run.directory);
    }
    this.backgroundWriterByApp.set(run.appSessionId, run.writer);
    this.broadcastBackgroundWork(run.appSessionId);
    // A shell job does not hold the run, so nothing else would arm its deadline.
    this.armBackgroundDeadline(run.appSessionId, this.backgroundWorkTimeoutMs);
  }

  /**
   * Drops one background task from its parent's list and tells the composer.
   *
   * `outcome` is set when the registry knows how the work ended (a child's own
   * terminal, a deadline verdict, or the engine's synthetic notice for a shell
   * job): the card reads its live word off `task_status`, so sending it here
   * stops the card's spinner without waiting for the next history refresh. A
   * task dropped because nothing could judge it gets no frame — its card keeps
   * whatever the transcript says.
   */
  private finishBackgroundWork(taskId: string, outcome?: BackgroundTaskStatus): void {
    const appSessionId = this.backgroundAppByTask.get(taskId);
    if (!appSessionId) {
      return;
    }
    this.backgroundAppByTask.delete(taskId);
    this.backgroundDirectoryByTask.delete(taskId);
    const agentTasks = this.backgroundByApp.get(appSessionId);
    const shellTasks = this.shellBackgroundByApp.get(appSessionId);
    const task = agentTasks?.get(taskId) ?? shellTasks?.get(taskId);
    agentTasks?.delete(taskId);
    shellTasks?.delete(taskId);
    const writer = this.backgroundWriterByApp.get(appSessionId);

    if (outcome && task && task.toolUseId) {
      this.sendBackgroundFrame(appSessionId, createNormalizedMessage({
        id: generateMessageId(PROVIDER),
        sessionId: appSessionId,
        provider: PROVIDER,
        kind: 'task_status',
        event: 'updated',
        status: outcome,
        taskId: task.taskId,
        toolUseId: task.toolUseId,
        taskType: task.taskType,
        description: task.description,
      }), writer);
    }
    if (!agentTasks || agentTasks.size === 0) {
      this.backgroundByApp.delete(appSessionId);
      // Only the agent side has waiters: a shell job never holds the run.
      this.resolveBackgroundWaiters(appSessionId);
    }
    if (!shellTasks || shellTasks.size === 0) {
      this.shellBackgroundByApp.delete(appSessionId);
    }
    if (!this.isBackgroundWorkPending(appSessionId)) {
      this.clearBackgroundDeadline(appSessionId);
      this.backgroundWriterByApp.delete(appSessionId);
    }
    this.sendBackgroundFrame(appSessionId, {
      ...createBackgroundTasksStatusMessage(
        { provider: PROVIDER, sessionId: appSessionId },
        this.backgroundTasksFor(appSessionId),
        this.hasAgentBackgroundWork(appSessionId),
        false,
      ),
      backgroundWorkPending: this.isBackgroundWorkPending(appSessionId),
    }, writer);
  }

  /** Publishes the current background list so the composer strip appears/clears live. */
  private broadcastBackgroundWork(appSessionId: string): void {
    this.sendBackgroundFrame(appSessionId, {
      ...createBackgroundTasksStatusMessage(
        { provider: PROVIDER, sessionId: appSessionId },
        this.backgroundTasksFor(appSessionId),
        this.hasAgentBackgroundWork(appSessionId),
        false,
      ),
      backgroundWorkPending: this.isBackgroundWorkPending(appSessionId),
    });
  }

  /**
   * Sends one background-work frame down the session channel when the runtime
   * supplied it, else through the run writer that launched the work. The
   * channel is what makes a completion reach a tab opened after the run ended.
   */
  private sendBackgroundFrame(
    appSessionId: string,
    message: NormalizedMessage,
    fallbackWriter: ProviderRuntimeWriter | undefined = this.backgroundWriterByApp.get(appSessionId),
  ): void {
    const publish = this.sessionPublisherByApp.get(appSessionId);
    if (publish) {
      publish(message);
      return;
    }
    fallbackWriter?.send(message);
  }

  private clearBackgroundWorkForSession(appSessionId: string): void {
    for (const [taskId, parentAppSessionId] of this.backgroundAppByTask) {
      if (parentAppSessionId === appSessionId) {
        this.backgroundAppByTask.delete(taskId);
        this.backgroundDirectoryByTask.delete(taskId);
      }
    }
    this.backgroundByApp.delete(appSessionId);
    this.shellBackgroundByApp.delete(appSessionId);
    // Announced before the writer is let go: the composer strip only clears
    // on a `background_tasks` frame, so dropping the list silently left it on
    // screen until a reload re-read the empty list from the subscribe ack.
    this.broadcastBackgroundWork(appSessionId);
    this.backgroundWriterByApp.delete(appSessionId);
    this.sessionPublisherByApp.delete(appSessionId);
    this.clearBackgroundDeadline(appSessionId);
    this.resolveBackgroundWaiters(appSessionId);
  }

  private clearBackgroundWork(): void {
    const sessionIds = new Set([...this.backgroundByApp.keys(), ...this.shellBackgroundByApp.keys()]);
    for (const appSessionId of sessionIds) {
      this.clearBackgroundWorkForSession(appSessionId);
    }
    this.backgroundAppByTask.clear();
    this.backgroundDirectoryByTask.clear();
    this.backgroundWriterByApp.clear();
    this.sessionPublisherByApp.clear();
  }

  private resolveBackgroundWaiters(appSessionId: string): void {
    const waiters = this.backgroundClearWaiters.get(appSessionId);
    if (!waiters) {
      return;
    }
    this.backgroundClearWaiters.delete(appSessionId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /** Forwards a run's own event: frames, occupancy, and terminals. */
  private deliverEvent(
    event: OpenCodeEventEnvelope,
    run: OpenCodeActiveRun,
  ): void {
    const { frames, terminal, stepTokens, compactionError, launch } = run.translator.translate(event);
    for (const frame of frames) {
      run.writer.send(frame);
    }
    if (launch?.taskType === LOCAL_BASH_TASK_TYPE) {
      this.startShellBackgroundWork(run, launch);
    }
    if (stepTokens && run.budgetTracker) {
      run.budgetTracker.report(stepTokens, run.writer, run.appSessionId);
    }
    if (compactionError && run.purpose === 'compact') {
      run.settle({ outcome: 'failed', error: compactionError });
      return;
    }
    if (terminal) {
      run.settle(terminal);
    }
  }

  /**
   * After a stream drop the terminal event may have been missed. A session
   * that went idle after the prompt was posted has finished; a 404 means it
   * is gone for good; any other failure leaves the run open for the next
   * reconnect.
   */
  async reconcile(client: Pick<OpenCodeApiClient, 'getSession'>): Promise<void> {
    for (const run of this.all()) {
      if (!run.promptAccepted) {
        continue;
      }
      try {
        const snapshot = await client.getSession(run.providerSessionId);
        if (snapshot.idleAt !== null && snapshot.idleAt >= run.startedAt) {
          run.settle(settlementFromSnapshot(snapshot));
        }
      } catch (error) {
        if (error instanceof OpenCodeApiError && error.status === 404) {
          run.settle({ outcome: 'lost', error: 'The OpenCode session no longer exists.' });
        }
      }
    }

    // A background child's own terminal can fall in the same gap, and nothing
    // else would retire its strip entry and card before the next deadline,
    // up to half an hour later. Same judgement as the deadline recheck.
    for (const [taskId, appSessionId] of [...this.backgroundAppByTask]) {
      const task = this.backgroundByApp.get(appSessionId)?.get(taskId);
      if (!task) {
        continue;
      }
      try {
        const snapshot = await client.getSession(taskId);
        if (snapshot.idleAt !== null && snapshot.idleAt >= task.startedAt) {
          this.finishBackgroundWork(taskId, settledStatusFromSnapshot(snapshot));
        }
      } catch {
        // A failed read proves nothing; the child's deadline still judges it.
      }
    }
  }
}

/**
 * Reads the engine's notice that background work ended. The notice is a
 * synthetic item in the session's inbox; every other inbox item carries
 * nothing the registry tracks. Read here rather than in the translator because
 * a shell job ends long after its launch run was released, when there is no
 * run left to translate the event.
 */
function readInboxBackgroundNotice(event: OpenCodeEventEnvelope): OpenCodeBackgroundNotice | null {
  if (event.type !== 'session.inbox.enqueued') {
    return null;
  }
  const item = readObjectRecord(readObjectRecord(event.data)?.item);
  if (readOptionalString(item?.type) !== 'synthetic') {
    return null;
  }
  return readBackgroundNotice(readObjectRecord(item?.payload)?.metadata);
}

function settlementFromSnapshot(snapshot: OpenCodeSessionSnapshot): OpenCodeRunSettlement {
  if (snapshot.outcome === 'interrupted') {
    return { outcome: 'interrupted', reason: 'reconciled after a stream drop' };
  }
  if (snapshot.outcome === 'failed') {
    return { outcome: 'failed', error: 'The run failed while the event stream was disconnected.' };
  }
  return { outcome: 'succeeded' };
}

/**
 * How a child ended, from its session row, for the card's settled status. A
 * row that went idle without recording an outcome reads as completed, the same
 * rule the history reader applies to the same column.
 */
function settledStatusFromSnapshot(snapshot: OpenCodeSessionSnapshot): BackgroundTaskStatus {
  if (snapshot.outcome === 'failed') {
    return 'failed';
  }
  if (snapshot.outcome === 'interrupted' || snapshot.outcome === 'stopped') {
    return 'stopped';
  }
  return 'completed';
}

/**
 * How a shell job ended, from its service record, for the card's settled
 * status. `killed` is a stop, `timeout` is a failure, and an exit code decides
 * the rest (a job that merely went away without one is a failure too).
 */
function shellStatusToOutcome(snapshot: OpenCodeShellSnapshot): BackgroundTaskStatus {
  if (snapshot.status === 'killed') {
    return 'stopped';
  }
  if (snapshot.status === 'timeout') {
    return 'failed';
  }
  if (snapshot.status === 'completed' || snapshot.exitCode === 0) {
    return 'completed';
  }
  return 'failed';
}

/** How a child ended, from its own terminal event, for the card's settled status. */
function terminalStatusForEvent(eventType: string): BackgroundTaskStatus {
  if (eventType === 'session.execution.failed') {
    return 'failed';
  }
  if (eventType === 'session.execution.interrupted') {
    return 'stopped';
  }
  return 'completed';
}
