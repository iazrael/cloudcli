import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
  stripAnsiSequences,
} from '@/shared/utils.js';

import {
  getOpenCodeDatabasePath,
  resolveOpenCodeSessionTableName,
} from './opencode-data-root.js';
import { tryResolveOpenCodeEnginePath } from './opencode-engine-path.js';

/**
 * Curated OpenCode catalog shipped as immutable CloudCLI defaults.
 *
 * OpenCode routes by `<providerID>/<modelID>`, so this list mirrors the
 * providers `opencode models --verbose` reports: the OpenCode Zen gateway, the
 * OpenCode Go subscription gateway, and the Anthropic and OpenAI providers
 * OpenCode can address directly with the user's own credentials.
 */
/**
 * Static anchor catalog for OpenCode.
 *
 * The real catalog is the account-scoped list `opencode models` reports at
 * runtime; these two entries only stand in when that probe is unavailable
 * (CLI missing, failing, or answering empty) and anchor the shared capability
 * catalogs' default model. Model ids churn with OpenCode's console lineup, so
 * this list is deliberately tiny: every entry here is a maintenance liability,
 * not a feature. The Go anchor additionally carries the effort variants a
 * dynamic option cannot know. Unknown dynamic ids are synthesized on the fly
 * by buildOpenCodeModelOption, which reuses an entry's display metadata on
 * match.
 */
export const OPENCODE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'opencode/gpt-5.6-terra', label: 'GPT 5.6 Terra', description: 'OpenCode Zen' },
    {
      value: 'opencode-go/glm-5.3',
      label: 'GLM 5.3',
      description: 'OpenCode Go',
      effort: {
        values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
  ],
  DEFAULT: 'opencode/gpt-5.6-terra',
};

/** Global OpenCode config files, in the order the CLI loads them. */
const OPENCODE_CONFIG_FILES = ['config.json', 'opencode.json', 'opencode.jsonc'];

/** Provider API keys OpenCode reads straight from the environment. */
const OPENCODE_ENV_PROVIDER_IDS: Record<string, string> = {
  OPENCODE_API_KEY: 'opencode',
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
};

const readOpenCodeJsonFile = async (filePath: string): Promise<Record<string, unknown> | null> => {
  try {
    return readObjectRecord(JSON.parse(await readFile(filePath, 'utf8')));
  } catch {
    // Missing, unreadable, or comment-bearing (.jsonc) files simply contribute
    // nothing; the auth store is the authoritative source below.
    return null;
  }
};

/**
 * Reads the upstream provider ids OpenCode v2 records in its shared database.
 *
 * OpenCode v2 stores one `credential` row per connected integration and no
 * longer writes the v1-era auth.json, so without this sweep a v2 install
 * contributes no provider ids at all and the picker offers models the CLI
 * cannot route. Only active rows count — rotating a login deactivates the
 * replaced row. A missing database or an older layout without the credential
 * table contributes nothing.
 */
