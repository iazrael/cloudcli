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
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
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

test('session archive queries hide archived rows from active project views', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const activeProjectSessions = sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);
  });
});

test('createSession preserves archived state of existing rows', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    // A rescan of an unchanged transcript passes its (stale) file timestamps;
    // since the upstream rework, an omitted timestamp would count as fresh
    // activity and legitimately unarchive the row.
    const staleTimestamp = new Date(Date.now() - 60_000).toISOString();
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name', staleTimestamp, staleTimestamp);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const session = sessionsDb.getSessionById('session-reused');

    assert.equal(activeSessions.length, 0);
    assert.equal(archivedSessions.length, 1);
    assert.equal(archivedSessions[0]?.session_id, 'session-reused');
    assert.equal(session?.isArchived, 1);
  });
});

test('the cutoff listing and the archiving by id cover the stale sessions and only those', async () => {
  await withIsolatedDatabase(() => {
    // One clock read for every instant, and a cutoff a full day in the past,
    // so nothing here depends on how long the test itself takes. Reading the
    // clock afresh for each cutoff instead put `session-fresh` — written with
    // SQLite's second-resolution CURRENT_TIMESTAMP — exactly on the boundary:
    // the test only passed while its whole body ran inside one second, and
    // under full-suite load the second call archived it and the run went red.
    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    sessionsDb.createSession('session-stale-1', 'claude', '/workspace/demo-project', 'Stale 1', twoDaysAgo, twoDaysAgo);
    sessionsDb.createSession('session-stale-2', 'claude', '/workspace/demo-project', 'Stale 2', twoDaysAgo, twoDaysAgo);
    // Left on CURRENT_TIMESTAMP on purpose — that default is what a rescan
    // writes, and it must still read as newer than the cutoff.
    sessionsDb.createSession('session-fresh', 'claude', '/workspace/demo-project', 'Fresh');
    sessionsDb.createSession('session-already-archived', 'claude', '/workspace/demo-project', 'Archived', twoDaysAgo, twoDaysAgo);
    sessionsDb.updateSessionIsArchived('session-already-archived', true);

    const candidates = sessionsDb.listSessionsOlderThanCutoff(oneDayAgo);
    const archivedIds = sessionsDb.archiveSessionsByIds(candidates);

    assert.deepEqual(archivedIds.sort(), ['session-stale-1', 'session-stale-2']);
    // A second run finds nothing left to archive.
    assert.deepEqual(sessionsDb.listSessionsOlderThanCutoff(oneDayAgo), []);
  });
});

test("createSession leaves an archived row archived when the transcript has not changed", async () => {
  await withIsolatedDatabase(() => {
    const createdAt = "2026-07-18T09:00:00.000Z";
    const updatedAt = "2026-07-18T10:00:00.000Z";
    const jsonlPath = "/transcripts/session-untouched.jsonl";

    sessionsDb.createSession("session-untouched", "claude", "/workspace/demo-project", "A Name", createdAt, updatedAt, jsonlPath);
    sessionsDb.updateSessionIsArchived("session-untouched", true);

    // A full rescan re-indexes every transcript created since the last scan,
    // changed or not, and hands over the timestamps the file still carries.
    sessionsDb.createSession("session-untouched", "claude", "/workspace/demo-project", "A Name", createdAt, updatedAt, jsonlPath);

    assert.equal(sessionsDb.getSessionById("session-untouched")?.isArchived, 1);
    assert.equal(sessionsDb.getArchivedSessions().length, 1);
    assert.equal(sessionsDb.getAllSessions().length, 0);

    // Actually writing to the session again still brings it back.
    sessionsDb.createSession("session-untouched", "claude", "/workspace/demo-project", "A Name", createdAt, "2026-07-18T11:00:00.000Z", jsonlPath);

    assert.equal(sessionsDb.getSessionById("session-untouched")?.isArchived, 0);
  });
});

test("the upsert path counts an omitted timestamp as activity", async () => {
  await withIsolatedDatabase(() => {
    // An app-created row carries no provider id, so indexing it takes the
    // INSERT ... ON CONFLICT branch rather than the UPDATE above. Its
    // updated_at is CURRENT_TIMESTAMP, which resolves to whole seconds, so a
    // call in the same second is not *newer* -- the omitted timestamp itself
    // has to be what reactivates the row.
    sessionsDb.createAppSession("session-legacy", "claude", "/workspace/demo-project");
    sessionsDb.updateSessionIsArchived("session-legacy", true);

    sessionsDb.createSession("session-legacy", "claude", "/workspace/demo-project", "Indexed Name");

    assert.equal(sessionsDb.getSessionById("session-legacy")?.isArchived, 0);
  });
});

test("the upsert path leaves an archived row alone for a transcript older than it", async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession("session-stale", "claude", "/workspace/demo-project");
    sessionsDb.updateSessionIsArchived("session-stale", true);

    sessionsDb.createSession("session-stale", "claude", "/workspace/demo-project", "Indexed Name", "2026-07-18T09:00:00.000Z", "2026-07-18T10:00:00.000Z", "/transcripts/session-stale.jsonl");

    assert.equal(sessionsDb.getSessionById("session-stale")?.isArchived, 1);
  });
});

