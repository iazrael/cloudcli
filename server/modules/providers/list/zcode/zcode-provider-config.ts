/**
 * ZCode Provider Config Resolution
 *
 * The ZCode desktop app points its embedded CLI engine at three provider
 * configuration files through environment variables. A bare `app-server`
 * spawn (as CloudCLI does) does not inherit them, so the engine cannot locate
 * its builtin provider catalog and `session/create` hangs until the client
 * times out — no model can be selected at all.
 *
 * This module reconstructs those variables from the resolved engine path and
 * the ZCode storage directory:
 * - `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`: the active builtin catalog. The
 *   engine refreshes a copy under `<storage>/v2/runtime/provider/...` and
 *   falls back to the catalog bundled with the install
 *   (`<resources>/config/provider/zcode-builtin.json`).
 * - `ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE`: the install-bundled copy.
 * - `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`: the user's provider overrides
 *   (`<storage>/v2/provider_config.json`), which hold every provider and model
 *   the user added in the ZCode app.
 *
 * Every path is set only when it exists, so an older ZCode install keeps the
 * engine's own resolution behavior.
 *
 * @module zcode-provider-config
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord, readOptionalString, readTrimmedStringRecord } from '@/shared/utils.js';

import { readDecryptedZCodeIndividualPlanApiKey, readDecryptedZCodeJwtToken } from './zcode-credentials.js';
import { getZCodeStorageDir } from './zcode-data-root.js';

/**
 * Engine env override names, exported so the supervisor can strip ambient
 * values inherited from a parent ZCode App session before merging CloudCLI's
 * own resolution (see {@link resolveZCodeProviderConfigEnv}).
 *
 * Consumers: zcode-engine-supervisor.ts and the provider-config tests.
 */
export const ZCODE_BUILTIN_PROVIDER_CONFIG_ENV = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE';
export const ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_ENV = 'ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE';
export const ZCODE_PERSONAL_PROVIDER_CONFIG_ENV = 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE';

const CLOUDCLI_PERSONAL_CONFIG_FILE = 'cloudcli-provider-config.json';

function splitModelRef(value: string): { providerId?: string; modelId: string } {
  const slashIndex = value.indexOf('/');
  if (slashIndex < 0) return { modelId: value };
  return {
    providerId: value.slice(0, slashIndex).trim(),
    modelId: value.slice(slashIndex + 1).trim(),
  };
}

/**
 * Converts ZCode's user-facing `cli/config.json` provider definitions into the
 * strict personal-provider registry consumed by app-server 0.16.9.
 *
 * The generated file is CloudCLI-owned and separate from ZCode's own
 * `v2/provider_config.json`; consumers are the engine supervisor through
 * {@link resolveZCodeProviderConfigEnv}. Returns null when there is no usable
 * provider, in which case the engine keeps its own native config.
 */
