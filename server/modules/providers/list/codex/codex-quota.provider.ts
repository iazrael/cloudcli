import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';

import spawn from 'cross-spawn';

import type {
  ProviderQuotaBucket,
  ProviderQuotaData,
  ProviderQuotaGroup,
  ProviderQuotaResetConsumeInput,
  ProviderQuotaResetConsumeResult,
  ProviderQuotaResetCredit,
} from '@/shared/types.js';
import {
  createProviderQuotaCache,
  pickAvailableResetCredit,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

type CodexQuotaDependencies = {
  startAppServer: () => ChildProcess;
  now: () => number;
};

type CodexRateLimitWindow = {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
};

type CodexRateLimitSnapshot = {
  limitId?: unknown;
  limitName?: unknown;
  planType?: unknown;
  primary?: unknown;
  secondary?: unknown;
};

const CACHE_TTL_MS = 120_000;
const APP_SERVER_TIMEOUT_MS = 10_000;
const quotaCache = createProviderQuotaCache<ProviderQuotaData>(CACHE_TTL_MS);

const defaultDependencies: CodexQuotaDependencies = {
  startAppServer: () => spawn('codex', ['app-server', '--stdio'], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }),
  now: () => Date.now(),
};

const QUOTA_INITIALIZE_ID = 'cloudcli-quota-initialize';
const QUOTA_READ_ID = 'cloudcli-quota-read';
const QUOTA_CONSUME_ID = 'cloudcli-quota-consume';

function readFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readRateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  const record = readObjectRecord(value);
  return record ? record as CodexRateLimitWindow : null;
}

function resolveWindow(durationMinutes: number | null, fallback: '5h' | 'weekly'): string {
  if (durationMinutes === 300) return '5h';
  if (durationMinutes === 10_080) return 'weekly';
  return durationMinutes && durationMinutes > 0 ? `${durationMinutes}m` : fallback;
}

function createQuotaBucket(
  limitId: string,
  position: 'primary' | 'secondary',
  value: unknown,
): ProviderQuotaBucket | null {
  const windowData = readRateLimitWindow(value);
  const usedPercent = readFiniteNumber(windowData?.usedPercent);
  if (!windowData || usedPercent === null) {
    return null;
  }

  const durationMinutes = readFiniteNumber(windowData.windowDurationMins);
  const window = resolveWindow(durationMinutes, position === 'primary' ? '5h' : 'weekly');
  const remainingFraction = Math.max(0, Math.min(1, (100 - usedPercent) / 100));
  const resetsAtSeconds = readFiniteNumber(windowData.resetsAt);
  const resetTime = resetsAtSeconds !== null && resetsAtSeconds > 0
    ? new Date(resetsAtSeconds * 1000).toISOString()
    : undefined;

  return {
    id: `${limitId}-${position}-${window}`,
    name: window === '5h'
      ? 'Five Hour Limit Remaining'
      : window === 'weekly'
        ? 'Weekly Limit Remaining'
        : `${durationMinutes ?? 'Unknown'} Minute Limit Remaining`,
    description: `${Math.max(0, Math.min(100, usedPercent))}% used`,
    window,
    remainingFraction,
    resetTime,
  };
}

function normalizeSnapshot(
  value: unknown,
  fallbackLimitId: string,
): ProviderQuotaGroup | null {
  const snapshot = readObjectRecord(value) as CodexRateLimitSnapshot | null;
  if (!snapshot) {
    return null;
  }

  const limitId = readOptionalString(snapshot.limitId) ?? fallbackLimitId;
  const buckets = [
    createQuotaBucket(limitId, 'primary', snapshot.primary),
    createQuotaBucket(limitId, 'secondary', snapshot.secondary),
  ].filter((bucket): bucket is ProviderQuotaBucket => bucket !== null);

  if (buckets.length === 0) {
    return null;
  }

  const limitName = readOptionalString(snapshot.limitName);
  const planType = readOptionalString(snapshot.planType);
  return {
    name: limitName ?? (limitId === 'codex' ? 'Codex' : limitId),
    description: planType ? `Codex ${planType} plan` : undefined,
    buckets,
  };
}

/**
 * Maps the rate-limit snapshot's reset-credit inventory onto the wire model.
 *
 * Every Codex card observed so far is a full reset (`codexRateLimits` — both
 * the 5-hour and the weekly window), so it maps to `all`. Redeemed and expired
 * cards stay in the payload with `available: false` so the UI can account for
 * them; only fresh reads may be spent.
 */
