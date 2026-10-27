import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

/**
 * Status lifecycle of a persisted scheduled message row.
 *
 * Consumer: scheduled-messages service and database repository barrel.
 */
export type ScheduledMessageStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

/**
 * Raw SQLite row shape for `scheduled_messages`.
 *
 * Consumer: scheduled-messages service and dispatcher via `@/modules/database/index.js`.
 */
export type ScheduledMessageRow = {
  id: string;
  user_id: number;
  session_id: string;
  content: string;
  options: string;
  scheduled_for: string;
  status: ScheduledMessageStatus;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  'id, user_id, session_id, content, options, scheduled_for, status, failure_reason, created_at, updated_at';

/**
 * Persistence operations for `scheduled_messages`.
 *
 * Consumer: scheduled-messages service, dispatcher, and tests via `@/modules/database/index.js`.
 */
export const scheduledMessagesDb = {
  create(input: {
    userId: number;
    sessionId: string;
    content: string;
    options: unknown;
    scheduledFor: Date;
  }): ScheduledMessageRow {
    const db = getConnection();
    const id = randomUUID();

    db.prepare(
      `INSERT INTO scheduled_messages (id, user_id, session_id, content, options, scheduled_for, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    ).run(
      id,
      input.userId,
      input.sessionId,
      input.content,
      JSON.stringify(input.options ?? {}),
      input.scheduledFor.toISOString(),
    );

    return db.prepare(`SELECT ${COLUMNS} FROM scheduled_messages WHERE id = ?`).get(id) as ScheduledMessageRow;
  },

  /** Everything still to come or recently resolved, newest schedule first. */
  listForSession(userId: number, sessionId: string): ScheduledMessageRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM scheduled_messages
         WHERE user_id = ? AND session_id = ?
         ORDER BY scheduled_for ASC`
      )
      .all(userId, sessionId) as ScheduledMessageRow[];
  },

  listPendingForUser(userId: number): ScheduledMessageRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM scheduled_messages
         WHERE user_id = ? AND status = 'pending'
         ORDER BY scheduled_for ASC`
      )
      .all(userId) as ScheduledMessageRow[];
  },

  /**
   * Claims the earliest due message for each session that is not already
   * running a scheduled turn, marking only those claimed rows in the same
   * transaction that selects them.
   *
   * Leaving later due messages for the same session as `pending` until the
   * earlier turn finishes keeps them visible, cancellable, and recoverable
   * across a server restart.
   */
  claimDue(now: Date, busySessionIds: ReadonlySet<string> = new Set()): ScheduledMessageRow[] {
    const db = getConnection();
    const nowIso = now.toISOString();

    return db.transaction(() => {
      const due = db
        .prepare(
          `SELECT ${COLUMNS} FROM scheduled_messages
           WHERE status = 'pending' AND scheduled_for <= ?
           ORDER BY scheduled_for ASC, rowid ASC`
        )
        .all(nowIso) as ScheduledMessageRow[];

      const claimed: ScheduledMessageRow[] = [];
      const seenSessions = new Set<string>(busySessionIds);
      const markSent = db.prepare(
        `UPDATE scheduled_messages SET status = 'sent', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      );

      for (const row of due) {
        if (seenSessions.has(row.session_id)) {
          continue;
        }
        seenSessions.add(row.session_id);
        markSent.run(row.id);
        claimed.push(row);
      }

      return claimed;
    })();
  },

  /**
   * Claims the next due pending message for one session, or returns null when
   * that session has nothing else due yet.
   */
  claimNextDueForSession(sessionId: string, now: Date): ScheduledMessageRow | null {
    const db = getConnection();
    const nowIso = now.toISOString();

    return db.transaction(() => {
      const row = db
        .prepare(
          `SELECT ${COLUMNS} FROM scheduled_messages
           WHERE session_id = ? AND status = 'pending' AND scheduled_for <= ?
           ORDER BY scheduled_for ASC, rowid ASC
           LIMIT 1`
        )
        .get(sessionId, nowIso) as ScheduledMessageRow | undefined;

      if (!row) {
        return null;
      }

      db.prepare(
        `UPDATE scheduled_messages SET status = 'sent', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(row.id);

      return row;
    })();
  },

  markFailed(id: string, reason: string): void {
    getConnection()
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'failed', failure_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(reason.slice(0, 500), id);
  },

  /**
   * Puts a claimed message back to `pending` without recording a failure.
   *
   * Used when the engine deferred the turn because background work is still
   * running: nothing was sent, so the message stays visible, cancellable, and
   * due again on the next poll pass. The `sent` guard means only a row this
   * pass actually claimed can be released.
   */
  releaseClaimed(id: string): void {
    getConnection()
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'pending', failure_reason = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'sent'`
      )
      .run(id);
  },

  /**
   * Cancels a pending message, or dismisses a failed one so its banner goes
   * away. Returns false when it had already fired successfully.
   */
  cancel(userId: number, id: string): boolean {
    const result = getConnection()
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND status IN ('pending', 'failed')`
      )
      .run(id, userId);

    return result.changes > 0;
  },
};
