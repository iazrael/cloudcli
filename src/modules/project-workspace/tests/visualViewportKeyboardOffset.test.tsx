import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useVisualViewportKeyboardOffset } from '@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset';

/**
 * Regression guards for the blank-band bug: the workspace shell lifts its
 * bottom edge by `--keyboard-height`, so a stale non-zero value (iOS hides the
 * keyboard without a final visualViewport resize on tab switches and IME
 * changes) leaves half the screen blank under the composer.
 */

const LAYOUT_HEIGHT = 900;

class FakeVisualViewport extends EventTarget {
  height = LAYOUT_HEIGHT;
  offsetTop = 0;
}

function readKeyboardVar(): string {
  return document.documentElement.style.getPropertyValue('--keyboard-height');
}

let viewport: FakeVisualViewport;

beforeEach(() => {
  vi.useFakeTimers();
  viewport = new FakeVisualViewport();
  Object.defineProperty(window, 'innerHeight', {
    value: LAYOUT_HEIGHT,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, 'visualViewport', {
    value: viewport,
    configurable: true,
    writable: true,
  });
  document.documentElement.style.removeProperty('--keyboard-height');
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.style.removeProperty('--keyboard-height');
});

test('resize shrinking the visual viewport records the keyboard height', () => {
  renderHook(() => useVisualViewportKeyboardOffset());
  assert.equal(readKeyboardVar(), '0px');

  act(() => {
    viewport.height = LAYOUT_HEIGHT - 350;
    viewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(readKeyboardVar(), '350px');
});

test('a restored visual viewport clears the offset to zero', () => {
  renderHook(() => useVisualViewportKeyboardOffset());

  act(() => {
    viewport.height = LAYOUT_HEIGHT - 350;
    viewport.dispatchEvent(new Event('resize'));
  });
  act(() => {
    viewport.height = LAYOUT_HEIGHT;
    viewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(readKeyboardVar(), '0px');
});

test('focusout re-syncs even when iOS never fires the closing resize', () => {
  renderHook(() => useVisualViewportKeyboardOffset());

  act(() => {
    viewport.height = LAYOUT_HEIGHT - 350;
    viewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(readKeyboardVar(), '350px');

  // Keyboard closes silently: geometry changes but no visualViewport event.
  viewport.height = LAYOUT_HEIGHT;
  act(() => {
    document.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(500);
  });
  assert.equal(readKeyboardVar(), '0px');
});

test('small viewport differences below the keyboard threshold stay zero', () => {
  renderHook(() => useVisualViewportKeyboardOffset());

  act(() => {
    viewport.height = LAYOUT_HEIGHT - 100;
    viewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(readKeyboardVar(), '0px');
});

test('scrolled visual viewport offset does not count as keyboard height', () => {
  renderHook(() => useVisualViewportKeyboardOffset());

  act(() => {
    viewport.height = LAYOUT_HEIGHT - 200;
    viewport.offsetTop = 200;
    viewport.dispatchEvent(new Event('scroll'));
  });
  assert.equal(readKeyboardVar(), '0px');

  act(() => {
    viewport.height = LAYOUT_HEIGHT - 350;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(readKeyboardVar(), '350px');
});
