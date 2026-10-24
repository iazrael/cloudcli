import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  OpenCodeProviderModels,
  OPENCODE_PREDEFINED_MODELS,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

const OPENCODE_ENV_KEYS = [
  'OPENCODE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
];

/**
 * Runs one case against a throwaway OpenCode home, so the catalog the adapter
 * reports depends on the fixture rather than on the providers the machine
 * running the suite happens to be logged into.
 *
 * The CLI executable override points at a missing path unless a case installs
 * its own fake, so the dynamic `opencode models` probe fails fast and the
 * assertions exercise the declared fallback instead of the real machine's
 * account.
 */
const withOpenCodeHome = async (
  setUp: (homeDir: string) => Promise<void>,
  runTest: (adapter: OpenCodeProviderModels) => Promise<void>,
): Promise<void> => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-catalog-'));
  const originalHomedir = os.homedir;
  const envKeys = [...OPENCODE_ENV_KEYS, 'CLOUDCLI_OPENCODE_CLI'];
  const originalEnv = envKeys.map((key) => [key, process.env[key]] as const);

  (os as any).homedir = () => homeDir;
  for (const key of envKeys) {
    if (key === 'CLOUDCLI_OPENCODE_CLI') {
      process.env[key] = path.join(homeDir, 'no-such-opencode');
    } else {
      delete process.env[key];
    }
  }

  try {
    await setUp(homeDir);
    await runTest(new OpenCodeProviderModels());
  } finally {
    (os as any).homedir = originalHomedir;
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(homeDir, { recursive: true, force: true });
  }
};

/** Installs a fake `opencode` executable whose stdout stands in for `opencode models`. */
const writeFakeOpenCodeCli = async (homeDir: string, stdout: string): Promise<string> => {
  const cliPath = path.join(homeDir, 'fake-opencode');
  const heredocBody = stdout.endsWith('\n') ? stdout : `${stdout}\n`;
  await writeFile(cliPath, `#!/bin/sh\ncat <<'EOF'\n${heredocBody}EOF\n`, 'utf8');
  await chmod(cliPath, 0o755);
  return cliPath;
};

const writeOpenCodeAuth = async (homeDir: string, auth: Record<string, unknown>): Promise<void> => {
  const authDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, 'auth.json'), JSON.stringify(auth), 'utf8');
};

test('OpenCode falls back to the anchor catalog when nothing dynamic is readable', async () => {
  await withOpenCodeHome(async () => {}, async (adapter) => {
    // Nothing readable about this install, so the picker keeps the anchor
    // entries rather than coming up empty.
    assert.deepEqual(await adapter.getSupportedModels(), OPENCODE_PREDEFINED_MODELS);
    assert.equal(
      (await adapter.getCurrentActiveModel()).model,
      OPENCODE_PREDEFINED_MODELS.DEFAULT,
    );
  });
  // OpenCode routes by `<providerID>/<modelID>`, so every anchor has to carry
  // a provider prefix the CLI would report.
  const providerIds = new Set(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value.split('/')[0]),
  );
  assert.deepEqual([...providerIds].sort(), ['opencode', 'opencode-go']);
  assert.equal(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.every((option) => /^[a-z0-9-]+\/.+/.test(option.value)),
    true,
  );
  assert.equal(
    new Set(OPENCODE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value)).size,
    OPENCODE_PREDEFINED_MODELS.OPTIONS.length,
  );
  // The anchors deliberately stay tiny: the dynamic CLI listing is the real
  // catalog, so every hardcoded id is a maintenance liability that will churn
  // with OpenCode's console lineup. They only stand in when the probe fails,
  // anchor the shared capability catalogs' default model, and carry the Go
  // effort variants a synthesized option cannot know.
  assert.equal(OPENCODE_PREDEFINED_MODELS.DEFAULT, 'opencode/gpt-5.6-terra');
  assert.deepEqual(
    OPENCODE_PREDEFINED_MODELS.OPTIONS.map((option) => option.value),
    ['opencode/gpt-5.6-terra', 'opencode-go/glm-5.3'],
  );
  // Effort choices come from `opencode models --verbose` variants; the runtime
  // turns a selected value into `--variant`, so the values have to match the
  // CLI's exactly.
  const goAnchor = OPENCODE_PREDEFINED_MODELS.OPTIONS.find(
    (option) => option.value === 'opencode-go/glm-5.3',
  );
  assert.ok(goAnchor);
  assert.deepEqual(
    goAnchor?.effort?.values.map((value) => value.value),
    ['low', 'high', 'max'],
  );
});

