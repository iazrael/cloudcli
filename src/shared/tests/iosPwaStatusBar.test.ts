import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { setupIosPwaStatusBar } from '@/shared/iosPwaStatusBar';

let strip: HTMLDivElement;
let dispose: (() => void) | undefined;
let visibility: DocumentVisibilityState;
let standalone: boolean;
let supportsTouchCallout: boolean;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  visibility = 'visible';
  standalone = true;
  supportsTouchCallout = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.stubGlobal('CSS', { supports: () => supportsTouchCallout });
  const matchMedia = window.matchMedia;
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    ...matchMedia(query),
    matches: query === '(display-mode: standalone)' && standalone,
  }));
  strip = document.createElement('div');
  strip.className = 'ios-pwa-status-strip';
  document.body.append(strip);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  strip.remove();
  Reflect.deleteProperty(navigator, 'standalone');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectStripToReturnToTop() {
  vi.advanceTimersToNextFrame();
  expect(Number.parseFloat(strip.style.top)).toBeGreaterThan(4);
  vi.advanceTimersToNextFrame();
  expect(strip.style.top).toBe('');
}

test('presents the strip to WebKit on launch and when returning to the foreground', () => {
  dispose = setupIosPwaStatusBar();
  expectStripToReturnToTop();

  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  vi.advanceTimersToNextFrame();
  expect(strip.style.top).toBe('');

  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  expectStripToReturnToTop();
});

test('refreshes after page restoration and coalesces overlapping resume events', () => {
  dispose = setupIosPwaStatusBar();
  expectStripToReturnToTop();

  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  vi.advanceTimersToNextFrame();
  expect(Number.parseFloat(strip.style.top)).toBeGreaterThan(4);
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersToNextFrame();
  expect(strip.style.top).toBe('');
  expect(vi.getTimerCount()).toBe(0);
});

test('restores the strip before the next resume if the app hides during a refresh', () => {
  dispose = setupIosPwaStatusBar();
  vi.advanceTimersToNextFrame();
  expect(Number.parseFloat(strip.style.top)).toBeGreaterThan(4);

  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  expect(strip.style.top).toBe('');
  expect(vi.getTimerCount()).toBe(0);

  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  expectStripToReturnToTop();
});

test('honors the iOS standalone flag when the display-mode query does not match', () => {
  standalone = false;
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  dispose = setupIosPwaStatusBar();
  expectStripToReturnToTop();
});

test.each([
  { standalone: false, supportsTouchCallout: true },
  { standalone: true, supportsTouchCallout: false },
])('leaves the strip inactive outside installed iOS web apps (%o)', (mode) => {
  standalone = mode.standalone;
  supportsTouchCallout = mode.supportsTouchCallout;
  dispose = setupIosPwaStatusBar();
  window.dispatchEvent(new Event('pageshow'));
  document.dispatchEvent(new Event('visibilitychange'));
  expect(strip.classList.contains('is-active')).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
