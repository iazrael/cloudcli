/**
 * OpenCode Data Root
 *
 * Single source of truth for OpenCode CLI filesystem locations and SQLite
 * storage-layout detection. Mirrors the antigravity/zcode data-root convention
 * so provider path knowledge lives in the provider module rather than the
 * global shared layer.
 *
 * @module opencode-data-root
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database, { type Database as SqliteDatabase } from 'better-sqlite3';

import type { AnyRecord } from '@/shared/types.js';
import {
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/**
 * Resolves the OpenCode CLI data directory shared by all of its state files.
 */
function getOpenCodeDataDirectory(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

/**
 * Resolves the OpenCode SQLite session database path.
 *
 * OpenCode stores session, message, and project metadata in one shared
 * `opencode.db` file under its XDG data directory. Provider readers and
 * synchronizers should use this path for read-only access and should never
 * store it as a deletable transcript path for an individual app session row.
 *
 * Consumers: opencode models, sessions, and session synchronizer providers.
 */
export function getOpenCodeDatabasePath(): string {
  return path.join(getOpenCodeDataDirectory(), 'opencode.db');
}

/** One active credential row decoded from OpenCode's v2 SQLite store. */
export type OpenCodeActiveCredential = {
  /** Human-readable account label OpenCode wrote for the row. */
  label: string;
  /** Parsed `value` column (`{ type, key }` for API-key credentials). */
  value: AnyRecord | null;
};

/**
 * Reads the newest active row from OpenCode's v2 `credential` table.
 *
 * `integrationId` narrows the read to one connected provider (for example
 * `opencode-go`); omitting it returns the most recently updated active
 * credential, which is what the auth status check needs. A missing database,
 * an older schema without the table, or an unreadable row resolves to null.
 * The connection is read-only so it never blocks the CLI's WAL writes.
 *
 * Consumers: opencode auth (status label) and quota (OpenCode Go API key).
 */
export function readOpenCodeActiveCredential(
  integrationId?: string,
): OpenCodeActiveCredential | null {
  let db: Database.Database;
  try {
    db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }

  try {
    const selection = 'SELECT label, value FROM credential WHERE active = 1';
    const ordering = 'ORDER BY time_updated DESC, time_created DESC LIMIT 1';
    const row = integrationId
      ? db.prepare(`${selection} AND integration_id = ? ${ordering}`).get(integrationId)
      : db.prepare(`${selection} ${ordering}`).get();
    const record = readObjectRecord(row);
    const label = readOptionalString(record?.label);
    if (!label) {
      return null;
    }
    return { label, value: readJsonRecord(record?.value) };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Resolves the OpenCode credential store path.
 *
 * v1 OpenCode kept every connected provider credential - including the
 * `opencode-go` subscription API key - in one `auth.json` under its XDG data
 * directory; v2 moved them to the `credential` table, so this file is only
 * the legacy fallback.
 *
 * Consumers: opencode auth and quota providers.
 */
export function getOpenCodeAuthPath(): string {
  return path.join(getOpenCodeDataDirectory(), 'auth.json');
}

/**
 * Resolves OpenCode's own model-registry cache path.
 *
 * The file is models.dev data OpenCode refreshed for its registry; its
 * `providerID.modelID.limit.context` entries are the only place this app can
 * learn a model's context window without calling the gateway.
 *
 * Consumers: opencode context usage and runtime providers (context-window
 * lookup for the composer badge's percentage).
 */
export function getOpenCodeModelsCachePath(): string {
  return path.join(os.homedir(), '.cache', 'opencode', 'models.json');
}

/**
 * Opens the shared OpenCode database read-only, or returns null when the
 * engine has never written one. The caller closes it.
 *
 * Consumers: the opencode sessions provider (history) and the opencode
 * runtime (notices persisted while the event stream was down).
 */
export function openOpenCodeDatabase(): SqliteDatabase | null {
  const dbPath = getOpenCodeDatabasePath();
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * The SQLite table holding OpenCode session rows.
 *
 * v2 renamed `session` to `session_v2` (same project/directory/title/timestamp
 * columns plus token totals); v1 layouts keep the original table. Consumers
 * must interpolate only this resolver's result — never a user-supplied string.
 */
export type OpenCodeSessionTableName = 'session_v2' | 'session';

/** Minimal structural view of a better-sqlite3 database this module needs. */
type OpenCodeReadableDatabase = Pick<SqliteDatabase, 'prepare'>;

/**
 * Detects which session table the database carries, preferring the v2
 * `session_v2` layout. Returns null when neither table exists (empty or
 * foreign database), which callers treat as "no sessions".
 *
 * Consumers: opencode sessions, session synchronizer, models, and runtime.
 */
export function resolveOpenCodeSessionTableName(
  db: OpenCodeReadableDatabase,
): OpenCodeSessionTableName | null {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session')",
  ).all() as Array<{ name?: string }>;
  const names = new Set(rows.map((row) => row.name));
  if (names.has('session_v2')) {
    return 'session_v2';
  }
  if (names.has('session')) {
    return 'session';
  }
  return null;
}

/**
 * Detects where OpenCode stores message content.
 *
 * v2 folds messages and their content blocks into one `session_message`
 * table; v1 splits them across `message` and `part`. Returns null when
 * neither layout is present.
 *
 * Consumers: opencode sessions history reader.
 */
export function resolveOpenCodeMessageLayout(
  db: OpenCodeReadableDatabase,
): 'session_message' | 'message_part' | null {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_message', 'message', 'part')",
  ).all() as Array<{ name?: string }>;
  const names = new Set(rows.map((row) => row.name));
  if (names.has('session_message')) {
    return 'session_message';
  }
  if (names.has('message') && names.has('part')) {
    return 'message_part';
  }
  return null;
}

/**
 * One conversation message of a session, reduced to what an edit or fork cut
 * needs: its provider id (`msg_…`, the transcript anchor) and its role.
 *
 * Consumers: opencode sessions provider (edit anchor/rewind) and fork provider.
 */
export type OpenCodeConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
};

/**
 * Lists a session's user and assistant messages, oldest first, in either
 * storage layout.
 *
 * v2 interleaves bookkeeping rows (`model-switched`, `system`, `idle`,
 * `compaction`, …) with the conversation in `session_message`; those are
 * skipped, because the revert and fork cuts must be named by a conversation
 * message — a cut placed on a bookkeeping row would split a turn. v1 keeps the
 * role inside each `message` row's JSON payload.
 *
 * Consumers: opencode sessions provider (edit anchor/rewind) and fork provider.
 */
export function readOpenCodeConversationOrder(
  db: OpenCodeReadableDatabase,
  providerSessionId: string,
): OpenCodeConversationMessage[] {
  const layout = resolveOpenCodeMessageLayout(db);
  if (layout === 'session_message') {
    const rows = db.prepare(`
      SELECT id, type
      FROM session_message
      WHERE session_id = ? AND type IN ('user', 'assistant')
      ORDER BY seq
    `).all(providerSessionId) as Array<{ id: string; type: 'user' | 'assistant' }>;
    return rows.map((row) => ({ id: row.id, role: row.type }));
  }
  if (layout === 'message_part') {
    const rows = db.prepare(`
      SELECT id, data
      FROM message
      WHERE session_id = ?
      ORDER BY COALESCE(time_created, 0), id
    `).all(providerSessionId) as Array<{ id: string; data: string | null }>;
    const messages: OpenCodeConversationMessage[] = [];
    for (const row of rows) {
      const role = readOptionalString(readJsonRecord(row.data)?.role);
      if (role === 'user' || role === 'assistant') {
        messages.push({ id: row.id, role });
      }
    }
    return messages;
  }
  return [];
}

/**
 * When the session last went idle (epoch ms), `null` while a run is in
 * flight, or `undefined` when the database has no idle column (layouts that
 * predate v2) or no such session.
 *
 * Consumer: the OpenCode history reader, to tell a spawn call left `running`
 * by a run that is still going from one whose run is gone.
 */
export function readOpenCodeSessionIdleAt(
  db: OpenCodeReadableDatabase,
  sessionId: string,
): number | null | undefined {
  const table = resolveOpenCodeSessionTableName(db);
  if (!table) {
    return undefined;
  }
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === 'time_idle')) {
    return undefined;
  }
  const row = db.prepare(`SELECT time_idle AS idleAt FROM ${table} WHERE id = ?`).get(sessionId) as { idleAt: number | null } | undefined;
  return row ? row.idleAt : undefined;
}