const readDatabaseCredentialProviderIds = (): Set<string> => {
  const providerIds = new Set<string>();
  try {
    const db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(
        'SELECT integration_id FROM credential WHERE active = 1 AND integration_id IS NOT NULL',
      ).all() as Array<{ integration_id?: string | null }>;
      for (const row of rows) {
        const integrationId = row.integration_id?.trim();
        if (integrationId) {
          providerIds.add(integrationId);
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // Contributes nothing, mirroring the missing-auth.json handling.
  }
  return providerIds;
};

/**
 * Lists the upstream providers this OpenCode install can actually route to.
 *
 * OpenCode resolves `<providerID>/<modelID>` against the providers the user has
 * connected, and rejects anything else outright - `Model
 * opencode/claude-sonnet-4-6 is not valid` is what a run gets for asking for an
 * OpenCode Zen model on a machine that only has an Anthropic key. The curated
 * catalog spans every provider OpenCode can address, so it has to be narrowed
 * to this machine's providers before it reaches the model picker.
 *
 * Returns null when nothing can be read, so the caller keeps the full catalog
 * rather than leaving the picker empty. Providers declared only in a
 * project-level `opencode.json` are not visible here; the null fallback and the
 * env-key sweep keep those installs on the full list.
 */
const readConnectedOpenCodeProviderIds = async (): Promise<Set<string> | null> => {
  const providerIds = new Set<string>();
  const configDir = path.join(os.homedir(), '.config', 'opencode');

  for (const providerId of readDatabaseCredentialProviderIds()) {
    providerIds.add(providerId);
  }

  const auth = await readOpenCodeJsonFile(
    path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
  );
  for (const [providerId, credential] of Object.entries(auth ?? {})) {
    if (readObjectRecord(credential)) {
      providerIds.add(providerId);
    }
  }

  const configs: Array<Record<string, unknown> | null> = [];
  for (const configFile of OPENCODE_CONFIG_FILES) {
    configs.push(await readOpenCodeJsonFile(path.join(configDir, configFile)));
  }

  // Custom config passed through OPENCODE_CONFIG (a file path) or
  // OPENCODE_CONFIG_CONTENT (inline JSON) is read too, so providers declared
  // there are not filtered out of the CLI listing.
  const customConfigPath = readOptionalString(process.env.OPENCODE_CONFIG);
  if (customConfigPath) {
    configs.push(await readOpenCodeJsonFile(customConfigPath));
  }
  const inlineConfig = readOptionalString(process.env.OPENCODE_CONFIG_CONTENT);
  if (inlineConfig) {
    try {
      configs.push(readObjectRecord(JSON.parse(inlineConfig)));
    } catch {
      // Malformed inline config contributes nothing, like an unreadable file.
    }
  }

  for (const config of configs) {
    for (const providerId of Object.keys(readObjectRecord(config?.provider) ?? {})) {
      providerIds.add(providerId);
    }
  }

  for (const [envKey, providerId] of Object.entries(OPENCODE_ENV_PROVIDER_IDS)) {
    if (readOptionalString(process.env[envKey])) {
      providerIds.add(providerId);
    }
  }

  return providerIds.size > 0 ? providerIds : null;
};

/**
 * Narrows the curated catalog to the providers OpenCode can route to.
 *
 * The default has to move with the list: leaving it on an OpenCode Zen model
 * would hand every new session a model the CLI refuses to run.
 */
const filterOpenCodeModelsByProvider = (
  definition: ProviderModelsDefinition,
  connectedProviderIds: Set<string> | null,
): ProviderModelsDefinition => {
  if (!connectedProviderIds) {
    return definition;
  }

  const options = definition.OPTIONS.filter(
    (option) => connectedProviderIds.has(option.value.split('/')[0]),
  );
  if (options.length === 0) {
    return definition;
  }

  return {
    ...definition,
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === definition.DEFAULT)
      ? definition.DEFAULT
      : options[0].value,
  };
};

const execFileAsync = promisify(execFile);

/** `opencode models` answers in ~100ms via the background service; a hung CLI must not pin the models endpoint. */
const OPENCODE_MODELS_PROBE_TIMEOUT_MS = 5000;

/** `<providerID>/<modelID>` as printed by `opencode models`; looser ids would never run anyway. */
const OPENCODE_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;

/** Brand spellings the capitalized fallback label must not mangle. */
const OPENCODE_LABEL_ACRONYMS: Record<string, string> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  gpt: 'GPT',
  mimo: 'MiMo',
  openai: 'OpenAI',
};

const humanizeOpenCodeModelLabel = (modelId: string): string => (
  modelId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => OPENCODE_LABEL_ACRONYMS[token.toLowerCase()] ?? (
      token.charAt(0).toUpperCase() + token.slice(1)
    ))
    .join(' ')
);

/** Gateway display names for OpenCode's own provider families; other families route directly. */
const OPENCODE_FAMILY_DESCRIPTIONS: Record<string, string> = {
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
};

