import type { AnyRecord, ProviderTokenUsageResult } from '@/shared/types.js';
import { readJsonlIncrementally, readUsageNumber, type JsonlIncrementalState } from '@/shared/utils.js';

/** Codex's own default when a snapshot reports no window. */
const DEFAULT_CODEX_CONTEXT_WINDOW = 200_000;

/** How many rollout cursors to remember; one small object per open session. */
const MAX_CODEX_ROLLOUT_CURSORS = 200;

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

/** What one rollout has produced so far; only the newest reading is kept. */
type CodexRolloutAccumulator = { snapshot: ProviderTokenUsageResult | null };

/**
 * Cursors of the rollouts already read, keyed by path.
 *
 * A rollout grows by a few hundred kilobytes per turn while reaching tens of
 * megabytes overall, so the state makes each refresh parse only the tail
 * instead of the whole file. The entry is small (offset, a possible pending
 * line, the last snapshot); the cap bounds a long-lived server's memory.
 */
const codexRolloutCursors = new Map<string, JsonlIncrementalState<CodexRolloutAccumulator>>();

function rememberCodexRolloutCursor(
  filename: string,
  state: JsonlIncrementalState<CodexRolloutAccumulator>,
): void {
  codexRolloutCursors.delete(filename);
  codexRolloutCursors.set(filename, state);
  if (codexRolloutCursors.size > MAX_CODEX_ROLLOUT_CURSORS) {
    const oldest = codexRolloutCursors.keys().next().value;
    if (oldest !== undefined) {
      codexRolloutCursors.delete(oldest);
    }
  }
}

/**
 * Reads the newest usage reading from one Codex rollout JSONL, parsing only
 * the bytes appended since the previous call.
 *
 * Consumers: the Codex sessions provider's token-usage endpoint. A rollout is
 * append-only and its `token_count` entries carry cumulative counters, so the
 * newest entry alone is the whole answer — no history needs to be retained
 * beyond the last snapshot.
 */
export async function readCodexRolloutTokenUsage(filename: string): Promise<ProviderTokenUsageResult> {
  const next = await readJsonlIncrementally(
    filename,
    codexRolloutCursors.get(filename),
    (): CodexRolloutAccumulator => ({ snapshot: null }),
    (accumulator, entry) => {
      if (entry.type !== 'event_msg') {
        return;
      }
      const payload = readObject(entry.payload);
      if (payload?.type !== 'token_count') {
        return;
      }
      const info = readObject(payload.info);
      if (!info) {
        return;
      }
      accumulator.snapshot = buildCodexUsageSnapshot({
        last: info.last_token_usage,
        total: info.total_token_usage,
        contextWindow: info.model_context_window,
      }) ?? accumulator.snapshot;
    },
  );

  if (next) {
    rememberCodexRolloutCursor(filename, next);
  }

  return next?.accumulator.snapshot ?? {
    used: 0,
    total: DEFAULT_CODEX_CONTEXT_WINDOW,
    inputTokens: 0,
    outputTokens: 0,
    breakdown: { input: 0, output: 0 },
  };
}
