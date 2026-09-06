import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  SWIPE_EDGE_ZONE_PX,
  SWIPE_FLICK_VELOCITY_PX_PER_MS,
  SWIPE_MIN_TRAVEL_PX,
  SWIPE_OPEN_THRESHOLD,
  computeSwipeProgress,
  isSwipeEdgeOrigin,
  isSwipeInsideOverlay,
  lockSwipeDirection,
  shouldOpenOnRelease,
} from '@/modules/project-workspace/utils/sidebarSwipeGesture';

test('edge origin honors the safe-area inset on top of the base zone', () => {
  assert.equal(isSwipeEdgeOrigin(SWIPE_EDGE_ZONE_PX, 0), true);
  assert.equal(isSwipeEdgeOrigin(SWIPE_EDGE_ZONE_PX + 1, 0), false);
  assert.equal(isSwipeEdgeOrigin(SWIPE_EDGE_ZONE_PX + 40, 40), true);
  assert.equal(isSwipeEdgeOrigin(SWIPE_EDGE_ZONE_PX + 41, 40), false);
});

test('overlay-originated touches are excluded from the gesture', () => {
  const overlayChild = document.createElement('button');
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.appendChild(overlayChild);

  assert.equal(isSwipeInsideOverlay(overlayChild), true);
  assert.equal(isSwipeInsideOverlay(dialog), true);
  assert.equal(isSwipeInsideOverlay(document.createElement('div')), false);
  assert.equal(isSwipeInsideOverlay(null), false);
});

test('direction lock waits for minimum travel, then decides by the ratio', () => {
  const start = { x: 10, y: 100 };

  assert.equal(lockSwipeDirection(start, { x: 10 + SWIPE_MIN_TRAVEL_PX - 1, y: 100 }), 'undecided');

  assert.equal(
    lockSwipeDirection(start, { x: 10 + SWIPE_MIN_TRAVEL_PX * 3, y: 100 }),
    'horizontal',
  );
  assert.equal(
    lockSwipeDirection(start, { x: 10 - SWIPE_MIN_TRAVEL_PX * 3, y: 100 }),
    'cancelled',
  );
  assert.equal(
    lockSwipeDirection(start, { x: 10, y: 100 + SWIPE_MIN_TRAVEL_PX * 3 }),
    'vertical',
  );
  // Diagonal travel within the ratio stays undecided until one axis dominates.
  assert.equal(
    lockSwipeDirection(start, { x: 10 + SWIPE_MIN_TRAVEL_PX * 2, y: 100 + SWIPE_MIN_TRAVEL_PX * 2 }),
    'undecided',
  );
});

test('progress clamps rightward drag against the drawer width', () => {
  assert.equal(computeSwipeProgress(-20, 300), 0);
  assert.equal(computeSwipeProgress(30, 0), 0);
  assert.equal(computeSwipeProgress(150, 300), 0.5);
  assert.equal(computeSwipeProgress(500, 300), 1);
});

test('release opens at threshold progress or on a fast flick', () => {
  const thresholdProgress = SWIPE_OPEN_THRESHOLD;
  assert.equal(shouldOpenOnRelease(thresholdProgress, 0), true);
  assert.equal(shouldOpenOnRelease(thresholdProgress - 0.01, 0), false);
  assert.equal(shouldOpenOnRelease(0.1, SWIPE_FLICK_VELOCITY_PX_PER_MS), true);
  assert.equal(shouldOpenOnRelease(0.1, SWIPE_FLICK_VELOCITY_PX_PER_MS - 0.01), false);
  // Leftward release velocity never opens, even past the progress threshold start.
  assert.equal(shouldOpenOnRelease(0.1, -1), false);
});
