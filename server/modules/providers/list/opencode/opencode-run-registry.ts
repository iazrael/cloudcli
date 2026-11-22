/**
 * OpenCode Run Registry
 *
 * Bookkeeping for the conversations the runtime routes service events for:
 * which app session maps to which provider session, the session's event
 * translator, first-settlement-wins outcome tracking for the run in flight,
 * event dispatch, and the reconciliation that rescues a run whose terminal
 * event was lost during a stream drop (the session row's `time.idle`/
 * `outcome`, verified live against v2.0.31, say whether it already finished).
 *
 * A conversation outlives its run while the engine still works in it: work
 * moved to the background keeps running, and once it ends the engine starts
 * a turn of its own to report on it. Until both are over the conversation's
 * frames go to its session channel instead of the finished run's writer (see
 * `opencode-background-work.ts`).
 *
 * @module opencode-run-registry
 */

import type { NormalizedMessage, ProviderRuntimeWriter } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import type { BackgroundWorkRegistry } from '../../shared/background-work/background-work-registry.js';
import { createBackgroundTasksStatusMessage, createTaskStatusMessage, LOCAL_AGENT_TASK_TYPE } from '../../shared/background-work/task-status.js';

import { OpenCodeApiError, type OpenCodeApiClient, type OpenCodeSessionSnapshot } from './opencode-api.client.js';
import {
  opencodeBackgroundWork,
  type OpenCodeBackgroundLaunch,
  type OpenCodeBackgroundNotice,
  type OpenCodeBackgroundOutcome,
} from './opencode-background-work.js';
import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';
import { OpenCodeSessionEventTranslator, type OpenCodeRunOutcome, type OpenCodeToolCall } from './opencode-event-translator.js';

const PROVIDER = 'opencode' as const;

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
  /** Epoch ms right before the prompt was posted; `time.idle` at or after it means the run finished. */
  startedAt: number;
  aborted: boolean;
  /** Set once the prompt was accepted; only then can reconciliation judge the run. */
  promptAccepted: boolean;
  /**
   * Set once the run's terminal event arrived. The engine can start its report
   * turn in the same tick, before the runtime releases the run, so from here on
   * a turn starting is the engine's own and frames go to the session channel.
   */
  terminalSeen: boolean;
  /** Resolves on the first settlement; later settlements are ignored. */
  settled: Promise<OpenCodeRunSettlement>;
  settle: (settlement: OpenCodeRunSettlement) => void;
};

/** Session token totals → the status-frame budget shape other providers emit. `contextWindow` is the model's declared window (null when unknown; the composer bar needs it). */
export function toOpenCodeTokenBudget(
  tokens: NonNullable<OpenCodeSessionSnapshot['tokens']>,
  contextWindow?: number | null,
): { used: number; inputTokens: number; outputTokens: number; total: number; breakdown: { input: number; output: number } } | null {
  const used = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;
  if (used <= 0) {
    return null;
  }
  const inputTokens = tokens.input + tokens.cacheRead;
  return {
    used,
    inputTokens,
    outputTokens: tokens.output,
    total: Math.max(0, Math.round(contextWindow ?? 0)),
    breakdown: { input: inputTokens, output: tokens.output },
  };
}

/**
 * A conversation the registry routes events for: while a run is in flight,
 * while work it moved to the background is still running, and while the
 * engine runs a turn of its own to report on that work.
 *
 * Consumer: opencode runtime (bridge attachment, abort, activity) via the
 * registry's hooks and lookups.
 */
export type OpenCodeConversation = {
  appSessionId: string;
  providerSessionId: string;
  /** Lives as long as the conversation: tool names are remembered across turns. */
  translator: OpenCodeSessionEventTranslator;
  /** The in-flight run's writer, else the session channel. */
  writer: ProviderRuntimeWriter;
  run: OpenCodeActiveRun | null;
  /** Delivers to the session outside any run; null when the runtime context offered no channel. */
  channel: ProviderRuntimeWriter | null;
  /** The engine runs a turn nobody here started (it reports on background work). */
  engineTurn: boolean;
  /** When that turn began (epoch ms), so the page times the report and not the run before it. */
  engineTurnStartedAt: number | null;
  /** Who the conversation belongs to and what it is called, for the notification when its work ends. */
  owner: { userId: string | null; sessionName?: string };
  /** Child sessions of background agents still running: their calls are not the run's to settle. */
  backgroundChildren: Set<string>;
  /**
   * Notices that named work not recorded yet, with when they arrived: a
   * command that ends at once can be reported before the call that launched
   * it returns. A launch within `EARLY_NOTICE_TTL_MS` settles against them; an
   * older one is a repeat of a notice whose work already ended.
   */
  earlyNotices: Map<string, { outcome: OpenCodeBackgroundOutcome; at: number }>;
};