function materializeCloudCliProviderConfig(storageDir: string): string | null {
  const sourcePath = path.join(storageDir, 'cli', 'config.json');
  let source: AnyRecord;
  try {
    source = readObjectRecord(JSON.parse(fs.readFileSync(sourcePath, 'utf8'))) ?? {};
  } catch {
    return null;
  }

  const providers = readObjectRecord(source.provider);
  if (!providers) return null;

  const providerRules: AnyRecord[] = [];
  const providerModelRules: AnyRecord[] = [];
  const providerOrder: string[] = [];
  const modelDefaults = new Map<string, string>();

  for (const [providerId, rawProvider] of Object.entries(providers)) {
    // `builtin:` and `account:` rows are migration aliases owned by ZCode's
    // built-in registry. Re-registering them as personal providers can collide
    // with the built-in config; their matching non-reserved provider is used.
    if (providerId.startsWith('builtin:') || providerId.startsWith('account:')) continue;
    const provider = readObjectRecord(rawProvider);
    const models = readObjectRecord(provider?.models);
    const providerOptions = readObjectRecord(provider?.options);
    const baseUrl = readOptionalString(providerOptions?.baseURL) ?? readOptionalString(providerOptions?.baseUrl);
    const apiKey = readOptionalString(providerOptions?.apiKey);
    const headers = readTrimmedStringRecord(providerOptions?.headers);
    const apiType = resolveZCodeProviderApiType(provider?.kind);
    const modelIds = models ? Object.keys(models).filter((modelId) => modelId.trim()) : [];
    if (!provider || !baseUrl || !apiType || (!apiKey && !headers) || modelIds.length === 0) continue;

    providerOrder.push(providerId);
    providerRules.push({
      providerId,
      providerName: readOptionalString(provider.name) ?? providerId,
      enabled: provider.enabled !== false,
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', ...(apiKey ? { apiKey } : {}) },
        api: {
          type: apiType,
          baseUrl,
          ...(headers ? { headers } : {}),
        },
        personalModelIds: modelIds,
        modelOrder: modelIds,
      },
    });

    for (const modelId of modelIds) {
      const model = readObjectRecord(models?.[modelId]);
      const reasoning = readObjectRecord(model?.reasoning);
      const defaultLevel = readOptionalString(reasoning?.defaultLevel);
      if (defaultLevel) modelDefaults.set(`${providerId}/${modelId}`, defaultLevel);
      providerModelRules.push({ providerId, modelId, config: { enabled: true } });
    }
  }

  if (providerRules.length === 0) return null;

  const configuredModel = readOptionalString(source.model);
  let defaultSelection: AnyRecord | undefined;
  if (configuredModel) {
    const parsed = splitModelRef(configuredModel);
    const configuredProviderIsRegistered = parsed.providerId
      && providerOrder.includes(parsed.providerId);
    const providerId = configuredProviderIsRegistered
      ? parsed.providerId
      : providerOrder.find((candidate) => (
          providerModelRules.some((rule) => rule.providerId === candidate && rule.modelId === parsed.modelId)
        ));
    if (providerId && providerModelRules.some((rule) => (
      rule.providerId === providerId && rule.modelId === parsed.modelId
    ))) {
      const reasoningLevel = modelDefaults.get(`${providerId}/${parsed.modelId}`);
      defaultSelection = {
        providerId,
        modelId: parsed.modelId,
        ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
      };
    }
  }

  const nativePersonalPath = path.join(storageDir, 'v2', 'provider_config.json');
  let nativeConfig: AnyRecord | null = null;
  try {
    nativeConfig = readObjectRecord(JSON.parse(fs.readFileSync(nativePersonalPath, 'utf8')));
  } catch {
    // Native personal config is optional.
  }
  const nativeBody = readObjectRecord(nativeConfig?.config);
  const nativeProviderRules = Array.isArray(readObjectRecord(nativeBody?.providerConfigRules)?.providerRules)
    ? readObjectRecord(nativeBody?.providerConfigRules)?.providerRules as unknown[]
    : [];
  const nativeModelConfig = readObjectRecord(nativeBody?.modelConfigRules);
  const nativeProviderModelRules = Array.isArray(nativeModelConfig?.providerModelRules)
    ? nativeModelConfig.providerModelRules as unknown[]
    : [];
  const nativeManualModelRules = Array.isArray(nativeModelConfig?.manualProviderModelRules)
    ? nativeModelConfig.manualProviderModelRules as unknown[]
    : [];
  const generatedProviderIds = new Set(providerOrder);
  const mergedNativeProviderRules = nativeProviderRules.filter((rule) => {
    const providerId = readOptionalString(readObjectRecord(rule)?.providerId);
    return !providerId || !generatedProviderIds.has(providerId);
  });
  const mergedNativeModelRules = nativeProviderModelRules.filter((rule) => {
    const record = readObjectRecord(rule);
    const providerId = readOptionalString(record?.providerId);
    const modelId = readOptionalString(record?.modelId);
    return !providerId || !modelId || !providerModelRules.some((generatedRule) => (
      generatedRule.providerId === providerId && generatedRule.modelId === modelId
    ));
  });
  const nativeProviderOrder = Array.isArray(nativeBody?.providerOrder)
    ? nativeBody.providerOrder.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];

  const generatedPath = path.join(storageDir, 'cli', CLOUDCLI_PERSONAL_CONFIG_FILE);
  const temporaryPath = `${generatedPath}.${process.pid}.tmp`;
  const generated = {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [...providerRules, ...mergedNativeProviderRules] },
      modelConfigRules: {
        providerModelRules: [...providerModelRules, ...mergedNativeModelRules],
        manualProviderModelRules: nativeManualModelRules,
      },
      providerOrder: [...new Set([...providerOrder, ...nativeProviderOrder])],
      ...(defaultSelection
        ? { defaultModelSelection: defaultSelection }
        : readObjectRecord(nativeBody?.defaultModelSelection)
          ? { defaultModelSelection: nativeBody?.defaultModelSelection }
          : {}),
    },
  };

  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(generated), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, generatedPath);
    fs.chmodSync(generatedPath, 0o600);
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // A failed cleanup must not hide the original materialization error.
    }
  }
  return generatedPath;
}

/**
 * Maps ZCode's provider `kind` onto the API shape the engine accepts.
 * Unknown kinds stay null so a provider without a supported transport is
 * skipped instead of being sent with a guessed API type.
 */
