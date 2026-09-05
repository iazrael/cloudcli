/**
 * ZCode Quota and Rate Limit Provider
 *
 * Fetches account-level quota status (5-hour rolling token limits and cycle limits)
 * from BigModel / Z.AI monitoring endpoints using the decrypted OAuth token.
 *
 * Consumers:
 * - `ZCodeProviderAuth.getQuota` in `zcode-auth.provider.ts`
 * - `provider-token-usage.service.ts` via provider registry
 *
 * @module zcode-quota.provider
 */

import type { ProviderQuotaBucket, ProviderQuotaData, ProviderQuotaGroup } from '@/shared/types.js';
import { createProviderQuotaCache, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { readDecryptedZCodeCredentials } from './zcode-credentials.js';

export type ZCodeQuotaDependencies = {
  fetch: typeof globalThis.fetch;
  readCredentials: typeof readDecryptedZCodeCredentials;
  now: () => number;
};

const DEFAULT_DEPENDENCIES: ZCodeQuotaDependencies = {
  fetch: globalThis.fetch,
  readCredentials: readDecryptedZCodeCredentials,
  now: () => Date.now(),
};

const BIGMODEL_QUOTA_URL = 'https://bigmodel.cn/api/monitor/usage/quota/limit';
const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
const CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

const quotaCache = createProviderQuotaCache<ProviderQuotaData>(CACHE_TTL_MS);

/**
 * Resets the in-memory quota cache. Used in tests to ensure isolation.
 */
export function clearZCodeQuotaCache(): void {
  quotaCache.reset();
}

type RawZCodeLimit = {
  type?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails?: Array<{ modelCode?: string; usage?: number }>;
};

/**
 * Safely parses an optional epoch timestamp into an ISO string.
 * Returns undefined when invalid or not a positive finite number.
 */
function toSafeIsoDate(timestamp: unknown): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Maps ZCode raw limit entries to unified ProviderQuotaBucket items.
 */
function normalizeQuotaLimit(limit: RawZCodeLimit): ProviderQuotaBucket | null {
  const type = readOptionalString(limit.type);
  if (!type) {
    return null;
  }

  const nextResetIso = toSafeIsoDate(limit.nextResetTime);

  if (type === 'TOKENS_LIMIT') {
    const rawPercentage = Number(limit.percentage);
    const percentage = Number.isFinite(rawPercentage) ? rawPercentage : 0;
    const remainingFraction = Math.max(0, Math.min(1, (100 - percentage) / 100));
    const isFiveHour = limit.unit === 3 || limit.number === 5;

    return {
      id: isFiveHour ? 'zcode-5h-tokens' : 'zcode-tokens-limit',
      name: isFiveHour ? 'Five Hour Limit Remaining' : 'Token Limit Remaining',
      description: isFiveHour ? '5-hour rolling token limit' : 'Model token rate limit',
      window: isFiveHour ? '5h' : 'rolling',
      remainingFraction,
      resetTime: nextResetIso,
    };
  }

  if (type === 'TIME_LIMIT') {
    const rawUsage = Number(limit.usage);
    const usageTotal = Number.isFinite(rawUsage) ? rawUsage : 0;

    const rawRemaining = Number(limit.remaining);
    const remaining = Number.isFinite(rawRemaining) ? rawRemaining : 0;

    const rawPercentage = Number(limit.percentage);
    const percentage = Number.isFinite(rawPercentage) ? rawPercentage : 0;

    const remainingFraction = usageTotal > 0
      ? Math.max(0, Math.min(1, remaining / usageTotal))
      : Math.max(0, Math.min(1, (100 - percentage) / 100));

    return {
      id: 'zcode-calls-limit',
      name: 'Cycle Calls Limit',
      description: limit.usageDetails && limit.usageDetails.length > 0
        ? `${remaining} of ${usageTotal} calls remaining`
        : 'Cycle model and tool call quota',
      window: 'cycle',
      remainingFraction,
      resetTime: nextResetIso,
    };
  }

  return null;
}

/**
 * Normalizes raw API response to unified ProviderQuotaData.
 */
function normalizeQuotaPayload(
  payload: unknown,
  providerFamily: 'bigmodel' | 'zai',
  nowTimestamp: number,
): ProviderQuotaData | null {
  const record = readObjectRecord(payload);
  if (!record) {
    return null;
  }

  const data = readObjectRecord(record.data);
  if (!data || !Array.isArray(data.limits)) {
    return null;
  }

  const buckets = data.limits
    .map((item) => normalizeQuotaLimit(item as RawZCodeLimit))
    .filter((bucket): bucket is ProviderQuotaBucket => bucket !== null);

  if (buckets.length === 0) {
    return null;
  }

  const rawLevel = readOptionalString(data.level);
  const levelLabel = rawLevel ? rawLevel.toUpperCase() : null;
  const groupName = levelLabel
    ? `ZCode (${levelLabel})`
    : 'ZCode';

  const group: ProviderQuotaGroup = {
    name: groupName,
    description: providerFamily === 'zai' ? 'Z.AI Coding Plan account quota' : 'BigModel Coding Plan account quota',
    buckets,
  };

  return {
    groups: [group],
    updatedAt: new Date(nowTimestamp).toISOString(),
  };
}

/**
 * Fetches current ZCode account quota status.
 *
 * Consumer: ZCodeProviderAuth.getQuota and provider-token-usage.service.
 */
export async function fetchZCodeQuota(
  options: { forceRefresh?: boolean } = {},
  dependencyOverrides: Partial<ZCodeQuotaDependencies> = {},
): Promise<ProviderQuotaData | null> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };

  return quotaCache.get(
    options,
    async () => {
      const credentials = await deps.readCredentials();
      if (!credentials.authenticated || !credentials.accessToken) {
        return null;
      }

      const targetUrl = credentials.providerFamily === 'zai' ? ZAI_QUOTA_URL : BIGMODEL_QUOTA_URL;

      try {
        const response = await deps.fetch(targetUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          return null;
        }

        const payload = await response.json();
        return normalizeQuotaPayload(payload, credentials.providerFamily, deps.now());
      } catch {
        // Fail closed: network timeouts or errors degrade gracefully to null
        return null;
      }
    },
    deps.now,
  );
}
