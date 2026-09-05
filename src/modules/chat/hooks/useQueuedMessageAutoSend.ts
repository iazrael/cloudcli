import { useEffect, useRef } from 'react';

import { clearQueuedMessage, readQueuedMessage } from '@/modules/chat/utils/chatStorage';
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
 * Dispatches queued messages for sessions the user is NOT currently viewing.
 *
 * The composer persists each queued draft (text + send options snapshotted at
 * queue time) under `queued_message_<sessionId>`. When a session's run leaves
 * the processing map — its previous response completed — this hook sends that
 * session's queued message immediately instead of waiting for the user to
 * open the session again. Removing the storage key before sending is the
 * claim that keeps the composer's own flush from double-sending.
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

      const queued = readQueuedMessage(sessionId);
      if (!queued) {
        continue;
      }

      // A closed socket would drop the send silently; keep the draft so the
      // composer (or a later completion) can retry once we're connected.
      if (!isConnected) {
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
