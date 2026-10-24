import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildZCodeAccountSyncPayload,
  resolveZCodeBuiltinRevision,
  resolveZCodeProviderConfigEnv,
} from '@/modules/providers/list/zcode/zcode-provider-config.js';

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
    const env = resolveZCodeProviderConfigEnv(enginePath);

    assert.equal(env[BUILTIN_ENV], configPath);
  });
});

test('prefers the config co-located with the engine over the packaged sibling', async () => {
  await withEngineLayout(path.join('provider', 'zcode-builtin.json'), async (enginePath, configPath) => {
    const env = resolveZCodeProviderConfigEnv(enginePath);

    assert.equal(env[BUILTIN_ENV], configPath);
  });
});

test('points the personal config at the ZCode storage directory', async () => {
  await withEngineLayout(path.join('..', 'config', 'provider', 'zcode-builtin.json'), async (enginePath) => {
    const previousStorage = process.env.ZCODE_STORAGE_DIR;
    process.env.ZCODE_STORAGE_DIR = path.join(os.tmpdir(), 'zcode-storage-fixture');
    try {
      const env = resolveZCodeProviderConfigEnv(enginePath);

      assert.equal(env[PERSONAL_ENV], path.join(process.env.ZCODE_STORAGE_DIR, 'v2', 'provider_config.json'));
    } finally {
      if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorage;
    }
  });
});

test('materializes the 0.16.9 provider registry from cli/config.json without changing the source config', async () => {
  await withEngineLayout(path.join('..', 'config', 'provider', 'zcode-builtin.json'), async (enginePath) => {
    const previousStorage = process.env.ZCODE_STORAGE_DIR;
    const storageDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-provider-registry-'));
    process.env.ZCODE_STORAGE_DIR = storageDir;
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    const sourcePath = path.join(cliDir, 'config.json');
    const source = JSON.stringify({
      provider: {
        'bigmodel-coding-plan': {
          kind: 'anthropic',
          name: 'BigModel Coding Plan',
          options: { apiKey: 'fixture-key', baseURL: 'https://example.invalid/api/anthropic' },
          models: {
            'GLM-5.3-Flash': {
              reasoning: { enabled: true, levels: ['low', 'max'], defaultLevel: 'max' },
            },
          },
        },
        'builtin:bigmodel-coding-plan': {
          kind: 'anthropic',
          name: 'Reserved migration alias',
          options: { apiKey: 'fixture-key', baseURL: 'https://example.invalid/api/anthropic' },
          models: {
            'GLM-5.3-Flash': {
              reasoning: { enabled: true, levels: ['low', 'max'], defaultLevel: 'max' },
            },
          },
        },
      },
      model: 'builtin:bigmodel-coding-plan/GLM-5.3-Flash',
    });
    await writeFile(sourcePath, source, 'utf8');

    try {
      const env = resolveZCodeProviderConfigEnv(enginePath);
      const generatedPath = env[PERSONAL_ENV];
      assert.ok(generatedPath);
      const generated = JSON.parse(await readFile(generatedPath, 'utf8')) as any;
      assert.equal(generated.schemaVersion, 1);
      assert.equal(generated.config.providerConfigRules.providerRules.length, 1);
      assert.equal(generated.config.providerConfigRules.providerRules[0].providerId, 'bigmodel-coding-plan');
      assert.equal(generated.config.providerConfigRules.providerRules[0].config.access.apiKey, 'fixture-key');
      assert.deepEqual(generated.config.defaultModelSelection, {
        providerId: 'bigmodel-coding-plan',
        modelId: 'GLM-5.3-Flash',
        options: { reasoningLevel: 'max' },
      });
      assert.equal((await stat(generatedPath)).mode & 0o077, 0);
      assert.equal(await readFile(sourcePath, 'utf8'), source);
    } finally {
      if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorage;
    }
  });
});

test('ignores ambient ZCode_* variables inherited from a parent ZCode session', async () => {
  await withEngineLayout(path.join('..', 'config', 'provider', 'zcode-builtin.json'), async (enginePath, configPath) => {
    const previousBuiltin = process.env[BUILTIN_ENV];
    const previousPersonal = process.env[PERSONAL_ENV];
    process.env[BUILTIN_ENV] = '/parent-session/builtin.json';
    process.env[PERSONAL_ENV] = '/parent-session/personal.json';
    try {
      const env = resolveZCodeProviderConfigEnv(enginePath);

      assert.equal(env[BUILTIN_ENV], configPath);
      assert.ok(env[PERSONAL_ENV]);
      assert.notEqual(env[PERSONAL_ENV], '/parent-session/personal.json');
    } finally {
      if (previousBuiltin === undefined) delete process.env[BUILTIN_ENV];
      else process.env[BUILTIN_ENV] = previousBuiltin;
      if (previousPersonal === undefined) delete process.env[PERSONAL_ENV];
      else process.env[PERSONAL_ENV] = previousPersonal;
    }
  });
});

test('returns no overrides when no built-in config exists, leaving the engine its own error', async () => {
  await withEngineLayout(null, async (enginePath) => {
    const env = resolveZCodeProviderConfigEnv(enginePath);

    assert.deepEqual(env, {});
  });
});

