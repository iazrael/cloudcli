import crypto from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type {
  AsyncTaskRecord,
  ClaimPendingEventInput,
  RecordTaskCompletionInput,
  RecordTaskCompletionResult,
  RegisterAsyncTaskInput,
  TaskContinuationEventRecord,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Normalizes SQLite UTC timestamps (e.g. "2026-10-17 03:00:00") into standard ISO strings.
 */
function normalizeDate(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) {
    return new Date().toISOString();
  }
  const isoCandidate = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const parsed = new Date(isoCandidate);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * Normalizes an async task row from the database.
 */
function mapTaskRow(row: any): AsyncTaskRecord {
  return {
    task_id: row.task_id,
    user_id: row.user_id,
    session_id: row.session_id,
    run_id: row.run_id ?? null,
    provider_thread_id: row.provider_thread_id ?? null,
    session_project_path: row.session_project_path ?? null,
    working_directory: row.working_directory ?? null,
    sandbox_policy_type: row.sandbox_policy_type ?? null,
    network_access: row.network_access == null ? null : Number(row.network_access),
    approval_policy: row.approval_policy ?? null,
    title: row.title,
    command: row.command ?? null,
    registration_key: row.registration_key ?? null,
    auto_notify: Number(row.auto_notify) || 0,
    notification_cancelled_at: row.notification_cancelled_at ? normalizeDate(row.notification_cancelled_at) : null,
    notification_cancelled_reason: row.notification_cancelled_reason ?? null,
    status: row.status,
    exit_code: row.exit_code != null ? Number(row.exit_code) : null,
    result_digest: row.result_digest ?? null,
    result_path: row.result_path ?? null,
    result_summary: row.result_summary ?? null,
    result_json: row.result_json ?? null,
    last_error: row.last_error ?? null,
    token_hash: row.token_hash,
    token_expires_at: row.token_expires_at ? normalizeDate(row.token_expires_at) : null,
    created_at: normalizeDate(row.created_at),
    updated_at: normalizeDate(row.updated_at),
  };
}

/**
 * Normalizes a continuation event row from the database.
 */
function mapEventRow(row: any): TaskContinuationEventRecord {
  const leaseExpiresAtMs = row.lease_expires_at_ms == null ? null : Number(row.lease_expires_at_ms);
  return {
    event_id: row.event_id,
    task_id: row.task_id,
    session_id: row.session_id,
    status: row.status,
    attempts: Number(row.attempts) || 0,
    lease_owner: row.lease_owner ?? null,
    lease_expires_at: leaseExpiresAtMs !== null
      ? new Date(leaseExpiresAtMs).toISOString()
      : row.lease_expires_at ? normalizeDate(row.lease_expires_at) : null,
    lease_expires_at_ms: Number.isFinite(leaseExpiresAtMs) ? leaseExpiresAtMs : null,
    last_attempt_at: row.last_attempt_at ? normalizeDate(row.last_attempt_at) : null,
    engine_turn_id: row.engine_turn_id ?? null,
    host_run_id: row.host_run_id ?? null,
    last_error: row.last_error ?? null,
    created_at: normalizeDate(row.created_at),
    updated_at: normalizeDate(row.updated_at),
  };
}

/**
 * Repository providing atomic SQLite operations for asynchronous tasks and the continuation outbox.
 *
 * Consumed by task-continuations module routes, services, and recovery managers.
 */
export const taskContinuationDb = {
  /**
   * Registers a new async task with initial state 'registered'.
   */
  registerAsyncTask(input: RegisterAsyncTaskInput): AsyncTaskRecord {
    const db = getConnection();
    const sql = `
      INSERT INTO async_tasks (
        task_id,
        user_id,
        session_id,
        run_id,
        provider_thread_id,
        session_project_path,
        working_directory,
        sandbox_policy_type,
        network_access,
        approval_policy,
        title,
        command,
        registration_key,
        auto_notify,
        status,
        token_hash,
        token_expires_at,
        created_at,
        updated_at
      ) VALUES (
        @taskId,
        @userId,
        @sessionId,
        @runId,
        @providerThreadId,
        @sessionProjectPath,
        @workingDirectory,
        @sandboxPolicyType,
        @networkAccess,
        @approvalPolicy,
        @title,
        @command,
        @registrationKey,
        @autoNotify,
        'registered',
        @tokenHash,
        @tokenExpiresAt,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
    `;

    db.prepare(sql).run({
      taskId: input.taskId,
      userId: input.userId,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      providerThreadId: input.providerThreadId ?? null,
      sessionProjectPath: input.sessionProjectPath ?? null,
      workingDirectory: input.workingDirectory ?? null,
      sandboxPolicyType: input.sandboxPolicyType ?? null,
      networkAccess: input.networkAccess == null ? null : input.networkAccess ? 1 : 0,
      approvalPolicy: input.approvalPolicy ?? null,
      title: input.title,
      command: input.command ?? null,
      registrationKey: input.registrationKey ?? null,
      autoNotify: input.autoNotify ? 1 : 0,
      tokenHash: input.tokenHash,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
    });

    const task = this.getTaskById(input.taskId);
    if (!task) {
      throw new AppError('Failed to retrieve registered async task', {
        code: 'TASK_NOT_FOUND',
        statusCode: 500,
      });
    }
    return task;
  },

  /**
   * Fetches an async task by its ID.
   */
  getTaskById(taskId: string): AsyncTaskRecord | null {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM async_tasks WHERE task_id = ?').get(taskId);
    return row ? mapTaskRow(row) : null;
  },

  /** Finds a task created by the same trusted registration request identity. */
  getTaskByRegistrationKey(registrationKey: string): AsyncTaskRecord | null {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM async_tasks WHERE registration_key = ?').get(registrationKey);
    return row ? mapTaskRow(row) : null;
  },

  /**
   * A chat's tasks whose worker reported start and has not reported trouble.
   *
   * Consumer: the host task cards of the task-continuations module.
   */
  listRunningTasksForSession(sessionId: string): AsyncTaskRecord[] {
    const db = getConnection();
    const rows = db.prepare(`
      SELECT * FROM async_tasks
      WHERE session_id = ? AND status = 'running' AND last_error IS NULL
      ORDER BY created_at, task_id
    `).all(sessionId);
    return rows.map(mapTaskRow);
  },

  /** Marks a newly spawned task as running without overwriting a terminal result. */
  markTaskRunning(taskId: string): boolean {
    const db = getConnection();
    const result = db.prepare(`
      UPDATE async_tasks
      SET status = 'running', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = ? AND status = 'registered'
    `).run(taskId);
    return result.changes > 0;
  },

  /** Stores a recovery failure that callers can inspect through task status. */
  updateTaskRecoveryError(input: { taskId: string; error: string }): boolean {
    const db = getConnection();
    const result = db.prepare(`
      UPDATE async_tasks
      SET last_error = @error, updated_at = CURRENT_TIMESTAMP
      WHERE task_id = @taskId AND status IN ('registered', 'running')
    `).run(input);
    return result.changes > 0;
  },

  /**
   * Fetches a continuation event by its ID.
   */
  getEventById(eventId: string): TaskContinuationEventRecord | null {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM task_continuation_events WHERE event_id = ?').get(eventId);
    return row ? mapEventRow(row) : null;
  },

  /**
   * Fetches a continuation event by its associated task ID.
   */
  getEventByTaskId(taskId: string): TaskContinuationEventRecord | null {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM task_continuation_events WHERE task_id = ?').get(taskId);
    return row ? mapEventRow(row) : null;
  },

  /**
   * Submits a task terminal state and creates a continuation outbox event in a single atomic transaction.
   *
   * Idempotent: repeated submissions with the identical status and digest return the existing event id.
   * Conflicting results throw a TASK_RESULT_CONFLICT AppError.
   */
  recordTaskCompletionAndCreateContinuationEvent(
    input: RecordTaskCompletionInput,
  ): RecordTaskCompletionResult {
    const db = getConnection();

    const executeTransaction = db.transaction(() => {
      const existing = db.prepare('SELECT * FROM async_tasks WHERE task_id = ?').get(input.taskId) as any;
      if (!existing) {
        throw new AppError(`Async task ${input.taskId} was not found`, {
          code: 'TASK_NOT_FOUND',
          statusCode: 404,
        });
      }

      const isAlreadyTerminal = existing.status === 'completed' ||
        existing.status === 'failed' ||
        existing.status === 'cancelled';

      if (isAlreadyTerminal) {
        // 核对是否完全一致
        const isSameStatus = existing.status === input.status;
        const isSameDigest = existing.result_digest === input.resultDigest;
        if (isSameStatus && isSameDigest) {
          const eventRow = db
            .prepare('SELECT event_id FROM task_continuation_events WHERE task_id = ?')
            .get(input.taskId) as any;
          return {
            taskId: input.taskId,
            eventId: eventRow ? eventRow.event_id : null,
            status: existing.status,
            isDuplicate: true,
          };
        }

        throw new AppError(
          `Conflict on task ${input.taskId}: task is already ${existing.status} with a different result digest`,
          {
            code: 'TASK_RESULT_CONFLICT',
            statusCode: 409,
          },
        );
      }

      // 更新任务终态
      db.prepare(`
        UPDATE async_tasks
        SET
          status = @status,
          exit_code = @exitCode,
          result_digest = @resultDigest,
          result_path = @resultPath,
          result_summary = @resultSummary,
          result_json = @resultJson,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE task_id = @taskId
      `).run({
        taskId: input.taskId,
        status: input.status,
        exitCode: input.exitCode != null ? input.exitCode : null,
        resultDigest: input.resultDigest,
        resultPath: input.resultPath ?? null,
        resultSummary: input.resultSummary ?? null,
        resultJson: input.resultJson ?? null,
      });

      // 如果启用了 auto_notify，双写生成待投递事件
      let eventId: string | null = null;
      if (existing.auto_notify === 1 && !existing.notification_cancelled_at) {
        eventId = `evt_${crypto.randomUUID()}`;
        db.prepare(`
          INSERT INTO task_continuation_events (
            event_id,
            task_id,
            session_id,
            status,
            attempts,
            created_at,
            updated_at
          ) VALUES (
            @eventId,
            @taskId,
            @sessionId,
            'pending',
            0,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
        `).run({
          eventId,
          taskId: input.taskId,
          sessionId: existing.session_id,
        });
      }

      return {
        taskId: input.taskId,
        eventId,
        status: input.status,
        isDuplicate: false,
      };
    });

    return executeTransaction.immediate();
  },

  /**
   * Atomically claims the oldest pending continuation event with a timed lease.
   * If a claimed event's lease has expired, it can also be claimed.
   */
  claimPendingEvent(input: ClaimPendingEventInput): TaskContinuationEventRecord | null {
    const db = getConnection();
    const nowMs = input.nowMs ?? Date.now();
    const leaseExpiresAtMs = nowMs + input.leaseDurationMs;

    const executeTransaction = db.transaction(() => {
      const candidate = db.prepare(`
        SELECT candidate.* FROM task_continuation_events AS candidate
        WHERE (candidate.status = 'pending'
           OR (candidate.status = 'claimed' AND candidate.lease_expires_at_ms IS NOT NULL AND candidate.lease_expires_at_ms <= @nowMs))
          AND NOT EXISTS (
            SELECT 1 FROM task_continuation_events AS earlier
            WHERE earlier.session_id = candidate.session_id
              AND earlier.rowid < candidate.rowid
              AND earlier.status NOT IN ('delivered', 'reply_failed', 'cancelled')
          )
        ORDER BY (
          SELECT MAX(previous.last_attempt_at)
          FROM task_continuation_events AS previous
          WHERE previous.session_id = candidate.session_id
        ) ASC, candidate.rowid ASC
        LIMIT 1
      `).get({ nowMs }) as any;

      if (!candidate) {
        return null;
      }

      const leaseExpiresAt = new Date(Date.now() + input.leaseDurationMs).toISOString();

      const updateResult = db.prepare(`
        UPDATE task_continuation_events
        SET
          status = 'claimed',
          lease_owner = @leaseOwner,
          lease_expires_at = NULL,
          lease_expires_at_ms = @leaseExpiresAtMs,
          attempts = attempts + 1,
          last_attempt_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE event_id = @eventId
          AND (
            status = 'pending'
            OR (status = 'claimed' AND lease_expires_at_ms <= @nowMs)
          )
        `).run({
          eventId: candidate.event_id,
          leaseOwner: input.leaseOwner,
          leaseExpiresAtMs,
          nowMs,
      });

      if (updateResult.changes === 0) {
        return null;
      }

      const claimedRow = db.prepare('SELECT * FROM task_continuation_events WHERE event_id = ?').get(candidate.event_id);
      return claimedRow ? mapEventRow(claimedRow) : null;
    });

    return executeTransaction.immediate();
  },

  /**
   * Atomically claims a specific continuation event by ID with a timed lease.
   */
  claimEventById(input: { eventId: string; leaseOwner: string; leaseDurationMs: number; nowMs?: number }): boolean {
    const db = getConnection();
    const nowMs = input.nowMs ?? Date.now();
    const leaseExpiresAtMs = nowMs + input.leaseDurationMs;
    const result = db.prepare(`
      UPDATE task_continuation_events
      SET
        status = 'claimed',
        lease_owner = @leaseOwner,
        lease_expires_at = NULL,
        lease_expires_at_ms = @leaseExpiresAtMs,
        attempts = attempts + 1,
        last_attempt_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE event_id = @eventId
        AND (
          status = 'pending'
          OR (status = 'claimed' AND lease_expires_at_ms <= @nowMs)
          OR (status = 'claimed' AND lease_owner = @leaseOwner)
        )
    `).run({
      eventId: input.eventId,
      leaseOwner: input.leaseOwner,
      leaseExpiresAtMs,
      nowMs,
    });
    return result.changes > 0;
  },

  /**
   * Transitions an event to 'sending', confirming the lease owner and recording the host run id.
   */
  updateEventSending(params: { eventId: string; leaseOwner: string; hostRunId: string }): boolean {
    const db = getConnection();
    const result = db.prepare(`
      UPDATE task_continuation_events
      SET
        status = 'sending',
        host_run_id = @hostRunId,
        updated_at = CURRENT_TIMESTAMP
      WHERE event_id = @eventId
        AND lease_owner = @leaseOwner
        AND status = 'claimed'
    `).run(params);
    return result.changes > 0;
  },

  /** Returns a send attempt to the queue only when the gateway atomically refused a busy session. */
  releaseSendingEvent(params: { eventId: string; hostRunId: string; reason: string }): boolean {
    const db = getConnection();
    const result = db.prepare(`
      UPDATE task_continuation_events
      SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
          lease_expires_at_ms = NULL, engine_turn_id = NULL, host_run_id = NULL,
          last_error = @reason, updated_at = CURRENT_TIMESTAMP
      WHERE event_id = @eventId AND status = 'sending' AND host_run_id = @hostRunId
    `).run(params);
    return result.changes > 0;
  },

  /**
   * Transitions an event to 'accepted' when the engine acknowledges the turn start.
   */
  updateEventAccepted(params: { eventId: string; engineTurnId: string; hostRunId: string }): boolean {
    const db = getConnection();
    const result = db.prepare(`
      UPDATE task_continuation_events
      SET
        status = 'accepted',
        engine_turn_id = @engineTurnId,
        updated_at = CURRENT_TIMESTAMP
      WHERE event_id = @eventId
        AND status = 'sending'
        AND host_run_id = @hostRunId
    `).run(params);
    return result.changes > 0;
  },

  /**
   * Transitions an event to 'delivered' when the associated turn finishes successfully.
   */
  updateEventDelivered(params: { eventId: string; engineTurnId: string }): boolean {
    const db = getConnection();
    const result = db.prepare(`
      UPDATE task_continuation_events
      SET
        status = 'delivered',
        updated_at = CURRENT_TIMESTAMP
      WHERE event_id = @eventId
        AND status = 'accepted'
        AND engine_turn_id = @engineTurnId
    `).run(params);
    return result.changes > 0;
  },

  /**
   * Transitions an event to a failure state ('reply_failed' or 'needs_review').
   */
  updateEventFailed(params: {
    eventId: string;
    error: string;
    terminalStatus?: 'reply_failed' | 'needs_review';
    expectedStatus: 'pending' | 'claimed' | 'sending' | 'accepted' | 'uncertain';
    leaseOwner?: string | null;
    hostRunId?: string | null;
    engineTurnId?: string | null;
  }): boolean {
    const db = getConnection();
    const status = params.terminalStatus ?? 'reply_failed';
    if (status === 'reply_failed' && params.expectedStatus !== 'accepted') {
      return false;
    }

    let attemptCondition = '';
    if (params.expectedStatus === 'claimed') {
      if (!params.leaseOwner) return false;
      attemptCondition = 'AND lease_owner = @leaseOwner';
    } else if (params.expectedStatus === 'sending' || params.expectedStatus === 'uncertain') {
      if (!params.hostRunId) return false;
      attemptCondition = 'AND host_run_id = @hostRunId';
    } else if (params.expectedStatus === 'accepted') {
      if (!params.engineTurnId) return false;
      attemptCondition = 'AND engine_turn_id = @engineTurnId';
    }

    const result = db.prepare(`
      UPDATE task_continuation_events
      SET
        status = @status,
        last_error = @error,
        updated_at = CURRENT_TIMESTAMP
      WHERE event_id = @eventId
        AND status = @expectedStatus
        ${attemptCondition}
    `).run({
      eventId: params.eventId,
      status,
      error: params.error,
      expectedStatus: params.expectedStatus,
      leaseOwner: params.leaseOwner ?? null,
      hostRunId: params.hostRunId ?? null,
      engineTurnId: params.engineTurnId ?? null,
    });
    return result.changes > 0;
  },

  /**
   * Releases a claimed event back to 'pending' when the target session is busy.
   */
  releaseClaimedEvent(params: { eventId: string; leaseOwner: string }): boolean {
    const db = getConnection();
    const result = db.prepare(`
      UPDATE task_continuation_events
      SET
        status = 'pending',
        lease_owner = NULL,
        lease_expires_at = NULL,
        lease_expires_at_ms = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE event_id = @eventId
        AND lease_owner = @leaseOwner
        AND status = 'claimed'
    `).run(params);
    return result.changes > 0;
  },

  /**
   * Cancels an event that has not yet been accepted by the engine.
   */
  cancelEvent(params: { eventId: string; reason?: string }): boolean {
    const db = getConnection();
    const result = db.prepare(`
      UPDATE task_continuation_events
      SET
        status = 'cancelled',
        last_error = @reason,
        updated_at = CURRENT_TIMESTAMP
      WHERE event_id = @eventId
        AND status IN ('pending', 'claimed')
    `).run({
      eventId: params.eventId,
      reason: params.reason ?? null,
    });
    return result.changes > 0;
  },

  /** Cancels a future notification, including tasks that have not produced an outbox event yet. */
  cancelNotificationForTask(taskId: string, reason?: string): 'cancelled' | 'already_sending' | 'already_terminal' | 'not_found' {
    const db = getConnection();
    const cancel = db.transaction(() => {
      const task = db.prepare(`
        SELECT task_id, status, notification_cancelled_at FROM async_tasks WHERE task_id = ?
      `).get(taskId) as { task_id: string; status: string; notification_cancelled_at: string | null } | undefined;
      if (!task) return 'not_found' as const;

      const event = db.prepare(`
        SELECT event_id, status FROM task_continuation_events WHERE task_id = ?
      `).get(taskId) as { event_id: string; status: string } | undefined;
      if (event && (event.status === 'sending' || event.status === 'accepted')) return 'already_sending' as const;
      if (event && event.status !== 'pending' && event.status !== 'claimed' && event.status !== 'cancelled') {
        return 'already_terminal' as const;
      }
      if (!event && task.status !== 'registered' && task.status !== 'running' && !task.notification_cancelled_at) {
        return 'already_terminal' as const;
      }

      if (event && event.status !== 'cancelled') {
        db.prepare(`
          UPDATE task_continuation_events SET status = 'cancelled', last_error = @reason,
            lease_owner = NULL, lease_expires_at = NULL, lease_expires_at_ms = NULL,
            updated_at = CURRENT_TIMESTAMP
          WHERE event_id = @eventId AND status IN ('pending', 'claimed')
        `).run({ eventId: event.event_id, reason: reason ?? 'Cancelled by user' });
      }
      db.prepare(`
        UPDATE async_tasks SET notification_cancelled_at = COALESCE(notification_cancelled_at, CURRENT_TIMESTAMP),
          notification_cancelled_reason = COALESCE(notification_cancelled_reason, @reason),
          updated_at = CURRENT_TIMESTAMP WHERE task_id = @taskId
      `).run({ taskId, reason: reason ?? 'Cancelled by user' });
      return 'cancelled' as const;
    });
    return cancel.immediate();
  },

  /** Records an explicit user decision before retrying an uncertain notification. */
  manuallyRequeueEvent(params: { eventId: string; userId: number; reason: string }): boolean {
    const db = getConnection();
    const requeue = db.transaction(() => {
      const event = db.prepare(`
        SELECT * FROM task_continuation_events
        WHERE event_id = ? AND status = 'needs_review'
      `).get(params.eventId) as any;
      if (!event) return false;

      const previousReceipt = JSON.stringify({
        status: event.status,
        attempts: Number(event.attempts) || 0,
        lastAttemptAt: event.last_attempt_at ? normalizeDate(event.last_attempt_at) : null,
        engineTurnId: event.engine_turn_id ?? null,
        hostRunId: event.host_run_id ?? null,
        lastError: event.last_error ?? null,
        leaseOwner: event.lease_owner ?? null,
        leaseExpiresAtMs: event.lease_expires_at_ms == null ? null : Number(event.lease_expires_at_ms),
      });
      const audit = db.prepare(`
        INSERT INTO task_continuation_manual_actions (event_id, task_id, user_id, action, reason, previous_receipt_json)
        VALUES (@eventId, @taskId, @userId, 'retry_notification', @reason, @previousReceipt)
      `).run({ ...params, taskId: event.task_id, previousReceipt });
      if (audit.changes !== 1) return false;

      const warning = `Manual retry approved; the prior attempt may already have run. Reason: ${params.reason}`;
      const update = db.prepare(`
        UPDATE task_continuation_events
        SET status = 'pending', attempts = 0, lease_owner = NULL,
            lease_expires_at = NULL, lease_expires_at_ms = NULL,
            last_attempt_at = NULL, engine_turn_id = NULL, host_run_id = NULL,
            last_error = @warning, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = @eventId AND status = 'needs_review'
      `).run({ eventId: params.eventId, warning });
      if (update.changes !== 1) throw new Error('Task event changed while recording manual retry.');
      return true;
    });
    return requeue.immediate();
  },

  /**
   * For testing: forcibly expires a lease by setting lease_expires_at to 1 hour ago.
   */
  expireLeaseForTesting(eventId: string): void {
    const db = getConnection();
    db.prepare(`
      UPDATE task_continuation_events
      SET lease_expires_at = NULL, lease_expires_at_ms = 0
      WHERE event_id = ?
    `).run(eventId);
  },
};