export function resolveZCodeProviderApiType(
  kind: unknown,
): 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses' | null {
  const normalized = readOptionalString(kind)?.toLowerCase();
  if (normalized === 'anthropic' || normalized === 'anthropic-messages') return 'anthropic-messages';
  if (normalized === 'openai-responses') return 'openai-responses';
  if (normalized?.startsWith('openai')) return 'openai-chat-completions';
  return null;
}

/**
 * Path to a provider config file, when it exists on disk.
 */
type ProviderConfigPaths = {
  /** Install-bundled builtin catalog, or null when absent. */
  bundled: string | null;
  /** Storage-refreshed builtin catalog, or null when absent. */
  runtime: string | null;
  /** User provider overrides, or null when absent. */
  personal: string | null;
};

/**
 * Finds the install-bundled builtin catalog from the engine entry path.
 *
 * The engine lives at `<app>/resources/glm/zcode.cjs` (or
 * `<app>/Contents/Resources/glm/zcode.cjs` on macOS), so the catalog sits one
 * directory up under `config/provider`. Exported for the engine-path tests.
 *
 * Consumers: `resolveZCodeProviderConfigEnv` (spawn env) and the models
 * provider (catalog fallback source).
 */
export function findZCodeBundledProviderConfig(enginePath: string): string | null {
  const engineDir = path.dirname(enginePath);
  for (const relative of [
    path.join('provider', 'zcode-builtin.json'),
    path.join('..', 'config', 'provider', 'zcode-builtin.json'),
  ]) {
    const candidate = path.resolve(engineDir, relative);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next supported layout.
    }
  }
  return null;
}

/**
 * Finds the newest storage-refreshed builtin catalog.
 *
 * The engine lays them out as
 * `<storage>/v2/runtime/provider/<platform>/<version>/endpoint-<hash>/zcode-builtin.json`;
 * the layout is globbed rather than reconstructed so platform/version naming
 * changes cannot silently break resolution. Exported for the engine-path
 * tests.
 *
 * Consumers: `resolveZCodeProviderConfigEnv` (spawn env) and the models
 * provider (primary catalog source).
 */
