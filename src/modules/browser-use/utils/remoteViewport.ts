/**
 * Maps a tap/click on the scaled screenshot back to the real browser viewport
 * coordinates. Returns null when the tap cannot be mapped (no viewport known,
 * or the rendered image has no measurable size).
 */
export function toViewportPoint(
  pointer: { x: number; y: number },
  imageRect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number } | null,
): { x: number; y: number } | null {
  if (!viewport || imageRect.width <= 0 || imageRect.height <= 0) {
    return null;
  }

  const x = Math.round((pointer.x - imageRect.left) * (viewport.width / imageRect.width));
  const y = Math.round((pointer.y - imageRect.top) * (viewport.height / imageRect.height));
  return {
    x: Math.min(Math.max(x, 0), viewport.width - 1),
    y: Math.min(Math.max(y, 0), viewport.height - 1),
  };
}

/**
 * Converts a touch drag into scroll wheel deltas. The finger drags the content,
 * so the wheel direction is inverted: dragging down (end.y > start.y) scrolls
 * the page up with a negative deltaY.
 */
export function toScrollDelta(
  start: { x: number; y: number },
  end: { x: number; y: number },
): { deltaX: number; deltaY: number } {
  return {
    deltaX: -(end.x - start.x),
    deltaY: -(end.y - start.y),
  };
}