type OpenCodeCatalogModelEntry = {
  name?: string;
  reasoning_options?: Array<{ type?: string; values?: string[] }>;
};

/**
 * Reads the models.dev catalog OpenCode caches in its database (`kv` key
 * `models-dev:catalog`) and maps `<family>/<modelId>` to the display name and
 * reasoning-effort values it records for each model.
 *
 * This is where the reasoning-variant data lives in v2 — `opencode models`
 * prints ids only, but this catalog carries `reasoning_options` per model and
 * is refreshed by the CLI itself. A missing database, missing key, or a
 * `body` encoded as an embedded JSON string all degrade to an empty map, so
 * options fall back to synthesized labels without effort variants.
 */
const readOpenCodeCatalogEntries = (): Map<string, OpenCodeCatalogModelEntry> => {
  const entries = new Map<string, OpenCodeCatalogModelEntry>();
  try {
    const db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT value FROM kv WHERE key = 'models-dev:catalog'").get() as {
        value?: string;
      } | undefined;
      const parsed = readJsonRecord(row?.value);
      let body: unknown = parsed?.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }
      const families = readObjectRecord(body) ?? {};
      for (const [familyId, family] of Object.entries(families)) {
        const models = readObjectRecord(readObjectRecord(family)?.models) ?? {};
        for (const [modelId, model] of Object.entries(models)) {
          const record = readObjectRecord(model);
          if (record) {
            entries.set(`${familyId}/${modelId}`, record as OpenCodeCatalogModelEntry);
          }
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // No database or no cached catalog: options fall back to synthesis.
  }
  return entries;
};

const buildOpenCodeModelOption = (
  value: string,
  catalogEntries: Map<string, OpenCodeCatalogModelEntry> = new Map(),
): ProviderModelOption => {
  const curated = OPENCODE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === value);
  if (curated) {
    return curated;
  }

  const familyId = value.slice(0, value.indexOf('/'));
  const modelId = value.slice(value.indexOf('/') + 1);
  // Direct-connect families (anthropic/openai/...) are labeled with their own
  // name — stamping them "OpenCode Zen" would misrepresent where the run goes.
  const gateway = OPENCODE_FAMILY_DESCRIPTIONS[familyId] ?? humanizeOpenCodeModelLabel(familyId);
  const catalogEntry = catalogEntries.get(value);
  const effortValues = (catalogEntry?.reasoning_options ?? [])
    .find((option) => option?.type === 'effort')
    ?.values?.filter((entry): entry is string => typeof entry === 'string') ?? [];

  return {
    value,
    label: catalogEntry?.name?.trim() || humanizeOpenCodeModelLabel(modelId),
    description: modelId.endsWith('-free') && familyId.startsWith('opencode')
      ? `${gateway} · Free`
      : gateway,
    ...(effortValues.length > 0
      ? { effort: { values: effortValues.map((effortValue) => ({ value: effortValue })) } }
      : {}),
  };
};

/**
 * Builds the account-scoped catalog from the ids `opencode models` reported.
 *
 * The curated default survives when the account has that model enabled;
 * otherwise the first reported model takes over, so the picker never opens on
 * a model the CLI would refuse to run.
 */
const buildAccountScopedOpenCodeCatalog = (
  modelIds: string[],
  catalogEntries: Map<string, OpenCodeCatalogModelEntry>,
): ProviderModelsDefinition => {
  const options = modelIds.map((modelId) => buildOpenCodeModelOption(modelId, catalogEntries));
  const curatedDefault = OPENCODE_PREDEFINED_MODELS.DEFAULT;
  return {
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === curatedDefault)
      ? curatedDefault
      : options[0].value,
  };
};

/**
 * Runs `opencode models` and returns the `<providerID>/<modelID>` ids it
 * reports, deduplicated in output order.
 *
 * This is the account's own model list — the console entitlements — so it is
 * strictly narrower and fresher than the anchor catalog. Any failure
 * (missing CLI, non-zero exit, timeout, empty output) returns empty so the
 * caller falls back to the curated catalog. The executable override follows
 * the CLAUDE_CLI_PATH / CLOUDCLI_ZCODE_ENGINE precedent and is read per call
 * so tests can install a fake after import; without an override the shared
 * engine-path resolver supplies the binary (platform install locations
 * included, which matters under pm2 where PATH may lack Homebrew).
 */
