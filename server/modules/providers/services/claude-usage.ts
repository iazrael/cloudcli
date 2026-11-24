import type { AnyRecord, ProviderTokenUsageResult } from '@/shared/types.js';
import { readJsonlIncrementally, readUsageNumber, type JsonlIncrementalState } from '@/shared/utils.js';
import { resolveModelContextWindow } from '@/modules/providers/services/model-context-window.service.js';

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

/** Running totals over one Claude transcript: newest context plus whole spend. */
type ClaudeUsageAccumulator = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  /** Model of the newest main-thread turn; the fallback window is looked up by it. */
  model: string | null;
};

/** Cursors of the transcripts already read; one small object per session. */
const claudeTranscriptCursors = new Map<string, JsonlIncrementalState<ClaudeUsageAccumulator>>();

/** Bounds a long-lived server's memory; the least recently read entry leaves. */
const MAX_CLAUDE_TRANSCRIPT_CURSORS = 200;

function createClaudeUsageAccumulator(): ClaudeUsageAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    model: null,
  };
}

/**
 * Folds one transcript entry into the running totals.
 *
 * Shared by the pure summarizer (which is handed already-parsed rows) and the
 * incremental file reader, so both apply exactly the same rules.
 */
function applyClaudeUsageEntry(accumulator: ClaudeUsageAccumulator, entry: AnyRecord): void {
  const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
  if (!usage) {
    return;
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
    return;
  }

  accumulator.cumulativeInputTokens += rowInputTokens;
  accumulator.cumulativeOutputTokens += rowOutputTokens;

  // A subagent's turns report the subagent's context window, not this
  // conversation's; reading one makes the counter drop to the subagent's
  // number and bounce back on the next main-thread turn. They still count as
  // spend above, and the newest main-thread row wins here.
  if (entry?.isSidechain === true) {
    return;
  }

  accumulator.cacheReadTokens = rowCacheReadTokens;
  accumulator.cacheCreationTokens = rowCacheCreationTokens;
  accumulator.inputTokens = rowInputTokens;
  accumulator.outputTokens = rowOutputTokens;

  // The window fallback is per model, so the newest main-thread turn's model
  // decides it — a subagent's model has its own window (it was skipped above).
  const model = entry?.message?.model;
  if (typeof model === 'string' && model && model !== '<synthetic>') {
    accumulator.model = model;
  }
}

function buildClaudeUsageResult(
  accumulator: ClaudeUsageAccumulator,
  configuredContextWindow: string | undefined,
  reportedContextWindow?: number,
): ProviderTokenUsageResult {
  const parsedContextWindow = Number.parseInt(configuredContextWindow ?? '', 10);
  const configuredOrDefaultContextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160_000;
  // The SDK states the window only for direct Anthropic runs. Behind a
  // compatible gateway the model id is all there is, so the local catalog
  // stands in — an explicit MODEL_CONTEXT_WINDOWS entry inside it first.
  const inferredContextWindow = resolveModelContextWindow(accumulator.model);
  const contextWindow = reportedContextWindow && reportedContextWindow > 0
    ? reportedContextWindow
    : inferredContextWindow ?? configuredOrDefaultContextWindow;
  const cacheTokens = accumulator.cacheReadTokens + accumulator.cacheCreationTokens;

  return {
    used: accumulator.inputTokens + accumulator.outputTokens,
    total: contextWindow,
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    cacheReadTokens: accumulator.cacheReadTokens,
    cacheCreationTokens: accumulator.cacheCreationTokens,
    cacheTokens,
    cumulative: {
      used: accumulator.cumulativeInputTokens + accumulator.cumulativeOutputTokens,
      inputTokens: accumulator.cumulativeInputTokens,
      outputTokens: accumulator.cumulativeOutputTokens,
    },
    breakdown: { input: accumulator.inputTokens, output: accumulator.outputTokens },
  };
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
  const accumulator = createClaudeUsageAccumulator();
  for (const entry of entries) {
    applyClaudeUsageEntry(accumulator, entry);
  }
  return buildClaudeUsageResult(accumulator, configuredContextWindow, reportedContextWindow);
}

/**
 * Same reading, computed from the transcript file itself and parsing only the
 * bytes appended since the previous call.
 *
 * A Claude transcript reaches hundreds of megabytes while each turn adds a few
 * kilobytes, so replaying the whole file on every usage refresh spends
 * hundreds of milliseconds of parse and GC for nothing. The accumulator keeps
 * the running totals, which is all a refresh needs.
 *
 * Consumers: the Claude sessions provider's token-usage endpoint.
 */
export async function readClaudeTranscriptTokenUsage(
  filename: string,
  configuredContextWindow: string | undefined = process.env.CONTEXT_WINDOW,
  reportedContextWindow?: number,
): Promise<ProviderTokenUsageResult> {
  const next = await readJsonlIncrementally(
    filename,
    claudeTranscriptCursors.get(filename),
    createClaudeUsageAccumulator,
    applyClaudeUsageEntry,
  );

  if (next) {
    // Re-insert so the most recently read transcripts are the last evicted.
    claudeTranscriptCursors.delete(filename);
    claudeTranscriptCursors.set(filename, next);
    if (claudeTranscriptCursors.size > MAX_CLAUDE_TRANSCRIPT_CURSORS) {
      const oldest = claudeTranscriptCursors.keys().next().value;
      if (oldest !== undefined) {
        claudeTranscriptCursors.delete(oldest);
      }
    }
  }

  return buildClaudeUsageResult(
    next?.accumulator ?? createClaudeUsageAccumulator(),
    configuredContextWindow,
    reportedContextWindow,
  );
}
