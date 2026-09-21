import { scheduledJobsDb, sessionsDb } from '@/modules/database/index.js';
import type { ScheduledJobRow } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import {
  scheduledJobsService,
  SCHEDULED_JOB_RUN_HISTORY_LIMIT,
} from '@/modules/scheduled-jobs/services/scheduled-jobs.service.js';
import { scheduledJobsSettingsService } from '@/modules/scheduled-jobs/services/scheduled-jobs-settings.service.js';

/**
 * How often due occurrences are looked for.
 *
 * A minute is the finest schedule the picker offers and the claim is indexed
 * on `(enabled, next_run_at)`, so the poll is one cheap query.
 */
const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchInFlight = false;
/** Set by the server entrypoint; manual runs from the API use the same gateway. */
let runtimeGateway: ProviderRuntimeGateway | null = null;

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** A per-run session title that sorts naturally and says which job it belongs to. */
function buildRunSessionName(job: ScheduledJobRow, startedAt: Date): string {
  const stamp = startedAt.toISOString().slice(0, 16).replace('T', ' ');
  return `${job.name} · ${stamp}`;
}

/**
 * Resolves the session an occurrence runs in.
 *
 * `reuse` jobs run in their bound conversation; `new` jobs get a session per
 * occurrence so a daily job's context never accumulates and each run reads as
 * its own conversation in the sidebar.
 */
function resolveRunSession(job: ScheduledJobRow): string {
  if (job.session_mode === 'reuse' && job.session_id) {
    return job.session_id;
  }

  const created = sessionsService.createAppSession(
    job.provider as LLMProvider,
    job.project_path,
    job.prompt,
  );
  sessionsService.renameSessionById(created.sessionId, buildRunSessionName(job, new Date()));
  return created.sessionId;
}

/**
 * Runs one claimed occurrence and records how it ended.
 *
 * Never interrupts a run already in progress: a recurring job can wait for the
 * next occurrence, and a conversation the user is actively working in must not
 * be cut off by a timer. A busy session is recorded as `skipped`, everything
 * else that failed as `failed`.
 */
export async function executeScheduledJobRun(
  job: ScheduledJobRow,
  runId: string,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  try {
    const sessionId = resolveRunSession(job);
    if (job.session_mode === 'new') {
      scheduledJobsDb.setRunSession(runId, sessionId);
    }

    if (job.session_mode === 'reuse' && chatRunRegistry.isProcessing(sessionId)) {
      scheduledJobsDb.finishRun(runId, 'skipped', 'A run was already in progress for this session.');
      scheduledJobsDb.recordJobOutcome(job.id, 'skipped');
      return;
    }

    const result = await runDetachedChatTurn(
      {
        sessionId,
        userId: job.user_id,
        content: job.prompt,
        options: readOptions(job.options),
      },
      { runtime },
    );

    if (!result.started) {
      // The pre-check above already ruled out a busy session, so a failure to
      // start now is either the race it cannot cover or a session/provider
      // that is gone.
      const sessionGone = !sessionsDb.getSessionById(sessionId);
      const status = sessionGone ? 'failed' : 'skipped';
      scheduledJobsDb.finishRun(runId, status, result.error ?? 'The run did not start.');
      scheduledJobsDb.recordJobOutcome(job.id, status);
      return;
    }

    const status = result.error ? 'failed' : 'succeeded';
    scheduledJobsDb.finishRun(runId, status, result.error);
    scheduledJobsDb.recordJobOutcome(job.id, status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduledJobsDb.finishRun(runId, 'failed', message);
    scheduledJobsDb.recordJobOutcome(job.id, 'failed');
  } finally {
    scheduledJobsDb.pruneRuns(job.id, SCHEDULED_JOB_RUN_HISTORY_LIMIT);
  }
}

/**
 * Runs every occurrence whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledJobs(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  const claimed = scheduledJobsService.claimDue(now);
  if (claimed.length === 0) {
    return 0;
  }

  // Concurrently: a long-running job must not push every later job past its
  // missed-grace window. Two jobs landing on the same session still cannot
  // race a run into it — the registry turns the loser into `skipped`.
  await Promise.all(claimed.map((entry) => (
    entry.missed
      ? Promise.resolve()
      : executeScheduledJobRun(entry.job, entry.runId, runtime)
  )));

  return claimed.length;
}

/**
 * Starts the poll that fires scheduled jobs.
 *
 * The schedule lives in the database, so jobs survive a restart; occurrences
 * that came due while the server was down are either run late (inside the
 * grace window) or recorded as missed, then the job continues on its cadence.
 */
export function initializeScheduledJobDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  runtimeGateway = runtime;
  const stranded = scheduledJobsDb.sweepRunningRuns('Interrupted by a server restart.');
  if (stranded > 0) {
    console.warn(`[ScheduledJobs] Marked ${stranded} interrupted run(s) as failed`);
  }

  const poll = () => {
    // The feature switch is the whole feature: while it is off, tasks are kept
    // but nothing fires, so "disabled" cannot mean "still running in the dark".
    if (!scheduledJobsSettingsService.isEnabled()) {
      return;
    }
    // A pass that overruns the interval must not be started again underneath
    // itself; the claim is transactional but the runs are not.
    if (dispatchInFlight) {
      return;
    }
    dispatchInFlight = true;
    void dispatchDueScheduledJobs(runtime)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledJobs] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled jobs.
  pollTimer.unref?.();

  // Catch up on anything that came due while the server was not running.
  poll();
}

/**
 * Starts a manual run from the API, outside the schedule.
 *
 * The run row is opened before execution starts so the history shows it as in
 * flight immediately; `next_run_at` is untouched, so "Run now" never shifts
 * the cadence.
 */
export async function runScheduledJobNow(userId: number, id: string): Promise<{ runId: string }> {
  const { job, runId } = scheduledJobsService.requestManualRun(userId, id);
  if (!runtimeGateway) {
    throw new Error('The scheduled-jobs dispatcher is not initialized.');
  }

  void executeScheduledJobRun(job, runId, runtimeGateway).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ScheduledJobs] Manual run failed', { jobId: id, error: message });
  });

  return { runId };
}

export function closeScheduledJobDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  runtimeGateway = null;
}
