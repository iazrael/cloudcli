import fsSync from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';
import { getZCodeDatabasePath, getZCodeStorageDir } from './zcode-data-root.js';
import { tryResolveEnginePath } from './zcode-engine-path.js';
import { protocolClient } from './zcode-protocol.client.js';

/**
 * ZCode builtin models definition as fallback when config read fails.
 * Based on integration plan §3.2.5 and spike findings (GLM-5.3 with 1M context, 128K output).
 */
/**
 * Static fallback catalog used when the engine's model config cannot be read.
 * Exported for the capability tests: the capability catalog's defaultModel is
 * pinned to this definition's DEFAULT.
 */
export const ZCODE_BUILTIN_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'GLM-5.3',
      label: 'GLM-5.3',
      description: 'ZCode default model with 1M context window and 128K output tokens',
      effort: {
        default: 'max',
        values: [
          { value: 'low', description: 'Faster, less detailed reasoning' },
          { value: 'high', description: 'Balanced reasoning for most tasks' },
          { value: 'max', description: 'Maximum reasoning for complex tasks' },
        ],
      },
    },
  ],
  DEFAULT: 'GLM-5.3',
};

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: 'Faster, less detailed reasoning',
  high: 'Balanced reasoning for most tasks',
  max: 'Maximum reasoning for complex tasks',
};

/**
 * Reads ZCode's user-facing provider config to extract model definitions.
 * 0.16.9 stores the active catalog in `cli/config.json`; the v2 path is
 * retained as a fallback for installations that have not rewritten it yet.
 */
const readZCodeModelConfig = async (): Promise<ProviderModelsDefinition> => {
  try {
    let config: AnyRecord | null = null;
    for (const configPath of [
      path.join(getZCodeStorageDir(), 'cli', 'config.json'),
      path.join(getZCodeStorageDir(), 'v2', 'config.json'),
    ]) {
      try {
        config = readObjectRecord(JSON.parse(await readFile(configPath, 'utf8')));
        if (readObjectRecord(config?.provider)) break;
      } catch {
        // Try the next supported config location.
      }
    }

    if (!config) {
      return ZCODE_BUILTIN_MODELS;
    }

    const providers = readObjectRecord(config.provider);
    if (!providers) {
      return ZCODE_BUILTIN_MODELS;
    }

    const modelOptions: ProviderModelOption[] = [];
    const seenModelKeys = new Set<string>();

    for (const providerConfig of Object.values(providers)) {
      const providerRecord = readObjectRecord(providerConfig);
      // Skip explicitly disabled providers
      if (providerRecord?.enabled === false) continue;

      const models = readObjectRecord(providerRecord?.models);
      if (!models) continue;

      for (const [modelKey, modelConfig] of Object.entries(models)) {
        if (seenModelKeys.has(modelKey)) continue;

        const modelRecord = readObjectRecord(modelConfig);
        if (!modelRecord) continue;

        seenModelKeys.add(modelKey);

        const reasoning = readObjectRecord(modelRecord.reasoning);
        const variants = Array.isArray(reasoning?.levels) ? reasoning.levels : reasoning?.variants;
        const hasReasoning = Array.isArray(variants) && variants.length > 0;

        const limits = readObjectRecord(modelRecord.limit);
        const contextLimit = limits?.context;
        const outputLimit = limits?.output;

        const limitDescriptions: string[] = [];
        if (typeof contextLimit === 'number') {
          limitDescriptions.push(`${(contextLimit / 1000).toFixed(0)}K context`);
        }
        if (typeof outputLimit === 'number') {
          limitDescriptions.push(`${(outputLimit / 1000).toFixed(0)}K output`);
        }

        const description = limitDescriptions.length > 0
          ? `ZCode model with ${limitDescriptions.join(', ')}`
          : `ZCode ${modelKey} model`;

        let effort: ProviderModelOption['effort'] | undefined;
        if (hasReasoning && Array.isArray(variants)) {
          const sortedVariants = variants
            .filter((variant): variant is string => typeof variant === 'string' && variant.trim().length > 0)
            .map((variant) => variant.trim().toLowerCase())
            .sort();
          effort = {
            default: readOptionalString(reasoning?.defaultLevel)?.toLowerCase() ?? 'max',
            values: sortedVariants.map((variant: string) => {
              const normalized = variant.toLowerCase();
              return {
                value: normalized,
                description: EFFORT_DESCRIPTIONS[normalized] || `${normalized} reasoning level`,
              };
            }),
          };
        }

        modelOptions.push({
          value: modelKey,
          label: modelKey,
          description: readOptionalString(modelRecord.description) || description,
          effort: hasReasoning ? effort : undefined,
        });
      }
    }

    if (modelOptions.length === 0) {
      return ZCODE_BUILTIN_MODELS;
    }

    return {
      OPTIONS: modelOptions,
      DEFAULT: modelOptions[0]?.value ?? 'GLM-5.3',
    };
  } catch {
    // Config read failed, return builtin models
    return ZCODE_BUILTIN_MODELS;
  }
};

