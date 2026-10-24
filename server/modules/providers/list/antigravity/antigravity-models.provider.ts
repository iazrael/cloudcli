/**
 * Antigravity Models Provider
 *
 * Implements IProviderModels for the Antigravity CLI (agy).
 * Provides the supported model catalog (with effort levels) and active model
 * resolution. Both the builtin fallback and the `agy models` output are
 * collapsed into base models whose effort tiers ride on the Reasoning picker
 * (see antigravity-model-effort).
 *
 * @module antigravity-models.provider
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import type { StaleWhileRefreshValue } from '@/shared/utils.js';
import {
  buildDefaultProviderCurrentActiveModel,
  createStaleWhileRefreshValue,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

import { getAntigravitySettingsPath } from './antigravity-data-root.js';
import { tryResolveEnginePath } from './antigravity-engine-path.js';
import {
  dedupeAntigravityVariantModels,
  findCatalogOptionForModelString,
  splitModelEffortSuffix,
  type AntigravityRawModelEntry,
} from './antigravity-model-effort.js';

const execFileAsync = promisify(execFile);

/**
 * Builtin raw model rows mirroring `agy models` output, used verbatim as the
 * fallback catalog when the CLI cannot be queried. Variant families with two
 * or more tiers collapse into base models at load time, so the picker lists
 * one entry per adjustable model with its Reasoning tiers; single-variant
 * rows (gpt-oss-120b-medium) and claude passthroughs keep their original id
 * and label with no Reasoning options. Only the first row of each collapsed
 * family carries a description; it becomes the base model's description.
 */
const ANTIGRAVITY_BUILTIN_RAW_MODELS: AntigravityRawModelEntry[] = [
  { value: "gemini-4-argon-high", label: "Gemini 4 Argon (High)", description: "Google Gemini 4 Argon" },
  { value: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
  { value: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
  { value: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", description: "Google Gemini 3.8 Flash" },
  { value: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { value: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { value: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)", description: "Anthropic Claude Opus 5.5 with maximum reasoning capability" },
  { value: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)" },
  { value: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
  { value: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)", description: "Anthropic Claude Sonnet 5.5 with extended thinking" },
  { value: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
  { value: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
  { value: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

/** Catalog default, kept identical in the builtin and dynamic paths. */
const DEFAULT_BASE_MODEL = 'gemini-4-argon';

/**
 * Builtin fallback model definitions when `agy models` cannot be queried.
 */
export const ANTIGRAVITY_BUILTIN_MODELS: ProviderModelsDefinition = {
  OPTIONS: dedupeAntigravityVariantModels(ANTIGRAVITY_BUILTIN_RAW_MODELS),
  DEFAULT: DEFAULT_BASE_MODEL,
};

/**
 * Fetches available models dynamically by invoking `agy models`.
 */
async function fetchModelsFromCli(): Promise<ProviderModelsDefinition | null> {
  const enginePath = tryResolveEnginePath();
  if (!enginePath) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(enginePath, ['models'], {
      encoding: 'utf8',
      // A healthy `agy models` takes ~5s cold (token refresh included);
      // leave headroom so a cold start is not misread as a dead CLI.
      timeout: 15000,
    });

    const entries: AntigravityRawModelEntry[] = [];

    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Fetching')) {
        continue;
      }

      // Format is `<modelId>\t<Label>` or `<modelId>   <Label>`
      const parts = trimmed.split(/\t+|\s{2,}/);
      const value = parts[0]?.trim() || '';
      if (!value) {
        continue;
      }

      entries.push({
        value,
        label: parts.length >= 2 ? (parts[1]?.trim() || value) : value,
      });
    }

    if (entries.length > 0) {
      const options = dedupeAntigravityVariantModels(entries).map((option) => ({
        ...option,
        description: option.description ?? `${option.label} via Google Antigravity CLI`,
      }));

      const defaultModel = options.find((o) => o.value === DEFAULT_BASE_MODEL)?.value
        ?? options[0]?.value
        ?? DEFAULT_BASE_MODEL;

      return {
        OPTIONS: options,
        DEFAULT: defaultModel,
      };
    }
  } catch {
    // Dynamic query failed, fall back to builtin models
  }

  return null;
}

/**
 * Reads user's default model setting from the agy data root's `settings.json`.
 */
function readDefaultModelFromSettings(): string | null {
  try {
    const settingsPath = getAntigravitySettingsPath();
    if (!fs.existsSync(settingsPath)) {
      return null;
    }

    const content = fs.readFileSync(settingsPath, 'utf8');
    const settings = readObjectRecord(JSON.parse(content));
    return readOptionalString(settings?.model) ?? null;
  } catch {
    return null;
  }
}

export class AntigravityProviderModels implements IProviderModels {
  /**
   * Every turn reads the catalog before spawning agy, and `agy models` takes
   * seconds (or hangs to its timeout), so only the first read waits on it; an
   * expired catalog keeps serving while it is re-queried.
   */
  private readonly catalog: StaleWhileRefreshValue<ProviderModelsDefinition>;

  /**
   * @param fallbackTtlMs How long the builtin fallback stays fresh. Unlike a
   *   healthy CLI result it expires fast: the builtin list is a stopgap that
   *   goes stale, so `agy models` is asked again soon instead of after the
   *   full five-minute window.
   */
  constructor(fallbackTtlMs: number = 10_000) {
    this.catalog = createStaleWhileRefreshValue<ProviderModelsDefinition>({
      load: async () => (await fetchModelsFromCli()) ?? ANTIGRAVITY_BUILTIN_MODELS,
      ttlMs: (models) => (models === ANTIGRAVITY_BUILTIN_MODELS ? fallbackTtlMs : 5 * 60 * 1000),
      // The load falls back instead of rejecting; this only covers a bug in it.
      failureRetryMs: fallbackTtlMs,
      onRefreshError: (error) => console.error('[Antigravity] Model catalog refresh failed:', error),
    });
  }

  /**
   * Returns supported Antigravity models, dynamically loaded or from builtin defaults.
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return this.catalog.get();
  }

  /**
   * Returns the current active model for a session or default.
   *
   * Session-scoped model memory is owned by providerModelsService
   * (setSessionModel / resolveResumeModel) on the chat path; this facet only
   * reports the settings.json default or the catalog default. agy stores a
   * suffixed id — or, when the model was picked in agy's own menu, a display
   * label — in settings.json; both normalize onto the base-model catalog so a
   * label never enters the session model chain (a label is invisible to the
   * spawn-time catalog lookup and would combine with --effort into an
   * argument pair the CLI rejects).
   */
  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    const catalog = await this.getSupportedModels();
    const settingsModel = readDefaultModelFromSettings();
    if (settingsModel) {
      // A label's tier qualifier is dropped here on purpose: this value only
      // seeds the composer's base-model picker, and the Reasoning menu owns
      // the effort choice from there.
      const normalized = findCatalogOptionForModelString(settingsModel, catalog.OPTIONS)?.option.value
        ?? splitModelEffortSuffix(settingsModel).base;
      return { model: normalized };
    }

    return buildDefaultProviderCurrentActiveModel(catalog);
  }

  /**
   * Clears the models cache.
   */
  clearCache(): void {
    this.catalog.clear();
  }
}
