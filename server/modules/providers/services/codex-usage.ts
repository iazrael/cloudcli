import type { AnyRecord, ProviderTokenUsageResult } from '@/shared/types.js';
import { readUsageNumber } from '@/shared/utils.js';

/** Codex's own default when a snapshot reports no window. */
const DEFAULT_CODEX_CONTEXT_WINDOW = 200_000;

/**
 * Reads one usage block that may be spelled either way Codex reports it:
 * the app-server notification's camelCase (`totalTokens`, `inputTokens`) or
 * the rollout JSONL's snake_case (`total_tokens`, `input_tokens`).
 */
function readUsageBlock(value: unknown): { totalTokens: number; inputTokens: number; outputTokens: number } | null {
  const block = readObject(value);
  if (!block) {
    return null;
  }

  const inputTokens = readUsageNumber(block.inputTokens ?? block.input_tokens);
  const outputTokens = readUsageNumber(block.outputTokens ?? block.output_tokens);
  return {
    totalTokens: readUsageNumber(block.totalTokens ?? block.total_tokens) || inputTokens + outputTokens,
    inputTokens,
    outputTokens,
  };
}

function readObject(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null;
}

/**
 * Builds the app's usage snapshot from one Codex token reading.
 *
 * Codex reports two blocks per update: the turn that just ran (what the
 * context window currently holds) and the session's cumulative spend. Both
 * the live `thread/tokenUsage/updated` notification and the rollout's
 * `token_count` entries carry the same pair under different spellings; going
 * through this one function is what keeps the live counter and a reloaded
 * session from disagreeing.
 *
 * Consumers: the Codex runtime (live gauge) and the Codex sessions provider
 * (history pages and the token-usage endpoint).
 */
export function buildCodexUsageSnapshot(input: {
  /** The newest turn's usage; absent on notifications that only carry totals. */
  last?: unknown;
  /** The session's cumulative usage. */
  total?: unknown;
  /** The model's context window. */
  contextWindow?: unknown;
}): ProviderTokenUsageResult | null {
  const last = readUsageBlock(input.last);
  const cumulativeBlock = readUsageBlock(input.total);
  const context = last ?? cumulativeBlock;
  if (!context) {
    return null;
  }

  return {
    used: context.totalTokens,
    total: readUsageNumber(input.contextWindow) || DEFAULT_CODEX_CONTEXT_WINDOW,
    inputTokens: context.inputTokens,
    outputTokens: context.outputTokens,
    breakdown: { input: context.inputTokens, output: context.outputTokens },
    ...(cumulativeBlock
      ? {
          cumulative: {
            used: cumulativeBlock.totalTokens,
            inputTokens: cumulativeBlock.inputTokens,
            outputTokens: cumulativeBlock.outputTokens,
          },
        }
      : {}),
  };
}
