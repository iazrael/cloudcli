/**
 * ZCode Context Usage
 *
 * Reads "how full is the context window right now" for one ZCode session out of
 * the engine's own SQLite store.
 *
 * Both the history reader (`zcode-sessions.provider.ts`) and the runtime's live
 * badge refresh (`zcode-runtime.provider.ts`) consume this, so the counter a
 * running turn pushes and the one a reloaded transcript shows can never
 * disagree.
 *
 * @module zcode-context-usage
 */

import type Database from 'better-sqlite3';

import type { ProviderTokenUsageResult } from '@/shared/types.js';
import {
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
  readUsageNumber,
} from '@/shared/utils.js';

import { readZCodeTokenUsedCount } from './zcode-live-event-normalizer.js';
import { resolveZCodeModelContextWindow } from './zcode-models.provider.js';

/** One persisted step's numbers, normalized across the two stored shapes. */
type ZCodeStepTotals = {
  /** Prompt side as the engine counts it: for the persisted shape this already contains the cache reads. */
  inputTokens: number;
  /** Generated text, reasoning included (the split the `/cost` breakdown shows). */
  outputTokens: number;
  /**
   * What the context window held for this step: the engine's own `total` when it
   * is stored, otherwise the sum of the parts. Cache reads are never added on
   * top — the persisted prompt already carries them (a row reporting
   * `input: 169340` next to `cache.read: 169088` describes one prompt, not two).
   */
  used: number;
};

type ZCodeSessionTotals = {
  inputTokens: number;
  outputTokens: number;
  used: number;
};

/**
 * Reads one `message.data.tokens` record into step totals.
 *
 * Two shapes reach the store: the component shape (`{input, output, reasoning,
 * cache: {read, write}}`) and the additive streaming shape (`{inputTokens,
 * outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens}`), where the
 * cache counters sit outside the prompt. `total` is the engine's own occupancy
 * reading and wins whenever a row carries it. Returns null for a record with no
 * numbers at all — an in-flight step, which must never read as "0 tokens used".
 */
function readZCodeStepTotals(value: unknown): ZCodeStepTotals | null {
  const tokens = readObjectRecord(value);
  if (!tokens) {
    return null;
  }

  const isStreamingShape = tokens.inputTokens !== undefined
    || tokens.outputTokens !== undefined
    || tokens.cacheReadTokens !== undefined;
  const inputTokens = isStreamingShape
    ? readUsageNumber(tokens.inputTokens)
    : readUsageNumber(tokens.input);
  const generationTokens = isStreamingShape
    ? readUsageNumber(tokens.outputTokens) + readUsageNumber(tokens.reasoningTokens)
    : readUsageNumber(tokens.output) + readUsageNumber(tokens.reasoning);
  const additiveFallback = isStreamingShape
    ? readZCodeTokenUsedCount(tokens) ?? 0
    : inputTokens + generationTokens;
  const used = readUsageNumber(tokens.total) || additiveFallback;

  if (used <= 0 && inputTokens <= 0 && generationTokens <= 0) {
    return null;
  }

  return { inputTokens, outputTokens: generationTokens, used };
}

/**
 * Session-lifetime totals from every `message.data.tokens` row of a session.
 *
 * Summing the whole transcript is only meaningful as a spend figure: each row
 * carries its own request's prompt, so the same prefix is counted once per
 * turn. Never report this as current occupancy — see
 * `readZCodeLatestMessageUsage`.
 */
function readZCodeSessionCumulativeUsage(
  db: Database.Database,
  sessionId: string,
): ZCodeSessionTotals | undefined {
  const rows = db.prepare('SELECT data FROM message WHERE session_id = ?').all(sessionId) as { data: string }[];

  const totals: ZCodeSessionTotals = { inputTokens: 0, outputTokens: 0, used: 0 };
  let hasAnyUsage = false;

  for (const row of rows) {
    const step = readZCodeStepTotals(readJsonRecord(row.data)?.tokens);
    if (!step) {
      continue;
    }

    hasAnyUsage = true;
    totals.inputTokens += step.inputTokens;
    totals.outputTokens += step.outputTokens;
    totals.used += step.used;
  }

  return hasAnyUsage ? totals : undefined;
}

/**
 * Latest per-step context occupancy of one ZCode session.
 *
 * Every assistant row stores the request that produced it on
 * `message.data.tokens`, and `tokens.total` is that request's whole prompt plus
 * output — i.e. what the context window held when that step ran. Only the newest
 * non-zero record matters; the per-message `input`/`output` split is carried
 * along for the `/cost` breakdown.
 *
 * Compaction summaries (a `summary` object on the message) are skipped: their
 * numbers describe the conversation that was just replaced. When such a summary
 * is the newest record, `compacted` is set — the engine only learns the
 * post-compaction occupancy once the next step runs, so there is no honest
 * number to report yet.
 */
