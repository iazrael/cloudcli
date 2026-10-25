import { randomUUID } from 'node:crypto';

import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { sessionsDb } from '@/modules/database/index.js';
import { recordRunOutcome } from '@/modules/diagnostics/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  ProviderSessionIdReplacement,
  RealtimeClientConnection,
  RunOutcomeReason,
} from '@/shared/types.js';

import { CHAT_REPLAY_LIMITS } from '../../../../shared/protocol/frames.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * Reply payload for `chat.subscribe`'s replay lookup: the missed events, the
 * session's authoritative sequence watermark (valid even when no run is
 * tracked), and whether the client's `lastSeq` has fallen out of the buffered
 * window (see `replayEvents`).
 */
export type ChatReplayResult = {
  events: NormalizedMessage[];
  lastSeq: number;
  stale: boolean;
  streamEpoch: string;
  replayFromSeq: number;
};

// One namespace for this gateway process, independent of run eviction/reset.
const streamEpoch = randomUUID();

/**
 * The session's event channel: the audience, the sequence numbers and the
 * bounded replay buffer.
 *
 * The channel belongs to the session rather than to a run, because a provider
 * that stays resident keeps reporting after its round ended — the engine
 * starts a turn of its own to report a background result, and that report
 * belongs to the session, not to the round the user is waiting for. A new
 * round replaces the run record but not the channel, and the round's writer
 * and the session's publish entry travel on the same channel.
 */
type ChatSessionChannel = {
  appSessionId: string;
  /** Every socket watching this session, across rounds. */
  audience: Set<RealtimeClientConnection>;
  /** The last sequence number handed out for this session. */
  lastSeq: number;
  /** When the channel was created, which orders the sessions by age. */
  createdAt: number;
  /** The events a reconnecting client can replay. */
  events: NormalizedMessage[];
  eventBytes: number[];
  bufferedBytes: number;
  lastDroppedSeq: number;
  /** The writer for events that belong to the session rather than to a run. */
  writer: ChatSessionWriter;
};

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `channel`: the session's event channel. Every live event gets a `seq`
 *   continuing the session's watermark (see `sessionWatermarks`) and is
 *   buffered so a reconnecting client can replay exactly the events it missed
 *   via `chat.subscribe`.
 */
type ChatRun = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  /** The session channel this run's events travel on. */
  channel: ChatSessionChannel;
  /** The session's last sequence number, read from the channel. */
  readonly lastSeq: number;
  /** The session's replay buffer, read from the channel. */
  readonly events: NormalizedMessage[];
  /** The session's buffered bytes, read from the channel. */
  readonly bufferedBytes: number;
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
  /**
   * Why this run is about to end, when the end was decided here rather than
   * by the engine: the abort path, the supersede path, and the dispatch-error
   * safety net each stamp it before the terminal `complete` goes out. Left
   * null for a run the engine ended itself, which is then classified from its
   * exit code.
   */
  endReason: RunOutcomeReason | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per session so a very long tool-heavy run
 * cannot grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = CHAT_REPLAY_LIMITS.events;
const MAX_BUFFERED_EVENT_BYTES = CHAT_REPLAY_LIMITS.eventBytes;
const MAX_BUFFERED_RUN_BYTES = CHAT_REPLAY_LIMITS.sessionBytes;
const MAX_BUFFERED_TOTAL_BYTES = CHAT_REPLAY_LIMITS.totalBytes;
let totalBufferedBytes = 0;

function dropOldestEvent(channel: ChatSessionChannel): void {
  const removed = channel.events.shift();
  const bytes = channel.eventBytes.shift() ?? 0;
  channel.bufferedBytes -= bytes;
  totalBufferedBytes -= bytes;
  if (typeof removed?.seq === 'number') channel.lastDroppedSeq = Math.max(channel.lastDroppedSeq, removed.seq);
}

function releaseBufferedEvents(channel: ChatSessionChannel): void {
  totalBufferedBytes -= channel.bufferedBytes;
  channel.events.length = 0;
  channel.eventBytes.length = 0;
  channel.bufferedBytes = 0;
}

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

/**
 * The event channels of the sessions that have been talked to, keyed by app
 * session id.
 *
 * A channel outlives its runs: the next round of the conversation travels on
 * the same channel, and a provider that reports in the background finds the
 * audience it has to deliver to.
 */
