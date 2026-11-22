/**
 * Antigravity ACP Session Manager Unit Tests
 *
 * Drives the manager against a stub `agy acp` peer so process residency,
 * resume and its failure path, the busy guard, cancel and idle recycling are verified
 * without the real CLI. HOME is pointed at a temp dir first, so the pinned
 * settings (`~/.gemini/antigravity-cli/settings.json`) stay inside the fixture.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AntigravityAcpSessionManager, ensureAcpPermissionsPinned } from '../list/antigravity/antigravity-acp-session-manager.js';

const realHome = os.homedir();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mgr-home-'));
// ensureAcpPermissionsPinned resolves the Gemini dir via os.homedir(), which
// honours $HOME on POSIX: point it at the fixture before anything runs.
process.env.HOME = fakeHome;
process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR = path.join(fakeHome, '.gemini', 'antigravity-cli');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const STUB_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const logPath = process.env.AGY_ACP_STUB_LOG;
const log = (frame) => fs.appendFileSync(logPath, JSON.stringify(frame) + '\\n');
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
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
  log({ ...frame, pid: process.pid, argv: process.argv.slice(2) });
  const mode = process.env.AGY_ACP_STUB_MODE;
  if (frame.method === 'initialize') {
    if (mode === 'silent-init') {
      setTimeout(() => process.exit(1), 1000);
      return;
    }
    send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } });
    if (mode === 'exit-soon') setTimeout(() => process.exit(1), 100);
    return;
  }
  if (frame.method === 'session/load') {
    if (mode === 'load-fails') {
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'no such conversation' } });
    } else {
      send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: frame.params.sessionId, modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] }, models: { currentModelId: 'gemini-4-neon-high' } } });
    }
    return;
  }
  if (frame.method === 'session/new') {
    const sessionId = mode === 'load-fails' ? 'fresh-conv' : 'new-conv';
    const conversations = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(conversations, { recursive: true });
    fs.writeFileSync(path.join(conversations, sessionId + '.db'), 'stub conversation');
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId, modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] }, models: { currentModelId: 'gemini-4-neon-high' } } });
    return;
  }
  if (frame.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
  }
}
process.on('SIGTERM', () => { if (process.env.AGY_ACP_STUB_MODE !== 'ignore-term') process.exit(0); });
`;

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mgr-stub-'));
const stubPath = path.join(stubDir, 'agy-acp-stub');
const framesLog = path.join(stubDir, 'frames.log');
fs.writeFileSync(stubPath, STUB_SCRIPT, { mode: 0o755 });

/** Builds a manager over the stub with per-test env selection. */
function buildManager(mode: string, onSessionExit: () => void = () => {}) {
  process.env.AGY_ACP_STUB_MODE = mode;
  process.env.AGY_ACP_STUB_LOG = framesLog;
  fs.rmSync(framesLog, { force: true });
  return new AntigravityAcpSessionManager({ onSessionExit }, stubPath);
}

test('ensureAcpPermissionsPinned pins request-review in the native settings and preserves user keys', async () => {
  const settingsPath = path.join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  // The user's own file carries unrelated keys (model labels, status line);
  // the pin is a read-merge-write that must preserve them.
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'Gemini 4 Hydrogen (XHigh)', statusLine: { enabled: true }, toolPermission: 'always-proceed' }));

  await ensureAcpPermissionsPinned('/tmp/workspace-a');
  const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8'));
  assert.equal(settings.toolPermission, 'request-review', 'always-proceed is pinned to request-review');
  assert.equal(settings.model, 'Gemini 4 Hydrogen (XHigh)', 'user keys preserved');
  assert.ok(settings.trustedWorkspaces.includes('/tmp/workspace-a'));

  // A second workspace joins without dropping the first.
  await Promise.all([
    ensureAcpPermissionsPinned('/tmp/workspace-b'),
    ensureAcpPermissionsPinned('/tmp/workspace-c'),
  ]);
  const updated = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8'));
  assert.deepEqual(updated.trustedWorkspaces.sort(), ['/tmp/workspace-a', '/tmp/workspace-b', '/tmp/workspace-c']);
  assert.equal(updated.model, 'Gemini 4 Hydrogen (XHigh)');
});

