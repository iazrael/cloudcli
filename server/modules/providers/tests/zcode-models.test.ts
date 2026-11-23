import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { encryptZCodeCredentialValue } from '@/modules/providers/list/zcode/zcode-credentials.js';
import { clearEnginePathCache } from '@/modules/providers/list/zcode/zcode-engine-path.js';
import {
  readZCodeModelContextWindow,
  readZCodeModelReasoningValues,
} from '@/modules/providers/list/zcode/zcode-provider-config.js';
import {
  ZCodeProviderModels,
  buildZCodeSendModelParams,
  readZCodeModelContextLimit,
  resolveZCodeModelRef,
} from '@/modules/providers/list/zcode/zcode-models.provider.js';

/** Redirects ZCODE_STORAGE_DIR to a temp dir for fixture isolation. */
const withZCodeStorage = async (runTest: (storageDir: string) => Promise<void>): Promise<void> => {
  const previous = process.env.ZCODE_STORAGE_DIR;
  const previousEngine = process.env.CLOUDCLI_ZCODE_ENGINE;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-models-'));
  process.env.ZCODE_STORAGE_DIR = tempDir;
  // Pin engine resolution to a fixture bundle without a builtin provider
  // config, so native template defaults read as unavailable unless the test
  // installs them explicitly. The resolver caches per process, so the cache
  // is reset around every case.
  const enginePath = path.join(tempDir, 'engine', 'zcode.cjs');
  await mkdir(path.dirname(enginePath), { recursive: true });
  await writeFile(enginePath, '', 'utf8');
  process.env.CLOUDCLI_ZCODE_ENGINE = enginePath;
  clearEnginePathCache();

  try {
    await runTest(tempDir);
  } finally {
    if (previous === undefined) {
      delete process.env.ZCODE_STORAGE_DIR;
    } else {
      process.env.ZCODE_STORAGE_DIR = previous;
    }
    if (previousEngine === undefined) {
      delete process.env.CLOUDCLI_ZCODE_ENGINE;
    } else {
      process.env.CLOUDCLI_ZCODE_ENGINE = previousEngine;
    }
    clearEnginePathCache();
    await rm(tempDir, { recursive: true, force: true });
  }
};

/** Writes template model enable defaults into the fixture engine bundle. */
const withEngineTemplateModelRules = async (
  storageDir: string,
  rules: unknown[],
  modelRules: unknown[] = [],
): Promise<void> => {
  const providerDir = path.join(storageDir, 'engine', 'provider');
  await mkdir(providerDir, { recursive: true });
  await writeFile(path.join(providerDir, 'zcode-builtin.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    config: { modelConfigRules: { templateModelRules: rules, ...(modelRules.length ? { modelRules } : {}) } },
  }), 'utf8');
};

/** Engine reasoning specs mirroring the aliyun template shape. */
const ALIYUN_MODEL_RULES = [
  // The catch-all ships first, engine-accurate ordering.
  { modelMatch: '.*', config: { optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } } },
  { modelMatch: '.*qwen-max.*', config: { optionSpecs: { reasoningLevel: { values: ['low', 'medium', 'xhigh'] } } } },
  { modelMatch: '.*deepseek-x.*', config: { optionSpecs: { reasoningLevel: { values: ['disabled', 'low', 'high', 'max'] } } } },
];

test('getSupportedModels falls back to the builtin catalog without a config', async () => {
  await withZCodeStorage(async () => {
    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    assert.equal(definition.DEFAULT, 'GLM-5.3-Flash');
    assert.equal(definition.OPTIONS[0].value, 'GLM-5.3');
    assert.deepEqual(
      definition.OPTIONS[0].effort?.values.map((value) => value.value),
      ['low', 'high', 'max']
    );
  });
});

test('getSupportedModels parses the cli config provider catalog', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'builtin:bigmodel-coding-plan': {
            kind: 'anthropic',
            models: {
              'GLM-5.3': {
                reasoning: { variants: ['max', 'low', 'high'] },
                limit: { context: 1000000, output: 128000 },
              },
            },
          },
        },
      }),
      'utf8'
    );

    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    // The plan row only enriches GLM-5.3; the pinned pair completes the
    // catalog with GLM-5.3-Flash.
    assert.equal(definition.OPTIONS.length, 2);
    assert.equal(definition.DEFAULT, 'GLM-5.3-Flash');
    assert.equal(definition.OPTIONS[0].description, 'ZCode model with 1000K context, 128K output');
    // Variants are normalized to reasoning intensity order: low -> high -> max
    assert.deepEqual(
      definition.OPTIONS[0].effort?.values.map((value) => value.value),
      ['low', 'high', 'max']
    );
    assert.equal(definition.OPTIONS[1].value, 'GLM-5.3-Flash');
  });
});