const sessionChannels = new Map<string, ChatSessionChannel>();

/**
 * Per-session monotonic sequence watermark.
 *
 * seq is a session-scoped contract: clients keep one `lastSeq` per session and
 * send it back with `chat.subscribe`, so the counter must never restart when a
 * new run begins. This map is the single owner of that watermark — the channel
 * seeds its counter from it and every stamped event writes it back.
 * It deliberately survives run switches and buffer eviction (entries are one
 * number per session), so a reconnecting client's `lastSeq` stays comparable
 * even when the previous run's buffer is long gone.
 */
const sessionWatermarks = new Map<string, number>();

/**
 * Sockets that have asked to watch a session, kept even while the session has
 * no active run.
 *
 * `attachConnection` can only attach to a run that already exists, so a tab
 * sitting on an idle conversation is invisible to the gateway. That is fine
 * while every run begins with a client send — the sender's socket is known —
 * but a run the provider engine starts on its own (opencode resuming a session
 * from its inbox when a background subagent completes) has no sender at all.
 * These subscribers are what `adoptExternalRun` attaches so the tabs already
 * watching see the adopted run live instead of only after a manual refresh.
 *
 * Entries are keyed by app session id; a socket is dropped on close
 * (`forgetSessionSubscriber`) and dead sockets are pruned lazily on attach.
 */
const sessionSubscribers = new Map<string, Set<RealtimeClientConnection>>();

/**
 * Answers whether a completed run must stay registered a while longer. Set by
 * the composition root to the provider runtimes' background-work check: a
 * session whose turn ended but whose agents, workflows or commands are still
 * running keeps sending live events through this run's writer, and a tab that
 * subscribes meanwhile needs the run to attach to.
 */
let retainCompletedRun: (appSessionId: string) => boolean = () => false;

/**
 * Schedules one run's eviction. The timer is bound to the run it was armed
 * for: a later run can take the session's slot while this one's retention —
 * re-armed for as long as the guard holds — is still pending, and firing on
 * the slot alone would evict that newer run early.
 */
