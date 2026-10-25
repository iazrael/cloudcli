/** One token-usage reading shared by the composer's occupancy surfaces. */
export type ContextUsageReading = {
  used: number;
  total: number;
  /** Fill ratio in whole percent (1–100), or null when there is no window to measure against. */
  percent: number | null;
  /** UTF-8 size of the compaction summary that replaced the conversation, right after a compact. */
  summaryBytes: number;
};

const readNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Normalizes one raw `ProviderTokenUsageResult` payload into composer badge
 * state.
 *
 * A just-compacted session carries no occupancy — the numbers in that payload
 * describe the context the user discarded — so it is replaced by the summary's
 * size when the engine reported one, and by nothing at all otherwise. Every
 * path that feeds the badge (history pages, the `/token-usage` refresh, the
 * `/cost` result, the realtime `token_budget` frame) goes through here so none
 * of them can pin a stale or meaningless "0".
 */
export function toTokenBudget(usage: unknown): Record<string, unknown> | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const record = usage as Record<string, unknown>;
  if (record.compacted !== true) {
    return record;
  }

  const summaryBytes = readNumber(record.summaryBytes);
  return summaryBytes > 0 ? { used: 0, summaryBytes } : null;
}

/**
 * Normalizes one `ProviderTokenUsageResult` payload for the composer.
 *
 * The engine's own `percentage` wins when it reports one (Claude does);
 * otherwise the ratio is `used / total`. `percent` is null when the provider
 * reports no context window, because a ratio without a window is meaningless.
 *
 * Shared by `TokenUsageSummary` (desktop badge) and `ContextUsageBar` (mobile
 * progress line) so the two can never disagree about occupancy.
 */
export function readContextUsage(usage: Record<string, unknown> | null): ContextUsageReading {
  if (!usage) {
    return { used: 0, total: 0, percent: null, summaryBytes: 0 };
  }

  const total = readNumber(usage.total);
  const used = readNumber(usage.used)
    || readNumber(usage.inputTokens) + readNumber(usage.outputTokens);
  const reported = readNumber(usage.percentage);

  const percent = reported > 0
    ? Math.min(100, Math.max(1, Math.round(reported)))
    : total > 0 && used > 0
      ? Math.min(100, Math.max(1, Math.round((used / total) * 100)))
      : null;

  return { used, total, percent, summaryBytes: readNumber(usage.summaryBytes) };
}

/**
 * Formats a byte size for the post-compaction reading (the summary's text
 * length), where "1.2KB" is the number a user can compare against the summary
 * they can see in the transcript.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0B';
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)}KB`;
  }
  return `${Math.round(bytes)}B`;
}
