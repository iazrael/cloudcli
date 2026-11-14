/**
 * ZCode Quota and Rate Limit Provider
 *
 * Fetches account-level quota status (5-hour rolling token limits and cycle limits)
 * from BigModel / Z.AI monitoring endpoints, authenticating with the coding-plan
 * api-key plus the optional `org-…`/`proj_…` scoping headers (the OAuth Bearer
 * tokens the endpoints used to accept were retired by the 2026-11 ZCode desktop
 * upgrade). The provider-side rejection arrives as HTTP 200 with a non-200 body
 * `code`, so the body envelope is always verified before normalization.
 *
 * Consumers:
 * - `ZCodeProviderAuth.getQuota` in `zcode-auth.provider.ts`
 * - `provider-token-usage.service.ts` via provider registry
 *
 * @module zcode-quota.provider
 */

import { randomUUID } from 'node:crypto';

import type {
  ProviderQuotaBucket,
  ProviderQuotaData,
  ProviderQuotaGroup,
  ProviderQuotaResetConsumeInput,
  ProviderQuotaResetConsumeResult,
  ProviderQuotaResetCredit,
  ProviderQuotaResetCredits,
} from '@/shared/types.js';
import {
  createProviderQuotaCache,
  pickAvailableResetCredit,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

import { readZCodeCodingPlanQuotaContext, type ZCodeCodingPlanQuotaContext } from './zcode-credentials.js';
import { readZCodeAppVersion, tryResolveEnginePath } from './zcode-engine-path.js';

export type ZCodeQuotaDependencies = {
  fetch: typeof globalThis.fetch;
  readQuotaContext: typeof readZCodeCodingPlanQuotaContext;
  readAppVersion: () => string;
  now: () => number;
};

const DEFAULT_DEPENDENCIES: ZCodeQuotaDependencies = {
  fetch: globalThis.fetch,
  readQuotaContext: () => readZCodeCodingPlanQuotaContext(),
  readAppVersion: () => {
    const enginePath = tryResolveEnginePath();
    return (enginePath ? readZCodeAppVersion(enginePath) : null) ?? FALLBACK_APP_VERSION;
  },
  now: () => Date.now(),
};

const BIGMODEL_QUOTA_URL = 'https://bigmodel.cn/api/monitor/usage/quota/limit';
const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
// The ZCode MCP call quota lives on the zcode gateway, not on the bigmodel
// monitor, and its envelope answers `code: 0` instead of `code: 200`.
const ZCODE_MCP_USAGE_URL = 'https://zcode.z.ai/api/v1/mcp/usage';
const ZCODE_PLAN_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
// The gateway validates the value loosely; the desktop app's own version passes.
const FALLBACK_APP_VERSION = '3.18.2';
// Reset-card ("用量重置额度") endpoints behind the coding-plan console; only the
// personal plan segment is wired up — team accounts need org/project ids.
const BIGMODEL_RESET_LIST_URL = 'https://bigmodel.cn/api/biz/customer-package-reset/list';
const BIGMODEL_RESET_USE_URL = 'https://bigmodel.cn/api/biz/customer-package-reset/use';
const RESET_TARGET_TYPE = 'PERSONAL';
const CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

const quotaCache = createProviderQuotaCache<ProviderQuotaData>(CACHE_TTL_MS);

/**
 * Resets the in-memory quota cache. Used in tests to ensure isolation.
 */
export function clearZCodeQuotaCache(): void {
  quotaCache.reset();
}

/**
 * Builds the coding-plan auth headers: the raw api-key in `authorization`
 * (no Bearer prefix, matching the desktop client) plus the org/project scoping
 * headers when the account has a stored key location. Sending a *wrong*
 * scoping header empties the payload, so absent ids are omitted entirely.
 */
function buildQuotaAuthHeaders(context: ZCodeCodingPlanQuotaContext): Record<string, string> {
  return {
    authorization: context.apiKey,
    ...(context.organizationId ? { 'bigmodel-organization': context.organizationId } : {}),
    ...(context.projectId ? { 'bigmodel-project': context.projectId } : {}),
  };
}

/** Chooses the quota host from the plan family (`zai-*` plans live on api.z.ai). */
function resolveQuotaUrl(planFamily: string): string {
  return planFamily.startsWith('zai') ? ZAI_QUOTA_URL : BIGMODEL_QUOTA_URL;
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
      name: 'Tool Calls Allowance',
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
  planFamily: string,
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
    description: planFamily.startsWith('zai') ? 'Z.AI Coding Plan account quota' : 'BigModel Coding Plan account quota',
    buckets,
  };

  return {
    groups: [group],
    updatedAt: new Date(nowTimestamp).toISOString(),
    // One family (GLM), split by allowance rather than by model family.
    partitioning: 'bucket',
  };
}

