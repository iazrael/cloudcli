import { useEffect, useRef } from 'react';

import type { ServerEvent } from '@/shared/context/WebSocketContext';
import { hydrateChatDrafts, readQueuedMessage } from '@/shared/chatDrafts';
import type { ChatAttachment, ChatImage, ChatMessage, MarkSessionProcessing } from '@/shared/types';
import { isImageAttachment } from '@/shared/utils';

type UseQueuedMessageSyncArgs = {
  /** The session the chat view shows; only its timeline gets the echo. */
  activeSessionId: string | null;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  /** Appends to the viewed session's timeline, as a manual send does. */
  addMessage: (message: ChatMessage) => void;
  onSessionProcessing?: MarkSessionProcessing;
};

/**
 * Mounted by ChatInterface, which owns the timeline the echo goes into.
 *
 * Keeps the page in step with the server, which is the only sender of queued
 * messages: the composer writes a queued message to the server and the
 * scheduled-messages dispatcher starts it once the session is free, whether or
 * not any page is open.
 *
 * - `queued_message_dispatched`: the server started a session's queued
 *   message. The viewed session gets the same local echo a manual send makes
 *   only when its local copy matches the submitted fingerprint; the
 *   session is marked busy, and the queue is reloaded so the card disappears.
 * - `websocket_reconnected`: a page that was offline (a phone that slept)
 *   missed those frames, so the queue is reloaded from the server.
 */
export function useQueuedMessageSync({
  activeSessionId,
  subscribe,
  addMessage,
  onSessionProcessing,
}: UseQueuedMessageSyncArgs) {
  // Read inside the listener so a session switch or a new callback identity
  // never drops a frame between unsubscribe and resubscribe.
  const latestRef = useRef({ activeSessionId, addMessage, onSessionProcessing });
  useEffect(() => {
    latestRef.current = { activeSessionId, addMessage, onSessionProcessing };
  });

  useEffect(() => subscribe((event) => {
    void (async () => {
      if (event.kind === 'websocket_reconnected') {
        void hydrateChatDrafts();
        return;
      }
      if (event.kind !== 'queued_message_dispatched' || typeof event.sessionId !== 'string') {
        return;
      }

      const { sessionId } = event;
      const latest = latestRef.current;
      const queued = readQueuedMessage(sessionId);
      let matchesSubmitted = !event.messageFingerprint;
      if (queued && event.messageFingerprint && globalThis.crypto?.subtle) {
        const input = JSON.stringify({ content: queued.content, attachments: queued.attachments ?? [] });
        const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
        const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        matchesSubmitted = fingerprint === event.messageFingerprint;
      }
      // 本地后续编辑不能冒充本轮已发送的内容；
      // 指纹不匹配时，由服务端历史补齐真实消息。
      if (queued && matchesSubmitted && sessionId === latestRef.current.activeSessionId) {
        const attachments = (queued.attachments ?? []) as ChatAttachment[];
        latestRef.current.addMessage({
          type: 'user',
          content: queued.content,
          images: attachments.filter(isImageAttachment) as ChatImage[],
          files: attachments.filter((attachment) => !isImageAttachment(attachment)),
          timestamp: new Date(),
        });
      }
      latest.onSessionProcessing?.(sessionId, { statusText: null, canInterrupt: true });
      void hydrateChatDrafts();
    })().catch((error: unknown) => {
      console.error('排队消息发送确认同步失败：', error);
      void hydrateChatDrafts();
    });
  }), [subscribe]);
}
