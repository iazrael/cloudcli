import fsSync from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
  SubagentActivity,
  SubagentInfo,
  ProviderSessionUsageInput,
  ProviderTokenUsageResult,
} from '@/shared/types.js';
import {
  ProviderDisplayAssetError,
  compactProviderPayload,
  AppError,
  createNormalizedMessage,
  generateMessageId,
  hasVisibleText,
  normalizeProjectPath,
  normalizeProviderTimestamp,
  readObjectRecord,
  readJsonRecord,
  readOptionalString,
  readUsageNumber,
  removePathIfExists,
  sliceTailPage,
  truncateSubagentActivity,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

import {
  opencodeBackgroundWork,
  readBackgroundNotice,
  type OpenCodeBackgroundOutcome,
} from './opencode-background-work.js';
import { createOpenCodeCompactionFrame, formatToolOutput } from './opencode-event-translator.js';
import {
  getOpenCodeDatabasePath,
  openOpenCodeDatabase,
  readOpenCodeSessionIdleAt,
  readOpenCodeSessionTokenTotals,
  readOpenCodeSyntheticNoticeMetadata,
  resolveOpenCodeMessageLayout,
  resolveOpenCodeSessionTableName,
} from './opencode-data-root.js';
import {
  isOpenCodeSubagentTool,
  readSubagentChildSessionId,
  toAgentCardInput,
  toClientToolName,
} from './opencode-subagent.js';
import { isOpenCodeQuestionTool, toQuestionCardInput } from './opencode-question.js';

const PROVIDER = 'opencode';

/** OpenCode's tool for spawning a subagent; it runs in a child session of the caller. */
const SUBAGENT_TOOL_NAME = 'task';

/** Upper bound on how much of a subagent's timeline is sent to the client, as for Claude and Codex. */
const MAX_TRANSMITTED_SUBAGENT_ACTIVITIES = 200;

type OpenCodeHistoryRow = {
  message_id: string;
  message_time_created: number | null;
  message_data: string | null;
  part_id: string | null;
  part_time_created: number | null;
  part_data: string | null;
};

/**
 * What the history normalizer needs beyond the rows themselves: the open
 * database (a spawn call's child session is read from it) and the layout
 * that tells how to read that child.
 */
type OpenCodeHistoryContext = {
  db: Database.Database;
  layout: 'session_message' | 'message_part';
  /** The session being read, whose idle time says whether a call left `running` can still finish. */
  providerSessionId: string;
  /**
   * How each session's background work ended, by the engine's handle, read
   * once per session from the notices it persisted. Shared by reference with
   * the child sessions' contexts, so it is keyed by session.
   */
  backgroundOutcomes?: Map<string, OpenCodeSessionBackgroundRecord>;
};

/**
 * One session's background work as persisted: the notices of work that ended,
 * and when each agent was launched in the background, both by the engine's
 * handle. A notice belongs to the launch it follows and not to a later one.
 */
type OpenCodeSessionBackgroundRecord = {
  notices: Map<string, Array<{ outcome: OpenCodeBackgroundOutcome; at: number | null }>>;
  launches: Map<string, number[]>;
};

type OpenCodeTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const formatToolContent = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const extractText = (value: unknown): string => {
  if (typeof value === 'string') {
    return unwrapJsonStringLiteral(value);
  }

  const record = readObjectRecord(value);
  const text = readOptionalString(record?.text)
    ?? readOptionalString(record?.content)
    ?? '';
  return unwrapJsonStringLiteral(text);
};

const hasUserRole = (value: unknown): boolean => {
  const record = readObjectRecord(value);
  return readOptionalString(record?.role) === 'user';
};

// `opencode run --format json` nests each event's payload under `part`; older builds sent it flat.
const readEventPart = (raw: AnyRecord): AnyRecord => readObjectRecord(raw.part) ?? {};

// Error events carry an object (`{ name, data }`), not a string.
const readEventError = (value: unknown): string | undefined => {
  const record = readObjectRecord(value);
  if (!record) {
    return readOptionalString(value);
  }

  const data = readObjectRecord(record.data);
  const message = readOptionalString(data?.message) ?? readOptionalString(record.message);
  if (message) {
    return message;
  }

  const name = readOptionalString(record.name);
  const providerId = readOptionalString(data?.providerID) ?? readOptionalString(record.providerID);
  const modelId = readOptionalString(data?.modelID) ?? readOptionalString(record.modelID);
  if (providerId && modelId) {
    return `${name ?? 'Error'}: ${providerId}/${modelId}`;
  }

  const details = data ? JSON.stringify(data).slice(0, 200) : '';
  return [name, details].filter(Boolean).join(': ') || undefined;
};

const isUserTextEcho = (raw: AnyRecord): boolean => {
  return readOptionalString(raw.role) === 'user'
    || hasUserRole(raw.message)
    || hasUserRole(raw.part);
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

const readOpenCodeSessionColumnTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => buildTokenUsage(readOpenCodeSessionTokenTotals(db, sessionId) ?? undefined);

/**
 * Flattens v2 `session_message` rows into the (message, part) row shape the
 * history normalizer consumes.
 *
 * v2 event-sources one row per message and carries its content blocks inline
 * (`user` rows hold the prompt text; `assistant` rows hold a `content` array
 * of text/reasoning/tool blocks), so each row expands into one virtual
 * message plus one virtual part per block. A finished compaction becomes one
 * `compaction` part, so the notice the live stream showed stays after a
 * reload; idle, system and other rows carry no user-visible transcript
 * content and are skipped.
 */
function* flattenOpenCodeV2HistoryRows(
  db: Database.Database,
  sessionId: string,
): Generator<OpenCodeHistoryRow> {
  const messageRows = db.prepare(`
    SELECT id, type, time_created, time_updated, data
    FROM session_message
    WHERE session_id = ?
    ORDER BY seq
  `).iterate(sessionId) as Iterable<{
    id: string;
    type: string;
    time_created: number | null;
    time_updated: number | null;
    data: string;
  }>;

  for (const messageRow of messageRows) {
    if (messageRow.type === 'compaction') {
      // Only a finished compaction draws a row; one still running has none.
      const compaction = readJsonRecord(messageRow.data);
      const status = readOptionalString(compaction?.status);
      if (status === 'completed' || status === 'failed') {
        yield {
          message_id: messageRow.id,
          message_time_created: messageRow.time_created,
          message_data: JSON.stringify({ role: 'compaction' }),
          part_id: 'compaction',
          part_time_created: messageRow.time_updated ?? messageRow.time_created,
          part_data: JSON.stringify({
            type: 'compaction',
            status,
            reason: compaction?.reason ?? null,
            error: compaction?.error ?? null,
            summary: typeof compaction?.summary === 'string' ? compaction.summary : null,
          }),
        };
      }
      continue;
    }
    if (messageRow.type !== 'user' && messageRow.type !== 'assistant') {
      continue;
    }

    const data: AnyRecord = compactProviderPayload({ ...(readJsonRecord(messageRow.data) ?? {}), role: messageRow.type });
    // Part rows repeat the message payload (the v1 join did too) so the
    // normalizer can read the role off every row.
    const messageData = JSON.stringify({ role: messageRow.type, error: data.error ?? null });
    yield {
      message_id: messageRow.id,
      message_time_created: messageRow.time_created,
      message_data: messageData,
      part_id: null,
      part_time_created: null,
      part_data: null,
    };

    if (messageRow.type === 'user') {
      yield {
        message_id: messageRow.id,
        message_time_created: messageRow.time_created,
        message_data: messageData,
        part_id: `${messageRow.id}_text`,
        part_time_created: messageRow.time_created,
        part_data: JSON.stringify({ type: 'text', text: readOptionalString(data.text) ?? '' }),
      };
      continue;
    }

    const content = Array.isArray(data.content) ? data.content : [];
    // The SSE stream names a part `${messageID}_text_${ordinal}` /
    // `${messageID}_reasoning_${ordinal}`, where ordinal counts that type's
    // parts within the message (the engine initializes the counter per
    // message). Renumber blocks the same way so both transports name one
    // record identically — the timeline deduplicates on that id.
    let textOrdinal = 0;
    let reasoningOrdinal = 0;
    for (const [index, block] of content.entries()) {
      const blockRecord = readObjectRecord(block);
      if (!blockRecord) {
        continue;
      }

      const blockType = readOptionalString(blockRecord.type);
      let partData: Record<string, unknown> | null = null;
      let partId = `${messageRow.id}_${index}`;
      if (blockType === 'text' || blockType === 'reasoning') {
        partData = { type: blockType, text: readOptionalString(blockRecord.text) ?? '' };
        partId = blockType === 'text'
          ? `text_${textOrdinal++}`
          : `reasoning_${reasoningOrdinal++}`;
      } else if (blockType === 'tool') {
        partData = {
          type: 'tool',
          tool: readOptionalString(blockRecord.name) ?? readOptionalString(blockRecord.tool),
          callID: readOptionalString(blockRecord.id),
          state: blockRecord.state ?? {},
        };
      }
      if (!partData) {
        continue;
      }

      yield {
        message_id: messageRow.id,
        message_time_created: messageRow.time_created,
        message_data: messageData,
        part_id: partId,
        part_time_created: messageRow.time_updated ?? messageRow.time_created,
        part_data: JSON.stringify(partData),
      };
    }
  }
}

/**
 * OpenCode stores per-message token counts on assistant `message.data` objects
 * (see MessageV2.Assistant). Older DBs also had session-level counters; this
 * matches current `opencode.db` layouts that only persist message JSON.
 */
/**
 * When each agent of a v2 session was launched in the background, in order:
 * the assistant messages whose `subagent` call returned still running. The
 * message time is the call time the history reader uses for those calls.
 */
const readBackgroundAgentLaunchTimes = (
  db: Database.Database,
  sessionId: string,
): Array<{ childSessionId: string; at: number }> => {
  const rows = db.prepare(`
    SELECT time_created AS at, data FROM session_message
    WHERE session_id = ? AND type = 'assistant' AND data LIKE '%"subagent"%'
    ORDER BY seq
  `).all(sessionId) as Array<{ at: number | null; data: string }>;
  const launches: Array<{ childSessionId: string; at: number }> = [];
  for (const row of rows) {
    const content = readJsonRecord(row.data)?.content;
    if (!Array.isArray(content) || typeof row.at !== 'number') {
      continue;
    }
    for (const part of content) {
      const record = readObjectRecord(part);
      const state = readObjectRecord(record?.state);
      const metadata = readObjectRecord(state?.metadata);
      const childSessionId = readOptionalString(metadata?.sessionID);
      if (record?.type === 'tool' && isOpenCodeSubagentTool(readOptionalString(record.name) ?? '')
        && readOptionalString(metadata?.status) === 'running' && childSessionId) {
        launches.push({ childSessionId, at: row.at });
      }
    }
  }
  return launches;
};

const aggregateOpenCodeSessionTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const sessionColumnUsage = readOpenCodeSessionColumnTokenUsage(db, sessionId);
  if (sessionColumnUsage) {
    return sessionColumnUsage;
  }

  const rows = db.prepare('SELECT data FROM message WHERE session_id = ?').iterate(sessionId) as Iterable<{ data: string }>;

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

const readToolResult = (state: AnyRecord): SubagentActivity['toolResult'] => {
  const status = readOptionalString(state.status);
  if (status !== 'completed' && status !== 'error') {
    return null;
  }

  return {
    content: formatToolContent(state.output ?? state.error),
    isError: status === 'error',
  };
};

/**
 * Flattens the child session a `task` call spawned into the shared subagent
 * timeline. OpenCode keeps it in the same database as the parent.
 */
const readOpenCodeSubagentActivity = (
  db: Database.Database,
  childSessionId: string,
): SubagentActivity[] => {
  const rows = db.prepare(`
    SELECT p.data AS part_data, p.time_created AS part_time_created
    FROM part p
    INNER JOIN message m
      ON m.id = p.message_id
     AND m.session_id = p.session_id
    WHERE p.session_id = ?
      AND json_extract(m.data, '$.role') = 'assistant'
    ORDER BY COALESCE(m.time_created, 0), m.id, COALESCE(p.time_created, 0), p.id
  `).all(childSessionId) as { part_data: string | null; part_time_created: number | null }[];

  const activity: SubagentActivity[] = [];
  for (const row of rows) {
    const partData = readJsonRecord(row.part_data) ?? {};
    const timestamp = normalizeProviderTimestamp(row.part_time_created);
    const partType = readOptionalString(partData.type);

    if (partType === 'tool') {
      const state = readObjectRecord(partData.state) ?? {};
      activity.push({
        kind: 'tool',
        toolId: readOptionalString(partData.callID) ?? readOptionalString(partData.id),
        toolName: readOptionalString(partData.tool) ?? 'Tool',
        toolInput: state.input ?? {},
        toolResult: readToolResult(state),
        timestamp,
      });
      continue;
    }

    if (partType === 'text' || partType === 'reasoning') {
      const content = extractText(partData);
      if (content.trim()) {
        activity.push({ kind: partType === 'text' ? 'text' : 'thinking', content, timestamp });
      }
    }
  }

  return activity;
};

// The task tool wraps the subagent's answer as `<task …><task_result>…</task_result></task>`.
const TASK_OUTPUT_PATTERN = /<task_(result|error)>\n?([\s\S]*?)\n?<\/task_\1>/;

const unwrapTaskOutput = (content: string): string => {
  const match = TASK_OUTPUT_PATTERN.exec(content);
  return match ? match[2] : content;
};

/**
 * Turns a `task` tool row into a subagent container, the way Claude's `Agent`
 * rows are: identity from the call, timeline from the child session.
 *
 * `runIsLive` says whether a run of this session is still in progress: a task
 * without a result outside one was stopped and will never report.
 */
const attachOpenCodeSubagent = (
  message: NormalizedMessage,
  state: AnyRecord,
  db: Database.Database | null,
  runIsLive: boolean,
): void => {
  if (message.toolName !== SUBAGENT_TOOL_NAME) {
    return;
  }

  const input = readObjectRecord(state.input) ?? {};
  const metadata = readObjectRecord(state.metadata) ?? {};
  const childSessionId = readOptionalString(metadata.sessionId);
  const toolResult = message.toolResult;
  let status: SubagentInfo['status'] = runIsLive ? 'running' : 'stopped';
  if (metadata.interrupted === true) {
    status = 'stopped';
  } else if (toolResult) {
    status = toolResult.isError ? 'failed' : 'completed';
  }

  if (toolResult?.content) {
    toolResult.content = unwrapTaskOutput(toolResult.content);
  }

  const subagent: SubagentInfo = {
    id: childSessionId ?? message.toolId ?? message.id,
    type: readOptionalString(input.subagent_type),
    description: readOptionalString(input.description),
    status,
    model: readOptionalString(readObjectRecord(metadata.model)?.modelID),
  };

  if (db && childSessionId) {
    try {
      const activity = readOpenCodeSubagentActivity(db, childSessionId);
      if (activity.length > 0) {
        // Keep the latest steps: the timeline says the missing ones are the earlier ones.
        message.subagentTools = activity
          .slice(-MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)
          .map(truncateSubagentActivity);
        subagent.activityCount = activity.length;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to read subagent session ${childSessionId}:`, reason);
    }
  }

  message.subagent = subagent;
};

/** Opens the shared database for a live event, or null when it cannot be read right now. */
const openOpenCodeDatabaseForLiveEvent = (): Database.Database | null => {
  try {
    return openOpenCodeDatabase();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('[OpenCodeProvider] Failed to open opencode.db for a live event:', reason);
    return null;
  }
};

export class OpenCodeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes live `opencode run --format json` events into frontend messages.
   *
   * v2 wraps the payload in a `part` object (`{"type":"text","part":{type,
   * text}}`, `{"type":"tool_use","part":{type:"tool",tool,id,state}}`), while
   * v1 carried the fields on the event itself; both shapes are read.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(compactProviderPayload(rawMessage));
    if (!raw) {
      return [];
    }

    const part = readObjectRecord(raw.part);
    const partState = part ? readObjectRecord(part.state) : null;
    const type = readOptionalString(raw.type) ?? readOptionalString(raw.event);
    const eventSessionId = readOptionalString(raw.sessionID) ?? readOptionalString(raw.sessionId) ?? sessionId;
    const timestamp = normalizeProviderTimestamp(raw.time ?? raw.timestamp);
    const partMessageId = readOptionalString(part?.messageID);
    const partId = readOptionalString(part?.id);
    // Same id the history reader gives this part, so a reload does not duplicate it.
    const baseId = (partMessageId && partId ? `${partMessageId}_${partId}` : undefined)
      ?? readOptionalString(raw.id)
      ?? readOptionalString(raw.messageID)
      ?? readOptionalString(part?.id)
      ?? generateMessageId('opencode');

    if (type === 'text') {
      // The client already renders an optimistic user bubble, so provider user
      // echoes must not be streamed back as assistant text.
      if (isUserTextEcho(raw) || (part && isUserTextEcho(part))) {
        return [];
      }

      const content = extractText(raw.text ?? raw.delta ?? raw.message ?? part?.text);
      if (!hasVisibleText(content)) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_delta',
        content,
      })];
    }

    if (type === 'reasoning') {
      const content = extractText(raw.text ?? raw.delta ?? raw.message ?? part?.text);
      if (!hasVisibleText(content)) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'thinking',
        content,
      })];
    }

    if (type === 'tool_use') {
      const toolName = readOptionalString(raw.tool)
        ?? readOptionalString(raw.name)
        ?? readOptionalString(part?.tool)
        ?? 'Tool';
      const toolId = readOptionalString(raw.callID)
        ?? readOptionalString(raw.toolCallId)
        ?? readOptionalString(part?.id)
        ?? baseId;
      const output = raw.output ?? partState?.output;
      const error = raw.error ?? partState?.error;
      // v2 reports the tool's lifecycle on `state.status`; a finished state
      // carries the output/error the flat v1 fields would have had.
      const toolStatus = readOptionalString(partState?.status);
      const toolMessage = createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName,
        toolInput: raw.input ?? raw.arguments ?? partState?.input ?? part?.input ?? {},
        toolId,
      });

      if (output !== undefined || error !== undefined) {
        toolMessage.toolResult = {
          content: formatToolContent(output ?? error),
          isError: error !== undefined,
        };
      } else if (toolStatus === 'completed' || toolStatus === 'error') {
        toolMessage.toolResult = {
          content: formatToolContent(partState?.output ?? partState?.error),
          isError: toolStatus === 'error',
        };
      }

      if (toolName === SUBAGENT_TOOL_NAME) {
        // `opencode run` reports a task only once it has finished, so its
        // child session is complete in the database by now.
        const db = openOpenCodeDatabaseForLiveEvent();
        try {
          attachOpenCodeSubagent(toolMessage, partState ?? {}, db, true);
        } finally {
          db?.close();
        }
      }

      return [toolMessage];
    }

    if (type === 'error') {
      // v2 nests the detail (`{"type":"error","error":{type,message}}`); v1
      // carried a plain string.
      const errorRecord = readObjectRecord(raw.error);
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'error',
        content: readEventError(raw.error)
          ?? readOptionalString(errorRecord?.message)
          ?? readOptionalString(raw.message)
          ?? 'Unknown OpenCode error',
      })];
    }

    if (type === 'step_finish') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_end',
      })];
    }

    return [];
  }

  /**
   * Loads OpenCode history from the shared SQLite session database.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // OpenCode's shared sqlite database keys messages by the provider-native
    // session id, not the app-facing id this method is addressed with.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const db = openOpenCodeDatabase();
    if (!db) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const layout = resolveOpenCodeMessageLayout(db);
      if (!layout) {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      }

      // v2 keeps the per-session token totals on the session row; the v1
      // layout aggregates them from per-message rows instead.
      const rows = layout === 'session_message'
        ? flattenOpenCodeV2HistoryRows(db, providerSessionId)
        : this.readV1HistoryRows(db, providerSessionId);
      const tokenUsage = layout === 'session_message'
        ? buildTokenUsage(readOpenCodeSessionTokenTotals(db, providerSessionId) ?? undefined)
        : aggregateOpenCodeSessionTokenUsage(db, providerSessionId);

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const capacity = normalizedLimit === null ? Infinity : normalizedOffset + normalizedLimit;
      const window: NormalizedMessage[] = [];
      let total = 0;
      let head = 0;
      for (const message of this.normalizeHistoryRows(rows, sessionId, { db, layout, providerSessionId, backgroundOutcomes: new Map() })) {
        total += 1;
        if (capacity === 0) continue;
        if (window.length < capacity) window.push(message);
        else { window[head] = message; head = (head + 1) % capacity; }
      }
      const ordered = head === 0 ? window : [...window.slice(head), ...window.slice(0, head)];
      const { page } = sliceTailPage(ordered, normalizedLimit, normalizedOffset);
      const hasMore = normalizedLimit !== null && total > normalizedOffset + normalizedLimit;

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      if (error instanceof ProviderDisplayAssetError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    } finally {
      db.close();
    }
  }

  /** The v1 message+part layout query, kept for databases predating v2. */
  private readV1HistoryRows(db: Database.Database, providerSessionId: string): Iterable<OpenCodeHistoryRow> {
    return db.prepare(`
      SELECT
        m.id AS message_id,
        m.time_created AS message_time_created,
        m.data AS message_data,
        p.id AS part_id,
        p.time_created AS part_time_created,
        p.data AS part_data
      FROM message m
      LEFT JOIN part p
        ON p.session_id = m.session_id
       AND p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY
        COALESCE(m.time_created, 0),
        m.id,
        COALESCE(p.time_created, 0),
        p.id
    `).iterate(providerSessionId) as Iterable<OpenCodeHistoryRow>;
  }

  private *normalizeHistoryRows(
    rows: Iterable<OpenCodeHistoryRow>,
    sessionId: string,
    context: OpenCodeHistoryContext,
  ): Generator<NormalizedMessage> {
    let rowOrdinal = 0;
    const emittedMessageErrors = new Set<string>();

    for (const row of rows) {
      const timestamp = normalizeProviderTimestamp(row.part_time_created ?? row.message_time_created);
      const baseId = `${row.message_id}_${row.part_id ?? rowOrdinal++}`;
      const messageInfo = compactProviderPayload(readJsonRecord(row.message_data));
      const messageRole = readOptionalString(messageInfo?.role);

      if (
        messageInfo
        && messageRole === 'assistant'
        && messageInfo.error != null
        && !emittedMessageErrors.has(row.message_id)
      ) {
        emittedMessageErrors.add(row.message_id);
        yield createNormalizedMessage({
          id: `${baseId}_error`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'error',
          content: formatToolContent(messageInfo.error),
        });
      }

      if (!row.part_id) {
        continue;
      }

      const rawPartData = readJsonRecord(row.part_data);
      const partData = compactProviderPayload(rawPartData && messageRole === 'user' ? { ...rawPartData, role: 'user' } : rawPartData) ?? {};
      const partType = readOptionalString(partData.type);
      if (!partType) {
        continue;
      }

      if (partType === 'text') {
        const rawContent = extractText(partData);
        // User prompts sent with attachments carry an <images_input> path
        // list; strip it for display and surface the paths as images.
        const parsedImages = messageRole === 'user'
          ? parseImagesInputTag(rawContent)
          : { text: rawContent, attachments: [] };
        const parsedFiles = messageRole === 'user'
          ? parseFilesInputTag(parsedImages.text)
          : { text: rawContent, attachments: [] };
        if (
          hasVisibleText(parsedFiles.text)
          || parsedImages.attachments.length > 0
          || parsedFiles.attachments.length > 0
        ) {
          yield createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: messageRole === 'user' ? 'user' : 'assistant',
            content: parsedFiles.text,
            images: parsedImages.attachments.length > 0 ? parsedImages.attachments : undefined,
            files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
          });
        }
        continue;
      }

      if (partType === 'reasoning') {
        const content = extractText(partData);
        if (hasVisibleText(content)) {
          yield createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'thinking',
            content,
          });
        }
        continue;
      }

      if (partType === 'tool') {
        const state = readObjectRecord(partData.state) ?? {};
        const status = readOptionalString(state.status);
        const engineToolName = readOptionalString(partData.tool) ?? 'Tool';
        const isSubagent = isOpenCodeSubagentTool(engineToolName);
        const engineInput = state.input ?? partData.input ?? {};
        const toolMessage = createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: toClientToolName(engineToolName),
          toolInput: isSubagent
            ? toAgentCardInput(engineInput)
            : isOpenCodeQuestionTool(engineToolName) ? toQuestionCardInput(engineInput, state.metadata) : engineInput,
          toolId: readOptionalString(partData.callID) ?? row.part_id,
        });

        if (status === 'completed' || status === 'error') {
          // v1 states carry the output as a string; v2 states carry result
          // blocks under `content`.
          const output = state.output ?? (state.content === undefined ? undefined : formatToolOutput(state.content));
          toolMessage.toolResult = {
            content: formatToolContent(output ?? state.error),
            isError: status === 'error',
          };
        }

        if (isSubagent) {
          this.attachSubagent(toolMessage, state, engineInput, row.part_time_created ?? row.message_time_created, context);
        }

        yield toolMessage;
        continue;
      }

      if (partType === 'compaction') {
        yield createOpenCodeCompactionFrame({
          inputId: row.message_id,
          sessionId,
          timestamp,
          phase: partData.status === 'failed' ? 'failed' : 'done',
          reason: partData.reason,
          error: partData.error,
        });
        // The summary the compaction wrote, which the client folds into the row.
        const summary = readOptionalString(partData.summary);
        if (summary && hasVisibleText(summary)) {
          yield createNormalizedMessage({
            id: `${row.message_id}_summary`,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: summary,
            isCompactSummary: true,
          });
        }
        continue;
      }

      if (partType === 'step-finish') {
        yield createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'stream_end',
        });
        continue;
      }

      // An `agent` part is the user's @-mention of an agent, not a spawn (the
      // prompt text already holds the mention), so it draws nothing.
      if (partType === 'patch') {
        yield createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: 'Patch',
          toolInput: partData,
          toolId: row.part_id,
        });
      }
    }

  }

  /**
   * Publishes a spawn call's outcome and its child session's work on its
   * `Agent` row.
   *
   * The call's own status is the agent's outcome (`completed`, `error`). A
   * call persisted as `pending` or `running` can only still be running while
   * the session has a run in flight; once the session is idle the run that
   * owned the call is gone and the agent can never finish, so it reads as
   * `stopped`.
   *
   * A call launched in the background is persisted `completed` the moment it
   * returns, with its metadata still saying `running`; that only says the
   * agent started. Its outcome is the notice the engine persisted when the
   * agent ended; with no notice yet it runs while the runtime still tracks
   * it, and is `stopped` once nothing does.
   */
  private attachSubagent(
    toolMessage: NormalizedMessage,
    state: AnyRecord,
    engineInput: unknown,
    callTime: number | null,
    context: OpenCodeHistoryContext,
  ): void {
    const input = readObjectRecord(engineInput);
    const childSessionId = readSubagentChildSessionId(state.metadata)
      ?? readOptionalString(input?.sessionID);
    const agentType = readOptionalString(input?.agent);
    const description = readOptionalString(input?.description);
    const subagent: SubagentInfo = {
      id: childSessionId ?? String(toolMessage.toolId),
      name: agentType,
      type: agentType,
      description,
      status: childSessionId && readOptionalString(readObjectRecord(state.metadata)?.status) === 'running'
        && readOptionalString(state.status) === 'completed'
        ? this.resolveBackgroundSubagentStatus(childSessionId, callTime, context)
        : this.resolveSubagentStatus(readOptionalString(state.status), callTime, context),
    };

    if (childSessionId) {
      const activity = this.readChildSessionActivity(childSessionId, context);
      if (activity.length > 0) {
        toolMessage.subagentTools = activity.map(truncateSubagentActivity);
        subagent.activityCount = activity.length;
      }
    }
    toolMessage.subagent = subagent;
  }

  /**
   * A resumed agent keeps its child session id, so this call's outcome is the
   * first notice written after it launched the agent and before the next
   * call launched it again. Without one the agent runs while the runtime
   * still tracks it (only the latest launch can be running), else it is lost.
   */
  private resolveBackgroundSubagentStatus(
    childSessionId: string,
    callTime: number | null,
    context: OpenCodeHistoryContext,
  ): SubagentInfo['status'] {
    const record = this.readBackgroundRecord(context);
    const nextLaunch = callTime === null
      ? undefined
      : (record.launches.get(childSessionId) ?? []).find((launchedAt) => launchedAt > callTime);
    const notice = (record.notices.get(childSessionId) ?? []).find((entry) => entry.at === null || callTime === null
      || (entry.at >= callTime && (nextLaunch === undefined || entry.at < nextLaunch)));
    if (notice) {
      return notice.outcome;
    }
    return nextLaunch === undefined && opencodeBackgroundWork.has(childSessionId) ? 'running' : 'stopped';
  }

  private readBackgroundRecord(context: OpenCodeHistoryContext): OpenCodeSessionBackgroundRecord {
    const cache = context.backgroundOutcomes ?? new Map<string, OpenCodeSessionBackgroundRecord>();
    context.backgroundOutcomes = cache;
    const cached = cache.get(context.providerSessionId);
    if (cached) {
      return cached;
    }
    const record: OpenCodeSessionBackgroundRecord = { notices: new Map(), launches: new Map() };
    for (const { metadata, createdAt } of readOpenCodeSyntheticNoticeMetadata(context.db, context.providerSessionId)) {
      const notice = readBackgroundNotice(metadata);
      if (notice) {
        const list = record.notices.get(notice.taskId) ?? [];
        list.push({ outcome: notice.outcome, at: createdAt });
        record.notices.set(notice.taskId, list);
      }
    }
    if (context.layout === 'session_message') {
      for (const launch of readBackgroundAgentLaunchTimes(context.db, context.providerSessionId)) {
        const list = record.launches.get(launch.childSessionId) ?? [];
        list.push(launch.at);
        record.launches.set(launch.childSessionId, list);
      }
    }
    cache.set(context.providerSessionId, record);
    return record;
  }

  private resolveSubagentStatus(
    callStatus: string | undefined,
    callTime: number | null,
    context: OpenCodeHistoryContext,
  ): SubagentInfo['status'] {
    if (callStatus === 'completed') {
      return 'completed';
    }
    if (callStatus === 'error') {
      return 'failed';
    }
    const idleAt = readOpenCodeSessionIdleAt(context.db, context.providerSessionId);
    // `undefined`: this database cannot say whether a run is in flight, so a
    // call left unresolved is not claimed to be running. `null`: a run is
    // still in flight. A number: the session went idle at that time, which
    // ends every call begun before it.
    const stillInFlight = idleAt === null || (idleAt !== undefined && (callTime ?? 0) > idleAt);
    return stillInFlight ? 'running' : 'stopped';
  }

  /** The child session's text, reasoning and tool calls as a subagent timeline. */
  private readChildSessionActivity(childSessionId: string, context: OpenCodeHistoryContext): SubagentActivity[] {
    const rows = context.layout === 'session_message'
      ? flattenOpenCodeV2HistoryRows(context.db, childSessionId)
      : this.readV1HistoryRows(context.db, childSessionId);
    const activity: SubagentActivity[] = [];
    for (const message of this.normalizeHistoryRows(rows, childSessionId, { ...context, providerSessionId: childSessionId })) {
      if (message.kind === 'tool_use') {
        activity.push({
          kind: 'tool',
          timestamp: message.timestamp,
          toolId: message.toolId,
          toolName: message.toolName,
          toolInput: message.toolInput,
          toolResult: message.toolResult ?? null,
        });
      } else if (message.kind === 'text' && message.role !== 'user') {
        activity.push({ kind: 'text', timestamp: message.timestamp, content: message.content });
      } else if (message.kind === 'thinking') {
        activity.push({ kind: 'thinking', timestamp: message.timestamp, content: message.content });
      }
    }
    return activity;
  }

  /**
   * Reads the token usage recorded on the session row's token columns.
   *
   * Consumer: the provider token-usage service. Databases predating the token
   * columns answer with an explicit unsupported result; a database or session
   * row that cannot be found is a 404.
   */
  async getTokenUsage(input: ProviderSessionUsageInput): Promise<ProviderTokenUsageResult> {
    const databasePath = getOpenCodeDatabasePath();
    if (!fsSync.existsSync(databasePath)) {
      throw new AppError('OpenCode database was not found.', {
        code: 'OPENCODE_DATABASE_NOT_FOUND',
        statusCode: 404,
      });
    }

    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const table = resolveOpenCodeSessionTableName(database);
      const requiredColumns = [
        'tokens_input',
        'tokens_output',
        'tokens_reasoning',
        'tokens_cache_read',
        'tokens_cache_write',
      ];
      const columnNames = new Set(
        table
          ? (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
          : [],
      );

      if (!table || !requiredColumns.every((column) => columnNames.has(column))) {
        return {
          used: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
          unsupported: true,
          message: 'Token usage tracking is not available in this OpenCode database schema',
        };
      }

      const row = database.prepare(`
        SELECT
          tokens_input AS inputTokens,
          tokens_output AS outputTokens,
          tokens_reasoning AS reasoningTokens,
          tokens_cache_read AS cacheReadTokens,
          tokens_cache_write AS cacheWriteTokens
        FROM ${table}
        WHERE id = ?
      `).get(input.nativeSessionId) as OpenCodeTokenTotals | undefined;

      if (!row) {
        throw new AppError('OpenCode session was not found.', {
          code: 'OPENCODE_SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      const inputTokens = readUsageNumber(row.inputTokens) + readUsageNumber(row.cacheReadTokens);
      const outputTokens = readUsageNumber(row.outputTokens);
      const used = readUsageNumber(row.inputTokens)
        + outputTokens
        + readUsageNumber(row.reasoningTokens)
        + readUsageNumber(row.cacheReadTokens)
        + readUsageNumber(row.cacheWriteTokens);

      return {
        used,
        inputTokens,
        outputTokens,
        breakdown: { input: inputTokens, output: outputTokens },
      };
    } finally {
      database.close();
    }
  }

  /**
   * Cleans up OpenCode native storage (SQLite session row and jsonl file if any).
   */
  async cleanupSession(nativeSessionId: string, jsonlPath?: string | null): Promise<boolean> {
    let removed = false;
    if (jsonlPath) {
      if (await removePathIfExists(jsonlPath)) {
        removed = true;
      }
    }
    const openCodeDbPath = getOpenCodeDatabasePath();
    if (fsSync.existsSync(openCodeDbPath)) {
      let db: Database.Database | null = null;
      try {
        db = new Database(openCodeDbPath);
        const table = resolveOpenCodeSessionTableName(db);
        const res = table
          ? db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(nativeSessionId)
          : { changes: 0 };
        if (res.changes > 0) {
          removed = true;
        }
      } catch (err) {
        console.warn('[OpenCodeSessions] Failed to delete OpenCode session row:', err);
      } finally {
        if (db) {
          db.close();
        }
      }
    }
    return removed;
  }

  /**
   * Cleans up OpenCode project storage from SQLite database.
   */
  async cleanupProjectStorage(projectPath: string): Promise<void> {
    const normalizedPath = normalizeProjectPath(projectPath);
    if (!normalizedPath || normalizedPath === path.parse(normalizedPath).root) {
      return;
    }
    const openCodeDbPath = getOpenCodeDatabasePath();
    if (fsSync.existsSync(openCodeDbPath)) {
      let db: Database.Database | null = null;
      try {
        db = new Database(openCodeDbPath);
        const table = resolveOpenCodeSessionTableName(db);
        if (table) {
          db.prepare(`DELETE FROM ${table} WHERE directory = ?`).run(normalizedPath);
        }
      } catch (err) {
        console.warn('[OpenCodeSessions] Failed to clean up OpenCode project sessions:', err);
      } finally {
        if (db) {
          db.close();
        }
      }
    }
  }
}