export type OpenCodeSessionTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Reads one session's token totals from the session table's token columns
 * (v2 `session_v2` and late-v1 `session` alike). Returns null when the
 * database has no session table or the table predates the token columns.
 *
 * Consumers: opencode sessions and runtime token-usage readers.
 */
export function readOpenCodeSessionTokenTotals(
  db: OpenCodeReadableDatabase,
  sessionId: string,
): OpenCodeSessionTokenTotals | null {
  const table = resolveOpenCodeSessionTableName(db);
  if (!table) {
    return null;
  }

  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
  if (!requiredColumns.every((column) => columnNames.has(column))) {
    return null;
  }

  const row = db.prepare(`
    SELECT
      tokens_input AS inputTokens,
      tokens_output AS outputTokens,
      tokens_reasoning AS reasoningTokens,
      tokens_cache_read AS cacheReadTokens,
      tokens_cache_write AS cacheWriteTokens
    FROM ${table}
    WHERE id = ?
  `).get(sessionId) as OpenCodeSessionTokenTotals | undefined;

  return row ?? null;
}

/**
 * Reads one session row's stored model selection, normalized to a
 * `providerId/modelId` key (OpenCode's routing key and the models.json cache
 * key). Both layouts store it as a JSON object on the `model` column
 * (`{providerID, id}` or `{providerID, modelID}`); rows that predate the
 * column, or a missing session table, answer null.
 *
 * Consumers: opencode context usage (context-window lookup) and runtime
 * (fallback when a run carries no model reference).
 */
