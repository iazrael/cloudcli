/**
 * Pure decision helpers for the edge-swipe-to-open-sidebar gesture.
 * Consumed by useSidebarSwipeToOpen; kept separate so the thresholds are unit-testable
 * without a touch environment.
 */

/** Horizontal distance from the left screen edge (plus safe-area inset) where a swipe may start. */
export const SWIPE_EDGE_ZONE_PX = 24;

/** Drag progress (0-1 of drawer width) required to snap open on release without a flick. */
export const SWIPE_OPEN_THRESHOLD = 0.35;

/** Rightward release velocity (px/ms) that opens the drawer regardless of progress. */
export const SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.5;

/** |dx| must exceed |dy| by this ratio to lock the gesture as horizontal. */
export const SWIPE_DIRECTION_LOCK_RATIO = 1.2;

/** Minimum horizontal travel (px) before the direction lock is decided. */
export const SWIPE_MIN_TRAVEL_PX = 8;

/** Whether a touch starting at `clientX` counts as a left-edge origin. */
export function isSwipeEdgeOrigin(clientX: number, safeAreaLeftPx: number): boolean {
  return clientX <= SWIPE_EDGE_ZONE_PX + safeAreaLeftPx;
}

/** Whether the touch started inside a modal overlay (all modals share Dialog's role="dialog"), which must not trigger the gesture. */
export function isSwipeInsideOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="dialog"]') !== null;
}

export type SwipeDirectionLock = 'undecided' | 'horizontal' | 'vertical' | 'cancelled';

/**
 * Decide the gesture direction once travel passes the minimum threshold.
 * `horizontal` means rightward (opens the left drawer); a dominant leftward
 * travel cancels the gesture instead of opening it.
 */
export function lockSwipeDirection(
  start: { x: number; y: number },
  current: { x: number; y: number },
): SwipeDirectionLock {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  if (Math.abs(dx) < SWIPE_MIN_TRAVEL_PX && Math.abs(dy) < SWIPE_MIN_TRAVEL_PX) {
    return 'undecided';
  }
  if (Math.abs(dx) > Math.abs(dy) * SWIPE_DIRECTION_LOCK_RATIO) {
    return dx > 0 ? 'horizontal' : 'cancelled';
  }
  if (Math.abs(dy) > Math.abs(dx) * SWIPE_DIRECTION_LOCK_RATIO) {
    return 'vertical';
  }
  return 'undecided';
}

/** Drag progress (0-1) of a rightward `dx` relative to the drawer width. */
export function computeSwipeProgress(dx: number, drawerWidthPx: number): number {
  if (drawerWidthPx <= 0 || dx <= 0) {
    return 0;
  }
  return Math.min(1, dx / drawerWidthPx);
}

/** Whether releasing at `progress` with `velocityPxPerMs` (positive = rightward) should open the drawer. */
export function shouldOpenOnRelease(progress: number, velocityPxPerMs: number): boolean {
  return progress >= SWIPE_OPEN_THRESHOLD || velocityPxPerMs >= SWIPE_FLICK_VELOCITY_PX_PER_MS;
}
