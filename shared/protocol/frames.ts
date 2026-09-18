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
  | WebsocketReconnectedEvent;