function extractCodexResetCredits(snapshot: unknown): ProviderQuotaResetCredit[] {
  const snapshotRecord = readObjectRecord(snapshot);
  const inventory = readObjectRecord(snapshotRecord?.rateLimitResetCredits);
  const rawCredits = Array.isArray(inventory?.credits) ? inventory.credits : [];

  const credits = rawCredits
    .map((entry): ProviderQuotaResetCredit | null => {
      const credit = readObjectRecord(entry);
      const id = readOptionalString(credit?.id);
      const status = readOptionalString(credit?.status);
      if (!credit || !id) {
        return null;
      }

      const title = readOptionalString(credit.title);
      const rawResetType = readOptionalString(credit.resetType);
      const expiresAtSeconds = readFiniteNumber(credit.expiresAt);
      const expireTime = expiresAtSeconds !== null && expiresAtSeconds > 0
        ? new Date(expiresAtSeconds * 1000).toISOString()
        : undefined;
      return {
        id,
        // `codexRateLimits` is today's only observed card kind (full reset).
        // Unknown future kinds keep their raw name so the shared pick rule
        // never mistakes a narrower card for an `all` card.
        resetType: !rawResetType || rawResetType === 'codexRateLimits' ? 'all' : rawResetType,
        ...(title ? { title } : {}),
        available: status === 'available',
        ...(expireTime ? { expireTime } : {}),
      };
    })
    .filter((credit): credit is ProviderQuotaResetCredit => credit !== null);

  return credits;
}

function normalizeQuotaResponse(value: unknown, nowTimestamp: number): ProviderQuotaData | null {
  const response = readObjectRecord(value);
  if (!response) {
    return null;
  }

  const snapshotsById = readObjectRecord(response.rateLimitsByLimitId);
  const groups = snapshotsById && Object.keys(snapshotsById).length > 0
    ? Object.entries(snapshotsById)
      .map(([limitId, snapshot]) => normalizeSnapshot(snapshot, limitId))
      .filter((group): group is ProviderQuotaGroup => group !== null)
    : [normalizeSnapshot(response.rateLimits, 'codex')]
      .filter((group): group is ProviderQuotaGroup => group !== null);

  if (groups.length === 0) {
    return null;
  }

  const resetCredits = extractCodexResetCredits(response);
  return {
    groups,
    updatedAt: new Date(nowTimestamp).toISOString(),
    // One family, split by allowance: the gpt-reserve carve-out sits beside
    // the main pool, so a family match cannot tell them apart.
    partitioning: 'bucket' as const,
    ...(resetCredits.length > 0 ? { resetCredits: { credits: resetCredits } } : {}),
  };
}

type CodexAppServerCall = {
  id: string;
  method: string;
  params?: unknown;
};

/**
 * Opens one app-server session, performs the protocol handshake, and hands
 * `session` a `call` helper issuing one request/response round trip at a time
 * over that connection.
 *
 * The generic timeout covers the whole session: a hung read delays the consume
 * behind it, and the child is torn down either way. Handler failures settle
 * the session promise; an early child exit rejects it through `fail`.
 */
