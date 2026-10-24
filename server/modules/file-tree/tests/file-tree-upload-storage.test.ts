import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';

import type { StorageEngine } from 'multer';

import { createBoundedDiskStorage } from '@/modules/file-tree/file-tree.module.js';

/**
 * Runs one upload through the storage engine directly. The fake file only
 * needs `stream`; the engine reports its result or error through the callback.
 */
function runUpload(
  storage: StorageEngine,
  stream: Readable,
): Promise<{ path: string; size: number; filename: string; destination: string }> {
  return new Promise((resolve, reject) => {
    const file = { stream } as unknown as Express.Multer.File;
    storage._handleFile({} as never, file, (error, info) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(info as { path: string; size: number; filename: string; destination: string });
    });
  });
}

test('caps the stored file at the configured byte limit', async () => {
  const storage = createBoundedDiskStorage(1024);
  const uploaded = await runUpload(storage, Readable.from([Buffer.alloc(4096, 7)]));

  try {
    // Multer's Busboy limit is fileSize + 1; the gate must stop at the real cap.
    assert.equal(uploaded.size, 1024);
    const stats = await fs.stat(uploaded.path);
    assert.equal(stats.size, 1024);
  } finally {
    await fs.unlink(uploaded.path).catch(() => {});
  }
});

test('writes a file below the limit through byte-for-byte', async () => {
  const storage = createBoundedDiskStorage(1024);
  const payload = Buffer.from('cloudcli upload payload', 'utf8');
  const uploaded = await runUpload(storage, Readable.from([payload]));

  try {
    assert.equal(uploaded.size, payload.length);
    assert.deepEqual(await fs.readFile(uploaded.path), payload);
    assert.match(uploaded.filename, /^cloudcli-file-upload-/);
  } finally {
    await fs.unlink(uploaded.path).catch(() => {});
  }
});

test('_removeFile deletes the partial file, tolerating an already-removed one', async () => {
  const storage = createBoundedDiskStorage(1024);
  const uploaded = await runUpload(storage, Readable.from([Buffer.alloc(16, 1)]));
  const file = { path: uploaded.path } as unknown as Express.Multer.File;

  await new Promise<void>((resolve, reject) => {
    storage._removeFile({} as never, file, (error) => (error ? reject(error) : resolve()));
  });
  await assert.rejects(fs.stat(uploaded.path), { code: 'ENOENT' });

  // A second removal is a no-op: the path was already cleared.
  const secondPath = `${uploaded.path}-absent`;
  await new Promise<void>((resolve, reject) => {
    storage._removeFile(
      {} as never,
      { path: secondPath } as unknown as Express.Multer.File,
      (error) => (error ? reject(error) : resolve()),
    );
  });
});
