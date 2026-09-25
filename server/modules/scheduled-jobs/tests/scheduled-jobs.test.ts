import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  scheduledJobsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  closeScheduledJobDispatcher,
  dispatchDueScheduledJobs,
  executeScheduledJobRun,
  initializeScheduledJobDispatcher,
  runScheduledJobNow,
} from '@/modules/scheduled-jobs/services/scheduled-job-dispatcher.service.js';
import { scheduledJobsService } from '@/modules/scheduled-jobs/services/scheduled-jobs.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const SESSION_ID = 'scheduled-job-session';
const CRON_EVERY_MINUTE = '* * * * *';
const TIMEZONE = 'Asia/Shanghai';

async function withIsolatedDatabase(runTest: (userId: number, projectPath: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-jobs-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('scheduler', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Bound session');
    await runTest(Number(user.id), tempDirectory);
  } finally {
    closeScheduledJobDispatcher();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

function createRuntime(runs: RunCall[], behaviour: 'ok' | 'throw' = 'ok') {
  return {
    hasRuntime: () => true,
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      if (behaviour === 'throw') {
        throw new Error('provider exploded');
      }
      runs.push({ provider, command, options });
    },
    abort: async () => true,
  } as never;
}

function createReuseJob(userId: number, overrides: Record<string, unknown> = {}) {
  return scheduledJobsService.create({
    userId,
    name: 'Nightly checks',
    provider: undefined,
    projectPath: undefined,
    sessionId: SESSION_ID,
    sessionMode: 'reuse',
    prompt: 'run the nightly checks',
    options: { model: 'claude-opus-5', permissionMode: 'bypassPermissions' },
    cronExpression: CRON_EVERY_MINUTE,
    timezone: TIMEZONE,
    ...overrides,
  });
}

test('a reuse job inherits provider and workspace from its session and lists by project', async () => {
  await withIsolatedDatabase(async (userId, projectPath) => {
    const job = createReuseJob(userId);

    assert.equal(job.provider, 'claude');
    assert.equal(job.projectPath, projectPath);
    assert.equal(job.sessionId, SESSION_ID);
    assert.equal(job.enabled, true);
    assert.ok(new Date(job.nextRunAt).getTime() > Date.now());

    assert.equal(scheduledJobsService.list(userId).length, 1);
    assert.equal(scheduledJobsService.list(userId, { projectPath }).length, 1);
    assert.equal(scheduledJobsService.list(userId, { projectPath: '/somewhere/else' }).length, 0);
    assert.equal(scheduledJobsService.list(userId, { sessionId: SESSION_ID }).length, 1);
    assert.equal(scheduledJobsService.list(userId, { sessionId: 'other' }).length, 0);
  });
});

test('a due occurrence runs in the bound session and advances the schedule', async () => {
  await withIsolatedDatabase(async (userId) => {
    const job = createReuseJob(userId);
    const firstNextRun = job.nextRunAt;

    const runs: RunCall[] = [];
    const dispatched = await dispatchDueScheduledJobs(
      createRuntime(runs),
      new Date(Date.now() + 120_000),
    );

    assert.equal(dispatched, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'run the nightly checks');
    assert.equal(runs[0].options.model, 'claude-opus-5');

    const history = scheduledJobsService.listRuns(userId, job.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'succeeded');
    assert.equal(history[0].sessionId, SESSION_ID);

    const row = scheduledJobsDb.getById(userId, job.id);
    assert.equal(row?.last_status, 'succeeded');
    assert.notEqual(row?.next_run_at, firstNextRun);
    assert.ok(new Date(row?.next_run_at ?? 0).getTime() > Date.now() + 120_000);
  });
});

test('an occurrence older than the grace window is recorded as missed, not run', async () => {
  await withIsolatedDatabase(async (userId) => {
    const job = createReuseJob(userId);

    const runs: RunCall[] = [];
    const dispatched = await dispatchDueScheduledJobs(
      createRuntime(runs),
      new Date(Date.now() + 30 * 60_000),
    );

    assert.equal(dispatched, 1);
    assert.equal(runs.length, 0);

    const history = scheduledJobsService.listRuns(userId, job.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'missed');
    assert.equal(scheduledJobsDb.getById(userId, job.id)?.last_status, 'missed');
  });
});

test('a busy session is skipped instead of interrupted', async () => {
  await withIsolatedDatabase(async (userId) => {
    const job = createReuseJob(userId);
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    await dispatchDueScheduledJobs(createRuntime(runs), new Date(Date.now() + 120_000));

    assert.equal(runs.length, 0);
    const history = scheduledJobsService.listRuns(userId, job.id);
    assert.equal(history[0].status, 'skipped');
    assert.match(history[0].error ?? '', /already in progress/);
    assert.equal(scheduledJobsDb.getById(userId, job.id)?.last_status, 'skipped');
  });
});

test('a new-mode job creates a session per occurrence', async () => {
  await withIsolatedDatabase(async (userId, projectPath) => {
    const job = scheduledJobsService.create({
      userId,
      name: 'Daily audit',
      provider: 'claude',
      projectPath,
      sessionId: undefined,
      sessionMode: 'new',
      prompt: 'audit the workspace',
      options: {},
      cronExpression: CRON_EVERY_MINUTE,
      timezone: TIMEZONE,
    });

    const runs: RunCall[] = [];
    await dispatchDueScheduledJobs(createRuntime(runs), new Date(Date.now() + 120_000));

    const history = scheduledJobsService.listRuns(userId, job.id);
    assert.equal(history[0].status, 'succeeded');
    assert.ok(history[0].sessionId);
    assert.notEqual(history[0].sessionId, SESSION_ID);

    const created = sessionsDb.getSessionById(history[0].sessionId as string);
    assert.equal(created?.project_path, projectPath);
    assert.match(created?.custom_name ?? '', /^Daily audit/);
  });
});

test('overlapping passes cannot double-fire one occurrence', async () => {
  await withIsolatedDatabase(async (userId) => {
    createReuseJob(userId);

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    const now = new Date(Date.now() + 120_000);
    await Promise.all([
      dispatchDueScheduledJobs(runtime, now),
      dispatchDueScheduledJobs(runtime, now),
    ]);

    assert.equal(runs.length, 1);
  });
});

test('a provider failure is recorded on the run and on the job', async () => {
  await withIsolatedDatabase(async (userId) => {
    const job = createReuseJob(userId);

    await dispatchDueScheduledJobs(createRuntime([], 'throw'), new Date(Date.now() + 120_000));

    const history = scheduledJobsService.listRuns(userId, job.id);
    assert.equal(history[0].status, 'failed');
    assert.match(history[0].error ?? '', /provider exploded/);
    assert.equal(scheduledJobsDb.getById(userId, job.id)?.last_status, 'failed');
  });
});

test('manual runs are recorded with the manual trigger and leave the cadence alone', async () => {
  await withIsolatedDatabase(async (userId) => {
    const job = createReuseJob(userId);
    const nextRunAt = scheduledJobsDb.getById(userId, job.id)?.next_run_at;

    const { job: row, runId } = scheduledJobsService.requestManualRun(userId, job.id);
    const runs: RunCall[] = [];
    await executeScheduledJobRun(row, runId, createRuntime(runs));

    assert.equal(runs.length, 1);
    const history = scheduledJobsService.listRuns(userId, job.id);
    assert.equal(history[0].trigger, 'manual');
    assert.equal(history[0].status, 'succeeded');
    assert.equal(scheduledJobsDb.getById(userId, job.id)?.next_run_at, nextRunAt);
  });
});

test('a stranded running run is failed on dispatcher startup', async () => {
  await withIsolatedDatabase(async (userId) => {
    const job = createReuseJob(userId);
    scheduledJobsService.requestManualRun(userId, job.id);

    const runs: RunCall[] = [];
    initializeScheduledJobDispatcher(createRuntime(runs));
    closeScheduledJobDispatcher();

    const history = scheduledJobsService.listRuns(userId, job.id);
    assert.equal(history[0].status, 'failed');
    assert.match(history[0].error ?? '', /server restart/);
  });
});

test('runScheduledJobNow starts a manual run through the initialized dispatcher', async () => {
  await withIsolatedDatabase(async (userId) => {
    const job = createReuseJob(userId);

    const runs: RunCall[] = [];
    initializeScheduledJobDispatcher(createRuntime(runs));
    await runScheduledJobNow(userId, job.id);

    // The run is fire-and-forget; give the runtime a moment to settle.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = scheduledJobsService.listRuns(userId, job.id)[0]?.status;
      if (status && status !== 'running') {
        assert.equal(status, 'succeeded');
        closeScheduledJobDispatcher();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    closeScheduledJobDispatcher();
    assert.fail('the manual run never settled');
  });
});

test('pausing stops firing and re-enabling schedules from now', async () => {
  await withIsolatedDatabase(async (userId) => {
    const job = createReuseJob(userId);

    scheduledJobsService.update(userId, job.id, { enabled: false });
    const runs: RunCall[] = [];
    assert.equal(
      await dispatchDueScheduledJobs(createRuntime(runs), new Date(Date.now() + 30 * 60_000)),
      0,
    );
    assert.equal(runs.length, 0);

    const reenabled = scheduledJobsService.update(userId, job.id, { enabled: true });
    assert.ok(new Date(reenabled.nextRunAt).getTime() > Date.now());
    assert.equal(scheduledJobsService.listRuns(userId, job.id).length, 0);
  });
});

test('another user cannot see or change a job', async () => {
  await withIsolatedDatabase(async (userId) => {
    const job = createReuseJob(userId);

    assert.equal(scheduledJobsService.list(userId + 1).length, 0);
    assert.throws(
      () => scheduledJobsService.update(userId + 1, job.id, { name: 'stolen' }),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_JOB_NOT_FOUND',
    );
    assert.throws(
      () => scheduledJobsService.listRuns(userId + 1, job.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_JOB_NOT_FOUND',
    );
    assert.throws(
      () => scheduledJobsService.remove(userId + 1, job.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_JOB_NOT_FOUND',
    );
  });
});

test('creating a job validates its schedule and binding', async () => {
  await withIsolatedDatabase(async (userId) => {
    const base = {
      userId,
      name: 'Job',
      sessionId: SESSION_ID,
      sessionMode: 'reuse',
      prompt: 'do it',
      cronExpression: CRON_EVERY_MINUTE,
      timezone: TIMEZONE,
    };

    assert.throws(
      () => createReuseJob(userId, { prompt: '   ' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULED_JOB',
    );
    assert.throws(
      () => createReuseJob(userId, { cronExpression: 'not a cron' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_CRON_EXPRESSION',
    );
    assert.throws(
      () => createReuseJob(userId, { cronExpression: '0 0 9 * * *' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_CRON_EXPRESSION',
    );
    assert.throws(
      () => createReuseJob(userId, { timezone: 'Not/AZone' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_CRON_EXPRESSION',
    );
    assert.throws(
      () => scheduledJobsService.create({ ...base, sessionId: 'nope' }),
      (error: Error & { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
    assert.throws(
      () => scheduledJobsService.create({
        ...base,
        sessionId: undefined,
        sessionMode: 'new',
        provider: 'nope',
        projectPath: '/tmp',
      }),
      (error: Error & { code?: string }) => error.code === 'PROVIDER_NOT_AVAILABLE',
    );
    assert.throws(
      () => scheduledJobsService.create({
        ...base,
        sessionId: undefined,
        sessionMode: 'new',
        provider: 'claude',
        projectPath: '   ',
      }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULED_JOB',
    );
  });
});

test('a one-off task fires once and is disabled instead of repeating', async () => {
  await withIsolatedDatabase(async (userId) => {
    // Fixed instant so the derived expression is deterministic: 09:30 Shanghai.
    const runAt = new Date('2027-03-05T01:30:00.000Z');
    const job = createReuseJob(userId, { cronExpression: undefined, runAt: runAt.toISOString() });

    assert.equal(job.runAt, runAt.toISOString());
    assert.equal(job.nextRunAt, runAt.toISOString());
    assert.equal(job.cronExpression, '30 9 5 3 *');

    const runs: RunCall[] = [];
    await dispatchDueScheduledJobs(createRuntime(runs), new Date(runAt.getTime() + 10_000));

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'run the nightly checks');
    assert.equal(scheduledJobsService.listRuns(userId, job.id)[0].status, 'succeeded');

    const row = scheduledJobsDb.getById(userId, job.id);
    assert.equal(row?.enabled, 0);
    assert.equal(row?.next_run_at, runAt.toISOString());

    // A later pass must not fire it a second time.
    assert.equal(
      await dispatchDueScheduledJobs(createRuntime(runs), new Date(runAt.getTime() + 24 * 60 * 60_000)),
      0,
    );
    assert.equal(runs.length, 1);
  });
});

test('a one-off that came due while the server was down is missed, not replayed', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runAt = new Date(Date.now() + 60_000);
    const job = createReuseJob(userId, { cronExpression: undefined, runAt: runAt.toISOString() });

    const runs: RunCall[] = [];
    await dispatchDueScheduledJobs(createRuntime(runs), new Date(runAt.getTime() + 30 * 60_000));

    assert.equal(runs.length, 0);
    assert.equal(scheduledJobsService.listRuns(userId, job.id)[0].status, 'missed');
    assert.equal(scheduledJobsDb.getById(userId, job.id)?.enabled, 0);
  });
});

test('a one-off validates its instant, and a spent one can only be re-armed with a new time', async () => {
  await withIsolatedDatabase(async (userId) => {
    const runAt = new Date(Date.now() + 60_000);

    assert.throws(
      () => createReuseJob(userId, { cronExpression: undefined, runAt: new Date(Date.now() - 60_000).toISOString() }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULED_JOB',
    );
    assert.throws(
      () => createReuseJob(userId, { cronExpression: undefined, runAt: 'not-a-date' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULED_JOB',
    );
    assert.throws(
      () => createReuseJob(userId, { runAt: runAt.toISOString() }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULED_JOB',
    );

    const job = createReuseJob(userId, { cronExpression: undefined, runAt: runAt.toISOString() });
    await dispatchDueScheduledJobs(createRuntime([]), new Date(runAt.getTime() + 10_000));
    assert.equal(scheduledJobsDb.getById(userId, job.id)?.enabled, 0);

    // The claim disabled the job, but its instant is still ahead of the wall
    // clock the update path reads; move it into the past to stand in for a
    // one-off that has truly been spent.
    scheduledJobsDb.update(userId, job.id, { runAt: new Date(Date.now() - 60_000) });
    assert.throws(
      () => scheduledJobsService.update(userId, job.id, { enabled: true }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULED_JOB',
    );

    const newRunAt = new Date(Date.now() + 120_000);
    const rearmed = scheduledJobsService.update(userId, job.id, { runAt: newRunAt.toISOString() });
    assert.equal(rearmed.enabled, true);
    assert.equal(rearmed.runAt, newRunAt.toISOString());
    assert.equal(rearmed.nextRunAt, newRunAt.toISOString());

    // Clearing the instant returns the job to the cron it was created with.
    const recurring = scheduledJobsService.update(userId, job.id, { runAt: null });
    assert.equal(recurring.runAt, null);
    assert.ok(new Date(recurring.nextRunAt).getTime() > Date.now());
  });
});

test('editing the schedule recomputes the next run', async () => {
  await withIsolatedDatabase(async (userId) => {
    const job = createReuseJob(userId);
    const before = job.nextRunAt;

    const updated = scheduledJobsService.update(userId, job.id, {
      cronExpression: '0 9 * * 1-5',
      timezone: 'Europe/Stockholm',
    });

    assert.equal(updated.cronExpression, '0 9 * * 1-5');
    assert.equal(updated.timezone, 'Europe/Stockholm');
    assert.notEqual(updated.nextRunAt, before);
    assert.ok(new Date(updated.nextRunAt).getTime() > Date.now());
  });
});
