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
let activeInputElement: HTMLInputElement | null = null;

function focusInput() {
  if (!activeInputElement) {
    activeInputElement = document.createElement('input');
    document.body.appendChild(activeInputElement);
  }
  activeInputElement.focus();
}

function blurInput() {
  if (activeInputElement) {
    activeInputElement.blur();
    if (activeInputElement.parentNode) {
      activeInputElement.parentNode.removeChild(activeInputElement);
    }
    activeInputElement = null;
  }
}

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
  focusInput();
});

afterEach(() => {
  vi.useRealTimers();
  blurInput();
  document.documentElement.style.removeProperty('--keyboard-height');
});

test('resize shrinking the visual viewport records the keyboard height when an input is focused', () => {
  renderHook(() => useVisualViewportKeyboardOffset());
  assert.equal(readKeyboardVar(), '0px');

  act(() => {
    viewport.height = LAYOUT_HEIGHT - 350;
    viewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(readKeyboardVar(), '350px');
});

test('viewport shrinking without any focused editable element stays zero (prevents page load blank bug)', () => {
  blurInput();
  renderHook(() => useVisualViewportKeyboardOffset());

  act(() => {
    viewport.height = LAYOUT_HEIGHT - 350;
    viewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(readKeyboardVar(), '0px');
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

test('focusout clears offset even when iOS never fires the closing resize', () => {
  renderHook(() => useVisualViewportKeyboardOffset());

  act(() => {
    viewport.height = LAYOUT_HEIGHT - 350;
    viewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(readKeyboardVar(), '350px');

  // Input blurs and keyboard closes silently: geometry stays unchanged or delayed.
  blurInput();
  act(() => {
    document.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(500);
  });
  assert.equal(readKeyboardVar(), '0px');
});

test('visibilitychange / pageshow clears stale offset when resuming without focus', () => {
  renderHook(() => useVisualViewportKeyboardOffset());

  act(() => {
    viewport.height = LAYOUT_HEIGHT - 350;
    viewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(readKeyboardVar(), '350px');

  // User switched to another app, iOS closed keyboard in background, resumed back
  blurInput();
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
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
