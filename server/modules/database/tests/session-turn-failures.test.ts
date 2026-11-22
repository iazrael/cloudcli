import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionTurnFailuresDb } from '@/modules/database/repositories/session-turn-failures.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'turn-failure-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
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
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('turn failure repository upserts one latest failure per session', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(sessionTurnFailuresDb.getTurnFailure('sess-f1'), null);

    sessionTurnFailuresDb.recordTurnFailure({
      sessionId: 'sess-f1',
      provider: 'antigravity',
      errorText: 'first failure',
      failedAt: '2026-11-22T00:30:16.000Z',
    });
    assert.deepEqual(sessionTurnFailuresDb.getTurnFailure('sess-f1'), {
      provider: 'antigravity',
      errorText: 'first failure',
      failedAt: '2026-11-22T00:30:16.000Z',
    });

    // A newer failure in the same session replaces the row: one row per
    // session keeps the table bounded and matches "latest failed turn".
    sessionTurnFailuresDb.recordTurnFailure({
      sessionId: 'sess-f1',
      provider: 'antigravity',
      errorText: 'second failure',
      failedAt: '2026-11-22T01:00:00.000Z',
    });
    assert.equal(sessionTurnFailuresDb.getTurnFailure('sess-f1')?.errorText, 'second failure');

    sessionTurnFailuresDb.deleteTurnFailure('sess-f1');
    assert.equal(sessionTurnFailuresDb.getTurnFailure('sess-f1'), null);
  });
});
