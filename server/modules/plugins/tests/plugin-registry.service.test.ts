import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrateLegacyPluginPaths, restoreNativeBinaryExecBits } from '../plugin-registry.service.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-registry-test-'));
}

/** Create a fake node-pty spawn-helper under a plugin root with the given mode. */
function writeHelper(root: string, platform: string, mode: number): string {
  const helper = path.join(root, 'node_modules', 'node-pty', 'prebuilds', platform, 'spawn-helper');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, '#!/bin/sh\n', { mode });
  return helper;
}

test('restoreNativeBinaryExecBits adds the exec bit to spawn-helper binaries only', () => {
  const root = makeTempDir();
  try {
    const arm64 = writeHelper(root, 'darwin-arm64', 0o644);
    const x64 = writeHelper(root, 'darwin-x64', 0o644);
    const bystander = path.join(root, 'node_modules', 'node-pty', 'package.json');
    fs.writeFileSync(bystander, '{}', { mode: 0o644 });

    restoreNativeBinaryExecBits(root);

    assert.notEqual(fs.statSync(arm64).mode & 0o111, 0, 'arm64 spawn-helper should gain the exec bit');
    assert.notEqual(fs.statSync(x64).mode & 0o111, 0, 'x64 spawn-helper should gain the exec bit');
    assert.equal(fs.statSync(bystander).mode & 0o111, 0, 'other files must stay untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restoreNativeBinaryExecBits leaves already-executable helpers alone', () => {
  const root = makeTempDir();
  try {
    const helper = writeHelper(root, 'darwin-arm64', 0o755);
    restoreNativeBinaryExecBits(root);
    assert.notEqual(fs.statSync(helper).mode & 0o111, 0, 'helper should remain executable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restoreNativeBinaryExecBits is a no-op without node-pty prebuilds', () => {
  const root = makeTempDir();
  try {
    restoreNativeBinaryExecBits(root);
    restoreNativeBinaryExecBits(path.join(root, 'missing'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migrateLegacyPluginPaths moves legacy plugin data and cleans the empty root', () => {
  const home = makeTempDir();
  const legacyRoot = path.join(home, 'legacy-root');
  const fromDir = path.join(legacyRoot, 'plugins');
  const fromConfig = path.join(legacyRoot, 'plugins.json');
  fs.mkdirSync(path.join(fromDir, 'web-terminal'), { recursive: true });
  fs.writeFileSync(path.join(fromDir, 'web-terminal', 'manifest.json'), '{"name":"web-terminal"}');
  fs.writeFileSync(fromConfig, '{"web-terminal":{"enabled":true}}');

  migrateLegacyPluginPaths({
    fromDir,
    fromConfig,
    toDir: path.join(home, 'cloudcli', 'plugins'),
    toConfig: path.join(home, 'cloudcli', 'plugins.json'),
    force: true,
  });

  assert.ok(fs.existsSync(path.join(home, 'cloudcli', 'plugins', 'web-terminal', 'manifest.json')), 'plugin directory should move');
  assert.ok(fs.existsSync(path.join(home, 'cloudcli', 'plugins.json')), 'plugins.json should move');
  assert.ok(!fs.existsSync(legacyRoot), 'emptied legacy root should be removed');
});

test('migrateLegacyPluginPaths never overwrites existing data', () => {
  const home = makeTempDir();
  const legacyRoot = path.join(home, 'legacy-root');
  const fromDir = path.join(legacyRoot, 'plugins');
  fs.mkdirSync(fromDir, { recursive: true });
  fs.writeFileSync(path.join(fromDir, 'marker'), 'legacy');
  const toDir = path.join(home, 'cloudcli', 'plugins');
  fs.mkdirSync(toDir, { recursive: true });
  fs.writeFileSync(path.join(toDir, 'marker'), 'current');

  migrateLegacyPluginPaths({
    fromDir,
    fromConfig: path.join(legacyRoot, 'plugins.json'),
    toDir,
    toConfig: path.join(home, 'cloudcli', 'plugins.json'),
    force: true,
  });

  assert.equal(fs.readFileSync(path.join(toDir, 'marker'), 'utf-8'), 'current', 'existing data wins');
  assert.ok(fs.existsSync(path.join(fromDir, 'marker')), 'legacy data stays in place when the target exists');
});
