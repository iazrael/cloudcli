import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildZCodeAccountSyncPayload,
  findActiveZCodeBuiltinConfig,
  findZCodeBundledProviderConfig,
  findZCodeRuntimeProviderConfig,
  resolveZCodeBuiltinRevision,
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

test('findActiveZCodeBuiltinConfig returns the catalog the spawn env hands the engine', async () => {
  await withFixture(async ({ storageDir, enginePath, bundledDir }) => {
    assert.equal(findActiveZCodeBuiltinConfig(enginePath), path.join(bundledDir, 'zcode-builtin.json'));

    const endpoint = path.join(storageDir, 'v2', 'runtime', 'provider', 'windows-x86_64', '3.12.3', 'endpoint-a');
    await mkdir(endpoint, { recursive: true });
    const runtimeCatalog = path.join(endpoint, 'zcode-builtin.json');
    await writeFile(runtimeCatalog, '{"schemaVersion":1}', 'utf8');

    assert.equal(findActiveZCodeBuiltinConfig(enginePath), runtimeCatalog);
    assert.equal(findActiveZCodeBuiltinConfig(enginePath), resolveZCodeProviderConfigEnv(enginePath).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE);
  });
});

test('resolveZCodeBuiltinRevision tags the revision with the sha256 of the resolved path', async () => {
  await withFixture(async ({ bundledDir }) => {
    const configPath = path.join(bundledDir, 'zcode-builtin.json');
    await writeFile(configPath, JSON.stringify({ revision: 30 }), 'utf8');

    const expectedHash = crypto.createHash('sha256').update(path.resolve(configPath)).digest('hex');
    assert.equal(resolveZCodeBuiltinRevision(configPath), `zcode-builtin:30:${expectedHash}`);
  });
});

test('resolveZCodeBuiltinRevision returns null for a missing file or a missing revision', async () => {
  await withFixture(async ({ bundledDir }) => {
    assert.equal(resolveZCodeBuiltinRevision(path.join(bundledDir, 'absent.json')), null);
    // The fixture catalog carries no revision.
    assert.equal(resolveZCodeBuiltinRevision(path.join(bundledDir, 'zcode-builtin.json')), null);
  });
});

test('buildZCodeAccountSyncPayload entitles the start-plan provider when a JWT is stored', async () => {
  await withFixture(async ({ storageDir, bundledDir }) => {
    const configPath = path.join(bundledDir, 'zcode-builtin.json');
    await writeFile(configPath, JSON.stringify({ revision: 30 }), 'utf8');
    await mkdir(path.join(storageDir, 'v2'), { recursive: true });
    await writeFile(path.join(storageDir, 'v2', 'credentials.json'), JSON.stringify({ zcodejwttoken: 'test-jwt-token' }), 'utf8');

    const payload = buildZCodeAccountSyncPayload(configPath);
    assert.ok(payload);
    assert.equal(payload.revision, '1');
    assert.equal(payload.basedOnZCodeBuiltinRevision, resolveZCodeBuiltinRevision(configPath));
    assert.deepEqual(payload.providers, {
      'account:bigmodel-start-plan': { access: { type: 'zhipu-account', entitled: true } },
    });
    assert.deepEqual(payload.states, {
      'account:bigmodel-start-plan': { availability: 'available', entitled: true, current: true },
    });
  });
});

test('buildZCodeAccountSyncPayload returns null without a stored JWT', async () => {
  await withFixture(async ({ storageDir, bundledDir }) => {
    const configPath = path.join(bundledDir, 'zcode-builtin.json');
    await writeFile(configPath, JSON.stringify({ revision: 30 }), 'utf8');
    await mkdir(path.join(storageDir, 'v2'), { recursive: true });
    await writeFile(path.join(storageDir, 'v2', 'credentials.json'), JSON.stringify({ other: 'value' }), 'utf8');

    assert.equal(buildZCodeAccountSyncPayload(configPath), null);
  });
});

test('account sync activates the native individual provider when its plan key is available', async () => {
  await withFixture(async ({ storageDir, bundledDir }) => {
    const configPath = path.join(bundledDir, 'zcode-builtin.json');
    await writeFile(configPath, JSON.stringify({ revision: 30 }), 'utf8');
    await mkdir(path.join(storageDir, 'v2'), { recursive: true });
    await writeFile(path.join(storageDir, 'v2', 'credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'individual-key',
    }), 'utf8');

    const payload = buildZCodeAccountSyncPayload(configPath);
    assert.ok(payload);
    assert.deepEqual((payload.providers as Record<string, unknown>)['account:bigmodel-individual-coding-plan'], {
      access: { type: 'zhipu-account', entitled: true },
    });
    assert.deepEqual((payload.states as Record<string, unknown>)['account:bigmodel-individual-coding-plan'], {
      availability: 'available', entitled: true, current: true,
    });
    // No JWT stored, so the trial provider stays out of the payload.
    assert.equal((payload.providers as Record<string, unknown>)['account:bigmodel-start-plan'], undefined);
  });
});
