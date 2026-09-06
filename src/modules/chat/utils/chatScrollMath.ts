/**
 * Pure arithmetic behind the chat scroll layer. Extracted so the behavior
 * contract tests (tests/chatScrollStability.test.ts) pin these exact formulas
 * instead of re-implementations; DOM and rAF orchestration stays in the
 * hooks (useContinuousScrollAnchor, useChatSessionState), the only consumers.
 */

/** True when the viewport sits within `threshold` px of the container bottom. */
export function isNearBottom(
  geometry: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold: number,
): boolean {
  return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight <= threshold;
}

/**
 * scrollTop delta that keeps the viewport anchored over the same content when
 * older rows prepend above it. Callers apply the delta only when it is
 * positive: a non-positive diff means nothing was added, and native anchoring
 * already handles every prepend that did not land at scrollTop 0.
 */
export function prependScrollAdjustment(prevHeight: number, newHeight: number): number {
  return newHeight - prevHeight;
}

/** The tail slice of `messages` actually rendered into the pane. */
export function sliceVisibleMessages<T>(messages: T[], visibleCount: number): T[] {
  if (messages.length <= visibleCount) return messages;
  return messages.slice(-visibleCount);
}

/**
 * Window growth when rows append at the bottom while the user is scrolled up:
 * growing the window by the appended delta keeps the top-most visible row in
 * place instead of evicting it. An infinite window (load-all) stays infinite.
 */
export function expandVisibleCount(prevVisibleCount: number, appendedDelta: number): number {
  return prevVisibleCount === Infinity ? Infinity : prevVisibleCount + appendedDelta;
}
