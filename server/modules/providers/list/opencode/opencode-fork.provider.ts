import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import type { IProviderFork } from '@/shared/interfaces.js';
import { AppError, readJsonRecord, readOptionalString } from '@/shared/utils.js';

import { getOpenCodeDatabasePath } from './opencode-data-root.js';
import { acquireOpenCodeServer, forkOpenCodeSession, releaseOpenCodeServer } from './opencode-server.client.js';

/** One message of a session, reduced to what a fork cut needs. */
type OpenCodeMessageOrderEntry = {
  id: string;
  role: string;
};

/**
 * Provider message ids and roles of one session, oldest first.
 *
 * Exported for tests only.
 */
export function readOpenCodeMessageOrder(
  db: Database.Database,
  providerSessionId: string,
): OpenCodeMessageOrderEntry[] {
  const rows = db.prepare(`
    SELECT id, data
    FROM message
    WHERE session_id = ?
    ORDER BY COALESCE(time_created, 0), id
  `).all(providerSessionId) as Array<{ id: string; data: string | null }>;

  return rows.map((row) => ({
    id: row.id,
    role: readOptionalString(readJsonRecord(row.data)?.role) ?? '',
  }));
}

/**
 * The message id to hand OpenCode's **exclusive** fork cut so the copy ends at
 * the anchor's turn.
 *
 * The cut copies everything before the named message, so the answer is the
 * first *user* message after the anchor: that keeps the anchor's whole turn
 * (its answer included) and drops the next one. `null` means the anchor's turn
 * is the last, and the whole conversation is copied. Turn-inclusive is the same
 * choice Codex's fork makes — a turn is the smallest useful branch point.
 *
 * Exported for tests only.
 */
export function resolveOpenCodeForkCut(
  order: OpenCodeMessageOrderEntry[],
  anchorId: string,
): string | null {
  const anchorIndex = order.findIndex((message) => message.id === anchorId);
  if (anchorIndex < 0) {
    throw new AppError('That message is no longer in the transcript.', {
      code: 'ANCHOR_NOT_FOUND',
      statusCode: 404,
    });
  }

  const nextUserMessage = order.slice(anchorIndex + 1).find((message) => message.role === 'user');
  return nextUserMessage?.id ?? null;
}

/**
 * Branches an OpenCode conversation through the server's `fork` primitive,
 * which copies the messages before the cut into an independent session.
 *
 * OpenCode keeps its transcript in a shared database rather than a file, so
 * `requiresTranscriptFile` is false and the fork returns no artifact path.
 */
export class OpenCodeForkProvider implements IProviderFork {
  readonly requiresTranscriptFile = false;

  async forkSession(input: {
    providerSessionId: string;
    jsonlPath: string | null;
    projectPath: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string | null }> {
    const databasePath = getOpenCodeDatabasePath();
    if (!fsSync.existsSync(databasePath)) {
      throw new AppError('OpenCode database was not found.', {
        code: 'OPENCODE_DATABASE_NOT_FOUND',
        statusCode: 409,
      });
    }

    let cutMessageId: string | null = null;
    if (input.upToAnchorId) {
      const db = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        cutMessageId = resolveOpenCodeForkCut(
          readOpenCodeMessageOrder(db, input.providerSessionId),
          input.upToAnchorId,
        );
      } finally {
        db.close();
      }
    }

    // The fork's chosen title lives on this app's own session row, so the
    // engine-side session keeps whatever it derives itself.
    const handle = await acquireOpenCodeServer();
    try {
      const forkedSessionId = await forkOpenCodeSession(
        handle,
        input.projectPath,
        input.providerSessionId,
        cutMessageId,
      );
      return { providerSessionId: forkedSessionId, jsonlPath: null };
    } finally {
      releaseOpenCodeServer();
    }
  }
}
