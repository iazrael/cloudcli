/**
 * Antigravity ACP Session Manager Unit Tests
 *
 * Drives the manager against a stub `agy acp` peer so process residency,
 * resume fallbacks, the busy guard, cancel and idle recycling are verified
 * without the real CLI. HOME is pointed at a temp dir first, so the managed
 * data directory (`~/.gemini/cloudcli-acp/`) writes stay inside the fixture.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AntigravityAcpSessionManager, ensureAcpManagedDataDir, ACP_APP_DATA_DIR_NAME } from '../list/antigravity/antigravity-acp-session-manager.js';

const realHome = os.homedir();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mgr-home-'));
// ensureAcpManagedDataDir resolves the Gemini dir via os.homedir(), which
// honours $HOME on POSIX: point it at the fixture before anything runs.
process.env.HOME = fakeHome;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const STUB_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
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
  log(frame);
  const mode = process.env.AGY_ACP_STUB_MODE;
  if (frame.method === 'initialize') {
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
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: mode === 'load-fails' ? 'fresh-conv' : 'new-conv', modes: { currentModeId: 'default', availableModes: [{ id: 'default' }] }, models: { currentModelId: 'gemini-4-neon-high' } } });
    return;
  }
  if (frame.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
  }
}
process.on('SIGTERM', () => process.exit(0));
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

test('ensureAcpManagedDataDir pins request-review inside the managed dir', async () => {
  await ensureAcpManagedDataDir('/tmp/workspace-a');
  const settingsPath = path.join(fakeHome, '.gemini', ACP_APP_DATA_DIR_NAME, 'settings.json');
  const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8'));
  assert.equal(settings.toolPermission, 'request-review');
  assert.ok(settings.trustedWorkspaces.includes('/tmp/workspace-a'));

  // A second workspace joins without dropping the first; the user's own
  // antigravity-cli settings are never touched.
  await ensureAcpManagedDataDir('/tmp/workspace-b');
  const updated = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8'));
  assert.deepEqual(updated.trustedWorkspaces, ['/tmp/workspace-a', '/tmp/workspace-b']);
  const userSettingsPath = path.join(realHome, '.gemini', 'antigravity-cli', 'settings.json');
  assert.equal(fs.existsSync(userSettingsPath.replace(fakeHome, realHome)), fs.existsSync(userSettingsPath), 'test writes stay in the fixture HOME');
  assert.ok(!JSON.stringify(updated).includes('always-proceed'));
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
    const again = await manager.acquire('app-1', { cwd: stubDir });
    assert.equal(again, handle);
    assert.equal(manager.size, 1);
  } finally {
    manager.destroyAll();
  }
});

test('resume rides session/load and falls back to a fresh conversation on failure', async () => {
  const ok = buildManager('load-ok');
  try {
    const resumed = await ok.acquire('app-resume', { cwd: stubDir, resumeProviderSessionId: 'conv-42' });
    assert.equal(resumed.sessionId, 'conv-42');
    assert.equal(resumed.continuity, 'resumed');
  } finally {
    ok.destroyAll();
  }

  const failed = buildManager('load-fails');
  try {
    const restarted = await failed.acquire('app-restart', { cwd: stubDir, resumeProviderSessionId: 'conv-lost' });
    assert.equal(restarted.sessionId, 'fresh-conv');
    assert.equal(restarted.continuity, 'restarted');
  } finally {
    failed.destroyAll();
  }
});

test('a busy session refuses a second acquire', async () => {
  const manager = buildManager('started');
  try {
    await manager.acquire('app-busy', { cwd: stubDir });
    manager.setBusy('app-busy', true);
    await assert.rejects(
      manager.acquire('app-busy', { cwd: stubDir }),
      /busy with another turn/,
    );
  } finally {
    manager.destroyAll();
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
    manager.destroyAll();
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
    manager.destroyAll();
  }
});

test('idle recycling reclaims quiet sessions and spares busy ones', async () => {
  process.env.CLOUDCLI_ANTIGRAVITY_ACP_IDLE_MINUTES = '0.005'; // ~300ms
  const manager = buildManager('started');
  try {
    await manager.acquire('app-idle', { cwd: stubDir });
    await sleep(700);
    assert.equal(manager.size, 0, 'idle session recycled');

    await manager.acquire('app-busy-idle', { cwd: stubDir });
    manager.setBusy('app-busy-idle', true);
    await sleep(700);
    assert.equal(manager.size, 1, 'busy session survives the idle window');
  } finally {
    delete process.env.CLOUDCLI_ANTIGRAVITY_ACP_IDLE_MINUTES;
    manager.destroyAll();
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
    manager.destroyAll();
  }
});