test("a legacy archived row with a NULL updated_at unarchives on new activity", async () => {
  await withIsolatedDatabase(() => {
    // UPDATE branch: the row is keyed by provider_session_id, so indexing it
    // again takes the UPDATE path. Legacy rows predating timestamp bookkeeping
    // carry updated_at NULL; without the NULL guard every julianday comparison
    // against them is false and they could never leave the archive.
    sessionsDb.createSession("session-null-ts-update", "claude", "/workspace/demo-project", "A Name", "2026-07-18T09:00:00.000Z", "2026-07-18T10:00:00.000Z");
    sessionsDb.updateSessionIsArchived("session-null-ts-update", true);
    getConnection().prepare("UPDATE sessions SET updated_at = NULL WHERE session_id = ?").run("session-null-ts-update");

    sessionsDb.createSession("session-null-ts-update", "claude", "/workspace/demo-project", "A Name", undefined, "2026-07-18T11:00:00.000Z");

    assert.equal(sessionsDb.getSessionById("session-null-ts-update")?.isArchived, 0);
  });
});

test("the upsert path unarchives a legacy row with a NULL updated_at", async () => {
  await withIsolatedDatabase(() => {
    // ON CONFLICT branch: the app row has no provider id yet, so indexing
    // takes INSERT ... ON CONFLICT against its session_id.
    sessionsDb.createAppSession("session-null-ts-conflict", "claude", "/workspace/demo-project");
    sessionsDb.updateSessionIsArchived("session-null-ts-conflict", true);
    getConnection().prepare("UPDATE sessions SET updated_at = NULL WHERE session_id = ?").run("session-null-ts-conflict");

    sessionsDb.createSession("session-null-ts-conflict", "claude", "/workspace/demo-project", "Indexed Name", undefined, "2026-07-18T11:00:00.000Z");

    assert.equal(sessionsDb.getSessionById("session-null-ts-conflict")?.isArchived, 0);
  });
});


test('repository reads normalize SQLite UTC timestamps to ISO strings', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-timezone', 'claude', '/workspace/demo-project');

    const row = sessionsDb.getSessionById('session-timezone');
    assert.ok(row?.created_at.endsWith('Z'));
    assert.ok(row?.updated_at.endsWith('Z'));
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('createSession lets an engine title replace an unlocked name and spares locked ones', async () => {
  await withIsolatedDatabase(() => {
    // App-created rows carry the initial first-sentence name and no lock, so
    // the next synchronizer write may replace it with the engine's own title.
    sessionsDb.createAppSession('app-unlocked', 'claude', '/workspace/demo-project', 'first sentence name');
    sessionsDb.assignProviderSessionId('app-unlocked', 'prov-unlocked');
    sessionsDb.createSession('prov-unlocked', 'claude', '/workspace/demo-project', 'Engine title');

    assert.equal(sessionsDb.getSessionById('app-unlocked')?.custom_name, 'Engine title');
    assert.equal(sessionsDb.getSessionById('app-unlocked')?.name_locked, 0);

    // After the user renamed the session the lock is set; engine titles no
    // longer win, in either upsert branch.
    sessionsDb.updateSessionCustomName('app-unlocked', 'My own name', { lockName: true });

    sessionsDb.createSession('prov-unlocked', 'claude', '/workspace/demo-project', 'Newer engine title');
    assert.equal(sessionsDb.getSessionById('app-unlocked')?.custom_name, 'My own name');

    // ON CONFLICT branch: the app row has no provider id yet, so indexing
    // under its own id lands there.
    sessionsDb.createAppSession('app-locked', 'claude', '/workspace/demo-project', 'first sentence name');
    sessionsDb.updateSessionCustomName('app-locked', 'Renamed early', { lockName: true });
    sessionsDb.createSession('app-locked', 'claude', '/workspace/demo-project', 'Engine title');

    assert.equal(sessionsDb.getSessionById('app-locked')?.custom_name, 'Renamed early');
  });
});

test('updateSessionCustomName only locks when asked', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-codex-upgrade', 'codex', '/workspace/demo-project', 'Untitled Codex Session');

    // The synchronizer's fallback-name upgrade must not mark the row as
    // user-renamed — the engine title has to stay followable.
    sessionsDb.updateSessionCustomName('session-codex-upgrade', 'Engine title');
    assert.equal(sessionsDb.getSessionById('session-codex-upgrade')?.name_locked, 0);

    sessionsDb.updateSessionCustomName('session-codex-upgrade', 'Renamed', { lockName: true });
    assert.equal(sessionsDb.getSessionById('session-codex-upgrade')?.name_locked, 1);
  });
});