/**
 * Verifies the bigmodel envelope: the monitor endpoints answer HTTP 200 even
 * for auth failures, with the verdict in the body (`code`/`success`). Throws
 * so the caller degrades to "no quota" instead of parsing an error as data.
 */
function assertQuotaSuccessPayload(payload: unknown): void {
  const record = readObjectRecord(payload);
  if (!record) {
    throw new Error('Quota endpoint returned a non-object payload.');
  }
  const code = Number(record.code);
  if (record.success === true && code === 200) {
    return;
  }
  const message = readOptionalString(record.msg) ?? 'unknown provider error';
  throw new Error(`Quota endpoint rejected the request (code ${Number.isFinite(code) ? code : 'n/a'}): ${message}`);
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
      const context = await deps.readQuotaContext();
      if (!context) {
        return null;
      }

      try {
        const [limitsResult, resetResult, mcpResult, startPlanResult] = await Promise.allSettled([
          readLimitsPayload(deps, context),
          readResetCreditsQuietly(deps, context),
          readMcpUsageBucket(deps, context),
          readStartPlanBalanceGroup(deps, context),
        ]);

        if (limitsResult.status === 'rejected') {
          // Fail closed: network timeouts, HTTP errors, or provider-side
          // envelope rejections degrade gracefully to null
          return null;
        }

        const normalized = normalizeQuotaPayload(limitsResult.value, context.planFamily, deps.now());
        if (!normalized) {
          return null;
        }

        // The reset-card inventory rides along when it can be read; a failing
        // card request must never take the quota display down with it.
        const resetCredits = resetResult.status === 'fulfilled' ? resetResult.value : undefined;
        // Same for the ZCode MCP call quota: its failure only drops that bucket.
        if (mcpResult.status === 'fulfilled' && mcpResult.value) {
          normalized.groups[0].buckets.push(mcpResult.value);
        }
        // The start plan balance becomes its own group — an exhausted trial
        // allowance (remaining 0) is still worth showing.
        if (startPlanResult.status === 'fulfilled' && startPlanResult.value) {
          normalized.groups.push(startPlanResult.value);
        }
        return resetCredits ? { ...normalized, resetCredits } : normalized;
      } catch {
        return null;
      }
    },
    deps.now,
  );
}

/**
 * Reads the ZCode MCP call quota from the zcode.z.ai gateway. Auth is a dual
 * header pair: the start-plan zcode JWT in `Authorization` beside the
 * coding-plan credential in `X-Bigmodel-Authorization` (both as Bearer). The
 * gateway envelope uses `code: 0` — unlike the bigmodel monitor endpoints'
 * `code: 200` — and a missing/failing read only drops this bucket.
 */
