/**
 * Antigravity Quota Provider
 *
 * Interacts with the `agy` CLI to fetch account-level quota status, including
 * 5-hour rolling limit buckets and weekly limit buckets across model groups.
 *
 * @module antigravity-quota.provider
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  ProviderQuotaBucket,
  ProviderQuotaData,
  ProviderQuotaGroup,
} from '@/shared/types.js';
import { createProviderQuotaCache } from '@/shared/utils.js';

import { tryResolveEnginePath } from './antigravity-engine-path.js';
import { buildAntigravitySubprocessEnv } from './antigravity-subprocess-env.js';

const execFileAsync = promisify(execFile);

export type AntigravityQuotaBucket = ProviderQuotaBucket;
export type AntigravityQuotaGroup = ProviderQuotaGroup;
export type AntigravityQuotaData = ProviderQuotaData;

type RawAgyBucket = {
  id?: string;
  name?: string;
  description?: string;
  window?: string;
  remaining_fraction?: number;
  reset_time?: string;
};

type RawAgyGroup = {
  name?: string;
  description?: string;
  buckets?: RawAgyBucket[];
};

type RawAgyUsageResponse = {
  command?: {
    name?: string;
    data?: {
      description?: string;
      groups?: RawAgyGroup[];
    };
  };
};

type AntigravityQuotaDependencies = {
  resolveEnginePath: () => string | null;
  runCommand: (executablePath: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  now: () => number;
};

/**
 * Wall-clock ceiling for the `agy /usage` subprocess.
 *
 * A healthy `agy /usage` on agy 1.5.9 (2026-11-14 build) takes ~8-11s — the CLI
 * refreshes its token and round-trips the backend on every call — so the
 * previous 10s ceiling intermittently killed healthy runs; the catch block then
 * mapped that to null and the Token Usage modal showed "no quota data". 30s
 * leaves headroom for the slow runs without hanging a manual refresh.
 *
 * Consumers: tests pin this lower bound (antigravity-quota.test.ts).
 */
export const ANTIGRAVITY_QUOTA_COMMAND_TIMEOUT_MS = 30_000;

const defaultDependencies: AntigravityQuotaDependencies = {
  resolveEnginePath: tryResolveEnginePath,
  runCommand: async (executablePath, args) => {
    return execFileAsync(executablePath, args, {
      timeout: ANTIGRAVITY_QUOTA_COMMAND_TIMEOUT_MS,
      encoding: 'utf8',
      env: buildAntigravitySubprocessEnv(),
      windowsHide: true,
    });
  },
  now: () => Date.now(),
};

const CACHE_TTL_MS = 120_000; // 2 minutes
const quotaCache = createProviderQuotaCache<AntigravityQuotaData>(CACHE_TTL_MS);

function normalizeQuotaPayload(raw: RawAgyUsageResponse, nowTimestamp: number): AntigravityQuotaData | null {
  const groupsRaw = raw.command?.data?.groups;
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) {
    return null;
  }

  const groups: AntigravityQuotaGroup[] = groupsRaw
    .map((group) => {
      const name = typeof group.name === 'string' ? group.name.trim() : 'Unknown Group';
      const description = typeof group.description === 'string' ? group.description : undefined;
      const rawBuckets = Array.isArray(group.buckets) ? group.buckets : [];

      const buckets: AntigravityQuotaBucket[] = rawBuckets
        .map((bucket) => {
          const rawFraction = Number(bucket.remaining_fraction);
          const remainingFraction = Number.isFinite(rawFraction)
            ? Math.max(0, Math.min(1, rawFraction))
            : 0;

          return {
            id: typeof bucket.id === 'string' ? bucket.id : 'unknown',
            name: typeof bucket.name === 'string' ? bucket.name : 'Limit',
            description: typeof bucket.description === 'string' ? bucket.description : undefined,
            window: typeof bucket.window === 'string' ? bucket.window : 'unknown',
            remainingFraction,
            resetTime: typeof bucket.reset_time === 'string' ? bucket.reset_time : undefined,
          };
        })
        .filter((bucket) => Boolean(bucket.id));

      return {
        name,
        description,
        buckets,
      };
    })
    .filter((group) => group.buckets.length > 0);

  if (groups.length === 0) {
    return null;
  }

  return {
    groups,
    updatedAt: new Date(nowTimestamp).toISOString(),
    // Antigravity splits its allowance by model family: a Gemini group beside
    // a Claude/GPT one, each naming its family in its own text.
    partitioning: 'model-family',
  };
}

/**
 * Fetches the current Antigravity quota and limit status by invoking the CLI.
 * Consumed by provider-token-usage.service.ts and commands.routes.ts to enrich
 * Token Usage presentations with 5-hour and weekly quota meters.
 */
export async function fetchAntigravityQuota(
  options: { forceRefresh?: boolean } = {},
  dependencyOverrides: Partial<AntigravityQuotaDependencies> = {},
): Promise<AntigravityQuotaData | null> {
  const deps: AntigravityQuotaDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  return quotaCache.get(
    options,
    async () => {
      try {
        const enginePath = deps.resolveEnginePath();
        if (!enginePath) {
          return null;
        }

        const { stdout } = await deps.runCommand(enginePath, [
          '--output-format',
          'json',
          '--print',
          '/usage',
        ]);

        if (!stdout || !stdout.trim()) {
          return null;
        }

        const parsed = JSON.parse(stdout) as RawAgyUsageResponse;
        return normalizeQuotaPayload(parsed, deps.now());
      } catch (error) {
        // Quota refresh is cache-gated (2 min TTL), so failures are infrequent:
        // surface them instead of silently mapping to null, which only shows up
        // as an empty quota card in the UI and leaves diagnosis nothing to read.
        console.warn('[Antigravity] agy /usage quota fetch failed:', error);
        return null;
      }
    },
    deps.now,
  );
}

/**
 * Resets the in-memory quota cache.
 * Consumed primarily in unit test suites.
 */
export function resetAntigravityQuotaCache(): void {
  quotaCache.reset();
}
