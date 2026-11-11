/**
 * Claude Quota Provider
 *
 * Reports the claude.ai subscription rate-limit windows (the 5-hour session
 * limit and the 7-day limits) that Claude Code itself renders in `/usage`.
 *
 * The window numbers and the account's use-it-or-lose-it reset grants both
 * live on the claude.ai OAuth usage endpoint. The provider reads that endpoint
 * directly first, in one request, so the card list rides along with the
 * windows. The Agent SDK control protocol is the fallback: it owns the OAuth
 * token's silent refresh, so asking it is how an expired token is renewed
 * before the next direct attempt. Both reads are cached in front of the panel
 * (two minutes). Spending a reset is a separate, explicit path: it re-reads
 * the grants, claims one only after the user confirms, and never runs during a
 * quota read.
 *
 * Consumers:
 * - `ClaudeProviderAuth.getQuota` in `claude-auth.provider.ts`
 * - `provider-token-usage.service.ts` via the provider registry
 *
 * @module claude-quota.provider
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';
import { HttpsProxyAgent } from 'https-proxy-agent';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type {
  ProviderQuotaBucket,
  ProviderQuotaData,
  ProviderQuotaResetConsumeInput,
  ProviderQuotaResetConsumeResult,
  ProviderQuotaResetCredit,
} from '@/shared/types.js';
import {
  createProviderQuotaCache,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/** The direct OAuth usage body plus the plan label the endpoint omits. */
export type ClaudeDirectUsage = {
  payload: unknown;
  subscriptionType: string | null;
};

export type ClaudeQuotaDependencies = {
  /**
   * SDK fallback: returns the raw `/usage` payload, or null when the SDK
   * cannot answer. Used when the direct read fails, chiefly to refresh an
   * expired OAuth token before the next direct attempt.
   */
  readUsage: () => Promise<unknown>;
  /**
   * Primary read: returns the full `/api/oauth/usage` body, whose windows and
   * `cedar_ember` reset grants arrive in one request. Null when unavailable.
   */
  readDirectUsage: () => Promise<ClaudeDirectUsage | null>;
  now: () => number;
};

/** The provider-native identity a single Claude reset claim needs. */
export type ClaudeResetClaimInput = {
  organizationUuid: string;
  grantId: string;
  requestId: string;
};

/**
 * Collaborators for spending a Claude reset. Tests inject a fake claim so the
 * irreversible POST is never sent; production uses the real HTTP path.
 */