/**
 * What the runtime does when a conversation changes hands.
 *
 * Consumer: opencode runtime (moves the interaction bridge along).
 */
export type OpenCodeConversationHooks = {
  /** The run ended but the engine still works in the conversation: its frames now go to `writer`. */
  detached?: (conversation: OpenCodeConversation) => void;
  /** Nothing is left running in the conversation; it is forgotten. */
  dropped?: (conversation: OpenCodeConversation) => void;
  /**
   * The engine's report turn ended with nothing left running: the work the
   * run started in the background is over now, not when the run ended.
   */
  workFinished?: (conversation: OpenCodeConversation) => void;
};

/**
 * A session the engine created for a subagent, owned by the conversation
 * that spawned it. Requests and events of such a session carry its own id, so
 * without this record they match no conversation and are dropped: an approval
 * card never appears and the subagent's steps never show.
 */
type OpenCodeChildSession = {
  conversation: OpenCodeConversation;
  /** The session that spawned this one (the root session, or another child). */
  parentSessionId: string;
  /**
   * The call in the parent session that spawned this one, as the latest
   * `session.tool.progress` named it (a resumed child is spawned again by a
   * later call, and the newest call owns the card). The card the user sees is
   * the one of the topmost child of the root session, so a grandchild finds
   * its card by walking up (`cardCallIdOf`). Unknown until the call reports it.
   */
  spawnCallId?: string;
  translator: OpenCodeSessionEventTranslator;
  /** Frames translated before the card was known, flushed once it is. */
  held: NormalizedMessage[];
  /** Set once the held-frame cap was hit, so the loss is logged once per child. */
  heldOverflowLogged?: boolean;
};

/** Most frames held for a child whose card is not known yet. */
const MAX_HELD_CHILD_FRAMES = 500;

/** Longest ancestor chain followed; a real tree is a few levels deep, a cycle is a bug. */
const MAX_CHILD_DEPTH = 16;

/** Frame kinds a child's stream never contributes: its finished rows carry the content. */
const CHILD_STREAMING_KINDS = new Set(['stream_delta', 'stream_end']);

/** Most unmatched notices remembered per conversation; a real one is matched within a tick. */
const MAX_EARLY_NOTICES = 50;

/** How long an unmatched notice can still be its launch's: the two arrive moments apart. */
const EARLY_NOTICE_TTL_MS = 5_000;

/**
 * How far before the host recorded a task a persisted notice may be stamped
 * and still be that task's: the engine stamps the launch a moment before the
 * host hears of it. A resumed agent's earlier run ended at least a turn before.
 */
const PERSISTED_NOTICE_CLOCK_SLACK_MS = 1_000;

/** The run of the conversation that still owns its turn: none once its terminal arrived. */
function liveRun(conversation: OpenCodeConversation): OpenCodeActiveRun | null {
  return conversation.run && !conversation.run.terminalSeen ? conversation.run : null;
}

/**
 * Tracks the conversations of one runtime instance.
 *
 * Consumer: opencode runtime.
 */
export class OpenCodeRunRegistry {
  private readonly byApp = new Map<string, OpenCodeConversation>();
  private readonly byProvider = new Map<string, OpenCodeConversation>();
  private readonly children = new Map<string, OpenCodeChildSession>();
  private readonly backgroundWork: BackgroundWorkRegistry;
  private readonly hooks: OpenCodeConversationHooks;
  private readonly now: () => number;

  constructor(dependencies: {
    backgroundWork?: BackgroundWorkRegistry;
    hooks?: OpenCodeConversationHooks;
    now?: () => number;
  } = {}) {
    this.backgroundWork = dependencies.backgroundWork ?? opencodeBackgroundWork;
    this.hooks = dependencies.hooks ?? {};
    this.now = dependencies.now ?? Date.now;
  }

