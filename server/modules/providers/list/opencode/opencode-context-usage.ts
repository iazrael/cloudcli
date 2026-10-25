/**
 * OpenCode Context Usage
 *
 * Reads "how full is the context window right now" for one OpenCode session
 * out of the shared `opencode.db` plus OpenCode's own model cache.
 *
 * OpenCode records two very different numbers, and conflating them is the
 * misreading this module exists to prevent:
 *
 * - The session row's `tokens_*` columns (also `GET /api/session/:id`'s
 *   `tokens`) are SESSION-LIFETIME spends: every turn's prompt is added again,
 *   so a long session reaches hundreds of millions while its window stays a
 *   fraction full. They are preserved as `cumulative` for the cost breakdown.
 * - Each assistant message's own `tokens` describe the request that produced
 *   it — that request's whole prompt plus what it generated — i.e. what the
 *   context window held when that turn ran. That is the occupancy the composer
 *   badge must show.
 * - A compaction (v2.0.32 writes it as a `compaction` message row) replaces
 *   that conversation: its own tokens describe the summarization request, so
 *   the reader reports `compacted` with the summary's byte size instead of an
 *   occupancy until the next turn runs.
 *
 * Both the history reader (`opencode-sessions.provider.ts`) and the runtime's
 * token-budget frames (`opencode-run-registry.ts`) consume this, so a reloaded
 * transcript and the live counter can never disagree.
 *
 * @module opencode-context-usage
 */

import fsSync from 'node:fs';

import type Database from 'better-sqlite3';

import type { AnyRecord, ProviderTokenUsageResult } from '@/shared/types.js';
import {
  readObjectRecord,
  readJsonRecord,
  readOptionalString,
  readUsageNumber,
} from '@/shared/utils.js';

import {
  getOpenCodeModelsCachePath,
  readOpenCodeSessionModelKey,
  readOpenCodeSessionTokenTotals,
  readOpenCodeUsageMessageRows,
  resolveOpenCodeMessageLayout,
} from './opencode-data-root.js';

/**
 * One step's numbers, normalized across the shapes OpenCode stores and emits.
 *
 * `promptTokens` is what the engine fed the model for that step, cache reads
 * INCLUDED: the stored `input` counts only the uncached part (the cache
 * counters sit beside it), so the window occupancy is `input + cache`. Live
 * `session.step.ended` events carry the same shape, which is why both readers
 * share this one normalizer.
 */
export type OpenCodeStepTokens = {
  promptTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What the window held for this step: prompt plus generated text. */
  used: number;
};

/**
 * Normalizes one `tokens` payload (assistant message JSON or a
 * `session.step.ended` event) into step totals.
 *
 * Returns null for a record with no readable prompt at all — an in-flight or
 * token-less step, which must never read as "0 tokens used".
 */
