/**
 * Narrowing an incoming frame to the one it actually is.
 *
 * `ServerEvent` is a union without an index signature, so a field cannot be
 * read before the frame is established. These are how that is done, and the
 * two readers at the bottom cover the fields that exist on *some* frames: a
 * plain `msg.sessionId` does not compile, because a reconnect notice and a
 * loading-progress frame have no session.
 */

import type {
  SessionRemovedEvent,
  SessionUpsertedEvent,
  NormalizedMessage,
} from './chatEvents.js';
import type {
  ChatSubscribedEvent,
  LoadingProgressEvent,
  ProtocolErrorEvent,
  ServerEvent,
  WebsocketReconnectedEvent,
} from './frames.js';

export function isChatSubscribedEvent(event: ServerEvent): event is ChatSubscribedEvent {
  return event.kind === 'chat_subscribed';
}

export function isProtocolErrorEvent(event: ServerEvent): event is ProtocolErrorEvent {
  return event.kind === 'protocol_error';
}

export function isLoadingProgressEvent(event: ServerEvent): event is LoadingProgressEvent {
  return event.kind === 'loading_progress';
}

export function isSessionUpsertedEvent(event: ServerEvent): event is SessionUpsertedEvent {
  return event.kind === 'session_upserted';
}

export function isSessionRemovedEvent(event: ServerEvent): event is SessionRemovedEvent {
  return event.kind === 'session_removed';
}

export function isWebsocketReconnectedEvent(
  event: ServerEvent,
): event is WebsocketReconnectedEvent {
  return event.kind === 'websocket_reconnected';
}

/** Kinds the gateway adds; everything else on the channel is a provider message. */
const GATEWAY_KINDS: ReadonlySet<string> = new Set([
  'chat_subscribed',
  'session_upserted',
  'session_removed',
  'loading_progress',
  'protocol_error',
  'websocket_reconnected',
]);

/** True for the provider messages, as opposed to the gateway's own frames. */
export function isNormalizedMessageEvent(event: ServerEvent): event is NormalizedMessage {
  return !GATEWAY_KINDS.has(event.kind);
}

/**
 * The session a frame belongs to, or null when it belongs to none.
 *
 * `protocol_error` carries an explicitly nullable one; a reconnect notice and
 * a loading-progress frame carry no session at all.
 */
export function readFrameSessionId(event: ServerEvent): string | null {
  return 'sessionId' in event && typeof event.sessionId === 'string' && event.sessionId
    ? event.sessionId
    : null;
}

/** The replay sequence a frame carries, or null when it carries none. */
export function readFrameSeq(event: ServerEvent): number | null {
  return 'seq' in event && typeof event.seq === 'number' ? event.seq : null;
}
