import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

/** Renders the composer badge with one token-usage payload. */
const renderBadge = (usage: Record<string, unknown> | null) =>
  render(React.createElement(TokenUsageSummary, { usage }));

test('shows a context percentage derived from used/total when the engine reports none', () => {
  const { getByText } = renderBadge({ used: 52_027, total: 1_000_000, inputTokens: 51_661, outputTokens: 366 });
  assert.ok(getByText('5%'), 'used/total must render as a rounded percentage');
});

test('prefers the engine-reported percentage over the derived one', () => {
  // Claude reports the percentage directly (autocompact window); it wins even
  // when the raw counters would round differently.
  const { getByText } = renderBadge({ used: 18_871, total: 1_000_000, percentage: 2 });
  assert.ok(getByText('2%'));
});

test('omits the percentage when the provider reports no context window', () => {
  const { queryByText } = renderBadge({ used: 42, inputTokens: 13, outputTokens: 20 });
  assert.equal(queryByText(/%$/), null);
});

test('shows the summary size instead of 0 right after a compaction', () => {
  // Occupancy is unknown until the next turn, but the summary text that now
  // stands in for the conversation does have a size.
  const { getByText } = renderBadge({ used: 0, total: 1_000_000, compacted: true, summaryBytes: 9_651 });
  assert.ok(getByText('9.4KB'), 'the compaction summary size must render');
});

test('renders nothing for a just-compacted session, whose payload is cleared to null', () => {
  // A compacted session has no occupancy until the next turn; without this the
  // badge would pin a meaningless "0" on the toolbar.
  const { queryByText } = renderBadge(null);
  assert.equal(queryByText(/0/), null);
});

test('renders nothing for an all-zero snapshot', () => {
  const { queryByText } = renderBadge({ used: 0, total: 1_000_000, inputTokens: 0, outputTokens: 0 });
  assert.equal(queryByText(/0/), null);
});