export function readOpenCodeStepTokens(value: unknown): OpenCodeStepTokens | null {
  const tokens = readObjectRecord(value);
  if (!tokens) {
    return null;
  }

  const cache = readObjectRecord(tokens.cache);
  const cacheReadTokens = readUsageNumber(cache?.read);
  const cacheWriteTokens = readUsageNumber(cache?.write);
  const uncachedInput = readUsageNumber(tokens.input);
  const promptTokens = uncachedInput + cacheReadTokens + cacheWriteTokens;
  const outputTokens = readUsageNumber(tokens.output) + readUsageNumber(tokens.reasoning);

  if (promptTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return { promptTokens, outputTokens, cacheReadTokens, cacheWriteTokens, used: promptTokens + outputTokens };
}

// ---------------------------

/**
 * Context window for one `providerId/modelId` pair, read from OpenCode's model
 * cache (`~/.cache/opencode/models.json`, models.dev data with
 * `limit.context`).
 *
 * The cache is multi-megabyte JSON that OpenCode rewrites on registry
 * refreshes, so the parsed window map is memoized by file identity (mtime +
 * size) and only re-read when that identity changes. Returns undefined when
 * the cache is missing, malformed, or carries no limit for the model — a
 * windowless reading simply shows no percentage.
 *
 * Consumers: opencode context usage (below) and the runtime (mid-turn budget
 * frames, which resolve the window once per run).
 */
let openCodeContextWindowCache: { key: string; windows: Map<string, number> } | null = null;

export function resolveOpenCodeContextWindow(providerId: string, modelId: string): number | undefined {
  const cachePath = getOpenCodeModelsCachePath();
  let cacheKey: string;
  try {
    const stats = fsSync.statSync(cachePath);
    cacheKey = `${cachePath}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    return undefined;
  }

  if (openCodeContextWindowCache?.key !== cacheKey) {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(cachePath, 'utf8')) as Record<string, unknown> | null;
      const windows = new Map<string, number>();
      for (const [catalogProviderId, providerValue] of Object.entries(parsed ?? {})) {
        const models = readObjectRecord(readObjectRecord(providerValue)?.models);
        if (!models) {
          continue;
        }
        for (const [catalogModelId, modelValue] of Object.entries(models)) {
          const contextLimit = readUsageNumber(readObjectRecord(readObjectRecord(modelValue)?.limit)?.context);
          if (contextLimit > 0) {
            windows.set(`${catalogProviderId}/${catalogModelId}`, contextLimit);
          }
        }
      }
      openCodeContextWindowCache = { key: cacheKey, windows };
    } catch {
      openCodeContextWindowCache = null;
      return undefined;
    }
  }

  return openCodeContextWindowCache?.windows.get(`${providerId}/${modelId}`);
}

// ---------------------------

/**
 * Session-lifetime totals, formatted for the `cumulative` field of the usage
 * payload. Fed from the session row's token columns when the layout has them
 * (v2) and from per-message sums otherwise (v1).
 *
 * Consumer: `readOpenCodeContextUsage`.
 */
function readOpenCodeCumulativeUsage(
  db: Database.Database,
  sessionId: string,
  messageRows: Array<{ data: AnyRecord | null }>,
): { used: number; inputTokens: number; outputTokens: number } | undefined {
  // v2 keeps the lifetime totals on the session row; v1 only has them across
  // the per-message payloads. Both are normalized to the row's raw shape
  // (input WITHOUT cache) before formatting.
  const sessionTotals = readOpenCodeSessionTokenTotals(db, sessionId);
  const totals = sessionTotals ?? messageRows.reduce(
    (sum, row) => {
      const raw = readObjectRecord(row.data?.tokens);
      if (!raw) {
        return sum;
      }
      const cache = readObjectRecord(raw.cache);
      return {
        inputTokens: sum.inputTokens + readUsageNumber(raw.input),
        outputTokens: sum.outputTokens + readUsageNumber(raw.output),
        reasoningTokens: sum.reasoningTokens + readUsageNumber(raw.reasoning),
        cacheReadTokens: sum.cacheReadTokens + readUsageNumber(cache?.read),
        cacheWriteTokens: sum.cacheWriteTokens + readUsageNumber(cache?.write),
      };
    },
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );

  const used = totals.inputTokens
    + totals.outputTokens
    + totals.reasoningTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens;
  if (used <= 0) {
    return undefined;
  }

  return {
    used,
    inputTokens: totals.inputTokens + totals.cacheReadTokens,
    outputTokens: totals.outputTokens,
  };
}

// ---------------------------

/**
 * Whether one usage-bearing row says the conversation was replaced by a
 * summary.
 *
 * v2.0.32 writes the compaction as a message row of its own — `status:
 * 'completed'` with the summary text in `summary` — while builds that folded
 * it into an assistant message flag that message with `summary: true`. A
 * failed or in-flight compaction leaves the conversation alone and must not
 * mark it as replaced.
 */
function isCompactionSummaryRow(data: AnyRecord | null): boolean {
  if (!data) {
    return false;
  }
  if (data.summary === true) {
    return true;
  }
  return data.status === 'completed' && typeof data.summary === 'string';
}

/**
 * Newest per-message context occupancy of one OpenCode session.
 *
 * Rows arrive newest-first; the first assistant record with usable tokens
 * wins. Compaction summaries are skipped (either shape — see
 * `isCompactionSummaryRow`): their tokens describe the summarization request,
 * i.e. the whole PRE-compaction conversation, so reporting them as current
 * occupancy is exactly wrong. When such a summary is the newest record,
 * `compacted` is set: OpenCode only learns the post-compaction occupancy once
 * the next turn runs, so there is no number to report yet.
 */
function readLatestOpenCodeMessageUsage(
  messageRows: Array<{ id: string; data: AnyRecord | null }>,
): {
  compacted: boolean;
  /** Id of the newest compaction summary, whose text is the post-compaction context. */
  summaryMessageId: string | null;
  modelKey: string | null;
  tokens: OpenCodeStepTokens;
} | null {
  let sawNewerCompaction = false;
  let summaryMessageId: string | null = null;
  let latest = null as { modelKey: string | null; tokens: OpenCodeStepTokens } | null;

  for (const row of messageRows) {
    if (isCompactionSummaryRow(row.data)) {
      sawNewerCompaction = true;
      summaryMessageId = summaryMessageId ?? row.id;
      continue;
    }

    const tokens = readOpenCodeStepTokens(row.data?.tokens);
    if (!tokens || tokens.used <= 0) {
      continue;
    }

    latest = { modelKey: readAssistantModelKey(row.data), tokens };
    break;
  }

  if (!latest) {
    return sawNewerCompaction
      ? {
          compacted: true,
          summaryMessageId,
          modelKey: null,
          tokens: { promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, used: 0 },
        }
      : null;
  }

  return { compacted: sawNewerCompaction, summaryMessageId, ...latest };
}

/**
 * Provider-native model key of one assistant payload, built as
 * `providerId/modelId`.
 *
 * Assistant payloads carry the model as `model.{providerID, id}` (v2) or as
 * flat `providerID`/`modelID` fields (older rows). Rows whose id still carries
 * the provider (`provider/model`) or an effort variant (`model#max`) have both
 * stripped, because models.json keys are exactly `provider/model`.
 */
function readAssistantModelKey(info: AnyRecord | null): string | null {
  const model = readObjectRecord(info?.model);
  const providerId = readOptionalString(model?.providerID)
    ?? readOptionalString(model?.providerId)
    ?? readOptionalString(info?.providerID)
    ?? readOptionalString(info?.providerId);
  const modelId = readOptionalString(model?.id)
    ?? readOptionalString(model?.modelID)
    ?? readOptionalString(model?.modelId)
    ?? readOptionalString(info?.modelID)
    ?? readOptionalString(info?.modelId);

  if (!modelId) {
    return null;
  }
  // A plain routed id may still carry its provider (`provider/model`) or an
  // effort variant (`provider/model#max`); both must come off before the
  // models.json lookup.
  const withoutVariant = modelId.split('#')[0] ?? modelId;
  if (withoutVariant.includes('/')) {
    const [embeddedProvider, ...modelParts] = withoutVariant.split('/');
    return `${providerId ?? embeddedProvider}/${modelParts.join('/')}`;
  }
  return providerId ? `${providerId}/${withoutVariant}` : withoutVariant;
}

/**
 * UTF-8 size of one message's text parts.
 *
 * After a compaction the summary's text *is* the conversation handed to the
 * next turn, so its size is the only honest "how big is the context now"
 * reading available before that turn reports real occupancy. v2 keeps the
 * message's content inline (`session_message.data.content`); v1 splits parts
 * into the `part` table. A storage layout the message is not in simply
 * contributes nothing.
 */
function readOpenCodeMessageTextBytes(db: Database.Database, messageId: string): number {
  const layout = resolveOpenCodeMessageLayout(db);
  if (layout === 'session_message') {
    return readInlineMessageTextBytes(db, messageId);
  }
  if (layout === 'message_part') {
    try {
      const rows = db.prepare('SELECT data FROM part WHERE message_id = ?').all(messageId) as { data: string }[];
      let bytes = 0;
      for (const row of rows) {
        const part = readJsonRecord(row.data);
        if (readOptionalString(part?.type) !== 'text' || typeof part?.text !== 'string') {
          continue;
        }
        bytes += Buffer.byteLength(part.text, 'utf8');
      }
      return bytes;
    } catch {
      return 0;
    }
  }
  return 0;
}

/** Reads a v2 `session_message` row's inline text: its `content` text blocks plus the summarization a compaction row keeps beside them. */
function readInlineMessageTextBytes(db: Database.Database, messageId: string): number {
  try {
    const row = db.prepare('SELECT data FROM session_message WHERE id = ?').get(messageId) as { data: string } | undefined;
    const data = readJsonRecord(row?.data ?? null);
    // v2.0.32 compaction rows hold the whole post-compaction context as a
    // top-level string instead of content blocks.
    let bytes = typeof data?.summary === 'string' ? Buffer.byteLength(data.summary, 'utf8') : 0;
    const content = data?.content;
    if (!Array.isArray(content)) {
      return bytes;
    }
    for (const block of content) {
      const part = readObjectRecord(block);
      if (readOptionalString(part?.type) !== 'text' || typeof part?.text !== 'string') {
        continue;
      }
      bytes += Buffer.byteLength(part.text, 'utf8');
    }
    return bytes;
  } catch {
    return 0;
  }
}

/**
 * Builds the context-usage answer for one OpenCode session: the newest
 * message's occupancy plus the model's context window when it can be resolved,
 * with the session-lifetime columns preserved as `cumulative` for the cost
 * breakdown.
 *
 * A transcript with no usable per-message record reports nothing at all
 * (`undefined`): its lifetime totals are a spend figure, and dressing them up
 * as occupancy is exactly the misreading this module exists to remove.
 *
 * Right after a compaction the window carries `compacted: true` and no
 * occupancy: the newest record is the summary of the conversation that was
 * just replaced (either a v2 `compaction` row or an assistant message flagged
 * `summary: true`), so any number taken from it describes the context the user
 * just got rid of. What CAN be measured is the summary text itself, which is
 * what the next turn feeds back in, so the payload carries its byte size as
 * `summaryBytes` until a real turn lands.
 *
 * Consumers: the sessions provider (`fetchHistory` / `getTokenUsage`) and the
 * runtime's token-budget frames.
 */
export function readOpenCodeContextUsage(
  db: Database.Database,
  sessionId: string,
): ProviderTokenUsageResult | undefined {
  const messageRows = readOpenCodeUsageMessageRows(db, sessionId);
  const latest = readLatestOpenCodeMessageUsage(messageRows);
  if (!latest) {
    return undefined;
  }

  const modelKey = readOpenCodeSessionModelKey(db, sessionId) ?? latest.modelKey;
  const slash = modelKey?.indexOf('/') ?? -1;
  const contextWindow = modelKey && slash > 0
    ? resolveOpenCodeContextWindow(modelKey.slice(0, slash), modelKey.slice(slash + 1))
    : undefined;

  const cumulative = readOpenCodeCumulativeUsage(db, sessionId, messageRows);
  const cumulativePayload = cumulative ? { cumulative } : {};

  if (latest.compacted) {
    const summaryBytes = latest.summaryMessageId
      ? readOpenCodeMessageTextBytes(db, latest.summaryMessageId)
      : 0;

    return {
      used: 0,
      ...(contextWindow ? { total: contextWindow } : {}),
      inputTokens: 0,
      outputTokens: 0,
      breakdown: { input: 0, output: 0 },
      compacted: true,
      ...(summaryBytes > 0 ? { summaryBytes } : {}),
      ...cumulativePayload,
    };
  }

  return {
    used: latest.tokens.used,
    ...(contextWindow ? { total: contextWindow } : {}),
    inputTokens: latest.tokens.promptTokens,
    outputTokens: latest.tokens.outputTokens,
    breakdown: { input: latest.tokens.promptTokens, output: latest.tokens.outputTokens },
    ...cumulativePayload,
  };
}

/**
 * Formats one live step's tokens into the token-budget frame shape.
 *
 * Consumer: the opencode runtime's mid-turn and end-of-run `token_budget`
 * frames. The step event carries no model reference, so the caller supplies
 * the window it resolved for the run; a cache read counts toward the prompt
 * (the engine bills it there), and the generated text toward the output — the
 * same split `readOpenCodeContextUsage` reports.
 */
export function buildOpenCodeTokenBudget(
  tokens: OpenCodeStepTokens,
  contextWindow?: number,
): ProviderTokenUsageResult {
  return {
    used: tokens.used,
    ...(contextWindow ? { total: contextWindow } : {}),
    inputTokens: tokens.promptTokens,
    outputTokens: tokens.outputTokens,
    breakdown: { input: tokens.promptTokens, output: tokens.outputTokens },
  };
}
