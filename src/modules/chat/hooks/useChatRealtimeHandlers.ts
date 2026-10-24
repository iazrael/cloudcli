import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent } from '@/shared/context/WebSocketContext';
import { showCompletionTitleIndicator } from '@/shared/utils';
import { playChatCompletionSound, playNotificationSound } from '@/modules/chat/utils/notificationSound';
import type { MarkSessionIdle, MarkSessionProcessing, SessionActivityMap, PendingPermissionRequest, ProjectSession, LLMProvider } from '@/shared/types';
import type { ServerEventDirective } from '@/modules/chat/utils/sessionTimelineStore';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasSubagentOrigin = (request: PendingPermissionRequest): boolean => {
  const subagent = (request.context as { subagent?: unknown } | null | undefined)?.subagent;
  return Boolean(subagent && typeof subagent === 'object');
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

type UseChatRealtimeHandlersArgs = {
  isActive: boolean;
  sendMessage: (message: unknown) => void;
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
  /** Which sessions are busy; a `background_tasks` frame must not demote a reply in flight. */
  processingSessions?: SessionActivityMap;
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
  sendMessage,
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
  processingSessions,
  onWebSocketReconnect,
  requestLatestMessages,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const { t } = useTranslation('chat');
  // One retry chain per recovery identity; ordinary rerenders must not restart it.
  const recoveryRetriesRef = useRef(new Map<string, { id: number; attempts: number; timer: ReturnType<typeof setTimeout> | null }>());
  // Async failures after unmount must not schedule a new retry chain.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const retries = recoveryRetriesRef.current;
    return () => {
      mountedRef.current = false;
      for (const retry of retries.values()) if (retry.timer !== null) clearTimeout(retry.timer);
      retries.clear();
    };
  }, []);

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
  const sessionHadBackgroundTasksRef = useRef<Map<string, boolean>>(new Map());
  const processingSessionsRef = useRef(processingSessions);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    processingSessionsRef.current = processingSessions;
  }, [processingSessions]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      // Transport-synthesized (no timeline state; the store never sees it).
      if (msg.kind === 'websocket_reconnected') {
        sessionStore.beginConnection();
        const sessions = new Set(sessionStore.getKnownSessionIds());
        if (activeViewSessionIdRef.current) sessions.add(activeViewSessionIdRef.current);
        for (const sessionId of sessions) executeDirective({ effect: 'replay_request', sessionId });
        onWebSocketReconnect?.();
        return;
      }

      // Sidebar/global events — owned by useProjectsState; queued-message
      // starts — owned by useQueuedMessageSync.
      if (
        msg.kind === 'session_upserted'
        || msg.kind === 'session_removed'
        || msg.kind === 'loading_progress'
        || msg.kind === 'queued_message_dispatched'
      ) {
        return;
      }

      sessionStore.applyServerEvent(msg, {
        fallbackSessionId: activeViewSessionIdRef.current,
        provider,
        onDirective: executeDirective,
      });
    };

    /** Runs the app reactions one frame requires. No timeline state in here. */
    function executeDirective(directive: ServerEventDirective): void {
      switch (directive.effect) {
        case 'replay_request': {
          statusCheckSentAtRef.current.set(directive.sessionId, Date.now());
          sendMessage({ type: 'chat.subscribe', sessions: [sessionStore.getSubscriptionCursor(directive.sessionId)] });
          return;
        }
        case 'recover_stream': {
          const { sessionId, recoveryId } = directive;
          const previous = recoveryRetriesRef.current.get(sessionId);
          if (previous?.id === recoveryId) return;
          if (previous?.timer != null) clearTimeout(previous.timer);
          const retry = { id: recoveryId, attempts: 0, timer: null as ReturnType<typeof setTimeout> | null };
          recoveryRetriesRef.current.set(sessionId, retry);
          const current = () => mountedRef.current && recoveryRetriesRef.current.get(sessionId) === retry
            && sessionStore.isEventRecoveryCurrent(sessionId, recoveryId);
          const attempt = () => {
            retry.timer = null;
            if (!current()) return;
            void sessionStore.recoverEventStream(sessionId, recoveryId, {
              provider, onDirective: executeDirective,
            }).then(() => {
              if (recoveryRetriesRef.current.get(sessionId) === retry) recoveryRetriesRef.current.delete(sessionId);
            }).catch((error) => {
              console.error('[Chat] History recovery failed:', error);
              if (!current()) return;
              sessionStore.setEventRecoveryError(sessionId, t('replay.recoveryFailed'), provider);
              const delay = Math.min(1000 * 2 ** Math.min(retry.attempts++, 5), 30_000);
              retry.timer = setTimeout(attempt, delay);
            });
          };
          attempt();
          return;
        }
        case 'chat_subscribed': {
          // The ack's `lastSeq` is already merged into the store. `stale`
          // means the replay cursor predates the server's replay buffer, so
          // replay cannot bridge the reconnect gap and a REST refresh must
          // reconcile.
          if (directive.stale) {
            void requestLatestMessages(directive.sessionId, isActiveRef.current);
          }

          if (directive.isProcessing || sessionStore.hasPendingBackgroundWork(directive.sessionId)) {
            onSessionProcessing?.(directive.sessionId, {
              background: !directive.isProcessing,
            });
            if (sessionStore.hasPendingBackgroundWork(directive.sessionId)) {
              sessionHadBackgroundTasksRef.current.set(directive.sessionId, true);
            }
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
          // A rejected stop is not a terminal event, and neither is a send the
          // server refused because a run is still going. The store has shown
          // the error, but only the runtime can settle the foreground/background
          // state and release queued input.
          console.error('[Chat] Protocol error:', directive.code, directive.error);
          if (directive.code === 'NO_SUCH_TASK' || directive.code === 'TASK_ID_REQUIRED'
            || directive.code === 'TASK_STOP_FAILED' || directive.code === 'ABORT_FAILED'
            || directive.code === 'RUN_IN_PROGRESS') {
            return;
          }
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
          const backgroundPending = Boolean(sessionId && sessionStore.hasPendingBackgroundWork(sessionId));
          if (sessionId) {
            // The reply is over now, not at the next render: a task frame
            // landing before React re-renders must see it as over.
            const turnActivity = processingSessionsRef.current?.get(sessionId);
            if (turnActivity && !turnActivity.background) {
              const settled = new Map(processingSessionsRef.current);
              settled.delete(sessionId);
              processingSessionsRef.current = settled;
            }
          }
          if (sessionId && backgroundPending && success && !aborted) {
            onSessionProcessing?.(sessionId, { background: true });
          } else {
            onSessionIdle?.(sessionId);
            if (aborted || !success) {
              onSessionIdle?.(sessionId, { backgroundOnly: true });
            }
          }
          if (sessionId === activeViewSessionIdRef.current) {
            // The turn's own cards end with it. A card from a subagent that
            // is still running is the server's to retract (`permission_cancelled`
            // when the agent stops), so a clean finish keeps it; a failed or
            // aborted run takes every card with it.
            const surviving = success && !aborted
              ? pendingPermissionRequestsRef.current.filter((request) => hasSubagentOrigin(request))
              : [];
            pendingPermissionRequestsRef.current = surviving;
            setPendingPermissionRequests(surviving);
          }

          if (aborted || !success) {
            if (sessionId) {
              sessionHadBackgroundTasksRef.current.delete(sessionId);
            }
            if (aborted) {
              // Abort was requested — the complete event confirms it. No
              // further UI action is needed beyond clearing the entry above.
              return;
            }
          }

          // Celebrate only successful runs (failed runs end with success: false).
          // If background tasks are still running, defer celebration until they complete.
          const hasRunningBgTasks = Boolean(
            sessionId && sessionStore.hasPendingBackgroundWork(sessionId),
          );
          if (sessionId && hasRunningBgTasks) {
            sessionHadBackgroundTasksRef.current.set(sessionId, true);
          }
          if (success && !hasRunningBgTasks) {
            if (sessionId) {
              sessionHadBackgroundTasksRef.current.delete(sessionId);
            }
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
          if (directive.text === 'activity_state' && directive.sessionId && directive.activityState) {
            // The engine says what it is doing with the round, so the pill can
            // tell "waiting for the engine" from "the engine is working on it"
            // without waiting for the next poll.
            onSessionProcessing?.(directive.sessionId, {
              queued: directive.activityState.queued === true,
              reporting: directive.activityState.reporting === true,
            });
          } else if (directive.text === 'token_budget' && directive.tokenBudget) {
            setTokenBudget(directive.tokenBudget as Record<string, unknown>);
          } else if (directive.text === 'background_tasks' && directive.sessionId) {
            // Agents launched and settled mid-turn (Codex, ZCode) are the
            // turn's business: the reply stays the thing in flight, and the
            // turn's own `complete` decides whether a background phase follows.
            const activity = processingSessionsRef.current?.get(directive.sessionId);
            if (activity && !activity.background) {
              return;
            }
            if (sessionStore.hasPendingBackgroundWork(directive.sessionId)) {
              sessionHadBackgroundTasksRef.current.set(directive.sessionId, true);
              onSessionProcessing?.(directive.sessionId, { background: true });
            } else if (sessionHadBackgroundTasksRef.current.get(directive.sessionId)) {
              sessionHadBackgroundTasksRef.current.delete(directive.sessionId);
              onSessionIdle?.(directive.sessionId, {
                backgroundOnly: true,
              });
              showCompletionTitleIndicator();
              void playChatCompletionSound();
            }
          } else if (directive.text && directive.sessionId) {
            onSessionProcessing?.(directive.sessionId, {
              statusText: directive.text,
              canInterrupt: directive.canInterrupt,
              background: sessionStore.hasPendingBackgroundWork(directive.sessionId),
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
            // A card can arrive with no reply in flight (a background agent
            // asking after the turn ended); it must not turn the session
            // into a foreground reply.
            onSessionProcessing?.(directive.sessionId, { awaitingApproval: true });
          }
          return;
        }

        case 'permission_resolved':
        case 'permission_cancelled': {
          if (directive.requestId && directive.sessionId === activeViewSessionIdRef.current) {
            const current = pendingPermissionRequestsRef.current;
            const nextPendingPermissionRequests = current.filter(
              (request: PendingPermissionRequest) => request.requestId !== directive.requestId,
            );

            if (nextPendingPermissionRequests.length !== current.length) {
              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          return;
        }
      }
    }

    return subscribe(handleEvent);
  }, [
    t,
    sendMessage,
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
