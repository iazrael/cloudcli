import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import type { MarkSessionIdle, SessionActivityMap } from '@/shared/types';
import type { SessionSlot, SessionStore, NormalizedMessage } from '@/modules/chat/hooks/useSessionStore';
import { SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';
import type { Project, ProjectSession, LLMProvider } from '@/shared/types';
import { authenticatedFetch } from '@/shared/api';
import type { ChatMessage } from '@/shared/types';
import { createMessageHistoryRefreshCoordinator } from '@/modules/chat/utils/messageHistoryRefreshCoordinator';
import type { DiffCalculator } from '@/shared/types';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { useTranscriptViewport } from '@/modules/chat/hooks/useTranscriptViewport';
import { groupConsecutiveTools } from '@/modules/chat/utils/toolGrouping';
import { toTokenBudget } from '@/modules/chat/utils/contextUsage';
import { findSearchTargetIndex } from '@/modules/chat/utils/searchTargetLocator';

/** How long a search hit stays flashed after the jump lands. */
const SEARCH_HIGHLIGHT_DURATION_MS = 4000;

type UseChatSessionStateArgs = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  sessionStore: SessionStore;
  /** Grouping folds hidden reasoning rows away, so it decides the row count. */
  showThinking: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = {
    id,
    sessionId,
    timestamp: ts,
    provider,
    transcriptAnchorId: msg.transcriptAnchorId,
    replacesAnchorId: msg.replacesAnchorId,
  };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isInteractivePrompt) {
    return { ...base, kind: 'interactive_prompt', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its files immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
    files: Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  externalMessageUpdate,
  newSessionTrigger,
  processingSessions,
  onSessionIdle,
  resetStreamingState,
  statusCheckSentAtRef,
  sessionStore,
  showThinking,
}: UseChatSessionStateArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, _setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);
  // Row a search jump landed on; cleared once its flash has run.
  const [highlightedItemIndex, setHighlightedItemIndex] = useState<number | null>(null);
  /**
   * Bumped whenever the transcript is replaced (session switch, New Session)
   * so the viewport re-arms its stick to the bottom.
   */
  const [viewportResetSignal, setViewportResetSignal] = useState(0);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> AppContent -> MainContent -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    resetStreamingState();
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setViewHiddenCount(0);
    setSearchTarget(null);
    setHighlightedItemIndex(null);
    searchScrollActiveRef.current = false;
    setViewportResetSignal((signal) => signal + 1);
    lastLoadedSessionKeyRef.current = null;
  }, [newSessionTrigger, onSessionIdle, resetStreamingState]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  const isActiveRef = useRef(isActive);
  const activeSessionIdRef = useRef(activeSessionId);
  isActiveRef.current = isActive;
  activeSessionIdRef.current = activeSessionId;

  /**
   * Single mirror point from a store slot into the view's pagination and
   * token-usage state. Every store response applied to the viewed session
   * funnels through here, so the local mirror and the slot can never drift
   * apart (a missed copy at any call site used to leave top loading gated on
   * a stale hasMore).
   */
  const syncPaginationFromSlot = useCallback((slot: SessionSlot) => {
    setHasMoreMessages(slot.hasMore);
    setTotalMessages(slot.total);
    if (slot.tokenUsage && typeof slot.tokenUsage === 'object') {
      setTokenBudget(toTokenBudget(slot.tokenUsage));
    }
  }, []);

  const latestRefreshExecutorRef = useRef<(sessionId: string) => Promise<boolean | void>>(
    async () => true,
  );
  latestRefreshExecutorRef.current = async (sessionId: string) => {
    const result = await sessionStore.refreshLatestFromServer(sessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === sessionId
      ),
    });
    const slot = result.slot;
    if (slot && activeSessionIdRef.current === sessionId) {
      syncPaginationFromSlot(slot);
    }
    return !result.deferred;
  };

  const refreshCoordinatorRef = useRef<ReturnType<typeof createMessageHistoryRefreshCoordinator> | null>(null);
  if (!refreshCoordinatorRef.current) {
    refreshCoordinatorRef.current = createMessageHistoryRefreshCoordinator(
      (sessionId) => latestRefreshExecutorRef.current(sessionId),
      (sessionId) => isActiveRef.current && activeSessionIdRef.current === sessionId,
    );
  }

  const requestLatestMessages = useCallback((sessionId: string, allowNetwork = isActiveRef.current) => (
    refreshCoordinatorRef.current?.request(sessionId, allowNetwork) ?? Promise.resolve()
  ), []);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Hidden Chat tabs keep collecting realtime rows without re-rendering the
  // CSS-hidden tree. Activation itself renders once and reads the latest cache.
  const activeSessionForStore = isActive ? activeSessionId : null;
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionForStore !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionForStore;
    sessionStore.setActiveSession(activeSessionForStore);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : [];

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    if (viewHiddenCount > 0 && viewHiddenCount < all.length) return all.slice(0, -viewHiddenCount);
    return all;
  }, [storeMessages, viewHiddenCount, pendingUserMessage]);

  /* ---------------------------------------------------------------- */
  /*  addMessage / clearMessages / rewindMessages                     */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  const loadOlderMessages = useCallback(
    async () => {
      if (!isActive) return false;
      if (isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;

      try {
        const result = await sessionStore.fetchMore(selectedSession.id, {
          limit: SESSION_MESSAGES_PAGE_SIZE,
          canRequest: () => (
            isActiveRef.current
            && activeSessionIdRef.current === selectedSession.id
          ),
        });
        const { slot, prependedCount } = result;
        syncPaginationFromSlot(slot);

        if (!slot.hasMore) {
          allMessagesLoadedRef.current = true;
          setAllMessagesLoaded(true);
        }
        return prependedCount > 0;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [hasMoreMessages, isActive, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore],
  );

  /**
   * The rows the transcript actually renders. Grouping lives here rather than
   * in the pane because the virtualizer addresses rows by index — the row
   * count and every index (search jumps, sticking to the tail) must come from
   * the same list the pane renders.
   */
  const transcriptItems = useMemo(
    () => groupConsecutiveTools(chatMessages, showThinking),
    [chatMessages, showThinking],
  );

  /**
   * Bumps whenever the tail grows, including while the last row is still
   * streaming and the row count is unchanged.
   */
  const tailSignal = useMemo(() => {
    const lastMessage = chatMessages[chatMessages.length - 1];
    return chatMessages.length * 1e6 + (lastMessage?.content?.length ?? 0);
  }, [chatMessages]);

  const {
    scrollRef,
    virtualizerRef,
    isUserScrolledUp,
    shiftOnPrepend,
    handleScroll,
    stickToBottom,
    scrollToRow,
  } = useTranscriptViewport({
    isActive,
    hasMoreMessages,
    allMessagesLoaded,
    tailSignal,
    rowCount: transcriptItems.length,
    onLoadOlder: loadOlderMessages,
    resetSignal: viewportResetSignal,
  });

  // Reset scroll state on session change. A search jump owns the viewport, so
  // it must not be overridden by the initial bottom stick.
  useEffect(() => {
    if (!searchScrollActiveRef.current) {
      setViewportResetSignal((signal) => signal + 1);
    }
  }, [selectedProject?.projectId, selectedSession?.id]);


  // Session replay/subscription remains active regardless of which main tab is
  // visible. Only persisted-history HTTP traffic is visibility-gated below.
  useEffect(() => {
    if (!selectedSession || !selectedProject || !ws) return;

    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: sessionStore.getResumeSeq(selectedSession.id),
      }],
    });
  }, [selectedProject, selectedSession, sendMessage, sessionStore, statusCheckSentAtRef, ws]);

  // Main session loading effect — store-based
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it.
      if (currentSessionId && processingSessionsRef.current?.has(currentSessionId)) {
        return;
      }

      resetStreamingState();
      setCurrentSessionId(null);
        setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    if (!isActive) {
      setIsLoadingSessionMessages(false);
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const existingSlot = sessionStore.getSessionSlot(selectedSessionId);
    const isCurrentHydratedSession =
      lastLoadedSessionKeyRef.current === sessionKey
      && Boolean(existingSlot?.fetchedAt);

    // Returning from another tab must not reset pagination or scroll. Refresh
    // a stale hydrated session through the bounded tail path instead.
    if (isCurrentHydratedSession) {
      if (sessionStore.isStale(selectedSessionId)) {
        void requestLatestMessages(selectedSessionId);
      }
      return;
    }

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;

    // Reset pagination/scroll state. Stream buffers are NOT reset here: they
    // are per session now, and clearing them on switch would discard the
    // in-flight prefix of a run still streaming in another session.
    setHasMoreMessages(false);
    setTotalMessages(0);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setViewHiddenCount(0);
    setHighlightedItemIndex(null);
    setViewportResetSignal((signal) => signal + 1);

    if (sessionChanged) {
      setTokenBudget(null);
    }

    setCurrentSessionId(selectedSessionId);

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      offset: 0,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === selectedSessionId
      ),
    }).then(slot => {
      if (slot) {
        syncPaginationFromSlot(slot);
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      setIsLoadingSessionMessages(false);
    });
  }, [
    isActive,
    requestLatestMessages,
    selectedProject,
    selectedSession?.id,
    sessionStore,
  ]);

  // Hidden refresh signals are coalesced. An initial page load supersedes a
  // pending latest refresh for an unhydrated/loading slot; otherwise activation
  // flushes exactly one request for the selected session.
  useEffect(() => {
    if (!isActive || !activeSessionId) return;

    const slot = sessionStore.getSessionSlot(activeSessionId);
    if (!slot?.fetchedAt || slot.status === 'loading') {
      refreshCoordinatorRef.current?.discardPending(activeSessionId);
      return;
    }

    void refreshCoordinatorRef.current?.flushPending(activeSessionId);
  }, [activeSessionId, isActive, sessionStore]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isProcessing) {
          // Sticking is the viewport's default while pinned; a refresh that
          // replaces the tail needs no separate scroll choreography.
          await requestLatestMessages(selectedSession.id);
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    requestLatestMessages,
    selectedProject,
    selectedSession,
    isProcessing,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!isActive || !searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const scrollToTarget = async () => {
      // The sidebar can point anywhere in the transcript. Hydrate the full
      // history into the store first, but render only the window that covers
      // the hit — committing the whole transcript to reach one row was the
      // most expensive thing the pane could do.
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
        try {
          const slot = await sessionStore.fetchFromServer(selectedSession.id, {
            limit: null,
            offset: 0,
            canRequest: () => (
              isActiveRef.current
              && activeSessionIdRef.current === selectedSession.id
            ),
          });
          if (slot) {
            syncPaginationFromSlot(slot);
            setAllMessagesLoaded(true);
            allMessagesLoadedRef.current = true;
          } else if (!isActiveRef.current) {
            setSearchTarget(target);
            return;
          }
        } catch {
          // Fall through and search the messages already loaded.
        }
      }

      // chatMessages in this closure predates the hydration above; re-derive
      // from the store so the locator sees the full transcript.
      const sessionId = selectedSession?.id;
      if (!sessionId) {
        searchScrollActiveRef.current = false;
        return;
      }
      const messages = normalizedToChatMessages(sessionStore.getMessages(sessionId));
      const items = groupConsecutiveTools(messages, showThinking);
      const targetIndex = findSearchTargetIndex(items, target);
      if (targetIndex < 0) {
        // A miss is knowable from the data: decline instead of the old
        // retry loop that eventually gave up silently.
        searchScrollActiveRef.current = false;
        return;
      }

      // The whole reveal is one index-addressed scroll: the virtualizer mounts
      // and measures whatever rows that offset needs. No DOM lookup, no
      // double-centering pass, no settle delay.
      scrollToRow(targetIndex);
      setHighlightedItemIndex(targetIndex);
      searchScrollActiveRef.current = false;
      window.setTimeout(() => setHighlightedItemIndex(null), SEARCH_HIGHLIGHT_DURATION_MS);
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isActive, isLoadingSessionMessages, searchTarget]);

  const refreshTokenUsage = useCallback(async (sessionIdToFetch?: string) => {
    const sid = sessionIdToFetch || activeSessionIdRef.current;
    if (!sid) {
      setTokenBudget(null);
      return;
    }
    try {
      const url = `/api/providers/sessions/${encodeURIComponent(sid)}/token-usage`;
      const response = await authenticatedFetch(url);
      if (response.ok && activeSessionIdRef.current === sid) {
        const payload = await response.json();
        if (payload.data && typeof payload.data === 'object' && activeSessionIdRef.current === sid) {
          const nextData = payload.data as Record<string, unknown>;
          const nextBudget = toTokenBudget(nextData);
          if (nextData.compacted === true) {
            // No occupancy until the next turn; only the summary size is known.
            setTokenBudget(nextBudget);
            return;
          }
          const nextUsed = Number(nextData.used ?? 0)
            || (Number(nextData.inputTokens ?? 0) + Number(nextData.outputTokens ?? 0));
          setTokenBudget((prev) => {
            const currentUsed = Number((prev as Record<string, unknown> | null)?.used ?? 0);
            if (nextUsed === 0 && currentUsed > 0) {
              return prev;
            }
            return nextBudget;
          });
        }
      }
    } catch (error) {
      console.error('Failed to fetch token usage:', error);
    }
  }, []);

  // Initial token usage fetch whenever active session id changes
  useEffect(() => {
    if (!activeSessionId) {
      setTokenBudget(null);
      return;
    }
    void refreshTokenUsage(activeSessionId);
  }, [activeSessionId, refreshTokenUsage]);

  // Refresh token usage automatically when a turn finishes processing within the same session
  const lastProcessedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (isProcessing) {
      lastProcessedSessionIdRef.current = activeSessionId;
    } else if (lastProcessedSessionIdRef.current) {
      const finishedSessionId = lastProcessedSessionIdRef.current;
      lastProcessedSessionIdRef.current = null;
      if (finishedSessionId === activeSessionId) {
        void refreshTokenUsage(finishedSessionId);
      }
    }
  }, [isProcessing, activeSessionId, refreshTokenUsage]);

  /**
   * Hydrates the entire transcript in one request. Only the search jump needs
   * this now: with rows virtualized, holding the whole history costs memory in
   * the store but nothing in the DOM, so there is no user-facing "load all"
   * affordance to drive it any more.
   */
  const loadAllMessages = useCallback(async () => {
    if (!isActive) return;
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        limit: null,
        offset: 0,
        canRequest: () => (
          isActiveRef.current
          && activeSessionIdRef.current === requestSessionId
        ),
      });

      if (currentSessionId !== requestSessionId) return;

      if (slot) {
        syncPaginationFromSlot(slot);
        setAllMessagesLoaded(true);
      } else {
        allMessagesLoadedRef.current = false;
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [currentSessionId, isActive, isLoadingAllMessages, selectedProject, selectedSession, sessionStore]);

  return {
    chatMessages,
    addMessage,
    rewindMessages,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    refreshTokenUsage,
    transcriptItems,
    highlightedItemIndex,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    createDiff,
    scrollRef,
    virtualizerRef,
    shiftOnPrepend,
    handleScroll,
    stickToBottom,
    requestLatestMessages,
  };
}
