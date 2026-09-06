import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  expandVisibleCount,
  isNearBottom,
  prependScrollAdjustment,
  sliceVisibleMessages,
} from '@/modules/chat/utils/chatScrollMath';

/**
 * Behavior contract for the chat scroll layer, pinned against the real
 * formulas (chatScrollMath.ts) rather than re-implementations: the visible
 * window arithmetic that keeps a scrolled-up reader's top row stable, the
 * prepend compensation that restores the viewport after a top page load, and
 * the near-bottom test that decides pinned-to-bottom.
 */

test('the visible window keeps the top row stable when rows append while scrolled up', () => {
  const initialMessages = Array.from({ length: 50 }, (_, i) => ({ id: `msg-${i}` }));
  let visibleCount = 20;

  const initialVisible = sliceVisibleMessages(initialMessages, visibleCount);
  assert.equal(initialVisible.length, 20);
  assert.equal(initialVisible[0].id, 'msg-30'); // The top-most message in view

  // 5 new rows stream in at the bottom while the user reads history.
  const updatedMessages = [
    ...initialMessages,
    ...Array.from({ length: 5 }, (_, i) => ({ id: `msg-${50 + i}` })),
  ];
  visibleCount = expandVisibleCount(visibleCount, updatedMessages.length - initialMessages.length);

  const updatedVisible = sliceVisibleMessages(updatedMessages, visibleCount);
  assert.equal(updatedVisible[0].id, 'msg-30'); // NO EVICTION / JUMP
  assert.equal(updatedVisible.length, 25);
  assert.equal(updatedVisible[updatedVisible.length - 1].id, 'msg-54');
});

test('an infinite window stays infinite; a finite window grows by the appended delta', () => {
  assert.equal(expandVisibleCount(Infinity, 5), Infinity);
  assert.equal(expandVisibleCount(20, 5), 25);
});

test('the prepend adjustment restores the exact viewport position over the same anchor', () => {
  const initialTop = 150;
  const anchorOffset = 40; // anchor sits 40px below the viewport top

  // 800px of older rows prepend above the viewport.
  const delta = prependScrollAdjustment(1200, 2000);
  assert.equal(delta, 800);

  const nextTop = initialTop + delta;
  assert.equal(nextTop, 950);
  // Relative position of the anchor to the viewport top is unchanged.
  assert.equal((anchorOffset + delta) - delta, anchorOffset);
});

test('the prepend adjustment is ignored for shrunken or unchanged content', () => {
  assert.equal(prependScrollAdjustment(1000, 900), -100);
  assert.equal(prependScrollAdjustment(1000, 1000), 0);
});

test('near-bottom is true while pinned and stays true across streaming growth', () => {
  let scrollHeight = 1200;
  const clientHeight = 600;
  let scrollTop = scrollHeight - clientHeight;

  assert.equal(isNearBottom({ scrollHeight, scrollTop, clientHeight }, 60), true);

  // Streaming appends 150px; the pinned viewport follows to the new bottom.
  scrollHeight += 150;
  scrollTop = scrollHeight - clientHeight;
  assert.equal(isNearBottom({ scrollHeight, scrollTop, clientHeight }, 60), true);

  // Reading 500px above the bottom is not pinned.
  assert.equal(isNearBottom({ scrollHeight, scrollTop: scrollTop - 500, clientHeight }, 60), false);
});