function evictRunLater(run: ChatRun): void {
  const timer = setTimeout(() => {
    if (runs.get(run.appSessionId) !== run || run.status !== 'completed') {
      return;
    }
    if (retainCompletedRun(run.appSessionId)) {
      evictRunLater(run);
      return;
    }
    releaseBufferedEvents(run.channel);
    runs.delete(run.appSessionId);
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Buffers one stamped event for replay and keeps the buffer within its bounds.
 *
 * The audience still receives an event that is too large to buffer: a
 * reconnecting client must fetch its authoritative history instead of
 * silently replaying across the hole.
 */
function bufferSessionEvent(channel: ChatSessionChannel, outbound: NormalizedMessage): void {
  const bytes = Buffer.byteLength(JSON.stringify(outbound));
  if (bytes > MAX_BUFFERED_EVENT_BYTES) {
    channel.lastDroppedSeq = channel.lastSeq;
    return;
  }

  channel.events.push(outbound);
  channel.eventBytes.push(bytes);
  channel.bufferedBytes += bytes;
  totalBufferedBytes += bytes;
  while (channel.events.length > MAX_BUFFERED_EVENTS_PER_RUN || channel.bufferedBytes > MAX_BUFFERED_RUN_BYTES) {
    dropOldestEvent(channel);
  }
  while (totalBufferedBytes > MAX_BUFFERED_TOTAL_BYTES) {
    // The oldest session goes first, so the conversations that are still
    // streaming keep their history and the quiet ones lose it.
    const candidates = [...sessionChannels.values()]
      .filter((entry) => entry.events.length > 0)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (!candidates[0]) break;
    dropOldestEvent(candidates[0]);
  }
}

/**
 * Stamps one event with the session's next sequence number.
 *
 * Provider-native ids never leave the backend, so the session id is remapped
 * to the app session id here as well.
 */
function stampSessionEvent(channel: ChatSessionChannel, message: NormalizedMessage): NormalizedMessage {
  channel.lastSeq += 1;
  sessionWatermarks.set(channel.appSessionId, channel.lastSeq);
  return {
    ...message,
    sessionId: channel.appSessionId,
    seq: channel.lastSeq,
    streamEpoch,
  };
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  const outbound = stampSessionEvent(run.channel, message);

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    // Every run leaves through this one branch, whichever runtime produced it
    // and whoever decided it should stop, so this is the only place that can
    // record why it ended without each provider having to remember to.
    recordRunOutcome({
      sessionId: run.appSessionId,
      provider: run.provider,
      reason: run.endReason ?? (readExitCode(message) === 0 ? 'engine_completed' : 'engine_failed'),
      exitCode: readExitCode(message),
      startedAt: run.startedAt,
      endedAt: run.completedAt,
      eventCount: run.channel.events.length + 1,
      lastSeq: run.channel.lastSeq,
    });
    evictRunLater(run);
  }

  bufferSessionEvent(run.channel, outbound);

  return outbound;
}

/**
 * Decorates one event that belongs to the session rather than to a run.
 *
 * A background report travels here: it is stamped and buffered like any other
 * event, but it never flips a run to `completed` and never invents one, so a
 * session with no round in flight does not start looking busy.
 */
function decorateSessionEvent(channel: ChatSessionChannel, message: NormalizedMessage): NormalizedMessage | null {
  // A terminal event belongs to a run's contract. A session-level event that
  // carried one would end a round nobody started.
  if (message.kind === 'complete') {
    return null;
  }
  const outbound = stampSessionEvent(channel, message);
  bufferSessionEvent(channel, outbound);
  return outbound;
}

/** Reads a terminal event's exit code, defaulting to a failure it cannot read. */
function readExitCode(message: NormalizedMessage): number {
  const value = (message as NormalizedMessage & { exitCode?: unknown }).exitCode;
  return typeof value === 'number' ? value : 1;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 *
 * A `replacement` descriptor means the engine started a different session than
 * the one this run resumed (Claude, after its first prompt was edited). The app
 * row must then move to the replacement transcript — `assignProviderSessionId`
 * would keep the old `jsonl_path` — and the transcript it leaves behind must be
 * retired so the indexer never offers it back as its own conversation.
 */
function recordProviderSessionId(
  run: ChatRun,
  providerSessionId: string,
  replacement?: ProviderSessionIdReplacement,
): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    if (replacement) {
      sessionsDb.repointSessionToProviderSession(run.appSessionId, {
        providerSessionId,
        jsonlPath: replacement.transcriptPath,
        supersedePrevious: true,
      });
    } else {
      sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    }
    void broadcastSessionUpserted(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * The event channel of a session, created when the session is first talked to.
 *
 * The channel keeps the session's audience, so a provider that reports after
 * its round ended still reaches the tabs that are watching the conversation.
 */
function ensureSessionChannel(
  appSessionId: string,
  options: { userId: string | number | null; provider: LLMProvider },
): ChatSessionChannel {
  const existing = sessionChannels.get(appSessionId);
  if (existing) {
    return existing;
  }
  pruneSessionChannels();
  const channel: ChatSessionChannel = {
    appSessionId,
    audience: new Set<RealtimeClientConnection>(),
    // Continue the session's watermark: a client that watched the previous
    // run keeps one `lastSeq` per session, so a fresh counter per run would
    // make its replay filter silently drop the new run's events.
    lastSeq: sessionWatermarks.get(appSessionId) ?? 0,
    createdAt: Date.now(),
    events: [],
    eventBytes: [],
    bufferedBytes: 0,
    lastDroppedSeq: 0,
    writer: null as unknown as ChatSessionWriter,
  };
  channel.writer = new ChatSessionWriter({
    connection: null,
    audience: channel.audience,
    userId: options.userId,
    provider: options.provider,
    providerSessionId: null,
    onProviderSessionId: () => {},
    decorateOutboundEvent: (message) => decorateSessionEvent(channel, message),
  });
  sessionChannels.set(appSessionId, channel);
  return channel;
}

/**
 * Drops the channels that no run, no event and no socket needs any more.
 *
 * A channel outlives the run that created it, because a resident engine
 * reports on it after the run is over. One that nothing points at any more
 * would only keep its sockets alive.
 */
function pruneSessionChannels(): void {
  for (const [sessionId, channel] of sessionChannels) {
    for (const connection of channel.audience) {
      if (connection.readyState !== WS_OPEN_STATE) {
        channel.audience.delete(connection);
      }
    }
    if (!runs.has(sessionId) && channel.events.length === 0 && channel.audience.size === 0) {
      sessionChannels.delete(sessionId);
    }
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /** Installs the check that keeps a completed run registered while its session still has background work. */
  setRetentionGuard(guard: (appSessionId: string) => boolean): void {
    retainCompletedRun = guard;
  },

  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    /**
     * The socket that asked for this run, or `null` for one nobody is watching
     * — a scheduled message fires with no browser attached. The writer's event
     * buffer still records everything, so a client that subscribes later
     * replays the run from its start.
     */
    connection: RealtimeClientConnection | null;
    userId: string | number | null;
    /** What the user calls the session, for notification titles. */
    sessionName?: string | null;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      return null;
    }

    const channel = ensureSessionChannel(input.appSessionId, {
      userId: input.userId,
      provider: input.provider,
    });
    // The socket that asked for the run also watches the session, so the
    // events that belong to the session reach it as well.
    if (input.connection) {
      channel.audience.add(input.connection);
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      channel,
      get lastSeq() {
        return channel.lastSeq;
      },
      get events() {
        return channel.events;
      },
      get bufferedBytes() {
        return channel.bufferedBytes;
      },
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
      endReason: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      // The sockets watching the conversation when the round starts. A tab that
      // opens the conversation later joins the session's audience, not this
      // round's: it replays what it missed instead.
      audience: new Set(channel.audience),
      userId: input.userId,
      sessionName: input.sessionName,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId, replacement) => {
        recordProviderSessionId(run, providerSessionId, replacement);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    runs.set(input.appSessionId, run);
    return run;
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.channel.lastSeq,
      }));
  },

  /**
   * Records one socket as watching a session. Called for every `chat.subscribe`
   * target — including sessions with a run in flight, where attachment happens
   * through `attachConnection` — so a later engine-initiated run can reach
   * whoever is already looking without waiting for a refresh.
   */
  noteSessionSubscriber(appSessionId: string, connection: RealtimeClientConnection): void {
    let subscribers = sessionSubscribers.get(appSessionId);
    if (!subscribers) {
      subscribers = new Set();
      sessionSubscribers.set(appSessionId, subscribers);
    }
    subscribers.add(connection);
  },

  /** Drops one closed socket from every session it was watching. */
  forgetSessionSubscriber(connection: RealtimeClientConnection): void {
    for (const [appSessionId, subscribers] of sessionSubscribers) {
      if (!subscribers.delete(connection)) {
        continue;
      }
      if (subscribers.size === 0) {
        sessionSubscribers.delete(appSessionId);
      }
    }
  },

  /**
   * Attaches every socket currently watching the session to its run.
   *
   * Used when a run begins without a sender socket — an adopted engine run —
   * so the tabs already on the conversation receive its frames live. A later
   * subscriber still attaches through `chat.subscribe`'s own path; attaching
   * here is an addition, never a takeover. Returns how many sockets attached.
   */
  attachSessionSubscribers(appSessionId: string): number {
    const run = runs.get(appSessionId);
    const subscribers = sessionSubscribers.get(appSessionId);
    if (!run || !subscribers) {
      return 0;
    }

    let attached = 0;
    for (const connection of [...subscribers]) {
      if (connection.readyState === WS_OPEN_STATE) {
        run.writer.updateWebSocket(connection);
        attached += 1;
      } else {
        subscribers.delete(connection);
      }
    }
    return attached;
  },

  /**
   * Opens a gateway run for an execution the provider engine started on its
   * own, and returns the app session the run belongs to plus the writer the
   * runtime must feed its translated frames.
   *
   * This is the adoption half of the two-registry design: the runtime detects
   * engine-initiated activity on its event feed (opencode resuming an idle
   * session from its inbox after a subagent completes) and asks here for a
   * run, because only the gateway can assign `seq`, buffer for replay, record
   * the outcome, and reach the sockets. The run is registered exactly like a
   * detached scheduled turn — no owning connection, so `isProcessing` reports
   * busy everywhere, subscribers attach below, and a client that subscribes
   * later replays it from the start.
   *
   * Returns null when the provider session maps to no app session (subagent
   * and CLI-created sessions live only in the engine), the row is archived,
   * the provider disagrees, or a run is already in flight for the session.
   */
  adoptExternalRun(input: {
    provider: LLMProvider;
    providerSessionId: string;
  }): { appSessionId: string; writer: ChatSessionWriter } | null {
    const session = sessionsDb.getSessionByProviderSessionId(input.providerSessionId);
    if (!session || session.provider !== input.provider || session.isArchived) {
      return null;
    }

    const run = this.startRun({
      appSessionId: session.session_id,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      connection: null,
      userId: null,
    });
    if (!run) {
      return null;
    }

    this.attachSessionSubscribers(session.session_id);
    return { appSessionId: session.session_id, writer: run.writer };
  },

  /**
   * Adds a websocket connection to a session's audience.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   *
   * Subscribing does not take the stream away from sockets that were already
   * watching — a session open in two places stays live in both, and the
   * refreshed tab's abandoned socket is dropped when the next event finds it
   * closed. Replay stays per-connection because each client sends its own
   * `lastSeq` with `chat.subscribe`.
   */
  attachConnection(
    appSessionId: string,
    connection: RealtimeClientConnection,
    options?: { includeRun?: boolean },
  ): boolean {
    // The session's audience is for the events that belong to the session
    // rather than to a round: a resident engine reports on it after its run
    // is over. A session that has not run yet has no channel, because a
    // resident engine only exists once a round ran in this process.
    const channel = sessionChannels.get(appSessionId);
    if (channel) {
      channel.audience.add(connection);
      pruneSessionChannels();
    }

    const run = runs.get(appSessionId);
    if (!run) {
      return Boolean(channel);
    }
    const includeRun = options?.includeRun ?? run.status === 'running';
    if (includeRun) {
      // A run that is still going, or one that the session's background work
      // keeps alive, delivers its later events to the socket as well.
      run.writer.updateWebSocket(connection);
      return true;
    }
    // A finished run keeps its own audience: a socket that opens the
    // conversation afterwards does not receive that run's late events, it
    // replays them instead.
    return Boolean(channel);
  },

  /**
   * Publishes one event to a session outside any run.
   *
   * A resident provider can report after its round ended — the engine starts
   * a turn of its own to deliver a background result. That event belongs to
   * the session: it is stamped with the session's next sequence number,
   * buffered for replay and delivered to the session's audience, but it never
   * makes the session look busy and never ends a round.
   */
  publishSessionEvent(appSessionId: string, message: NormalizedMessage): void {
    const channel = ensureSessionChannel(appSessionId, {
      userId: null,
      provider: message.provider ?? 'codex',
    });
    channel.writer.send(message);
  },

  /**
   * Returns the events a reconnecting client missed, plus the authoritative
   * replay state for `chat.subscribe`'s ack.
   *
   * `stale` is true when the client's `afterSeq` predates the oldest buffered
   * event: the middle of the stream was dropped (the per-session buffer cap or
   * the completed-run retention window), replay cannot bridge the gap, and the
   * client must refresh history over REST instead of trusting the replay.
   */
  replayEvents(appSessionId: string, afterSeq: number): ChatReplayResult {
    const lastSeq = sessionWatermarks.get(appSessionId) ?? 0;
    const channel = sessionChannels.get(appSessionId);
    if (!channel) {
      return { events: [], lastSeq, stale: afterSeq !== lastSeq, streamEpoch, replayFromSeq: lastSeq + 1 };
    }

    const events = channel.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
    const oldestBuffered = channel.events.find((event) => typeof event.seq === 'number')?.seq;
    const replayFromSeq = Math.max(channel.lastDroppedSeq + 1, oldestBuffered ?? lastSeq + 1);
    return { events, lastSeq, stale: afterSeq < replayFromSeq - 1 || afterSeq > lastSeq, streamEpoch, replayFromSeq };
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(
    appSessionId: string,
    opts: { exitCode: number; aborted?: boolean; reason: RunOutcomeReason },
  ): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.endReason = opts.reason;
    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(
    run: ChatRun,
    opts: { exitCode: number; aborted?: boolean; reason: RunOutcomeReason },
  ): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.endReason = opts.reason;
    run.writer.sendComplete(opts);
  },

  /**
   * Test-only escape hatch: clears every tracked run, channel and sequence
   * watermark.
   */
  clearAll(): void {
    runs.clear();
    sessionChannels.clear();
    totalBufferedBytes = 0;
    sessionWatermarks.clear();
    sessionSubscribers.clear();
  },
};