export function readOpenCodeSessionModelKey(
  db: OpenCodeReadableDatabase,
  sessionId: string,
): string | null {
  const table = resolveOpenCodeSessionTableName(db);
  if (!table) {
    return null;
  }

  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === 'model')) {
    return null;
  }

  const row = db.prepare(`SELECT model FROM ${table} WHERE id = ?`).get(sessionId) as { model?: unknown } | undefined;
  const model = readJsonRecord(row?.model);
  if (!model) {
    return null;
  }

  const providerId = readOptionalString(model.providerID) ?? readOptionalString(model.providerId);
  const modelId = readOptionalString(model.id)
    ?? readOptionalString(model.modelID)
    ?? readOptionalString(model.modelId);
  if (!modelId) {
    return null;
  }
  // Some rows carry the routed id as `provider/model` with an optional
  // `#variant` suffix; models.json keys are `provider/model` alone.
  const [bare, inlineProvider] = modelId.includes('/')
    ? [modelId.split('/').slice(1).join('/'), modelId.split('/')[0]]
    : [modelId, null];
  const resolvedProvider = providerId ?? inlineProvider;
  return resolvedProvider ? `${resolvedProvider}/${bare}` : bare;
}

export type OpenCodeUsageMessageRecord = {
  /** Message row id; identifies the newest compaction summary for the size reading. */
  id: string;
  /** Parsed message payload (raw row data can also be a plain string). */
  data: AnyRecord | null;
};

/**
 * Reads one session's usage-bearing message rows, newest first.
 *
 * Blind to the storage layout: v2 folds messages into `session_message` rows
 * (with the payload inline), v1 splits them across `message` and `part`. Both
 * carry per-message token usage on the assistant payload, which is what the
 * context-usage reader needs; timeline rendering uses the layout-aware
 * fetchers instead.
 *
 * v2 `compaction` rows ride along: they carry no usable occupancy (their
 * tokens describe the whole pre-compaction conversation), but their position
 * relative to the newest assistant message is what tells the reader the
 * conversation was replaced. Returns an empty list when neither layout
 * exists.
 *
 * Consumer: opencode context usage.
 */
export function readOpenCodeUsageMessageRows(
  db: OpenCodeReadableDatabase,
  sessionId: string,
): OpenCodeUsageMessageRecord[] {
  const layout = resolveOpenCodeMessageLayout(db);
  if (layout === 'session_message') {
    const rows = db.prepare(`
      SELECT id, data
      FROM session_message
      WHERE session_id = ? AND type IN ('assistant', 'compaction')
      ORDER BY seq DESC
    `).all(sessionId) as Array<{ id: string; data: string }>;
    return rows.map((row) => ({ id: row.id, data: readJsonRecord(row.data) }));
  }

  if (layout === 'message_part') {
    // v1 stores the role on each message payload; the LIKE prefilter keeps the
    // scan off user rows whose bodies can be far larger than their headers.
    const rows = db.prepare(`
      SELECT id, data
      FROM message
      WHERE session_id = ?
        AND (data LIKE '%"role":"assistant"%' OR data LIKE '%"role": "assistant"%')
      ORDER BY time_created DESC, id DESC
    `).all(sessionId) as Array<{ id: string; data: string }>;
    return rows.map((row) => ({ id: row.id, data: readJsonRecord(row.data) }));
  }

  return [];
}

/**
 * The metadata of every `synthetic` message the engine persisted in a session,
 * in order, with the time it was written. The engine writes one when
 * background work it ran for the session ends (`{ source, childID | shellID,
 * state }`); other synthetic messages (instruction updates) carry other
 * metadata and are the reader's to skip. Empty for layouts that predate v2,
 * which have no synthetic messages.
 *
 * Consumers: the opencode sessions provider and the opencode runtime, both
 * through `readBackgroundNotice`.
 */
export function readOpenCodeSyntheticNoticeMetadata(
  db: OpenCodeReadableDatabase,
  sessionId: string,
): Array<{ metadata: unknown; createdAt: number | null }> {
  if (resolveOpenCodeMessageLayout(db) !== 'session_message') {
    return [];
  }
  const rows = db.prepare(`
    SELECT time_created AS createdAt, data FROM session_message
    WHERE session_id = ? AND type = 'synthetic'
    ORDER BY seq
  `).all(sessionId) as Array<{ createdAt: number | null; data: string | null }>;
  return rows.map((row) => {
    let metadata: unknown;
    try {
      const parsed: unknown = JSON.parse(row.data ?? 'null');
      metadata = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).metadata : undefined;
    } catch {
      metadata = undefined;
    }
    return { metadata, createdAt: typeof row.createdAt === 'number' ? row.createdAt : null };
  });
}
