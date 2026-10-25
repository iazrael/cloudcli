import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createAssetsRouter } from '@/modules/assets/assets.routes.js';

async function withUploads(
  run: (baseUrl: string, home: string, firstResult: () => unknown) => Promise<void>,
  options: Parameters<typeof createAssetsRouter>[0] = {},
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-upload-test-'));
  // os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows, so the
  // isolated upload store needs both variables pointed at the fixture home.
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  let firstPayload: unknown;
  const app = express();
  app.use((req, res, next) => {
    if (!req.header('X-Test-No-User')) Object.assign(req, { user: { id: req.header('X-Test-User') || 'one' } });
    if (req.header('X-Test-Drop-Response')) {
      res.json = ((payload: unknown) => {
        firstPayload = payload;
        res.socket?.destroy();
        return res;
      }) as typeof res.json;
    }
    next();
  });
  app.use('/api/assets', createAssetsRouter(options));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`, home, () => firstPayload);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    await fs.rm(home, { recursive: true, force: true });
  }
}

function upload(baseUrl: string, headers: Record<string, string> = {}) {
  const body = new FormData();
  body.append('files', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  return fetch(`${baseUrl}/api/assets/files`, { method: 'POST', headers, body });
}

test('replays the stored attachment after the successful response is lost, without a second file', async () => {
  await withUploads(async (url, home, firstResult) => {
    const headers = { 'X-Upload-Request-Id': 'response-lost-request-123' };
    await assert.rejects(upload(url, { ...headers, 'X-Test-Drop-Response': '1' }));
    const response = await upload(url, headers);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), firstResult());
    assert.equal((await fs.readdir(path.join(home, '.cloudcli', 'assets'))).length, 1);
  });
});

test('concurrent repeats return the same file while different users and new IDs get separate files', async () => {
  await withUploads(async (url, home) => {
    const headers = { 'X-Upload-Request-Id': 'concurrent-upload-12345' };
    const responses = await Promise.all([upload(url, headers), upload(url, headers), upload(url, headers)]);
    const records = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(records[1], records[0]);
    assert.deepEqual(records[2], records[0]);
    assert.equal((await fs.readdir(path.join(home, '.cloudcli', 'assets'))).length, 1);
    const otherUser = await (await upload(url, { ...headers, 'X-Test-User': 'two' })).json();
    const otherAction = await (await upload(url, { 'X-Upload-Request-Id': 'another-upload-12345' })).json();
    assert.notDeepEqual(otherUser, records[0]);
    assert.notDeepEqual(otherAction, records[0]);
    assert.equal((await fs.readdir(path.join(home, '.cloudcli', 'assets'))).length, 3);
  });
});

test('rejects invalid upload identities before writing any files', async () => {
  await withUploads(async (url, home) => {
    for (const requestId of ['', '../invalid-upload-12345', 'x'.repeat(129)]) {
      assert.equal((await upload(url, { 'X-Upload-Request-Id': requestId })).status, 400);
    }
    await assert.rejects(fs.access(path.join(home, '.cloudcli', 'assets')));
  });
});

test('failed uploads release their identity for a corrected upload', async () => {
  await withUploads(async (url) => {
    const headers = { 'X-Upload-Request-Id': 'failed-upload-request-123' };
    const failed = await fetch(`${url}/api/assets/files`, { method: 'POST', headers, body: new FormData() });
    assert.equal(failed.status, 400);
    assert.equal((await upload(url, headers)).status, 200);
  }, { maxEntries: 1 });
});

test('capacity preserves recent successes and expiry frees capacity for new uploads', async () => {
  let now = 1000;
  await withUploads(async (url) => {
    const headers = { 'X-Upload-Request-Id': 'cache-full-request-123' };
    const first = await (await upload(url, headers)).json();
    assert.equal((await upload(url, { 'X-Upload-Request-Id': 'cache-other-request-123' })).status, 503);
    assert.deepEqual(await (await upload(url, headers)).json(), first);
    now = 1100;
    assert.equal((await upload(url, { 'X-Upload-Request-Id': 'cache-other-request-123' })).status, 200);
    now = 1200;
    const afterExpiry = await (await upload(url, headers)).json();
    assert.notDeepEqual(afterExpiry, first);
  }, { ttlMs: 100, maxEntries: 1, now: () => now });
});

test('legacy uploads without an identity stay independent', async () => {
  await withUploads(async (url) => {
    const first = await (await upload(url)).json();
    const second = await (await upload(url)).json();
    assert.notDeepEqual(first, second);
  });
});

test('image uploads share retry protection but cannot replay a general-file upload', async () => {
  await withUploads(async (url, home) => {
    const headers = { 'X-Upload-Request-Id': 'image-upload-request-123' };
    const files = await (await upload(url, headers)).json() as { attachments: Array<{ path: string }> };
    const uploadImage = () => {
      const body = new FormData();
      body.append('images', new Blob(['image'], { type: 'image/png' }), 'shot.png');
      return fetch(`${url}/api/assets/images`, { method: 'POST', headers, body });
    };
    const image = await (await uploadImage()).json() as { images: Array<{ path: string }> };
    assert.deepEqual(await (await uploadImage()).json(), image);
    assert.ok('images' in image);
    assert.notEqual(image.images[0].path, files.attachments[0].path);
    assert.equal((await fs.readdir(path.join(home, '.cloudcli', 'assets'))).length, 2);
  });
});

test('keyed retries require an authenticated user before writing files', async () => {
  await withUploads(async (url, home) => {
    const response = await upload(url, { 'X-Upload-Request-Id': 'unauthenticated-upload-123', 'X-Test-No-User': '1' });
    assert.equal(response.status, 401);
    await assert.rejects(fs.access(path.join(home, '.cloudcli', 'assets')));
  });
});

test('uploaded files remain downloadable and missing or invalid filenames return errors', async () => {
  await withUploads(async (url) => {
    const record = await (await upload(url)).json() as { attachments: Array<{ path: string }> };
    const filename = path.basename(record.attachments[0].path);
    const response = await fetch(`${url}/api/assets/files/${filename}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Disposition') || '', /^attachment;/);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(await response.text(), 'hello');
    const imageResponse = await fetch(`${url}/api/assets/images/${filename}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(await imageResponse.text(), 'hello');
    for (const kind of ['files', 'images']) {
      assert.equal((await fetch(`${url}/api/assets/${kind}/missing.txt`)).status, 404);
      assert.equal((await fetch(`${url}/api/assets/${kind}/invalid..txt`)).status, 400);
    }
  });
});

test('legacy SVG images download as attachments', async () => {
  await withUploads(async (url) => {
    const body = new FormData();
    body.append('images', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'shot.svg');
    const response = await fetch(`${url}/api/assets/images`, { method: 'POST', body });
    const record = await response.json() as { images: Array<{ path: string }> };
    const download = await fetch(`${url}/api/assets/images/${path.basename(record.images[0].path)}`);
    assert.equal(download.headers.get('Content-Disposition'), 'attachment');
    assert.equal(await download.text(), '<svg/>');
  });
});

test('invalid image formats fail and their identity can be reused for a valid image', async () => {
  await withUploads(async (url) => {
    const headers = { 'X-Upload-Request-Id': 'invalid-image-request-123' };
    const invalid = new FormData();
    invalid.append('images', new Blob(['text'], { type: 'text/plain' }), 'notes.txt');
    assert.equal((await fetch(`${url}/api/assets/images`, { method: 'POST', headers, body: invalid })).status, 400);
    const valid = new FormData();
    valid.append('images', new Blob(['image'], { type: 'image/png' }), 'shot.png');
    assert.equal((await fetch(`${url}/api/assets/images`, { method: 'POST', headers, body: valid })).status, 200);
  }, { maxEntries: 1 });
});

test('a slow in-flight upload keeps its slot beyond the completed-result TTL', async () => {
  let now = 1000;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  await withUploads(async (url) => {
    const requestId = 'slow-pending-upload-123';
    const prefix = '--test-boundary\r\nContent-Disposition: form-data; name="files"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\n';
    const suffix = 'hello\r\n--test-boundary--\r\n';
    let finish!: http.ClientRequest;
    const first = new Promise<unknown>((resolve, reject) => {
      finish = http.request(`${url}/api/assets/files`, {
        method: 'POST', headers: {
          'Content-Type': 'multipart/form-data; boundary=test-boundary',
          'Content-Length': Buffer.byteLength(prefix + suffix),
          'X-Upload-Request-Id': requestId,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); }
        });
        response.on('error', reject);
      });
      finish.on('error', reject);
      finish.write(prefix);
    });
    // Observe rejection immediately even if an assertion fails before the first upload ends.
    void first.catch(() => undefined);
    try {
      await started;
      now = 1200;
      assert.equal((await upload(url, { 'X-Upload-Request-Id': 'other-pending-upload-123' })).status, 503);
      finish.end(suffix);
      const result = await first;
      assert.deepEqual(await (await upload(url, { 'X-Upload-Request-Id': requestId })).json(), result);
    } finally {
      finish.destroy();
    }
  }, { ttlMs: 100, maxEntries: 1, now: () => { markStarted(); return now; } });
});

test('disconnecting in the middle of a file upload releases the cache slot', async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  await withUploads(async (url, home) => {
    const prefix = '--abort-boundary\r\nContent-Disposition: form-data; name="files"; filename="partial.txt"\r\nContent-Type: text/plain\r\n\r\nhe';
    const request = http.request(`${url}/api/assets/files`, {
      method: 'POST', headers: {
        'Content-Type': 'multipart/form-data; boundary=abort-boundary',
        'Content-Length': 1000,
        'X-Upload-Request-Id': 'aborted-upload-request-123',
      },
    });
    const closed = new Promise<void>((resolve) => request.on('error', () => resolve()));
    request.write(prefix);
    await started;
    // Confirm multipart storage has started, rather than aborting before parsing.
    const directory = path.join(home, '.cloudcli', 'assets');
    let filenames: string[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      try { filenames = await fs.readdir(directory); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (filenames.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(filenames.length, 1, 'a partial file was opened');
    request.destroy(new Error('client disconnected during upload'));
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await upload(url, { 'X-Upload-Request-Id': 'after-abort-request-123' });
    assert.equal(response.status, 200, 'failed upload must release the only cache slot');
    assert.equal((await fs.readdir(directory)).length, 1, 'partial upload file must be removed');
  }, { maxEntries: 1, now: () => { markStarted(); return Date.now(); } });
});

test('storage setup errors free the retry slot and remain visible to the caller', async () => {
  await withUploads(async (url, home) => {
    const directory = path.join(home, '.cloudcli');
    await fs.mkdir(directory);
    const blockedAssets = path.join(directory, 'assets');
    await fs.writeFile(blockedAssets, 'not a directory');
    const headers = { 'X-Upload-Request-Id': 'storage-error-request-123' };
    const failed = await upload(url, headers);
    assert.equal(failed.status, 400);
    assert.match(JSON.stringify(await failed.json()), /EEXIST|ENOTDIR/);
    await fs.unlink(blockedAssets);
    assert.equal((await upload(url, headers)).status, 200);
  }, { maxEntries: 1 });
});

test('multipart count limits remove files already written and release the retry identity', async () => {
  await withUploads(async (url, home) => {
    const headers = { 'X-Upload-Request-Id': 'too-many-files-request-123' };
    const body = new FormData();
    for (let index = 0; index < 11; index++) body.append('files', new Blob(['hello']), `${index}.txt`);
    const response = await fetch(`${url}/api/assets/files`, { method: 'POST', headers, body });
    assert.equal(response.status, 400);
    assert.equal((await fs.readdir(path.join(home, '.cloudcli', 'assets'))).length, 0);
    assert.equal((await upload(url, headers)).status, 200);
  }, { maxEntries: 1 });
});

for (const [kind, field, limit, mimeType] of [
  ['files', 'files', 10 * 1024 * 1024, 'text/plain'],
  ['images', 'images', 5 * 1024 * 1024, 'image/png'],
] as const) {
  test(`${kind}: disconnecting after the size limit cleans up without crashing the server`, async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    await withUploads(async (url, home) => {
      const request = http.request(`${url}/api/assets/${kind}`, {
        method: 'POST', headers: {
          'Content-Type': 'multipart/form-data; boundary=size-boundary',
          'Content-Length': limit * 2,
          'X-Upload-Request-Id': 'size-limit-aborted-12345',
        },
      });
      const closed = new Promise<void>((resolve) => request.on('error', () => resolve()));
      request.write(`--size-boundary\r\nContent-Disposition: form-data; name="${field}"; filename="large.png"\r\nContent-Type: ${mimeType}\r\n\r\n`);
      request.write(Buffer.alloc(limit + 1024, 120));
      await started;
      const directory = path.join(home, '.cloudcli', 'assets');
      let storedSize = 0;
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const files = await fs.readdir(directory);
          if (files[0]) storedSize = (await fs.stat(path.join(directory, files[0]))).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (storedSize === limit) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      request.destroy(new Error('client disconnected after file size limit'));
      await closed;
      assert.equal(storedSize, limit, 'server reached its production file size limit');
      // The server releases the aborted upload's slot when it notices the
      // disconnect, which takes however long the event loop needs; the next
      // upload is turned away with 503 until then. Wait for the slot to free
      // (a slot that never frees fails here at the deadline) instead of
      // guessing how long that takes.
      let followUp = await upload(url, { 'X-Upload-Request-Id': 'after-size-limit-12345' });
      for (const deadline = Date.now() + 5_000; followUp.status === 503 && Date.now() < deadline;) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        followUp = await upload(url, { 'X-Upload-Request-Id': 'after-size-limit-12345' });
      }
      assert.equal(followUp.status, 200);
      assert.equal((await fs.readdir(directory)).length, 1, 'only the subsequent successful upload remains');
    }, { maxEntries: 1, now: () => { markStarted(); return Date.now(); } });
  });
}