test('getSupportedModels ignores disabled providers and deduplicates model options', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'builtin:disabled-provider': {
            enabled: false,
            models: {
              'GLM-5.3': {
                reasoning: { variants: ['low'] },
              },
              'DISABLED-ONLY': {},
            },
          },
          'builtin:first-provider': {
            enabled: true,
            models: {
              'GLM-5.3': {
                reasoning: { variants: ['max', 'low'] },
              },
            },
          },
          'builtin:second-provider': {
            models: {
              'GLM-5.3': {
                reasoning: { variants: ['high'] },
              },
              'GLM-5.3-Flash': {},
            },
          },
        },
      }),
      'utf8'
    );

    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    // DISABLED-ONLY should not be present; GLM-5.3 must appear exactly once
    assert.deepEqual(
      definition.OPTIONS.map((opt) => opt.value),
      ['GLM-5.3', 'GLM-5.3-Flash']
    );
  });
});

test('readZCodeSessionModelInfoFromDb returns null without a database', async () => {
  await withZCodeStorage(async () => {
    const { readZCodeSessionModelInfoFromDb } = await import('@/modules/providers/list/zcode/zcode-models.provider.js');
    assert.equal(readZCodeSessionModelInfoFromDb('sess_any'), null);
  });
});

test('resolveZCodeModelRef parses full ref and bare model key', async () => {
  // Case 1: Full ref with slash
  const full = resolveZCodeModelRef('custom:zai/GLM-5.3');
  assert.deepEqual(full, {
    providerId: 'custom:zai',
    modelId: 'GLM-5.3',
  });

  // Case 2: With reasoning effort variant
  const fullWithVariant = resolveZCodeModelRef('custom:zai/GLM-5.3', 'high');
  assert.deepEqual(fullWithVariant, {
    providerId: 'custom:zai',
    modelId: 'GLM-5.3',
    options: { reasoningLevel: 'high' },
  });

  // Case 3: Bare model with config and variant
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'custom-provider': {
            enabled: true,
            models: {
              'GLM-5.3': {},
            },
          },
        },
      }),
      'utf8'
    );

    const resolved = resolveZCodeModelRef('GLM-5.3', 'max');
    assert.deepEqual(resolved, {
      providerId: 'custom-provider',
      modelId: 'GLM-5.3',
      options: { reasoningLevel: 'max' },
    });
  });
});

test('buildZCodeSendModelParams maps the selected model, reasoning level, and auth for 0.16.9', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'bigmodel-coding-plan': {
            kind: 'anthropic',
            options: { apiKey: 'fixture-key', baseURL: 'https://example.invalid/api/anthropic' },
            models: {
              'GLM-5.3-Flash': {
                reasoning: { enabled: true, levels: ['low', 'max'], defaultLevel: 'max' },
              },
            },
          },
        },
      }),
      'utf8'
    );

    assert.deepEqual(buildZCodeSendModelParams('GLM-5.3-Flash', 'low'), {
      modelSelection: {
        providerId: 'bigmodel-coding-plan',
        modelId: 'GLM-5.3-Flash',
        options: { reasoningLevel: 'low' },
      },
      modelExecution: {
        selectionScope: 'execution',
        requestAuth: { apiKey: 'fixture-key' },
      },
    });
    assert.deepEqual(
      buildZCodeSendModelParams('builtin:bigmodel-coding-plan/GLM-5.3-Flash'),
      {
        modelSelection: {
          providerId: 'bigmodel-coding-plan',
          modelId: 'GLM-5.3-Flash',
          options: { reasoningLevel: 'max' },
        },
        modelExecution: {
          selectionScope: 'execution',
          requestAuth: { apiKey: 'fixture-key' },
        },
      },
    );
  });
});

test('buildZCodeSendModelParams degrades to null instead of blocking the send when config is incomplete', async () => {
  await withZCodeStorage(async (storageDir) => {
    // No cli/config.json at all.
    assert.equal(buildZCodeSendModelParams('GLM-5.3'), null);

    // Provider present but without credentials or base URL.
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'bigmodel-coding-plan': { kind: 'anthropic', models: { 'GLM-5.3': {} } },
        },
      }),
      'utf8'
    );
    assert.equal(buildZCodeSendModelParams('GLM-5.3'), null);
  });
});