test('OpenCode offers only models the install can route to', async () => {
  // With the dynamic probe unavailable the anchor list stands in, and it only
  // covers the opencode/opencode-go families. A connected provider without an
  // anchor entry (anthropic here) empties the narrowing, and the empty-filter
  // guard keeps the anchors visible rather than handing the picker an empty
  // list — the dynamic probe is what surfaces direct-connect families.
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeAuth(homeDir, { anthropic: { type: 'api', key: 'test' } }),
    async (adapter) => {
      assert.deepEqual(await adapter.getSupportedModels(), OPENCODE_PREDEFINED_MODELS);
    },
  );

  // A Go subscriber's auth store holds only `opencode-go`, so the anchor list
  // narrows to the Go entry and the default moves onto it instead of the
  // unreachable Zen default.
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeAuth(homeDir, { 'opencode-go': { type: 'api', key: 'test' } }),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();

      assert.deepEqual(
        catalog.OPTIONS,
        OPENCODE_PREDEFINED_MODELS.OPTIONS.filter((option) => option.value.startsWith('opencode-go/')),
      );
      assert.equal(catalog.DEFAULT, 'opencode-go/glm-5.3');
      assert.ok(catalog.OPTIONS.some((option) => option.value === catalog.DEFAULT));
      assert.equal((await adapter.getCurrentActiveModel()).model, catalog.DEFAULT);
    },
  );

  // Zen credentials keep the anchor default, which its own family covers.
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeAuth(homeDir, { opencode: { type: 'api', key: 'test' } }),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();

      assert.equal(catalog.DEFAULT, OPENCODE_PREDEFINED_MODELS.DEFAULT);
    },
  );
});

