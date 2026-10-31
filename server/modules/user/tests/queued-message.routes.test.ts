import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { createUserRouter } from '../user.routes.js';
import { createUserService } from '../user.service.js';

test('queue HTTP contract protects drafts, detects stale or claimed clears, and validates input', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-routes-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const id = Number(userDb.createUser('queue-routes', 'hash').id);
  sessionsDb.createAppSession('session', 'claude', directory, 'Queue');
  const service = createUserService({
    users: { getGitConfig: () => undefined, updateGitConfig: () => {}, completeOnboarding: () => {}, hasCompletedOnboarding: () => false },
    preferences: { getPreferences: () => ({}), savePreferences: () => {} },
    drafts: sessionDraftsDb,
    readSystemGitConfig: async () => ({ git_name: null, git_email: null }),
    applyGlobalGitConfig: async () => {}, logInfo: () => {}, logError: () => {},
  });
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use((req, _res, next) => { Object.assign(req, { user: { id } }); next(); });
  app.use('/api/user', createUserRouter(service));
  app.use((error: AppError, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode).json({ code: error.code, error: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = async (method: string, suffix: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/user/drafts${suffix}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { code?: string; queuedMessage?: unknown; appended?: boolean } };
  };
  try {
    const a = { content: 'A', images: [{ name: 'a' }], options: { model: 'x', permissionMode: 'plan' } };
    const first = await request('POST', '/queued-message', { scope: 'session', queuedMessage: a });
    assert.deepEqual(first, { status: 200, body: { success: true, queuedMessage: { content: 'A', attachments: [{ name: 'a' }], options: a.options }, appended: false } });
    await request('PUT', '', { scope: 'session', text: 'draft' });
    for (const queuedMessage of [{ content: 'old' }]) {
      const legacy = await request('PUT', '', { scope: 'session', text: 'overwrite', queuedMessage });
      assert.equal(legacy.status, 409);
      assert.equal(legacy.body.code, 'LEGACY_QUEUE_WRITE');
      assert.equal(sessionDraftsDb.getDrafts(id)[0].text, 'draft');
    }
    assert.equal((await request('PUT', '', { scope: 'session', text: 'safe old text', queuedMessage: null })).status, 200);
    assert.equal(sessionDraftsDb.getDrafts(id)[0].text, 'safe old text');
    assert.deepEqual(sessionDraftsDb.getDrafts(id)[0].queuedMessage, first.body.queuedMessage);
    assert.equal((await request('DELETE', '', { scope: 'session' })).status, 200);
    assert.deepEqual(sessionDraftsDb.getDrafts(id)[0].queuedMessage, first.body.queuedMessage);
    const b = await request('POST', '/queued-message', { scope: 'session', queuedMessage: { content: 'B' } });
    assert.equal(b.body.appended, true);
    const stale = await request('DELETE', '/queued-message', { scope: 'session', expectedQueuedMessage: a });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'QUEUED_MESSAGE_CHANGED');
    const conflict = await request('POST', '/queued-message', { scope: 'session', queuedMessage: { content: ' /compact' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'QUEUED_MESSAGE_NOT_COMBINABLE');
    const candidate = sessionDraftsDb.listQueuedMessages()[0];
    sessionDraftsDb.claimQueuedMessage(candidate);
    const claimed = await request('DELETE', '/queued-message', { scope: 'session', expectedQueuedMessage: b.body.queuedMessage });
    assert.equal(claimed.status, 409);
    assert.equal(claimed.body.code, 'QUEUED_MESSAGE_CHANGED');
    sessionDraftsDb.restoreQueuedMessage(candidate);
    const cleared = await request('DELETE', '/queued-message', { scope: 'session', expectedQueuedMessage: { content: 'A\n\nB', images: [{ name: 'a' }], options: { permissionMode: 'plan', model: 'x' } } });
    assert.deepEqual(cleared, { status: 200, body: { success: true } });
    assert.deepEqual(sessionDraftsDb.getDrafts(id), []);
    assert.equal((await request('DELETE', '/queued-message', { scope: 'session', expectedQueuedMessage: a })).status, 409);
    for (const queuedMessage of [null, [], {}, { content: '  ' }, { content: 'A', options: [] }]) {
      assert.equal((await request('POST', '/queued-message', { scope: 'session', queuedMessage })).status, 400);
    }
    assert.equal((await request('POST', '/queued-message', { scope: '', queuedMessage: a })).status, 400);
    assert.equal((await request('DELETE', '/queued-message', { scope: 'session', expectedQueuedMessage: null })).status, 400);
    await request('POST', '/queued-message', { scope: 'session', queuedMessage: { content: 'x'.repeat(60_000) } });
    const large = await request('POST', '/queued-message', { scope: 'session', queuedMessage: { content: 'y'.repeat(60_000) } });
    assert.equal((await request('DELETE', '/queued-message', { scope: 'session', expectedQueuedMessage: large.body.queuedMessage })).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