test('readZCodeSessionModelInfoFromDb returns model and variant from latest message', async () => {
  await withZCodeStorage(async (storageDir) => {
    const dbDir = path.join(storageDir, 'cli', 'db');
    await mkdir(dbDir, { recursive: true });

    const db = new Database(path.join(dbDir, 'db.sqlite'));
    try {
      db.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL,
          sequence INTEGER
        );
      `);
      const insert = db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insert.run('m1', 'sess_var', 1000, 1000, JSON.stringify({
        role: 'user',
        model: { modelID: 'GLM-5.3', variant: 'high' },
      }), 0);
    } finally {
      db.close();
    }

    const { readZCodeSessionModelInfoFromDb } = await import('@/modules/providers/list/zcode/zcode-models.provider.js');
    assert.deepEqual(readZCodeSessionModelInfoFromDb('sess_var'), {
      modelId: 'GLM-5.3',
      variant: 'high',
    });
  });
});

test('getSupportedModels appends the pinned trial Flash option when a trial JWT exists', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(cliDir, { recursive: true });
    await mkdir(v2Dir, { recursive: true });

    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'bigmodel-coding-plan': {
            kind: 'anthropic',
            models: {
              'GLM-5.3': { reasoning: { variants: ['low', 'high', 'max'], defaultLevel: 'max' } },
              'GLM-5.3-Flash': { reasoning: { variants: ['low', 'high', 'max'], defaultLevel: 'max' } },
            },
          },
        },
      }),
      'utf8'
    );

    await writeFile(
      path.join(v2Dir, 'credentials.json'),
      JSON.stringify({ zcodejwttoken: 'mock-jwt-token' }),
      'utf8'
    );

    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    // The trial plan appends exactly one pinned option keyed by its
    // account-scoped id; personal options stay bare and ungrouped.
    assert.deepEqual(
      definition.OPTIONS.map((opt) => opt.value),
      ['GLM-5.3', 'GLM-5.3-Flash', 'account:bigmodel-start-plan/GLM-5.3-Flash']
    );
    const trial = definition.OPTIONS[2];
    assert.equal(trial.label, 'GLM-5.3-Flash（体验）');
    assert.equal(trial.group, undefined);
    assert.equal(trial.effort?.default, 'max');
    assert.deepEqual(
      trial.effort?.values.map((value) => value.value),
      ['low', 'high', 'max']
    );
    assert.equal(definition.DEFAULT, 'GLM-5.3-Flash');
  });
});

test('getSupportedModels falls back to the builtin catalog when only the legacy v2 config exists', async () => {
  await withZCodeStorage(async (storageDir) => {
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(v2Dir, { recursive: true });
    await writeFile(
      path.join(v2Dir, 'config.json'),
      JSON.stringify({
        provider: {
          'builtin:bigmodel-coding-plan': {
            kind: 'anthropic',
            models: {
              'GLM-5.3': { reasoning: { variants: ['low', 'high', 'max'] } },
              'GLM-5.2': {},
            },
          },
        },
      }),
      'utf8'
    );

    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    // The v2 path is no longer consulted; without a cli config the pinned
    // plan pair is the whole catalog.
    assert.deepEqual(
      definition.OPTIONS.map((opt) => opt.value),
      ['GLM-5.3', 'GLM-5.3-Flash']
    );
  });
});

test('buildZCodeSendModelParams sends start-plan refs on the trial plan with its JWT', async () => {
  await withZCodeStorage(async (storageDir) => {
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(v2Dir, { recursive: true });
    const encryptedToken = encryptZCodeCredentialValue('trial-jwt-token');
    assert.match(encryptedToken, /^enc:v1:/);
    await writeFile(
      path.join(v2Dir, 'credentials.json'),
      JSON.stringify({ zcodejwttoken: encryptedToken }),
      'utf8'
    );

    const params = buildZCodeSendModelParams('account:bigmodel-start-plan/GLM-5.3-Flash', 'high');
    assert.ok(params);
    assert.deepEqual(params.modelSelection, {
      providerId: 'account:bigmodel-start-plan',
      modelId: 'GLM-5.3-Flash',
      options: { reasoningLevel: 'high' },
    });
    // The decrypted plain token must be passed, never raw ciphertext.
    assert.deepEqual(params.modelExecution, {
      selectionScope: 'execution',
      requestAuth: { apiKey: 'trial-jwt-token' },
    });
  });
});

test('personal plan uses the native account provider and its own credential', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(cliDir, { recursive: true });
    await mkdir(v2Dir, { recursive: true });
    await writeFile(path.join(cliDir, 'config.json'), JSON.stringify({
      provider: {
        'bigmodel-coding-plan': {
          kind: 'anthropic',
          options: { apiKey: 'legacy-key', baseURL: 'https://example.invalid/api/anthropic' },
          models: { 'GLM-5.3-Flash': {} },
        },
      },
    }), 'utf8');
    await writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key':
        encryptZCodeCredentialValue('personal-plan-key'),
      zcodejwttoken: encryptZCodeCredentialValue('trial-jwt'),
    }), 'utf8');

    const catalog = await new ZCodeProviderModels().getSupportedModels();
    assert.equal(catalog.OPTIONS.find((option) => option.value === 'GLM-5.3-Flash')?.group,
      undefined);
    // Bare model ids resolve to the native account provider at send time.
    assert.deepEqual(buildZCodeSendModelParams('GLM-5.3-Flash', 'high'), {
      modelSelection: {
        providerId: 'account:bigmodel-individual-coding-plan',
        modelId: 'GLM-5.3-Flash',
        options: { reasoningLevel: 'high' },
      },
      modelExecution: { selectionScope: 'execution', requestAuth: { apiKey: 'personal-plan-key' } },
    });
    // Saved account-prefixed selections keep working.
    assert.deepEqual(buildZCodeSendModelParams('account:bigmodel-individual-coding-plan/GLM-5.3-Flash', 'high'), {
      modelSelection: {
        providerId: 'account:bigmodel-individual-coding-plan',
        modelId: 'GLM-5.3-Flash',
        options: { reasoningLevel: 'high' },
      },
      modelExecution: { selectionScope: 'execution', requestAuth: { apiKey: 'personal-plan-key' } },
    });
    for (const legacyRef of [
      'bigmodel-coding-plan/GLM-5.3-Flash',
      'builtin:bigmodel-coding-plan/GLM-5.3-Flash',
    ]) {
      assert.equal(buildZCodeSendModelParams(legacyRef)?.modelSelection.providerId,
        'account:bigmodel-individual-coding-plan');
    }
  });
});

test('native individual plan remains selectable without a legacy provider config', async () => {
  await withZCodeStorage(async (storageDir) => {
    const v2Dir = path.join(storageDir, 'v2');
    await mkdir(v2Dir, { recursive: true });
    await writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'personal-key',
    }), 'utf8');
    const catalog = await new ZCodeProviderModels().getSupportedModels();
    assert.equal(catalog.DEFAULT, 'GLM-5.3-Flash');
    assert.deepEqual(buildZCodeSendModelParams('GLM-5.3-Flash')?.modelSelection, {
      providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash',
      options: { reasoningLevel: 'max' },
    });
  });
});

test('account plan selection fails when its credential is missing', async () => {
  await withZCodeStorage(async () => {
    assert.throws(() => buildZCodeSendModelParams('account:bigmodel-individual-coding-plan/GLM-5.3-Flash'),
      /individual.*credential/i);
    // The trial selection needs its own trial JWT; it never falls back to the
    // individual key or the engine default.
    assert.throws(() => buildZCodeSendModelParams('account:bigmodel-start-plan/GLM-5.3-Flash'),
      /start.*credential/i);
  });
});

test('a same-name custom model keeps its provider when an individual-plan key exists', async () => {
  await withZCodeStorage(async (storageDir) => {
    await mkdir(path.join(storageDir, 'cli'), { recursive: true });
    await mkdir(path.join(storageDir, 'v2'), { recursive: true });
    await writeFile(path.join(storageDir, 'cli', 'config.json'), JSON.stringify({ provider: {
      'custom-provider': {
        kind: 'anthropic', options: { apiKey: 'custom-key', baseURL: 'https://example.invalid/api' },
        models: { 'GLM-5.3-Flash': {} },
      },
      'bigmodel-coding-plan': {
        kind: 'anthropic', options: { apiKey: 'legacy-key', baseURL: 'https://example.invalid/api' },
        models: { 'GLM-5.3-Flash': {} },
      },
    } }), 'utf8');
    await writeFile(path.join(storageDir, 'v2', 'credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'personal-key',
    }), 'utf8');
    const catalog = await new ZCodeProviderModels().getSupportedModels();
    // The custom provider owns the same-name key (first listing row wins):
    // its grouped option covers the plan entry and keeps its own routing.
    const flashOption = catalog.OPTIONS.find((option) => option.value === 'GLM-5.3-Flash');
    assert.equal(flashOption?.group, 'custom-provider');
    assert.equal(buildZCodeSendModelParams(flashOption!.value)?.modelSelection.providerId,
      'custom-provider');
  });
});

test('readZCodeSessionModelInfoFromDb re-scopes start-plan sessions for picker highlighting', async () => {
  await withZCodeStorage(async (storageDir) => {
    const dbDir = path.join(storageDir, 'cli', 'db');
    await mkdir(dbDir, { recursive: true });

    const db = new Database(path.join(dbDir, 'db.sqlite'));
    try {
      db.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL,
          sequence INTEGER
        );
      `);
      const insert = db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)'
      );
      // Real engine writes providerID and modelID (uppercase ID)
      insert.run('m_start', 'sess_start_plan', 2000, 2000, JSON.stringify({
        role: 'user',
        model: {
          providerID: 'account:bigmodel-start-plan',
          modelID: 'GLM-5.3-Flash',
          variant: 'max',
        },
      }), 0);
      insert.run('m_ind', 'sess_individual', 3000, 3000, JSON.stringify({
        role: 'user',
        model: {
          providerID: 'account:bigmodel-individual-coding-plan',
          modelID: 'GLM-5.3-Flash',
          variant: 'max',
        },
      }), 1);
    } finally {
      db.close();
    }

    const { readZCodeSessionModelInfoFromDb } = await import('@/modules/providers/list/zcode/zcode-models.provider.js');
    // The trial option is the only picker entry keyed by its scoped id, so
    // the start-plan readback re-attaches the scope for exact matching.
    assert.deepEqual(readZCodeSessionModelInfoFromDb('sess_start_plan'), {
      modelId: 'account:bigmodel-start-plan/GLM-5.3-Flash',
      variant: 'max',
    });
    // Individual-plan sessions report bare ids that match the personal options.
    assert.deepEqual(readZCodeSessionModelInfoFromDb('sess_individual'), {
      modelId: 'GLM-5.3-Flash',
      variant: 'max',
    });
  });
});

