import { Cron } from 'croner';

import { scheduledJobsDb, sessionsDb } from '@/modules/database/index.js';
import type {
  ClaimedScheduledJob,
  ScheduledJobRow,
  ScheduledJobRunRow,
  ScheduledJobRunStatus,
  ScheduledJobRunTrigger,
  ScheduledJobSessionMode,
  ScheduledJobStatus,
  ScheduledJobUpdate,
} from '@/modules/database/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** How long a missed occurrence may still be run before it is recorded as missed. */
export const SCHEDULED_JOB_MISSED_GRACE_MS = 10 * 60 * 1000;

/** How many finished runs one job keeps; older rows are pruned on every run. */
export const SCHEDULED_JOB_RUN_HISTORY_LIMIT = 50;

const MAX_NAME_LENGTH = 120;
const MAX_PROMPT_LENGTH = 100_000;

/** A recurring job as the API serves it (camelCase, absolute timestamps). */
export type ScheduledJob = {
  id: string;
  name: string;
  provider: string;
  projectPath: string;
  sessionId: string | null;
  sessionMode: ScheduledJobSessionMode;
  prompt: string;
  options: Record<string, unknown>;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: ScheduledJobStatus | null;
  createdAt: string;
};

/** One attempt of a job, as the API serves it. */
export type ScheduledJobRun = {
  id: string;
  jobId: string;
  sessionId: string | null;
  trigger: ScheduledJobRunTrigger;
  status: ScheduledJobRunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    // A corrupt options blob must not stop the job from running.
    return {};
  }
}

function normalizeOptions(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('options must be an object.', {
      code: 'INVALID_JOB_OPTIONS',
      statusCode: 400,
    });
  }
  return value as Record<string, unknown>;
}

function readRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(`${field} is required.`, {
      code: 'INVALID_SCHEDULED_JOB',
      statusCode: 400,
    });
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new AppError(`${field} is too long.`, {
      code: 'INVALID_SCHEDULED_JOB',
      statusCode: 400,
    });
  }
  return text;
}

function readSessionMode(value: unknown): ScheduledJobSessionMode {
  if (value !== 'reuse' && value !== 'new') {
    throw new AppError('sessionMode must be "reuse" or "new".', {
      code: 'INVALID_SCHEDULED_JOB',
      statusCode: 400,
    });
  }
  return value;
}

/**
 * Validates a cron expression and timezone by asking croner for the next
 * occurrence: an invalid expression or zone throws there, so creation and
 * edits fail loudly instead of leaving a job that can never fire.
 */
function assertValidSchedule(cronExpression: string, timezone: string): void {
  if (cronExpression.split(/\s+/).length !== 5) {
    throw new AppError('The schedule must be a five-field cron expression.', {
      code: 'INVALID_CRON_EXPRESSION',
      statusCode: 400,
    });
  }
  try {
    new Cron(cronExpression, { timezone }).nextRun(new Date());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(`Invalid schedule: ${message}`, {
      code: 'INVALID_CRON_EXPRESSION',
      statusCode: 400,
    });
  }
}

/**
 * The next occurrence strictly after `from`, in the job's own timezone.
 *
 * Computed from "now" rather than from the occurrence that just fired: after a
 * long outage that skips several occurrences, this lands on the next real
 * occurrence instead of replaying the backlog.
 */
export function computeScheduledJobNextRun(
  cronExpression: string,
  timezone: string,
  from: Date = new Date(),
): Date {
  const next = new Cron(cronExpression, { timezone }).nextRun(from);
  if (!next) {
    throw new AppError('The schedule has no next occurrence.', {
      code: 'INVALID_CRON_EXPRESSION',
      statusCode: 400,
    });
  }
  return next;
}

function assertKnownProvider(provider: string): LLMProvider {
  if (!providerRuntimeService.hasRuntime(provider)) {
    throw new AppError(`Provider "${provider}" is not available.`, {
      code: 'PROVIDER_NOT_AVAILABLE',
      statusCode: 400,
    });
  }
  return provider as LLMProvider;
}

export function toScheduledJob(row: ScheduledJobRow): ScheduledJob {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    projectPath: row.project_path,
    sessionId: row.session_id,
    sessionMode: row.session_mode,
    prompt: row.prompt,
    options: readOptions(row.options),
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    createdAt: row.created_at,
  };
}

