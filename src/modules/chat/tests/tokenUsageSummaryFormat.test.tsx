import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { describe, it, vi } from 'vitest';

import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const shownCount = (used: number) => {
  const { getByRole, unmount } = render(<TokenUsageSummary usage={{ used }} />);
  const text = getByRole('button').textContent;
  unmount();
  return text?.replace('chat:misc.tokensLabel', '');
};

describe('TokenUsageSummary count', () => {
  it('carries a count that rounds up into the next unit', () => {
    assert.equal(shownCount(9_949), '9.9K');
    assert.equal(shownCount(9_960), '10K');
    assert.equal(shownCount(376_000), '376K');
    assert.equal(shownCount(999_499), '999K');
    assert.equal(shownCount(999_600), '1.0M');
    assert.equal(shownCount(9_960_000), '10M');
  });

  it('names the context window in the tooltip so the number is not read as a total', () => {
    const { getByRole, unmount } = render(
      <TokenUsageSummary usage={{ used: 335_960, total: 475_000 }} />,
    );
    const title = getByRole('button').getAttribute('title');
    unmount();
    assert.equal(title, 'chat:misc.contextTokensUsed');
  });
});
