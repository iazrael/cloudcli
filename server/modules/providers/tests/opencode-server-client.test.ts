/**
 * OpenCode shared-server client tests.
 *
 * The client drives a locally spawned `opencode serve` over HTTP and the chat
 * gateway renders whatever message the client throws. These tests pin down that
 * a transport-level failure names the real cause instead of undici's opaque
 * `fetch failed`, which is what left users with no idea what had happened.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  createOpenCodeSession,
  getOpenCodeSessionStatus,
  waitForOpenCodeSessionIdle,
} from '@/modules/providers/list/opencode/opencode-server.client.js';
import type { OpenCodeServerHandle } from '@/modules/providers/list/opencode/opencode-server.client.js';
import {
  OPENCODE_SERVER_RESPONSE_TIMEOUT_MS,
  OPENCODE_SERVER_TRANSPORT_TIMEOUT_MS,
} from '@/modules/providers/list/opencode/opencode-http.client.js';

function handleFor(baseUrl: string): OpenCodeServerHandle {
  return { baseUrl, headers: {} };
}

/** Reserves a loopback port, then closes it so connecting is refused. */
async function reserveClosedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test('a dropped connection is reported with its underlying socket cause', async () => {
  const server = http.createServer((_req, res) => {
    res.socket?.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  let failure: unknown = null;
  try {
    await createOpenCodeSession(handleFor(`http://127.0.0.1:${address.port}`), '/tmp/project', null, undefined);
  } catch (error) {
    failure = error;
  } finally {
    server.close();
  }

  assert.ok(failure instanceof Error);
  assert.notEqual(failure.message, 'fetch failed');
  assert.match(failure.message, /could not reach the local OpenCode server/);
  assert.ok(failure.cause instanceof Error);
});

test('a refused connection is reported as unreachable', async () => {
  const port = await reserveClosedPort();

  let failure: unknown = null;
  try {
    await createOpenCodeSession(handleFor(`http://127.0.0.1:${port}`), '/tmp/project', null, undefined);
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.match(failure.message, /could not reach the local OpenCode server/);
});

test('the client talks over its own transport, not the global fetch', async () => {
  // undici's default five-minute headersTimeout used to kill the blocking
  // prompt request before the client's own deadline could apply. Every call
  // must therefore carry the dedicated agent; breaking that would make this
  // test fail, because the global fetch is replaced with a throwing stub.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'ses_created' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('the opencode client must not use the global fetch');
  }) as typeof fetch;

  try {
    const id = await createOpenCodeSession(
      handleFor(`http://127.0.0.1:${address.port}`),
      '/tmp/project',
      null,
      undefined,
    );
    assert.equal(id, 'ses_created');
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
  }
});

test('transport timeouts outlive every request deadline', () => {
  // The transport caps must stay above the client's own deadline, or undici
  // kills long turns (and drops quiet event streams) before the provider can
  // apply its own recovery.
  assert.ok(OPENCODE_SERVER_TRANSPORT_TIMEOUT_MS > OPENCODE_SERVER_RESPONSE_TIMEOUT_MS);
  assert.ok(OPENCODE_SERVER_RESPONSE_TIMEOUT_MS > 5 * 60_000);
});

test('the status map is read per session and idle-wait blocks until it clears', async () => {
  let statusCalls = 0;
  const server = http.createServer((_req, res) => {
    statusCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ses_test: { type: statusCalls < 2 ? 'busy' : 'idle' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const handle = handleFor(`http://127.0.0.1:${address.port}`);

  try {
    // First read sees the running turn; the wait then polls until it is idle.
    assert.equal(await getOpenCodeSessionStatus(handle, '/tmp/project', 'ses_test'), 'busy');
    await waitForOpenCodeSessionIdle(handle, '/tmp/project', 'ses_test', 30_000);
    assert.ok(statusCalls >= 2);
  } finally {
    server.close();
  }
});

test('idle-wait finishes when a finished session leaves the status map', async () => {
  // The engine omits sessions with no work in flight instead of reporting
  // `idle`, so an untracked session must end the wait. It used to keep the
  // poll spinning until the one-hour deadline, leaving the run "processing"
  // long after the turn had completed.
  let statusCalls = 0;
  const server = http.createServer((_req, res) => {
    statusCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(statusCalls < 2 ? { ses_test: { type: 'busy' } } : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    await waitForOpenCodeSessionIdle(handleFor(`http://127.0.0.1:${address.port}`), '/tmp/project', 'ses_test', 5_000);
    assert.ok(statusCalls >= 2);
  } finally {
    server.close();
  }
});

test('idle-wait rejects when the server disappears mid-turn', async () => {
  const port = await reserveClosedPort();
  await assert.rejects(waitForOpenCodeSessionIdle(handleFor(`http://127.0.0.1:${port}`), '/tmp/project', 'ses_test', 30_000));
});
