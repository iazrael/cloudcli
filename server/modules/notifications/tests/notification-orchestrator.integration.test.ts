import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionTurnFailuresDb,
  sessionsDb,
} from '@/modules/database/index.js';

import {
  buildNotificationPayload,
  notifyRunFailed,
} from '../services/notification-orchestrator.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('notification payload uses the app session id for a provider session id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-session-1', 'claude-native-1');

    const payload = buildNotificationPayload({
      provider: 'claude',
      sessionId: 'claude-native-1',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });

    assert.equal(payload.data.sessionId, 'app-session-1');
    assert.match(payload.data.tag, /app-session-1/);
  });
});

test('a failed run persists its final error under the app session id for history readers', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-2', 'antigravity', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-session-2', 'agy-native-9');

    // userId null keeps the delivery channels out of the test; persistence
    // happens before any preference gate because it is data, not a push.
    notifyRunFailed({
      userId: null,
      provider: 'antigravity',
      sessionId: 'agy-native-9',
      error: 'Our servers are experiencing high traffic right now.',
    });

    assert.deepEqual(sessionTurnFailuresDb.getTurnFailure('app-session-2'), {
      provider: 'antigravity',
      errorText: 'Our servers are experiencing high traffic right now.',
      failedAt: sessionTurnFailuresDb.getTurnFailure('app-session-2')?.failedAt,
    });
    // The overlay orders this stamp against engine transcript timestamps, so
    // it must be a parseable ISO instant, not SQLite's naive CURRENT_TIMESTAMP.
    const storedFailedAt = sessionTurnFailuresDb.getTurnFailure('app-session-2')?.failedAt ?? '';
    assert.notEqual(Date.parse(storedFailedAt), NaN);
    assert.match(storedFailedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

test('a failed run without a resolvable app session persists nothing', async () => {
  await withIsolatedDatabase(() => {
    notifyRunFailed({
      userId: null,
      provider: 'antigravity',
      sessionId: 'no-such-session-anywhere',
      error: 'boom',
    });
    assert.equal(sessionTurnFailuresDb.getTurnFailure('no-such-session-anywhere'), null);
  });
});