  /**
   * Starts a run in the conversation, taking it over when the engine is
   * already working in it: a message sent during a report turn is steered
   * into that turn, whose terminal then ends this run.
   */
  create(
    appSessionId: string,
    providerSessionId: string,
    writer: ProviderRuntimeWriter,
    channel: ProviderRuntimeWriter | null = null,
    owner: OpenCodeConversation['owner'] = { userId: null },
  ): OpenCodeActiveRun {
    let settle!: (settlement: OpenCodeRunSettlement) => void;
    const settled = new Promise<OpenCodeRunSettlement>((resolve) => {
      settle = resolve;
    });
    let conversation = this.byProvider.get(providerSessionId);
    if (!conversation) {
      conversation = {
        appSessionId,
        providerSessionId,
        translator: new OpenCodeSessionEventTranslator(appSessionId),
        writer,
        run: null,
        channel,
        engineTurn: false,
        engineTurnStartedAt: null,
        owner,
        backgroundChildren: new Set(),
        earlyNotices: new Map(),
      };
      this.byProvider.set(providerSessionId, conversation);
    }
    this.byApp.set(appSessionId, conversation);
    const run: OpenCodeActiveRun = {
      appSessionId,
      providerSessionId,
      writer,
      translator: conversation.translator,
      startedAt: Date.now(),
      aborted: false,
      promptAccepted: false,
      terminalSeen: false,
      settled,
      settle,
    };
    conversation.run = run;
    conversation.writer = writer;
    conversation.channel = channel ?? conversation.channel;
    conversation.owner = owner;
    conversation.engineTurn = false;
    return run;
  }

  /** The run in flight, looked up by either the app session id or the provider session id. */
  get(sessionId: string): OpenCodeActiveRun | null {
    return this.conversation(sessionId)?.run ?? null;
  }

  /** The conversation, looked up by either the app session id or the provider session id. */
  conversation(sessionId: string): OpenCodeConversation | null {
    return this.byApp.get(sessionId) ?? this.byProvider.get(sessionId) ?? null;
  }

  all(): OpenCodeActiveRun[] {
    return [...this.byProvider.values()].flatMap((conversation) => (conversation.run ? [conversation.run] : []));
  }

  /** The engine's report turn is in flight and no run of ours owns it. */
  isReporting(sessionId: string): boolean {
    const conversation = this.conversation(sessionId);
    return Boolean(conversation && !liveRun(conversation) && conversation.engineTurn);
  }

  /** Conversations in a report turn with no background task left to list them, dated by the turn's start. */
  listReportingOnly(): Array<{ sessionId: string; startedAt?: number }> {
    return [...this.byProvider.values()]
      .filter((conversation) => !liveRun(conversation) && conversation.engineTurn
        && !this.backgroundWork.hasSession(conversation.appSessionId))
      .map((conversation) => ({
        sessionId: conversation.appSessionId,
        ...(conversation.engineTurnStartedAt === null ? {} : { startedAt: conversation.engineTurnStartedAt }),
      }));
  }

  /**
   * Whether `abort` still has something to stop: the run, the report turn, or
   * a background agent. A backgrounded command alone cannot be stopped: no
   * request ends one shell job.
   */
  canInterrupt(sessionId: string): boolean {
    const conversation = this.conversation(sessionId);
    if (!conversation) {
      return false;
    }
    return Boolean(liveRun(conversation)) || conversation.engineTurn
      || this.backgroundWork.list().some((entry) => entry.sessionId === conversation.appSessionId
        && entry.tasks.some((task) => task.taskType === LOCAL_AGENT_TASK_TYPE));
  }

  /**
   * The root session's provider id and the child's tool-call lookup, for a
   * session the engine created for a subagent. Used by the interaction bridge
   * to show a child's approval and question cards under the root session.
   */
  childOwner(sessionId: string): {
    rootProviderSessionId: string;
    resolveToolCall: (callId: string) => OpenCodeToolCall | null;
    /** The `Agent` card the child's requests belong to, when its spawn call is known. */
    resolveOrigin: () => { toolUseId: string; description?: string } | null;
  } | null {
    const child = this.children.get(sessionId);
    if (!child) {
      return null;
    }
    return {
      rootProviderSessionId: child.conversation.providerSessionId,
      resolveToolCall: (callId) => child.translator.getToolCall(callId),
      resolveOrigin: () => {
        const toolUseId = this.cardCallIdOf(child);
        if (!toolUseId) {
          return null;
        }
        const description = readOptionalString(readObjectRecord(child.conversation.translator.getToolCall(toolUseId)?.input)?.description);
        return { toolUseId, ...(description ? { description } : {}) };
      },
    };
  }

