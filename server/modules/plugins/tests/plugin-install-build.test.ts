import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The registry resolves ~/.cloudcli/plugins when it is imported, so HOME has to
// point at a fixture first.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'plugin-install-home-'));
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { getPluginsDir, installPluginFromGit } = await import(
  '@/modules/plugins/plugin-registry.service.js'
);

process.on('exit', () => {
  fs.rmSync(fixtureHome, { recursive: true, force: true });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

async function writeExecutable(filePath: string, source: string): Promise<void> {
  await writeFile(filePath, source, { mode: 0o755 });
}

/**
 * A plugin repository whose build tool comes from devDependencies and whose
 * native dependency mimics node-pty: npm's tarball has no binary for this
 * platform, only an install script that compiles one. Both are local file
 * dependencies, so the test runs offline.
 */
async function createPluginRepository(seed: string): Promise<void> {
  fs.mkdirSync(path.join(seed, 'build-tool'), { recursive: true });
  await writeJson(path.join(seed, 'build-tool', 'package.json'), {
    name: 'plugin-build-tool',
    version: '1.0.0',
    bin: { 'plugin-build-tool': 'cli.js' },
  });
  await writeExecutable(
    path.join(seed, 'build-tool', 'cli.js'),
    '#!/usr/bin/env node\n'
    + "const { mkdirSync, writeFileSync } = require('node:fs');\n"
    + "mkdirSync('dist', { recursive: true });\n"
    + "writeFileSync('dist/index.js', 'export const built = true;\\n');\n",
  );

  fs.mkdirSync(path.join(seed, 'native-pty'), { recursive: true });
  await writeJson(path.join(seed, 'native-pty', 'package.json'), {
    name: 'node-pty',
    version: '1.1.0',
    scripts: { install: 'node install.js' },
  });
  await writeFile(
    path.join(seed, 'native-pty', 'install.js'),
    "const { mkdirSync, writeFileSync } = require('node:fs');\n"
    + "mkdirSync('build/Release', { recursive: true });\n"
    + "writeFileSync('build/Release/pty.node', '');\n",
  );

  await writeJson(path.join(seed, 'manifest.json'), {
    name: 'devdep-plugin',
    displayName: 'Dev Dependency Plugin',
    entry: 'dist/index.js',
  });
  await writeJson(path.join(seed, 'package.json'), {
    name: 'devdep-plugin',
    version: '1.0.0',
    private: true,
    scripts: { build: 'plugin-build-tool' },
    dependencies: { 'node-pty': 'file:./native-pty' },
    devDependencies: { 'plugin-build-tool': 'file:./build-tool' },
  });

  execFileSync('git', ['init', '-q', seed]);
  execFileSync('git', ['-C', seed, 'add', '.']);
  execFileSync('git', [
    '-C', seed, '-c', 'user.email=plugin@example.test', '-c', 'user.name=Plugin Test',
    'commit', '-q', '-m', 'initial',
  ]);
}

test('a production host install still gets devDependencies and a rebuilt native module', { timeout: 120_000 }, async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-install-repo-'));
  const seed = path.join(projectRoot, 'devdep-plugin');
  const pluginDir = path.join(getPluginsDir(), 'devdep-plugin');
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    await createPluginRepository(seed);

    // PM2 starts the host this way; npm would otherwise omit devDependencies.
    process.env.NODE_ENV = 'production';
    const manifest = await installPluginFromGit(seed) as { name: string };
    assert.equal(manifest.name, 'devdep-plugin');

    assert.ok(
      fs.existsSync(path.join(pluginDir, 'dist', 'index.js')),
      'the build tool from devDependencies must be installed and run',
    );
    assert.ok(
      fs.existsSync(path.join(pluginDir, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')),
      'the missing node-pty binary must be rebuilt from its install script',
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
