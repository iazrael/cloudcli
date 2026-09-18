import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveZCodeProviderConfigEnv } from '@/modules/providers/list/zcode/zcode-provider-config.js';

const BUILTIN_ENV = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE';
const PERSONAL_ENV = 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE';

/**
 * Builds a temp tree shaped like a ZCode install: the engine bundle plus a
 * built-in config placed at `relativeConfig` (omitted when null).
 */
const withEngineLayout = async (
  relativeConfig: string | null,
  runTest: (enginePath: string, configPath: string | null) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zcode-provider-config-'));
  const engineDir = path.join(root, 'Contents', 'Resources', 'glm');
  await mkdir(engineDir, { recursive: true });
  const enginePath = path.join(engineDir, 'zcode.cjs');
  await writeFile(enginePath, '// engine', 'utf8');

  let configPath: string | null = null;
  if (relativeConfig) {
    configPath = path.resolve(engineDir, relativeConfig);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{}', 'utf8');
  }

  await runTest(enginePath, configPath);
};

test('finds the built-in config in the packaged Resources/config layout', async () => {
  await withEngineLayout(path.join('..', 'config', 'provider', 'zcode-builtin.json'), async (enginePath, configPath) => {
    const env = resolveZCodeProviderConfigEnv(enginePath, { ZCODE_STORAGE_DIR: '/tmp/storage' });

    assert.equal(env[BUILTIN_ENV], configPath);
  });
});

test('prefers the config co-located with the engine over the packaged sibling', async () => {
  await withEngineLayout(path.join('provider', 'zcode-builtin.json'), async (enginePath, configPath) => {
    const env = resolveZCodeProviderConfigEnv(enginePath, {});

    assert.equal(env[BUILTIN_ENV], configPath);
  });
});

test('points the personal config at the ZCode storage directory', async () => {
  await withEngineLayout(path.join('..', 'config', 'provider', 'zcode-builtin.json'), async (enginePath) => {
    const previousStorage = process.env.ZCODE_STORAGE_DIR;
    process.env.ZCODE_STORAGE_DIR = path.join(os.tmpdir(), 'zcode-storage-fixture');
    try {
      const env = resolveZCodeProviderConfigEnv(enginePath, {});

      assert.equal(env[PERSONAL_ENV], path.join(process.env.ZCODE_STORAGE_DIR, 'v2', 'provider_config.json'));
    } finally {
      if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorage;
    }
  });
});

test('returns no overrides when the caller already set both variables', async () => {
  await withEngineLayout(path.join('..', 'config', 'provider', 'zcode-builtin.json'), async (enginePath) => {
    const env = resolveZCodeProviderConfigEnv(enginePath, {
      [BUILTIN_ENV]: '/custom/builtin.json',
      [PERSONAL_ENV]: '/custom/personal.json',
    });

    assert.deepEqual(env, {});
  });
});

test('returns no overrides when no built-in config exists, leaving the engine its own error', async () => {
  await withEngineLayout(null, async (enginePath) => {
    const env = resolveZCodeProviderConfigEnv(enginePath, {});

    assert.deepEqual(env, {});
  });
});