  /** The child sessions of the conversation's background agents, whose cards must outlive the run. */
  backgroundChildSessions(conversation: OpenCodeConversation): Set<string> {
    const sessions = new Set<string>();
    for (const childId of this.children.keys()) {
      if (this.children.get(childId)?.conversation === conversation && this.isBackgroundOwned(childId)) {
        sessions.add(childId);
      }
    }
    return sessions;
  }

  /**
   * Settles the cards of calls a run's children never resolved. Called when
   * the run ends, alongside the root translator's own settle. A background
   * agent's session is still working, so its calls are left alone.
   */
  settleChildren(run: OpenCodeActiveRun): NormalizedMessage[] {
    const frames: NormalizedMessage[] = [];
    for (const [childId, child] of this.children) {
      if (child.conversation.run === run && !this.isBackgroundOwned(childId)) {
        frames.push(...child.translator.settleOpenSubagents());
      }
    }
    return frames;
  }

  /**
   * Ends the run. The conversation lives on while the engine still works in
   * it (background work, a report turn) and its frames go to the session
   * channel from here on; otherwise it is forgotten with its children.
   */
  release(run: OpenCodeActiveRun): void {
    const conversation = this.byProvider.get(run.providerSessionId);
    if (!conversation || conversation.run !== run) {
      return;
    }
    conversation.run = null;
    if (this.isBusy(conversation)) {
      // Without a channel the frames have nowhere live to go, but the work is
      // still tracked: the running-sessions poll and a reload still show it.
      conversation.writer = conversation.channel ?? run.writer;
      this.hooks.detached?.(conversation);
      return;
    }
    this.drop(conversation);
  }

  /**
   * Settles every run, and every background task as stopped: the service
   * that ran them is gone.
   */
  settleAll(settlement: OpenCodeRunSettlement): void {
    for (const conversation of [...this.byProvider.values()]) {
      for (const task of this.backgroundWork.clearSession(conversation.appSessionId)) {
        conversation.writer.send(this.taskStatusFrame(conversation, task.taskId, task.toolUseId, task.taskType, 'stopped'));
      }
      this.sendStrip(conversation);
      // No agent survives the service, so none of their cards may be kept.
      conversation.backgroundChildren.clear();
      conversation.engineTurn = false;
      if (conversation.run) {
        conversation.run.settle(settlement);
      } else {
        this.drop(conversation);
      }
    }
  }

  /** Routes one service event to the conversation that owns its session. */
  dispatch(event: OpenCodeEventEnvelope): void {
    const data = readObjectRecord(event.data);
    const providerSessionId = readOptionalString(data?.sessionID);
    this.learnOwnership(event, providerSessionId, data);
    const conversation = providerSessionId ? this.byProvider.get(providerSessionId) : null;
    if (!conversation) {
      const child = providerSessionId ? this.children.get(providerSessionId) : undefined;
      if (child) {
        this.dispatchChild(child, event);
      }
      return;
    }
    const translated = conversation.translator.translate(event);
    for (const frame of translated.frames) {
      conversation.writer.send(frame);
    }
    if (translated.launch) {
      this.recordLaunch(conversation, translated.launch, false);
    }
    if (translated.notice) {
      this.recordNotice(conversation, translated.notice);
    }
    const run = liveRun(conversation);
    if (run) {
      if (translated.terminal) {
        run.terminalSeen = true;
        run.settle(translated.terminal);
        // What follows the terminal belongs to the session, not to the run.
        conversation.writer = conversation.channel ?? conversation.writer;
      }
      return;
    }
    // No live run of ours: a turn here is the engine's own report.
    if (translated.executionStarted) {
      conversation.engineTurn = true;
      conversation.engineTurnStartedAt = Date.now();
    } else if (translated.terminal && conversation.engineTurn) {
      conversation.engineTurn = false;
      conversation.engineTurnStartedAt = null;
      if (!this.isBusy(conversation)) {
        this.hooks.workFinished?.(conversation);
        this.drop(conversation);
      }
    } else if (translated.terminal) {
      this.dropIfIdle(conversation);
    }
  }