test('createForkedSession locks the name only when the user typed one', async () => {  await withIsolatedDatabase(() => {
    const baseInput = {
      sessionId: 'unused',
      provider: 'claude',
      projectPath: '/workspace/demo-project',
      customName: 'Fork name',
      providerSessionId: 'prov-fork',
      jsonlPath: '/transcripts/fork.jsonl',
      forkedFromSessionId: 'source-session',
      model: null,
      effort: null,
    } as const;

    sessionsDb.createForkedSession({ ...baseInput, sessionId: 'fork-user-title', nameLocked: true });
    sessionsDb.createForkedSession({ ...baseInput, sessionId: 'fork-auto-title', nameLocked: false });

    assert.equal(sessionsDb.getSessionById('fork-user-title')?.name_locked, 1);
    assert.equal(sessionsDb.getSessionById('fork-auto-title')?.name_locked, 0);
  });
});

test('a fork inherits the window the branched conversation was measured against', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createForkedSession({
      sessionId: 'fork-with-window',
      provider: 'claude',
      projectPath: '/workspace/demo-project',
      customName: 'Fork',
      nameLocked: false,
      providerSessionId: 'prov-fork-window',
      jsonlPath: '/transcripts/fork-window.jsonl',
      forkedFromSessionId: 'source-session',
      model: 'opus[1m]',
      effort: null,
      contextWindow: 1_000_000,
    });

    // Without this the page's first reading falls back to a 200k default and
    // draws 5x the real occupancy until the first turn ends.
    assert.equal(sessionsDb.getSessionById('fork-with-window')?.context_window, 1_000_000);
  });
});

test('recent sessions are globally ordered, paginated, and limited to visible conversations', async () => {
  await withIsolatedDatabase(() => {
    const fixtures: Array<Parameters<typeof sessionsDb.createSession>> = [
      ['session-oldest', 'claude', '/workspace/project-a', 'Oldest', '2026-07-18T09:00:00.000Z', '2026-07-18T10:00:00.000Z'],
      ['session-newest', 'codex', '/workspace/project-b', 'Newest', '2026-07-18T11:00:00.000Z', '2026-07-18T12:00:00.900Z'],
      ['session-same-second', 'claude', '/workspace/project-a', 'Same second, slightly older', '2026-07-18T12:00:00.000Z', '2026-07-18T12:00:00.100Z'],
      ['session-middle', 'claude', '/workspace/project-a', 'Middle', '2026-07-18T10:00:00.000Z', '2026-07-18T11:00:00.000Z'],
      ['session-archived', 'claude', '/workspace/project-a', 'Archived session', '2026-07-18T13:00:00.000Z', '2026-07-18T13:00:00.000Z'],
      ['session-hidden-project', 'claude', '/workspace/project-hidden', 'Archived project session', '2026-07-18T14:00:00.000Z', '2026-07-18T14:00:00.000Z'],
    ];
    fixtures.forEach((fixture) => sessionsDb.createSession(...fixture));

    sessionsDb.updateSessionIsArchived('session-archived', true);
    projectsDb.updateProjectIsArchived('/workspace/project-hidden', true);

    const firstPage = sessionsDb.getRecentSessionsPage(2, 0);
    const secondPage = sessionsDb.getRecentSessionsPage(2, 2);

    assert.equal(firstPage.total, 4);
    assert.deepEqual(
      firstPage.sessions.map((session) => session.session_id),
      ['session-newest', 'session-same-second'],
    );
    assert.equal(secondPage.total, 4);
    assert.deepEqual(
      secondPage.sessions.map((session) => session.session_id),
      ['session-middle', 'session-oldest'],
    );
  });
});

test('automatic names only change the matching unlocked active native session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('auto-title', 'codex', '/workspace/title', 'Original');
    sessionsDb.assignProviderSessionId('auto-title', 'thread-a');
    const before = sessionsDb.getSessionById('auto-title')!;
    assert.equal(sessionsDb.applyAutomaticSessionName('auto-title', 'codex', 'thread-a', '排查重复消息'), true);
    assert.equal(sessionsDb.getSessionById('auto-title')?.custom_name, '排查重复消息');
    assert.equal(sessionsDb.getSessionById('auto-title')?.updated_at, before.updated_at);
    for (const [provider, nativeId] of [['claude', 'thread-a'], ['codex', 'thread-b']]) {
      assert.equal(sessionsDb.applyAutomaticSessionName('auto-title', provider, nativeId, 'Wrong'), false);
    }
    sessionsDb.updateSessionIsArchived('auto-title', true);
    assert.equal(sessionsDb.applyAutomaticSessionName('auto-title', 'codex', 'thread-a', 'Archived'), false);
    sessionsDb.updateSessionIsArchived('auto-title', false);
    sessionsDb.updateSessionCustomName('auto-title', 'My title', { lockName: true });
    assert.equal(sessionsDb.applyAutomaticSessionName('auto-title', 'codex', 'thread-a', 'Overwrite'), false);
    assert.equal(sessionsDb.getSessionById('auto-title')?.custom_name, 'My title');
    assert.equal(sessionsDb.applyAutomaticSessionName('missing', 'codex', 'thread-a', 'Missing'), false);
  });
});
