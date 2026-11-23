import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { codexAppServer, openCodexAppServer } from '../list/codex/codex-app-server.client.js';

test('an RPC timeout retains a late-result owner without closing the shared process', async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = new EventEmitter() as any;
  let closed = false;
  let delayedId: number | undefined;
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill() { closed = true; child.emit('exit', 0, 'SIGTERM'); } });
  stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString());
    if (!request.id) return;
    if (request.method === 'turn/start') delayedId = request.id;
    else stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
  });
  const mocked = t.mock.method(childProcess, 'spawn', (() => child) as any);
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  const connection = await openCodexAppServer();
  const late: unknown[] = [];
  try {
    await assert.rejects(connection.call('turn/start', {}, { timeoutMs: 10, onLateResult: (result) => { late.push(result); } }), { code: 'CODEX_APP_SERVER_TIMEOUT' });
    assert.equal(closed, false);
    stdout.write(`${JSON.stringify({ id: delayedId, result: { turn: { id: 'late-turn' } } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(late, [{ turn: { id: 'late-turn' } }]);
    await connection.call('model/list', {});
  } finally { connection.close(); }
});

test('a native Codex launcher is spawned directly instead of through node', async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = new EventEmitter() as any;
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill() { child.emit('exit', 0, 'SIGTERM'); } });
  stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString());
    if (request.id) stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
  });
  const mocked = t.mock.method(childProcess, 'spawn', (() => child) as any);
  syncBuiltinESMExports();
  const original = codexAppServer.resolveLauncher;
  codexAppServer.resolveLauncher = () => '/opt/codex/bin/codex';
  t.after(() => {
    codexAppServer.resolveLauncher = original;
    mocked.mock.restore();
    syncBuiltinESMExports();
  });

  const connection = await openCodexAppServer();
  connection.close();

  assert.equal(mocked.mock.calls[0].arguments[0], '/opt/codex/bin/codex');
  assert.deepEqual(mocked.mock.calls[0].arguments[1], ['app-server']);
});
