/**
 * Antigravity ACP Client Unit Tests
 *
 * Drives the client against a stub `agy acp` peer (a Node script that speaks
 * newline-delimited JSON-RPC on stdio, selected by scenario via env), so
 * framing, request/response bookkeeping, server->client dispatch, cancel and
 * exit handling are verified without the real CLI. Every frame the stub
 * receives is appended to a log file the tests assert against.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AntigravityAcpClient,
  AcpConnectionClosedError,
} from '../list/antigravity/antigravity-acp-client.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Creates the stub executable and starts a client pointed at it. */
function startStubClient(mode: string, handlerOverrides?: (client: AntigravityAcpClient) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-stub-'));
  const stubPath = path.join(dir, 'agy-acp-stub.cjs');
  const logPath = path.join(dir, 'frames.log');
  fs.writeFileSync(stubPath, STUB_SCRIPT);
  const client = new AntigravityAcpClient({
    enginePath: process.execPath,
    args: [stubPath],
    cwd: dir,
    env: { AGY_ACP_STUB_MODE: mode, AGY_ACP_STUB_LOG: logPath },
  });
  handlerOverrides?.(client);
  return { client, logPath, dir };
}

async function readFrames(logPath: string) {
  const text = await fs.promises.readFile(logPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const STUB_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const logPath = process.env.AGY_ACP_STUB_LOG;
const log = (frame) => fs.appendFileSync(logPath, JSON.stringify(frame) + '\\n');
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
let promptId = null;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(frame) {
  log(frame);
  const mode = process.env.AGY_ACP_STUB_MODE;
  if (frame.method === 'initialize') {
    if (mode === 'bad-frame') send(null);
    if (mode === 'silent') return;
    send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    if (mode === 'server-request') {
      send({ jsonrpc: '2.0', id: 9001, method: 'session/request_permission', params: { options: [{ optionId: 'allow' }] } });
      send({ jsonrpc: '2.0', id: 9002, method: 'session/some_future_extension', params: {} });
    } else if (mode === 'exit-mid-request') {
      setTimeout(() => process.exit(1), 500);
    } else if (mode === 'notification') {
      // Emitted after the handshake so the test is guaranteed to have
      // subscribed before the notification flies.
      send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } });
    }
    return;
  }
  if (frame.method === 'session/new') {
    if (mode === 'exit-mid-request') {
      // The engine dies without answering: the client must fail the pending
      // request through its exit path, not resolve it.
      return;
    }
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'stub-session-1' } });
    return;
  }
  if (frame.method === 'session/prompt') {
    if (mode === 'cancel') {
      promptId = frame.id;
      return;
    }
    send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (frame.method === 'session/cancel' && promptId !== null) {
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
    promptId = null;
  }
}
if (process.env.AGY_ACP_STUB_MODE === 'garbage') {
  process.stdout.write('this line is not json\\n');
}
process.on('SIGTERM', () => process.exit(0));
`;

test('acp client performs the handshake and resolves request results', async () => {
  const { client, logPath, dir } = startStubClient('handshake');
  try {
    const result = (await client.request('initialize', { protocolVersion: 1 })) as Record<string, unknown>;
    assert.equal(result.protocolVersion, 1);

    const session = (await client.request('session/new', { cwd: dir })) as Record<string, unknown>;
    assert.equal(session.sessionId, 'stub-session-1');

    const frames = await readFrames(logPath);
    const initFrame = frames.find((frame) => frame.method === 'initialize');
    assert.equal(initFrame?.id, 1, 'first request uses id 1');
  } finally {
    client.close();
  }
});

test('acp client surfaces engine notifications to subscribers', async () => {
  const { client } = startStubClient('notification');
  try {
    // Subscribe before the handshake: the stub emits its notification right
    // after answering initialize, so the subscriber must already be in place.
    const received = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('notification never arrived')), 5000);
      client.onNotification((notification) => {
        clearTimeout(timer);
        resolve(notification as unknown as Record<string, unknown>);
      });
      void client.request('initialize', {}).catch(reject);
    });
    assert.equal(received.method, 'session/update');
  } finally {
    client.close();
  }
});

test('acp client dispatches server requests to handlers and answers unknown methods with an empty result', async () => {
  const { client, logPath } = startStubClient('server-request', (c) => {
    c.handleServerRequest('session/request_permission', (request) => {
      const params = request.params as { options: Array<{ optionId: string }> };
      return { outcome: { outcome: 'selected_once', optionId: params.options[0].optionId } };
    });
  });
  try {
    await client.request('initialize', {});
    await sleep(300);
    const frames = await readFrames(logPath);
    const permissionReply = frames.find((frame) => frame.id === 9001 && frame.result !== undefined) as Record<string, unknown> | undefined;
    assert.deepEqual(permissionReply?.result, { outcome: { outcome: 'selected_once', optionId: 'allow' } });

    const unknownReply = frames.find((frame) => frame.id === 9002 && frame.result !== undefined) as Record<string, unknown> | undefined;
    assert.deepEqual(unknownReply?.result, {}, 'unhandled server requests get an empty result');
  } finally {
    client.close();
  }
});

test('acp client turns handler throws into JSON-RPC error replies', async () => {
  const { client, logPath } = startStubClient('server-request', (c) => {
    c.handleServerRequest('session/request_permission', () => {
      throw new Error('permission gateway is closed');
    });
  });
  try {
    await client.request('initialize', {});
    await sleep(300);
    const frames = await readFrames(logPath);
    const errorReply = frames.find((frame) => frame.id === 9001 && frame.error !== undefined) as Record<string, unknown> | undefined;
    assert.equal((errorReply?.error as Record<string, unknown>)?.code, -32603);
    assert.match(String((errorReply?.error as Record<string, unknown>)?.message), /permission gateway is closed/);
  } finally {
    client.close();
  }
});

test('acp client tolerates non-JSON stdout lines', async () => {
  const diagnostics: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-stub-'));
  const stubPath = path.join(dir, 'stub.cjs');
  fs.writeFileSync(stubPath, STUB_SCRIPT);
  const client = new AntigravityAcpClient({
    enginePath: process.execPath,
    args: [stubPath],
    cwd: dir,
    env: { AGY_ACP_STUB_MODE: 'garbage', AGY_ACP_STUB_LOG: path.join(dir, 'frames.log') },
    onDiagnostic: (line) => diagnostics.push(line),
  });
  try {
    const result = (await client.request('initialize', {})) as Record<string, unknown>;
    assert.equal(result.protocolVersion, 1);
    assert.ok(diagnostics.some((line) => line.includes('unparseable stdout line')), 'garbage line is surfaced as a diagnostic');
  } finally {
    client.close();
  }
});

test('engine exit rejects in-flight requests with AcpConnectionClosedError', async () => {
  const { client } = startStubClient('exit-mid-request');
  try {
    await client.request('initialize', {});
    const pending = client.request('session/new', {});
    await assert.rejects(pending, AcpConnectionClosedError);
    const exit = await client.whenExit();
    assert.equal(exit.code, 1);
  } finally {
    client.close();
  }
});

test('close() kills the engine and later requests fail fast', async () => {
  const { client } = startStubClient('handshake');
  client.close();
  await client.whenExit();
  await assert.rejects(client.request('session/new', {}), AcpConnectionClosedError);
});

test('session/cancel resolves an in-flight prompt with stopReason cancelled', async () => {
  const { client } = startStubClient('cancel');
  try {
    await client.request('initialize', {});
    const prompt = client.request('session/prompt', { sessionId: 'stub-session-1', prompt: [] });
    await sleep(100);
    client.notify('session/cancel', { sessionId: 'stub-session-1' });
    const result = (await prompt) as Record<string, unknown>;
    assert.equal(result.stopReason, 'cancelled');
  } finally {
    client.close();
  }
});

test('spawning a missing engine rejects requests and resolves whenExit', async () => {
  const client = new AntigravityAcpClient({
    enginePath: path.join(os.tmpdir(), 'definitely-missing-agy-binary'),
    args: ['acp'],
    cwd: os.tmpdir(),
  });
  await assert.rejects(client.request('initialize', {}), AcpConnectionClosedError);
  const exit = await client.whenExit();
  assert.equal(exit.code, null);
});

test('a valid JSON value that is not an ACP frame does not crash the client', async () => {
  const { client } = startStubClient('bad-frame');
  try {
    assert.deepEqual(await client.request('initialize', {}, 1000), {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
  } finally {
    client.close();
  }
});

test('a silent control request times out and closes its connection', async () => {
  const { client } = startStubClient('silent');
  try {
    await assert.rejects(client.request('initialize', {}, 100), /initialize.*timed out/);
    await client.whenExit();
    assert.equal(client.isClosed(), true);
  } finally {
    client.close();
  }
});
