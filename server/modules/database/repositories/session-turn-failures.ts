/**
 * Session turn failure repository.
 *
 * Persists the final error text of each session's latest failed run. Engine
 * transcripts do not always carry the turn's terminal failure (antigravity
 * logs per-attempt retry rows but never the final one), so the notification
 * orchestrator — which sees every runtime's failure with its full message —
 * records it here, and history readers overlay it to keep a reloaded
 * timeline consistent with the push the user already received.
 *
 * One row per session (latest failure wins): bounded storage, no cleanup
 * path needed. Keyed by the stable app session id.
 */

import { getConnection } from '@/modules/database/connection.js';

type SessionTurnFailureRow = {
  provider: string;
  error_text: string;
  failed_at: string;
};

/**
 * The stored failure as callers read it back (history readers compare
 * `failedAt` against engine transcript timestamps). `failedAt` is always an
 * explicit ISO instant written by the notification orchestrator — never
 * SQLite's naive CURRENT_TIMESTAMP — so `Date.parse` comparisons hold.
 */
export type SessionTurnFailure = {
  provider: string;
  errorText: string;
  failedAt: string;
};

export const sessionTurnFailuresDb = {
  /** Replaces the session's stored failure; `failedAt` is an ISO instant. */
  recordTurnFailure(failure: {
    sessionId: string;
    provider: string;
    errorText: string;
    failedAt: string;
  }): void {
    const db = getConnection();
    db.prepare(`
      INSERT INTO session_turn_failures (session_id, provider, error_text, failed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        error_text = excluded.error_text,
        failed_at = excluded.failed_at
    `).run(failure.sessionId, failure.provider, failure.errorText, failure.failedAt);
  },

  /** Returns the session's latest stored failure, or null when none. */
  getTurnFailure(sessionId: string): SessionTurnFailure | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT provider, error_text, failed_at FROM session_turn_failures WHERE session_id = ?')
      .get(sessionId) as SessionTurnFailureRow | undefined;

    if (!row) return null;
    return {
      provider: row.provider,
      errorText: row.error_text,
      failedAt: row.failed_at,
    };
  },

  /** Forgets the session's stored failure. */
  deleteTurnFailure(sessionId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM session_turn_failures WHERE session_id = ?').run(sessionId);
  },
};