  /**
   * Settles background work whose notice was missed while the event stream
   * was down, from the notices the engine persisted. Only a notice written
   * after the work was recorded counts: a resumed agent keeps its child
   * session id, and the notice of its earlier run must not end the new one.
   * The conversation is not dropped here: the engine may be in the report
   * turn that followed, which `reconcile` asks the service about.
   */
  reconcileBackground(readNotices: (providerSessionId: string) => OpenCodeBackgroundNotice[]): void {
    for (const conversation of [...this.byProvider.values()]) {
      if (!this.backgroundWork.hasSession(conversation.appSessionId)) {
        continue;
      }
      const sessions = [conversation.providerSessionId, ...this.backgroundChildSessions(conversation)];
      for (const providerSessionId of sessions) {
        for (const notice of readNotices(providerSessionId)) {
          const task = this.backgroundWork.get(conversation.appSessionId, notice.taskId);
          if (task && notice.at !== undefined && notice.at >= task.startedAt - PERSISTED_NOTICE_CLOCK_SLACK_MS) {
            this.recordNotice(conversation, notice);
          }
        }
      }
    }
  }

  private isBusy(conversation: OpenCodeConversation): boolean {
    return Boolean(conversation.run) || conversation.engineTurn
      || this.backgroundWork.hasSession(conversation.appSessionId);
  }

  private dropIfIdle(conversation: OpenCodeConversation): void {
    if (!this.isBusy(conversation)) {
      this.drop(conversation);
    }
  }

  /**
   * Forgets the conversation and tells the runtime, once: a reconcile that
   * awaited the service may come back holding a record already replaced by a
   * new run of the same conversation, whose cards must stay.
   */
  private drop(conversation: OpenCodeConversation): void {
    if (this.byProvider.get(conversation.providerSessionId) !== conversation) {
      return;
    }
    for (const [sessionId, child] of this.children) {
      if (child.conversation === conversation) {
        this.children.delete(sessionId);
      }
    }
    if (this.byApp.get(conversation.appSessionId) === conversation) {
      this.byApp.delete(conversation.appSessionId);
    }
    if (this.byProvider.get(conversation.providerSessionId) === conversation) {
      this.byProvider.delete(conversation.providerSessionId);
    }
    this.hooks.dropped?.(conversation);
  }

  private recordLaunch(conversation: OpenCodeConversation, launch: OpenCodeBackgroundLaunch, nested: boolean): void {
    const early = conversation.earlyNotices.get(launch.taskId);
    conversation.earlyNotices.delete(launch.taskId);
    if (early && this.now() - early.at <= EARLY_NOTICE_TTL_MS) {
      // It ended before its launch was acknowledged: settle the card now.
      const frame = this.taskStatusFrame(conversation, launch.taskId, launch.callId, launch.taskType, early.outcome);
      const child = nested ? this.childOwningCall(conversation, launch.callId) : undefined;
      const cardCallId = child ? this.cardCallIdOf(child) : undefined;
      conversation.writer.send(cardCallId ? this.tieToCard(frame, cardCallId) : frame);
      return;
    }
    if (launch.taskType === LOCAL_AGENT_TASK_TYPE) {
      conversation.backgroundChildren.add(launch.taskId);
    }
    this.backgroundWork.start(conversation.appSessionId, {
      taskId: launch.taskId,
      toolUseId: launch.callId,
      taskType: launch.taskType,
      description: launch.description,
      ...(nested ? { nested: true } : {}),
    });
    this.sendStrip(conversation);
  }

  /**
   * Settles the card of the work a notice names. The report turn the engine
   * starts next keeps the conversation alive, so it is not dropped here.
   */
  private recordNotice(conversation: OpenCodeConversation, notice: OpenCodeBackgroundNotice): void {
    conversation.backgroundChildren.delete(notice.taskId);
    const task = this.backgroundWork.end(conversation.appSessionId, notice.taskId);
    if (!task) {
      const now = this.now();
      for (const [taskId, early] of conversation.earlyNotices) {
        if (now - early.at > EARLY_NOTICE_TTL_MS) {
          conversation.earlyNotices.delete(taskId);
        }
      }
      if (conversation.earlyNotices.size < MAX_EARLY_NOTICES) {
        conversation.earlyNotices.set(notice.taskId, { outcome: notice.outcome, at: now });
      } else {
        console.warn(`[OpenCode] ignoring a background notice for unknown work ${notice.taskId}: ${MAX_EARLY_NOTICES} unmatched notices are held`);
      }
      return;
    }
    const frame = this.taskStatusFrame(conversation, task.taskId, task.toolUseId, task.taskType, notice.outcome);
    // A nested task's card sits in its agent's timeline, under the outer card.
    const child = task.nested ? this.childOwningCall(conversation, task.toolUseId) : undefined;
    const cardCallId = child ? this.cardCallIdOf(child) : undefined;
    conversation.writer.send(cardCallId ? this.tieToCard(frame, cardCallId) : frame);
    this.sendStrip(conversation);
  }

