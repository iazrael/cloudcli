import { useCallback, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

/**
 * Coordinates session-fork requests so a double click cannot create two copies.
 *
 * Used by the chat message action and the sidebar session menu. Both funnel
 * through `forkSession`, which ignores a second call for the same source while
 * the first is still copying, and read `forkingSessionIds` to disable their
 * action. Navigate or select the returned id on success; the hook only owns the
 * dedup and the request.
 */

/** Source session ids with a fork request in flight. */
const forkingSessionIds = new Set<string>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;

const emitChange = (): void => {
  snapshotVersion += 1;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): number => snapshotVersion;

export function useSessionFork() {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  /**
   * Forks one session. Returns the new session's id and name, or `null` when a
   * fork for the same source is already in flight. Throws when the request
   * fails, so the caller can surface its own error message.
   */
  const forkSession = useCallback(
    async (
      sourceSessionId: string,
      options: { upToAnchorId?: string } = {},
    ): Promise<{ sessionId: string; sessionName: string } | null> => {
      if (forkingSessionIds.has(sourceSessionId)) {
        return null;
      }

      forkingSessionIds.add(sourceSessionId);
      emitChange();
      try {
        const response = await api.forkSession(sourceSessionId, options);
        const payload = await response.json();
        const forkedSessionId = payload?.data?.sessionId;
        if (!response.ok || typeof forkedSessionId !== 'string') {
          throw new Error(payload?.message || `HTTP ${response.status}`);
        }
        return {
          sessionId: forkedSessionId,
          sessionName: typeof payload?.data?.sessionName === 'string' ? payload.data.sessionName : '',
        };
      } finally {
        forkingSessionIds.delete(sourceSessionId);
        emitChange();
      }
    },
    [],
  );

  return { forkSession, forkingSessionIds };
}
