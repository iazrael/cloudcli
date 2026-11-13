/**
 * Antigravity Model Effort Helpers
 *
 * The Antigravity CLI encodes reasoning effort as model-id suffixes: `agy
 * models` lists `gemini-3.7-flash-high/medium/low` as separate models and has
 * no bare `gemini-3.7-flash` id. To keep the picker a short base-model list
 * plus the shared Reasoning menu, variant families with two or more tiers are
 * collapsed into base models whose effort config carries
 * `encoding: 'model-suffix'`, and spawn-time arguments are re-expanded by
 * resolveAntigravityModelArgs. Models without adjustable tiers — single-
 * variant rows (gpt-oss-120b-medium), claude passthroughs, user-defined
 * custom models — carry no effort config, so the WebUI hides the Reasoning
 * menu for them and only `default` is ever sent.
 *
 * @module antigravity-model-effort
 */

import type { ProviderModelOption } from '@/shared/types.js';

/** Effort tiers agy appends to model ids, in display order (weakest first). */
export const ANTIGRAVITY_EFFORT_TIERS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Standard reasoning effort descriptions shared by all antigravity models.
 */
const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: 'Faster, less detailed reasoning',
  medium: 'Balanced reasoning for most tasks',
  high: 'Maximum depth reasoning for complex tasks',
  xhigh: 'Extra high depth reasoning for the hardest tasks',
  max: 'Unbounded reasoning depth for exhaustive analysis',
};

/** One `<modelId> <Label>` row as printed by `agy models`. */
export type AntigravityRawModelEntry = {
  value: string;
  label: string;
  description?: string;
};

/**
 * Tier set of one collapsed variant family: the tiers agy offers as id
 * suffixes and the tier used when no explicit effort was chosen.
 */
type AntigravityVariantFamily = {
  tiers: string[];
  default: string;
};

const EFFORT_SUFFIX_PATTERN = /-(low|medium|high|xhigh|max)$/;
const LABEL_TIER_PATTERN = /\s*\((XHigh|Max|High|Medium|Low)\)\s*$/;

/**
 * Splits a trailing effort tier off a model id.
 *
 * `gemini-3.7-flash-medium` becomes `{ base: 'gemini-3.7-flash', effort:
 * 'medium' }`; ids without a tier suffix return the id unchanged and a null
 * effort. Ids that merely end in one of these words but are not agy variants
 * (e.g. gpt-oss-120b-medium) are treated as suffixed too — spawn-time
 * resolution keeps such ids verbatim, so they round-trip unchanged.
 */
export function splitModelEffortSuffix(modelId: string): { base: string; effort: string | null } {
  const effort = modelId.match(EFFORT_SUFFIX_PATTERN)?.[1] ?? null;
  return { base: effort ? modelId.replace(EFFORT_SUFFIX_PATTERN, '') : modelId, effort };
}

/**
 * Strips a trailing "(High)"-style tier qualifier from a display label.
 * Unrelated qualifiers such as "(Thinking)" are kept.
 */
export function stripEffortTierFromLabel(label: string): string {
  return label.replace(LABEL_TIER_PATTERN, '');
}

/**
 * Collapses suffixed model variants into base-model catalog options.
 *
 * Used by antigravity-models.provider for both the builtin fallback rows and
 * the dynamic `agy models` output.
 *
 * Entries whose id ends in an effort tier are grouped under their base id.
 * A family offering two or more tiers becomes one base-model option (label
 * and description from the first-seen variant, tier stripped from the label)
 * whose merged tier set rides on the `encoding: 'model-suffix'` effort
 * config. A single-variant family is a fixed-tier model, not an adjustable
 * one: the original row passes through verbatim with no effort config.
 * Entries without a tier suffix (claude passthroughs) also pass through
 * without effort config. Options keep first-appearance order.
 */
export function dedupeAntigravityVariantModels(
  entries: AntigravityRawModelEntry[],
): ProviderModelOption[] {
  type FamilyDraft = {
    base: string;
    label: string;
    description?: string;
    tiers: Set<string>;
    firstEntry: AntigravityRawModelEntry;
    firstSeen: number;
  };

  type Slot =
    | { firstSeen: number; family: FamilyDraft }
    | { firstSeen: number; option: ProviderModelOption };

  const familyByBase = new Map<string, FamilyDraft>();
  const slots: Slot[] = [];

  for (const entry of entries) {
    const { base, effort } = splitModelEffortSuffix(entry.value);
    if (!effort) {
      slots.push({
        firstSeen: slots.length,
        option: {
          value: entry.value,
          label: entry.label,
          description: entry.description,
        },
      });
      continue;
    }

    let draft = familyByBase.get(base);
    if (!draft) {
      draft = {
        base,
        label: stripEffortTierFromLabel(entry.label),
        description: entry.description,
        tiers: new Set<string>(),
        firstEntry: entry,
        firstSeen: slots.length,
      };
      familyByBase.set(base, draft);
      slots.push({ firstSeen: draft.firstSeen, family: draft });
    }
    draft.tiers.add(effort);
  }

  return slots
    .slice()
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .map((slot) => {
      if ('option' in slot) {
        return slot.option;
      }
      // A single variant is a fixed-tier model, not an adjustable one: keep
      // the original suffixed id and label with no Reasoning options.
      if (slot.family.tiers.size < 2) {
        const entry = slot.family.firstEntry;
        return {
          value: entry.value,
          label: entry.label,
          description: entry.description,
        } satisfies ProviderModelOption;
      }
      const tiers = ANTIGRAVITY_EFFORT_TIERS.filter((tier) => slot.family.tiers.has(tier));
      return {
        value: slot.family.base,
        label: slot.family.label,
        description: slot.family.description,
        effort: {
          default: defaultTierOf(tiers),
          values: tiers.map((tier) => ({ value: tier, description: EFFORT_DESCRIPTIONS[tier] })),
          encoding: 'model-suffix',
        },
      } satisfies ProviderModelOption;
    });
}

