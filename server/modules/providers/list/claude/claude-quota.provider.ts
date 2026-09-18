/**
 * Claude Quota Provider
 *
 * Reports the claude.ai subscription rate-limit windows (the 5-hour session
 * limit and the 7-day limits) that Claude Code itself renders in `/usage`.
 *
 * The numbers come from the Agent SDK control protocol rather than an HTTP
 * endpoint: the SDK owns the OAuth credentials and their silent refresh, so
 * asking it is the only way to read the account's limits without handling
 * tokens here. Reading them costs one short-lived `claude` process, hence the
 * shared quota cache in front of it.
 *
 * Consumers:
 * - `ClaudeProviderAuth.getQuota` in `claude-auth.provider.ts`
 * - `provider-token-usage.service.ts` via the provider registry
 *
 * @module claude-quota.provider
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { ProviderQuotaBucket, ProviderQuotaData } from '@/shared/types.js';
import {
  createProviderQuotaCache,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

export type ClaudeQuotaDependencies = {
  /** Returns the raw `/usage` payload, or null when the SDK cannot answer. */
  readUsage: () => Promise<unknown>;
  now: () => number;
};

/**
 * The SDK still ships this reader under an explicitly unstable name. It is
 * called by lookup rather than as a method so that a rename in a future SDK
 * release degrades to "no quota available" instead of a crash.
 */
const USAGE_METHOD_NAME = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

// Spawning the CLI and the round trip to claude.ai took ~5s in practice; the
// ceiling only exists so a hung process cannot pin the request open.
const USAGE_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 120_000;

const quotaCache = createProviderQuotaCache<ProviderQuotaData>(CACHE_TTL_MS);

/**
 * Resets the in-memory quota cache. Used by tests to keep cases isolated.
 * Consumer: `server/modules/providers/tests/claude-quota.test.ts`.
 */
export function clearClaudeQuotaCache(): void {
  quotaCache.reset();
}

/**
 * Reads the structured `/usage` payload through a throwaway SDK session.
 *
 * The prompt stream deliberately yields nothing: the CLI stays up waiting for
 * input, which is enough to serve a control request, while no turn ever starts
 * — so this neither writes a transcript nor consumes any of the very limits it
 * is reporting.
 */
async function readUsageThroughSdk(): Promise<unknown> {
  let releaseIdleStream: (() => void) | undefined;
  // Yields nothing on purpose — see above; it exists only to hold stdin open.
  // eslint-disable-next-line require-yield
  const idlePrompt = (async function* () {
    await new Promise<void>((resolve) => {
      releaseIdleStream = resolve;
    });
  })();

  const abortController = new AbortController();
  const executablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  const queryInstance = query({
    prompt: idlePrompt,
    options: {
      abortController,
      ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
    },
  });

  const timeoutHandle = setTimeout(() => abortController.abort(), USAGE_TIMEOUT_MS);
  try {
    const readUsage = (queryInstance as unknown as Record<string, unknown>)[USAGE_METHOD_NAME];
    if (typeof readUsage !== 'function') {
      return null;
    }
    return await (readUsage as () => Promise<unknown>).call(queryInstance);
  } finally {
    clearTimeout(timeoutHandle);
    // Ending the prompt stream closes the CLI's stdin; the abort covers the
    // case where the SDK never started reading it.
    releaseIdleStream?.();
    abortController.abort();
  }
}

const defaultDependencies: ClaudeQuotaDependencies = {
  readUsage: readUsageThroughSdk,
  now: () => Date.now(),
};

type RawUsageWindow = {
  utilization?: unknown;
  resets_at?: unknown;
};

/**
 * Maps one `{ utilization, resets_at }` window onto a quota bucket.
 * Windows the account does not have come back as null and are skipped, as are
 * windows whose utilization the server left unset.
 */