export function findZCodeRuntimeProviderConfig(): string | null {
  const runtimeRoot = path.join(getZCodeStorageDir(), 'v2', 'runtime', 'provider');
  let platforms: fs.Dirent[];
  try {
    platforms = fs.readdirSync(runtimeRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  let newest: { filePath: string; mtimeMs: number } | null = null;

  for (const platform of platforms) {
    if (!platform.isDirectory()) continue;
    const platformDir = path.join(runtimeRoot, platform.name);
    let versions: fs.Dirent[];
    try {
      versions = fs.readdirSync(platformDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const version of versions) {
      if (!version.isDirectory()) continue;
      const versionDir = path.join(platformDir, version.name);
      let endpoints: fs.Dirent[];
      try {
        endpoints = fs.readdirSync(versionDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const endpoint of endpoints) {
        if (!endpoint.isDirectory()) continue;
        const filePath = path.join(versionDir, endpoint.name, 'zcode-builtin.json');
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && (!newest || stat.mtimeMs > newest.mtimeMs)) {
            newest = { filePath, mtimeMs: stat.mtimeMs };
          }
        } catch {
          // Missing catalog under this endpoint; keep scanning.
        }
      }
    }
  }

  return newest?.filePath ?? null;
}

/**
 * Resolves every provider-config path for one engine install.
 *
 * Consumers: `resolveZCodeProviderConfigEnv` and the models provider.
 */
export function resolveZCodeProviderConfigPaths(enginePath: string): ProviderConfigPaths {
  const personal = path.join(getZCodeStorageDir(), 'v2', 'provider_config.json');

  return {
    bundled: findZCodeBundledProviderConfig(enginePath),
    runtime: findZCodeRuntimeProviderConfig(),
    personal,
  };
}

/** The builtin catalog the engine runs on: the refreshed runtime copy, else the bundled one. */
function selectActiveBuiltinCatalog(paths: Pick<ProviderConfigPaths, 'bundled' | 'runtime'>): string | null {
  return paths.runtime ?? paths.bundled;
}

/**
 * Resolves the builtin catalog path this CloudCLI-spawned engine was handed as
 * `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (see {@link resolveZCodeProviderConfigEnv}).
 *
 * Consumer: zcode-protocol.client.ts (account-config sync), whose revision
 * tag must hash exactly the file the engine loaded.
 */
export function findActiveZCodeBuiltinConfig(enginePath: string): string | null {
  return selectActiveBuiltinCatalog(resolveZCodeProviderConfigPaths(enginePath));
}

/**
 * Computes the exact revision string expected by ZCode app-server's
 * `provider/updateAccountConfig` RPC
 * (`zcode-builtin:${revision}:${sha256(path.resolve(configPath))}`).
 * Returns null if the file cannot be read or is missing a valid revision.
 *
 * Consumer: {@link buildZCodeAccountSyncPayload}.
 */
export function resolveZCodeBuiltinRevision(builtinConfigPath: string): string | null {
  try {
    const parsed = readObjectRecord(JSON.parse(fs.readFileSync(builtinConfigPath, 'utf8')));
    const revision = parsed?.revision;
    if (typeof revision !== 'number' && typeof revision !== 'string') return null;
    const hash = crypto.createHash('sha256').update(path.resolve(builtinConfigPath)).digest('hex');
    return `zcode-builtin:${revision}:${hash}`;
  } catch {
    return null;
  }
}

/**
 * Builds the `provider/updateAccountConfig` payload for the available account
 * plans.
 *
 * In app-server mode, the engine starts fail-closed by marking all account
 * providers as `entitled: false`. A trial JWT entitles the start-plan (体验)
 * provider and an individual-plan API key entitles the individual provider in
 * the engine's executable registry view.
 *
 * The engine's registry takes an account provider's model list from
 * `builtinModelIds` in this payload, so the start plan also carries the pair
 * the ZCode App sends for the same account (captured from its log). The field
 * overlays — and so replaces — the static builtin list (GLM-5.3-Flash/
 * GLM-5.2/GLM-5-Turbo only), and without it a GLM-5.3 selection is rerouted
 * to the engine's default model. The individual plan's static list already
 * matches the picker, so it stays access-only.
 *
 * Returns null when neither credential is stored or the built-in config is unavailable.
 *
 * Consumer: zcode-protocol.client.ts.
 */
export function buildZCodeAccountSyncPayload(builtinConfigPath: string): Record<string, unknown> | null {
  const jwtToken = readDecryptedZCodeJwtToken();
  const individualApiKey = readDecryptedZCodeIndividualPlanApiKey();
  if (!jwtToken && !individualApiKey) return null;

  const basedOnZCodeBuiltinRevision = resolveZCodeBuiltinRevision(builtinConfigPath);
  if (!basedOnZCodeBuiltinRevision) return null;

  // Literal ids on purpose: zcode-models.provider.ts imports this module, so
  // importing its constants back would form a cycle.
  const entitledProviderIds = [
    ...(jwtToken ? ['account:bigmodel-start-plan'] : []),
    ...(individualApiKey ? ['account:bigmodel-individual-coding-plan'] : []),
  ];
  return {
    revision: '1',
    basedOnZCodeBuiltinRevision,
    providers: Object.fromEntries(entitledProviderIds.map((providerId) => [providerId, {
      access: { type: 'zhipu-account', entitled: true },
      ...(providerId === 'account:bigmodel-start-plan' ? { builtinModelIds: ['GLM-5.3-Flash', 'GLM-5.3'] } : {}),
    }])),
    states: Object.fromEntries(entitledProviderIds.map((providerId) => [providerId, {
      availability: 'available', entitled: true, current: true,
    }])),
  };
}

/**
 * Builds the provider-config environment variables for an engine spawn.
 *
 * `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` prefers the refreshed runtime catalog
 * (what the engine would itself refresh) and falls back to the bundled copy,
 * which is what makes a bare spawn resolve providers at all.
 *
 * Consumers: `zcode-engine-supervisor.ts` (the default spawn wrapper).
 */
export function resolveZCodeProviderConfigEnv(enginePath: string): Record<string, string> {
  const { bundled, runtime, personal } = resolveZCodeProviderConfigPaths(enginePath);
  const env: Record<string, string> = {};

  const activeCatalog = selectActiveBuiltinCatalog({ bundled, runtime });
  // Without a built-in catalog the engine's own resolution is the only one
  // that can work; injecting partial overrides would hide its own error.
  if (!activeCatalog) return env;

  env[ZCODE_BUILTIN_PROVIDER_CONFIG_ENV] = activeCatalog;
  if (bundled) {
    env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_ENV] = bundled;
  }
  const personalConfig = materializeCloudCliProviderConfig(getZCodeStorageDir()) ?? personal;
  if (personalConfig) {
    env[ZCODE_PERSONAL_PROVIDER_CONFIG_ENV] = personalConfig;
  }

  return env;
}