test('resolveZCodeBuiltinRevision computes the exact sha256-tagged revision format', async () => {
  await withEngineLayout(path.join('provider', 'zcode-builtin.json'), async (_enginePath, configPath) => {
    assert.ok(configPath);
    await writeFile(configPath, JSON.stringify({ revision: 30 }), 'utf8');

    const result = resolveZCodeBuiltinRevision(configPath);
    const expectedHash = (await import('node:crypto')).createHash('sha256').update(path.resolve(configPath)).digest('hex');
    assert.equal(result, `zcode-builtin:30:${expectedHash}`);
  });
});

test('resolveZCodeBuiltinRevision returns null for missing or invalid config', async () => {
  assert.equal(resolveZCodeBuiltinRevision('/non/existent/path.json'), null);

  const tmpInvalid = path.join(os.tmpdir(), `zcode-invalid-${Date.now()}.json`);
  await writeFile(tmpInvalid, JSON.stringify({ noRevision: true }), 'utf8');
  try {
    assert.equal(resolveZCodeBuiltinRevision(tmpInvalid), null);
  } finally {
    const { unlink } = await import('node:fs/promises');
    await unlink(tmpInvalid).catch(() => {});
  }
});

test('buildZCodeAccountSyncPayload entitles only the individual plan and ignores the trial JWT', async () => {
  await withEngineLayout(path.join('provider', 'zcode-builtin.json'), async (_enginePath, configPath) => {
    assert.ok(configPath);
    await writeFile(configPath, JSON.stringify({ revision: 30 }), 'utf8');

    const previousStorage = process.env.ZCODE_STORAGE_DIR;
    const storageDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-payload-storage-'));
    process.env.ZCODE_STORAGE_DIR = storageDir;
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(v2Dir, { recursive: true });
    // Both credentials present: the trial JWT must not resurrect the removed
    // start-plan account, only the individual plan is entitled.
    await writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({
      zcodejwttoken: 'test-jwt-token',
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'individual-key',
    }), 'utf8');

    try {
      const payload = buildZCodeAccountSyncPayload(configPath);
      assert.ok(payload);
      assert.equal(payload.revision, '1');
      assert.ok((payload.basedOnZCodeBuiltinRevision as string).startsWith('zcode-builtin:30:'));
      assert.deepEqual(payload.providers, {
        'account:bigmodel-individual-coding-plan': {
          access: {
            type: 'zhipu-account',
            entitled: true,
          },
        },
      });
      assert.deepEqual(payload.states, {
        'account:bigmodel-individual-coding-plan': {
          availability: 'available',
          entitled: true,
          current: true,
        },
      });
    } finally {
      if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorage;
    }
  });
});

test('buildZCodeAccountSyncPayload returns null when only the trial JWT exists', async () => {
  await withEngineLayout(path.join('provider', 'zcode-builtin.json'), async (_enginePath, configPath) => {
    assert.ok(configPath);
    await writeFile(configPath, JSON.stringify({ revision: 30 }), 'utf8');

    const previousStorage = process.env.ZCODE_STORAGE_DIR;
    const storageDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-payload-storage-'));
    process.env.ZCODE_STORAGE_DIR = storageDir;
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(v2Dir, { recursive: true });
    await writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({ zcodejwttoken: 'test-jwt-token' }), 'utf8');

    try {
      const payload = buildZCodeAccountSyncPayload(configPath);
      assert.equal(payload, null);
    } finally {
      if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorage;
    }
  });
});

test('account sync activates the native individual provider when its plan key is available', async () => {
  await withEngineLayout(path.join('provider', 'zcode-builtin.json'), async (_enginePath, configPath) => {
    assert.ok(configPath);
    await writeFile(configPath, JSON.stringify({ revision: 30 }), 'utf8');
    const previousStorage = process.env.ZCODE_STORAGE_DIR;
    const storageDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-individual-sync-'));
    process.env.ZCODE_STORAGE_DIR = storageDir;
    await mkdir(path.join(storageDir, 'v2'), { recursive: true });
    await writeFile(path.join(storageDir, 'v2', 'credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'individual-key',
    }), 'utf8');
    try {
      const payload = buildZCodeAccountSyncPayload(configPath);
      assert.deepEqual((payload?.providers as Record<string, unknown>)?.['account:bigmodel-individual-coding-plan'], {
        access: { type: 'zhipu-account', entitled: true },
      });
      assert.deepEqual((payload?.states as Record<string, unknown>)?.['account:bigmodel-individual-coding-plan'], {
        availability: 'available', entitled: true, current: true,
      });
    } finally {
      if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorage;
    }
  });
});

test('buildZCodeAccountSyncPayload returns null when no individual key is stored', async () => {
  await withEngineLayout(path.join('provider', 'zcode-builtin.json'), async (_enginePath, configPath) => {
    assert.ok(configPath);
    await writeFile(configPath, JSON.stringify({ revision: 30 }), 'utf8');

    const previousStorage = process.env.ZCODE_STORAGE_DIR;
    const storageDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-payload-storage-'));
    process.env.ZCODE_STORAGE_DIR = storageDir;
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(v2Dir, { recursive: true });
    await writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({ other: 'val' }), 'utf8');

    try {
      const payload = buildZCodeAccountSyncPayload(configPath);
      assert.equal(payload, null);
    } finally {
      if (previousStorage === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorage;
    }
  });
});
