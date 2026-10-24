import { useEffect, useRef } from 'react';

import {
  clearQueuedCompact,
  clearQueuedMessage,
  readQueuedCompact,
  readQueuedMessage,
} from '@/modules/chat/utils/chatStorage';
import {
  useProcessingSessions,
  useSessionProtectionActions,
} from '@/shared/context/SessionProtectionContext';

type UseQueuedMessageAutoSendArgs = {
  /**
   * The session currently open in the chat view. Its queued draft is owned by
   * the composer (which also handles image attachments and slash commands),
   * so this hook never touches it.
   */
  activeSessionId: string | null;
  /** Live websocket connectivity; a send while disconnected would drop the frame silently. */
  isConnected: boolean;
  sendMessage: (message: unknown) => void;
};

/**
 * Dispatches queued work for sessions the user is NOT currently viewing.
 *
 * The composer persists each queued draft (text + send options snapshotted at
 * queue time) under `queued_message_<sessionId>`, and each `/compact` asked
 * for mid-turn under `queued_compact_<sessionId>`. When a session's run leaves
 * the processing map — its previous response completed — this hook dispatches
 * that work immediately instead of waiting for the user to open the session
 * again. Removing the storage key before sending is the claim that keeps the
 * composer's own flush from double-sending.
 *
 * Mounted by the project-workspace shell, one level below the
 * SessionProtectionProvider, so every viewed project gets exactly one instance.
 */
export function useQueuedMessageAutoSend({
  activeSessionId,
  isConnected,
  sendMessage,
}: UseQueuedMessageAutoSendArgs) {
  const processingSessions = useProcessingSessions();
  const { markSessionProcessing } = useSessionProtectionActions();
  const prevProcessingRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const prev = prevProcessingRef.current;
    const current = new Set(processingSessions.keys());
    prevProcessingRef.current = current;

    for (const sessionId of prev) {
      if (current.has(sessionId) || sessionId === activeSessionId) {
        continue;
      }

      // A closed socket would drop the send silently; keep the work so the
      // composer (or a later completion) can retry once we're connected.
      if (!isConnected) {
        continue;
      }

      // A parked `/compact` goes first: compaction is a run of its own, so the
      // queued message behind it waits for the next completion.
      const parkedCompact = readQueuedCompact(sessionId);
      if (parkedCompact) {
        clearQueuedCompact(sessionId);
        sendMessage({
          type: 'chat.compact',
          sessionId,
          options: parkedCompact.options ?? {},
        });
        markSessionProcessing(sessionId, { statusText: null, canInterrupt: false });
        continue;
      }

      const queued = readQueuedMessage(sessionId);
      if (!queued) {
        continue;
      }

      clearQueuedMessage(sessionId);
      sendMessage({
        type: 'chat.send',
        sessionId,
        content: queued.content,
        options: { ...(queued.options ?? {}), images: [] },
      });
      markSessionProcessing(sessionId, { statusText: null, canInterrupt: true });
    }
  }, [processingSessions, activeSessionId, isConnected, sendMessage, markSessionProcessing]);
}
