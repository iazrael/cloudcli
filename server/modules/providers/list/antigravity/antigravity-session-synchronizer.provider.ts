import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { ProviderSessionFileSynchronizationDelta } from '@/shared/types.js';
import {
  parseAntigravityWorkspacePath,
  readOptionalString,
  sanitizeLeafDirectoryName,
} from '@/shared/utils.js';

import { SqliteSessionSynchronizer } from '../../shared/sessions/sqlite-session-synchronizer.provider.js';

import {
  getAntigravitySummariesDbPath,
  getAntigravityTranscriptCandidates,
} from './antigravity-data-root.js';

type AntigravitySummaryRow = {
  id: string;
  title: string | null;
  workspace_uris: string | null;
  last_modified_time: string | null;
  parent_conversation_id: string | null;
  nesting_depth: number | null;
};

type ConversationSummaryHierarchy = {
  hasParentConversationId: boolean;
  hasNestingDepth: boolean;
};

function readConversationSummaryHierarchy(db: Database.Database): ConversationSummaryHierarchy {
  const columns = db.prepare('PRAGMA table_info(conversation_summaries)').all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  return {
    hasParentConversationId: columnNames.has('parent_conversation_id'),
    hasNestingDepth: columnNames.has('nesting_depth'),
  };
}

function isTopLevelConversation(row: AntigravitySummaryRow): boolean {
  return !readOptionalString(row.parent_conversation_id) && (row.nesting_depth ?? 0) === 0;
}

/**
 * Session synchronizer for Antigravity's conversation_summaries.db.
 *
 * Contributes Antigravity's row mapping to the shared SQLite synchronizer
 * skeleton: only top-level conversations are indexed, the workspace is decoded
 * from `workspace_uris` (falling back to the process cwd),
 * `last_modified_time` is an ISO string, and each session row carries the path
 * of its per-session brain transcript via `resolveJsonlPath`.
 */
export class AntigravitySessionSynchronizer extends SqliteSessionSynchronizer<AntigravitySummaryRow> {
  protected readonly fallbackTitle = 'Untitled Antigravity Session';
  protected readonly logTag = '[AntigravitySessionSynchronizer]';
  protected readonly watchedFileBasenames = [
    'conversation_summaries.db',
    'conversation_summaries.db-wal',
  ];

  constructor() {
    super('antigravity');
  }

  protected getDatabasePath(): string {
    return getAntigravitySummariesDbPath();
  }

  async synchronize(since?: Date): Promise<number> {
    this.archiveIndexedSubagentSessions();
    return super.synchronize(since);
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    this.archiveIndexedSubagentSessions();
    return super.synchronizeFile(filePath);
  }

  /**
   * Consumer: session-synchronizer service uses this lifecycle seam for
   * watcher deltas. The ordinary synchronizer interface stays compatible with
   * providers whose filesystem scans can only report one updated id.
   */
  async synchronizeFileWithLifecycle(filePath: string): Promise<ProviderSessionFileSynchronizationDelta> {
    const removedSessionIds = this.archiveIndexedSubagentSessions();
    return { updatedSessionId: await super.synchronizeFile(filePath), removedSessionIds };
  }

  protected selectSessionRows(
    db: Database.Database,
    _sinceMillis: number | null,
    limit: number | null,
  ): AntigravitySummaryRow[] {
    // The summaries table has no filterable timestamp column in SQL; the
    // shared skeleton applies the since filter per row after parsing the
    // ISO `last_modified_time`. Newer schemas expose hierarchy columns, while
    // old schemas remain readable without them.
    const hierarchy = readConversationSummaryHierarchy(db);
    const parentColumn = hierarchy.hasParentConversationId
      ? 'COALESCE(parent_conversation_id, \'\')'
      : "''";
    const nestingColumn = hierarchy.hasNestingDepth
      ? 'COALESCE(nesting_depth, 0)'
      : '0';
    const query = `
      SELECT
        conversation_id AS id,
        title,
        workspace_uris,
        last_modified_time,
        ${parentColumn} AS parent_conversation_id,
        ${nestingColumn} AS nesting_depth
      FROM conversation_summaries
      WHERE ${parentColumn} = ''
        AND ${nestingColumn} = 0
      ORDER BY last_modified_time DESC
      ${limit === null ? '' : 'LIMIT ?'}
    `;

    return (limit === null
      ? db.prepare(query).all()
      : db.prepare(query).all(limit)) as AntigravitySummaryRow[];
  }

