import fsSync from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
  ProviderSessionUsageInput,
  ProviderTokenUsageResult,
} from '@/shared/types.js';
import {
  AppError,
  createNormalizedMessage,
  generateMessageId,
  normalizeProjectPath,
  normalizeProviderTimestamp,
  readObjectRecord,
  readJsonRecord,
  readOptionalString,
  removePathIfExists,
  sliceTailPage,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

import { readOpenCodeContextUsage } from './opencode-context-usage.js';
import { getOpenCodeDatabasePath } from './opencode-data-root.js';
import {
  acquireOpenCodeServer,
  releaseOpenCodeServer,
  revertOpenCodeSession,
} from './opencode-server.client.js';

const PROVIDER = 'opencode';

type OpenCodeHistoryRow = {
  message_id: string;
  message_time_created: number | null;
  message_data: string | null;
  part_id: string | null;
  part_time_created: number | null;
  part_data: string | null;
};

const openOpenCodeDatabase = (): Database.Database | null => {
  const dbPath = getOpenCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  return new Database(dbPath, { readonly: true, fileMustExist: true });
};

/**
 * Provider message ids of one session, oldest first. Used by the edit flow to
 * turn an anchor into the message OpenCode must revert to.
 */
const readOpenCodeMessageIds = (db: Database.Database, providerSessionId: string): string[] => {
  const rows = db.prepare(`
    SELECT id
    FROM message
    WHERE session_id = ?
    ORDER BY COALESCE(time_created, 0), id
  `).all(providerSessionId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
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

/**
 * Reads the human-readable text out of one live OpenCode error event.
 *
 * `opencode run --format json` serializes provider failures as
 * `{ type: 'error', error: { name, data: { message, ref } } }`, so the message
 * is nested two levels down; the older flat `{ error: '...' }` /
 * `{ message: '...' }` shapes still occur. Without the nested lookup every
 * failure degraded to the generic fallback, hiding causes like "Model not
 * found".
 */
const extractErrorMessage = (raw: AnyRecord): string => {
  const errorRecord = readObjectRecord(raw.error);
  return readOptionalString(errorRecord?.message)
    ?? readOptionalString(readObjectRecord(errorRecord?.data)?.message)
    ?? readOptionalString(errorRecord?.name)
    ?? readOptionalString(raw.error)
    ?? readOptionalString(raw.message)
    ?? 'Unknown OpenCode error';
};

const isUserTextEcho = (raw: AnyRecord): boolean => {
  return readOptionalString(raw.role) === 'user'
    || hasUserRole(raw.message)
    || hasUserRole(raw.part);
};

/**
 * The cross-transport identity of one OpenCode assistant text row.
 *
 * A persisted row is named `(message_id, part_id)`, but the live stream never
 * names a row: assistant text arrives as `message.part.delta` fragments the
 * client accumulates into a bubble of its own, so the two paths cannot be
 * joined on `id`. The part id is what both sides do carry — one text part is
 * one transcript row on both — so it becomes the row key and the client
 * reconciles the streamed body against the persisted one through it.
 *
 * Keying per part rather than per message matters: a turn that writes text,
 * calls a tool, then writes more text persists two text rows, and one shared
 * key for both would be ambiguous and reconcile neither.
 *
 * Consumers: `normalizeMessage` (live deltas, keyed off the envelope's
 * `partID`) and `normalizeHistoryRows` (persisted rows). Both must derive the
 * key the same way or the streamed reply renders beside its persisted copy.
 */
function buildOpenCodeTextRowKey(partId: string): string {
  return `opencode-part:${partId}`;
}

export class OpenCodeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes live OpenCode events into frontend messages.
   *
   * The runtime now drives the server's event stream instead of
   * `opencode run --format json`, but it translates each server event back onto
   * these same envelopes (`text` / `reasoning` / `tool_use` / `step_finish` /
   * `error`) so history and live output keep sharing one normalizer.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const type = readOptionalString(raw.type) ?? readOptionalString(raw.event);
    const eventSessionId = readOptionalString(raw.sessionID) ?? readOptionalString(raw.sessionId) ?? sessionId;
    const timestamp = normalizeProviderTimestamp(raw.time ?? raw.timestamp);
    const baseId = readOptionalString(raw.id)
      ?? readOptionalString(raw.messageID)
      ?? generateMessageId('opencode');

    if (type === 'text') {
      // The client already renders an optimistic user bubble, so provider user
      // echoes must not be streamed back as assistant text.
      if (isUserTextEcho(raw)) {
        return [];
      }

      const content = extractText(raw.text ?? raw.delta ?? raw.message);
      if (!content.trim()) {
        return [];
      }

      // The runtime names the streaming part on the envelope. An emitter
      // that does not (the older `opencode run --format json` lines) leaves
      // the row unkeyed rather than invent a key nothing could match.
      const partId = readOptionalString(raw.partID);

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_delta',
        content,
        transcriptAnchorId: readOptionalString(raw.messageID) ?? undefined,
        ...(partId ? { providerRowKey: buildOpenCodeTextRowKey(partId) } : {}),
      })];
    }

    if (type === 'reasoning') {
      const content = extractText(raw.text ?? raw.delta ?? raw.message);
      if (!content.trim()) {
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
      // `opencode run --format json` envelopes the line as
      // `{ type, timestamp, sessionID, part }`: the tool name and call id sit
      // on the part, the arguments and outcome under `part.state`. Reading
      // them off the line itself labeled every live call "Tool" with empty
      // parameters, no result and no call id — the transcript then stacked
      // unlabeled "Running" cards. Flat emitters put the fields on the line,
      // so the line stays the fallback.
      const part = readObjectRecord(raw.part) ?? raw;
      const state = readObjectRecord(part.state) ?? {};
      const toolName = readOptionalString(part.tool) ?? readOptionalString(part.name) ?? 'Tool';
      const toolId = readOptionalString(part.callID)
        ?? readOptionalString(part.toolCallId)
        ?? baseId;
      const toolMessage = createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName,
        toolInput: state.input ?? part.input ?? raw.arguments ?? {},
        toolId,
      });

      const status = readOptionalString(state.status);
      const output = state.output ?? part.output;
      const error = state.error ?? part.error;
      if (status === 'completed' || status === 'error' || output !== undefined || error !== undefined) {
        toolMessage.toolResult = {
          content: formatToolContent(output ?? error),
          isError: status === 'error' || error !== undefined,
        };
      }

      return [toolMessage];
    }

    if (type === 'error') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'error',
        content: extractErrorMessage(raw),
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
      const rows = db.prepare(`
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
      `).all(providerSessionId) as OpenCodeHistoryRow[];

      const normalized = this.normalizeHistoryRows(rows, sessionId);
      const tokenUsage = readOpenCodeContextUsage(db, providerSessionId);

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    } finally {
      db.close();
    }
  }

  private normalizeHistoryRows(rows: OpenCodeHistoryRow[], sessionId: string): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    const emittedMessageErrors = new Set<string>();

    for (const row of rows) {
      const timestamp = normalizeProviderTimestamp(row.part_time_created ?? row.message_time_created);
      const baseId = `${row.message_id}_${row.part_id ?? normalized.length}`;
      const messageInfo = readJsonRecord(row.message_data);
      const messageRole = readOptionalString(messageInfo?.role);

      if (
        messageInfo
        && messageRole === 'assistant'
        && messageInfo.error != null
        && !emittedMessageErrors.has(row.message_id)
      ) {
        emittedMessageErrors.add(row.message_id);
        normalized.push(createNormalizedMessage({
          id: `${baseId}_error`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'error',
          content: formatToolContent(messageInfo.error),
        }));
      }

      if (!row.part_id) {
        continue;
      }

      const partData = readJsonRecord(row.part_data) ?? {};
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
          parsedFiles.text.trim()
          || parsedImages.attachments.length > 0
          || parsedFiles.attachments.length > 0
        ) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: messageRole === 'user' ? 'user' : 'assistant',
            content: parsedFiles.text,
            images: parsedImages.attachments.length > 0 ? parsedImages.attachments : undefined,
            files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
            transcriptAnchorId: row.message_id,
            // The live stream never names this row — it sends deltas under the
            // part id — so the part id is the only identity the two paths
            // share. Without it the streamed reply and this row are two rows
            // nothing but their text could relate.
            ...(messageRole === 'user' ? {} : { providerRowKey: buildOpenCodeTextRowKey(row.part_id) }),
          }));
        }
        continue;
      }

      if (partType === 'reasoning') {
        const content = extractText(partData);
        if (content.trim()) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'thinking',
            content,
          }));
        }
        continue;
      }

      if (partType === 'tool') {
        const state = readObjectRecord(partData.state) ?? {};
        const status = readOptionalString(state.status);
        const toolMessage = createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: readOptionalString(partData.tool) ?? 'Tool',
          toolInput: state.input ?? partData.input ?? {},
          toolId: readOptionalString(partData.callID) ?? row.part_id,
        });

        if (status === 'completed' || status === 'error') {
          toolMessage.toolResult = {
            content: formatToolContent(state.output ?? state.error),
            isError: status === 'error',
          };
        }

        normalized.push(toolMessage);
        continue;
      }

      if (partType === 'step-finish') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'stream_end',
        }));
        continue;
      }

      if (partType === 'patch' || partType === 'agent') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: partType === 'patch' ? 'Patch' : 'Agent',
          toolInput: partData,
          toolId: row.part_id,
        }));
      }
    }

    return normalized;
  }

  /**
   * Reads the session's context usage (newest message occupancy + model
   * context window) for the provider token-usage service.
   *
   * Databases whose messages and columns both predate token tracking answer
   * with an explicit unsupported result; a database or session row that cannot
   * be found is a 404.
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
      const sessionRow = database
        .prepare('SELECT id FROM session WHERE id = ?')
        .get(input.nativeSessionId) as { id: string } | undefined;

      if (!sessionRow) {
        throw new AppError('OpenCode session was not found.', {
          code: 'OPENCODE_SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      return readOpenCodeContextUsage(database, input.nativeSessionId) ?? {
        used: 0,
        inputTokens: 0,
        outputTokens: 0,
        breakdown: { input: 0, output: 0 },
        unsupported: true,
        message: 'Token usage tracking is not available in this OpenCode database schema',
      };
    } finally {
      database.close();
    }
  }

  /**
   * Resolves the last message to keep when the message `anchorId` names is
   * replaced.
   *
   * `anchorId` is the provider message id (`msg_…`) carried as each normalized
   * message's transcript anchor. OpenCode's `revert` drops the named message
   * and everything after it, so the predecessor of the edited message — or
   * `null` when it is the first — is what survives.
   */
  async resolveEditAnchor(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null }> {
    const session = sessionsDb.getSessionById(sessionId);
    const providerSessionId = session?.provider_session_id;
    if (!providerSessionId) {
      return { found: false, resumeThroughId: null };
    }

    const db = openOpenCodeDatabase();
    if (!db) {
      return { found: false, resumeThroughId: null };
    }

    try {
      const messageIds = readOpenCodeMessageIds(db, providerSessionId);
      const index = messageIds.indexOf(anchorId);
      if (index < 0) {
        return { found: false, resumeThroughId: null };
      }

      return { found: true, resumeThroughId: index === 0 ? null : messageIds[index - 1] };
    } finally {
      db.close();
    }
  }

  /**
   * Rewinds an OpenCode session so `keepThroughId` is its last message.
   *
   * OpenCode has no resume-at-a-message, but the server keeps a revert marker:
   * naming the first message to drop (`keepThroughId`'s successor, or the
   * session's first message when nothing is kept) makes the engine discard that
   * message and everything after it when the replacement prompt arrives.
   */
  async rewindSession(sessionId: string, keepThroughId: string | null): Promise<void> {
    const session = sessionsDb.getSessionById(sessionId);
    const providerSessionId = session?.provider_session_id;
    if (!session || !providerSessionId) {
      throw new AppError('This session has not produced a transcript yet.', {
        code: 'EDIT_SOURCE_NOT_READY',
        statusCode: 409,
      });
    }

    const db = openOpenCodeDatabase();
    if (!db) {
      throw new AppError('OpenCode database was not found.', {
        code: 'OPENCODE_DATABASE_NOT_FOUND',
        statusCode: 409,
      });
    }

    let dropMessageId: string | null;
    try {
      const messageIds = readOpenCodeMessageIds(db, providerSessionId);
      const keepIndex = keepThroughId === null ? -1 : messageIds.indexOf(keepThroughId);
      dropMessageId = messageIds[keepIndex + 1] ?? null;
    } finally {
      db.close();
    }

    // Nothing follows what is being kept, so there is nothing to replace.
    if (!dropMessageId) {
      return;
    }

    const handle = await acquireOpenCodeServer();
    try {
      await revertOpenCodeSession(handle, session.project_path ?? '', providerSessionId, dropMessageId);
    } finally {
      releaseOpenCodeServer();
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
        const res = db.prepare('DELETE FROM session WHERE id = ?').run(nativeSessionId);
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
        db.prepare('DELETE FROM session WHERE directory = ?').run(normalizedPath);
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
