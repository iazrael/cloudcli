import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-pin-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

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
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Creates sessions whose activity times are spread one minute apart, oldest first. */
function seedSessions(projectPath: string, sessionIds: string[]): void {
  projectsDb.ensureProjectPath(projectPath);
  sessionIds.forEach((sessionId, index) => {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    sessionsDb.createSession(sessionId, 'claude', projectPath, sessionId, timestamp, timestamp);
  });
}

test('new sessions start unpinned', async () => {
  await withIsolatedDatabase(() => {
    seedSessions('/repo', ['ses_a']);
    assert.equal(sessionsDb.getSessionById('ses_a')?.isPinned, 0);
  });
});

test('updateSessionIsPinned sets and clears the flag without touching activity time', async () => {
  await withIsolatedDatabase(() => {
    seedSessions('/repo', ['ses_a']);
    const before = sessionsDb.getSessionById('ses_a');

    sessionsDb.updateSessionIsPinned('ses_a', true);
    const pinned = sessionsDb.getSessionById('ses_a');
    assert.equal(pinned?.isPinned, 1);
    assert.equal(pinned?.updated_at, before?.updated_at);

    sessionsDb.updateSessionIsPinned('ses_a', false);
    assert.equal(sessionsDb.getSessionById('ses_a')?.isPinned, 0);
  });
});

test('project session pages list pinned sessions first, so an old pinned session is on page one', async () => {
  await withIsolatedDatabase(() => {
    seedSessions('/repo', ['ses_old', 'ses_mid', 'ses_new']);
    sessionsDb.updateSessionIsPinned('ses_old', true);

    const firstPage = sessionsDb.getSessionsByProjectPathPage('/repo', 2, 0).map((row) => row.session_id);
    assert.deepEqual(firstPage, ['ses_old', 'ses_new']);

    const secondPage = sessionsDb.getSessionsByProjectPathPage('/repo', 2, 2).map((row) => row.session_id);
    assert.deepEqual(secondPage, ['ses_mid']);
  });
});

test('pinned sessions keep activity order among themselves', async () => {
  await withIsolatedDatabase(() => {
    seedSessions('/repo', ['ses_1', 'ses_2', 'ses_3', 'ses_4']);
    sessionsDb.updateSessionIsPinned('ses_1', true);
    sessionsDb.updateSessionIsPinned('ses_3', true);

    const ids = sessionsDb.getSessionsByProjectPathPage('/repo', 10, 0).map((row) => row.session_id);
    assert.deepEqual(ids, ['ses_3', 'ses_1', 'ses_4', 'ses_2']);
  });
});

test('the recent conversations feed lists pinned sessions from every project first', async () => {
  await withIsolatedDatabase(() => {
    seedSessions('/repo-a', ['ses_a_old', 'ses_a_new']);
    seedSessions('/repo-b', ['ses_b_old', 'ses_b_new']);
    sessionsDb.updateSessionIsPinned('ses_a_old', true);

    const page = sessionsDb.getRecentSessionsPage(2, 0);
    assert.equal(page.total, 4);
    assert.equal(page.sessions[0]?.session_id, 'ses_a_old');
    assert.equal(page.sessions[0]?.isPinned, 1);
  });
});

test('existing databases gain the isPinned column through migration', async () => {
  await withIsolatedDatabase(async () => {
    const columns = (getConnection().prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.ok(columns.includes('isPinned'));

    getConnection().exec('ALTER TABLE sessions DROP COLUMN isPinned');
    closeConnection();
    await initializeDatabase();

    const migratedColumns = (getConnection().prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.ok(migratedColumns.includes('isPinned'));
  });
});
