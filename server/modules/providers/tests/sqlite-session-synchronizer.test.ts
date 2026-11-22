import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { SqliteSessionSynchronizer } from '@/modules/providers/shared/sessions/sqlite-session-synchronizer.provider.js';

import { workspaceFixturePath } from './workspace-fixture.js';

type FixtureRow = {
  id: string;
  title: string | null;
  /** 1 when `title` stands for a content-derived name the engine did not generate. */
  derived?: number;
  updated_ms: number;
};

class FixtureSynchronizer extends SqliteSessionSynchronizer<FixtureRow> {
  protected readonly fallbackTitle = 'Untitled Fixture';
  protected readonly logTag = '[Fixture]';
  protected readonly watchedFileBasenames = ['fixture.db', 'fixture.db-wal'];

  constructor(private readonly dbPath: string) {
    super('zcode');
  }

  protected getDatabasePath(): string {
    return this.dbPath;
  }

  protected selectSessionRows(
    db: Database.Database,
    sinceMillis: number | null,
    limit: number | null,
  ): FixtureRow[] {
    return db.prepare(`
      SELECT id, title, derived, updated_ms
      FROM session
      WHERE (? IS NULL OR updated_ms > ?)
      ORDER BY updated_ms DESC
      ${limit === null ? '' : 'LIMIT ?'}
    `).all(...(limit === null
      ? [sinceMillis, sinceMillis]
      : [sinceMillis, sinceMillis, limit])) as FixtureRow[];
  }

  protected getRowTimestampsMs(row: FixtureRow): { createdAtMs: number; updatedAtMs: number } {
    return { createdAtMs: row.updated_ms, updatedAtMs: row.updated_ms };
  }

  protected getProjectPath(row: FixtureRow): string | null {
    return row.id === 'no-project' ? null : fixtureWorkspacePath(row.id);
  }

  protected deriveSessionName(_db: Database.Database, row: FixtureRow) {
    return { name: row.title, generated: row.title !== null && !row.derived };
  }
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

/**
 * Workspace directory the fixture rows claim. Session indexing only admits a
 * workspace that still exists on disk **outside** the system temporary
 * directories, so the fixtures use real directories created beside the tests
 * instead of naming an imaginary `/workspace/...` path or a temp scratch dir.
 */
function fixtureWorkspacePath(sessionId: string): string {
  return workspaceFixturePath(`sqlite-${sessionId}`);
}

/** Creates the fixture provider database with two dated session rows. */
async function createFixtureDatabase(directory: string, rows: FixtureRow[]): Promise<string> {
  const dbPath = path.join(directory, 'fixture.db');
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, derived INTEGER DEFAULT 0, updated_ms INTEGER)');
    const insert = db.prepare('INSERT INTO session (id, title, derived, updated_ms) VALUES (?, ?, ?, ?)');
    for (const row of rows) {
      insert.run(row.id, row.title, row.derived ?? 0, row.updated_ms);
      await mkdir(fixtureWorkspacePath(row.id), { recursive: true });
    }
  } finally {
    db.close();
  }
  return dbPath;
}