function createQuotaBucket(id: string, name: string, value: unknown): ProviderQuotaBucket | null {
  const window = readObjectRecord(value) as RawUsageWindow | null;
  if (!window) {
    return null;
  }

  // `utilization: null` is the server saying "this window has no reading",
  // which is not the same as 0% used — coercing it would paint a full bar.
  const utilization = window.utilization;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) {
    return null;
  }

  const usedPercent = Math.max(0, Math.min(100, utilization));
  const resetsAt = readOptionalString(window.resets_at);
  const resetDate = resetsAt ? new Date(resetsAt) : null;

  return {
    id,
    name,
    description: `${usedPercent}% used`,
    window: id === 'claude-5h' ? '5h' : 'weekly',
    remainingFraction: (100 - usedPercent) / 100,
    resetTime: resetDate && !Number.isNaN(resetDate.getTime())
      ? resetDate.toISOString()
      : undefined,
  };
}

/**
 * Turns the display name of a per-model weekly window into a stable bucket id.
 */
function toModelBucketId(displayName: string): string {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `claude-7d-${slug || 'model'}`;
}

/**
 * Normalizes the raw `/usage` payload into the provider-neutral quota model.
 *
 * Returns null whenever plan limits do not apply to this login (API key,
 * Bedrock, Vertex) or the payload carried no readable window, which the dialog
 * renders as "no account quota" rather than as an error.
 */
function normalizeUsagePayload(payload: unknown, nowTimestamp: number): ProviderQuotaData | null {
  const usage = readObjectRecord(payload);
  if (!usage || usage.rate_limits_available !== true) {
    return null;
  }

  const rateLimits = readObjectRecord(usage.rate_limits);
  if (!rateLimits) {
    return null;
  }

  const buckets = [
    createQuotaBucket('claude-5h', 'Five Hour Limit Remaining', rateLimits.five_hour),
    createQuotaBucket('claude-7d', 'Weekly Limit Remaining', rateLimits.seven_day),
    createQuotaBucket('claude-7d-opus', 'Weekly Opus Limit Remaining', rateLimits.seven_day_opus),
    createQuotaBucket('claude-7d-sonnet', 'Weekly Sonnet Limit Remaining', rateLimits.seven_day_sonnet),
  ];

  // Per-model weekly windows are additive: the server sends them only for the
  // models it currently meters separately, each carrying its own label.
  if (Array.isArray(rateLimits.model_scoped)) {
    for (const entry of rateLimits.model_scoped) {
      const record = readObjectRecord(entry);
      const displayName = readOptionalString(record?.display_name);
      if (!record || !displayName) continue;
      buckets.push(createQuotaBucket(
        toModelBucketId(displayName),
        `Weekly ${displayName} Limit Remaining`,
        record,
      ));
    }
  }

  const readableBuckets = buckets.filter((bucket): bucket is ProviderQuotaBucket => bucket !== null);
  if (readableBuckets.length === 0) {
    return null;
  }

  const subscriptionType = readOptionalString(usage.subscription_type);
  return {
    groups: [{
      name: subscriptionType ? `Claude (${subscriptionType.toUpperCase()})` : 'Claude',
      description: 'Claude subscription plan limits',
      buckets: readableBuckets,
    }],
    updatedAt: new Date(nowTimestamp).toISOString(),
    // One model family whose allowance is split per window, so the shared
    // 5-hour pool sits beside the per-model weekly carve-outs.
    partitioning: 'bucket',
  };
}

/**
 * Reads the current Claude account rate-limit status.
 *
 * Consumers: `ClaudeProviderAuth.getQuota` and the provider token-usage
 * service behind `GET /providers/quota`.
 */
export async function fetchClaudeQuota(
  options: { forceRefresh?: boolean } = {},
  dependencyOverrides: Partial<ClaudeQuotaDependencies> = {},
): Promise<ProviderQuotaData | null> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  return quotaCache.get(
    options,
    async () => normalizeUsagePayload(await dependencies.readUsage(), dependencies.now()),
    dependencies.now,
  );
}