async function readMcpUsageBucket(
  deps: ZCodeQuotaDependencies,
  context: ZCodeCodingPlanQuotaContext,
): Promise<ProviderQuotaBucket | null> {
  if (!context.zcodeJwtToken) {
    return null;
  }

  const response = await deps.fetch(ZCODE_MCP_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${context.zcodeJwtToken}`,
      'X-Bigmodel-Authorization': `Bearer ${context.apiKey}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Mcp usage endpoint returned HTTP ${response.status}`);
  }

  const record = readObjectRecord(await response.json());
  const code = Number(record?.code);
  if (!record || code !== 0) {
    const message = readOptionalString(record?.msg) ?? 'unknown gateway error';
    throw new Error(`Mcp usage endpoint rejected the request (code ${Number.isFinite(code) ? code : 'n/a'}): ${message}`);
  }

  const data = readObjectRecord(record.data);
  const usage = readObjectRecord(data?.total_usage);
  const limit = Number(usage?.limit);
  const remaining = Number(usage?.remaining);
  if (!Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  const usedRaw = Number(usage?.used);
  const used = Number.isFinite(usedRaw) ? usedRaw : Math.max(0, limit - remaining);
  const resetTime = toSafeIsoDate(Number(data?.next_refresh_at) * 1000);

  return {
    id: 'zcode-mcp-usage',
    name: 'ZCode MCP',
    description: `${remaining} of ${limit} calls remaining`,
    window: 'daily',
    remainingFraction: Math.max(0, Math.min(1, remaining / limit)),
    resetTime,
  };
}

/** One `balances[]` entry of the zcode start plan billing payload. */
type RawZCodePlanBalance = {
  bucket_id?: unknown;
  show_name?: unknown;
  total_units?: unknown;
  used_units?: unknown;
  remaining_units?: unknown;
  period?: unknown;
  expires_at?: unknown;
};

/**
 * Reads the start plan balance from the zcode gateway into its own quota
 * group: the trial allowance can sit at zero and still be worth showing, so
 * the group appears whenever the gateway answers, exhausted or not. Auth is
 * the start-plan zcode JWT as Bearer; the gateway also requires the device
 * UUID (`X-Device-Mid`) and an `app_version` query parameter.
 */
async function readStartPlanBalanceGroup(
  deps: ZCodeQuotaDependencies,
  context: ZCodeCodingPlanQuotaContext,
): Promise<ProviderQuotaGroup | null> {
  if (!context.zcodeJwtToken || !context.deviceMid) {
    return null;
  }

  const url = `${ZCODE_PLAN_BALANCE_URL}?app_version=${encodeURIComponent(deps.readAppVersion())}`;
  const response = await deps.fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${context.zcodeJwtToken}`,
      'X-Device-Mid': context.deviceMid,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Start plan balance endpoint returned HTTP ${response.status}`);
  }

  const record = readObjectRecord(await response.json());
  const code = Number(record?.code);
  if (!record || code !== 0) {
    const message = readOptionalString(record?.msg) ?? 'unknown gateway error';
    throw new Error(`Start plan balance endpoint rejected the request (code ${Number.isFinite(code) ? code : 'n/a'}): ${message}`);
  }

  const data = readObjectRecord(record.data);
  const balances = Array.isArray(data?.balances) ? data.balances : [];

  const buckets = balances
    .map((entry): ProviderQuotaBucket | null => {
      const balance = readObjectRecord(entry) as RawZCodePlanBalance | null;
      if (!balance) {
        return null;
      }
      const total = Number(balance.total_units);
      const remaining = Number(balance.remaining_units);
      if (!Number.isFinite(total) || total <= 0) {
        return null;
      }
      const name = readOptionalString(balance.show_name) ?? 'Start Plan Balance';
      const cappedRemaining = Number.isFinite(remaining) ? Math.max(0, Math.min(remaining, total)) : 0;
      const period = readOptionalString(balance.period);
      return {
        id: `zcode-start-plan-${readOptionalString(balance.bucket_id) ?? name}`,
        name,
        description: `${cappedRemaining} of ${total} tokens remaining`,
        // one_time grants carry an expiry date, not a recurring reset window.
        window: period === 'one_time' ? 'onetime' : 'total',
        remainingFraction: Math.max(0, Math.min(1, cappedRemaining / total)),
        resetTime: toSafeIsoDate(Number(balance.expires_at) * 1000),
      };
    })
    .filter((bucket): bucket is ProviderQuotaBucket => bucket !== null);

  if (buckets.length === 0) {
    return null;
  }

  return {
    name: 'ZCode Start Plan',
    description: 'ZCode start plan balance',
    buckets,
  };
}

/**
 * Reads the raw limits payload from the plan family's quota endpoint.
 * Rejects on transport errors, non-OK statuses, and provider-side envelope
 * rejections so the caller can decide between "no quota" and "quota unavailable".
 */
async function readLimitsPayload(
  deps: ZCodeQuotaDependencies,
  context: ZCodeCodingPlanQuotaContext,
): Promise<unknown> {
  const response = await deps.fetch(resolveQuotaUrl(context.planFamily), {    method: 'GET',
    headers: buildQuotaAuthHeaders(context),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Quota endpoint returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  assertQuotaSuccessPayload(payload);
  return payload;
}

/**
 * Reads the personal plan's reset-card inventory ("用量重置额度" cards) from the
 * coding-plan console API. Both card sections map onto the shared wire model:
 * `fiveHourResets` restore the 5-hour window, `weekResets` the weekly one (a
 * weekly reset also refills the 5-hour pool on the provider side). Returns
 * undefined when the account holds no spendable card or the read fails.
 */
async function readResetCreditsQuietly(
  deps: ZCodeQuotaDependencies,
  context: ZCodeCodingPlanQuotaContext,
): Promise<ProviderQuotaResetCredits | undefined> {
  try {
    const credits = await fetchZCodeResetCreditList(deps, context);
    return credits.length > 0 ? { credits } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Raw entry of `GET /biz/customer-package-reset/list`. `expireTime` comes as
 * `"YYYY-MM-DD HH:mm:ss"` in the account's local time.
 */
type RawZCodeResetRecord = {
  recordId?: unknown;
  grantType?: unknown;
  expireTime?: unknown;
  available?: unknown;
};

/**
 * Converts bigmodel's `"YYYY-MM-DD HH:mm:ss"` card expiry into ISO so every
 * client can `new Date()` it. The string carries no zone, so the server's own
 * zone is the assumption; anything unparseable passes through untouched.
 */
function normalizeZCodeTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return value;
  }
  const parsed = new Date(value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

async function fetchZCodeResetCreditList(
  deps: ZCodeQuotaDependencies,
  context: ZCodeCodingPlanQuotaContext,
): Promise<ProviderQuotaResetCredit[]> {
  const response = await deps.fetch(
    `${BIGMODEL_RESET_LIST_URL}?targetType=${RESET_TARGET_TYPE}`,
    {
      method: 'GET',
      headers: buildQuotaAuthHeaders(context),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  // Deliberately not a silent []: the consume path must distinguish "no
  // cards" from "cannot read the cards" before spending anything.
  if (!response.ok) {
    throw new Error(`Reset card endpoint returned HTTP ${response.status}`);
  }

  const json = await response.json();
  // The biz endpoints share the monitor envelope shape (HTTP 200 + body
  // verdict); without this check an auth rejection parses as an empty card
  // list and a spend attempt misreads "cannot read the cards" as "no cards".
  assertQuotaSuccessPayload(json);
  const payload = readObjectRecord(json);
  const data = readObjectRecord(payload?.data);
  const sections: Array<[string, ProviderQuotaResetCredit['resetType']]> = [
    ['fiveHourResets', '5h'],
    ['weekResets', 'weekly'],
  ];

  const credits: ProviderQuotaResetCredit[] = [];
  for (const [key, resetType] of sections) {
    const list = Array.isArray(data?.[key]) ? data[key] : [];
    for (const entry of list) {
      const record = readObjectRecord(entry) as RawZCodeResetRecord | null;
      const recordId = record ? Number(record.recordId) : Number.NaN;
      if (!record || !Number.isFinite(recordId)) {
        continue;
      }

      const expireTime = readOptionalString(record.expireTime);
      const grantType = readOptionalString(record.grantType);
      credits.push({
        id: String(recordId),
        resetType,
        ...(grantType ? { grantType } : {}),
        available: record.available === true,
        ...(expireTime ? { expireTime: normalizeZCodeTimestamp(expireTime) } : {}),
      });
    }
  }

  return credits;
}

/**
 * Spends one of the account's reset cards through the coding-plan console.
 *
 * Reads the fresh card list first (the quota cache may be 30 seconds stale and
 * offer a card spent elsewhere), picks the soonest-expiring available card
 * covering the request, and posts the irreversible use request with a
 * `requestId` idempotency key. A successful spend invalidates the quota cache
 * so the next read reflects the refilled windows.
 *
 * Failures keep the cause distinguishable (`code`): "no cards" is different
 * from "cannot read the cards", and a timeout maps to `unknown` because the
 * card may already have been spent provider-side — the UI must steer the user
 * into re-checking the quota instead of retrying into a double spend.
 * Consumer: ZCodeProviderAuth.consumeQuotaReset().
 */
export async function consumeZCodeQuotaReset(
  input: ProviderQuotaResetConsumeInput,
  dependencyOverrides: Partial<ZCodeQuotaDependencies> = {},
): Promise<ProviderQuotaResetConsumeResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };

  const context = await deps.readQuotaContext();
  if (!context) {
    return { ok: false, code: 'notAuthenticated', message: 'ZCode is not authenticated.' };
  }

  let credits: ProviderQuotaResetCredit[];
  try {
    credits = await fetchZCodeResetCreditList(deps, context);
  } catch (error) {
    return {
      ok: false,
      code: 'readFailed',
      message: error instanceof Error ? error.message : 'Could not read the reset card list.',
    };
  }

  const card = pickAvailableResetCredit(credits, input.resetType, deps.now());
  if (!card) {
    return { ok: false, code: 'noCard', message: 'No available quota reset card for this request.' };
  }

  try {
    const response = await deps.fetch(BIGMODEL_RESET_USE_URL, {
      method: 'POST',
      headers: {
        ...buildQuotaAuthHeaders(context),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetType: RESET_TARGET_TYPE,
        resetType: input.resetType === 'weekly' ? 'WEEK' : 'FIVE_HOUR',
        recordId: Number(card.id),
        grantType: card.grantType,
        requestId: randomUUID(),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const payload = readObjectRecord(await response.json().catch(() => null));
    if (response.ok && payload?.code === 200 && payload?.success === true) {
      quotaCache.reset();
      return {
        ok: true,
        code: 'reset',
        message: input.resetType === 'weekly'
          ? 'Weekly allowance was reset.'
          : '5-hour allowance was reset.',
      };
    }

    return {
      ok: false,
      code: 'spendFailed',
      message: readOptionalString(payload?.msg) ?? `Reset failed (HTTP ${response.status}).`,
    };
  } catch {
    return { ok: false, code: 'unknown', message: 'ZCode reset request did not confirm.' };
  }
}
