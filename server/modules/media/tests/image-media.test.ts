import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import test from 'node:test';

import express from 'express';
import jwt from 'jsonwebtoken';

import { createImageMediaService } from '@/modules/media/image-media.service.js';
import { createMediaRouter } from '@/modules/media/media.routes.js';

async function fixture(run: (base: string, state: { now: number; active: boolean; readable: boolean; version: number }) => Promise<void>) {
  const state = { now: 1_800_000_000, active: true, readable: true, version: 1 };
  const service = createImageMediaService({
    secret: 'test-only-media-secret',
    now: () => state.now,
    userExists: () => state.active,
    resolveImage: async (source) => {
      if (!state.readable || (source.kind !== 'asset' && source.path.includes('missing'))) {
        throw Object.assign(new Error('missing'), { statusCode: 404 });
      }
      return { source, contentType: source.kind === 'asset' && source.filename.endsWith('.svg') ? 'image/svg+xml' : 'image/png', etag: `"v${state.version}"`, size: 3 };
    },
    openImage: async () => Readable.from(['PNG']),
  });
  const routers = createMediaRouter(service, (req, res, next) => {
    if (req.header('authorization') !== 'Bearer test-login') { res.sendStatus(401); return; }
    Object.assign(req, { user: { id: 'user-1' }, authExpiresAt: state.now + 400 });
    next();
  });
  const app = express();
  app.use(express.json());
  app.use('/api/media', routers.images);
  // Signed bytes precede API key validation; issuing a ticket still requires it.
  app.use('/api', (req, res, next) => {
    if (req.header('x-api-key') !== 'test-key') { res.sendStatus(401); return; }
    next();
  });
  app.use('/api/media', routers.signing);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, state); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function readBatch(response: Response) {
  return await response.json() as { images: Array<{ url: string; expiresAt: number; status?: number }> };
}

async function issue(base: string, images: unknown = [{ id: 'a', kind: 'asset', filename: 'a.png' }]) {
  return fetch(`${base}/api/media/image-urls`, {
    method: 'POST', headers: { authorization: 'Bearer test-login', 'x-api-key': 'test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ images }),
  });
}

test('authenticated batch issues direct image URLs; bytes need no login or API key and never refresh auth', async () => {
  await fixture(async (base, state) => {
    const response = await issue(base);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { images: [image] } = await readBatch(response);
    assert.equal(image.expiresAt, (state.now + 400) * 1000);
    const bytes = await fetch(base + image.url);
    assert.equal(bytes.status, 200);
    assert.equal(await bytes.text(), 'PNG');
    assert.equal(bytes.headers.get('content-type'), 'image/png');
    assert.equal(bytes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(bytes.headers.get('x-refreshed-token'), null);
    assert.equal(bytes.headers.get('cache-control'), 'private, no-cache');
  });
});

test('signing requires both API key and login and rejects malformed, duplicate and oversized batches', async () => {
  await fixture(async (base) => {
    assert.equal((await fetch(`${base}/api/media/image-urls`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/api/media/image-urls`, { method: 'POST', headers: { 'x-api-key': 'test-key' } })).status, 401);
    for (const images of [[], [{ id: 'x', kind: 'project', path: 'a.png' }], Array.from({ length: 51 }, (_, i) => ({ id: String(i), kind: 'asset', filename: 'a.png' })), [{ id: 'x', kind: 'asset', filename: 'a.png' }, { id: 'x', kind: 'asset', filename: 'b.png' }]]) {
      assert.equal((await issue(base, images)).status, 400);
    }
  });
});

test('one missing image does not reject the rest of a batch', async () => {
  await fixture(async (base) => {
    const response = await issue(base, [{ id: 'bad', kind: 'project', projectId: 'p', path: 'missing.png' }, { id: 'good', kind: 'asset', filename: 'a.png' }]);
    const { images } = await readBatch(response);
    assert.equal(images[0].status, 404);
    assert.ok(images[1].url);
  });
});

test('tampering, login tokens, expired tickets and deleted users cannot read even with matching ETag', async () => {
  await fixture(async (base, state) => {
    const { images: [image] } = await readBatch(await issue(base));
    const parsed = new URL(base + image.url);
    const ticket = parsed.searchParams.get('ticket')!;
    const [header, payload, signature] = ticket.split('.');
    const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), source: { kind: 'asset', filename: 'secret.png' } })).toString('base64url');
    parsed.searchParams.set('ticket', `${header}.${changed}.${signature}`);
    assert.equal((await fetch(parsed)).status, 403);
    parsed.searchParams.set('ticket', jwt.sign({ userId: 'user-1' }, 'test-only-media-secret'));
    assert.equal((await fetch(parsed)).status, 403);
    state.active = false;
    assert.equal((await fetch(base + image.url, { headers: { 'cache-control': 'max-age=0', 'if-none-match': '"v1"' } })).status, 403);
    state.active = true;
    state.now += 400;
    const expired = await fetch(base + image.url, { headers: { 'cache-control': 'max-age=0', 'if-none-match': '"v1"' } });
    assert.equal(expired.status, 403);
    assert.equal(expired.headers.get('cache-control'), 'no-store');
  });
});

test('each read rechecks permission, and mutable image ETags update after a file changes', async () => {
  await fixture(async (base, state) => {
    const { images: [image] } = await readBatch(await issue(base));
    assert.equal((await fetch(base + image.url, { headers: { 'cache-control': 'max-age=0', 'if-none-match': '"v1"' } })).status, 304);
    state.version = 2;
    const changed = await fetch(base + image.url, { headers: { 'cache-control': 'max-age=0', 'if-none-match': '"v1"' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get('etag'), '"v2"');
    state.readable = false;
    assert.equal((await fetch(base + image.url, { headers: { 'cache-control': 'max-age=0', 'if-none-match': '"v2"' } })).status, 404);
  });
});

test('SVG direct navigation is sandboxed and scripts cannot run in the application origin', async () => {
  await fixture(async (base) => {
    const { images: [image] } = await readBatch(await issue(base, [{ id: 'svg', kind: 'asset', filename: 'a.svg' }]));
    const response = await fetch(base + image.url);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.match(response.headers.get('content-security-policy')!, /sandbox/);
    assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/);
  });
});
