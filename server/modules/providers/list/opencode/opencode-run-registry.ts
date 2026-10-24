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
 * @module opencode-run-registry
 */

import type {
  ActiveBackgroundTask,
  BackgroundTaskStatus,
  BackgroundTaskSummary,
  ProviderRuntimeWriter,
  ProviderTokenUsageResult,
} from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { OpenCodeApiError, type OpenCodeApiClient, type OpenCodeSessionSnapshot } from './opencode-api.client.js';
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
};

/**
 * How the registry judges one child at its deadline: the runtime wires the
 * service's `GET /api/session/:id` reader here, the same row the run
 * reconciliation reads for a lost parent terminal. Tests pass their own.
 */
export type OpenCodeRunRegistryOptions = {
  readChildSnapshot?: (childSessionId: string) => Promise<OpenCodeSessionSnapshot>;
  /** Total wall-clock a child may stay tracked before its deadline drops it. */
  maxBackgroundHoldMs?: number;
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
  private readonly backgroundWriterByApp = new Map<string, ProviderRuntimeWriter>();
  private readonly backgroundAppByChild = new Map<string, string>();
  /** Resolvers waiting for one app session's background work to clear. */
  private readonly backgroundClearWaiters = new Map<string, Set<() => void>>();
  /** The one pending deadline per app session whose background work is tracked. */
  private readonly backgroundDeadlineTimers = new Map<string, NodeJS.Timeout>();
  private readonly readChildSnapshot: (childSessionId: string) => Promise<OpenCodeSessionSnapshot>;
  private readonly maxBackgroundHoldMs: number;

  constructor(options: OpenCodeRunRegistryOptions = {}) {
    this.readChildSnapshot = options.readChildSnapshot ?? (async () => {
      // No reader wired: nothing can judge a child, so its deadline drops it —
      // the backstop's original behavior, kept for tests and host-less use.
      throw new Error('No child session reader is configured.');
    });
    this.maxBackgroundHoldMs = options.maxBackgroundHoldMs ?? BACKGROUND_WORK_MAX_HOLD_MS;
  }

  create(
    appSessionId: string,
    providerSessionId: string,
    writer: ProviderRuntimeWriter,
    purpose: OpenCodeActiveRun['purpose'] = 'chat',
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

  /** The active children of one app session, in the wire shape the composer ack uses. */
  backgroundTasksFor(appSessionId: string): ActiveBackgroundTask[] {
    return [...(this.backgroundByApp.get(appSessionId)?.values() ?? [])].map((task) => ({
      // The card's identity is the spawn call, not the child session: the
      // transcript anchors its card by the call and `chat.stop-task` is keyed
      // by the tool-use id the client compares against, so one handle on the
      // strip both reveals the card and stops exactly this task. The child
      // session id is only the engine's stop handle (`taskId`).
      id: task.toolUseId || task.taskId,
      taskId: task.taskId,
      toolName: 'subagent',
      description: task.description,
      startedAt: task.startedAt,
    }));
  }

  /** True while a child session of this app session still runs. */
  isBackgroundWorkPending(appSessionId: string): boolean {
    return this.backgroundByApp.has(appSessionId);
  }

  /** The same children in the shape the running-sessions list consumes. */
  listBackgroundWork(): Array<{ sessionId: string; tasks: BackgroundTaskSummary[] }> {
    return [...this.backgroundByApp].map(([sessionId, tasks]) => ({
      sessionId,
      tasks: [...tasks.values()],
    }));
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
    timer.unref?.();
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
   * its composer entry, its card's live frames and its question cards. A child
   * nothing can describe — the service is gone, or the row is unreadable — is
   * dropped: that is the backstop a plain timeout used to be, for the state no
   * verdict can be had about. The hold cap keeps a session row that reads
   * mid-turn forever — the engine died under it — from pinning the run.
   */
  private recheckBackgroundWork(appSessionId: string, intervalMs: number): void {
    const tasks = this.backgroundByApp.get(appSessionId);
    if (!tasks || tasks.size === 0) {
      // Settled naturally while the timer was pending; waiters are resolved.
      return;
    }

    const oldestStartedAt = Math.min(...[...tasks.values()].map((task) => task.startedAt));
    if (Date.now() - oldestStartedAt >= this.maxBackgroundHoldMs) {
      for (const childSessionId of [...tasks.keys()]) {
        this.finishBackgroundWork(childSessionId);
      }
      return;
    }

    void this.recheckChildren(appSessionId, intervalMs);
  }

  private async recheckChildren(appSessionId: string, intervalMs: number): Promise<void> {
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

    if (this.backgroundByApp.has(appSessionId)) {
      this.armBackgroundDeadline(appSessionId, intervalMs);
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
    if (this.backgroundAppByChild.has(childSessionId)) {
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
    this.backgroundAppByChild.set(childSessionId, run.appSessionId);
    this.backgroundWriterByApp.set(run.appSessionId, run.writer);
    this.broadcastBackgroundWork(run.appSessionId);
  }

  /**
   * Drops a child from its parent's background list and tells the composer.
   *
   * `outcome` is set when the registry knows how the child ended (its own
   * terminal, or a deadline verdict from its session row): the card reads its
   * live word off `task_status`, so sending it here stops the card's spinner
   * without waiting for the next history refresh. A child dropped because
   * nothing could judge it gets no frame — its card keeps whatever the
   * transcript says.
   */
  private finishBackgroundWork(childSessionId: string, outcome?: BackgroundTaskStatus): void {
    const appSessionId = this.backgroundAppByChild.get(childSessionId);
    if (!appSessionId) {
      return;
    }
    this.backgroundAppByChild.delete(childSessionId);
    const tasks = this.backgroundByApp.get(appSessionId);
    const task = tasks?.get(childSessionId);
    tasks?.delete(childSessionId);

    const writer = this.backgroundWriterByApp.get(appSessionId);
    if (outcome && task && task.toolUseId) {
      writer?.send(createNormalizedMessage({
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
      }));
    }
    if (!tasks || tasks.size === 0) {
      this.backgroundByApp.delete(appSessionId);
      this.backgroundWriterByApp.delete(appSessionId);
      this.clearBackgroundDeadline(appSessionId);
      this.resolveBackgroundWaiters(appSessionId);
    }
    writer?.send(createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      sessionId: appSessionId,
      provider: PROVIDER,
      kind: 'status',
      text: 'background_tasks',
      backgroundTasks: this.backgroundTasksFor(appSessionId),
      backgroundWorkPending: this.backgroundByApp.has(appSessionId),
    }));
  }

  /** Publishes the current child list so the composer pill appears/clears live. */
  private broadcastBackgroundWork(appSessionId: string): void {
    this.backgroundWriterByApp.get(appSessionId)?.send(createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      sessionId: appSessionId,
      provider: PROVIDER,
      kind: 'status',
      text: 'background_tasks',
      backgroundTasks: this.backgroundTasksFor(appSessionId),
      backgroundWorkPending: this.backgroundByApp.has(appSessionId),
    }));
  }

  private clearBackgroundWorkForSession(appSessionId: string): void {
    for (const [childSessionId, parentAppSessionId] of this.backgroundAppByChild) {
      if (parentAppSessionId === appSessionId) {
        this.backgroundAppByChild.delete(childSessionId);
      }
    }
    this.backgroundByApp.delete(appSessionId);
    // Announced before the writer is let go: the composer strip only clears
    // on a `background_tasks` frame, so dropping the list silently left it on
    // screen until a reload re-read the empty list from the subscribe ack.
    this.broadcastBackgroundWork(appSessionId);
    this.backgroundWriterByApp.delete(appSessionId);
    this.clearBackgroundDeadline(appSessionId);
    this.resolveBackgroundWaiters(appSessionId);
  }

  private clearBackgroundWork(): void {
    for (const appSessionId of [...this.backgroundByApp.keys()]) {
      this.clearBackgroundWorkForSession(appSessionId);
    }
    this.backgroundAppByChild.clear();
    this.backgroundWriterByApp.clear();
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
    const { frames, terminal, stepTokens, compactionError } = run.translator.translate(event);
    for (const frame of frames) {
      run.writer.send(frame);
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
    for (const [childSessionId, appSessionId] of [...this.backgroundAppByChild]) {
      const task = this.backgroundByApp.get(appSessionId)?.get(childSessionId);
      if (!task) {
        continue;
      }
      try {
        const snapshot = await client.getSession(childSessionId);
        if (snapshot.idleAt !== null && snapshot.idleAt >= task.startedAt) {
          this.finishBackgroundWork(childSessionId, settledStatusFromSnapshot(snapshot));
        }
      } catch {
        // A failed read proves nothing; the child's deadline still judges it.
      }
    }
  }
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
