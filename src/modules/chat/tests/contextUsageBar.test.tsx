import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import { ContextUsageBar } from '@/modules/chat/composer/ContextUsageBar';

/** Reads the rendered fill width, i.e. the occupancy the bar paints. */
const readFillStyle = (container: HTMLElement): string =>
  container.querySelector('span')?.getAttribute('style') ?? '';

test('derives the fill percentage from used/total when the engine reports none', () => {
  const { container } = render(React.createElement(ContextUsageBar, {
    usage: { used: 52_027, total: 1_000_000, inputTokens: 51_661, outputTokens: 366 },
  }));

  assert.match(readFillStyle(container), /width:\s*5%/);
});

test('prefers the engine-reported percentage over the derived one', () => {
  // Claude reports the percentage directly (autocompact window); it wins even
  // when the raw counters would round differently.
  const { container } = render(React.createElement(ContextUsageBar, {
    usage: { used: 18_871, total: 1_000_000, percentage: 2 },
  }));

  assert.match(readFillStyle(container), /width:\s*2%/);
});

test('renders nothing when the provider reports no context window', () => {
  const { container } = render(React.createElement(ContextUsageBar, {
    usage: { used: 42, inputTokens: 13, outputTokens: 20 },
  }));

  assert.equal(container.querySelector('button'), null);
});

test('opens the token-usage breakdown when tapped', () => {
  let clicks = 0;
  const { container } = render(React.createElement(ContextUsageBar, {
    usage: { used: 90, total: 100 },
    onClick: () => {
      clicks += 1;
    },
  }));
  const button = container.querySelector('button');

  assert.ok(button);
  fireEvent.click(button);
  assert.equal(clicks, 1);
});