test('acquire opens a session and reports its facts', async () => {
  const manager = buildManager('started');
  try {
    const handle = await manager.acquire('app-1', { cwd: stubDir });
    assert.equal(handle.sessionId, 'new-conv');
    assert.equal(handle.continuity, 'started');
    assert.equal(handle.currentModelId, 'gemini-4-neon-high');
    assert.equal(manager.size, 1);

    // A second acquire reuses the resident process (same client object).
    manager.release('app-1', handle);
    const again = await manager.acquire('app-1', { cwd: stubDir });
    assert.equal(again, handle);
    assert.equal(manager.size, 1);
  } finally {
    await manager.destroyAll();
  }
});

test('resume rides session/load and a failure preserves the original mapping', async () => {
  const nativeConversations = path.join(fakeHome, '.gemini', 'antigravity-cli', 'conversations');
  fs.mkdirSync(nativeConversations, { recursive: true });
  for (const id of ['conv-42', 'conv-lost']) {
    fs.writeFileSync(path.join(nativeConversations, id + '.db'), 'stub conversation');
  }
  const ok = buildManager('load-ok');
  try {
    const resumed = await ok.acquire('app-resume', { cwd: stubDir, resumeProviderSessionId: 'conv-42' });
    assert.equal(resumed.sessionId, 'conv-42');
    assert.equal(resumed.continuity, 'resumed');
  } finally {
    await ok.destroyAll();
  }

  const failed = buildManager('load-fails');
  try {
    await assert.rejects(failed.acquire('app-restart', { cwd: stubDir, resumeProviderSessionId: 'conv-lost' }), /no such conversation/);
  } finally {
    await failed.destroyAll();
  }
});

test('a busy session refuses a second acquire', async () => {
  const manager = buildManager('started');
  try {
    await manager.acquire('app-busy', { cwd: stubDir });
    await assert.rejects(
      manager.acquire('app-busy', { cwd: stubDir }),
      /busy with another turn/,
    );
  } finally {
    await manager.destroyAll();
  }
});

test('cancelTurn delivers the session/cancel notification', async () => {
  const manager = buildManager('started');
  try {
    await manager.acquire('app-cancel', { cwd: stubDir });
    assert.equal(manager.cancelTurn('app-cancel'), true);
    await sleep(150);
    const frames = (await fs.promises.readFile(framesLog, 'utf8').catch(() => ''))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(frames.some((frame) => frame.method === 'session/cancel'), 'cancel reached the engine');
    assert.equal(manager.cancelTurn('app-missing'), false);
  } finally {
    await manager.destroyAll();
  }
});

test('an engine exit evicts the session and fires the callback', async () => {
  let exitSeen: string | null = null;
  const manager = buildManager('exit-soon', () => { exitSeen = 'app-exit'; });
  try {
    const handle = await manager.acquire('app-exit', { cwd: stubDir });
    await handle.client.whenExit();
    await sleep(100);
    assert.equal(manager.size, 0, 'dead session is evicted');
    assert.equal(exitSeen, 'app-exit');
  } finally {
    await manager.destroyAll();
  }
});

test('idle recycling reclaims quiet sessions and spares busy ones', async () => {
  process.env.CLOUDCLI_ANTIGRAVITY_ACP_IDLE_MINUTES = '0.005'; // ~300ms
  const manager = buildManager('started');
  try {
    const idle = await manager.acquire('app-idle', { cwd: stubDir });
    manager.release('app-idle', idle);
    await sleep(700);
    assert.equal(manager.size, 0, 'idle session recycled');

    await manager.acquire('app-busy-idle', { cwd: stubDir });
    await sleep(700);
    assert.equal(manager.size, 1, 'busy session survives the idle window');
  } finally {
    delete process.env.CLOUDCLI_ANTIGRAVITY_ACP_IDLE_MINUTES;
    await manager.destroyAll();
  }
});

test('acquiring a dead resident session respawns instead of returning a corpse', async () => {
  process.env.AGY_ACP_STUB_MODE = 'started';
  const manager = new AntigravityAcpSessionManager({ onSessionExit: () => {} }, stubPath);
  try {
    const first = await manager.acquire('app-corpse', { cwd: stubDir });
    first.client.close();
    await first.client.whenExit();
    await sleep(100);
    const second = await manager.acquire('app-corpse', { cwd: stubDir });
    assert.notEqual(second.client, first.client, 'a fresh process serves the next turn');
  } finally {
    await manager.destroyAll();
  }
});