  protected getRowTimestampsMs(row: AntigravitySummaryRow): { createdAtMs: number; updatedAtMs: number } {
    const rowTime = row.last_modified_time
      ? new Date(row.last_modified_time).getTime()
      : 0;
    return {
      createdAtMs: rowTime || Date.now(),
      updatedAtMs: rowTime || Date.now(),
    };
  }

  protected getProjectPath(row: AntigravitySummaryRow): string | null {
    return parseAntigravityWorkspacePath(row.workspace_uris) ?? process.cwd();
  }

  /** Defends against a future query change accidentally reintroducing child rows. */
  protected getSessionId(row: AntigravitySummaryRow): string | null {
    return isTopLevelConversation(row) ? super.getSessionId(row) : null;
  }

  protected deriveSessionName(_db: Database.Database, row: AntigravitySummaryRow): string | null {
    return readOptionalString(row.title) ?? null;
  }

  /**
   * Antigravity stores one transcript per session under its brain directory,
   * so the session row can safely point at it (unlike the shared-SQLite
   * providers where jsonl_path must stay null).
   */
  protected resolveJsonlPath(row: AntigravitySummaryRow): string | null {
    const sessionId = readOptionalString(row.id);
    if (!sessionId) {
      return null;
    }

    try {
      const safeId = sanitizeLeafDirectoryName(sessionId, 'antigravity session id');
      for (const candidate of getAntigravityTranscriptCandidates(safeId)) {
        if (fsSync.existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {
      // Keep null when sanitization fails.
    }

    return null;
  }

  /**
   * Hides previously indexed child-agent sessions without deleting their local
   * metadata or transcript. The source database owns hierarchy, so this runs
   * before every scan instead of persisting a parallel hierarchy model.
   */
  private archiveIndexedSubagentSessions(): string[] {
    const dbPath = this.getDatabasePath();
    if (!fsSync.existsSync(dbPath)) {
      return [];
    }

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const hierarchy = readConversationSummaryHierarchy(db);
      if (!hierarchy.hasParentConversationId && !hierarchy.hasNestingDepth) {
        return [];
      }

      const parentColumn = hierarchy.hasParentConversationId
        ? 'COALESCE(parent_conversation_id, \'\')'
        : "''";
      const nestingColumn = hierarchy.hasNestingDepth
        ? 'COALESCE(nesting_depth, 0)'
        : '0';
      const childRows = db.prepare(`
        SELECT conversation_id AS id
        FROM conversation_summaries
        WHERE TRIM(${parentColumn}) <> '' OR ${nestingColumn} <> 0
      `).all() as Array<{ id: string }>;

      const activeAntigravitySessionIds = new Map(
        sessionsDb.getAllSessions()
          .filter((session) => (
            session.provider === 'antigravity'
            && !session.isArchived
            && Boolean(session.provider_session_id)
          ))
          .map((session) => [session.provider_session_id as string, session.session_id] as const),
      );
      const removedSessionIds: string[] = [];

      for (const childRow of childRows) {
        const childSessionId = activeAntigravitySessionIds.get(childRow.id);
        if (childSessionId) {
          sessionsDb.updateSessionIsArchived(childSessionId, true);
          removedSessionIds.push(childSessionId);
        }
      }
      return removedSessionIds;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`${this.logTag} Failed to archive child-agent sessions:`, message);
      return [];
    } finally {
      db?.close();
    }
  }
}
