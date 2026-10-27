/**
 * The frames a websocket client receives, as one discriminated union.
 *
 * Provider messages travel as `NormalizedMessage`; the gateway adds its own
 * frames on top. Three of those gateway payloads had never been described
 * anywhere — the client read `lastSeq`, `stale`, `code` and the rest straight
 * off an index signature, so nothing could tell a typo from a real field, nor
 * a field that exists on a different frame from one that exists on this one.
 *
 * `ServerEvent` below has no index signature on purpose. Reading a field means
 * first establishing which frame you have.
 */

import type {
  NormalizedMessage,
  SessionRemovedEvent,
  SessionUpsertedEvent,
} from './chatEvents.js';

/**
 * Acknowledges `chat.subscribe`, carrying everything a client needs to catch
 * up: whether a run is in flight, how far the server's sequence has got, and
 * the approvals still waiting for an answer.
 */
export type ChatSubscribedEvent = {
  kind: 'chat_subscribed';
  sessionId: string;
  isProcessing: boolean;
  /** The session's authoritative sequence watermark. */
  lastSeq: number;
  /** Gateway process identity. Old clients may omit it on subscribe. */
  streamEpoch?: string;
  /** First seq from which every event through lastSeq is still replayable. */
  replayFromSeq?: number;
  /**
   * Whether the client's `lastSeq` already fell out of the replay buffer, in
   * which case catching up needs a REST refresh rather than a replay.
   */
  stale: boolean;
  /**
   * Approvals still awaiting an answer. Shaped by whichever provider raised
   * them, so the client validates before rendering rather than trusting it —
   * a broken contract here once produced permission cards nothing could
   * dismiss.
   */
  pendingPermissions: unknown[];
  backgroundTasks?: import('./chatEvents.js').ActiveBackgroundTask[];
  /** Includes a follow-up reply whose task card has already disappeared. */
  backgroundWorkPending?: boolean;
  /**
   * Whether `chat.abort` can still stop the session's background work. False
   * once a runtime's turn has ended with no run left to cancel (ZCode's agents
   * outlive their turn); the client then offers no stop button for it.
   */
  backgroundCanInterrupt?: boolean;
  /** See `backgroundWorkQueuesInput` on the `background_tasks` status frame. */
  backgroundWorkQueuesInput?: boolean;
  timestamp: string;
};

/** A malformed or rejected client frame, reported back rather than ignored. */
export type ProtocolErrorEvent = {
  kind: 'protocol_error';
  code: string;
  error: string;
  /** Null when the failure could not be attributed to a session. */
  sessionId: string | null;
  timestamp: string;
};

/** Progress of the initial project/session indexing sweep. */
export type LoadingProgressEvent = {
  kind: 'loading_progress';
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

/**
 * The server submitted a session's queued message. Pages may echo their local
 * copy only when its fingerprint matches; the text is never broadcast here.
 */
export type QueuedMessageDispatchedEvent = {
  kind: 'queued_message_dispatched';
  sessionId: string;
  /** 已提交正文和附件的 SHA-256 指纹；广播中不包含用户正文。 */
  messageFingerprint?: string;
};

/**
 * Synthesized by the client when the socket re-opens after a drop; no server
 * sends it. It is in this union because every subscriber sees it on the same
 * channel and has to account for it.
 */
export type WebsocketReconnectedEvent = {
  kind: 'websocket_reconnected';
  timestamp: number;
};

/** Every frame a websocket subscriber can receive. */
export type ServerEvent =
  | NormalizedMessage
  | ChatSubscribedEvent
  | SessionUpsertedEvent
  | SessionRemovedEvent
  | LoadingProgressEvent
  | ProtocolErrorEvent
  | QueuedMessageDispatchedEvent
  | WebsocketReconnectedEvent;

/** Shared transport budgets used by the gateway replay log and client gap buffer. */
export const CHAT_REPLAY_LIMITS = {
  events: 5000,
  eventBytes: 1024 * 1024,
  sessionBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
} as const;
