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

import { readZCodeIndividualPlanAuthContext, readDecryptedZCodeJwtToken } from './zcode-credentials.js';
import { getZCodeStorageDir } from './zcode-data-root.js';
import { tryResolveEnginePath } from './zcode-engine-path.js';

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

function findEngineBundledConfig(enginePath: string): string | null {
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

/** Cached builtin file revisions keyed by path with an mtime+size identity. */
const builtinRevisionCache = new Map<string, { key: string; revision: number | null }>();

/**
 * Numeric `revision` of a builtin config file, cached on mtime+size so the
 * per-send resolution does not re-parse the file. Null when unreadable or
 * non-numeric.
 */
function readBuiltinFileRevision(builtinPath: string): number | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(builtinPath);
  } catch {
    return null;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = builtinRevisionCache.get(builtinPath);
  if (cached?.key === key) return cached.revision;
  let revision: number | null = null;
  try {
    const raw = readObjectRecord(JSON.parse(fs.readFileSync(builtinPath, 'utf8')));
    const numeric = typeof raw?.revision === 'number'
      ? raw.revision
      : typeof raw?.revision === 'string' ? Number(raw.revision) : Number.NaN;
    revision = Number.isFinite(numeric) ? numeric : null;
  } catch {
    revision = null;
  }
  builtinRevisionCache.set(builtinPath, { key, revision });
  return revision;
}

/**
 * Newest runtime-synced builtin cache under
 * `<storage>/v2/runtime/provider/<platform>/<version>/endpoint-<hash>/zcode-builtin.json`.
 * The ZCode client refreshes these files from its remote catalog endpoint
 * without an app update, so they can lead the bundled file; unreadable or
 * revision-less entries are skipped and the highest revision wins.
 */
