import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent } from '@/shared/context/WebSocketContext';
import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '@/modules/chat/utils/notificationSound';
import type { MarkSessionIdle, MarkSessionProcessing } from '@/shared/types';
import type { PendingPermissionRequest } from '@/shared/types';
import type { ProjectSession, LLMProvider } from '@/shared/types';
import type { ServerEventDirective } from '@/modules/chat/utils/sessionTimelineStore';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

type UseChatRealtimeHandlersArgs = {
  isActive: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * The side-effect layer of the realtime pipeline. Every frame goes through
 * `sessionStore.applyServerEvent`, which owns what a frame *means* to the
 * timeline (flush gate, upserts, truncation, stream lifecycle, resume seq —
 * see the store's routing table); this hook only executes the app reactions
 * the store reports: sounds, permission lists, processing state, refreshes.
 * Every frame is keyed by the stable app session id, so there is no
 * session-id handoff, no provider branching, and no navigation here.
 */
export function useChatRealtimeHandlers({
  isActive,
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  requestLatestMessages,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      // Transport-synthesized (no timeline state; the store never sees it).
      if (msg.kind === 'websocket_reconnected') {
        onWebSocketReconnect?.();
        return;
      }

      // Sidebar/global events — owned by useProjectsState.
      if (msg.kind === 'session_upserted' || msg.kind === 'loading_progress') {
        return;
      }

      const directive = sessionStore.applyServerEvent(msg, {
        fallbackSessionId: activeViewSessionIdRef.current,
        provider,
      });
      if (!directive) {
        return;
      }

      executeDirective(directive);
    };

    /** Runs the app reactions one frame requires. No timeline state in here. */
    function executeDirective(directive: ServerEventDirective): void {
      switch (directive.effect) {
        case 'chat_subscribed': {
          // The ack's `lastSeq` is already merged into the store. `stale`
          // means the replay cursor predates the server's replay buffer, so
          // replay cannot bridge the reconnect gap and a REST refresh must
          // reconcile.
          if (directive.stale) {
            void requestLatestMessages(directive.sessionId, isActiveRef.current);
          }

          if (directive.isProcessing) {
            onSessionProcessing?.(directive.sessionId);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(directive.sessionId, {
              ifStartedBefore: statusCheckSentAtRef.current.get(directive.sessionId),
            });
          }

          if (directive.sessionId === activeViewSessionIdRef.current && directive.pendingPermissions) {
            // Shape-check every entry: a bare request-id (or any malformed
            // row) would render a card with an empty tool badge whose buttons
            // are silently dropped because requestId is undefined.
            const nextPendingPermissionRequests = directive.pendingPermissions.filter(
              (entry): entry is PendingPermissionRequest =>
                typeof entry === 'object' && entry !== null &&
                typeof (entry as PendingPermissionRequest).requestId === 'string',
            );
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'protocol_error': {
          // The store already surfaced the failure as an error row and the
          // spinner must stop — the run never started, so no `complete`
          // follows.
          console.error('[Chat] Protocol error:', directive.code, directive.error);
          onSessionIdle?.(directive.sessionId);
          return;
        }

        case 'complete': {
          const { sessionId, success, aborted } = directive;
          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort (the
          // store settled unpaired tool cards before this ran). The indicator
          // derives from the processing map, so deleting the entry hides it
          // immediately and atomically.
          onSessionIdle?.(sessionId);
          if (sessionId === activeViewSessionIdRef.current) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            return;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (success) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sessionId && sessionId === activeViewSessionIdRef.current) {
            void requestLatestMessages(sessionId, isActiveRef.current);
          }
          return;
        }

        case 'status': {
          if (directive.text === 'token_budget' && directive.tokenBudget) {
            setTokenBudget(directive.tokenBudget as Record<string, unknown>);
          } else if (directive.text && directive.sessionId) {
            onSessionProcessing?.(directive.sessionId, {
              statusText: directive.text,
              canInterrupt: directive.canInterrupt,
            });
          }
          return;
        }

        case 'permission_request': {
          if (!directive.requestId) {
            return;
          }
          if (isActionablePermissionRequest({ toolName: directive.toolName })) {
            void playNotificationSound();
          }

          if (directive.sessionId === activeViewSessionIdRef.current) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === directive.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: directive.requestId,
                toolName: directive.toolName,
                input: directive.input,
                context: directive.context,
                sessionId: directive.sessionId,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (directive.sessionId) {
            onSessionProcessing?.(directive.sessionId);
          }
          return;
        }

        case 'permission_cancelled': {
          if (directive.requestId && directive.sessionId === activeViewSessionIdRef.current) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== directive.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          return;
        }
      }
    }

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  ]);
}