const writeOpenCodeCredentialDatabase = async (
  homeDir: string,
  rows: Array<{ integrationId: string; label: string; active: number }>,
) => {
  const dbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE credential (
        id text PRIMARY KEY,
        integration_id text,
        label text NOT NULL,
        value text NOT NULL,
        connector_id text,
        method_id text,
        active integer,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      );
    `);
    const insert = db.prepare(
      'INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const [index, row] of rows.entries()) {
      insert.run(`cred_${index}`, row.integrationId, row.label, 'secret', row.active, 1000 + index, 2000 + index);
    }
  } finally {
    db.close();
  }
};

test('OpenCode reads connected providers from the v2 credential database', async () => {
  // OpenCode v2 no longer writes auth.json; `opencode auth login` stores one
  // row per connected integration in opencode.db, so a Console-only install
  // must narrow the catalog to Zen models instead of offering every provider.
  await withOpenCodeHome(
    (homeDir) => writeOpenCodeCredentialDatabase(homeDir, [
      { integrationId: 'opencode', label: 'Personal', active: 0 },
      { integrationId: 'opencode', label: 'Azrael', active: 1 },
    ]),
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();
      const providerIds = new Set(catalog.OPTIONS.map((option) => option.value.split('/')[0]));

      assert.deepEqual([...providerIds], ['opencode']);
      assert.equal(catalog.DEFAULT, OPENCODE_PREDEFINED_MODELS.DEFAULT);
      assert.ok(catalog.OPTIONS.some((option) => option.value === catalog.DEFAULT));
    },
  );
});

test('OpenCode reads display names and effort variants from the cached catalog', async () => {
  // v2's `opencode models` prints ids only; the models.dev catalog the CLI
  // caches in opencode.db carries the official display names and the
  // reasoning-effort values each model accepts.
  await withOpenCodeHome(
    async (homeDir) => {
      const cliPath = await writeFakeOpenCodeCli(
        homeDir,
        ['opencode/beam-free', 'opencode/glm-5.3-flash-free'].join('\n'),
      );
      process.env.CLOUDCLI_OPENCODE_CLI = cliPath;

      const dbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
      await mkdir(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      try {
        db.exec('CREATE TABLE kv (key text PRIMARY KEY, value text NOT NULL);');
        db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(
          'models-dev:catalog',
          JSON.stringify({
            updatedAt: 1,
            digest: 'd',
            body: JSON.stringify({
              opencode: {
                models: {
                  'beam-free': {
                    name: 'Beam Free',
                    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
                  },
                  'glm-5.3-flash-free': { name: 'GLM 5.3 Flash Free', reasoning_options: [] },
                },
              },
            }),
          }),
        );
      } finally {
        db.close();
      }
    },
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();

      assert.deepEqual(catalog.OPTIONS, [
        {
          value: 'opencode/beam-free',
          label: 'Beam Free',
          description: 'OpenCode Zen · Free',
          effort: {
            values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }],
          },
        },
        // Empty reasoning_options mean no effort picker, and the -free suffix
        // keeps its gateway annotation.
        { value: 'opencode/glm-5.3-flash-free', label: 'GLM 5.3 Flash Free', description: 'OpenCode Zen · Free' },
      ]);
    },
  );
});

test('OpenCode does not run `opencode models` again for every turn', async () => {
  // Every turn reads the catalog before it starts, and the CLI query takes a
  // second or more; within the fresh window the catalog comes from memory.
  await withOpenCodeHome(
    async (homeDir) => {
      const cliPath = path.join(homeDir, 'fake-opencode');
      await writeFile(
        cliPath,
        `#!/bin/sh\necho run >> '${path.join(homeDir, 'runs')}'\necho opencode/beam-free\n`,
        'utf8',
      );
      await chmod(cliPath, 0o755);
      process.env.CLOUDCLI_OPENCODE_CLI = cliPath;
    },
    async (adapter) => {
      const first = await adapter.getSupportedModels();
      const second = await adapter.getSupportedModels();
      await adapter.getCurrentActiveModel();

      assert.deepEqual(second, first);
      const runs = (await readFile(path.join(os.homedir(), 'runs'), 'utf8')).trim().split('\n');
      assert.equal(runs.length, 1);
    },
  );
});

test('OpenCode lists only the models the CLI reports for the account', async () => {
  // `opencode models` answers with the models the logged-in account can
  // actually route, so the picker must mirror it instead of the curated
  // catalog — a model the console never enabled fails the run outright.
  await withOpenCodeHome(
    async (homeDir) => {
      const cliPath = await writeFakeOpenCodeCli(
        homeDir,
        [
          'opencode/gpt-5.6-terra',
          '',
          'garbage-without-slash',
          'opencode/claude-fable-5',
          'opencode/gpt-5.6-terra',
          'opencode/beam-free',
          'opencode-go/glm-5.3',
          'anthropic/claude-sonnet-9',
        ].join('\n'),
      );
      process.env.CLOUDCLI_OPENCODE_CLI = cliPath;
    },
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();

      // Deduplicated, malformed lines dropped; anchor entries keep their
      // label and description; unknown ids get synthesized display text, and
      // direct-connect families are labeled with their own name rather than
      // the OpenCode gateways. claude-fable-5 used to be an anchor and now
      // pins the synthesis path for formerly hardcoded ids.
      assert.deepEqual(catalog.OPTIONS, [
        OPENCODE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === 'opencode/gpt-5.6-terra'),
        { value: 'opencode/claude-fable-5', label: 'Claude Fable 5', description: 'OpenCode Zen' },
        { value: 'opencode/beam-free', label: 'Beam Free', description: 'OpenCode Zen · Free' },
        OPENCODE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === 'opencode-go/glm-5.3'),
        { value: 'anthropic/claude-sonnet-9', label: 'Claude Sonnet 9', description: 'Anthropic' },
      ]);
      // The curated default stays when the account has it enabled.
      assert.equal(catalog.DEFAULT, OPENCODE_PREDEFINED_MODELS.DEFAULT);
    },
  );

  // Without the curated default the first reported model takes over, so the
  // picker never opens on a model the account cannot route.
  await withOpenCodeHome(
    async (homeDir) => {
      const cliPath = await writeFakeOpenCodeCli(
        homeDir,
        ['opencode/gemini-4-argon', 'opencode/space-bunny-free'].join('\n'),
      );
      process.env.CLOUDCLI_OPENCODE_CLI = cliPath;
    },
    async (adapter) => {
      const catalog = await adapter.getSupportedModels();

      assert.deepEqual(catalog.OPTIONS, [
        { value: 'opencode/gemini-4-argon', label: 'Gemini 4 Argon', description: 'OpenCode Zen' },
        { value: 'opencode/space-bunny-free', label: 'Space Bunny Free', description: 'OpenCode Zen · Free' },
      ]);
      assert.equal(catalog.DEFAULT, 'opencode/gemini-4-argon');
    },
  );
});

