import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appConfigDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  createSessionsStorageCleanupService,
  DEFAULT_STORAGE_CLEANUP_SETTINGS,
} from '@/modules/providers/services/sessions-storage-cleanup.service.js';
import { AppError } from '@/shared/utils.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { SessionPurgeResult } from '@/shared/types.js';

const OLD = '2026-01-01T00:00:00.000Z';
const NOW = new Date('2026-11-07T00:00:00.000Z');

type Harness = {
  service: ReturnType<typeof createSessionsStorageCleanupService>;
  deleted: string[];
  artifactCalls: string[];
  purgeCalls: string[][];
  uploadSweeps: string[][];
  derivedSweeps: number;
  busy: Set<string>;
  admission: string[];
  setPurge: (fn: (ids: string[]) => Promise<SessionPurgeResult>) => void;
  onDelete: (fn: (id: string) => void) => void;
  /** Runs once after the artifact step, the way a user acts during a long pass. */
  setAfterArtifacts: (fn: () => void) => void;
  setRoots: (provider: string, roots: string[] | undefined) => void;
  failDelete: Set<string>;
};

async function withHarness(run: (harness: Harness, dir: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'storage-cleanup-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();

  const deleted: string[] = [];
  const artifactCalls: string[] = [];
  const purgeCalls: string[][] = [];
  const uploadSweeps: string[][] = [];
  const busy = new Set<string>();
  const admission: string[] = [];
  const failDelete = new Set<string>();
  let derivedSweeps = 0;
  let purge = async (ids: string[]): Promise<SessionPurgeResult> => ({
    deleted: ids.map((sessionId) => ({ sessionId, bytes: 100 })),
    kept: [],
    failed: [],
  });
  let afterArtifacts: (() => void) | null = null;
  let onDelete: ((id: string) => void) | null = null;
  const roots: Record<string, string[] | undefined> = { claude: ['/roots/claude'], zcode: ['/roots/zcode'] };

  const sessionsFor = (provider: string): Partial<IProviderSessions> => ({
    listStorageRoots: roots[provider] ? () => roots[provider]! : undefined,
    ...(provider === 'zcode'
      ? {
          cleanupSessionArtifacts: async (id: string, options?: { dryRun?: boolean }) => {
            if (!options?.dryRun) artifactCalls.push(id);
            return 10;
          },
          measureSessionStorage: async (ids: string[]) => new Map(ids.map((id) => [id, 1000])),
          purgeSessions: (ids: string[]) => {
            purgeCalls.push(ids);
            return purge(ids);
          },
        }
      : {}),
  });

  const harness: Harness = {
    service: createSessionsStorageCleanupService({
      listProviders: () => ['claude', 'zcode'],
      resolveSessions: (provider) => sessionsFor(provider) as IProviderSessions,
      runtime: {
        hasSessionWork: (id) => busy.has(id),
        closeSessionAdmission: (id) => { admission.push(`close:${id}`); },
        openSessionAdmission: (id) => { admission.push(`open:${id}`); },
      },
      deleteSession: async (id) => {
        onDelete?.(id);
        if (failDelete.has(id)) throw new Error('delete failed');
        deleted.push(id);
        getConnection().prepare('DELETE FROM sessions WHERE session_id = ?').run(id);
      },
      sweepDerivedAssets: async ({ dryRun }) => {
        if (!dryRun) {
          derivedSweeps += 1;
          afterArtifacts?.();
          afterArtifacts = null;
        }
        return { files: 2, bytes: 50 };
      },
      sweepUnreferencedUploads: async ({ referenceRoots }) => {
        uploadSweeps.push(referenceRoots);
        return { files: 1, bytes: 25 };
      },
      now: () => NOW,
    }),
    deleted,
    artifactCalls,
    purgeCalls,
    uploadSweeps,
    get derivedSweeps() { return derivedSweeps; },
    busy,
    admission,
    setPurge: (fn) => { purge = fn; },
    setAfterArtifacts: (fn) => { afterArtifacts = fn; },
    onDelete: (fn) => { onDelete = fn; },
    setRoots: (provider, value) => { roots[provider] = value; },
    failDelete,
  };

  try {
    await run(harness, dir);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function addSession(id: string, options: {
  provider?: string;
  archived?: boolean;
  pinned?: boolean;
  updatedAt?: string;
  forkedFrom?: string;
} = {}): void {
  getConnection().prepare(
    `INSERT INTO sessions (session_id, provider, provider_session_id, isArchived, isPinned, updated_at, forked_from_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    options.provider ?? 'zcode',
    `native-${id}`,
    options.archived === false ? 0 : 1,
    options.pinned ? 1 : 0,
    options.updatedAt ?? OLD,
    options.forkedFrom ?? null,
  );
}

const enablePurge = (harness: Harness) => harness.service.updateSettings({ purgeConversations: true, confirmPurge: true });

test('defaults: off, 30 days, conversations kept', async () => {
  await withHarness(async ({ service }) => {
    assert.deepEqual(DEFAULT_STORAGE_CLEANUP_SETTINGS, { enabled: false, retentionDays: 30, purgeConversations: false });
    assert.deepEqual(service.getSettings(), DEFAULT_STORAGE_CLEANUP_SETTINGS);
  });
});

test('a stored retention outside the offered options falls back to the default', async () => {
  await withHarness(async ({ service }) => {
    appConfigDb.set('sessions_storage_cleanup_settings', JSON.stringify({ enabled: true, retentionDays: 1, purgeConversations: false }));
    assert.equal(service.getSettings().retentionDays, 30);
  });
});

test('turning purge on needs confirmation; turning it off does not', async () => {
  await withHarness(async ({ service }) => {
    assert.throws(() => service.updateSettings({ purgeConversations: true }), (error: unknown) => (
      error instanceof AppError && error.code === 'STORAGE_CLEANUP_CONFIRMATION_REQUIRED'
    ));
    assert.equal(service.getSettings().purgeConversations, false);
    assert.equal(service.updateSettings({ purgeConversations: true, confirmPurge: true }).purgeConversations, true);
    assert.equal(service.updateSettings({ purgeConversations: false }).purgeConversations, false);
  });
});

test('a corrupt stored purge flag never counts as consent', async () => {
  await withHarness(async ({ service }) => {
    appConfigDb.set('sessions_storage_cleanup_settings', '{"purgeConversations":"yes"}');
    assert.equal(service.getSettings().purgeConversations, false);
  });
});

test('only archived, unpinned, idle sessions past the cutoff are eligible', async () => {
  await withHarness(async (harness) => {
    addSession('eligible');
    addSession('active', { archived: false });
    addSession('pinned', { pinned: true });
    addSession('recent', { updatedAt: '2026-11-01T00:00:00.000Z' });
    addSession('corrupt-date', { updatedAt: '+032971-01-01T00:00:00.000Z' });
    addSession('running');
    addSession('queued');
    addSession('scheduled');
    harness.busy.add('running');
    const db = getConnection();
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message) VALUES (1, 'queued', '', '{"content":"next"}')`).run();
    db.prepare(`INSERT INTO scheduled_messages (id, user_id, session_id, content, scheduled_for, status) VALUES ('m1', 1, 'scheduled', 'later', '2027-01-01T00:00:00.000Z', 'pending')`).run();

    const report = await harness.service.run();

    assert.deepEqual(harness.artifactCalls, ['native-eligible']);
    assert.equal(report.sessionsCleaned, 1);
    assert.equal(report.skipped, 3);
  });
});