  private childOwningCall(conversation: OpenCodeConversation, callId: string): OpenCodeChildSession | undefined {
    for (const child of this.children.values()) {
      if (child.conversation === conversation && child.translator.getToolCall(callId)) {
        return child;
      }
    }
    return undefined;
  }

  private taskStatusFrame(
    conversation: OpenCodeConversation,
    taskId: string,
    toolUseId: string,
    taskType: string,
    status: OpenCodeBackgroundOutcome,
  ): NormalizedMessage {
    return createTaskStatusMessage(
      { provider: PROVIDER, sessionId: conversation.appSessionId, taskId, toolUseId, taskType },
      { id: `${toolUseId}_status`, timestamp: new Date().toISOString(), event: 'notification', status },
    );
  }

  /** Announces the strip's full list; an emptied one too, since nothing else clears it. */
  private sendStrip(conversation: OpenCodeConversation): void {
    conversation.writer.send(createBackgroundTasksStatusMessage(
      { provider: PROVIDER, sessionId: conversation.appSessionId },
      this.listStripTasks(conversation.appSessionId),
      this.canInterrupt(conversation.appSessionId),
      // The engine files a new message into its inbox; the work goes on.
      false,
    ));
  }

  /** The strip's list: an agent offers its own stop (its child session can be interrupted); a command does not. */
  listStripTasks(appSessionId: string) {
    return this.backgroundWork.listStripTasks(
      appSessionId,
      (task) => (task.taskType === LOCAL_AGENT_TASK_TYPE ? task.taskId : undefined),
    );
  }

  /** Whether the child session, or one of its ancestors, is a background agent's. */
  private isBackgroundOwned(childId: string): boolean {
    let currentId: string | undefined = childId;
    for (let depth = 0; currentId && depth < MAX_CHILD_DEPTH; depth += 1) {
      const child = this.children.get(currentId);
      if (!child) {
        return false;
      }
      if (child.conversation.backgroundChildren.has(currentId)) {
        return true;
      }
      currentId = child.parentSessionId;
    }
    return false;
  }

  /**
   * Learns which sessions belong to a conversation: `session.created` names a
   * child's parent, and a spawn call's `session.tool.progress` names the
   * child it started (`metadata.sessionID`) and the call that owns its card.
   */
  private learnOwnership(event: OpenCodeEventEnvelope, sessionId: string | undefined, data: Record<string, unknown> | null): void {
    if (!sessionId || !data) {
      return;
    }
    if (event.type === 'session.created') {
      const parentId = readOptionalString(data.parentID);
      if (parentId && !this.children.has(sessionId)) {
        this.adoptChild(sessionId, parentId);
      }
      return;
    }
    if (event.type === 'session.tool.progress') {
      const childId = readOptionalString(readObjectRecord(data.metadata)?.sessionID);
      const callId = readOptionalString(data.id);
      if (!childId || !callId) {
        return;
      }
      const child = this.children.get(childId) ?? this.adoptChild(childId, sessionId);
      if (child && child.spawnCallId !== callId) {
        child.spawnCallId = callId;
        this.flushHeldBelow(childId);
      }
    }
  }

  /**
   * The root-level `Agent` call whose card shows a child's steps: the spawn
   * call of the topmost child on its ancestor chain. Resolved at dispatch time
   * rather than copied at adoption, because a grandchild can be adopted before
   * the call that spawned its ancestor has been reported.
   */
  private cardCallIdOf(child: OpenCodeChildSession): string | undefined {
    let current = child;
    for (let depth = 0; depth < MAX_CHILD_DEPTH; depth += 1) {
      const parent = this.children.get(current.parentSessionId);
      if (!parent) {
        return current.spawnCallId;
      }
      current = parent;
    }
    return undefined;
  }

