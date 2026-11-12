import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import type { StorageEngine } from 'multer';

import { createBoundedMemoryStorage } from '@/modules/voice/voice.module.js';

/**
 * Runs one upload through the storage engine directly. The fake file only
 * needs `stream`; the engine reports its result or error through the callback.
 */
function runUpload(
  storage: StorageEngine,
  stream: Readable,
): Promise<{ buffer: Buffer; size: number }> {
  return new Promise((resolve, reject) => {
    const file = { stream } as unknown as Express.Multer.File;
    storage._handleFile({} as never, file, (error, info) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(info as { buffer: Buffer; size: number });
    });
  });
}

test('caps the buffered audio at the configured byte limit', async () => {
  const storage = createBoundedMemoryStorage(1024);
  const uploaded = await runUpload(storage, Readable.from([Buffer.alloc(4096, 9)]));

  // Multer's Busboy limit is fileSize + 1; the gate must stop at the real cap.
  assert.equal(uploaded.size, 1024);
  assert.equal(uploaded.buffer.length, 1024);
});

test('buffers audio below the limit through byte-for-byte', async () => {
  const storage = createBoundedMemoryStorage(1024);
  const payload = Buffer.from('voice sample bytes', 'utf8');
  const uploaded = await runUpload(storage, Readable.from([payload]));

  assert.equal(uploaded.size, payload.length);
  assert.deepEqual(uploaded.buffer, payload);
});

test('_removeFile drops the buffered audio', async () => {
  const storage = createBoundedMemoryStorage(1024);
  const file = {
    buffer: Buffer.alloc(8, 1),
  } as unknown as Express.Multer.File;

  await new Promise<void>((resolve, reject) => {
    storage._removeFile({} as never, file, (error) => (error ? reject(error) : resolve()));
  });

  assert.equal((file as { buffer?: Buffer }).buffer, undefined);
});