test('the default mode cleans artifacts and keeps every conversation', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    const report = await harness.service.run();
    assert.deepEqual(harness.deleted, []);
    assert.deepEqual(harness.purgeCalls, []);
    assert.deepEqual(harness.uploadSweeps, []);
    assert.equal(harness.derivedSweeps, 1);
    assert.equal(report.bytesFreed, 60);
    assert.equal(sessionsDb.getSessionById('a')?.session_id, 'a');
  });
});

test('admission closes around the work and reopens for a kept session', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    await harness.service.run();
    assert.deepEqual(harness.admission, ['close:a', 'open:a']);
  });
});

test('one failing artifact cleanup does not stop the others', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    addSession('b');
    const service = createSessionsStorageCleanupService({
      listProviders: () => ['zcode'],
      resolveSessions: () => ({
        cleanupSessionArtifacts: async (id: string) => {
          if (id === 'native-a') throw new Error('EACCES');
          return 5;
        },
      }) as unknown as IProviderSessions,
      runtime: { hasSessionWork: () => false, closeSessionAdmission: () => undefined, openSessionAdmission: () => undefined },
      deleteSession: async () => undefined,
      sweepDerivedAssets: async () => ({ files: 0, bytes: 0 }),
      sweepUnreferencedUploads: async () => ({ files: 0, bytes: 0 }),
      now: () => NOW,
    });
    const report = await service.run();
    assert.equal(report.failed, 1);
    assert.equal(report.sessionsCleaned, 1);
    assert.equal(report.bytesFreed, 5);
  });
});