function findRuntimeBuiltinConfig(): string | null {
  const providerRoot = path.join(getZCodeStorageDir(), 'v2', 'runtime', 'provider');
  let platformEntries: fs.Dirent[];
  try {
    platformEntries = fs.readdirSync(providerRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { path: string; revision: number } | null = null;
  for (const platform of platformEntries) {
    if (!platform.isDirectory()) continue;
    const platformDir = path.join(providerRoot, platform.name);
    let versionEntries: fs.Dirent[];
    try {
      versionEntries = fs.readdirSync(platformDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versionEntries) {
      if (!version.isDirectory()) continue;
      const versionDir = path.join(platformDir, version.name);
      let endpointEntries: fs.Dirent[];
      try {
        endpointEntries = fs.readdirSync(versionDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const endpoint of endpointEntries) {
        if (!endpoint.isDirectory() || !endpoint.name.startsWith('endpoint-')) continue;
        const candidate = path.join(versionDir, endpoint.name, 'zcode-builtin.json');
        const revision = readBuiltinFileRevision(candidate);
        if (revision === null) continue;
        if (!best || revision > best.revision) best = { path: candidate, revision };
      }
    }
  }
  return best?.path ?? null;
}

/**
 * Resolves the builtin config every consumer shares: the runtime-synced cache
 * when it carries a higher revision than the engine-bundled file (the ZCode
 * App behaves the same way), the bundled file otherwise. Engine-spawn env,
 * template defaults, reasoning specs, the account sync revision and the plan
 * catalogs all read through this single resolution.
 */
export function findBuiltinConfig(enginePath: string): string | null {
  const bundledPath = findEngineBundledConfig(enginePath);
  const runtimePath = findRuntimeBuiltinConfig();
  const bundledRevision = bundledPath ? readBuiltinFileRevision(bundledPath) : null;
  const runtimeRevision = runtimePath ? readBuiltinFileRevision(runtimePath) : null;
  if (runtimePath && runtimeRevision !== null
    && (bundledRevision === null || runtimeRevision > bundledRevision)) {
    return runtimePath;
  }
  return bundledPath;
}

/** Cached builtin template state keyed by builtin file identity (path+mtime+size). */
type ZCodeBuiltinTemplateState = {
  /**
   * Per-template default model enablement. Null means the engine ships no
   * `templateModelRules` rows ("unknown", never "all off").
   */
  templateDefaults: Map<string, Map<string, boolean>> | null;
  /**
   * `modelRules` rows in file order. The engine ships its `.*` catch-all
   * first and narrower regex rows later, and later matches supersede earlier
   * ones, so resolution walks forward and keeps the last match. Regexes
   * compile the way the engine applies them — `^(?:pattern)$` anchored,
   * case-insensitive. Rows carry either (or both) of the reasoningLevel
   * values and the per-model contextWindow; invalid regexes never match.
   */
  reasoningSpecs: { regex: RegExp | null; values: string[]; contextWindow: number | null }[];
  /**
   * Per-provider `builtinModelIds` from `providerConfigRules.providerRules` —
   * the account plans' granted model catalogs, the same field the engine's
   * account registry consumes. Null when the file ships no provider rules
   * ("unknown", never "empty").
   */
  planModelIds: Map<string, string[]> | null;
};
let builtinTemplateCache: { key: string; state: ZCodeBuiltinTemplateState } | null = null;

function readZCodeBuiltinTemplateState(): ZCodeBuiltinTemplateState | null {
  const enginePath = tryResolveEnginePath();
  if (!enginePath) return null;
  const builtinPath = findBuiltinConfig(enginePath);
  if (!builtinPath) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(builtinPath);
  } catch {
    return null;
  }
  const cacheKey = `${builtinPath}:${stat.mtimeMs}:${stat.size}`;
  if (builtinTemplateCache?.key === cacheKey) return builtinTemplateCache.state;

  try {
    const configBody = readObjectRecord(readObjectRecord(JSON.parse(fs.readFileSync(builtinPath, 'utf8')))?.config);
    const modelConfig = readObjectRecord(configBody?.modelConfigRules);
    if (!modelConfig) return null;

    // Provider rules carry the account plans' model catalogs; absent rules
    // mean "no knowledge" (the plan pair fallback applies downstream).
    const providerRules = Array.isArray(readObjectRecord(configBody?.providerConfigRules)?.providerRules)
      ? readObjectRecord(configBody?.providerConfigRules)?.providerRules as unknown[]
      : null;
    const planModelIds = new Map<string, string[]>();
    for (const entry of providerRules ?? []) {
      const record = readObjectRecord(entry);
      const providerId = readOptionalString(record?.providerId);
      if (!providerId) continue;
      const modelIds = (Array.isArray(readObjectRecord(record?.config)?.builtinModelIds)
        ? readObjectRecord(record?.config)?.builtinModelIds as unknown[]
        : [])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim());
      planModelIds.set(providerId, modelIds);
    }

    // Absent rows (older engine layouts) mean "no knowledge", not "all off".
    const templateRows = Array.isArray(modelConfig.templateModelRules)
      ? modelConfig.templateModelRules as unknown[]
      : null;
    const defaults = new Map<string, Map<string, boolean>>();
    for (const entry of templateRows ?? []) {
      const record = readObjectRecord(entry);
      const templateId = readOptionalString(record?.templateId);
      const modelId = readOptionalString(record?.modelId);
      if (!templateId || !modelId) continue;
      const models = defaults.get(templateId) ?? new Map<string, boolean>();
      models.set(modelId, readObjectRecord(record?.config)?.enabled !== false);
      defaults.set(templateId, models);
    }

    const reasoningSpecs: ZCodeBuiltinTemplateState['reasoningSpecs'] = [];
    for (const entry of Array.isArray(modelConfig.modelRules) ? modelConfig.modelRules as unknown[] : []) {
      const record = readObjectRecord(entry);
      const pattern = readOptionalString(record?.modelMatch);
      if (!pattern) continue;
      const spec = readObjectRecord(readObjectRecord(record?.config)?.optionSpecs)?.reasoningLevel;
      const values = (Array.isArray(readObjectRecord(spec)?.values) ? readObjectRecord(spec)?.values as unknown[] : [])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim().toLowerCase());
      const rawContextWindow = readObjectRecord(readObjectRecord(record?.config)?.properties)?.contextWindow;
      const contextWindow = typeof rawContextWindow === 'number' && Number.isFinite(rawContextWindow) && rawContextWindow > 0
        ? rawContextWindow
        : null;
      if (values.length === 0 && contextWindow === null) continue;
      // The engine compiles these patterns as `^(?:pattern)$` with the /i
      // flag when applying them, so uppercase ids like GLM-5.4 hit the
      // lowercase rows and non-wrapped patterns stay anchored.
      let regex: RegExp | null = null;
      try {
        regex = new RegExp(`^(?:${pattern})$`, 'i');
      } catch {
        // Unusable pattern: this row never matches.
      }
      reasoningSpecs.push({ regex, values, contextWindow });
    }

    const state: ZCodeBuiltinTemplateState = {
      templateDefaults: templateRows ? defaults : null,
      reasoningSpecs,
      planModelIds: providerRules ? planModelIds : null,
    };
    builtinTemplateCache = { key: cacheKey, state };
    return state;
  } catch {
    return null;
  }
}

/**
 * The engine builtin config's `templateModelRules` rows: per-template default
 * model enablement that the ZCode App applies unless the user stored a
 * deviation in `v2/provider_config.json`. The App model page shows exactly
 * this overlay, so the CloudCLI catalog mirrors it from the same source.
 * Returns null when the engine, its builtin config or the rows are
 * unavailable, letting callers fall back to permissive listing (better to
 * over-list than to silently hide everything).
 *
 * Consumer: `readNativePersonalProviderRules` in zcode-models.provider.ts.
 */
export function readZCodeTemplateModelDefaults(): Map<string, Map<string, boolean>> | null {
  return readZCodeBuiltinTemplateState()?.templateDefaults ?? null;
}

/**
 * The individual coding plan's granted models: `builtinModelIds` of the
 * `account:bigmodel-individual-coding-plan` rule in the resolved builtin
 * config (runtime-synced cache first, engine-bundled file second). Null when
 * the builtin file or its provider rules are unavailable, or the rule lists
 * no models (more likely bad data than a plan that grants nothing) — callers
 * fall back to the pinned plan pair rather than hiding the whole plan.
 *
 * Consumer: `getPersonalPlanModelIds` in zcode-models.provider.ts.
 */
export function readZCodeIndividualPlanModelIds(): Set<string> | null {
  const ids = readZCodeBuiltinTemplateState()
    ?.planModelIds
    ?.get('account:bigmodel-individual-coding-plan');
  if (!ids || ids.length === 0) return null;
  const set = new Set(ids);
  return set.size > 0 ? set : null;
}

/**
 * Effective reasoningLevel values for a model id: the values of the LAST
 * builtin `modelRules` row whose pattern matches it (the engine ships the
 * `.*` catch-all first, matching anchored and case-insensitively). Rows
 * without reasoning values cannot mask an earlier row's spec. Null when
 * nothing matches or the builtin config is unavailable — callers must not
 * invent a level then. The engine rejects sends without
 * `options.reasoningLevel` for models that ship a non-empty spec
 * ("Reasoning level is required for <provider>/<model>"), so this feeds both
 * the menu effort and the send-time default.
 *
 * Consumers: native catalog entries and native send defaults in
 * zcode-models.provider.ts.
 */
export function readZCodeModelReasoningValues(modelId: string): string[] | null {
  const specs = readZCodeBuiltinTemplateState()?.reasoningSpecs;
  if (!specs?.length) return null;
  let matched: string[] | null = null;
  for (const spec of specs) {
    if (spec.values.length === 0) continue;
    if (spec.regex?.test(modelId)) matched = spec.values;
  }
  return matched;
}

/**
 * Context window for a model id: `properties.contextWindow` of the LAST
 * builtin `modelRules` row whose pattern matches it — the same per-model
 * metadata the engine applies. Null when no row carries one or the builtin
 * config is unavailable; callers fall back to their own default window.
 *
 * Consumer: `readZCodeModelContextLimit` in zcode-models.provider.ts.
 */
export function readZCodeModelContextWindow(modelId: string): number | null {
  const specs = readZCodeBuiltinTemplateState()?.reasoningSpecs;
  if (!specs?.length) return null;
  let matched: number | null = null;
  for (const spec of specs) {
    if (spec.contextWindow === null) continue;
    if (spec.regex?.test(modelId)) matched = spec.contextWindow;
  }
  return matched;
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
 * Builds the `provider/updateAccountConfig` payload for the available account
 * plans.
 *
 * In app-server mode, the engine starts fail-closed by marking all account
 * providers as `entitled: false`. A trial JWT entitles the start-plan (体验)
 * provider and usable personal-project credentials (or a legacy API key) entitle the individual provider in
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
 */
export function buildZCodeAccountSyncPayload(builtinConfigPath: string): Record<string, unknown> | null {
  const jwtToken = readDecryptedZCodeJwtToken();
  const individual = readZCodeIndividualPlanAuthContext();
  const hasIndividualCredential = individual && individual.kind !== 'unavailable';
  if (!jwtToken && !hasIndividualCredential) return null;

  const basedOnZCodeBuiltinRevision = resolveZCodeBuiltinRevision(builtinConfigPath);
  if (!basedOnZCodeBuiltinRevision) return null;

  // Literal ids on purpose: zcode-models.provider.ts imports this module, so
  // importing its constants back would form a cycle.
  const entitledProviderIds = [
    ...(jwtToken ? ['account:bigmodel-start-plan'] : []),
    ...(hasIndividualCredential ? ['account:bigmodel-individual-coding-plan'] : []),
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
