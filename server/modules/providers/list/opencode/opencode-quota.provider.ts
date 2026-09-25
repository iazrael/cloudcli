/**
 * OpenCode Quota Provider
 *
 * Fetches OpenCode Go subscription usage (rolling 5-hour, weekly, and monthly
 * windows) from OpenCode's official usage endpoint using the `opencode-go` API
 * key stored in the OpenCode auth store. Zen pay-as-you-go accounts expose no
 * usage endpoint, so they resolve to null and simply show no quota card.
 *
 * Consumers:
 * - `OpenCodeProviderAuth.getQuota` in `opencode-auth.provider.ts`
 * - `provider-token-usage.service.ts` via provider registry
 *
 * @module opencode-quota.provider
 */

import { readFile } from 'node:fs/promises';

import type { ProviderQuotaBucket, ProviderQuotaData } from '@/shared/types.js';
import { createProviderQuotaCache, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { getOpenCodeAuthPath } from './opencode-data-root.js';

type OpenCodeQuotaDependencies = {
  fetch: typeof globalThis.fetch;
  readApiKey: () => Promise<string | null>;
  now: () => number;
};

const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

const quotaCache = createProviderQuotaCache<ProviderQuotaData>(CACHE_TTL_MS);

/**
 * Resets the in-memory quota cache. Used in tests to ensure isolation.
 */
export function clearOpenCodeQuotaCache(): void {
  quotaCache.reset();
}

/**
 * Reads the `opencode-go` API key from the OpenCode auth store.
 *
 * OpenCode keeps every connected provider credential in one `auth.json`, with
 * the Go subscription key under the `opencode-go` entry. Missing, unreadable,
 * or Zen-only stores resolve to null rather than throwing.
 */
async function readOpenCodeGoApiKey(): Promise<string | null> {
  try {
    const auth = readObjectRecord(JSON.parse(await readFile(getOpenCodeAuthPath(), 'utf8')));
    const goCredential = readObjectRecord(auth?.['opencode-go']);
    return readOptionalString(goCredential?.key) ?? null;
  } catch {
    return null;
  }
}

const defaultDependencies: OpenCodeQuotaDependencies = {
  fetch: globalThis.fetch,
  readApiKey: readOpenCodeGoApiKey,
  now: () => Date.now(),
};

type OpenCodeUsageWindow = {
  status?: unknown;
  percent?: unknown;
  resetsAt?: unknown;
};

type OpenCodeQuotaWindowDefinition = {
  key: 'rolling' | 'weekly' | 'monthly';
  id: string;
  name: string;
  description: string;
  window: '5h' | 'weekly' | 'monthly';
};

/**
 * The three Go plan windows in display order. Upstream `percent` is always
 * "used", the same semantics the OpenCode dashboard reports.
 */
const QUOTA_WINDOW_DEFINITIONS: OpenCodeQuotaWindowDefinition[] = [
  {
    key: 'rolling',
    id: 'opencode-go-rolling',
    name: '5-hour limit',
    description: 'Rolling 5-hour usage limit',
    window: '5h',
  },
  {
    key: 'weekly',
    id: 'opencode-go-weekly',
    name: 'Weekly limit',
    description: 'Weekly usage limit',
    window: 'weekly',
  },
  {
    key: 'monthly',
    id: 'opencode-go-monthly',
    name: 'Monthly limit',
    description: 'Monthly usage limit',
    window: 'monthly',
  },
];

/**
 * Reads a usage percent, accepting JSON numbers and numeric strings while
 * keeping absent or null values distinguishable from a real zero.
 */
function readFinitePercent(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Safely parses an ISO reset timestamp, returning undefined when absent or
 * unparseable so the frontend simply omits the countdown.
 */
function toSafeIsoDate(value: unknown): string | undefined {
  const raw = readOptionalString(value);
  if (!raw) {
    return undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/**
 * Maps one upstream usage window to a unified ProviderQuotaBucket.
 *
 * Windows upstream reports as non-`ok` are treated as spent so the card never
 * advertises remaining allowance the plan cannot serve.
 */
function normalizeQuotaWindow(
  definition: OpenCodeQuotaWindowDefinition,
  value: unknown,
): ProviderQuotaBucket | null {
  const windowRecord = readObjectRecord(value) as OpenCodeUsageWindow | null;
  const usedPercent = readFinitePercent(windowRecord?.percent);
  if (!windowRecord || usedPercent === null) {
    return null;
  }

  const status = readOptionalString(windowRecord.status);
  const boundedUsedPercent = status && status.toLowerCase() !== 'ok'
    ? 100
    : Math.max(0, Math.min(100, usedPercent));

  return {
    id: definition.id,
    name: definition.name,
    description: `${Math.round(boundedUsedPercent)}% used`,
    window: definition.window,
    remainingFraction: (100 - boundedUsedPercent) / 100,
    resetTime: toSafeIsoDate(windowRecord.resetsAt),
  };
}

/**
 * Normalizes the raw `/zen/go/v1/usage` payload into unified ProviderQuotaData.
 */
function normalizeQuotaPayload(payload: unknown, nowTimestamp: number): ProviderQuotaData | null {
  const usage = readObjectRecord(readObjectRecord(payload)?.usage);
  if (!usage) {
    return null;
  }

  const buckets = QUOTA_WINDOW_DEFINITIONS
    .map((definition) => normalizeQuotaWindow(definition, usage[definition.key]))
    .filter((bucket): bucket is ProviderQuotaBucket => bucket !== null);

  if (buckets.length === 0) {
    return null;
  }

  return {
    groups: [
      {
        name: 'OpenCode Go',
        description: 'OpenCode Go subscription account quota',
        buckets,
      },
    ],
    updatedAt: new Date(nowTimestamp).toISOString(),
    // One family (OpenCode Go), split by allowance window rather than by model.
    partitioning: 'bucket',
  };
}

/**
 * Fetches current OpenCode Go account usage.
 *
 * Consumer: OpenCodeProviderAuth.getQuota and provider-token-usage.service.
 */
export async function fetchOpenCodeQuota(
  options: { forceRefresh?: boolean } = {},
  dependencyOverrides: Partial<OpenCodeQuotaDependencies> = {},
): Promise<ProviderQuotaData | null> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return quotaCache.get(
    options,
    async () => {
      const apiKey = await dependencies.readApiKey();
      if (!apiKey) {
        return null;
      }

      try {
        const response = await dependencies.fetch(OPENCODE_GO_USAGE_URL, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          return null;
        }

        return normalizeQuotaPayload(await response.json(), dependencies.now());
      } catch {
        // Fail closed: network timeouts or errors degrade gracefully to null
        return null;
      }
    },
    dependencies.now,
  );
}
