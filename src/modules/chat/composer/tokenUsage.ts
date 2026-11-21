/** Used by chat's TokenUsageSummary, TokenUsageBadge and ComposerOverflowMenu. */

export const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  // Thresholds sit where rounding would carry into the next unit, so 9,960 reads "10K", not "10.0K".
  if (value >= 999_500) {
    return `${(value / 1_000_000).toFixed(value >= 9_950_000 ? 0 : 1)}M`;
  }

  if (value >= 9_950) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Used by chat's TokenUsageSummary, TokenUsageBadge and ComposerOverflowMenu to read one budget blob. */
export type TokenUsageTotals = {
  /** Tokens the current context window holds. */
  usedTokens: number;
  /** Size of the window the usage is measured against; 0 when unknown. */
  contextWindow: number;
};

/** Used by chat's TokenUsageSummary, TokenUsageBadge and ComposerOverflowMenu to read one budget blob. */
export const readTokenUsageTotals = (usage: Record<string, unknown> | null): TokenUsageTotals => {
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;
  return { usedTokens, contextWindow: readUsageNumber(usage?.total) };
};

/** From this share of the window on, the mobile composer badge speaks up. */
export const TOKEN_USAGE_WARN_RATIO = 0.85;
/** From this share of the window on, the mobile composer badge turns red. */
export const TOKEN_USAGE_CRITICAL_RATIO = 0.95;

/** How close to full the context window is; null below the warn threshold or without a window. */
export const getTokenUsageAlert = (usedTokens: number, contextWindow: number): 'warn' | 'critical' | null => {
  if (contextWindow <= 0 || usedTokens <= 0) {
    return null;
  }
  const ratio = usedTokens / contextWindow;
  if (ratio >= TOKEN_USAGE_CRITICAL_RATIO) {
    return 'critical';
  }
  if (ratio >= TOKEN_USAGE_WARN_RATIO) {
    return 'warn';
  }
  return null;
};
