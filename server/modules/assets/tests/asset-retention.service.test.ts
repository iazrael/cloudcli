import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  sweepDerivedAssets,
  sweepUnreferencedUploads,
} from '@/modules/assets/services/asset-retention.service.js';

const OLD = new Date('2026-01-01T00:00:00.000Z');
const CUTOFF_MS = new Date('2026-06-01T00:00:00.000Z').getTime();
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

async function withDirs(run: (assets: string, roots: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'asset-retention-'));
  const assets = path.join(base, 'assets');
  const roots = path.join(base, 'roots');
  await mkdir(assets);
  await mkdir(roots);
  try {
    await run(assets, roots);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function put(dir: string, name: string, old = true, content = 'x'.repeat(10)): Promise<void> {
  await writeFile(path.join(dir, name), content);
  if (old) await utimes(path.join(dir, name), OLD, OLD);
}

test('derived assets older than the cutoff go, everything else stays', async () => {
  await withDirs(async (assets) => {
    await put(assets, 'inline-abc.png');
    await put(assets, 'zcode-12345678-name.png');
    await put(assets, 'inline-new.png', false);
    await put(assets, `${UUID_A}-photo.png`);
    await put(assets, 'unknown-file.png');

    const result = await sweepDerivedAssets({ cutoffMs: CUTOFF_MS, assetsDir: assets });

    assert.deepEqual(result, { files: 2, bytes: 20 });
    assert.deepEqual((await readdir(assets)).sort(), [`${UUID_A}-photo.png`, 'inline-new.png', 'unknown-file.png'].sort());
  });
});

test('a dry run of the derived sweep reports the same numbers and deletes nothing', async () => {
  await withDirs(async (assets) => {
    await put(assets, 'inline-abc.png');
    const result = await sweepDerivedAssets({ cutoffMs: CUTOFF_MS, assetsDir: assets, dryRun: true });
    assert.deepEqual(result, { files: 1, bytes: 10 });
    assert.deepEqual(await readdir(assets), ['inline-abc.png']);
  });
});

test('a symlink in the assets folder is never followed or removed', async () => {
  await withDirs(async (assets, roots) => {
    await put(roots, 'target.png');
    await symlink(path.join(roots, 'target.png'), path.join(assets, 'inline-link.png'));
    const result = await sweepDerivedAssets({ cutoffMs: CUTOFF_MS, assetsDir: assets });
    assert.equal(result.files, 0);
    assert.deepEqual(await readdir(assets), ['inline-link.png']);
  });
});

test('an old upload nothing refers to is removed; a referenced one stays', async () => {
  await withDirs(async (assets, roots) => {
    await put(assets, `${UUID_A}-kept.png`);
    await put(assets, `${UUID_B}-orphan.png`);
    await mkdir(path.join(roots, 'nested'));
    await writeFile(path.join(roots, 'nested', 'chat.jsonl'), `{"path":"/x/assets/${UUID_A}-kept.png"}\n`);

    const result = await sweepUnreferencedUploads({ cutoffMs: CUTOFF_MS, assetsDir: assets, referenceRoots: [roots] });

    assert.deepEqual(result, { files: 1, bytes: 10 });
    assert.deepEqual(await readdir(assets), [`${UUID_A}-kept.png`]);
  });
});

test('a reference that straddles a read chunk still counts', async () => {
  await withDirs(async (assets, roots) => {
    await put(assets, `${UUID_A}-kept.png`);
    // Puts the id across the 1MiB stream boundary.
    await writeFile(path.join(roots, 'big.jsonl'), `${'y'.repeat(1024 * 1024 - 10)}${UUID_A}-kept.png`);
    const result = await sweepUnreferencedUploads({ cutoffMs: CUTOFF_MS, assetsDir: assets, referenceRoots: [roots] });
    assert.equal(result.files, 0);
  });
});

test('recent uploads and non-upload names are out of scope', async () => {
  await withDirs(async (assets, roots) => {
    await put(assets, `${UUID_A}-recent.png`, false);
    await put(assets, 'not-a-uuid-name.png');
    const result = await sweepUnreferencedUploads({ cutoffMs: CUTOFF_MS, assetsDir: assets, referenceRoots: [roots] });
    assert.equal(result.files, 0);
    assert.equal((await readdir(assets)).length, 2);
  });
});

test('a reference root that cannot be read stops the sweep with nothing deleted', async () => {
  await withDirs(async (assets, roots) => {
    await put(assets, `${UUID_B}-orphan.png`);
    const unreadable = path.join(roots, 'not-a-directory');
    await writeFile(unreadable, 'x');
    await assert.rejects(sweepUnreferencedUploads({
      cutoffMs: CUTOFF_MS,
      assetsDir: assets,
      referenceRoots: [roots],
      readFileStream: () => { throw new Error('EACCES'); },
    }), /EACCES/);
    assert.equal((await readdir(assets)).length, 1);
  });
});

test('a missing reference root means that engine has no data', async () => {
  await withDirs(async (assets, roots) => {
    await put(assets, `${UUID_B}-orphan.png`);
    const result = await sweepUnreferencedUploads({
      cutoffMs: CUTOFF_MS,
      assetsDir: assets,
      referenceRoots: [path.join(roots, 'never-used-engine')],
    });
    assert.equal(result.files, 1);
  });
});

test('no reference roots at all deletes nothing', async () => {
  await withDirs(async (assets) => {
    await put(assets, `${UUID_B}-orphan.png`);
    await assert.rejects(
      sweepUnreferencedUploads({ cutoffMs: CUTOFF_MS, assetsDir: assets, referenceRoots: [] }),
      /reference roots/i,
    );
    assert.equal((await readdir(assets)).length, 1);
  });
});

test('an id broken by a SQLite overflow pointer still counts as a mention', async () => {
  await withDirs(async (assets, roots) => {
    await put(assets, `${UUID_A}-front.png`);
    await put(assets, `${UUID_B}-back.png`);
    const brokenEarly = `${UUID_A.slice(0, 6)}\u0000\u0001\u0002\u0003${UUID_A.slice(6)}`;
    const brokenLate = `${UUID_B.slice(0, 30)}\u0000\u0001\u0002\u0003${UUID_B.slice(30)}`;
    await writeFile(path.join(roots, 'db.sqlite'), `xx${brokenEarly}yy${brokenLate}zz`, 'latin1');
    const result = await sweepUnreferencedUploads({ cutoffMs: CUTOFF_MS, assetsDir: assets, referenceRoots: [roots] });
    assert.equal(result.files, 0);
  });
});

test('a symlinked reference root is scanned, not skipped', async () => {
  await withDirs(async (assets, roots) => {
    await put(assets, `${UUID_A}-kept.png`);
    const moved = path.join(roots, 'moved');
    await mkdir(moved);
    await writeFile(path.join(moved, 'chat.jsonl'), UUID_A);
    await symlink(moved, path.join(roots, 'link'));
    const result = await sweepUnreferencedUploads({
      cutoffMs: CUTOFF_MS,
      assetsDir: assets,
      referenceRoots: [path.join(roots, 'link')],
    });
    assert.equal(result.files, 0);
  });
});

test('a symlink nested in a root is followed, and a cycle ends', async () => {
  await withDirs(async (assets, roots) => {
    await put(assets, `${UUID_A}-kept.png`);
    const outside = path.join(roots, 'outside');
    const scanned = path.join(roots, 'scanned');
    await mkdir(outside);
    await mkdir(scanned);
    await writeFile(path.join(outside, 'chat.jsonl'), UUID_A);
    await symlink(outside, path.join(scanned, 'link'));
    await symlink(scanned, path.join(scanned, 'loop'));
    const result = await sweepUnreferencedUploads({ cutoffMs: CUTOFF_MS, assetsDir: assets, referenceRoots: [scanned] });
    assert.equal(result.files, 0);
  });
});

test('a dry run of the upload sweep deletes nothing', async () => {
  await withDirs(async (assets, roots) => {
    await put(assets, `${UUID_B}-orphan.png`);
    const result = await sweepUnreferencedUploads({ cutoffMs: CUTOFF_MS, assetsDir: assets, referenceRoots: [roots], dryRun: true });
    assert.equal(result.files, 1);
    assert.equal((await readdir(assets)).length, 1);
  });
});