function readZCodeLatestMessageUsage(
  db: Database.Database,
  sessionId: string,
): {
  compacted: boolean;
  /** Id of the newest compaction summary, whose text is the post-compaction context. */
  summaryMessageId: string | null;
  /** `providerId/modelId` of the step, used to resolve the model's context window. */
  modelKey: string | null;
  totals: ZCodeStepTotals;
} | null {
  const rows = db
    .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC, sequence DESC')
    .all(sessionId) as { id: string; data: string }[];

  // Rows are newest-first, so any summary seen before the first usable
  // assistant record is newer than it: compaction is the session's tip.
  let sawNewerCompaction = false;
  let summaryMessageId: string | null = null;
  let latest = null as { modelKey: string | null; totals: ZCodeStepTotals } | null;

  for (const row of rows) {
    const info = readJsonRecord(row.data);
    if (readObjectRecord(info?.summary)) {
      sawNewerCompaction = true;
      summaryMessageId = summaryMessageId ?? row.id;
      continue;
    }

    if (readOptionalString(info?.role) !== 'assistant') {
      continue;
    }

    const totals = readZCodeStepTotals(info?.tokens);
    if (!totals || totals.used <= 0) {
      continue;
    }

    latest = { modelKey: readMessageModelKey(info), totals };
    break;
  }

  if (!latest) {
    return sawNewerCompaction
      ? {
          compacted: true,
          summaryMessageId,
          modelKey: null,
          totals: { inputTokens: 0, outputTokens: 0, used: 0 },
        }
      : null;
  }

  return { compacted: sawNewerCompaction, summaryMessageId, ...latest };
}

/**
 * Provider-native model key of one message row.
 *
 * Assistant rows carry flat `providerId`/`modelId` fields; user rows carry the
 * selection as `model.{providerID, modelID}`. Rows that only know one half still
 * resolve their window through the bare-model lookup.
 */
function readMessageModelKey(info: Record<string, unknown> | null): string | null {
  const modelSelection = readObjectRecord(info?.model);
  const providerId = readOptionalString(info?.providerId)
    ?? readOptionalString(modelSelection?.providerID)
    ?? readOptionalString(modelSelection?.providerId);
  const modelId = readOptionalString(info?.modelId)
    ?? readOptionalString(info?.modelID)
    ?? readOptionalString(modelSelection?.modelID)
    ?? readOptionalString(modelSelection?.modelId);

  if (!modelId) {
    return null;
  }
  return providerId ? `${providerId}/${modelId}` : modelId;
}

/**
 * UTF-8 size of one message's text parts.
 *
 * The compaction summary's text *is* the conversation handed to the next step,
 * so its size is the only honest "how big is the context now" reading available
 * before the next step reports real occupancy. A database whose `part` table is
 * missing or unreadable simply yields 0.
 */
function readZCodeMessageTextBytes(db: Database.Database, messageId: string): number {
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
}

/**
 * Builds the context-usage answer for one ZCode session: the newest step's
 * occupancy, the model's declared context window when it can be resolved, and
 * the session-lifetime totals preserved as `cumulative` for the cost breakdown.
 *
 * A transcript with no usable per-step record reports nothing at all
 * (`undefined`) rather than its lifetime totals: a spend figure masquerading as
 * occupancy is exactly the misreading this module exists to remove.
 *
 * Right after a compaction the window carries `compacted: true` and no
 * occupancy: the newest record is the summary of the conversation that was just
 * replaced, so any number taken from it describes the context the user got rid
 * of. What CAN be measured is the summary text itself — the size of what the
 * next step feeds back in — so the payload carries its byte size as
 * `summaryBytes` until a real step lands.
 *
 * Consumers: the sessions provider (`fetchHistory` / `getTokenUsage`) and the
 * runtime's mid-turn token-budget frame.
 */
export function readZCodeContextUsage(
  db: Database.Database,
  sessionId: string,
): ProviderTokenUsageResult | undefined {
  const cumulativeTotals = readZCodeSessionCumulativeUsage(db, sessionId);
  const latest = readZCodeLatestMessageUsage(db, sessionId);
  if (!latest) {
    return undefined;
  }

  const contextWindow = latest.modelKey
    ? resolveZCodeModelContextWindow(latest.modelKey)
    : undefined;

  const cumulativePayload = cumulativeTotals
    ? { cumulative: { ...cumulativeTotals } }
    : {};

  if (latest.compacted) {
    const summaryBytes = latest.summaryMessageId
      ? readZCodeMessageTextBytes(db, latest.summaryMessageId)
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
    used: latest.totals.used,
    ...(contextWindow ? { total: contextWindow } : {}),
    inputTokens: latest.totals.inputTokens,
    outputTokens: latest.totals.outputTokens,
    breakdown: { input: latest.totals.inputTokens, output: latest.totals.outputTokens },
    ...cumulativePayload,
  };
}
