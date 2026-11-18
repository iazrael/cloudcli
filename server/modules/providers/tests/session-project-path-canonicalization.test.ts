import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { canonicalizeSessionProjectPath } from '@/modules/providers/shared/sessions/session-project-path-canonicalization.js';

import { createWorkspaceFixture, workspaceFixturePath } from './workspace-fixture.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await fsSync.promises.mkdtemp(path.join(os.tmpdir(), 'canonicalization-db-'));

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
    await fsSync.promises.rm(tempDirectory, { recursive: true, force: true });
  }
}

function symlinkFixture(name: string, targetPath: string): string {
  const linkPath = workspaceFixturePath(name);
  fsSync.symlinkSync(targetPath, linkPath, 'dir');
  return linkPath;
}

test('files a physically spelled directory onto the project registered through its symlink', async () => {
  await withIsolatedDatabase(async () => {
    const realDirectory = await createWorkspaceFixture();
    const linkDirectory = symlinkFixture('canonical-link', realDirectory);
    projectsDb.ensureProjectPath(linkDirectory);

    // claude ≥ 2.1.327 resolves the symlink and records the physical form.
    assert.equal(canonicalizeSessionProjectPath(realDirectory), linkDirectory);
  });
});

test('files a symlink-spelled directory onto the project registered through its physical path', async () => {
  await withIsolatedDatabase(async () => {
    const realDirectory = await createWorkspaceFixture();
    const linkDirectory = symlinkFixture('canonical-reverse-link', realDirectory);
    projectsDb.ensureProjectPath(realDirectory);

    assert.equal(canonicalizeSessionProjectPath(linkDirectory), realDirectory);
  });
});

test('keeps a directory with no equivalent project exactly as the engine reported it', async () => {
  await withIsolatedDatabase(async () => {
    const realDirectory = await createWorkspaceFixture();
    const linkDirectory = symlinkFixture('canonical-orphan-link', realDirectory);

    // Divergent spelling, but nobody registered either side: a brand-new
    // project must keep forming exactly as before, under the reported form.
    assert.equal(canonicalizeSessionProjectPath(linkDirectory), linkDirectory);
  });
});

test('keeps a path that cannot be resolved on disk exactly as reported', async () => {
  await withIsolatedDatabase(async () => {
    const missingPath = workspaceFixturePath('canonical-missing');

    assert.equal(canonicalizeSessionProjectPath(missingPath), missingPath);
  });
});

test('prefers the equivalent project holding more sessions when a twin pair exists', async () => {
  await withIsolatedDatabase(async () => {
    const realDirectory = await createWorkspaceFixture();
    const linkDirectory = symlinkFixture('canonical-twin-link', realDirectory);
    projectsDb.ensureProjectPath(linkDirectory);
    projectsDb.ensureProjectPath(realDirectory);

    // The twin state this rule exists to heal: both spellings are registered,
    // the original holds the history and the twin holds the freshly split
    // sessions. The heavier side must win so the twin drains instead of fed.
    sessionsDb.createSession('twin-original-1', 'claude', linkDirectory);
    sessionsDb.createSession('twin-original-2', 'claude', linkDirectory);
    sessionsDb.createSession('twin-stray-1', 'claude', realDirectory);

    assert.equal(canonicalizeSessionProjectPath(realDirectory), linkDirectory);
  });
});

test('does not file sessions onto an archived equivalent project', async () => {
  await withIsolatedDatabase(async () => {
    const realDirectory = await createWorkspaceFixture();
    const linkDirectory = symlinkFixture('canonical-archived-link', realDirectory);
    projectsDb.ensureProjectPath(linkDirectory);
    projectsDb.updateProjectIsArchived(linkDirectory, true);

    // A user who archived the twin decided it must not come back; resuming a
    // session must not silently resurrect it as the canonical target.
    assert.equal(canonicalizeSessionProjectPath(realDirectory), realDirectory);
  });
});