/**
 * Default reasoning level per `providerId/modelId`, captured from the engine's
 * resolved catalog. `session/setModel` rejects a model that declares reasoning
 * levels unless one is supplied, so the runtime reads it from here when the
 * user did not pick an explicit effort.
 */
let engineReasoningDefaults = new Map<string, string>();

/**
 * Context window per `providerId/modelId`, captured from the engine's resolved
 * catalog (`settings.model.available[].contextWindow`). The engine resolves
 * every provider it can run — including user-added ones that never appear in
 * `v2/config.json`, which is where a session's own model key gets its window
 * from (`resolveZCodeModelContextWindow`).
 *
 * Consumers: `resolveZCodeModelContextWindow` (zcode context-usage reader).
 */
let engineContextWindows = new Map<string, number>();

/** In-flight/settled engine catalog load, shared across providers and runs. */
let engineCatalogPromise: Promise<ProviderModelsDefinition | null> | null = null;

/**
 * Maps an engine `session/create` (or `session/resume`) response into CloudCLI's
 * model catalog.
 *
 * The engine resolves every provider from its own builtin + personal config,
 * including user-added providers that never appear in `v2/config.json`, and
 * returns them on the session settings as `settings.model.available`. Values
 * are emitted as `providerId/modelId` so a bare model id shared by multiple
 * providers stays unambiguous.
 *
 * Consumers: `loadEngineModelCatalog`, `PrimeZCodeModelCatalog`, and
 * `ingestZCodeModelCatalog` (the runtime seeds it from responses it already
 * has, avoiding a redundant create).
 */