test('permission changes replace the process in both directions and resume the conversation', async () => {
  const manager = buildManager('load-ok');
  try {
    const normal = await manager.acquire('app-mode', { cwd: stubDir });
    manager.release('app-mode', normal);
    const bypass = await manager.acquire('app-mode', { cwd: stubDir, skipPermissions: true });
    manager.release('app-mode', bypass);
    const restored = await manager.acquire('app-mode', { cwd: stubDir, skipPermissions: false });

    assert.notEqual(normal.client, bypass.client);
    assert.notEqual(bypass.client, restored.client);
    assert.equal(restored.sessionId, normal.sessionId);
    const frames = fs.readFileSync(framesLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const initializations = frames.filter((frame) => frame.method === 'initialize');
    assert.deepEqual(initializations.map((frame) => frame.argv.includes('--dangerously-skip-permissions')), [false, true, false]);
    assert.equal(new Set(initializations.map((frame) => frame.pid)).size, 3);
    assert.equal(frames.filter((frame) => frame.method === 'session/load').length, 2);
  } finally {
    await manager.destroyAll();
  }
});

test('a permission change never opens a fresh conversation if restoring fails', async () => {
  const manager = buildManager('load-fails');
  try {
    const bypass = await manager.acquire('app-failed-load', { cwd: stubDir, skipPermissions: true });
    manager.release('app-failed-load', bypass);
    await assert.rejects(manager.acquire('app-failed-load', { cwd: stubDir }), /no such conversation/);
    const frames = fs.readFileSync(framesLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(frames.filter((frame) => frame.method === 'session/new').length, 1);
  } finally {
    await manager.destroyAll();
  }
});

test('a starting process can be cancelled and a second acquire is rejected', async () => {
  const manager = buildManager('silent-init');
  try {
    const opening = manager.acquire('app-opening', { cwd: stubDir });
    const observed = assert.rejects(opening, /closed|exited|cancel/i);
    await assert.rejects(manager.acquire('app-opening', { cwd: stubDir }), /busy with another turn/);
    for (let i = 0; i < 50 && !fs.existsSync(framesLog); i += 1) await sleep(10);
    assert.ok(fs.existsSync(framesLog), 'initialize reached the engine');
    assert.equal(manager.cancelTurn('app-opening'), true);
    await observed;
  } finally {
    await manager.destroyAll();
  }
});

test('shutdown waits for the engine to exit even when SIGTERM is ignored', async () => {
  const manager = buildManager('ignore-term');
  const handle = await manager.acquire('app-shutdown', { cwd: stubDir });
  let exit: Awaited<ReturnType<typeof handle.client.whenExit>> | undefined;
  void handle.client.whenExit().then((value) => { exit = value; });
  await manager.destroyAll();
  assert.equal(exit?.signal, 'SIGKILL');
  assert.equal(manager.size, 0);
});

test('a missing conversation fails even if the engine would accept its ID', async () => {
  const manager = buildManager('load-ok');
  try {
    await assert.rejects(
      manager.acquire('app-missing-native', { cwd: stubDir, resumeProviderSessionId: 'absent-native-id' }),
      /conversation absent-native-id was not found/i,
    );
    assert.equal(fs.existsSync(framesLog), false, 'the unverified ID was not sent to agy');
  } finally {
    await manager.destroyAll();
  }
});

test('print-root conversations resume over ACP now that the store is shared', async () => {
  const manager = buildManager('load-ok');
  const conversations = path.join(fakeHome, '.gemini', 'antigravity-cli', 'conversations');
  fs.mkdirSync(conversations, { recursive: true });
  fs.writeFileSync(path.join(conversations, 'print-only.db'), 'stub conversation');
  try {
    const handle = await manager.acquire('app-print-only', { cwd: stubDir, resumeProviderSessionId: 'print-only' });
    assert.equal(handle.sessionId, 'print-only');
    assert.equal(handle.continuity, 'resumed');
  } finally {
    await manager.destroyAll();
  }
});
