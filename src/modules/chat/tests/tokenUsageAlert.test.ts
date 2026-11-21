import { describe, expect, it } from 'vitest';

import { getTokenUsageAlert, readTokenUsageTotals } from '@/modules/chat/composer/tokenUsage';

describe('getTokenUsageAlert', () => {
  it('returns null below the warn threshold', () => {
    expect(getTokenUsageAlert(84_900, 100_000)).toBeNull();
  });

  it('returns warn from the warn threshold up', () => {
    expect(getTokenUsageAlert(85_000, 100_000)).toBe('warn');
    expect(getTokenUsageAlert(94_000, 100_000)).toBe('warn');
  });

  it('returns critical from the critical threshold up', () => {
    expect(getTokenUsageAlert(95_000, 100_000)).toBe('critical');
    expect(getTokenUsageAlert(100_000, 100_000)).toBe('critical');
    expect(getTokenUsageAlert(120_000, 100_000)).toBe('critical');
  });

  it('returns null without a usable window or usage', () => {
    expect(getTokenUsageAlert(87_000, 0)).toBeNull();
    expect(getTokenUsageAlert(0, 100_000)).toBeNull();
    expect(getTokenUsageAlert(-1, 100_000)).toBeNull();
  });
});

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