/** Picks the preferred default tier: high, then medium, then low. */
function defaultTierOf(tiers: string[]): string {
  return tiers.find((tier) => tier === 'high')
    ?? tiers.find((tier) => tier === 'medium')
    ?? tiers.find((tier) => tier === 'low')
    ?? 'high';
}

/**
 * Extracts the variant-family tier set from a catalog option, or null when
 * the model does not encode effort in its id (fixed-tier, passthrough, and
 * custom models).
 */
function extractVariantFamilyFromOption(
  option: ProviderModelOption | undefined,
): AntigravityVariantFamily | null {
  const effort = option?.effort;
  if (!effort || effort.encoding !== 'model-suffix' || effort.values.length === 0) {
    return null;
  }

  const tiers = effort.values.map((value) => value.value);
  return {
    tiers,
    default: effort.default && tiers.includes(effort.default)
      ? effort.default
      : tiers[tiers.length - 1],
  };
}

/** One resolved model string: its catalog entry plus any tier its label carries. */
export type CatalogOptionForModelString = {
  option: ProviderModelOption;
  /**
   * The trailing "(High)"-style tier of the raw string, lowercased — user
   * intent recorded by agy's own picker. Null for id-form strings and labels
   * without a tier qualifier; validity against the family is the caller's
   * concern (resolveAntigravityModelArgs snaps out-of-family tiers to the
   * default).
   */
  labelTier: string | null;
};

/**
 * Resolves one raw model string onto its merged-catalog option.
 *
 * agy's own model picker writes display labels (`Gemini 3.8 Flash (Medium)`)
 * into settings.json, and session rows created while such a default was
 * active store the label verbatim. Both must resolve back onto the catalog
 * before spawning: a label missed by the value lookup falls into the
 * custom-model branch, whose `--effort` flag the CLI rejects for
 * tier-qualified models, and non-family rows would spawn the label itself,
 * which no engine id matches.
 *
 * Resolution order: exact catalog id, suffixed id reduced to its base family,
 * then label match on the raw and the tier-stripped form (collapsed families
 * carry the stripped label, fixed-tier rows the verbatim one). Returns null
 * when nothing matches so custom models and unknown ids keep their existing
 * behavior.
 *
 * Consumers: antigravity-models.provider (settings default-model
 * normalization) and antigravity-runtime.provider (spawn-time catalog lookup).
 */
export function findCatalogOptionForModelString(
  raw: string,
  options: ProviderModelOption[],
): CatalogOptionForModelString | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const labelTier = trimmed.match(LABEL_TIER_PATTERN)?.[1]?.toLowerCase() ?? null;

  const byValue = options.find((option) => option.value === trimmed);
  if (byValue) {
    return { option: byValue, labelTier };
  }

  const byBase = options.find((option) => option.value === splitModelEffortSuffix(trimmed).base);
  if (byBase) {
    return { option: byBase, labelTier };
  }

  const strippedLabel = stripEffortTierFromLabel(trimmed);
  const byLabel = options.find((option) => option.label === trimmed || option.label === strippedLabel);
  return byLabel ? { option: byLabel, labelTier } : null;
}

/**
 * Resolves the `--model` / `--effort` arguments one agy run should spawn with.
 *
 * Used by antigravity-runtime.provider when building the CLI argument list;
 * `catalogOption` is the merged-catalog entry for the model, located by
 * findCatalogOptionForModelString (id, legacy suffixed id, or display label).
 *
 * Rules:
 * - A model backed by a variant family runs as `<catalog value>-<tier>`: the
 *   chosen tier when valid, otherwise the tier embedded in a legacy suffixed
 *   id, otherwise the family default — the `--effort` flag is never combined
 *   with a suffixed id because the CLI rejects the run. The id is always
 *   built from the catalog value, never from the raw string, so label-form
 *   rows resolve onto the real id instead of concatenating onto the label.
 * - A cataloged model without effort support (claude passthroughs, the
 *   fixed-tier gpt-oss-120b-medium) runs with its catalog id; a stale effort
 *   choice is dropped and no model id is ever invented. Label-form rows land
 *   here too, so the catalog value — never the raw string — is what spawns.
 * - A model absent from the catalog (user-defined custom models) keeps its
 *   id and receives `--effort` when a valid tier was requested.
 */
export function resolveAntigravityModelArgs(
  model: string | undefined,
  effort: string | undefined,
  catalogOption: ProviderModelOption | undefined,
): { model?: string; effort?: string } {
  const requested = effort !== undefined
    && (ANTIGRAVITY_EFFORT_TIERS as readonly string[]).includes(effort)
    ? effort
    : undefined;

  if (!model) {
    return requested ? { effort: requested } : {};
  }

  const { effort: embedded } = splitModelEffortSuffix(model);
  const family = extractVariantFamilyFromOption(catalogOption);

  if (embedded && !family) {
    return { model };
  }

  if (family && catalogOption) {
    let tier = embedded ?? family.default;
    if (requested && requested !== tier) {
      tier = family.tiers.includes(requested) ? requested : family.default;
    }
    return { model: `${catalogOption.value}-${tier}` };
  }

  if (catalogOption) {
    return { model: catalogOption.value };
  }

  return requested ? { model, effort: requested } : { model };
}
