import { useCallback, useEffect, useRef, useState } from 'react';

export type UseContinuousScrollAnchorOptions = {
  isActive: boolean;
  hasMoreMessages: boolean;
  isLoadingMore: boolean;
  allMessagesLoaded: boolean;
  onLoadOlder: (container: HTMLDivElement) => Promise<boolean | void>;
  onNearTop?: (nearTop: boolean) => void;
  bottomThreshold?: number;
  topThreshold?: number;
  /**
   * The inner wrapper that grows/shrinks with message content. Observed with a
   * ResizeObserver so a pinned viewport stays glued to the bottom while
   * content streams in; the scroll container itself is observed too (its
   * content box changes when the bottom padding toggles with the activity bar).
   */
  scrollContentRef?: React.RefObject<HTMLElement | null>;
};

export type UseContinuousScrollAnchorReturn = {
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  isUserScrolledUp: boolean;
  setIsUserScrolledUp: React.Dispatch<React.SetStateAction<boolean>>;
  /**
   * Live pin state mirrored from scroll geometry. True while the viewport sits
   * within `bottomThreshold` of the bottom. Unlike `isUserScrolledUp`, this
   * never triggers a render, so long-running effects (e.g. the initial
   * scroll-to-bottom loop) can poll it and bail the moment the user scrolls up.
   */
  isPinnedToBottomRef: React.RefObject<boolean>;
  isNearBottom: () => boolean;
  scrollToBottom: (smooth?: boolean) => void;
  /** Invoked by the chat pane when its scroll container mounts/unmounts. */
  notifyPaneMounted: () => void;
  notifyContentMutating: () => void;
};

const DEFAULT_BOTTOM_THRESHOLD = 60;
const DEFAULT_TOP_THRESHOLD = 100;
/** Cooldown between chained top pages while the user stays parked at scrollTop≈0. */
const CHAIN_NEXT_PAGE_DELAY_MS = 150;

/**
 * Scroll stabilization for chat message lists, built on the browser's native
 * scroll anchoring instead of fighting it:
 *
 * 1. Native anchoring (overflow-anchor, left at its default) keeps the user's
 *    reading position stable whenever content above the viewport changes
 *    height (older messages prepended, images/code blocks finishing layout,
 *    content-visibility placeholders resolving to real heights).
 * 2. Stick-to-bottom: a ResizeObserver on the content wrapper re-pins the
 *    viewport to the bottom when content grows while the user is parked at the
 *    bottom. ResizeObserver callbacks run after layout but before paint, so
 *    streaming appends never flash a stale frame.
 * 3. The one case native anchoring refuses to handle is a prepend while
 *    scrollTop is exactly 0 (anchoring is boundary-suppressed there), so the
 *    load-older path applies an explicit height-diff compensation.
 */