const writeOpenCodeSessionDatabase = async (homeDir: string, rows: Array<Record<string, unknown>>) => {
  const dbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        model text,
        agent text,
        directory text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      );
    `);
    const insert = db.prepare(
      'INSERT INTO session (id, model, agent, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const [index, row] of rows.entries()) {
      insert.run(
        row.id,
        row.model,
        row.agent ?? null,
        row.directory ?? '/tmp/project',
        row.timeCreated ?? 1700000000000,
        row.timeUpdated ?? 1700000001000 + index,
      );
    }
  } finally {
    db.close();
  }
};

test('OpenCode composes the provider prefix into session model ids', async () => {
  // The lookup translates the app session id through the sessions database,
  // so point it at a throwaway file rather than the developer's real one.
  const tempSessionsDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-model-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempSessionsDirectory, 'auth.db');
    await initializeDatabase();
    // OpenCode stores the provider and model id in separate fields of the
    // session row ({"id":"z-ai/glm-5.3-flash","providerID":"openrouter"}), but
    // the CLI's `--model` flag only resolves the composed
    // `<providerID>/<modelID>` form. Resuming such a session without the prefix
    // fails with an unknown-model server error, which hits OpenRouter users
    // hardest because their model ids carry a slash themselves.
    await withOpenCodeHome(
      (homeDir) => writeOpenCodeSessionDatabase(homeDir, [
        {
          id: 'ses_openrouter',
          model: JSON.stringify({
            id: 'z-ai/glm-5.3-flash',
            providerID: 'openrouter',
            variant: 'default',
          }),
        },
        {
          id: 'ses_qualified',
          // An id that already carries the provider prefix must survive as-is.
          model: JSON.stringify({
            id: 'openrouter/z-ai/glm-5.3-flash',
            providerID: 'openrouter',
          }),
        },
        {
          id: 'ses_plain_string',
          model: 'opencode/gpt-5.6-terra',
        },
        {
          id: 'ses_github_copilot',
          model: JSON.stringify({
            id: 'gpt-5.6-terra',
            providerID: 'github-copilot',
          }),
        },
      ]),
      async (adapter) => {
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_openrouter')).model,
          'openrouter/z-ai/glm-5.3-flash',
        );
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_qualified')).model,
          'openrouter/z-ai/glm-5.3-flash',
        );
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_plain_string')).model,
          'opencode/gpt-5.6-terra',
        );
        assert.equal(
          (await adapter.getCurrentActiveModel('ses_github_copilot')).model,
          'github-copilot/gpt-5.6-terra',
        );
      },
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempSessionsDirectory, { recursive: true, force: true });
  }
});