function runCodexAppServerSession(
  startAppServer: CodexQuotaDependencies['startAppServer'],
  session: (call: (request: CodexAppServerCall) => Promise<unknown>) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = startAppServer();
    const { stdin, stdout } = child;
    if (!stdin || !stdout) {
      child.kill();
      reject(new Error('Codex app-server did not expose its protocol streams'));
      return;
    }

    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let settled = false;
    let forceKillTimeout: NodeJS.Timeout | null = null;

    const hasChildExited = () => (
      (child.exitCode !== null && child.exitCode !== undefined)
      || (child.signalCode !== null && child.signalCode !== undefined)
    );

    const stopChild = () => {
      if (hasChildExited()) return;
      child.kill();
      forceKillTimeout = setTimeout(() => {
        if (!hasChildExited()) {
          child.kill('SIGKILL');
        }
      }, 1_000);
      forceKillTimeout.unref();
    };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stopChild();
      if (error) reject(error);
      else resolve();
    };

    const fail = (error: Error) => {
      if (settled) return;
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      finish(error);
    };

    const timeout = setTimeout(() => {
      fail(new Error('Timed out while talking to the Codex app-server'));
    }, APP_SERVER_TIMEOUT_MS);

    const writeMessage = (message: Record<string, unknown>) => {
      stdin.write(`${JSON.stringify(message)}\n`);
    };

    let stdoutBuffer = '';

    const call = (request: CodexAppServerCall) => new Promise((callResolve, callReject) => {
      pending.set(request.id, { resolve: callResolve, reject: callReject });
      writeMessage({ id: request.id, method: request.method, params: request.params ?? null });
    });

    child.once('error', (error) => fail(error));
    stdin.once('error', (error) => fail(error));
    child.stderr?.resume();
    child.once('exit', (code) => {
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      fail(new Error(`Codex app-server exited before completing the session (${code ?? 'unknown'})`));
    });

    stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf('\n');

      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf('\n');
        if (!line || settled) continue;

        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (message.id === QUOTA_INITIALIZE_ID) {
          const protocolError = readObjectRecord(message.error);
          if (protocolError) {
            fail(new Error(readOptionalString(protocolError.message) ?? 'Codex initialization failed'));
            continue;
          }

          writeMessage({ method: 'initialized' });
          session(call).then(
            () => finish(),
            (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
          );
          continue;
        }

        const messageId = typeof message.id === 'string' ? message.id : null;
        const pendingCall = messageId ? pending.get(messageId) : undefined;
        if (!messageId || !pendingCall) continue;
        pending.delete(messageId);

        const protocolError = readObjectRecord(message.error);
        if (protocolError) {
          pendingCall.reject(new Error(readOptionalString(protocolError.message) ?? 'Codex app-server request failed'));
        } else {
          pendingCall.resolve(message.result);
        }
      }
    });

    writeMessage({
      id: QUOTA_INITIALIZE_ID,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'cloudcli',
          title: 'CloudCLI',
          version: '1.0.0',
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

async function readCodexRateLimits(
  startAppServer: CodexQuotaDependencies['startAppServer'],
): Promise<unknown> {
  let result: unknown;
  await runCodexAppServerSession(startAppServer, async (call) => {
    result = await call({ id: QUOTA_READ_ID, method: 'account/rateLimits/read', params: null });
  });
  return result;
}

/**
 * Reads the current Codex account rate limits through the supported app-server
 * protocol and maps its rolling windows into the provider-neutral quota model.
 * Consumer: CodexProviderAuth.getQuota().
 */
export async function fetchCodexQuota(
  options: { forceRefresh?: boolean } = {},
  dependencyOverrides: Partial<CodexQuotaDependencies> = {},
): Promise<ProviderQuotaData | null> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  return quotaCache.get(
    options,
    async () => normalizeQuotaResponse(
      await readCodexRateLimits(dependencies.startAppServer),
      dependencies.now(),
    ),
    dependencies.now,
  );
}

/**
 * Spends one of the account's Codex reset credits ("banked reset").
 *
 * The same connection first reads the fresh credit inventory — the cached
 * snapshot may be 2 minutes stale and offer an already-spent card — then
 * consumes the soonest-expiring available card covering the request, which
 * for Codex is always a full (5-hour + weekly) reset. A successful spend
 * invalidates the quota cache so the next read reflects the refilled windows.
 *
 * A timeout or dropped connection maps to `code: 'unknown'` rather than a
 * clean failure: the credit may already have been spent provider-side, and
 * the UI must steer the user into re-checking the quota instead of retrying
 * into a double spend. Consumer: CodexProviderAuth.consumeQuotaReset().
 */
export async function consumeCodexQuotaReset(
  input: ProviderQuotaResetConsumeInput,
  dependencyOverrides: Partial<CodexQuotaDependencies> = {},
): Promise<ProviderQuotaResetConsumeResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  let consumeResult: unknown;
  try {
    await runCodexAppServerSession(dependencies.startAppServer, async (call) => {
      const snapshot = await call({ id: QUOTA_READ_ID, method: 'account/rateLimits/read', params: null });
      const card = pickAvailableResetCredit(extractCodexResetCredits(snapshot), input.resetType);
      if (!card) {
        consumeResult = { outcome: 'noCardAvailable' };
        return;
      }

      consumeResult = await call({
        id: QUOTA_CONSUME_ID,
        method: 'account/rateLimitResetCredit/consume',
        params: { creditId: card.id, idempotencyKey: randomUUID() },
      });
    });
  } catch (error) {
    return {
      ok: false,
      code: 'unknown',
      message: error instanceof Error ? error.message : 'Codex rate-limit reset did not confirm.',
    };
  }

  const outcome = readOptionalString(readObjectRecord(consumeResult)?.outcome) ?? 'unknown';
  if (outcome === 'reset') {
    quotaCache.reset();
    return { ok: true, code: 'reset', message: 'Codex rate limits were reset.' };
  }

  return {
    ok: false,
    code: 'noCard',
    message: outcome === 'noCardAvailable'
      ? 'No available quota reset card for this request.'
      : `Codex declined the reset (outcome: ${outcome}).`,
  };
}

/** Resets the Codex quota cache for provider module tests. */
export function resetCodexQuotaCache(): void {
  quotaCache.reset();
}
