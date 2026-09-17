/**
 * OpenCode Context Usage
 *
 * Reads "how full is the context window right now" for one OpenCode session
 * out of the shared `opencode.db` plus OpenCode's own model cache.
 *
 * Both the history reader (`opencode-sessions.provider.ts`) and the runtime's
 * end-of-turn badge refresh (`opencode-runtime.provider.js`) consume this, so
 * the live counter and a reloaded transcript can never disagree.
 *
 * @module opencode-context-usage
 */

import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import type { AnyRecord, ProviderTokenUsageResult } from '@/shared/types.js';
import {
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
  readUsageNumber,
} from '@/shared/utils.js';

import { getOpenCodeModelsCachePath } from './opencode-data-root.js';

type OpenCodeTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const buildTokenUsage = (totals: OpenCodeTokenTotals | undefined): AnyRecord | undefined => {
  if (!totals) {
    return undefined;
  }

  const inputTokens = totals.inputTokens;
  const displayInputTokens = inputTokens + totals.cacheReadTokens;
  const outputTokens = totals.outputTokens;
  const used = inputTokens
    + outputTokens
    + totals.reasoningTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens;

  if (used <= 0) {
    return undefined;
  }

  return {
    used,
    inputTokens: displayInputTokens,
    outputTokens,
    breakdown: {
      input: displayInputTokens,
      output: outputTokens,
    },
  };
};

/**
 * Session-lifetime totals from the `session` row's token columns (older
 * OpenCode databases), or from summing every assistant message's tokens.
 */
const readOpenCodeSessionColumnTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const columns = db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
  if (!requiredColumns.every((column) => columnNames.has(column))) {
    return undefined;
  }

  const row = db.prepare(`
    SELECT
      tokens_input AS inputTokens,
      tokens_output AS outputTokens,
      tokens_reasoning AS reasoningTokens,
      tokens_cache_read AS cacheReadTokens,
      tokens_cache_write AS cacheWriteTokens
    FROM session
    WHERE id = ?
  `).get(sessionId) as OpenCodeTokenTotals | undefined;

  if (!row) {
    return undefined;
  }

  return buildTokenUsage({
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    reasoningTokens: Number(row.reasoningTokens ?? 0),
    cacheReadTokens: Number(row.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
  });
};

/**
 * OpenCode stores per-message token counts on assistant `message.data` objects
 * (see MessageV2.Assistant). Older DBs also had session-level counters; this
 * matches current `opencode.db` layouts that only persist message JSON.
 */
const aggregateOpenCodeSessionTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const sessionColumnUsage = readOpenCodeSessionColumnTokenUsage(db, sessionId);
  if (sessionColumnUsage) {
    return sessionColumnUsage;
  }

  const rows = db.prepare('SELECT data FROM message WHERE session_id = ?').all(sessionId) as { data: string }[];

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for (const row of rows) {
    const info = readJsonRecord(row.data);
    if (readOptionalString(info?.role) !== 'assistant') {
      continue;
    }

    const tokens = readObjectRecord(info?.tokens);
    if (!tokens) {
      continue;
    }

    inputTokens += Number(tokens.input ?? 0);
    outputTokens += Number(tokens.output ?? 0);
    reasoningTokens += Number(tokens.reasoning ?? 0);
    const cache = readObjectRecord(tokens.cache);
    cacheReadTokens += Number(cache?.read ?? 0);
    cacheWriteTokens += Number(cache?.write ?? 0);
  }

  return buildTokenUsage({
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
};

/**
 * Latest per-message context occupancy of one OpenCode session.
 *
 * OpenCode stores each assistant message's own request usage on
 * `message.data.tokens`; `tokens.total` is that request's whole prompt plus
 * output (`input + output + reasoning + cache.read + cache.write`), i.e. what
 * the context window held when that turn ran. Only the newest non-zero record
 * matters — summing them (the session's cumulative columns) counts the same
 * prefix once per turn and inflates the number by orders of magnitude.
 *
 * Compaction summaries (`summary: true` on an assistant message) are skipped:
 * their `tokens` describe the summarization request, i.e. the whole
 * PRE-compaction conversation, so reporting them as current occupancy is
 * exactly wrong. When such a summary is the newest record, `compacted` is set:
 * OpenCode only learns the post-compaction occupancy once the next turn runs,
 * so there is no number to report yet.
 *
 * Returns null for message shapes that predate `tokens.total`, so callers can
 * fall back to the cumulative columns.
 */
const readLatestOpenCodeMessageUsage = (
  db: Database.Database,
  sessionId: string,
): {
  compacted: boolean;
  /** Id of the newest compaction summary, whose text is the post-compaction context. */
  summaryMessageId: string | null;
  providerId: string | null;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  used: number;
} | null => {
  const rows = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC').all(sessionId) as { id: string; data: string }[];

  // Rows are newest-first, so any summary seen before the first usable
  // assistant record is newer than it: compaction is the session's tip.
  let sawNewerCompaction = false;
  let summaryMessageId: string | null = null;
  let latest = null as {
    providerId: string | null;
    modelId: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    used: number;
  } | null;

  for (const row of rows) {
    const info = readJsonRecord(row.data);
    const role = readOptionalString(info?.role);
    const isCompactionSummary = role === 'assistant' && info?.summary === true;
    if (isCompactionSummary) {
      sawNewerCompaction = true;
      summaryMessageId = summaryMessageId ?? row.id;
      continue;
    }

    if (role !== 'assistant') {
      continue;
    }

    const tokens = readObjectRecord(info?.tokens);
    const used = readUsageNumber(tokens?.total);
    if (!tokens || used <= 0) {
      continue;
    }

    const cache = readObjectRecord(tokens.cache);
    const cacheReadTokens = readUsageNumber(cache?.read);
    const cacheWriteTokens = readUsageNumber(cache?.write);
    let providerId = readOptionalString(info?.providerID) ?? null;
    let modelId = readOptionalString(info?.modelID) ?? null;

    // Some rows carry the routed id as `provider/model`; split it so the
    // models.json lookup keys match the cache's per-provider sections.
    if (modelId?.includes('/')) {
      const [maybeProvider, ...modelParts] = modelId.split('/');
      providerId = providerId ?? maybeProvider;
      modelId = modelParts.join('/');
    }

    latest = {
      providerId,
      modelId,
      inputTokens: readUsageNumber(tokens.input) + cacheReadTokens + cacheWriteTokens,
      outputTokens: readUsageNumber(tokens.output) + readUsageNumber(tokens.reasoning),
      cacheReadTokens,
      cacheWriteTokens,
      used,
    };
    break;
  }

  if (!latest) {
    return sawNewerCompaction
      ? {
          compacted: true,
          summaryMessageId,
          providerId: null,
          modelId: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          used: 0,
        }
      : null;
  }

  return { compacted: sawNewerCompaction, summaryMessageId, ...latest };
};

/**
 * UTF-8 size of one message's text parts.
 *
 * After a compaction the summary's text *is* the conversation handed to the
 * next turn, so its size is the only honest "how big is the context now"
 * reading available before that turn reports real occupancy. The summary's own
 * `tokens` describe the summarization request (the context that was just
 * discarded), so they cannot be used. A database whose `part` table is missing
 * or unreadable simply yields 0.
 */
const readOpenCodeMessageTextBytes = (db: Database.Database, messageId: string): number => {
  let rows: { data: string }[];
  try {
    rows = db.prepare('SELECT data FROM part WHERE message_id = ?').all(messageId) as { data: string }[];
  } catch {
    return 0;
  }

  let bytes = 0;
  for (const row of rows) {
    const part = readJsonRecord(row.data);
    if (readOptionalString(part?.type) !== 'text') {
      continue;
    }
    const text = part?.text;
    if (typeof text === 'string') {
      bytes += Buffer.byteLength(text, 'utf8');
    }
  }

  return bytes;
};

/**
 * Context window for one provider/model pair, read from OpenCode's model
 * cache (`~/.cache/opencode/models.json`, models.dev data with
 * `limit.context`).
 *
 * The cache is multi-megabyte JSON that OpenCode rewrites on registry
 * refreshes, so the parsed window map is memoized by file identity (mtime +
 * size) and only re-read when that identity changes. Returns undefined when
 * the cache is missing, malformed, or carries no limit for the model.
 */
let openCodeContextWindowCache: { key: string; windows: Map<string, number> } | null = null;

const readOpenCodeContextWindow = (providerId: string, modelId: string): number | undefined => {
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
      const parsed = readJsonRecord(fsSync.readFileSync(cachePath, 'utf8'));
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
};

/**
 * Builds the context-usage answer for one OpenCode session: newest message
 * occupancy plus the model's context window when it can be resolved, with the
 * session-lifetime columns preserved as `cumulative` for the cost breakdown.
 *
 * Falls back to the cumulative columns unchanged for sessions whose messages
 * predate `tokens.total`.
 *
 * Right after a compaction the window carries `compacted: true` and no
 * occupancy: the newest record is the summary of the conversation that was
 * just replaced, so any number taken from it (or from the turns before it)
 * describes the context the user just got rid of. What CAN be measured is the
 * summary text itself, which is what the next turn feeds back in, so the
 * payload carries its byte size as `summaryBytes` until a real turn lands.
 *
 * Consumers: the sessions provider (`fetchHistory` / `getTokenUsage`) and the
 * runtime's end-of-turn token-budget frame.
 */
export function readOpenCodeContextUsage(
  db: Database.Database,
  sessionId: string,
): ProviderTokenUsageResult | undefined {
  const cumulative = aggregateOpenCodeSessionTokenUsage(db, sessionId) as ProviderTokenUsageResult | undefined;
  const latest = readLatestOpenCodeMessageUsage(db, sessionId);
  if (!latest) {
    return cumulative;
  }

  const contextWindow = latest.providerId && latest.modelId
    ? readOpenCodeContextWindow(latest.providerId, latest.modelId)
    : undefined;

  const cumulativePayload = cumulative
    ? {
        cumulative: {
          used: readUsageNumber(cumulative.used),
          inputTokens: readUsageNumber(cumulative.inputTokens),
          outputTokens: readUsageNumber(cumulative.outputTokens),
        },
      }
    : {};

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
    used: latest.used,
    ...(contextWindow ? { total: contextWindow } : {}),
    inputTokens: latest.inputTokens,
    outputTokens: latest.outputTokens,
    breakdown: { input: latest.inputTokens, output: latest.outputTokens },
    ...cumulativePayload,
  };
}