/** Writes a ZCode App native personal provider config into the fixture. */
const withNativeProviderConfig = async (
  storageDir: string,
  body: unknown,
): Promise<void> => {
  const v2Dir = path.join(storageDir, 'v2');
  await mkdir(v2Dir, { recursive: true });
  await writeFile(path.join(v2Dir, 'provider_config.json'), JSON.stringify(body), 'utf8');
};

/** Aliyun Bailian-shaped native config fixture (App settings page output). */
const NATIVE_ALIYUN_CONFIG = {
  schemaVersion: 1,
  config: {
    providerOrder: ['qwen-alibaba-model-studio-cn'],
    providerConfigRules: {
      providerRules: [
        {
          providerId: 'qwen-alibaba-model-studio-cn',
          templateId: 'qwen-alibaba-model-studio-cn',
          providerName: '阿里云百炼（中国）',
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: 'native-secret' },
            api: { baseUrl: 'https://example.invalid/apps/anthropic' },
            personalModelIds: ['deepseek-x'],
            modelOrder: ['qwen-max', 'qwen-flash', 'deepseek-x', 'DISABLED-MODEL'],
          },
        },
        {
          // Reserved account rows belong to the plan routing, not the native list.
          providerId: 'account:bigmodel-start-plan',
          config: { modelOrder: ['SHOULD-NOT-APPEAR'] },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [
        { providerId: 'qwen-alibaba-model-studio-cn', modelId: 'deepseek-x', config: { enabled: true } },
        { providerId: 'qwen-alibaba-model-studio-cn', modelId: 'DISABLED-MODEL', config: { enabled: false } },
      ],
      manualProviderModelRules: [
        { providerId: 'qwen-alibaba-model-studio-cn', modelId: 'manual-y', config: { enabled: true } },
        { providerId: 'qwen-alibaba-model-studio-cn', modelId: 'manual-off', config: { enabled: false } },
      ],
    },
  },
};

