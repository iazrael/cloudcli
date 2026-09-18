/**
 * Account-level quota as served by `GET /api/providers/quota`.
 *
 * Defined once for both sides, like the chat contract next to it: these shapes
 * previously existed in three places — `server/shared/types.ts`,
 * `src/shared/types.ts` and `useChatComposerState.ts` — under two different
 * naming schemes, and had already drifted on whether `updatedAt` is optional.
 */

/** One rolling or windowed limit inside a quota group. */
export type ProviderQuotaBucket = {
  id: string;
  name: string;
  description?: string;
  window: '5h' | 'weekly' | string;
  remainingFraction: number;
  resetTime?: string;
};

/** One group of buckets, as the provider chooses to group them. */
export type ProviderQuotaGroup = {
  name: string;
  description?: string;
  buckets: ProviderQuotaBucket[];
};

/**
 * How a provider divides its quota into groups, stated by the provider rather
 * than inferred by the client from the provider's name.
 *
 * It decides how "which group backs the model I am running right now" is
 * answered, and the two answers are genuinely different:
 *
 * - `model-family`: each group covers a different family of models and says so
 *   in its own text (Antigravity's Gemini group versus its Claude/GPT group).
 *   A family keyword match settles it.
 * - `bucket`: the groups cover one family and split it by allowance instead
 *   (Codex's `gpt-reserve` carve-out sitting beside the main pool). A family
 *   match would tag the reserve as active for every model of that family, so a
 *   reserve bucket must name the running model explicitly, and an unmatched
 *   non-reserve bucket is the account's general-purpose pool.
 */
export type ProviderQuotaGroupPartitioning = 'model-family' | 'bucket';

/** Account-level quota and rate limit status across model groups. */
export type ProviderQuotaData = {
  groups: ProviderQuotaGroup[];
  updatedAt: string;
  partitioning: ProviderQuotaGroupPartitioning;
};
