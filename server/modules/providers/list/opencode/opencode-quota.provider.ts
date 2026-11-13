/**
 * OpenCode Quota Provider
 *
 * Reports the OpenCode Go plan usage meters (rolling 5-hour, weekly, monthly)
 * of the workspace the local OpenCode CLI is signed in to.
 *
 * The meters come from OpenCode's undocumented Go usage endpoint, mirroring
 * what the CLI itself reads (usage-limits.ts in the opencode repository).
 * The endpoint answers 403 for workspaces without a Go subscription, 401 for
 * an expired token; both — like every transport failure — degrade to "no
 * quota" rather than an error. Token refresh stays with the CLI: once the user
 * runs opencode again the rewritten credential row heals the next read.
 *
 * Consumers:
 * - `OpenCodeProviderAuth.getQuota` in `opencode-auth.provider.ts`
 * - `provider-token-usage.service.ts` via the provider registry
 *
 * @module opencode-quota.provider
 */

import { readFile } from 'node:fs/promises';

import Database from 'better-sqlite3';

import {
  getOpenCodeAuthPath,
  getOpenCodeDatabasePath,
} from '@/modules/providers/list/opencode/opencode-data-root.js';
import type { AnyRecord, ProviderQuotaBucket, ProviderQuotaData } from '@/shared/types.js';
import {
  createProviderQuotaCache,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

export type OpenCodeQuotaCredential = {
  token: string;
  /**
   * Workspace id. Go API keys already identify their workspace and leave this
   * empty; only console OAuth credentials need it to scope the usage query.
   */
  orgId: string;
  orgName?: string;
  /** The console server's origin, e.g. `https://opencode.ai`. */
  origin: string;
};

export type OpenCodeQuotaDependencies = {
  readCredential: () => Promise<OpenCodeQuotaCredential | null>;
  fetch: typeof globalThis.fetch;
  now: () => number;
};

const DEFAULT_CONSOLE_SERVER = 'https://opencode.ai/console';
const GO_USAGE_PATH = '/zen/go/v1/usage';
const GO_INTEGRATION_ID = 'opencode-go';
const CONSOLE_INTEGRATION_ID = 'opencode';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 120_000;

const quotaCache = createProviderQuotaCache<ProviderQuotaData>(CACHE_TTL_MS);

/**
 * Resets the in-memory quota cache. Used in tests to ensure isolation.
 */
export function clearOpenCodeQuotaCache(): void {
  quotaCache.reset();
}

type RawGoMeter = {
  status?: unknown;
  percent?: unknown;
  resetsAt?: unknown;
};

/**
 * Maps one Go usage meter onto a quota bucket. Windows the payload omits are
 * skipped; `rate-limited` forces the bucket empty even below 100%, because the
 * provider refuses requests regardless of the remaining percentage.
 */
function createGoBucket(id: string, name: string, window: string, meter: unknown): ProviderQuotaBucket | null {
  const record = readObjectRecord(meter) as RawGoMeter | null;
  if (!record) {
    return null;
  }

  const rawPercent = Number(record.percent);
  if (!Number.isFinite(rawPercent)) {
    return null;
  }
  const percent = Math.max(0, Math.min(100, rawPercent));
  const limited = readOptionalString(record.status) === 'rate-limited';
  const resetsAt = readOptionalString(record.resetsAt);
  const resetDate = resetsAt ? new Date(resetsAt) : null;

  return {
    id,
    name,
    description: `${percent}% used`,
    window,
    remainingFraction: limited ? 0 : (100 - percent) / 100,
    resetTime: resetDate && !Number.isNaN(resetDate.getTime())
      ? resetDate.toISOString()
      : undefined,
  };
}

/**
 * Normalizes the raw Go usage payload into the provider-neutral quota model.
 *
 * Returns null when the payload carries no readable meter, which the dialog
 * renders as "no account quota" rather than as an error.
 */
export function normalizeGoUsagePayload(payload: unknown, orgName: string | undefined, nowTimestamp: number): ProviderQuotaData | null {
  const record = readObjectRecord(payload);
  const usage = readObjectRecord(record?.usage);
  if (!usage) {
    return null;
  }

  const buckets = [
    createGoBucket('opencode-go-5h', 'Rolling 5 Hours', '5h', usage.rolling),
    createGoBucket('opencode-go-weekly', 'Weekly', 'weekly', usage.weekly),
    createGoBucket('opencode-go-monthly', 'Monthly', 'monthly', usage.monthly),
  ].filter((bucket): bucket is ProviderQuotaBucket => bucket !== null);

  if (buckets.length === 0) {
    return null;
  }

  return {
    groups: [{
      name: orgName ? `OpenCode Go (${orgName})` : 'OpenCode Go',
      description: 'OpenCode Go plan usage',
      buckets,
    }],
    updatedAt: new Date(nowTimestamp).toISOString(),
    // One plan (Go), split by allowance rather than by model family.
    partitioning: 'bucket',
  };
}

/**
 * Fetches the signed-in workspace's Go plan usage status.
 *
 * Consumer: OpenCodeProviderAuth.getQuota and provider-token-usage.service.
 */
export async function fetchOpenCodeQuota(
  options: { forceRefresh?: boolean } = {},
  dependencyOverrides: Partial<OpenCodeQuotaDependencies> = {},
): Promise<ProviderQuotaData | null> {
  const deps: OpenCodeQuotaDependencies = {
    readCredential: readActiveCredential,
    fetch: globalThis.fetch,
    now: () => Date.now(),
    ...dependencyOverrides,
  };

  return quotaCache.get(
    options,
    async () => {
      try {
        const credential = await deps.readCredential();
        if (!credential) {
          return null;
        }

        const headers: Record<string, string> = {
          Authorization: `Bearer ${credential.token}`,
          Accept: 'application/json',
        };
        // A Go API key already names its workspace; the endpoint rejects a
        // mismatched org header, so only console OAuth credentials carry one.
        if (credential.orgId) {
          headers['x-opencode-org-id'] = credential.orgId;
        }

        const response = await deps.fetch(`${credential.origin}${GO_USAGE_PATH}`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          // 403 = workspace has no Go plan, 401 = expired token; both are
          // "nothing to show" for the quota dialog, never an error.
          return null;
        }

        return normalizeGoUsagePayload(await response.json(), credential.orgName, deps.now());
      } catch {
        // Fail closed: timeouts and network errors degrade gracefully to null.
        return null;
      }
    },
    deps.now,
  );
}

type RawCredentialValue = {
  type?: unknown;
  access?: unknown;
  key?: unknown;
  metadata?: unknown;
};

/** Resolves the console origin, defaulting when `metadata.server` is absent. */
function resolveOrigin(metadata: AnyRecord | null): string {
  const server = readOptionalString(metadata?.server) ?? DEFAULT_CONSOLE_SERVER;
  try {
    return new URL(server).origin;
  } catch {
    return new URL(DEFAULT_CONSOLE_SERVER).origin;
  }
}

/**
 * Decodes one credential row. A `key` token (the Go plan's `oc_sk_…` API key)
 * already names its workspace and is usable on its own; an OAuth `access`
 * token needs the workspace id that scopes the usage query, so rows without
 * one are skipped.
 */
function decodeCredential(value: RawCredentialValue): OpenCodeQuotaCredential | null {
  const key = readOptionalString(value.key);
  const access = readOptionalString(value.access);
  const token = key ?? access;
  if (!token) {
    return null;
  }

  const metadata = readObjectRecord(value.metadata);
  const orgId = readOptionalString(metadata?.orgID) ?? '';
  if (!key && !orgId) {
    return null;
  }

  return {
    token,
    orgId,
    orgName: readOptionalString(metadata?.orgName),
    origin: resolveOrigin(metadata),
  };
}

/**
 * Reads the CLI's credential rows from its shared SQLite database — the same
 * table `opencode-auth.provider.ts` reads for login status.
 *
 * Go API keys live under `opencode-go`; console OAuth logins live under
 * `opencode` and carry the workspace id in `metadata.orgID`. The API key is
 * preferred because that is the credential a Go subscription writes, and it
 * is the one the usage endpoint accepts on its own.
 *
 * Returns null when the database is absent, unreadable, or neither row
 * carries a usable token; a read-only connection never blocks against the
 * CLI's WAL writes.
 */
function readDatabaseCredential(): OpenCodeQuotaCredential | null {
  let db: Database.Database;
  try {
    db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }

  try {
    const selectLatest = db.prepare(
      'SELECT value FROM credential WHERE integration_id = ? AND active = 1 ORDER BY time_updated DESC, time_created DESC LIMIT 1',
    );
    for (const integrationId of [GO_INTEGRATION_ID, CONSOLE_INTEGRATION_ID]) {
      const row = selectLatest.get(integrationId) as { value?: unknown } | undefined;
      // The CLI stores the credential value as a JSON-encoded string.
      const value = readJsonRecord(row?.value) as RawCredentialValue | null;
      if (!value) {
        continue;
      }
      const credential = decodeCredential(value);
      if (credential) {
        return credential;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Reads the v1-era `opencode-go.key` from `auth.json`. v2 moved credentials
 * into the database, so this only serves layouts the CLI has not migrated.
 */
async function readLegacyCredential(): Promise<OpenCodeQuotaCredential | null> {
  try {
    const auth = readObjectRecord(JSON.parse(await readFile(getOpenCodeAuthPath(), 'utf8')));
    const goCredential = readObjectRecord(auth?.[GO_INTEGRATION_ID]);
    const token = readOptionalString(goCredential?.key) ?? readOptionalString(goCredential?.access);
    if (!token) {
      return null;
    }
    return {
      token,
      orgId: '',
      origin: new URL(DEFAULT_CONSOLE_SERVER).origin,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves the credential the Go usage call should use: the v2 database
 * first (API key, then console OAuth), falling back to the v1 auth file.
 */
async function readActiveCredential(): Promise<OpenCodeQuotaCredential | null> {
  return readDatabaseCredential() ?? readLegacyCredential();
}
