import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

/** How a job reaches a session: a bound conversation or a fresh one per run. */
export type ScheduledJobSessionMode = 'reuse' | 'new';

/** How a job's last finished run ended. */
export type ScheduledJobStatus = 'succeeded' | 'failed' | 'skipped' | 'missed';

/** A run in flight is `running`; everything else is a finished outcome. */
export type ScheduledJobRunStatus = 'running' | ScheduledJobStatus;

export type ScheduledJobRunTrigger = 'schedule' | 'manual';

export type ScheduledJobRow = {
  id: string;
  user_id: number;
  name: string;
  provider: string;
  project_path: string;
  session_id: string | null;
  session_mode: ScheduledJobSessionMode;
  prompt: string;
  options: string;
  cron_expression: string;
  timezone: string;
  /** UTC instant of a one-off task; NULL for a recurring job. */
  run_at: string | null;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_status: ScheduledJobStatus | null;
  created_at: string;
  updated_at: string;
};

export type ScheduledJobRunRow = {
  id: string;
  job_id: string;
  session_id: string | null;
  trigger: ScheduledJobRunTrigger;
  status: ScheduledJobRunStatus;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

/** One due occurrence handed to the dispatcher, with the run row recording it. */
export type ClaimedScheduledJob = {
  job: ScheduledJobRow;
  runId: string;
  /** True when the occurrence was too old to run and was recorded as missed. */
  missed: boolean;
};

export type ScheduledJobUpdate = {
  name?: string;
  prompt?: string;
  options?: unknown;
  cronExpression?: string;
  timezone?: string;
  runAt?: Date | null;
  provider?: string;
  projectPath?: string;
  sessionMode?: ScheduledJobSessionMode;
  sessionId?: string | null;
  nextRunAt?: Date;
  enabled?: boolean;
};

const JOB_COLUMNS =
  'id, user_id, name, provider, project_path, session_id, session_mode, prompt, options, '
  + 'cron_expression, timezone, run_at, enabled, next_run_at, last_run_at, last_status, created_at, updated_at';

const RUN_COLUMNS = 'id, job_id, session_id, trigger, status, error, started_at, finished_at';

export const scheduledJobsDb = {
  create(input: {
    userId: number;
    name: string;
    provider: string;
    projectPath: string;
    sessionId: string | null;
    sessionMode: ScheduledJobSessionMode;
    prompt: string;
    options: unknown;
    cronExpression: string;
    timezone: string;
    /** Set for a one-off task; the caller has already checked it is in the future. */
    runAt: Date | null;
    nextRunAt: Date;
  }): ScheduledJobRow {
    const db = getConnection();
    const id = randomUUID();

    db.prepare(
      `INSERT INTO scheduled_jobs
         (id, user_id, name, provider, project_path, session_id, session_mode, prompt, options,
          cron_expression, timezone, run_at, enabled, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(
      id,
      input.userId,
      input.name,
      input.provider,
      input.projectPath,
      input.sessionId,
      input.sessionMode,
      input.prompt,
      JSON.stringify(input.options ?? {}),
      input.cronExpression,
      input.timezone,
      input.runAt ? input.runAt.toISOString() : null,
      input.nextRunAt.toISOString(),
    );

    return db.prepare(`SELECT ${JOB_COLUMNS} FROM scheduled_jobs WHERE id = ?`).get(id) as ScheduledJobRow;
  },

  /** A user's jobs, soonest occurrence first; optionally scoped to one project or session. */
  listForUser(userId: number, filter: { projectPath?: string; sessionId?: string } = {}): ScheduledJobRow[] {
    const conditions = ['user_id = ?'];
    const values: Array<string | number> = [userId];

    if (filter.projectPath) {
      conditions.push('project_path = ?');
      values.push(filter.projectPath);
    }
    if (filter.sessionId) {
      conditions.push('session_id = ?');
      values.push(filter.sessionId);
    }

    return getConnection()
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM scheduled_jobs
         WHERE ${conditions.join(' AND ')}
         ORDER BY next_run_at ASC`
      )
      .all(...values) as ScheduledJobRow[];
  },

  getById(userId: number, id: string): ScheduledJobRow | null {
    const row = getConnection()
      .prepare(`SELECT ${JOB_COLUMNS} FROM scheduled_jobs WHERE id = ? AND user_id = ?`)
      .get(id, userId) as ScheduledJobRow | undefined;
    return row ?? null;
  },

  /** Applies a partial edit. Returns the updated row, or null when not owned. */
  update(userId: number, id: string, patch: ScheduledJobUpdate): ScheduledJobRow | null {
    const db = getConnection();
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];

    const push = (column: string, value: string | number | null) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.name !== undefined) push('name', patch.name);
    if (patch.prompt !== undefined) push('prompt', patch.prompt);
    if (patch.options !== undefined) push('options', JSON.stringify(patch.options ?? {}));
    if (patch.cronExpression !== undefined) push('cron_expression', patch.cronExpression);
    if (patch.timezone !== undefined) push('timezone', patch.timezone);
    if (patch.runAt !== undefined) push('run_at', patch.runAt ? patch.runAt.toISOString() : null);
    if (patch.provider !== undefined) push('provider', patch.provider);
    if (patch.projectPath !== undefined) push('project_path', patch.projectPath);
    if (patch.sessionMode !== undefined) push('session_mode', patch.sessionMode);
    if (patch.sessionId !== undefined) push('session_id', patch.sessionId);
    if (patch.nextRunAt !== undefined) push('next_run_at', patch.nextRunAt.toISOString());
    if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0);

    if (assignments.length === 0) {
      return this.getById(userId, id);
    }

    values.push(id, userId);
    db.prepare(
      `UPDATE scheduled_jobs
       SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`
    ).run(...values);

    return this.getById(userId, id);
  },

  delete(userId: number, id: string): boolean {
    const result = getConnection()
      .prepare('DELETE FROM scheduled_jobs WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return result.changes > 0;
  },

  /**
   * Claims every enabled job whose occurrence has arrived, in one transaction.
   *
   * Claiming does three things atomically: advances `next_run_at` (so a second
   * poll cannot fire the same occurrence), records the attempt as a run row,
   * and decides whether the occurrence is still fresh enough to run. An
   * occurrence older than `graceMs` is recorded as `missed` and skipped — a
   * recurring job has a next occurrence coming, so firing a stale one hours
   * late is worse than saying it was missed.
   *
   * `nextRunAtFor` computes the next occurrence from the current clock; it is
   * called inside the transaction so the persisted schedule and the claimed
   * row can never disagree. A one-off (`run_at` set) skips it entirely and is
   * disabled in the same transaction: its claim is its whole lifecycle.
   */
  claimDue(
    now: Date,
    options: {
      graceMs: number;
      nextRunAtFor: (job: ScheduledJobRow) => Date;
    },
  ): ClaimedScheduledJob[] {
    const db = getConnection();
    const nowIso = now.toISOString();

    return db.transaction(() => {
      const due = db
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM scheduled_jobs
           WHERE enabled = 1 AND next_run_at <= ?
           ORDER BY next_run_at ASC`
        )
        .all(nowIso) as ScheduledJobRow[];

      const claimed: ClaimedScheduledJob[] = [];

      for (const job of due) {
        const missed = now.getTime() - new Date(job.next_run_at).getTime() > options.graceMs;
        // A one-off has no next occurrence: claiming it consumes the only one,
        // so the job is disabled here whatever the run's outcome, and it can
        // never be mistaken for a yearly repeat.
        const once = job.run_at !== null;
        const nextRunAt = once ? new Date(job.next_run_at) : options.nextRunAtFor(job);

        db.prepare(
          once
            ? `UPDATE scheduled_jobs
               SET next_run_at = ?, enabled = 0, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            : `UPDATE scheduled_jobs
               SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
        ).run(nextRunAt.toISOString(), job.id);

        const runId = randomUUID();
        db.prepare(
          `INSERT INTO scheduled_job_runs
             (id, job_id, session_id, trigger, status, error, started_at, finished_at)
           VALUES (?, ?, ?, 'schedule', ?, ?, ?, ?)`
        ).run(
          runId,
          job.id,
          // `new` jobs learn their session only when the occurrence starts.
          job.session_mode === 'reuse' ? job.session_id : null,
          missed ? 'missed' : 'running',
          missed ? 'The server was down when this occurrence was due.' : null,
          nowIso,
          missed ? nowIso : null,
        );

        if (missed) {
          db.prepare(
            `UPDATE scheduled_jobs
             SET last_run_at = ?, last_status = 'missed', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          ).run(nowIso, job.id);
        }

        claimed.push({ job, runId, missed });
      }

      return claimed;
    })();
  },

  insertRun(input: {
    jobId: string;
    sessionId: string | null;
    trigger: ScheduledJobRunTrigger;
    status: ScheduledJobRunStatus;
  }): ScheduledJobRunRow {
    const db = getConnection();
    const id = randomUUID();

    db.prepare(
      `INSERT INTO scheduled_job_runs (id, job_id, session_id, trigger, status)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, input.jobId, input.sessionId, input.trigger, input.status);

    return db.prepare(`SELECT ${RUN_COLUMNS} FROM scheduled_job_runs WHERE id = ?`).get(id) as ScheduledJobRunRow;
  },

  /** Fills in the session a run actually happened in (created late for `new` jobs). */
  setRunSession(runId: string, sessionId: string): void {
    getConnection()
      .prepare('UPDATE scheduled_job_runs SET session_id = ? WHERE id = ?')
      .run(sessionId, runId);
  },

  finishRun(runId: string, status: ScheduledJobStatus, error: string | null): void {
    getConnection()
      .prepare(
        `UPDATE scheduled_job_runs
         SET status = ?, error = ?, finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(status, error ? error.slice(0, 500) : null, runId);
  },

  /** Mirrors a finished run onto the job so the list can show it without a join. */
  recordJobOutcome(jobId: string, status: ScheduledJobStatus, finishedAt: Date = new Date()): void {
    getConnection()
      .prepare(
        `UPDATE scheduled_jobs
         SET last_run_at = ?, last_status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(finishedAt.toISOString(), status, jobId);
  },

  listRuns(jobId: string, limit: number): ScheduledJobRunRow[] {
    return getConnection()
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM scheduled_job_runs
         WHERE job_id = ?
         ORDER BY started_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(jobId, limit) as ScheduledJobRunRow[];
  },

  /** Bounds one job's history so a per-minute job cannot grow the DB forever. */
  pruneRuns(jobId: string, keep: number): void {
    getConnection()
      .prepare(
        `DELETE FROM scheduled_job_runs
         WHERE job_id = ? AND id NOT IN (
           SELECT id FROM scheduled_job_runs
           WHERE job_id = ?
           ORDER BY started_at DESC, rowid DESC
           LIMIT ?
         )`
      )
      .run(jobId, jobId, keep);
  },

  /**
   * Marks runs left `running` by a crash or restart as failed.
   *
   * A run row outlives the process that created it; without this sweep it
   * would show as running forever after the server came back.
   */
  sweepRunningRuns(reason: string): number {
    const db = getConnection();
    const nowIso = new Date().toISOString();

    return db.transaction(() => {
      const stranded = db
        .prepare("SELECT id, job_id FROM scheduled_job_runs WHERE status = 'running'")
        .all() as Array<{ id: string; job_id: string }>;

      for (const run of stranded) {
        db.prepare(
          `UPDATE scheduled_job_runs
           SET status = 'failed', error = ?, finished_at = ?
           WHERE id = ?`
        ).run(reason.slice(0, 500), nowIso, run.id);
        db.prepare(
          `UPDATE scheduled_jobs
           SET last_run_at = ?, last_status = 'failed', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).run(nowIso, run.job_id);
      }

      return stranded.length;
    })();
  },
};