test('purge needs confirmation at run time', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    enablePurge(harness);
    await assert.rejects(harness.service.run(), (error: unknown) => (
      error instanceof AppError && error.code === 'STORAGE_CLEANUP_CONFIRMATION_REQUIRED'
    ));
    assert.deepEqual(harness.deleted, []);
  });
});

test('only sessions the engine reports deleted lose their row', async () => {
  await withHarness(async (harness) => {
    addSession('gone');
    addSession('referenced');
    addSession('running-in-engine');
    addSession('broken');
    enablePurge(harness);
    harness.setPurge(async () => ({
      deleted: [{ sessionId: 'native-gone', bytes: 700 }],
      kept: [
        { sessionId: 'native-referenced', reason: 'referenced' },
        { sessionId: 'native-running-in-engine', reason: 'running' },
      ],
      failed: [{ sessionId: 'native-broken', code: 'unknown' }],
    }));

    const report = await harness.service.run({ confirmPurge: true });

    assert.deepEqual(harness.deleted, ['gone']);
    assert.equal(report.sessionsDeleted, 1);
    assert.equal(report.skipped, 2);
    assert.equal(report.failed, 1);
    assert.ok(report.bytesFreed >= 700);
    assert.ok(sessionsDb.getSessionById('referenced'));
    assert.ok(sessionsDb.getSessionById('broken'));
  });
});

test('an engine purge that fails outright deletes no row and no upload', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    enablePurge(harness);
    harness.setPurge(async () => { throw new Error('engine down'); });
    const report = await harness.service.run({ confirmPurge: true });
    assert.deepEqual(harness.deleted, []);
    assert.deepEqual(harness.uploadSweeps, []);
    assert.equal(report.failed, 1);
    assert.match(report.errors.join(' '), /engine down/);
  });
});

test('an engine silent about a session counts as failed, not deleted', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    enablePurge(harness);
    harness.setPurge(async () => ({ deleted: [], kept: [], failed: [] }));
    const report = await harness.service.run({ confirmPurge: true });
    assert.deepEqual(harness.deleted, []);
    assert.equal(report.failed, 1);
  });
});

test('providers without a batch purge use the existing delete path', async () => {
  await withHarness(async (harness) => {
    addSession('claude-one', { provider: 'claude' });
    enablePurge(harness);
    await harness.service.run({ confirmPurge: true });
    assert.deepEqual(harness.deleted, ['claude-one']);
    assert.deepEqual(harness.purgeCalls, []);
  });
});

test('a parent of a surviving fork is kept; a parent whose forks all go is purged', async () => {
  await withHarness(async (harness) => {
    addSession('parent-kept', { provider: 'claude' });
    addSession('child-live', { provider: 'claude', archived: false, forkedFrom: 'parent-kept' });
    addSession('parent-gone', { provider: 'claude' });
    addSession('child-gone', { provider: 'claude', forkedFrom: 'parent-gone' });
    addSession('grandparent', { provider: 'claude' });
    addSession('middle', { provider: 'claude', forkedFrom: 'grandparent' });
    addSession('leaf-live', { provider: 'claude', archived: false, forkedFrom: 'middle' });
    enablePurge(harness);

    const report = await harness.service.run({ confirmPurge: true });

    assert.deepEqual([...harness.deleted].sort(), ['child-gone', 'parent-gone']);
    assert.equal(report.skipped, 3);
  });
});