/** Engine-side template defaults: only qwen-max ships enabled. */
const ALIYUN_TEMPLATE_RULES = [
  { templateId: 'qwen-alibaba-model-studio-cn', modelId: 'qwen-max', config: { enabled: true } },
  { templateId: 'qwen-alibaba-model-studio-cn', modelId: 'qwen-flash', config: { enabled: false } },
  { templateId: 'qwen-alibaba-model-studio-cn', modelId: 'deepseek-x', config: { enabled: false } },
];

test('getSupportedModels merges ZCode App native providers as grouped options', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(path.join(cliDir, 'config.json'), JSON.stringify({
      provider: {
        'bigmodel-coding-plan': {
          kind: 'anthropic',
          models: {
            'GLM-5.3': { reasoning: { variants: ['low', 'max'], defaultLevel: 'max' } },
            'GLM-5.3-Flash': {},
            'GLM-4.7': {},
          },
        },
      },
    }), 'utf8');
    await withNativeProviderConfig(storageDir, NATIVE_ALIYUN_CONFIG);
    await withEngineTemplateModelRules(storageDir, ALIYUN_TEMPLATE_RULES);

    const definition = await new ZCodeProviderModels().getSupportedModels();

    // Personal whitelist still drops GLM-4.7; native entries match the App
    // model page: user rules first, engine template defaults next (qwen-flash
    // ships disabled and nobody enabled it), personalModelIds memberships stay
    // enabled, manual additions pass through, reserved account rows never
    // list. deepseek-x wins over the template `false` via its user rule.
    assert.deepEqual(
      definition.OPTIONS.map((opt) => opt.value),
      ['GLM-5.3', 'GLM-5.3-Flash', 'qwen-max', 'deepseek-x', 'manual-y'],
    );
    assert.equal(definition.OPTIONS[0].group, undefined);
    assert.equal(definition.OPTIONS[2].group, '阿里云百炼（中国）');
    assert.equal(definition.OPTIONS[2].description, 'ZCode qwen-max model');
    assert.equal(definition.OPTIONS[2].effort, undefined);
    assert.equal(definition.DEFAULT, 'GLM-5.3-Flash');
    // A template-disabled model is not routable either.
    assert.equal(buildZCodeSendModelParams('qwen-flash'), null);
  });
});

test('getSupportedModels lists native providers permissively when template defaults are unavailable', async () => {
  await withZCodeStorage(async (storageDir) => {
    // Fixture engine bundle has no zcode-builtin.json: with no template
    // defaults to consult, unlisted models fall back to enabled rather than
    // showing an empty group.
    await withNativeProviderConfig(storageDir, NATIVE_ALIYUN_CONFIG);

    const definition = await new ZCodeProviderModels().getSupportedModels();

    assert.deepEqual(
      definition.OPTIONS.map((opt) => opt.value),
      // The plan pair heads the menu; native groups follow.
      ['GLM-5.3', 'GLM-5.3-Flash', 'qwen-max', 'qwen-flash', 'deepseek-x', 'manual-y'],
    );
    assert.equal(definition.DEFAULT, 'GLM-5.3-Flash');
  });
});

test('personalModelIds memberships stay enabled even when the template ships them off', async () => {
  await withZCodeStorage(async (storageDir) => {
    const noUserRules = JSON.parse(JSON.stringify(NATIVE_ALIYUN_CONFIG));
    noUserRules.config.modelConfigRules.providerModelRules = [];
    await withNativeProviderConfig(storageDir, noUserRules);
    await withEngineTemplateModelRules(storageDir, ALIYUN_TEMPLATE_RULES);

    const definition = await new ZCodeProviderModels().getSupportedModels();

    // deepseek-x: not in templateModelRules as enabled, but listed in
    // personalModelIds (user-added), so it mirrors the App. qwen-flash stays
    // out: template-off with neither a user rule nor membership.
    assert.deepEqual(
      definition.OPTIONS.map((opt) => opt.value),
      ['GLM-5.3', 'GLM-5.3-Flash', 'qwen-max', 'deepseek-x', 'manual-y'],
    );
  });
});