export function useContinuousScrollAnchor({
  isActive,
  hasMoreMessages,
  isLoadingMore,
  allMessagesLoaded,
  onLoadOlder,
  onNearTop,
  bottomThreshold = DEFAULT_BOTTOM_THRESHOLD,
  topThreshold = DEFAULT_TOP_THRESHOLD,
  scrollContentRef,
}: UseContinuousScrollAnchorOptions): UseContinuousScrollAnchorReturn {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  // The chat pane mounts later than this hook's owner whenever ChatInterface
  // renders its "select a project" placeholder first. Listener/observer setup
  // re-runs when the pane reports itself mounted.
  const [paneMountedTick, setPaneMountedTick] = useState(0);
  const notifyPaneMounted = useCallback(() => {
    setPaneMountedTick((tick) => tick + 1);
  }, []);

  // Pin state maintained from scroll events without triggering renders. Only
  // a real flip of isUserScrolledUp (the scroll-to-bottom affordance) renders.
  const isPinnedToBottomRef = useRef(true);
  const isUserScrolledUpRef = useRef(false);

  // Expiry timestamp while a programmatic smooth scrollToBottom is in flight:
  // its own intermediate scroll events must not be mistaken for the user
  // scrolling up, but the guard self-clears so an interrupted animation can
  // never freeze the pin state.
  const smoothScrollUntilRef = useRef(0);

  // Momentum lock at the top to avoid thrashing load-older requests.
  const topBoundaryLockedRef = useRef(false);
  const wasNearTopRef = useRef(false);

  // Latest callbacks/flags kept in refs so `handleScroll` stays referentially
  // stable and the native scroll listener is attached exactly once.
  const isActiveRef = useRef(isActive);
  const onNearTopRef = useRef(onNearTop);
  const onLoadOlderRef = useRef(onLoadOlder);
  const loadStateRef = useRef({ hasMoreMessages, isLoadingMore, allMessagesLoaded });
  useEffect(() => {
    isActiveRef.current = isActive;
    onNearTopRef.current = onNearTop;
    onLoadOlderRef.current = onLoadOlder;
    loadStateRef.current = { hasMoreMessages, isLoadingMore, allMessagesLoaded };
  });

  const isNearBottom = useCallback((): boolean => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight <= bottomThreshold;
  }, [bottomThreshold]);

  const scrollToBottom = useCallback((smooth = false) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    isPinnedToBottomRef.current = true;
    smoothScrollUntilRef.current = smooth ? Date.now() + 800 : 0;
    if (isUserScrolledUpRef.current) {
      isUserScrolledUpRef.current = false;
      setIsUserScrolledUp(false);
    }
    if (smooth) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    } else {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  /**
   * Compensates a top prepend that landed while scrollTop was 0, where the
   * browser suppresses native anchoring. Called after the data mutation via
   * double-rAF so it measures the post-commit layout. The guard reads the
   * CURRENT scrollTop at execution time: if the user scrolled away during the
   * fetch, or anchoring already compensated (scrollTop > 1), the viewport is
   * not ours to move.
   */
  const stabilizeTopPrepend = useCallback((prevHeight: number) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (!container || container.scrollTop > 1) return;
        const heightDiff = container.scrollHeight - prevHeight;
        if (heightDiff > 0) {
          container.scrollTop += heightDiff;
        }
      });
    });
  }, []);

  // Top load handling with momentum lock. Extracted so the stay-at-top chain
  // below can re-enter it: after a prepend the viewport sits at scrollTop≈0,
  // where a further wheel-up produces no displacement and thus no scroll
  // event — the only signal left to load the next page is us.
  const attemptTopLoad = useCallback(function chainTopLoad() {
    const container = scrollContainerRef.current;
    if (!container) return;
    const loadState = loadStateRef.current;
    if (loadState.allMessagesLoaded || !loadState.hasMoreMessages || loadState.isLoadingMore) return;
    if (container.scrollTop >= topThreshold || topBoundaryLockedRef.current) return;

    topBoundaryLockedRef.current = true;
    const prevHeight = container.scrollHeight;

    // Compensate only when older rows actually prepended (the loader
    // resolves false for no-ops and failures, which need no adjustment).
    void Promise.resolve(onLoadOlderRef.current(container))
      .then((loaded) => {
        if (loaded) stabilizeTopPrepend(prevHeight);
        // Stay-at-top chain: the user is still parked at the absolute top and
        // asked for more history; keep paging until they scroll away, history
        // runs out, or a page grows the content enough to move them off 0.
        if (loaded && container.scrollTop <= 1) {
          window.setTimeout(() => {
            topBoundaryLockedRef.current = false;
            chainTopLoad();
          }, CHAIN_NEXT_PAGE_DELAY_MS);
        }
      })
      .catch(() => {
        // Load failures prepend nothing; no compensation. The lock releases
        // through the existing >20px hysteresis once the user scrolls down.
      });
  }, [stabilizeTopPrepend, topThreshold]);

  // Main scroll event handler — geometry reads only, one state write per flip.
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !isActiveRef.current) return;

    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <= bottomThreshold;

    if (Date.now() < smoothScrollUntilRef.current) {
      if (nearBottom) smoothScrollUntilRef.current = 0;
    } else {
      isPinnedToBottomRef.current = nearBottom;
    }
    const userUp = !isPinnedToBottomRef.current;
    if (isUserScrolledUpRef.current !== userUp) {
      isUserScrolledUpRef.current = userUp;
      setIsUserScrolledUp(userUp);
    }

    const scrolledNearTop = container.scrollTop < topThreshold;
    if (scrolledNearTop !== wasNearTopRef.current) {
      wasNearTopRef.current = scrolledNearTop;
      onNearTopRef.current?.(scrolledNearTop);
    }

    if (!scrolledNearTop) {
      topBoundaryLockedRef.current = false;
      return;
    }
    if (topBoundaryLockedRef.current) {
      // Hysteresis release: unlock once scrolled slightly down (> 20px);
      // the load itself fires on the next event back at the boundary.
      if (container.scrollTop > 20) {
        topBoundaryLockedRef.current = false;
      }
      return;
    }
    attemptTopLoad();
  }, [attemptTopLoad, bottomThreshold, topThreshold]);

  // Attach the native passive scroll listener exactly once per pane mount.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll, paneMountedTick]);

  // Stick-to-bottom: follow content growth only while pinned. While the user
  // is scrolled up, native anchoring keeps the reading position stable.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (!isActiveRef.current || !isPinnedToBottomRef.current) return;
      container.scrollTop = container.scrollHeight;
    });

    observer.observe(container);
    const content = scrollContentRef?.current;
    if (content && content !== container) {
      observer.observe(content);
    }

    return () => observer.disconnect();
  }, [paneMountedTick, scrollContentRef]);

  /**
   * Announces an imminent content mutation that prepends content while the
   * user sits at the very top (load-all, expand-visible-window), where native
   * anchoring is suppressed. A no-op everywhere else.
   */
  const notifyContentMutating = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || container.scrollTop > 1) return;
    stabilizeTopPrepend(container.scrollHeight);
  }, [stabilizeTopPrepend]);

  // External state resets (session switch, composer send) go through this so
  // the pin refs never desync from the React state. Refs are written
  // synchronously from the mirrored value, never from a state updater.
  const setUserScrolledUp = useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (action) => {
      const next = typeof action === 'function'
        ? (action as (current: boolean) => boolean)(isUserScrolledUpRef.current)
        : action;
      isUserScrolledUpRef.current = next;
      isPinnedToBottomRef.current = !next;
      setIsUserScrolledUp(next);
    },
    [],
  );

  return {
    scrollContainerRef,
    isUserScrolledUp,
    setIsUserScrolledUp: setUserScrolledUp,
    isPinnedToBottomRef,
    isNearBottom,
    scrollToBottom,
    notifyPaneMounted,
    notifyContentMutating,
  };
}