test('one batch stays bounded so the engine scan runs once per pass', async () => {
  await withHarness(async (harness) => {
    for (let index = 0; index < 205; index += 1) addSession(`s${index}`);
    enablePurge(harness);
    const report = await harness.service.run({ confirmPurge: true });
    assert.equal(harness.purgeCalls.length, 1);
    assert.equal(harness.purgeCalls[0].length, 200);
    assert.equal(report.sessionsDeleted, 200);
  });
});

test('a failed row delete after the engine purge is reported, not hidden', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    enablePurge(harness);
    harness.failDelete.add('a');
    const report = await harness.service.run({ confirmPurge: true });
    assert.equal(report.failed, 1);
    assert.equal(report.sessionsDeleted, 0);
  });
});

test('uploads are swept after purge, across every provider root and auth.db', async () => {
  await withHarness(async (harness, dir) => {
    addSession('a');
    enablePurge(harness);
    await harness.service.run({ confirmPurge: true });
    assert.equal(harness.uploadSweeps.length, 1);
    assert.deepEqual([...harness.uploadSweeps[0]].sort(), ['/roots/claude', '/roots/zcode', path.join(dir, 'auth.db'), path.join(dir, 'auth.db-wal')].sort());
  });
});

test('a provider without declared roots skips the upload sweep', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    enablePurge(harness);
    harness.setRoots('claude', undefined);
    const report = await harness.service.run({ confirmPurge: true });
    assert.deepEqual(harness.uploadSweeps, []);
    assert.equal(report.uploadsDeleted, 0);
    assert.match(report.errors.join(' '), /claude/);
  });
});

test('the first purge backs up auth.db once; a failed backup stops the purge', async () => {
  await withHarness(async (harness, dir) => {
    addSession('a');
    enablePurge(harness);
    await harness.service.run({ confirmPurge: true });
    addSession('b');
    await harness.service.run({ confirmPurge: true });
    const backups = (await readdir(dir)).filter((name) => name.includes('.bak.storage-cleanup-'));
    assert.equal(backups.length, 1);
  });

  await withHarness(async (harness) => {
    addSession('a');
    enablePurge(harness);
    const report = await harness.service.run({ confirmPurge: true, backupDatabase: async () => { throw new Error('disk full'); } });
    assert.deepEqual(harness.deleted, []);
    assert.deepEqual(harness.purgeCalls, []);
    assert.match(report.errors.join(' '), /disk full/);
  });
});

test('preview changes nothing and reports both modes', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    addSession('b', { provider: 'claude' });
    const preview = await harness.service.preview();
    assert.equal(preview.sessions, 2);
    assert.equal(preview.purgeableSessions, 2);
    assert.equal(preview.artifactBytes, 60);
    assert.equal(preview.purgeBytes, 1060);
    assert.deepEqual(harness.artifactCalls, []);
    assert.deepEqual(harness.deleted, []);
    assert.equal(harness.derivedSweeps, 0);
  });
});

test('a failed measurement marks the preview partial instead of failing it', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    const service = createSessionsStorageCleanupService({
      listProviders: () => ['zcode'],
      resolveSessions: () => ({
        measureSessionStorage: async () => { throw new Error('engine down'); },
      }) as unknown as IProviderSessions,
      runtime: { hasSessionWork: () => false, closeSessionAdmission: () => undefined, openSessionAdmission: () => undefined },
      deleteSession: async () => undefined,
      sweepDerivedAssets: async () => ({ files: 0, bytes: 0 }),
      sweepUnreferencedUploads: async () => ({ files: 0, bytes: 0 }),
      now: () => NOW,
    });
    const preview = await service.preview();
    assert.equal(preview.partial, true);
    assert.equal(preview.sessions, 1);
  });
});

test('a concurrent run is refused', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    const first = harness.service.run();
    await assert.rejects(harness.service.run(), (error: unknown) => (
      error instanceof AppError && error.code === 'STORAGE_CLEANUP_RUNNING'
    ));
    await first;
  });
});

test('the report is stored and the scheduled run waits a full day', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    await harness.service.run();
    assert.equal(harness.service.getLastReport()?.sessionsCleaned, 1);

    harness.service.updateSettings({ enabled: true });
    assert.equal(await harness.service.runIfDue(), false);
    assert.equal(harness.artifactCalls.length, 1);
  });
});