test('native options carry engine reasoning levels and sends default to the top level', async () => {
  await withZCodeStorage(async (storageDir) => {
    await withNativeProviderConfig(storageDir, NATIVE_ALIYUN_CONFIG);
    await withEngineTemplateModelRules(storageDir, ALIYUN_TEMPLATE_RULES, ALIYUN_MODEL_RULES);

    const definition = await new ZCodeProviderModels().getSupportedModels();
    const qwen = definition.OPTIONS.find((opt) => opt.value === 'qwen-max');
    assert.deepEqual(qwen?.effort?.values.map((v) => v.value), ['low', 'medium', 'xhigh']);
    assert.equal(qwen?.effort?.default, 'xhigh');
    const deepseek = definition.OPTIONS.find((opt) => opt.value === 'deepseek-x');
    assert.deepEqual(deepseek?.effort?.values.map((v) => v.value), ['low', 'high', 'max', 'disabled']);
    assert.equal(deepseek?.effort?.default, 'max');
    // A disabled/enabled toggle is not an effort picker for the menu.
    const manual = definition.OPTIONS.find((opt) => opt.value === 'manual-y');
    assert.equal(manual?.effort, undefined);

    // The engine requires a level when the model ships reasoning specs, so
    // sends default to the top effort and keep explicit choices.
    assert.deepEqual(buildZCodeSendModelParams('qwen-max'), {
      modelSelection: {
        providerId: 'qwen-alibaba-model-studio-cn',
        modelId: 'qwen-max',
        options: { reasoningLevel: 'xhigh' },
      },
      modelExecution: { selectionScope: 'execution' },
    });
    assert.deepEqual(buildZCodeSendModelParams('deepseek-x')?.modelSelection.options, { reasoningLevel: 'max' });
    assert.deepEqual(buildZCodeSendModelParams('qwen-max', 'low')?.modelSelection.options, { reasoningLevel: 'low' });
    // Toggle-only models default to thinking off.
    assert.deepEqual(buildZCodeSendModelParams('manual-y')?.modelSelection.options, { reasoningLevel: 'disabled' });
  });
});

test('native sends omit reasoning options when the engine ships no specs', async () => {
  await withZCodeStorage(async (storageDir) => {
    await withNativeProviderConfig(storageDir, NATIVE_ALIYUN_CONFIG);
    // Builtin present for template defaults but no modelRules: no reasoning
    // knowledge, so no invented level.
    await withEngineTemplateModelRules(storageDir, ALIYUN_TEMPLATE_RULES);

    assert.deepEqual(buildZCodeSendModelParams('qwen-max')?.modelSelection, {
      providerId: 'qwen-alibaba-model-studio-cn',
      modelId: 'qwen-max',
    });
  });
});

test('cli config keeps precedence over native providers with the same model key', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(path.join(cliDir, 'config.json'), JSON.stringify({
      provider: {
        'custom-provider': {
          name: 'Custom Provider',
          kind: 'anthropic',
          options: { apiKey: 'custom-key', baseURL: 'https://example.invalid/api' },
          models: { 'qwen-flash': {} },
        },
      },
    }), 'utf8');
    await withNativeProviderConfig(storageDir, NATIVE_ALIYUN_CONFIG);

    const definition = await new ZCodeProviderModels().getSupportedModels();
    const duplicates = definition.OPTIONS.filter((opt) => opt.value === 'qwen-flash');
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].group, 'Custom Provider');
    // Routing follows the same precedence as the list.
    assert.equal(resolveZCodeModelRef('qwen-flash').providerId, 'custom-provider');
  });
});

test('resolveZCodeModelRef routes native model ids to their provider', async () => {
  await withZCodeStorage(async (storageDir) => {
    await withNativeProviderConfig(storageDir, NATIVE_ALIYUN_CONFIG);

    assert.deepEqual(resolveZCodeModelRef('qwen-max', 'low'), {
      providerId: 'qwen-alibaba-model-studio-cn',
      modelId: 'qwen-max',
      options: { reasoningLevel: 'low' },
    });
    // Scoped refs route through the existing explicit-provider branch.
    assert.equal(
      resolveZCodeModelRef('qwen-alibaba-model-studio-cn/qwen-max').providerId,
      'qwen-alibaba-model-studio-cn',
    );
  });
});

