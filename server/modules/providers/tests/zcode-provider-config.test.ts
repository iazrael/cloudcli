import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findZCodeBundledProviderConfig,
  findZCodeRuntimeProviderConfig,
  resolveZCodeProviderConfigEnv,
} from '@/modules/providers/list/zcode/zcode-provider-config.js';

/** Runs a case against a temp ZCode storage dir and a temp install tree. */
const withFixture = async (runTest: (roots: {
  storageDir: string;
  enginePath: string;
  bundledDir: string;
}) => Promise<void>): Promise<void> => {
  const previous = process.env.ZCODE_STORAGE_DIR;
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-provider-config-storage-'));
  const installDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-provider-config-install-'));
  process.env.ZCODE_STORAGE_DIR = storageDir;

  const engineDir = path.join(installDir, 'resources', 'glm');
  const bundledDir = path.join(installDir, 'resources', 'config', 'provider');
  await mkdir(engineDir, { recursive: true });
  await mkdir(bundledDir, { recursive: true });
  await writeFile(path.join(bundledDir, 'zcode-builtin.json'), '{"schemaVersion":1}', 'utf8');

  try {
    await runTest({ storageDir, enginePath: path.join(engineDir, 'zcode.cjs'), bundledDir });
  } finally {
    if (previous === undefined) {
      delete process.env.ZCODE_STORAGE_DIR;
    } else {
      process.env.ZCODE_STORAGE_DIR = previous;
    }
    await rm(storageDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  }
};

test('findZCodeBundledProviderConfig resolves the install layout', async () => {
  await withFixture(async ({ enginePath, bundledDir }) => {
    assert.equal(
      findZCodeBundledProviderConfig(enginePath),
      path.join(bundledDir, 'zcode-builtin.json'),
    );
  });
});

test('findZCodeRuntimeProviderConfig returns the newest refreshed catalog', async () => {
  await withFixture(async ({ storageDir }) => {
    const endpointA = path.join(storageDir, 'v2', 'runtime', 'provider', 'windows-x86_64', '3.11.2', 'endpoint-a');
    const endpointB = path.join(storageDir, 'v2', 'runtime', 'provider', 'windows-x86_64', '3.12.3', 'endpoint-b');
    await mkdir(endpointA, { recursive: true });
    await mkdir(endpointB, { recursive: true });
    await writeFile(path.join(endpointA, 'zcode-builtin.json'), '{"v":"a"}', 'utf8');
    await writeFile(path.join(endpointB, 'zcode-builtin.json'), '{"v":"b"}', 'utf8');

    const resolved = findZCodeRuntimeProviderConfig();
    assert.ok(resolved === path.join(endpointA, 'zcode-builtin.json') || resolved === path.join(endpointB, 'zcode-builtin.json'));
    assert.ok(path.isAbsolute(resolved ?? ''));
  });
});

test('resolveZCodeProviderConfigEnv prefers runtime and fills the bundled/personal paths', async () => {
  await withFixture(async ({ storageDir, enginePath, bundledDir }) => {
    const endpoint = path.join(storageDir, 'v2', 'runtime', 'provider', 'windows-x86_64', '3.12.3', 'endpoint-a');
    await mkdir(endpoint, { recursive: true });
    const runtimeCatalog = path.join(endpoint, 'zcode-builtin.json');
    await writeFile(runtimeCatalog, '{"schemaVersion":1}', 'utf8');
    const personal = path.join(storageDir, 'v2', 'provider_config.json');
    await mkdir(path.dirname(personal), { recursive: true });
    await writeFile(personal, '{"schemaVersion":1}', 'utf8');

    const env = resolveZCodeProviderConfigEnv(enginePath);
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, runtimeCatalog);
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE, path.join(bundledDir, 'zcode-builtin.json'));
    assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, personal);
  });
});

test('resolveZCodeProviderConfigEnv falls back to the bundled catalog without a refresh', async () => {
  await withFixture(async ({ enginePath, bundledDir }) => {
    const env = resolveZCodeProviderConfigEnv(enginePath);
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, path.join(bundledDir, 'zcode-builtin.json'));
    assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, undefined);
  });
});
