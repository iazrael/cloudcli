import { describe, expect, it } from 'vitest';

import { toScrollDelta, toViewportPoint } from '@/modules/browser-use/utils/remoteViewport';

describe('toViewportPoint', () => {
  const viewport = { width: 1024, height: 768 };
  const rect = { left: 10, top: 20, width: 512, height: 384 };

  it('scales displayed-image coordinates up to the real viewport', () => {
    expect(toViewportPoint({ x: 10, y: 20 }, rect, viewport)).toEqual({ x: 0, y: 0 });
    expect(toViewportPoint({ x: 266, y: 212 }, rect, viewport)).toEqual({ x: 512, y: 384 });
  });

  it('clamps taps that land slightly outside the rendered image', () => {
    expect(toViewportPoint({ x: 0, y: 500 }, rect, viewport)).toEqual({ x: 0, y: 767 });
    expect(toViewportPoint({ x: 600, y: 100 }, rect, viewport)).toEqual({ x: 1023, y: 160 });
  });

  it('returns null without a viewport or an empty rect', () => {
    expect(toViewportPoint({ x: 0, y: 0 }, rect, null)).toBeNull();
    expect(toViewportPoint({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 0 }, viewport)).toBeNull();
  });
});

describe('toScrollDelta', () => {
  it('inverts finger drag direction into wheel deltas', () => {
    expect(toScrollDelta({ x: 100, y: 200 }, { x: 120, y: 160 })).toEqual({ deltaX: -20, deltaY: 40 });
  });

  it('keeps diagonal drags on both axes', () => {
    expect(toScrollDelta({ x: 50, y: 50 }, { x: 30, y: 90 })).toEqual({ deltaX: 20, deltaY: -40 });
  });
});