test('buildZCodeSendModelParams routes native providers without copying the api key', async () => {
  await withZCodeStorage(async (storageDir) => {
    await withNativeProviderConfig(storageDir, NATIVE_ALIYUN_CONFIG);

    const params = buildZCodeSendModelParams('qwen-max', 'low');
    assert.deepEqual(params, {
      modelSelection: {
        providerId: 'qwen-alibaba-model-studio-cn',
        modelId: 'qwen-max',
        options: { reasoningLevel: 'low' },
      },
      modelExecution: { selectionScope: 'execution' },
    });
    // The credential lives in the personal config handed to the engine at
    // spawn; it must never be duplicated into the send payload.
    assert.doesNotMatch(JSON.stringify(params), /native-secret/);
  });
});

test('buildZCodeSendModelParams degrades to null for native providers without api-key access', async () => {
  await withZCodeStorage(async (storageDir) => {
    const headless = JSON.parse(JSON.stringify(NATIVE_ALIYUN_CONFIG));
    delete headless.config.providerConfigRules.providerRules[0].config.access.apiKey;
    await withNativeProviderConfig(storageDir, headless);

    assert.equal(buildZCodeSendModelParams('qwen-flash'), null);
    // Disabled models are not routable either.
    assert.equal(buildZCodeSendModelParams('DISABLED-MODEL'), null);
  });
});

test('getSupportedModels enforces personal whitelist and keeps custom provider groups distinct', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });

    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'bigmodel-coding-plan': {
            kind: 'anthropic',
            models: {
              'GLM-5.3': {},
              'GLM-5.3-Flash': {},
              'GLM-4.7': {},
              'OBSOLETE-MODEL': {},
            },
          },
          'custom-provider-id': {
            name: 'Custom Provider',
            kind: 'openai',
            models: {
              'custom-model-x': {},
            },
          },
        },
      }),
      'utf8'
    );

    const models = new ZCodeProviderModels();
    const definition = await models.getSupportedModels();

    // Whitelist blocks GLM-4.7 and OBSOLETE-MODEL from personal provider; the
    // personal plan itself stays ungrouped so the menu reads like a flat list.
    const personalModels = definition.OPTIONS.filter((opt) => opt.group === undefined);
    assert.deepEqual(
      personalModels.map((opt) => opt.value),
      ['GLM-5.3', 'GLM-5.3-Flash']
    );

    // Custom provider keeps its own group name, NEVER labeled BigModel (个人)
    const customModel = definition.OPTIONS.find((opt) => opt.value === 'custom-model-x');
    assert.ok(customModel);
    assert.equal(customModel.group, 'Custom Provider');
  });
});

test('readZCodeModelContextLimit reads limit.context from the engine config', async () => {
  await withZCodeStorage(async (storageDir) => {
    const cliDir = path.join(storageDir, 'cli');
    await mkdir(cliDir, { recursive: true });
    await writeFile(
      path.join(cliDir, 'config.json'),
      JSON.stringify({
        provider: {
          'bigmodel-coding-plan': {
            models: { 'GLM-5.3': { limit: { context: 1_000_000, output: 128_000 } } },
          },
          'custom-provider': {
            enabled: false,
            models: { 'GLM-5.3': { limit: { context: 1 } } },
          },
        },
      }),
      'utf8'
    );

    assert.equal(readZCodeModelContextLimit('GLM-5.3'), 1_000_000);
    // Disabled providers are skipped; an unknown model has no window to read.
    assert.equal(readZCodeModelContextLimit('unknown-model'), null);
  });
});

test('readZCodeModelContextLimit returns null without an engine config', async () => {
  await withZCodeStorage(async () => {
    assert.equal(readZCodeModelContextLimit('GLM-5.3'), null);
  });
});

/** Writes the runtime-synced builtin cache the ZCode client refreshes from its remote catalog. */
const withRuntimeBuiltinCache = async (
  storageDir: string,
  payload: { revision: number; providerRules: unknown[]; modelRules?: unknown[] },
): Promise<string> => {
  const cachePath = path.join(
    storageDir, 'v2', 'runtime', 'provider', 'darwin-aarch64', '3.18.2', 'endpoint-fixture', 'zcode-builtin.json',
  );
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify({
    schemaVersion: 1,
    revision: payload.revision,
    // Real cache files always carry modelConfigRules; the reader gates on it.
    config: {
      modelConfigRules: { modelRules: payload.modelRules ?? [] },
      providerConfigRules: { providerRules: payload.providerRules },
    },
  }), 'utf8');
  return cachePath;
};

const INDIVIDUAL_PLAN_RULE = {
  providerId: 'account:bigmodel-individual-coding-plan',
  providerName: 'BigModel Individual Coding Plan',
  config: { builtinModelIds: ['GLM-5.4', 'GLM-5.3', 'GLM-5.3-Flash'] },
};

/** Engine-shaped GLM rows mirroring the rev-47 runtime cache (anchored patterns, per-model context). */
const GLM_RUNTIME_MODEL_RULES = [
  {
    modelMatch: '.*',
    config: { properties: { contextWindow: 200000 }, optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } },
  },
  {
    modelMatch: '(?:.*/)?glm[^/]*',
    config: { properties: { contextWindow: 1000000 }, optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] } } },
  },
  {
    modelMatch: '(?:.*/)?glm-5(?:-[0-9]{6,8})?',
    config: { properties: { contextWindow: 200000 }, optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } },
  },
  {
    modelMatch: '.*glm-5\\.3.*',
    config: { properties: { contextWindow: 1000000 }, optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] } } },
  },
];

