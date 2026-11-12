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

/** The shared OpenCode data directory (`auth.json`, `opencode.db`, model caches). */
function getOpenCodeDataDirectory(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

/**
 * Resolves the legacy v1 credential file.
 *
 * v1 OpenCode kept every connected provider credential — including the
 * `opencode-go` subscription API key — in one `auth.json` under its data
 * directory; v2 moved them to the `credential` table, so this file is only
 * the fallback. Consumed by the opencode quota provider.
 */
export function getOpenCodeAuthPath(): string {
  return path.join(getOpenCodeDataDirectory(), 'auth.json');
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
