import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import type { Request, Response, NextFunction } from 'express';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import scheduledJobsRoutes from '@/modules/scheduled-jobs/scheduled-jobs.routes.js';
import {
  closeScheduledJobDispatcher,
  initializeScheduledJobDispatcher,
} from '@/modules/scheduled-jobs/services/scheduled-job-dispatcher.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const SESSION_ID = 'route-session';
const TIMEZONE = 'Asia/Shanghai';

type ApiEnvelope = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: unknown;
};

/** Boots the router with an authenticated user, like server/index.ts mounts it. */
async function withRoutes(
  runTest: (request: (method: string, url: string, body?: unknown) => Promise<{ status: number; body: ApiEnvelope }>, userId: number) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-job-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const user = userDb.createUser('routes', 'hash');
  const userId = Number(user.id);
  sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Route session');

  const app = express()
    .use(express.json())
    .use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user?: { id: number } }).user = { id: userId };
      next();
    })
    .use('/api/scheduled-jobs', scheduledJobsRoutes)
    // Mirrors the app's error middleware: AppError becomes a JSON envelope
    // with its status and machine-readable code instead of Express's HTML page.
    .use((error: Error & { statusCode?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(error.statusCode ?? 500).json({
        success: false,
        error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message },
      });
    });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const request = async (method: string, url: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${url}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: ApiEnvelope;
      try {
        parsed = JSON.parse(text) as ApiEnvelope;
      } catch {
        parsed = { raw: text.slice(0, 400) } as ApiEnvelope;
      }
      return { status: response.status, body: parsed };
    };
    await runTest(request, userId);
  } finally {
    closeScheduledJobDispatcher();
    chatRunRegistry.clearAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const JOB_BODY = {
  name: 'Nightly checks',
  prompt: 'run the nightly checks',
  sessionMode: 'reuse',
  sessionId: SESSION_ID,
  cronExpression: '30 9 * * *',
  timezone: TIMEZONE,
};

test('the routes create, list, edit, run and delete a job', async () => {
  await withRoutes(async (request) => {
    const created = await request('POST', '/api/scheduled-jobs', JOB_BODY);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const jobId = created.body.data?.id as string;
    assert.ok(jobId);
    assert.equal(created.body.data?.provider, 'claude');

    const listed = await request('GET', '/api/scheduled-jobs');
    assert.equal(listed.status, 200);
    assert.equal((listed.body.data as unknown as unknown[]).length, 1);

    const scoped = await request('GET', `/api/scheduled-jobs?sessionId=${SESSION_ID}`);
    assert.equal((scoped.body.data as unknown as unknown[]).length, 1);
    const otherScope = await request('GET', '/api/scheduled-jobs?projectPath=/elsewhere');
    assert.equal((otherScope.body.data as unknown as unknown[]).length, 0);

    const paused = await request('PATCH', `/api/scheduled-jobs/${jobId}`, { enabled: false });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.data?.enabled, false);

    const runs = await request('GET', `/api/scheduled-jobs/${jobId}/runs`);
    assert.equal(runs.status, 200);
    assert.deepEqual(runs.body.data, []);

    const deleted = await request('DELETE', `/api/scheduled-jobs/${jobId}`);
    assert.equal(deleted.status, 200);

    const missing = await request('DELETE', `/api/scheduled-jobs/${jobId}`);
    assert.equal(missing.status, 404);
  });
});

test('creating a job validates its transport input', async () => {
  await withRoutes(async (request) => {
    const missingName = await request('POST', '/api/scheduled-jobs', { ...JOB_BODY, name: '' });
    assert.equal(missingName.status, 400);
    assert.equal((missingName.body.error as { code?: string }).code, 'INVALID_SCHEDULED_JOB');

    const badCron = await request('POST', '/api/scheduled-jobs', { ...JOB_BODY, cronExpression: 'every day' });
    assert.equal(badCron.status, 400);
    assert.equal((badCron.body.error as { code?: string }).code, 'INVALID_CRON_EXPRESSION');

    const unknownSession = await request('POST', '/api/scheduled-jobs', { ...JOB_BODY, sessionId: 'nope' });
    assert.equal(unknownSession.status, 404);
    assert.equal((unknownSession.body.error as { code?: string }).code, 'SESSION_NOT_FOUND');
  });
});

test('run now answers 202 with the opened run', async () => {
  await withRoutes(async (request) => {
    initializeScheduledJobDispatcher({
      hasRuntime: () => true,
      run: async () => {},
      abort: async () => true,
    } as never);

    const created = await request('POST', '/api/scheduled-jobs', JOB_BODY);
    const jobId = created.body.data?.id as string;

    const started = await request('POST', `/api/scheduled-jobs/${jobId}/run`);
    assert.equal(started.status, 202);
    assert.ok(started.body.data?.runId);
  });
});