test('getSupportedModels follows the runtime-synced plan catalog', async () => {
  await withZCodeStorage(async (storageDir) => {
    await withRuntimeBuiltinCache(storageDir, {
      revision: 47,
      providerRules: [INDIVIDUAL_PLAN_RULE],
      modelRules: GLM_RUNTIME_MODEL_RULES,
    });
    await mkdir(path.join(storageDir, 'cli'), { recursive: true });
    await writeFile(
      path.join(storageDir, 'cli', 'config.json'),
      JSON.stringify({
        provider: {
          'bigmodel-coding-plan': {
            kind: 'anthropic',
            // No GLM-5.4 record yet: the engine has not materialized it here.
            models: {
              'GLM-5.3': {
                reasoning: { enabled: true, levels: ['low', 'max', 'high'], defaultLevel: 'max' },
                limit: { context: 1000000, output: 128000 },
              },
              'GLM-5.3-Flash': {},
              'GLM-4.7': {},
            },
          },
        },
      }),
      'utf8'
    );

    const catalog = await new ZCodeProviderModels().getSupportedModels();
    // Engine-added GLM-5.4 shows up from the catalog even though the engine
    // has not written its record into cli/config.json yet; the stale
    // GLM-4.7 stays blocked even though cli/config.json lists it.
    const planModels = catalog.OPTIONS
      .filter((option) => option.group === undefined)
      .map((option) => option.value);
    assert.deepEqual(planModels, ['GLM-5.4', 'GLM-5.3', 'GLM-5.3-Flash']);
    // Catalog-only metadata come from the builtin table rows…
    const glm54 = catalog.OPTIONS.find((option) => option.value === 'GLM-5.4');
    assert.deepEqual(glm54?.effort?.values.map((entry) => entry.value), ['low', 'high', 'max']);
    assert.match(glm54?.description ?? '', /1000K context/);
    // …while GLM-5.3 is enriched by its cli/config.json record.
    const glm53 = catalog.OPTIONS.find((option) => option.value === 'GLM-5.3');
    assert.match(glm53?.description ?? '', /128K output/);
    // The default model stays anchored so a catalog reorder cannot drift it.
    assert.equal(catalog.DEFAULT, 'GLM-5.3-Flash');
  });
});

test('builtin reasoning rows match like the engine: anchored and case-insensitive', async () => {
  await withZCodeStorage(async (storageDir) => {
    await withEngineTemplateModelRules(storageDir, [], GLM_RUNTIME_MODEL_RULES);

    // Uppercase plan ids resolve through the lowercase rows (the engine's
    // matcher is case-insensitive).
    assert.deepEqual(readZCodeModelReasoningValues('GLM-5.4'), ['low', 'high', 'max']);
    assert.deepEqual(readZCodeModelReasoningValues('GLM-5.3'), ['low', 'high', 'max']);
    // The bare `glm-5(?:-digits)?` row is anchored, so GLM-5.1 keeps the
    // generic glm row instead of being swallowed by the glm-5 prefix.
    assert.deepEqual(readZCodeModelReasoningValues('GLM-5.1'), ['low', 'high', 'max']);
    // Per-row context windows follow the same last-match resolution.
    assert.equal(readZCodeModelContextWindow('GLM-5.4'), 1_000_000);
    // A non-GLM id only hits the catch-all row.
    assert.equal(readZCodeModelContextWindow('qwen-max'), 200_000);
  });
});

test('readZCodeModelContextLimit falls back to the builtin row context', async () => {
  await withZCodeStorage(async (storageDir) => {
    await withEngineTemplateModelRules(storageDir, [], GLM_RUNTIME_MODEL_RULES);

    // No cli/config.json record for GLM-5.4 yet; the builtin row carries the
    // usage denominator until the engine materializes one.
    assert.equal(readZCodeModelContextLimit('GLM-5.4'), 1_000_000);
  });
});

test('runtime-catalog plan ids route to the individual provider', async () => {
  await withZCodeStorage(async (storageDir) => {
    await withRuntimeBuiltinCache(storageDir, { revision: 47, providerRules: [INDIVIDUAL_PLAN_RULE] });
    await mkdir(path.join(storageDir, 'v2'), { recursive: true });
    await writeFile(path.join(storageDir, 'v2', 'credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key':
        encryptZCodeCredentialValue('personal-plan-key'),
    }), 'utf8');

    // Bare id from the runtime catalog resolves to the plan credential at send.
    assert.deepEqual(buildZCodeSendModelParams('GLM-5.4'), {
      modelSelection: {
        providerId: 'account:bigmodel-individual-coding-plan',
        modelId: 'GLM-5.4',
        options: { reasoningLevel: 'max' },
      },
      modelExecution: { selectionScope: 'execution', requestAuth: { apiKey: 'personal-plan-key' } },
    });
    // Outside the catalog a bare id keeps the legacy default routing.
    assert.equal(resolveZCodeModelRef('GLM-4.7').providerId, 'builtin:bigmodel-coding-plan');
  });
});
