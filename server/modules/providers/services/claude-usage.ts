import type { AnyRecord, ProviderTokenUsageResult } from '@/shared/types.js';
import { readUsageNumber } from '@/shared/utils.js';

/**
 * Context windows the Claude SDK reported per provider session id.
 *
 * The SDK states the real window of the model that served a turn only in the
 * turn's `result.modelUsage[model].contextWindow`; the transcript records the
 * model id at most, and an id cannot tell a 200K from a 1M variant, nor what a
 * self-hosted model behind ANTHROPIC_BASE_URL allows. Remembering the reported
 * value lets the history-derived usage show the same window the live counter
 * did. It is process memory on purpose: after a restart the counter falls back
 * to CONTEXT_WINDOW until the session's next turn reports again.
 */
const reportedClaudeContextWindows = new Map<string, number>();

/** One number per session; the cap only bounds a long-lived server's memory. */
const MAX_REPORTED_CLAUDE_CONTEXT_WINDOWS = 1000;

/**
 * Used by the Claude runtime provider to record the window the SDK reported for
 * a session's turn. Non-positive or non-numeric values are ignored so a build
 * that reports no window never overwrites one that did.
 */
export function rememberClaudeContextWindow(providerSessionId: string, contextWindow: number): void {
  if (!providerSessionId || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return;
  }

  // Re-insert so the most recently reported sessions are the last evicted.
  reportedClaudeContextWindows.delete(providerSessionId);
  reportedClaudeContextWindows.set(providerSessionId, contextWindow);
  if (reportedClaudeContextWindows.size > MAX_REPORTED_CLAUDE_CONTEXT_WINDOWS) {
    const oldestSessionId = reportedClaudeContextWindows.keys().next().value;
    if (oldestSessionId !== undefined) {
      reportedClaudeContextWindows.delete(oldestSessionId);
    }
  }
}

/**
 * Used by the Claude runtime provider (a resumed run starts from the window its
 * session last reported) and the Claude history reader.
 */
export function getReportedClaudeContextWindow(
  providerSessionId: string | null | undefined,
): number | undefined {
  return providerSessionId ? reportedClaudeContextWindows.get(providerSessionId) : undefined;
}

/**
 * Latest context-window usage plus the session's cumulative spend from a
 * Claude transcript's already-parsed rows.
 *
 * Exported because the session-messages reader hands the same usage back on
 * every history page, the way the Codex and OpenCode readers do. Without that,
 * a Claude session's counter only moved when the session was reselected, and
 * the store's "this provider reports no usage" path overwrote it with zero.
 *
 * `used` reads the newest main-thread assistant turn only:
 * `input_tokens + cache_read + cache_creation` is that one request's whole
 * prompt, i.e. what the context window currently holds. Summing turns would
 * count the same cached prefix once per turn, so the cumulative block sums
 * every assistant row instead — subagent turns included, since their tokens
 * were really spent on this session.
 *
 * The total is the window the SDK reported for the session when there is one,
 * and the CONTEXT_WINDOW setting otherwise.
 */
export function summarizeClaudeTokenUsage(
  entries: AnyRecord[],
  configuredContextWindow: string | undefined = process.env.CONTEXT_WINDOW,
  reportedContextWindow?: number,
): ProviderTokenUsageResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;

  for (const entry of entries) {
    const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
    if (!usage) {
      continue;
    }

    const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
    const rowCacheReadTokens = readUsageNumber(
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
    );
    const rowCacheCreationTokens = readUsageNumber(
      usage.cache_creation_input_tokens
        ?? usage.cacheCreationInputTokens
        ?? usage.cacheCreationTokens,
    );
    const rowInputTokens = directInputTokens + rowCacheReadTokens + rowCacheCreationTokens;
    const rowOutputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

    // `<synthetic>` rows — interrupts, API errors, "No response requested" —
    // are written with an all-zero usage block rather than none at all. They
    // never carried a prompt, so counting one zeroed a counter that a live
    // event had just set correctly.
    if (rowInputTokens === 0 && rowOutputTokens === 0) {
      continue;
    }

    cumulativeInputTokens += rowInputTokens;
    cumulativeOutputTokens += rowOutputTokens;

    // A subagent's turns report the subagent's context window, not this
    // conversation's; reading one makes the counter drop to the subagent's
    // number and bounce back on the next main-thread turn. They still count
    // as spend above, and the newest main-thread row wins here.
    if (entry?.isSidechain === true) {
      continue;
    }

    cacheReadTokens = rowCacheReadTokens;
    cacheCreationTokens = rowCacheCreationTokens;
    inputTokens = rowInputTokens;
    outputTokens = rowOutputTokens;
  }

  const parsedContextWindow = Number.parseInt(configuredContextWindow ?? '', 10);
  const configuredOrDefaultContextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160_000;
  const contextWindow = reportedContextWindow && reportedContextWindow > 0
    ? reportedContextWindow
    : configuredOrDefaultContextWindow;
  const cacheTokens = cacheReadTokens + cacheCreationTokens;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    cumulative: {
      used: cumulativeInputTokens + cumulativeOutputTokens,
      inputTokens: cumulativeInputTokens,
      outputTokens: cumulativeOutputTokens,
    },
    breakdown: { input: inputTokens, output: outputTokens },
  };
}
