import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isCodexCliOverrideActive,
  isCodexScriptLauncher,
  resolveCodexCliLaunchSpec,
} from '../list/codex/codex-cli-path.js';

// CODEX_CLI_PATH lets an operator run the Codex CLI installed on the server
// instead of the @openai/codex build pinned in package.json. These tests drive
// the resolution with real fake CLIs in a temp dir: the guard probes
// `--version` for real, so a stub would not prove what the code does.

const bundledVersion = (createRequire(import.meta.url)('@openai/codex/package.json') as { version: string }).version;

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-cli-path-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A JS launcher, the shape npm installs: run by node, reports `--version` itself. */
async function writeJsCli(dir: string, version: string): Promise<string> {
  const scriptPath = path.join(dir, 'codex.js');
  await writeFile(
    scriptPath,
    `if (process.argv.includes('--version')) { console.log('codex-cli ${version}'); process.exit(0); }\nprocess.exit(2);\n`,
    'utf8',
  );
  return scriptPath;
}

/** A native executable, the shape a standalone install has: run directly by spawn. */
async function writeNativeCli(dir: string, version: string, exitCode = 0): Promise<string> {
  const scriptPath = path.join(dir, 'codex');
  await writeFile(scriptPath, `#!/bin/sh\necho "codex-cli ${version}"\nexit ${exitCode}\n`, 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

test('without CODEX_CLI_PATH the bundled @openai/codex launcher is used', () => {
  const spec = resolveCodexCliLaunchSpec({});
  assert.ok(spec, 'the dependency is installed in this repository');
  assert.equal(spec.source, 'bundled');
  assert.equal(spec.command, process.execPath);
  assert.equal(spec.version, bundledVersion);
  assert.ok(spec.prefixArgs[0].endsWith(path.join('@openai', 'codex', 'bin', 'codex.js')));
  assert.equal(isCodexCliOverrideActive({}), false);
});

test('a JS launcher override runs under node and reports its own version', async () => {
  await withTempDir(async (dir) => {
    const scriptPath = await writeJsCli(dir, '99.1.0');
    const env = { CODEX_CLI_PATH: ` "${scriptPath}" ` };
    const spec = resolveCodexCliLaunchSpec(env);
    assert.deepEqual(spec, {
      command: process.execPath,
      prefixArgs: [scriptPath],
      source: 'override',
      version: '99.1.0',
    });
    assert.equal(isCodexCliOverrideActive(env), true);
  });
});

test('a native override is started directly', { skip: process.platform === 'win32' }, async () => {
  await withTempDir(async (dir) => {
    const binaryPath = await writeNativeCli(dir, '99.2.0');
    const spec = resolveCodexCliLaunchSpec({ CODEX_CLI_PATH: binaryPath });
    assert.equal(spec?.source, 'override');
    assert.equal(spec?.command, binaryPath);
    assert.deepEqual(spec?.prefixArgs, []);
    assert.equal(spec?.version, '99.2.0');
    assert.equal(isCodexScriptLauncher(binaryPath), false);
    assert.equal(isCodexScriptLauncher('/somewhere/codex.js'), true);
    assert.equal(isCodexScriptLauncher('/somewhere/codex.mjs'), true);
    assert.equal(isCodexScriptLauncher('/somewhere/codex.cjs'), true);
  });
});

test('an override older than the pinned build falls back to the bundled CLI', async () => {
  await withTempDir(async (dir) => {
    const binaryPath = await writeNativeCli(dir, '0.0.1');
    const env = { CODEX_CLI_PATH: binaryPath };
    const spec = resolveCodexCliLaunchSpec(env);
    assert.equal(spec?.source, 'bundled');
    assert.equal(spec?.version, bundledVersion);
    // The UI must say "ships with CloudCLI", not claim an external CLI is in use.
    assert.equal(isCodexCliOverrideActive(env), false);
  });
});

test('an override that cannot run falls back to the bundled CLI', async () => {
  await withTempDir(async (dir) => {
    const missing = resolveCodexCliLaunchSpec({ CODEX_CLI_PATH: path.join(dir, 'not-installed') });
    assert.equal(missing?.source, 'bundled');

    const failing = await writeNativeCli(dir, '99.3.0', 3);
    const spec = resolveCodexCliLaunchSpec({ CODEX_CLI_PATH: failing });
    assert.equal(spec?.source, 'bundled');
  });
});

test('the same CODEX_CLI_PATH is probed once per process', async () => {
  await withTempDir(async (dir) => {
    const binaryPath = path.join(dir, 'codex');
    const probeLog = path.join(dir, 'probe.log');
    await writeFile(
      binaryPath,
      `#!/bin/sh\necho probe >> "${probeLog}"\necho "codex-cli 99.4.0"\n`,
      'utf8',
    );
    await chmod(binaryPath, 0o755);

    const env = { CODEX_CLI_PATH: binaryPath };
    assert.equal(resolveCodexCliLaunchSpec(env)?.source, 'override');
    assert.equal(resolveCodexCliLaunchSpec(env)?.source, 'override');
    assert.equal((await readFile(probeLog, 'utf8')).trim().split('\n').length, 1);
  });
});