function mapEngineModelCatalog(result: AnyRecord | undefined | null): ProviderModelsDefinition | null {
  const settings = readObjectRecord(result?.settings);
  const modelSection = readObjectRecord(settings?.model);
  const available = modelSection?.available;
  if (!Array.isArray(available) || available.length === 0) {
    return null;
  }

  const options: ProviderModelOption[] = [];
  const reasoningDefaults = new Map<string, string>();
  const contextWindows = new Map<string, number>();
  const seenValues = new Set<string>();

  for (const entry of available) {
    const entryRecord = readObjectRecord(entry);
    const ref = readObjectRecord(entryRecord?.ref);
    const providerId = readOptionalString(ref?.providerId);
    const modelId = readOptionalString(ref?.modelId);
    if (!providerId || !modelId) continue;

    const value = `${providerId}/${modelId}`;
    if (seenValues.has(value)) continue;
    seenValues.add(value);

    const reasoning = readObjectRecord(entryRecord?.reasoning);
    const effortValues: { value: string; description: string }[] = [];
    if (Array.isArray(reasoning?.levels)) {
      for (const level of reasoning.levels) {
        const levelRecord = readObjectRecord(level);
        const levelValue = readOptionalString(levelRecord?.value);
        if (!levelValue) continue;
        effortValues.push({
          value: levelValue,
          description: readOptionalString(levelRecord?.label) ?? levelValue,
        });
      }
    }

    const defaultLevel = readOptionalString(reasoning?.defaultLevel)
      ?? effortValues[effortValues.length - 1]?.value;
    if (defaultLevel) {
      reasoningDefaults.set(value, defaultLevel);
    }

    const contextWindow = typeof entryRecord?.contextWindow === 'number' ? entryRecord.contextWindow : undefined;
    const maxOutputTokens = typeof entryRecord?.maxOutputTokens === 'number' ? entryRecord.maxOutputTokens : undefined;
    const providerLabel = readOptionalString(entryRecord?.providerLabel);
    if (contextWindow && contextWindow > 0) {
      contextWindows.set(value, contextWindow);
    }

    const descriptionParts: string[] = [];
    if (providerLabel) descriptionParts.push(providerLabel);
    if (contextWindow) descriptionParts.push(`${(contextWindow / 1000).toFixed(0)}K context`);
    if (maxOutputTokens) descriptionParts.push(`${(maxOutputTokens / 1000).toFixed(0)}K output`);

    options.push({
      value,
      label: readOptionalString(entryRecord?.label) ?? modelId,
      ...(descriptionParts.length > 0 ? { description: descriptionParts.join(' · ') } : {}),
      ...(effortValues.length > 0
        ? { effort: { default: defaultLevel, values: effortValues } }
        : {}),
    });
  }

  if (options.length === 0) {
    return null;
  }

  engineReasoningDefaults = reasoningDefaults;
  engineContextWindows = contextWindows;
  return { OPTIONS: options, DEFAULT: options[0].value };
}

/**
 * Seeds the shared reasoning-default map from a session response the runtime
 * already received.
 *
 * Consumer: `server/modules/providers/list/zcode/zcode-runtime.provider.ts`
 * (after `session/create` and `session/resume`), so `session/setModel` can
 * supply the required reasoning level without a second catalog request.
 */
export function ingestZCodeModelCatalog(result: AnyRecord | undefined | null): void {
  // Always re-map: the shared loader may have resolved to null before the
  // engine was reachable, and this response is a fresh, authoritative catalog.
  mapEngineModelCatalog(result);
}

/**
 * Loads the resolved model catalog from the engine.
 *
 * `session/create` is the only request that returns the workspace model
 * catalog (`settings.model.available`); the throwaway session is closed again
 * and never persists without a message. Returns null when the engine is not
 * installed or the response carries no catalog, so callers can fall back to
 * the on-disk config reader.
 *
 * Consumers: the `ZCodeProviderModels` default loader and
 * `primeZCodeModelCatalog`.
 */
async function loadEngineModelCatalog(): Promise<ProviderModelsDefinition | null> {
  if (!tryResolveEnginePath()) {
    return null;
  }

  try {
    const workspacePath = getZCodeStorageDir();
    const result = await protocolClient.sendRequest<AnyRecord>('session/create', {
      workspace: { workspacePath, workspaceKey: workspacePath },
    }, 15000);

    const sessionId = readOptionalString(readObjectRecord(result?.session)?.sessionId);
    if (sessionId) {
      try {
        await protocolClient.sendRequest('session/close', { sessionId }, 5000);
      } catch {
        // The throwaway session was never persisted; closing is best-effort.
      }
    }

    return mapEngineModelCatalog(result);
  } catch {
    return null;
  }
}

/**
 * Returns the shared engine catalog, loading it once per process.
 *
 * Consumers: `ZCodeProviderModels.getSupportedModels` (default loader) and
 * `resolveZCodeModelDefaultReasoningLevel` (runtime `session/setModel`).
 */
export function primeZCodeModelCatalog(): Promise<ProviderModelsDefinition | null> {
  if (!engineCatalogPromise) {
    engineCatalogPromise = loadEngineModelCatalog();
  }
  return engineCatalogPromise;
}