test('synchronizeFile ignores files outside the declared watch basenames', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_1', title: 'One', updated_ms: 1_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      const synchronizer = new FixtureSynchronizer(dbPath);

      assert.equal(await synchronizer.synchronizeFile(path.join(tempDir, 'unrelated.txt')), null);
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_1'), null);

      assert.equal(await synchronizer.synchronizeFile(path.join(tempDir, 'fixture.db-wal')), 'sess_1');
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('watch target derives the root from the database path and reuses the basename predicate', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, []);

  try {
    const synchronizer = new FixtureSynchronizer(dbPath);
    const target = synchronizer.getSessionWatchTarget();

    assert.equal(target.rootPath, tempDir);
    assert.equal(target.isTargetFile(path.join(tempDir, 'fixture.db')), true);
    assert.equal(target.isTargetFile(path.join(tempDir, 'fixture.db-wal')), true);
    assert.equal(target.isTargetFile(path.join(tempDir, 'other.db')), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('scan upserts rows, keeps custom names, and reports the first session id', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_a', title: 'Provider title', updated_ms: 2_000 },
    { id: 'sess_b', title: null, updated_ms: 3_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      // A pre-existing app session with a custom name keeps it; the fallback
      // title on an existing row does not.
      sessionsDb.createAppSession('app-b', 'zcode', fixtureWorkspacePath('sess_b'), 'My custom name');

      const synchronizer = new FixtureSynchronizer(dbPath);
      const processed = await synchronizer.synchronize();
      assert.equal(processed, 2);

      const sessionA = sessionsDb.getSessionByProviderSessionId('sess_a');
      assert.equal(sessionA?.custom_name, 'Provider title');
      assert.equal(sessionA?.jsonl_path, null);

      // sess_a's provider row is separate; the app row keeps its custom name
      // after the provider id was bound to it.
      const sessionB = sessionsDb.getSessionByProviderSessionId('sess_b');
      assert.equal(sessionB?.custom_name, 'My custom name');
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a generated engine title replaces an unlocked name and spares a locked one', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_follow', title: 'Fresh engine title', updated_ms: 4_000 },
    { id: 'sess_locked', title: 'Fresh engine title', updated_ms: 5_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      // Both rows already carry a real (non-fallback) name from an earlier
      // sync; the second one was renamed by the user and is locked.
      sessionsDb.createSession('sess_follow', 'zcode', fixtureWorkspacePath('sess_follow'), 'Old synced name');
      sessionsDb.createSession('sess_locked', 'zcode', fixtureWorkspacePath('sess_locked'), 'Old synced name');
      sessionsDb.updateSessionCustomName('sess_locked', 'My rename', { lockName: true });

      const synchronizer = new FixtureSynchronizer(dbPath);
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_follow')?.custom_name, 'Fresh engine title');
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_locked')?.custom_name, 'My rename');
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a content-derived name never overwrites an existing name but fills empty ones', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_derived_real', title: 'Derived from content', derived: 1, updated_ms: 4_000 },
    { id: 'sess_derived_fallback', title: 'Derived from content', derived: 1, updated_ms: 5_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession('sess_derived_real', 'zcode', fixtureWorkspacePath('sess_derived_real'), 'Earlier real name');
      sessionsDb.createSession('sess_derived_fallback', 'zcode', fixtureWorkspacePath('sess_derived_fallback'), 'Untitled Fixture');

      const synchronizer = new FixtureSynchronizer(dbPath);
      await synchronizer.synchronize();

      // The derived name may not drift an existing real name…
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_derived_real')?.custom_name, 'Earlier real name');
      // …but it does replace the placeholder.
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_derived_fallback')?.custom_name, 'Derived from content');
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('incremental syncs read only rows newer than the high-water mark', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_old', title: 'Old', updated_ms: 1_000 },
    { id: 'sess_new', title: 'New', updated_ms: 2_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      const synchronizer = new FixtureSynchronizer(dbPath);

      assert.equal(await synchronizer.synchronize(), 2);

      // Nothing new since the high-water mark (2_000).
      assert.equal(await synchronizer.synchronizeFile(path.join(tempDir, 'fixture.db')), null);

      // A strictly newer row is picked up; the older one is not reprocessed.
      const db = new Database(dbPath);
      try {
        db.prepare('INSERT INTO session (id, title, updated_ms) VALUES (?, ?, ?)')
          .run('sess_newest', 'Newest', 3_000);
      } finally {
        db.close();
      }
      await mkdir(fixtureWorkspacePath('sess_newest'), { recursive: true });

      assert.equal(await synchronizer.synchronizeFile(path.join(tempDir, 'fixture.db')), 'sess_newest');
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_old')?.custom_name, 'Old');
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_newest')?.custom_name, 'Newest');
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('binds provider-discovered sessions to pending app sessions', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_pending', title: 'From provider', updated_ms: 5_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      // The app created a session and is waiting for the provider id to arrive.
      sessionsDb.createAppSession('app-pending', 'zcode', fixtureWorkspacePath('sess_pending'));

      const synchronizer = new FixtureSynchronizer(dbPath);
      assert.equal(await synchronizer.synchronize(), 1);

      const bound = sessionsDb.getSessionById('app-pending');
      assert.equal(bound?.provider_session_id, 'sess_pending');
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rows whose workspace directory has vanished are skipped', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'sess_reaped', title: 'Sandbox run', updated_ms: 1_000 },
    { id: 'sess_live', title: 'Real project', updated_ms: 2_000 },
  ]);

  try {
    // An engine that ran inside a `mktemp -d` sandbox keeps naming that
    // directory long after the system reaped it; indexing the row would
    // re-create the same ghost project on every restart.
    await rm(fixtureWorkspacePath('sess_reaped'), { recursive: true, force: true });

    await withIsolatedDatabase(async () => {
      const synchronizer = new FixtureSynchronizer(dbPath);
      assert.equal(await synchronizer.synchronize(), 1);
      assert.equal(sessionsDb.getSessionByProviderSessionId('sess_reaped'), null);
      assert.ok(sessionsDb.getSessionByProviderSessionId('sess_live'));
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rows without a project path are skipped and a missing database yields zero', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-'));
  const dbPath = await createFixtureDatabase(tempDir, [
    { id: 'no-project', title: 'No project', updated_ms: 1_000 },
    { id: 'sess_ok', title: 'Ok', updated_ms: 2_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      const synchronizer = new FixtureSynchronizer(dbPath);
      assert.equal(await synchronizer.synchronize(), 1);
      assert.equal(sessionsDb.getSessionByProviderSessionId('no-project'), null);
      assert.ok(sessionsDb.getSessionByProviderSessionId('sess_ok'));

      // A missing database is a quiet zero, not a throw.
      const missing = new FixtureSynchronizer(path.join(tempDir, 'absent.db'));
      assert.equal(await missing.synchronize(), 0);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

class TwoDatabaseSynchronizer extends FixtureSynchronizer {
  constructor(primaryDbPath: string, private readonly secondaryDbPath: string) {
    super(primaryDbPath);
  }

  protected override getSecondaryDatabasePaths(): string[] {
    return [this.secondaryDbPath];
  }

  override getSessionWatchTarget() {
    const target = super.getSessionWatchTarget();
    return {
      ...target,
      extraRootPaths: [path.dirname(this.secondaryDbPath)],
    };
  }
}

test('scan covers secondary databases and the watch target exposes their roots', async () => {
  const primaryDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-p-'));
  const secondaryDir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-synchronizer-s-'));
  await createFixtureDatabase(primaryDir, [
    { id: 'primary_1', title: 'Primary', updated_ms: 2_000 },
  ]);
  await createFixtureDatabase(secondaryDir, [
    { id: 'secondary_1', title: 'Secondary', updated_ms: 3_000 },
  ]);

  try {
    await withIsolatedDatabase(async () => {
      const synchronizer = new TwoDatabaseSynchronizer(
        path.join(primaryDir, 'fixture.db'),
        path.join(secondaryDir, 'fixture.db'),
      );

      const target = synchronizer.getSessionWatchTarget();
      assert.deepEqual(target.extraRootPaths, [secondaryDir]);

      const processed = await synchronizer.synchronize();
      assert.equal(processed, 2, 'rows from both databases upserted');
      assert.ok(sessionsDb.getSessionByProviderSessionId('primary_1'), 'primary row indexed');
      assert.ok(sessionsDb.getSessionByProviderSessionId('secondary_1'), 'secondary row indexed');

      // Incremental syncs honour the shared high-water mark across both dbs:
      // a new secondary row after the first scan still lands.
      const synchronizer2 = new TwoDatabaseSynchronizer(
        path.join(primaryDir, 'fixture.db'),
        path.join(secondaryDir, 'fixture.db'),
      );
      await synchronizer2.synchronize();
      const db = new Database(path.join(secondaryDir, 'fixture.db'));
      try {
        db.prepare('INSERT INTO session (id, title, derived, updated_ms) VALUES (?, ?, ?, ?)')
          .run('secondary_2', 'Later', 0, 4_000);
      } finally {
        db.close();
      }
      await mkdir(fixtureWorkspacePath('secondary_2'), { recursive: true });
      await synchronizer2.synchronize();
      assert.ok(sessionsDb.getSessionByProviderSessionId('secondary_2'), 'cross-database high-water mark keeps later rows flowing');
    });
  } finally {
    await rm(primaryDir, { recursive: true, force: true });
    await rm(secondaryDir, { recursive: true, force: true });
  }
});