const readOpenCodeCliModelIds = async (): Promise<string[]> => {
  const executable = process.env.CLOUDCLI_OPENCODE_CLI?.trim() || tryResolveOpenCodeEnginePath() || 'opencode';
  try {
    const { stdout } = await execFileAsync(executable, ['models'], {
      timeout: OPENCODE_MODELS_PROBE_TIMEOUT_MS,
      // Otherwise the probe flashes a console window on Windows.
      windowsHide: true,
    });

    const modelIds: string[] = [];
    for (const line of stripAnsiSequences(stdout).split(/\r?\n/)) {
      const modelId = line.trim();
      if (modelId && OPENCODE_MODEL_ID_PATTERN.test(modelId) && !modelIds.includes(modelId)) {
        modelIds.push(modelId);
      }
    }
    return modelIds;
  } catch {
    return [];
  }
};

const parseOpenCodeSessionModelValue = (rawModel: unknown): string | null => {
  if (typeof rawModel === 'string') {
    const trimmed = rawModel.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return parseOpenCodeSessionModelValue(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }

  const record = readObjectRecord(rawModel);
  if (!record) {
    return null;
  }

  const modelId = readOptionalString(record.id)
    ?? readOptionalString(record.model)
    ?? readOptionalString(record.name)
    ?? readOptionalString(record.value);
  if (!modelId) {
    return null;
  }

  // OpenCode persists the provider and model id in separate fields (for
  // example {"id":"z-ai/glm-5.3-flash","providerID":"openrouter"}), and its
  // CLI's `--model` flag only accepts the composed `<providerID>/<modelID>`
  // form. Compose it here so a resumed session resolves the same model
  // instead of failing with an unknown-model error.
  const providerId = readOptionalString(record.providerID)
    ?? readOptionalString(record.providerId);
  if (providerId && !modelId.startsWith(`${providerId}/`)) {
    return `${providerId}/${modelId}`;
  }

  return modelId;
};

/** Provider registry model adapter for OpenCode account models and session metadata. */
export class OpenCodeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // `opencode models` reports exactly the models the logged-in account can
    // route — narrower and fresher than the anchor catalog, which only
    // covers the fallback path (CLI missing, failing, or answering empty).
    const cliModelIds = await readOpenCodeCliModelIds();
    if (cliModelIds.length > 0) {
      return buildAccountScopedOpenCodeCatalog(cliModelIds, readOpenCodeCatalogEntries());
    }

    return filterOpenCodeModelsByProvider(
      OPENCODE_PREDEFINED_MODELS,
      await readConnectedOpenCodeProviderIds(),
    );
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    // OpenCode's `session` table is keyed by its own session id, so the stable
    // app id has to be translated first; sessions discovered on disk store the
    // provider id in both columns and resolve to themselves.
    const providerSessionId = sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId;

    try {
      const dbPath = getOpenCodeDatabasePath();
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      try {
        const table = resolveOpenCodeSessionTableName(db);
        const row = table
          ? db.prepare(`
              SELECT
                s.id AS sessionId,
                s.model AS model,
                s.agent AS agent,
                s.directory AS directory,
                s.time_updated AS timeUpdated,
                s.time_created AS timeCreated
              FROM ${table} s
              WHERE s.id = ?
              ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC
              LIMIT 1
            `).get(providerSessionId) as {
              sessionId?: string;
              model?: unknown;
              agent?: string | null;
              directory?: string | null;
              timeUpdated?: number | null;
              timeCreated?: number | null;
            } | undefined
          : undefined;

        const model = parseOpenCodeSessionModelValue(row?.model);
        if (model) {
          return {
            model,
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the curated default when OpenCode session lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