export function toScheduledJobRun(row: ScheduledJobRunRow): ScheduledJobRun {
  return {
    id: row.id,
    jobId: row.job_id,
    sessionId: row.session_id,
    trigger: row.trigger,
    status: row.status,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Reads the session a `reuse` job is bound to and derives provider and
 * project from it, so a job can never disagree with its conversation about
 * which workspace it runs in.
 */
function resolveReuseSession(sessionId: string): { provider: LLMProvider; projectPath: string } {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    throw new AppError(`Session "${sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }
  if (!session.project_path) {
    throw new AppError('That session has no workspace attached.', {
      code: 'SESSION_WITHOUT_PROJECT',
      statusCode: 400,
    });
  }
  return {
    provider: assertKnownProvider(session.provider),
    projectPath: session.project_path,
  };
}

export const scheduledJobsService = {
  /**
   * Creates a recurring job. A `reuse` job is bound to an existing session and
   * inherits its provider and workspace; a `new` job runs each occurrence in a
   * freshly created session and carries provider and workspace itself.
   */
  create(input: {
    userId: number;
    name: unknown;
    /** Required for `new` jobs; a `reuse` job inherits both from its session. */
    provider?: unknown;
    projectPath?: unknown;
    sessionId: unknown;
    sessionMode: unknown;
    prompt: unknown;
    options?: unknown;
    cronExpression: unknown;
    timezone: unknown;
  }): ScheduledJob {
    const name = readRequiredText(input.name, 'name', MAX_NAME_LENGTH);
    const prompt = readRequiredText(input.prompt, 'prompt', MAX_PROMPT_LENGTH);
    const cronExpression = readRequiredText(input.cronExpression, 'cronExpression', 200);
    const timezone = readRequiredText(input.timezone, 'timezone', 100);
    assertValidSchedule(cronExpression, timezone);

    const sessionMode = readSessionMode(input.sessionMode);
    let provider: LLMProvider;
    let projectPath: string;
    let sessionId: string | null = null;

    if (sessionMode === 'reuse') {
      sessionId = readRequiredText(input.sessionId, 'sessionId', 200);
      const bound = resolveReuseSession(sessionId);
      provider = bound.provider;
      projectPath = bound.projectPath;
    } else {
      provider = assertKnownProvider(readRequiredText(input.provider, 'provider', 40));
      projectPath = readRequiredText(input.projectPath, 'projectPath', 2000);
    }

    return toScheduledJob(scheduledJobsDb.create({
      userId: input.userId,
      name,
      provider,
      projectPath,
      sessionId,
      sessionMode,
      prompt,
      options: normalizeOptions(input.options),
      cronExpression,
      timezone,
      nextRunAt: computeScheduledJobNextRun(cronExpression, timezone),
    }));
  },

  list(userId: number, filter: { projectPath?: string; sessionId?: string } = {}): ScheduledJob[] {
    return scheduledJobsDb.listForUser(userId, filter).map(toScheduledJob);
  },

  /** Applies an edit; schedule changes always move `next_run_at` to the future. */
  update(userId: number, id: string, patch: {
    name?: unknown;
    prompt?: unknown;
    options?: unknown;
    cronExpression?: unknown;
    timezone?: unknown;
    sessionMode?: unknown;
    sessionId?: unknown;
    enabled?: unknown;
  }): ScheduledJob {
    const existing = scheduledJobsDb.getById(userId, id);
    if (!existing) {
      throw new AppError(`Scheduled job "${id}" was not found.`, {
        code: 'SCHEDULED_JOB_NOT_FOUND',
        statusCode: 404,
      });
    }

    const update: ScheduledJobUpdate = {};

    if (patch.name !== undefined) {
      update.name = readRequiredText(patch.name, 'name', MAX_NAME_LENGTH);
    }
    if (patch.prompt !== undefined) {
      update.prompt = readRequiredText(patch.prompt, 'prompt', MAX_PROMPT_LENGTH);
    }
    if (patch.options !== undefined) {
      update.options = normalizeOptions(patch.options);
    }

    const cronExpression = patch.cronExpression !== undefined
      ? readRequiredText(patch.cronExpression, 'cronExpression', 200)
      : existing.cron_expression;
    const timezone = patch.timezone !== undefined
      ? readRequiredText(patch.timezone, 'timezone', 100)
      : existing.timezone;
    if (patch.cronExpression !== undefined || patch.timezone !== undefined) {
      assertValidSchedule(cronExpression, timezone);
      update.cronExpression = cronExpression;
      update.timezone = timezone;
      update.nextRunAt = computeScheduledJobNextRun(cronExpression, timezone);
    }

    // Provider and workspace follow a bound session, exactly like at creation.
    const rebind = (sessionId: string) => {
      const bound = resolveReuseSession(sessionId);
      update.sessionId = sessionId;
      update.provider = bound.provider;
      update.projectPath = bound.projectPath;
    };

    if (patch.sessionMode !== undefined) {
      const sessionMode = readSessionMode(patch.sessionMode);
      update.sessionMode = sessionMode;
      if (sessionMode === 'new') {
        update.sessionId = null;
      } else {
        const sessionId = patch.sessionId !== undefined
          ? readRequiredText(patch.sessionId, 'sessionId', 200)
          : existing.session_id;
        if (!sessionId) {
          throw new AppError('A reused job needs a session.', {
            code: 'INVALID_SCHEDULED_JOB',
            statusCode: 400,
          });
        }
        rebind(sessionId);
      }
    } else if (patch.sessionId !== undefined && existing.session_mode === 'reuse') {
      rebind(readRequiredText(patch.sessionId, 'sessionId', 200));
    }

    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') {
        throw new AppError('enabled must be a boolean.', {
          code: 'INVALID_SCHEDULED_JOB',
          statusCode: 400,
        });
      }
      update.enabled = patch.enabled;
      // Re-enabling starts from now: a job paused for a month must not fire
      // the occurrence that was next when it was paused.
      if (patch.enabled && existing.enabled !== 1) {
        update.nextRunAt = computeScheduledJobNextRun(cronExpression, timezone);
      }
    }

    const updated = scheduledJobsDb.update(userId, id, update);
    if (!updated) {
      throw new AppError(`Scheduled job "${id}" was not found.`, {
        code: 'SCHEDULED_JOB_NOT_FOUND',
        statusCode: 404,
      });
    }
    return toScheduledJob(updated);
  },

  remove(userId: number, id: string): void {
    if (!scheduledJobsDb.delete(userId, id)) {
      throw new AppError(`Scheduled job "${id}" was not found.`, {
        code: 'SCHEDULED_JOB_NOT_FOUND',
        statusCode: 404,
      });
    }
  },

  listRuns(userId: number, id: string, limit = SCHEDULED_JOB_RUN_HISTORY_LIMIT): ScheduledJobRun[] {
    if (!scheduledJobsDb.getById(userId, id)) {
      throw new AppError(`Scheduled job "${id}" was not found.`, {
        code: 'SCHEDULED_JOB_NOT_FOUND',
        statusCode: 404,
      });
    }
    return scheduledJobsDb.listRuns(id, limit).map(toScheduledJobRun);
  },

  /**
   * Opens a manual run row before execution starts, so the UI can show the run
   * as in flight the moment the button is pressed.
   */
  requestManualRun(userId: number, id: string): { job: ScheduledJobRow; runId: string } {
    const job = scheduledJobsDb.getById(userId, id);
    if (!job) {
      throw new AppError(`Scheduled job "${id}" was not found.`, {
        code: 'SCHEDULED_JOB_NOT_FOUND',
        statusCode: 404,
      });
    }
    const run = scheduledJobsDb.insertRun({
      jobId: id,
      sessionId: job.session_mode === 'reuse' ? job.session_id : null,
      trigger: 'manual',
      status: 'running',
    });
    return { job, runId: run.id };
  },

  /** Claims every due occurrence for the dispatcher, in one transaction. */
  claimDue(now: Date): ClaimedScheduledJob[] {
    return scheduledJobsDb.claimDue(now, {
      graceMs: SCHEDULED_JOB_MISSED_GRACE_MS,
      nextRunAtFor: (job) => computeScheduledJobNextRun(job.cron_expression, job.timezone, now),
    });
  },
};
