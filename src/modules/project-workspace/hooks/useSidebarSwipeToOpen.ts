import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import {
  SWIPE_EDGE_ZONE_PX,
  computeSwipeProgress,
  isSwipeEdgeOrigin,
  isSwipeInsideOverlay,
  lockSwipeDirection,
  shouldOpenOnRelease,
} from '@/modules/project-workspace/utils/sidebarSwipeGesture';

/** Upper bound for env(safe-area-inset-left); anything past this is never a left-edge swipe. */
const MAX_SAFE_AREA_PX = 60;

/** Snap animation duration; matches the drawer's transition-transform duration-150 class. */
const SNAP_TRANSITION_CSS = '150ms ease-out';

/** Grace period covering the snap animation before inline styles are cleared. */
const SNAP_CLEANUP_DELAY_MS = 200;

/** Minimum interval between velocity samples taken during the drag. */
const VELOCITY_SAMPLE_INTERVAL_MS = 50;

type SwipeGestureState = {
  touchId: number | null;
  startX: number;
  startY: number;
  startTime: number;
  lastX: number;
  lastTime: number;
  drawerWidthPx: number;
  locked: boolean;
  cancelled: boolean;
};

function findTouch(touchList: TouchList, touchId: number): Touch | undefined {
  return Array.from(touchList).find((touch) => touch.identifier === touchId);
}

/**
 * env()/constant() custom properties are not resolved by getComputedStyle on :root,
 * so measure the real inset through a throwaway probe element's padding.
 */
function measureSafeAreaLeft(): number {
  const probe = document.createElement('div');
  probe.style.position = 'fixed';
  probe.style.visibility = 'hidden';
  probe.style.paddingLeft = 'var(--safe-area-inset-left, 0px)';
  document.body.appendChild(probe);
  const px = Number.parseFloat(window.getComputedStyle(probe).paddingLeft);
  probe.remove();
  return Number.isFinite(px) ? px : 0;
}

type UseSidebarSwipeToOpenParams = {
  /** Only attach listeners while the mobile drawer is closed; swipe must never fight the open drawer. */
  enabled: boolean;
  onOpen: () => void;
  containerRef: RefObject<HTMLDivElement | null>;
  backdropRef: RefObject<HTMLButtonElement | null>;
  drawerRef: RefObject<HTMLDivElement | null>;
};

/**
 * Left-edge swipe-to-open gesture for the mobile sidebar drawer.
 *
 * Drag progress is applied imperatively (refs, zero React state) so a 60fps gesture
 * never re-renders the sidebar tree; React state is only touched once, via onOpen,
 * after the release decision. Listeners live on window: touches inside the open
 * drawer never reach it because the drawer panel stops touch propagation.
 */