  private adoptChild(childId: string, parentId: string): OpenCodeChildSession | null {
    const conversation = this.byProvider.get(parentId) ?? this.children.get(parentId)?.conversation;
    if (!conversation) {
      return null;
    }
    const child: OpenCodeChildSession = {
      conversation,
      parentSessionId: parentId,
      translator: new OpenCodeSessionEventTranslator(conversation.appSessionId),
      held: [],
    };
    this.children.set(childId, child);
    return child;
  }

  private dispatchChild(child: OpenCodeChildSession, event: OpenCodeEventEnvelope): void {
    // A child's own end is not the run's end: only the root session settles it.
    const translated = child.translator.translate(event);
    const cardCallId = this.cardCallIdOf(child);
    for (const frame of translated.frames) {
      if (CHILD_STREAMING_KINDS.has(frame.kind)) {
        continue;
      }
      if (cardCallId === undefined) {
        if (child.held.length < MAX_HELD_CHILD_FRAMES) {
          child.held.push(frame);
        } else if (!child.heldOverflowLogged) {
          child.heldOverflowLogged = true;
          console.warn(
            `[OpenCode] dropping steps of a subagent session whose card is still unknown (more than ${MAX_HELD_CHILD_FRAMES} held)`,
          );
        }
        continue;
      }
      child.conversation.writer.send(this.tieToCard(frame, cardCallId));
    }
    // An agent's own background work keeps the conversation working too.
    if (translated.launch) {
      this.recordLaunch(child.conversation, translated.launch, true);
    }
    if (translated.notice) {
      this.recordNotice(child.conversation, translated.notice);
    }
  }

  /** Sends what a child (and every session below it) held while its card was unknown. */
  private flushHeldBelow(rootChildId: string): void {
    for (const [childId, child] of this.children) {
      if (child.held.length === 0) {
        continue;
      }
      if (childId !== rootChildId && !this.isBelow(childId, rootChildId)) {
        continue;
      }
      const cardCallId = this.cardCallIdOf(child);
      if (cardCallId === undefined) {
        continue;
      }
      for (const frame of child.held) {
        child.conversation.writer.send(this.tieToCard(frame, cardCallId));
      }
      child.held = [];
    }
  }

  private isBelow(childId: string, ancestorId: string): boolean {
    let current = this.children.get(childId);
    for (let depth = 0; current && depth < MAX_CHILD_DEPTH; depth += 1) {
      if (current.parentSessionId === ancestorId) {
        return true;
      }
      current = this.children.get(current.parentSessionId);
    }
    return false;
  }

  /** Marks a child's row as belonging to the card of `callId`. */
  private tieToCard(frame: NormalizedMessage, callId: string): NormalizedMessage {
    return { ...frame, parentToolUseId: callId };
  }

  /**
   * After a stream drop the terminal event may have been missed. A session
   * that went idle after the prompt was posted has finished; a 404 means it
   * is gone for good; any other failure leaves the run open for the next
   * reconnect. A report turn whose session went idle has ended too.
   */
  async reconcile(client: Pick<OpenCodeApiClient, 'getSession'>): Promise<void> {
    for (const conversation of [...this.byProvider.values()]) {
      const run = liveRun(conversation);
      if (run && !run.promptAccepted) {
        continue;
      }
      try {
        const snapshot = await client.getSession(conversation.providerSessionId);
        if (run) {
          if (snapshot.idleAt !== null && snapshot.idleAt >= run.startedAt) {
            run.settle(settlementFromSnapshot(snapshot));
          }
        } else if (!liveRun(conversation)) {
          // The engine says whether it is in a turn: a report turn that began
          // or ended during the gap is learnt here.
          if (this.byProvider.get(conversation.providerSessionId) !== conversation) {
            continue;
          }
          const inTurn = snapshot.idleAt === null;
          const reportEnded = conversation.engineTurn && !inTurn;
          if (inTurn && !conversation.engineTurn) {
            conversation.engineTurnStartedAt = Date.now();
          }
          conversation.engineTurn = inTurn;
          if (reportEnded && !this.isBusy(conversation)) {
            // The report ended during the gap; the work is over all the same.
            this.hooks.workFinished?.(conversation);
          }
          this.dropIfIdle(conversation);
        }
      } catch (error) {
        if (error instanceof OpenCodeApiError && error.status === 404) {
          if (run) {
            run.settle({ outcome: 'lost', error: 'The OpenCode session no longer exists.' });
          } else if (!liveRun(conversation)) {
            conversation.engineTurn = false;
            this.dropIfIdle(conversation);
          }
        }
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