/**
 * Returns the engine default reasoning level for a model reference.
 *
 * Accepts the catalog value (`providerId/modelId`) or a bare model id; a bare
 * id only resolves when exactly one provider exposes it, mirroring
 * `canonicalizeProviderModel`. Consumers: the zcode runtime provider, which
 * must include a level on `session/setModel`.
 */
export function resolveZCodeModelDefaultReasoningLevel(modelKey: string): string | undefined {
  const normalized = modelKey.trim();
  if (!normalized) return undefined;

  const direct = engineReasoningDefaults.get(normalized);
  if (direct) return direct;

  const suffix = normalized.split('/').pop();
  if (!suffix) return undefined;

  let match: string | undefined;
  for (const [key, level] of engineReasoningDefaults) {
    if (key.split('/').pop() !== suffix) continue;
    if (match) return undefined; // Ambiguous across providers.
    match = level;
  }
  return match;
}

/**
 * Context window of one model, as the engine declared it.
 *
 * The engine-resolved catalog wins because it is the only source that knows
 * user-added providers (`opencode-go-chat/deepseek-v4.1-flash` never appears in
 * `v2/config.json`); the on-disk config is the fallback for a process that has
 * not resolved a catalog yet (a fresh server answering `/token-usage` before
 * the first models request or run).
 *
 * Consumer: the zcode context-usage reader, which needs a window to turn a
 * session's occupancy into a percentage.
 */
export function resolveZCodeModelContextWindow(modelKey: string): number | undefined {
  const normalized = modelKey.trim();
  if (!normalized) return undefined;

  const direct = engineContextWindows.get(normalized);
  if (direct) return direct;

  // Catalog values are `providerId/modelId`; a bare model id still resolves
  // when exactly one provider exposes it, mirroring the reasoning defaults.
  const suffix = normalized.split('/').pop();
  if (suffix) {
    let match: number | undefined;
    for (const [key, window] of engineContextWindows) {
      if (key.split('/').pop() !== suffix) continue;
      if (match) {
        match = undefined; // Ambiguous across providers.
        break;
      }
      match = window;
    }
    if (match) return match;
  }

  return readConfigContextWindow(suffix ?? normalized);
}

/**
 * Parsed `limit.context` per bare model id from ZCode's v2 config, memoized by
 * file identity. The editor and the CLI rewrite that file when providers
 * change, so identity (mtime + size) is what invalidates the parse — not a TTL.
 */
let configContextWindowCache: { key: string; windows: Map<string, number> } | null = null;