export function useSidebarSwipeToOpen({
  enabled,
  onOpen,
  containerRef,
  backdropRef,
  drawerRef,
}: UseSidebarSwipeToOpenParams): void {
  // Per-gesture bookkeeping lives in a ref: it mutates at touch frequency and must not trigger renders.
  const gestureRef = useRef<SwipeGestureState>({
    touchId: null,
    startX: 0,
    startY: 0,
    startTime: 0,
    lastX: 0,
    lastTime: 0,
    drawerWidthPx: 0,
    locked: false,
    cancelled: false,
  });
  const cleanupTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const resetInlineStyles = () => {
      const panel = drawerRef.current;
      const backdrop = backdropRef.current;
      const container = containerRef.current;
      if (panel) {
        panel.style.transition = '';
        panel.style.transform = '';
      }
      if (backdrop) {
        backdrop.style.transition = '';
        backdrop.style.opacity = '';
      }
      if (container) {
        container.style.visibility = '';
        container.style.opacity = '';
      }
    };

    /** Drop any in-flight gesture and clear drag styles; safe to call when no gesture is active. */
    const teardownGesture = () => {
      gestureRef.current.touchId = null;
      resetInlineStyles();
    };

    const applyProgress = (progress: number) => {
      const panel = drawerRef.current;
      const backdrop = backdropRef.current;
      const container = containerRef.current;
      if (!panel || !backdrop || !container) {
        return;
      }
      container.style.visibility = 'visible';
      container.style.opacity = '1';
      panel.style.transition = 'none';
      backdrop.style.transition = 'none';
      panel.style.transform = `translateX(${(progress - 1) * 100}%)`;
      // backdrop is bg-background/60, so element opacity 1 is the intended final look.
      backdrop.style.opacity = String(progress);
    };

    const finishGesture = (open: boolean) => {
      const panel = drawerRef.current;
      const backdrop = backdropRef.current;
      const container = containerRef.current;
      if (!panel || !backdrop || !container) {
        if (open) {
          onOpen();
        }
        return;
      }
      panel.style.transition = `transform ${SNAP_TRANSITION_CSS}`;
      backdrop.style.transition = `opacity ${SNAP_TRANSITION_CSS}`;
      container.style.visibility = 'visible';
      container.style.opacity = open ? '1' : '0';
      panel.style.transform = open ? 'translateX(0)' : 'translateX(-100%)';
      backdrop.style.opacity = open ? '1' : '0';
      if (open) {
        onOpen();
      }
      cleanupTimerRef.current = window.setTimeout(() => {
        cleanupTimerRef.current = null;
        resetInlineStyles();
      }, SNAP_CLEANUP_DELAY_MS);
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return;
      }
      const [touch] = event.touches;
      if (!touch || touch.clientX > SWIPE_EDGE_ZONE_PX + MAX_SAFE_AREA_PX) {
        return;
      }
      if (isSwipeInsideOverlay(event.target)) {
        return;
      }
      if (!isSwipeEdgeOrigin(touch.clientX, measureSafeAreaLeft())) {
        return;
      }
      const state = gestureRef.current;
      const panel = drawerRef.current;
      state.touchId = touch.identifier;
      state.startX = touch.clientX;
      state.startY = touch.clientY;
      state.startTime = event.timeStamp;
      state.lastX = touch.clientX;
      state.lastTime = event.timeStamp;
      state.drawerWidthPx = panel ? panel.getBoundingClientRect().width : 0;
      state.locked = false;
      state.cancelled = false;
    };

    const handleTouchMove = (event: TouchEvent) => {
      const state = gestureRef.current;
      if (state.touchId === null || state.cancelled) {
        return;
      }
      const touch = findTouch(event.touches, state.touchId);
      if (!touch) {
        return;
      }
      if (!state.locked) {
        const lock = lockSwipeDirection(
          { x: state.startX, y: state.startY },
          { x: touch.clientX, y: touch.clientY },
        );
        if (lock === 'vertical' || lock === 'cancelled') {
          state.cancelled = true;
          return;
        }
        if (lock !== 'horizontal') {
          return;
        }
        if (state.drawerWidthPx <= 0) {
          state.cancelled = true;
          return;
        }
        state.locked = true;
        state.lastX = state.startX;
        state.lastTime = state.startTime;
      }
      event.preventDefault();
      applyProgress(computeSwipeProgress(touch.clientX - state.startX, state.drawerWidthPx));
      if (event.timeStamp - state.lastTime >= VELOCITY_SAMPLE_INTERVAL_MS) {
        state.lastX = touch.clientX;
        state.lastTime = event.timeStamp;
      }
    };

    const handleTouchEnd = (event: TouchEvent, allowOpen: boolean) => {
      const state = gestureRef.current;
      if (state.touchId === null) {
        return;
      }
      const ended = findTouch(event.changedTouches, state.touchId);
      if (!ended) {
        return;
      }
      const locked = state.locked;
      state.touchId = null;
      if (!locked) {
        return;
      }
      const dtMs = Math.max(1, event.timeStamp - state.lastTime);
      const velocity = (ended.clientX - state.lastX) / dtMs;
      const progress = computeSwipeProgress(ended.clientX - state.startX, state.drawerWidthPx);
      finishGesture(allowOpen && shouldOpenOnRelease(progress, velocity));
    };

    const handleTouchEndEvent = (event: TouchEvent) => handleTouchEnd(event, true);
    const handleTouchCancelEvent = (event: TouchEvent) => handleTouchEnd(event, false);

    window.addEventListener('touchstart', handleTouchStart);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEndEvent);
    window.addEventListener('touchcancel', handleTouchCancelEvent);

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEndEvent);
      window.removeEventListener('touchcancel', handleTouchCancelEvent);
      if (cleanupTimerRef.current !== null) {
        window.clearTimeout(cleanupTimerRef.current);
        cleanupTimerRef.current = null;
      }
      // Never leave inline drag styles behind if the effect tears down mid-gesture.
      teardownGesture();
    };
  }, [enabled, onOpen, containerRef, backdropRef, drawerRef]);
}
