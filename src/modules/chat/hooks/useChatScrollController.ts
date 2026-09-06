import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

import { useContinuousScrollAnchor } from '@/modules/chat/hooks/useContinuousScrollAnchor';

type RevealableRow = { timestamp: unknown };

type UseChatScrollControllerOptions = {
  isActive: boolean;
  hasMoreMessages: boolean;
  isLoadingMore: boolean;
  allMessagesLoaded: boolean;
  /** While the session's first page is loading there is nothing to stick to. */
  isLoadingSessionMessages: boolean;
  /** The initial stick re-runs as hydration grows the loaded row count. */
  messageCount: number;
  /** A search jump owns the viewport until its reveal settles. */
  searchScrollActiveRef: MutableRefObject<boolean>;
  /** Session-owned flag: the initial stick is armed for the next commits. */
  pendingInitialScrollRef: MutableRefObject<boolean>;
  /** The pane's content wrapper, whose growth the stick-to-bottom observer tracks. */
  scrollContentRef: MutableRefObject<HTMLDivElement | null>;
  onLoadOlder: (container: HTMLDivElement) => Promise<boolean | void>;
  onNearTop?: (nearTop: boolean) => void;
};

/**
 * Locates a row wrapper by timestamp (exact match, then nearest) — the
 * `LazyMessageRow` wrapper stays in the DOM with the attribute even while its
 * content is an unmounted placeholder.
 */
function findMessageRow(container: HTMLElement, message: RevealableRow): Element | null {
  const timestamp = typeof message.timestamp === 'string' ? message.timestamp : '';
  if (!timestamp) return null;

  const exact = container.querySelector(`[data-message-timestamp="${CSS.escape(timestamp)}"]`);
  if (exact) return exact;

  const targetTime = new Date(timestamp).getTime();
  if (!Number.isFinite(targetTime)) return null;

  let nearest: Element | null = null;
  let nearestDistance = Infinity;
  for (const row of container.querySelectorAll('[data-message-timestamp]')) {
    const rowTime = new Date(row.getAttribute('data-message-timestamp') || '').getTime();
    if (!Number.isFinite(rowTime)) continue;
    const distance = Math.abs(rowTime - targetTime);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = row;
    }
  }
  return nearest;
}

/**
 * The one owner of chat scroll *mechanics*. `useContinuousScrollAnchor` is
 * the engine (native scroll listener, pin state, ResizeObserver stick-to-
 * bottom, top paging); this controller composes it with the frame-level
 * behaviors — the initial bottom-stick, settled sticking after sends and
 * refreshes, and the search-jump reveal. Intents that mix scroll with
 * pagination (scroll-to-bottom-and-reset, window expansion) stay with the
 * pagination state in `useChatSessionState`.
 *
 * Gates the perf harnesses pin: the 60px bottom threshold, the top
 * hysteresis + 150ms chain, one state write per scroll event.
 */
export function useChatScrollController({
  isActive,
  hasMoreMessages,
  isLoadingMore,
  allMessagesLoaded,
  isLoadingSessionMessages,
  messageCount,
  searchScrollActiveRef,
  pendingInitialScrollRef,
  scrollContentRef,
  onLoadOlder,
  onNearTop,
}: UseChatScrollControllerOptions) {
  const {
    scrollContainerRef,
    isUserScrolledUp,
    setIsUserScrolledUp,
    isPinnedToBottomRef,
    isNearBottom,
    scrollToBottom,
    notifyPaneMounted,
    notifyContentMutating,
  } = useContinuousScrollAnchor({
    isActive,
    hasMoreMessages,
    isLoadingMore,
    allMessagesLoaded,
    onLoadOlder,
    scrollContentRef,
    onNearTop,
  });

  // Initial scroll to bottom — robust to lazy content reflow, but yields the
  // moment the user scrolls up (isPinnedToBottomRef flips) so it can never
  // fight the user for the viewport during the first second. Reset paths arm
  // `pendingInitialScrollRef`; the run ends once heights stop changing.
  useEffect(() => {
    if (!isActive) return;
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    if (messageCount === 0) { pendingInitialScrollRef.current = false; return; }
    if (searchScrollActiveRef.current) { pendingInitialScrollRef.current = false; return; }

    const container = scrollContainerRef.current;
    let frame = 0;
    let lastHeight = 0;
    let stableCount = 0;
    let rafId = 0;

    const tick = () => {
      if (!pendingInitialScrollRef.current || !scrollContainerRef.current) return;
      if (!isPinnedToBottomRef.current) {
        pendingInitialScrollRef.current = false;
        return;
      }
      container.scrollTop = container.scrollHeight;
      if (container.scrollHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = container.scrollHeight;
      }
      frame++;
      if (stableCount < 3 && frame < 60) {
        rafId = requestAnimationFrame(tick);
      } else {
        pendingInitialScrollRef.current = false;
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [messageCount, isActive, isLoadingSessionMessages, isPinnedToBottomRef, scrollContainerRef, searchScrollActiveRef, pendingInitialScrollRef]);

  /**
   * Send / post-refresh sticking: scroll now, then re-stick after the commit
   * settles — deterministic instead of a blind delay racing content growth.
   * `scrollToBottom` already unpins, so callers owe nothing else.
   */
  const stickToBottomSettled = useCallback(() => {
    scrollToBottom();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      });
    });
  }, [scrollToBottom, scrollContainerRef]);

  /**
   * Reveals the search-jump hit: one commit to mount the window's rows, a
   * center scroll, a second pass after row heights settle from estimates to
   * real measurements, then the highlight flash. `onSettled` fires exactly
   * once — the jump releases the viewport there.
   */
  const revealMessageRow = useCallback((message: RevealableRow, onSettled: () => void) => {
    window.setTimeout(() => {
      const row = scrollContainerRef.current
        ? findMessageRow(scrollContainerRef.current, message)
        : null;
      if (!row || !scrollContainerRef.current) {
        onSettled();
        return;
      }
      row.scrollIntoView({ block: 'center' });
      window.setTimeout(() => {
        const container = scrollContainerRef.current;
        const settledRow = container ? findMessageRow(container, message) : null;
        const finalRow = settledRow ?? row;
        finalRow.scrollIntoView({ block: 'center' });
        finalRow.classList.add('search-highlight-flash');
        window.setTimeout(() => finalRow.classList.remove('search-highlight-flash'), 4000);
        onSettled();
      }, 300);
    }, 150);
  }, [scrollContainerRef]);

  return {
    scrollContainerRef,
    isUserScrolledUp,
    setIsUserScrolledUp,
    isPinnedToBottomRef,
    isNearBottom,
    scrollToBottom,
    notifyPaneMounted,
    notifyContentMutating,
    stickToBottomSettled,
    revealMessageRow,
  };
}