function readConfigContextWindow(modelId: string): number | undefined {
  const configPath = path.join(getZCodeStorageDir(), 'v2', 'config.json');
  let cacheKey: string;
  try {
    const stats = fsSync.statSync(configPath);
    cacheKey = `${configPath}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    return undefined;
  }

  if (configContextWindowCache?.key !== cacheKey) {
    try {
      const config = readObjectRecord(JSON.parse(fsSync.readFileSync(configPath, 'utf8')));
      const providers = readObjectRecord(config?.provider) ?? {};
      const windows = new Map<string, number>();
      for (const providerConfig of Object.values(providers)) {
        const models = readObjectRecord(readObjectRecord(providerConfig)?.models) ?? {};
        for (const [configModelId, modelConfig] of Object.entries(models)) {
          const contextLimit = readObjectRecord(readObjectRecord(modelConfig)?.limit)?.context;
          if (typeof contextLimit === 'number' && contextLimit > 0) {
            windows.set(configModelId, contextLimit);
          }
        }
      }
      configContextWindowCache = { key: cacheKey, windows };
    } catch {
      configContextWindowCache = null;
      return undefined;
    }
  }

  return configContextWindowCache?.windows.get(modelId);
}

/**
 * Reads the model a ZCode session last ran with from ZCode's own SQLite
 * store (most recent `message.data.modelID` per integration plan §3.2.5).
 *
 * Consumers: `ZCodeProviderModels.getCurrentActiveModel` (app session id
 * mapped to the provider id first) and the zcode runtime provider (which
 * already holds the provider session id and skips redundant `session/setModel`
 * calls when the requested model matches). Returns null when unknown.
 */
export function readZCodeSessionModelInfoFromDb(providerSessionId: string): { modelId: string; variant?: string } | null {
  const dbPath = getZCodeDatabasePath();

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const recentMessage = db
      .prepare(
        `SELECT data FROM message
         WHERE session_id = ?
         ORDER BY time_created DESC
         LIMIT 1`
      )
      .get(providerSessionId) as { data: string } | undefined;

    if (!recentMessage) {
      return null;
    }

    const messageData = readObjectRecord(JSON.parse(recentMessage.data));
    const modelRecord = readObjectRecord(messageData?.model);
    const modelId = readOptionalString(messageData?.modelID)
      || readOptionalString(modelRecord?.modelID)
      || readOptionalString(modelRecord?.modelId);

    if (!modelId) {
      return null;
    }

    const variant = readOptionalString(messageData?.variant)
      || readOptionalString(modelRecord?.variant);

    return {
      modelId,
      variant: variant || undefined,
    };
  } catch {
    // Database missing or unreadable - model unknown
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * Reads the model a ZCode session last ran with from ZCode's own SQLite
 * store (most recent `message.data.modelID` per integration plan §3.2.5).
 *
 * Consumers: `ZCodeProviderModels.getCurrentActiveModel` (app session id
 * mapped to the provider id first) and the zcode runtime provider (which
 * already holds the provider session id and skips redundant `session/setModel`
 * calls when the requested model matches). Returns null when unknown.
 */
export function readZCodeSessionModelFromDb(providerSessionId: string): string | null {
  return readZCodeSessionModelInfoFromDb(providerSessionId)?.modelId ?? null;
}

/**
 * Resolves a model name/key string into ZCode's protocol model object `{ providerId, modelId, variant? }`.
 *
 * Handles:
 * - Full model refs formatted as `providerId/modelId` (e.g. `builtin:bigmodel-coding-plan/GLM-5.3`)
 * - Bare model keys (e.g. `GLM-5.3`), by looking up the active/enabled provider from config or defaulting
 * - Optional reasoning effort variant (e.g. `low`, `medium`, `high`, `max`)
 *
 * Consumer: `server/modules/providers/list/zcode/zcode-runtime.provider.ts`
 */
export function resolveZCodeModelRef(
  modelKey: string,
  variant?: string,
): { providerId: string; modelId: string; variant?: string } {
  const trimmed = modelKey.trim();
  const trimmedVariant = variant && variant !== 'default' ? variant.trim() : undefined;
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex >= 0) {
    return {
      providerId: trimmed.slice(0, slashIndex).trim(),
      modelId: trimmed.slice(slashIndex + 1).trim(),
      ...(trimmedVariant ? { variant: trimmedVariant } : {}),
    };
  }

  // Look up enabled provider in config if possible. The app-server engine
  // resolves provider ids against its own cli/config.json, so that file is
  // consulted first; the App's v2 config only serves as a fallback because
  // its provider ids (builtin:*) may not exist in the engine's config.
  for (const configPath of [
    path.join(getZCodeStorageDir(), 'cli', 'config.json'),
    path.join(getZCodeStorageDir(), 'v2', 'config.json'),
  ]) {
    try {
      const content = fsSync.readFileSync(configPath, 'utf8');
      const config = readObjectRecord(JSON.parse(content));
      const providers = readObjectRecord(config?.provider);
      if (!providers) continue;
      for (const [providerId, providerConfig] of Object.entries(providers)) {
        const providerRecord = readObjectRecord(providerConfig);
        if (providerRecord?.enabled === false) continue;
        const models = readObjectRecord(providerRecord?.models);
        if (models && trimmed in models) {
          return {
            providerId,
            modelId: trimmed,
            ...(trimmedVariant ? { variant: trimmedVariant } : {}),
          };
        }
      }
      // Fallback: search even disabled providers if matching model
      for (const [providerId, providerConfig] of Object.entries(providers)) {
        const providerRecord = readObjectRecord(providerConfig);
        const models = readObjectRecord(providerRecord?.models);
        if (models && trimmed in models) {
          return {
            providerId,
            modelId: trimmed,
            ...(trimmedVariant ? { variant: trimmedVariant } : {}),
          };
        }
      }
    } catch {
      // Config read failed, try the next config source
    }
  }

  // Newer ZCode stores user-added providers in provider_config.json rather than
  // v2/config.json. Each provider rule lists every selectable model in
  // `modelOrder` (and the user's own additions in `personalModelIds`), which is
  // the only place a bare id like `deepseek-v4.1-flash` maps back to a provider.
  try {
    const personalPath = path.join(getZCodeStorageDir(), 'v2', 'provider_config.json');
    const personalConfig = readObjectRecord(JSON.parse(fsSync.readFileSync(personalPath, 'utf8')));
    const providerRules = readObjectRecord(personalConfig?.config)?.providerConfigRules;
    const rules = readObjectRecord(providerRules)?.providerRules;
    if (Array.isArray(rules)) {
      for (const rule of rules) {
        const ruleRecord = readObjectRecord(rule);
        const providerId = readOptionalString(ruleRecord?.providerId);
        const ruleConfig = readObjectRecord(ruleRecord?.config);
        if (!providerId || !ruleConfig) continue;

        const candidates = [
          ...(Array.isArray(ruleConfig.modelOrder) ? ruleConfig.modelOrder : []),
          ...(Array.isArray(ruleConfig.personalModelIds) ? ruleConfig.personalModelIds : []),
        ];
        if (candidates.some((candidate) => readOptionalString(candidate) === trimmed)) {
          return {
            providerId,
            modelId: trimmed,
            ...(trimmedVariant ? { variant: trimmedVariant } : {}),
          };
        }
      }
    }
  } catch {
    // Personal provider config missing or unreadable; fall through.
  }

  return {
    providerId: 'builtin:bigmodel-coding-plan',
    modelId: trimmed,
    ...(trimmedVariant ? { variant: trimmedVariant } : {}),
  };
}

/**
 * ZCode models provider implementing model catalog and active model detection.
 */
export class ZCodeProviderModels implements IProviderModels {
  private cachedModels: ProviderModelsDefinition | null = null;

  /**
   * @param loadEngineCatalog - Catalog loader override. Production reads the
   *   engine's resolved catalog (see `primeZCodeModelCatalog`); tests inject a
   *   stub to stay hermetic and exercise the on-disk fallback.
   */
  constructor(
    private readonly loadEngineCatalog: () => Promise<ProviderModelsDefinition | null> = primeZCodeModelCatalog,
  ) {}

  /**
   * Returns the engine-resolved catalog, falling back to the on-disk ZCode
   * config and finally the static builtin definition.
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    if (!this.cachedModels) {
      const engineCatalog = await this.loadEngineCatalog();
      this.cachedModels = engineCatalog ?? await readZCodeModelConfig();
    }
    return this.cachedModels;
  }

  /**
   * Returns the current active model for a session or default.
   *
   * The sessionId is the app-facing session id; it is mapped through the
   * sessions index to the ZCode-native session id before reading ZCode's
   * own database.
   */
  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (sessionId?.trim()) {
      const session = sessionsDb.getSessionById(sessionId);
      const providerSessionId = session ? readOptionalString(session.provider_session_id) : null;
      const modelInfo = providerSessionId
        ? readZCodeSessionModelInfoFromDb(providerSessionId)
        : null;

      if (modelInfo?.modelId) {
        if (session && !session.effort && modelInfo.variant) {
          sessionsDb.setSessionEffort(sessionId, modelInfo.variant);
        }
        return { model: modelInfo.modelId };
      }
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  /**
   * Clears the cached models.
   *
   * Consumer: `server/modules/providers/tests/zcode-models.test.ts`
   * (isolation between fixture config cases).
   */
  clearCache(): void {
    this.cachedModels = null;
  }
}
