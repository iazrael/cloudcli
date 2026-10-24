/**
 * ZCode Provider Config Location
 *
 * The embedded CLI locates its built-in provider config by walking five levels
 * up from its own entry file. That assumption holds for ZCode's source layout
 * but not for the packaged app, where `Resources/glm/zcode.cjs` walks up to the
 * filesystem root and the lookup dies with "无法定位 CLI ZCode Built-in Provider
 * Config" before the app-server ever starts.
 *
 * The engine short-circuits that whole derivation when both
 * `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
 * are set, so we resolve the packaged locations ourselves and hand them over.
 *
 * @module zcode-provider-config
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readObjectRecord, readOptionalString, readTrimmedStringRecord } from '@/shared/utils.js';
import type { AnyRecord } from '@/shared/types.js';

import { readDecryptedZCodeIndividualPlanApiKey } from './zcode-credentials.js';
import { getZCodeStorageDir } from './zcode-data-root.js';

/**
 * Engine env override names, exported so the supervisor can strip ambient
 * values inherited from a parent ZCode App session before merging its own
 * resolution (see {@link resolveZCodeProviderConfigEnv}).
 *
 * Consumers: zcode-engine-supervisor.ts and the provider-config tests.
 */
export const ZCODE_BUILTIN_PROVIDER_CONFIG_ENV = 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE';
export const ZCODE_PERSONAL_PROVIDER_CONFIG_ENV = 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE';

const BUILTIN_CONFIG_ENV = ZCODE_BUILTIN_PROVIDER_CONFIG_ENV;
const PERSONAL_CONFIG_ENV = ZCODE_PERSONAL_PROVIDER_CONFIG_ENV;

const BUILTIN_CONFIG_FILE = 'zcode-builtin.json';
const CLOUDCLI_PERSONAL_CONFIG_FILE = 'cloudcli-provider-config.json';

/**
 * Maps the provider kinds stored in `cli/config.json` onto the API protocol
 * names accepted by ZCode 0.16.9's registry. The registry materializer and
 * send-model builder share it so an unsupported provider cannot be registered
 * under one protocol and executed under another.
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

function splitModelRef(value: string): { providerId?: string; modelId: string } {
  const slashIndex = value.indexOf('/');
  if (slashIndex < 0) return { modelId: value };
  return {
    providerId: value.slice(0, slashIndex).trim(),
    modelId: value.slice(slashIndex + 1).trim(),
  };
}

/**
 * Converts ZCode's user-facing `cli/config.json` provider definitions into
 * the strict personal-provider registry consumed by app-server 0.16.9.
 *
 * The generated file is CloudCLI-owned and separate from ZCode's own
 * `v2/provider_config.json`; consumers are the engine supervisor through
 * {@link resolveZCodeProviderConfigEnv}. Returns null when there is no usable
 * legacy provider, allowing native ZCode configuration to remain authoritative.
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
 * Built-in config locations relative to the engine's own directory, in the
 * engine's own preference order: its co-located `provider/` directory first,
 * then the packaged `Resources/config/` sibling, then the source-layout path
 * the engine itself attempts.
 */
const BUILTIN_RELATIVE_CANDIDATES = [
  path.join('provider', BUILTIN_CONFIG_FILE),
  path.join('..', 'config', 'provider', BUILTIN_CONFIG_FILE),
  path.join('..', '..', '..', '..', '..', 'config', 'provider', BUILTIN_CONFIG_FILE),
];

export function findBuiltinConfig(enginePath: string): string | null {
  const engineDir = path.dirname(path.resolve(enginePath));
  for (const relative of BUILTIN_RELATIVE_CANDIDATES) {
    const candidate = path.resolve(engineDir, relative);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Candidate absent; try the next layout.
    }
  }
  return null;
}

/**
 * Computes the exact revision string expected by ZCode app-server's
 * `provider/updateAccountConfig` RPC (`zcode-builtin:${revision}:${sha256(path.resolve(configPath))}`).
 * Returns null if the file cannot be read or is missing a valid revision.
 */
export function resolveZCodeBuiltinRevision(builtinConfigPath: string): string | null {
  try {
    const raw = fs.readFileSync(builtinConfigPath, 'utf8');
    const parsed = readObjectRecord(JSON.parse(raw));
    const revision = parsed?.revision;
    if (typeof revision !== 'number' && typeof revision !== 'string') return null;
    const resolvedPath = path.resolve(builtinConfigPath);
    const hash = crypto.createHash('sha256').update(resolvedPath).digest('hex');
    return `zcode-builtin:${revision}:${hash}`;
  } catch {
    return null;
  }
}

/**
 * Builds the `provider/updateAccountConfig` payload for the individual plan.
 *
 * In app-server mode, the engine starts fail-closed by marking all account
 * providers as `entitled: false`. The individual-plan API key activates that
 * provider in the engine's executable registry view. The start-plan (体验)
 * group was removed from the model menu, so the trial JWT no longer entitles
 * anything here.
 *
 * Returns null when no individual-plan key is stored or the built-in config is unavailable.
 */
export function buildZCodeAccountSyncPayload(builtinConfigPath: string): Record<string, unknown> | null {
  const individualApiKey = readDecryptedZCodeIndividualPlanApiKey();
  if (!individualApiKey) return null;

  const basedOnZCodeBuiltinRevision = resolveZCodeBuiltinRevision(builtinConfigPath);
  if (!basedOnZCodeBuiltinRevision) return null;

  const entitledProviderIds = ['account:bigmodel-individual-coding-plan'];
  return {
    revision: '1',
    basedOnZCodeBuiltinRevision,
    providers: Object.fromEntries(entitledProviderIds.map((providerId) => [providerId, {
      access: { type: 'zhipu-account', entitled: true },
    }])),
    states: Object.fromEntries(entitledProviderIds.map((providerId) => [providerId, {
      availability: 'available', entitled: true, current: true,
    }])),
  };
}

/**
 * Resolves the provider-config environment overrides for an engine spawn.
 *
 * The result is authoritative for this CloudCLI-spawned engine: ambient
 * `ZCODE_*_PROVIDER_CONFIG_FILE` values inherited from a parent ZCode App
 * session are deliberately not honored (they point at the App's own runtime
 * files; forwarding them leaves the engine without CloudCLI's materialized
 * provider registry and every send fails with `provider_not_found`). The
 * supervisor strips them from the spawn environment entirely.
 *
 * Returns an empty record only when no built-in config can be found — in that
 * case the engine keeps its own resolution and its own error message, rather
 * than being handed a path that does not exist.
 *
 * Consumer: zcode-engine-supervisor.ts (spawn env).
 */
export function resolveZCodeProviderConfigEnv(enginePath: string): Record<string, string> {
  const builtinConfig = findBuiltinConfig(enginePath);
  if (!builtinConfig) return {};

  const storageDir = getZCodeStorageDir();
  return {
    [BUILTIN_CONFIG_ENV]: builtinConfig,
    [PERSONAL_CONFIG_ENV]:
      materializeCloudCliProviderConfig(storageDir)
      || path.join(storageDir, 'v2', 'provider_config.json'),
  };
}
