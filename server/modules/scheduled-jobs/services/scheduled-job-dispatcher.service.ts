import { scheduledJobsDb, sessionsDb } from '@/modules/database/index.js';
import type { ScheduledJobRow } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { readOptionalString } from '@/shared/utils.js';
import type { LLMProvider } from '@/shared/types.js';
import { broadcastScheduledJobsChanged, chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
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

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * Moves a rotating `reuse` job onto a fresh session once its bound one is
 * `rotate_after_days` old, and archives the old one.
 *
 * Reusing one session forever makes it ever slower to open — compaction only
 * shrinks what the model sees, every earlier turn stays in the transcript — so
 * a rotating job keeps one live conversation in the sidebar while bounding its
 * length. Age is read from the session itself, so binding a job to an already
 * old session rotates on its next run. A session with a run in flight is left
 * alone: the caller then records the occurrence as skipped, and the next one
 * rotates.
 */
async function rotateReuseSessionIfDue(job: ScheduledJobRow, now: Date): Promise<ScheduledJobRow> {
  if (job.session_mode !== 'reuse' || !job.session_id || !job.rotate_after_days) {
    return job;
  }

  const bound = sessionsDb.getSessionById(job.session_id);
  const createdAt = bound ? Date.parse(bound.created_at) : Number.NaN;
  if (Number.isNaN(createdAt) || now.getTime() - createdAt < job.rotate_after_days * DAY_MS) {
    return job;
  }
  if (chatRunRegistry.isProcessing(job.session_id)) {
    return job;
  }

  const created = sessionsService.createAppSession(
    job.provider as LLMProvider,
    job.project_path,
    job.prompt,
  );
  sessionsService.renameSessionById(created.sessionId, buildRunSessionName(job, now));
  // The outgoing session's model/effort are the only record of what this job
  // should keep running with. Without them the fresh session falls back to
  // the engine's current default model, which can belong to an unrelated (or
  // unusable) provider group — the job silently changes models on rotation.
  if (bound?.model) {
    sessionsDb.setSessionModel(created.sessionId, bound.model);
  }
  if (bound?.effort) {
    sessionsDb.setSessionEffort(created.sessionId, bound.effort);
  }
  scheduledJobsDb.update(job.user_id, job.id, { sessionId: created.sessionId });
  broadcastScheduledJobsChanged();

  try {
    await sessionsService.deleteOrArchiveSessionById(job.session_id);
  } catch (error) {
    // The job already moved on; a session left in the sidebar is cosmetic.
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[ScheduledJobs] Could not archive the rotated-out session', {
      jobId: job.id,
      sessionId: job.session_id,
      error: message,
    });
  }

  return { ...job, session_id: created.sessionId };
}

/**
 * Gives a run session a model selection when it has none of its own.
 *
 * A `new` job creates a fresh session per occurrence, so there is no bound
 * session to inherit from; without a selection the engine falls back to its
 * current default model, which can belong to a different provider group
 * entirely (and may not even be connected). Follow, in order: an explicit
 * `options.model`, the job's most recent run session, the workspace's most
 * recent session for the same provider, and finally the provider's catalog
 * default. A session that already records its own model (a `reuse` job, or a
 * user pick) is left untouched.
 */
async function ensureRunSessionModel(job: ScheduledJobRow, sessionId: string): Promise<void> {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session || session.model) {
    return;
  }

  const options = readOptions(job.options);
  const selectedModel = readOptionalString(options.model)?.trim();
  const selectedEffort = readOptionalString(options.effort)?.trim();

  if (selectedModel) {
    sessionsDb.setSessionModel(sessionId, selectedModel);
    if (selectedEffort) {
      sessionsDb.setSessionEffort(sessionId, selectedEffort);
    }
    return;
  }

  // The job's own last run is the conversation the user most recently saw,
  // so its selection is the closest thing to "what this task runs with".
  for (const previousRun of scheduledJobsDb.listRuns(job.id, 10)) {
    if (!previousRun.session_id) {
      continue;
    }
    const previousSession = sessionsDb.getSessionById(previousRun.session_id);
    if (previousSession?.provider === job.provider && previousSession.model) {
      sessionsDb.setSessionModel(sessionId, previousSession.model);
      if (previousSession.effort) {
        sessionsDb.setSessionEffort(sessionId, previousSession.effort);
      }
      return;
    }
  }

  // A job that has not run yet (or whose old sessions are gone) continues
  // with what the workspace last ran for this provider.
  const projectModel = sessionsDb.getSessionsByProjectPath(job.project_path)
    .filter((candidate) => candidate.provider === job.provider && candidate.model)
    .sort((left, right) => (
      Date.parse(right.updated_at ?? right.created_at)
      - Date.parse(left.updated_at ?? left.created_at)
    ))[0];
  if (projectModel?.model) {
    sessionsDb.setSessionModel(sessionId, projectModel.model);
    if (projectModel.effort) {
      sessionsDb.setSessionEffort(sessionId, projectModel.effort);
    }
    return;
  }

  // Last resort: the provider's own catalog default. It is still a model
  // this provider can route, unlike the engine's free-model fallback.
  const providerDefault = await providerModelsService.resolveSessionModel(
    job.provider as LLMProvider,
  );
  if (providerDefault.model) {
    sessionsDb.setSessionModel(sessionId, providerDefault.model);
    if (providerDefault.effort) {
      sessionsDb.setSessionEffort(sessionId, providerDefault.effort);
    }
  }
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
  now: Date = new Date(),
): Promise<void> {
  try {
    const runJob = await rotateReuseSessionIfDue(job, now);
    const sessionId = resolveRunSession(runJob);
    // The run row was opened with the bound session (or none, for `new`).
    if (sessionId !== job.session_id) {
      scheduledJobsDb.setRunSession(runId, sessionId);
    }

    if (job.session_mode === 'reuse' && chatRunRegistry.isProcessing(sessionId)) {
      scheduledJobsDb.finishRun(runId, 'skipped', 'A run was already in progress for this session.');
      scheduledJobsDb.recordJobOutcome(job.id, 'skipped');
      return;
    }

    // A fresh `new`-mode session (or a reused one that never recorded a
    // selection) starts from the task's last-known model instead of the
    // engine's default.
    await ensureRunSessionModel(runJob, sessionId);

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
  // Claiming advanced each job's next run (and disabled fired one-offs).
  broadcastScheduledJobsChanged();

  // Concurrently: a long-running job must not push every later job past its
  // missed-grace window. Two jobs landing on the same session still cannot
  // race a run into it — the registry turns the loser into `skipped`.
  await Promise.all(claimed.map((entry) => (
    entry.missed
      ? Promise.resolve()
      : executeScheduledJobRun(entry.job, entry.runId, runtime, now)
  )));
  // The runs recorded their outcomes (last status) on the jobs.
  broadcastScheduledJobsChanged();

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
