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
  /**
   * The model family this window meters when it is narrower than the whole
   * account (e.g. Claude's per-model weekly cap). Absent on all-models windows
   * and on providers that do not split an allowance by model.
   */
  modelScope?: string;
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

/**
 * One consumable quota-reset card ("banked reset") the account holds.
 *
 * Spending a card restores the covered allowances immediately instead of
 * waiting for the windows to roll over; the act itself is irreversible on the
 * provider side, which is why the UI confirms before calling.
 */
export type ProviderQuotaResetCredit = {
  /** Provider-native id of this grant (Codex credit id / bigmodel recordId). */
  id: string;
  /**
   * Which allowance the card restores: `5h`, `weekly`, or `all`. `all` means
   * both windows at once (Codex's full reset, bigmodel's week reset which
   * also refills the 5-hour pool without spending a 5-hour card).
   */
  resetType: '5h' | 'weekly' | 'all' | string;
  /** Provider's own display text for the grant, when it has one. */
  title?: string;
  /** How the card was granted (bigmodel: `DIRECT`, promotions, …). */
  grantType?: string;
  /** False for cards already spent or expired — informational only. */
  available: boolean;
  /** ISO timestamp after which the card can no longer be used. */
  expireTime?: string;
};

/** The account's quota-reset card inventory, embedded in `ProviderQuotaData`. */
export type ProviderQuotaResetCredits = {
  credits: ProviderQuotaResetCredit[];
};

/**
 * Input for spending one of the account's reset cards through
 * `POST /providers/quota/reset`.
 *
 * Deliberately carries no card id: when several available cards match, the
 * provider spends the soonest-expiring one itself (use-it-or-lose-it).
 */
export type ProviderQuotaResetConsumeInput = {
  /** Which allowance to restore; `5h` and `weekly` may also spend an `all` card. */
  resetType: '5h' | 'weekly' | 'all' | string;
};

/** Outcome of a reset-card spend, for the UI to relay verbatim. */
export type ProviderQuotaResetConsumeResult = {
  ok: boolean;
  /**
   * Coarse outcome category the client localizes from. `message` may carry
   * provider- or server-language text, so UIs should prefer their own copy
   * keyed by this code and treat `message` as fallback detail only.
   */
  code?: 'reset' | 'noCard' | 'readFailed' | 'notAuthenticated' | 'spendFailed' | 'unknown';
  /** Human-readable outcome detail; language depends on the source. */
  message?: string;
};

/** Account-level quota and rate limit status across model groups. */
export type ProviderQuotaData = {
  groups: ProviderQuotaGroup[];
  updatedAt: string;
  partitioning: ProviderQuotaGroupPartitioning;
  /** Present only when the provider reported reset cards at all. */
  resetCredits?: ProviderQuotaResetCredits;
};
