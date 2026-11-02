import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-mapping-'));
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

test('disk-discovered sessions are keyed by the provider id for both columns', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('provider-abc', 'claude', '/workspace/demo', 'From Disk');

    const row = sessionsDb.getSessionById('provider-abc');
    assert.equal(row?.session_id, 'provider-abc');
    assert.equal(row?.provider_session_id, 'provider-abc');

    const byProviderId = sessionsDb.getSessionByProviderSessionId('provider-abc');
    assert.equal(byProviderId?.session_id, 'provider-abc');
  });
});

test('app sessions get the provider id assigned without creating a duplicate row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-1', 'claude', '/workspace/demo', 'Initial CloudCLI message');
    sessionsDb.assignProviderSessionId('app-id-1', 'provider-xyz');

    // A later synchronizer pass that discovers the transcript on disk must
    // update the app row in place instead of inserting a provider-keyed row.
    const returnedId = sessionsDb.createSession(
      'provider-xyz',
      'claude',
      '/workspace/demo',
      'Synced Name',
      undefined,
      undefined,
      '/fake/path/provider-xyz.jsonl',
    );

    assert.equal(returnedId, 'app-id-1');
    assert.equal(sessionsDb.getAllSessions().length, 1);

    const row = sessionsDb.getSessionById('app-id-1');
    assert.equal(row?.provider_session_id, 'provider-xyz');
    assert.equal(row?.jsonl_path, '/fake/path/provider-xyz.jsonl');
    // The row is unlocked, so the synced (engine-derived) name replaces the
    // initial app name; only a user rename (name_locked) would keep it.
    assert.equal(row?.custom_name, 'Synced Name');

    sessionsDb.updateSessionCustomName('app-id-1', 'User rename', { lockName: true });
    sessionsDb.createSession(
      'provider-xyz',
      'claude',
      '/workspace/demo',
      'Newer Synced Name',
      undefined,
      undefined,
      '/fake/path/provider-xyz.jsonl',
    );
    assert.equal(sessionsDb.getSessionById('app-id-1')?.custom_name, 'User rename');
  });
});

test('assignProviderSessionId merges a watcher-created duplicate into the app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-id-2', 'codex', '/workspace/demo');

    // Simulate the race: the filesystem watcher indexed the provider
    // transcript before the runtime announced its session id to the gateway.
    sessionsDb.createSession(
      'provider-race',
      'codex',
      '/workspace/demo',
      'Watcher Name',
      undefined,
      undefined,
      '/fake/provider-race.jsonl',
    );
    assert.equal(sessionsDb.getAllSessions().length, 2);

    sessionsDb.assignProviderSessionId('app-id-2', 'provider-race');

    const rows = sessionsDb.getAllSessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.session_id, 'app-id-2');
    assert.equal(rows[0]?.provider_session_id, 'provider-race');
    // Transcript path and name from the duplicate are adopted.
    assert.equal(rows[0]?.jsonl_path, '/fake/provider-race.jsonl');
    assert.equal(rows[0]?.custom_name, 'Watcher Name');
  });
});

test('repointSessionToProviderSession moves both columns and retires the old transcript', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-edit-1', 'claude', '/workspace/demo', 'Edited first prompt');
    sessionsDb.assignProviderSessionId('app-edit-1', 'native-before-edit');
    sessionsDb.createSession(
      'native-before-edit',
      'claude',
      '/workspace/demo',
      'Edited first prompt',
      undefined,
      undefined,
      '/fake/transcripts/native-before-edit.jsonl',
    );

    // The watcher indexed the replacement transcript before the runtime
    // announced its id: the same conversation, under a second sidebar id.
    sessionsDb.createSession(
      'native-after-edit',
      'claude',
      '/workspace/demo',
      'Watcher name',
      undefined,
      undefined,
      '/fake/transcripts/native-after-edit.jsonl',
    );
    assert.equal(sessionsDb.getAllSessions().length, 2);

    sessionsDb.repointSessionToProviderSession('app-edit-1', {
      providerSessionId: 'native-after-edit',
      jsonlPath: '/fake/transcripts/native-after-edit.jsonl',
      supersedePrevious: true,
    });

    const rows = sessionsDb.getAllSessions();
    assert.equal(rows.length, 1, 'the watcher duplicate is replaced, not kept');
    assert.equal(rows[0]?.session_id, 'app-edit-1');
    assert.equal(rows[0]?.provider_session_id, 'native-after-edit');
    assert.equal(rows[0]?.jsonl_path, '/fake/transcripts/native-after-edit.jsonl');

    // The transcript the conversation left must not come back through a later
    // full rescan; its path stays recorded so force-delete can still reach it.
    assert.equal(sessionsDb.isProviderSessionSuperseded('native-before-edit', 'claude'), true);
    assert.deepEqual(
      sessionsDb.getSupersededTranscriptPaths('app-edit-1'),
      ['/fake/transcripts/native-before-edit.jsonl'],
    );
  });
});

test('legacy provider-keyed rows stay resolvable through both lookups', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('legacy-1', 'opencode', '/workspace/demo');

    assert.equal(sessionsDb.getSessionById('legacy-1')?.provider, 'opencode');
    assert.equal(sessionsDb.getSessionByProviderSessionId('legacy-1')?.session_id, 'legacy-1');
  });
});