export type ClaudeResetConsumeDependencies = {
  /** Cached quota first, so a spend does not add a second back-to-back read. */
  readQuota: () => Promise<ProviderQuotaData | null>;
  readOrganizationUuid: () => Promise<string | null>;
  claimReset: (input: ClaudeResetClaimInput) => Promise<unknown>;
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

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
// `cedar_ember` asks for the reset-grant block; `skip_spend` keeps the read
// from depending on billing data the panel does not show.
const RESET_GRANTS_QUERY = '?cedar_ember=1&skip_spend=1';
const API_VERSION = '2023-06-01';
const CLI_VERSION_TIMEOUT_MS = 5_000;

const RESET_PROGRAM = 'cedar_ember';
const RESET_CLAIM_TIMEOUT_MS = 25_000;
// The claim endpoint rejects a grant id outside this shape; check locally so a
// malformed grant never reaches the irreversible POST.
const RESET_GRANT_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;

// The usage endpoint gates reset grants on a recent `claude-cli` surface; ask
// the installed binary once and keep its version for the process lifetime.
let cachedCliVersion: string | null = null;

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

/** OAuth bearer and plan label read from Claude Code's credential file. */
type ClaudeLocalCredentials = {
  accessToken: string;
  subscriptionType: string | null;
};

/**
 * Reads the OAuth bearer and plan label Claude Code already persisted. The
 * token is only ever placed in the request header and never logged. Missing or
 * unreadable credentials degrade to the SDK fallback, not to an error.
 */
async function readClaudeCredentials(): Promise<ClaudeLocalCredentials | null> {
  try {
    const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const content = await readFile(credentialsPath, 'utf8');
    const credentials = readObjectRecord(JSON.parse(content));
    const oauth = readObjectRecord(credentials?.claudeAiOauth);
    const accessToken = readOptionalString(oauth?.accessToken);
    if (!accessToken) {
      return null;
    }
    return {
      accessToken,
      subscriptionType: readOptionalString(oauth?.subscriptionType) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Reads the signed-in organization UUID from Claude Code's account metadata.
 * The reset-claim endpoint is organization-scoped; a missing organization
 * means the claim cannot be addressed and is refused before any POST.
 */
async function readClaudeOrganizationUuid(): Promise<string | null> {
  try {
    const content = await readFile(path.join(os.homedir(), '.claude.json'), 'utf8');
    const config = readObjectRecord(JSON.parse(content));
    const account = readObjectRecord(config?.oauthAccount);
    return readOptionalString(account?.organizationUuid) ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads the installed Claude Code version for the `User-Agent` that tells the
 * usage endpoint this is a CLI surface. Without it the endpoint answers
 * `eligible: false` with `reason: "surface"`, and an old version is rejected
 * with `reason: "cli_version"`. Cached for the process lifetime; an upgrade
 * needs a restart before the reported version changes.
 */
function readClaudeCliVersion(): Promise<string | null> {
  if (cachedCliVersion) {
    return Promise.resolve(cachedCliVersion);
  }

  return new Promise((resolve) => {
    const executablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude';
    const child = spawn(executablePath, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    let stdout = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (version: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cachedCliVersion = version;
      resolve(version);
    };

    timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, CLI_VERSION_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      finish(/(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null);
    });
  });
}

type HttpsRequestOptions = {
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
};

type HttpsResponseError = Error & { statusCode?: number };

/**
 * Exchanges JSON over HTTPS through the same proxy environment Claude Code
 * uses. The usage endpoint rejected Node's direct client in a proxied network
 * while the CLI's client succeeded, so the proxy is part of the contract.
 */
function requestJsonOverHttps(url: string, options: HttpsRequestOptions): Promise<unknown> {
  const proxyUrl = process.env.HTTPS_PROXY
    ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY
    ?? process.env.http_proxy;
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      agent,
    }, (response) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        const error = new Error(
          `Usage endpoint returned HTTP ${response.statusCode ?? 'unknown'}`,
        ) as HttpsResponseError;
        error.statusCode = response.statusCode ?? undefined;
        reject(error);
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error('Usage endpoint timed out'));
    });
    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

/**
 * Reads the official OAuth usage body, including the `cedar_ember` reset
 * grants. This is deliberately a GET: the claim endpoint is never called here.
 * The endpoint rate-limits back-to-back reads, which is why this request is the
 * primary source and the SDK is only the fallback.
 */
async function readDirectUsageThroughHttp(): Promise<ClaudeDirectUsage | null> {
  const [credentials, cliVersion] = await Promise.all([
    readClaudeCredentials(),
    readClaudeCliVersion(),
  ]);
  if (!credentials || !cliVersion) {
    return null;
  }

  const payload = await requestJsonOverHttps(`${USAGE_ENDPOINT}${RESET_GRANTS_QUERY}`, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      'anthropic-version': API_VERSION,
      'User-Agent': `claude-cli/${cliVersion} (external, cli)`,
    },
    timeoutMs: USAGE_TIMEOUT_MS,
  });
  return {
    payload,
    subscriptionType: credentials.subscriptionType,
  };
}

const defaultDependencies: ClaudeQuotaDependencies = {
  readUsage: readUsageThroughSdk,
  readDirectUsage: readDirectUsageThroughHttp,
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
function createQuotaBucket(
  id: string,
  name: string,
  value: unknown,
  modelScope?: string,
): ProviderQuotaBucket | null {
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
    ...(modelScope ? { modelScope } : {}),
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

type RawModelScopedWindow = {
  display_name: string;
  utilization: number;
  resets_at?: unknown;
};

/**
 * Reads the per-model weekly windows. The SDK response ships them as
 * `model_scoped`; the direct usage body sometimes leaves that field null and
 * carries the same rows as `limits[]` entries of kind `weekly_scoped`. Prefer
 * the dedicated array when it has rows, then fall back to the generic rows.
 */
function readModelScopedWindows(rateLimits: Record<string, unknown>): RawModelScopedWindow[] {
  const explicit = Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : [];
  if (explicit.length > 0) {
    return explicit as RawModelScopedWindow[];
  }

  const limits = Array.isArray(rateLimits.limits) ? rateLimits.limits : [];
  const windows: RawModelScopedWindow[] = [];
  for (const entry of limits) {
    const row = readObjectRecord(entry);
    if (!row || row.kind !== 'weekly_scoped') continue;
    const scope = readObjectRecord(row.scope);
    const model = readObjectRecord(scope?.model);
    const displayName = readOptionalString(model?.display_name);
    const utilization = row.percent;
    if (!displayName || typeof utilization !== 'number' || !Number.isFinite(utilization)) continue;
    windows.push({ display_name: displayName, utilization, resets_at: row.resets_at });
  }
  return windows;
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
    createQuotaBucket('claude-7d-opus', 'Weekly Opus Limit Remaining', rateLimits.seven_day_opus, 'Opus'),
    createQuotaBucket('claude-7d-sonnet', 'Weekly Sonnet Limit Remaining', rateLimits.seven_day_sonnet, 'Sonnet'),
  ];

  // Per-model weekly windows are additive: the server sends them only for the
  // models it currently meters separately, each carrying its own label.
  for (const entry of readModelScopedWindows(rateLimits)) {
    const record = readObjectRecord(entry);
    const displayName = readOptionalString(record?.display_name);
    if (!record || !displayName) continue;
    buckets.push(createQuotaBucket(
      toModelBucketId(displayName),
      `Weekly ${displayName} Limit Remaining`,
      record,
      displayName,
    ));
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
 * The direct usage body carries the same window fields the SDK nests under
 * `rate_limits`, but omits the plan label — the local credentials supply it.
 * Reusing the SDK normalizer keeps both sources on one bucket model.
 */
function normalizeDirectUsage(direct: ClaudeDirectUsage, nowTimestamp: number): ProviderQuotaData | null {
  return normalizeUsagePayload({
    subscription_type: direct.subscriptionType,
    rate_limits_available: true,
    rate_limits: direct.payload,
  }, nowTimestamp);
}

/**
 * Names the allowance a reset grant restores. A Fable grant also clears the
 * shared 5-hour window, so its label must win over the `clears` heuristic.
 */
function resolveResetType(clears: readonly string[], title: string | undefined): string {
  if (title?.toLowerCase().includes('fable')) {
    return 'fable';
  }
  const clearsFiveHour = clears.includes('five_hour');
  const clearsWeekly = clears.includes('seven_day');
  if (clearsFiveHour && clearsWeekly) {
    return 'all';
  }
  if (clearsWeekly) {
    return 'weekly';
  }
  if (clearsFiveHour) {
    return '5h';
  }
  return 'weekly';
}

/**
 * Maps the `cedar_ember.grants[]` block onto the shared reset-card model.
 *
 * Unreadable entries are skipped rather than failing the whole list. Used,
 * paused and expired grants stay in the list with `available: false` so the
 * panel can still report how many the account has already spent or lost.
 */
function normalizeResetCredits(payload: unknown, nowTimestamp: number): ProviderQuotaResetCredit[] {
  const cedarEmber = readObjectRecord(readObjectRecord(payload)?.cedar_ember);
  if (!cedarEmber || cedarEmber.eligible !== true || !Array.isArray(cedarEmber.grants)) {
    return [];
  }

  const credits: ProviderQuotaResetCredit[] = [];
  for (const entry of cedarEmber.grants) {
    const grant = readObjectRecord(entry);
    const id = readOptionalString(grant?.id);
    if (!grant || !id || !RESET_GRANT_ID_PATTERN.test(id)) continue;

    const resetsLeft = typeof grant.resets_left === 'number' && Number.isFinite(grant.resets_left)
      ? Math.max(0, Math.floor(grant.resets_left))
      : 0;
    const endsAt = readOptionalString(grant.ends_at);
    const resetDate = endsAt ? new Date(endsAt) : null;
    const expiresAtMs = resetDate && !Number.isNaN(resetDate.getTime())
      ? resetDate.getTime()
      : null;
    const expired = expiresAtMs !== null && expiresAtMs <= nowTimestamp;
    const clears = Array.isArray(grant.clears)
      ? grant.clears.filter((value): value is string => typeof value === 'string')
      : [];
    const title = readOptionalString(grant.label);
    const grantType = readOptionalString(grant.type);

    credits.push({
      id,
      resetType: resolveResetType(clears, title),
      ...(title ? { title } : {}),
      ...(grantType ? { grantType } : {}),
      available: resetsLeft > 0 && grant.paused !== true && !expired && grant.usable_now === true,
      ...(resetDate && expiresAtMs !== null ? { expireTime: resetDate.toISOString() } : {}),
      remaining: resetsLeft,
    });
  }
  return credits;
}

/**
 * Picks the card the user clicked: exact reset type, available, with uses
 * left, soonest expiry first. A full reset deliberately does not satisfy a
 * Fable request — the click names the card.
 */
function selectResetCredit(
  credits: readonly ProviderQuotaResetCredit[],
  resetType: string,
): ProviderQuotaResetCredit | null {
  const candidates = credits.filter((credit) => (
    credit.resetType === resetType
    && credit.available
    && (credit.remaining ?? 1) > 0
  ));
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort((left, right) => {
    const leftExpiry = left.expireTime ? Date.parse(left.expireTime) : Number.POSITIVE_INFINITY;
    const rightExpiry = right.expireTime ? Date.parse(right.expireTime) : Number.POSITIVE_INFINITY;
    return leftExpiry - rightExpiry;
  })[0];
}

/**
 * POSTs one grant to the organization-scoped reset endpoint. This is the only
 * irreversible request in the module; it is reached only from an explicit
 * consume call, never from a quota read.
 */
async function claimClaudeResetThroughHttp(input: ClaudeResetClaimInput): Promise<unknown> {
  const [credentials, cliVersion] = await Promise.all([
    readClaudeCredentials(),
    readClaudeCliVersion(),
  ]);
  if (!credentials || !cliVersion) {
    const error = new Error('Claude credentials are unavailable') as HttpsResponseError;
    error.statusCode = 401;
    throw error;
  }

  const body = JSON.stringify({
    program: RESET_PROGRAM,
    grant_id: input.grantId,
    request_id: input.requestId,
  });
  return requestJsonOverHttps(
    `https://api.anthropic.com/api/organizations/${encodeURIComponent(input.organizationUuid)}/reset_rate_limits`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'anthropic-version': API_VERSION,
        'User-Agent': `claude-cli/${cliVersion} (external, cli)`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
      timeoutMs: RESET_CLAIM_TIMEOUT_MS,
    },
  );
}

const defaultResetConsumeDependencies: ClaudeResetConsumeDependencies = {
  readQuota: () => fetchClaudeQuota(),
  readOrganizationUuid: readClaudeOrganizationUuid,
  claimReset: claimClaudeResetThroughHttp,
  now: () => Date.now(),
};

function resetOutcomeMessage(response: unknown): string {
  const record = readObjectRecord(response);
  const result = readOptionalString(record?.result);
  const reason = readOptionalString(record?.reason);
  switch (result) {
    case 'reset':
      return 'Claude reset was applied.';
    case 'already_used':
      return 'That reset card has already been used.';
    case 'not_limited':
      return 'This reset only applies after reaching its limit; your usage is still below it.';
    case 'cooldown':
      return 'Reset cards are cooling down; try again later.';
    case 'ineligible':
      return 'This account is not eligible for that reset.';
    case 'unavailable':
      return 'That reset is not available right now.';
    default:
      return reason ? `Claude reset was not applied: ${reason}` : 'Claude reset was not applied.';
  }
}

/**
 * Spends one Claude reset card after an explicit user confirmation.
 *
 * A fresh grant read runs first so a stale card is never claimed; the POST is
 * sent only when a matching available grant exists. The irreversible step is
 * never retried here: a lost response is reported as unconfirmed.
 *
 * Consumers: `ClaudeProviderAuth.consumeQuotaReset` behind
 * `POST /providers/quota/reset`.
 */
export async function consumeClaudeQuotaReset(
  input: ProviderQuotaResetConsumeInput,
  dependencyOverrides: Partial<ClaudeResetConsumeDependencies> = {},
): Promise<ProviderQuotaResetConsumeResult> {
  const dependencies = { ...defaultResetConsumeDependencies, ...dependencyOverrides };
  const quota = await dependencies.readQuota().catch(() => null);
  if (!quota) {
    return {
      ok: false,
      code: 'readFailed',
      message: 'Could not read the current Claude reset cards.',
    };
  }

  const credit = selectResetCredit(quota.resetCredits?.credits ?? [], input.resetType);
  if (!credit) {
    return {
      ok: false,
      code: 'noCard',
      message: 'No matching Claude reset card is available.',
    };
  }

  const organizationUuid = await dependencies.readOrganizationUuid();
  if (!organizationUuid) {
    return {
      ok: false,
      code: 'notAuthenticated',
      message: 'No signed-in Claude organization was found.',
    };
  }

  let response: unknown;
  try {
    response = await dependencies.claimReset({
      organizationUuid,
      grantId: credit.id,
      requestId: randomUUID(),
    });
  } catch (error) {
    const statusCode = readObjectRecord(error)?.statusCode;
    // A response means the server rejected the claim; a transport failure may
    // have happened after it was applied, so it must not invite a blind retry.
    if (typeof statusCode === 'number') {
      if (statusCode === 401 || statusCode === 403) {
        return {
          ok: false,
          code: 'notAuthenticated',
          message: 'Claude sign-in is no longer valid.',
        };
      }
      return {
        ok: false,
        code: 'spendFailed',
        message: 'Claude rejected the reset request.',
      };
    }
    return {
      ok: false,
      code: 'unknown',
      message: 'The reset response was lost. Refresh the quota to confirm before retrying.',
    };
  }

  const result = readOptionalString(readObjectRecord(response)?.result);
  if (result === 'reset') {
    quotaCache.reset();
    return { ok: true, code: 'reset', message: resetOutcomeMessage(response) };
  }
  if (result === 'already_used' || result === 'not_limited' || result === 'cooldown'
    || result === 'ineligible' || result === 'unavailable') {
    return { ok: false, code: 'spendFailed', message: resetOutcomeMessage(response) };
  }
  return {
    ok: false,
    code: 'unknown',
    message: 'The reset response was unreadable. Refresh the quota to confirm before retrying.',
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
    async () => {
      // One direct read supplies both the windows and the reset grants. The
      // SDK is the fallback (and the token refresher) when that read fails;
      // a failed direct read must never take the quota windows down with it.
      const direct = await dependencies.readDirectUsage().catch(() => null);
      if (direct) {
        const nowTimestamp = dependencies.now();
        const quota = normalizeDirectUsage(direct, nowTimestamp);
        if (quota) {
          const resetCredits = normalizeResetCredits(direct.payload, nowTimestamp);
          return resetCredits.length > 0
            ? { ...quota, resetCredits: { credits: resetCredits } }
            : quota;
        }
      }

      return normalizeUsagePayload(await dependencies.readUsage(), dependencies.now());
    },
    dependencies.now,
  );
}
