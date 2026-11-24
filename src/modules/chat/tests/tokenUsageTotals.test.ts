import { describe, expect, it } from 'vitest';

import { readTokenUsageTotals } from '@/modules/chat/composer/tokenUsage';

describe('readTokenUsageTotals', () => {
  it('reads used and window from flat fields', () => {
    expect(readTokenUsageTotals({ used: 87_000, total: 400_000 })).toEqual({ usedTokens: 87_000, contextWindow: 400_000 });
  });

  it('falls back to input+output when used is missing', () => {
    expect(readTokenUsageTotals({ inputTokens: 30_000, outputTokens: 20_000, total: 400_000 }))
      .toEqual({ usedTokens: 50_000, contextWindow: 400_000 });
  });

  it('falls back to the breakdown object', () => {
    expect(readTokenUsageTotals({ breakdown: { input: 30, output: 12 }, total: 400 }))
      .toEqual({ usedTokens: 42, contextWindow: 400 });
  });

  it('tolerates null and junk', () => {
    expect(readTokenUsageTotals(null)).toEqual({ usedTokens: 0, contextWindow: 0 });
    expect(readTokenUsageTotals({ used: 'abc', total: null })).toEqual({ usedTokens: 0, contextWindow: 0 });
  });
});