test('the scheduled run stays off until enabled', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    assert.equal(await harness.service.runIfDue(), false);
    assert.deepEqual(harness.artifactCalls, []);
    harness.service.updateSettings({ enabled: true });
    assert.equal(await harness.service.runIfDue(), true);
    assert.equal(harness.artifactCalls.length, 1);
  });
});

test('a scheduled run honours the stored purge consent', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    harness.service.updateSettings({ enabled: true, purgeConversations: true, confirmPurge: true });
    assert.equal(await harness.service.runIfDue(), true);
    assert.deepEqual(harness.deleted, ['a']);
  });
});

test('a session restored after listing survives the engine purge', async () => {
  await withHarness(async (harness) => {
    addSession('restored');
    addSession('still-old');
    enablePurge(harness);
    // Restored while the pass was cleaning artifacts, after the first listing.
    harness.setAfterArtifacts(() => {
      getConnection().prepare(`UPDATE sessions SET isArchived = 0 WHERE session_id = 'restored'`).run();
    });
    const report = await harness.service.run({ confirmPurge: true });
    assert.deepEqual(harness.purgeCalls, [['native-still-old']]);
    assert.ok(sessionsDb.getSessionById('restored'));
    assert.equal(report.skipped, 1);
  });
});

test('a session pinned mid-pass survives the delete path too', async () => {
  await withHarness(async (harness) => {
    addSession('pinned-late', { provider: 'claude' });
    addSession('other', { provider: 'claude' });
    addSession('z', { provider: 'zcode' });
    enablePurge(harness);
    harness.setAfterArtifacts(() => {
      getConnection().prepare(`UPDATE sessions SET isPinned = 1 WHERE session_id = 'pinned-late'`).run();
    });
    await harness.service.run({ confirmPurge: true });
    assert.deepEqual(harness.deleted.filter((id) => id !== 'z'), ['other']);
  });
});

test('engine purges happen with admission closed, and it reopens after', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    enablePurge(harness);
    harness.setPurge(async () => {
      assert.ok(harness.admission.at(-1)?.startsWith('close:'));
      return { deleted: [], kept: [{ sessionId: 'native-a', reason: 'referenced' }], failed: [] };
    });
    await harness.service.run({ confirmPurge: true });
    assert.equal(harness.admission.at(-1), 'open:a');
  });
});

test('a row from a removed engine is skipped and the pass carries on', async () => {
  await withHarness(async (harness) => {
    addSession('legacy', { provider: 'removed-engine' });
    addSession('a');
    const report = await harness.service.run();
    assert.deepEqual(harness.artifactCalls, ['native-a']);
    assert.equal(report.skipped, 1);
  });
});

test('shortening the window or enabling with purge on needs confirmation', async () => {
  await withHarness(async (harness) => {
    enablePurge(harness);
    const needsConfirmation = (error: unknown) => (
      error instanceof AppError && error.code === 'STORAGE_CLEANUP_CONFIRMATION_REQUIRED'
    );
    assert.throws(() => harness.service.updateSettings({ retentionDays: 7 }), needsConfirmation);
    assert.throws(() => harness.service.updateSettings({ enabled: true }), needsConfirmation);
    assert.equal(harness.service.getSettings().retentionDays, 30);
    assert.equal(harness.service.updateSettings({ retentionDays: 60 }).retentionDays, 60);
    assert.equal(harness.service.updateSettings({ retentionDays: 7, confirmPurge: true }).retentionDays, 7);
  });
});

test('with purge off, the window and the switch change freely', async () => {
  await withHarness(async ({ service }) => {
    assert.equal(service.updateSettings({ retentionDays: 7 }).retentionDays, 7);
    assert.equal(service.updateSettings({ enabled: true }).enabled, true);
  });
});

