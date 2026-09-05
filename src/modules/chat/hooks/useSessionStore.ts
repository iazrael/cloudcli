/**
 * React adapter over the framework-free session timeline store.
 *
 * One `SessionTimelineStore` instance per app mount owns the per-session
 * timelines (persisted pages, live rows, merged view, pagination, stream
 * buffers, resume seq). This hook only wires the re-render signal: the store
 * notifies for the active session, and the tick bump re-renders the hosting
 * component so the view re-reads `getMessages`.
 *
 * Session switch = change activeSessionId pointer. No clearing. Old data
 * stays. WebSocket handler = store.appendRealtime(msg.sessionId, msg).
 * Backend transcript is the source of truth; no localStorage for messages.
 */

import { useState } from 'react';

import { SessionTimelineStore } from '@/modules/chat/utils/sessionTimelineStore';

export type { MessageKind, NormalizedMessage } from '@/shared/types';
export type { SessionSlot, SessionStatus } from '@/modules/chat/utils/sessionTimelineStore';

/** The store instance type the chat module's hooks pass around. */
export type SessionStore = SessionTimelineStore;

export function useSessionStore(): SessionTimelineStore {
  // Bump to force re-render — only when the active session's data changes.
  // Session ids are stable for the whole conversation lifetime (the backend
  // allocates them before the first send), so slots are keyed directly with
  // no alias/redirect indirection.
  const [, setTick] = useState(0);
  // Lazy singleton: the store is created once per app mount; `notify` only
  // ever fires after mount, so capturing the stable setter here is safe.
  const [store] = useState(() => new SessionTimelineStore({
    notify: () => setTick(n => n + 1),
  }));
  return store;
}