test('the batch cap never separates a parent from a fork it depends on', async () => {
  await withHarness(async (harness) => {
    for (let index = 0; index < 200; index += 1) {
      addSession(`parent${index}`, { provider: 'claude', updatedAt: '2026-01-01T00:00:00.000Z' });
      addSession(`fork${index}`, { provider: 'claude', updatedAt: '2026-02-01T00:00:00.000Z', forkedFrom: `parent${index}` });
    }
    enablePurge(harness);
    await harness.service.run({ confirmPurge: true });
    assert.equal(harness.deleted.length, 200);
    assert.ok(harness.deleted.every((id) => id.startsWith('fork')));
    await harness.service.run({ confirmPurge: true });
    assert.equal(harness.deleted.length, 400);
  });
});

test('a row sharing its engine session with a surviving row is kept', async () => {
  await withHarness(async (harness) => {
    addSession('old-copy', { provider: 'claude' });
    addSession('live-copy', { provider: 'claude', archived: false });
    getConnection().prepare(`UPDATE sessions SET provider_session_id = 'shared' WHERE session_id IN ('old-copy', 'live-copy')`).run();
    enablePurge(harness);
    await harness.service.run({ confirmPurge: true });
    assert.deepEqual(harness.deleted, []);
    assert.ok(sessionsDb.getSessionById('old-copy'));
  });
});

test('a provider without artifact cleanup does not count as cleaned', async () => {
  await withHarness(async (harness) => {
    addSession('claude-one', { provider: 'claude' });
    const report = await harness.service.run();
    assert.equal(report.sessionsCleaned, 0);
  });
});

test('the upload scan also reads the write-ahead log', async () => {
  await withHarness(async (harness, dir) => {
    addSession('a');
    enablePurge(harness);
    await harness.service.run({ confirmPurge: true });
    assert.ok(harness.uploadSweeps[0].includes(path.join(dir, 'auth.db-wal')));
  });
});

test('a session dropped at the last check gets its admission back', async () => {
  await withHarness(async (harness) => {
    addSession('restored');
    addSession('purged');
    enablePurge(harness);
    harness.setAfterArtifacts(() => {
      getConnection().prepare(`UPDATE sessions SET isArchived = 0 WHERE session_id = 'restored'`).run();
    });
    await harness.service.run({ confirmPurge: true });
    const closes = harness.admission.filter((entry) => entry === 'close:restored').length;
    const opens = harness.admission.filter((entry) => entry === 'open:restored').length;
    assert.equal(opens, closes);
  });
});

test('a deleted session stays closed; a kept or failed one reopens', async () => {
  await withHarness(async (harness) => {
    addSession('gone');
    addSession('kept');
    addSession('broken');
    enablePurge(harness);
    harness.failDelete.add('broken');
    harness.setPurge(async () => ({
      deleted: [{ sessionId: 'native-gone', bytes: 1 }, { sessionId: 'native-broken', bytes: 1 }],
      kept: [{ sessionId: 'native-kept', reason: 'referenced' }],
      failed: [],
    }));
    await harness.service.run({ confirmPurge: true });
    const lastFor = (id: string) => harness.admission.filter((entry) => entry.endsWith(`:${id}`)).at(-1);
    assert.equal(lastFor('gone'), 'close:gone');
    assert.equal(lastFor('kept'), 'open:kept');
    assert.equal(lastFor('broken'), 'open:broken');
  });
});

test('admission stays closed while the row of a purged session is deleted', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    enablePurge(harness);
    const seen: (string | undefined)[] = [];
    harness.onDelete((id) => { seen.push(harness.admission.filter((entry) => entry.endsWith(`:${id}`)).at(-1)); });
    await harness.service.run({ confirmPurge: true });
    assert.deepEqual(seen, ['close:a']);
  });
});

test('every admission closed by a failing purge reopens', async () => {
  await withHarness(async (harness) => {
    addSession('a');
    enablePurge(harness);
    harness.setPurge(async () => { throw new Error('engine down'); });
    await harness.service.run({ confirmPurge: true });
    assert.equal(harness.admission.at(-1), 'open:a');
  });
});

test('deferred sessions past the batch cap count as skipped', async () => {
  await withHarness(async (harness) => {
    for (let index = 0; index < 205; index += 1) addSession(`s${index}`);
    enablePurge(harness);
    const report = await harness.service.run({ confirmPurge: true });
    assert.equal(report.skipped, 5);
  });
});
