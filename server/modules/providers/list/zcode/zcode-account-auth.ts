import { createHash } from 'node:crypto';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { readZCodeIndividualPlanAuthContext } from './zcode-credentials.js';
import { getZCodeStorageDir } from './zcode-data-root.js';
import { readZCodeAppVersion, tryResolveEnginePath } from './zcode-engine-path.js';

// One active account only. Tokens never reach disk or logs; changing the login
// or project invalidates both the cached token and any outstanding exchange.
let cached: {
  scope: string;
  expiresAt: number;
  auth?: { apiKey: string; apiKeyId: string; accountScope: string };
  pending?: Promise<{ apiKey: string; apiKeyId: string; accountScope: string }>;
} | undefined;

function contextScope(context: ReturnType<typeof readZCodeIndividualPlanAuthContext>): string {
  return createHash('sha256').update(JSON.stringify([getZCodeStorageDir(), context])).digest('hex');
}

/** Runtime header bridge consumer: exchanges only the active personal project's login for model auth. */
export async function resolveZCodeIndividualPlanRequestAuth(params: Record<string, unknown>): Promise<{
  apiKey: string; apiKeyId?: string; accountScope?: string;
}> {
  const context = readZCodeIndividualPlanAuthContext();
  if (!context || context.kind === 'unavailable') {
    throw new Error(context?.error ?? 'ZCode individual plan credential is missing or ambiguous');
  }
  if (context.kind === 'legacy') {
    if (params.expectedAccountScope !== undefined || params.rejectedProjectTokenFingerprint !== undefined) {
      throw new Error('ZCode project token account changed');
    }
    return { apiKey: context.apiKey };
  }
  const scope = contextScope(context);
  if ((params.expectedAccountScope !== undefined && params.expectedAccountScope !== scope)
      || (params.rejectedProjectTokenFingerprint && !params.expectedAccountScope)) {
    throw new Error('ZCode project token account changed');
  }
  const access = readObjectRecord(params.accountAccess);
  if (params.accountAccess !== undefined && (!access || access.accountType !== 'bigmodel'
      || access.mode !== 'individual-coding-plan' || access.entitled !== true)) {
    throw new Error('ZCode personal project does not match requested account access');
  }
  if (cached?.scope !== scope) cached = { scope, expiresAt: 0 };
  const entry = cached;
  if (entry.auth && params.rejectedProjectTokenFingerprint === createHash('sha256').update(entry.auth.apiKey).digest('hex')) {
    entry.auth = undefined;
  }
  if (entry.auth && Date.now() < entry.expiresAt - 120_000) return entry.auth;
  if (entry.pending) return entry.pending;
  const pending = (async () => {
    const enginePath = tryResolveEnginePath();
    const version = enginePath ? readZCodeAppVersion(enginePath) : null;
    const url = `https://bigmodel.cn/api/biz/v1/organization/${encodeURIComponent(context.organizationId)}/projects/${encodeURIComponent(context.projectId)}/api_keys/${encodeURIComponent(context.apiKeyId)}/access_tokens`;
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${context.loginToken.replace(/^Bearer\s+/i, '')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientType: 'zcode', clientVersion: version ?? '3.18.2' }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Boundary: do not propagate request diagnostics that could contain credentials.
      throw new Error('ZCode project token request failed or timed out');
    }
    if (!response.ok) throw new Error(`ZCode project token request rejected (HTTP ${response.status})`);
    let body: Record<string, unknown> | null;
    try { body = readObjectRecord(await response.json()); }
    catch { throw new Error('ZCode project token response is invalid'); }
    const data = readObjectRecord(body?.data);
    const apiKey = readOptionalString(data?.accessToken);
    const expiresIn = data?.expiresIn;
    const expiresAt = data?.expiresAt;
    if (![200, 0, '200', '0'].includes(body?.code as number | string)
        || (data?.enable !== undefined && data.enable !== true) || !apiKey || data?.tokenType !== 'Bearer'
        || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0
        || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      throw new Error('ZCode project token is unavailable or the response is invalid');
    }
    const expiration = Math.min(expiresAt * 1000, startedAt + expiresIn * 1000);
    if (expiration <= Date.now()) throw new Error('ZCode project token is already expired');
    if (scope !== contextScope(readZCodeIndividualPlanAuthContext())) throw new Error('ZCode project token account changed');
    const auth = { apiKey, apiKeyId: context.apiKeyId, accountScope: scope };
    entry.auth = auth;
    entry.expiresAt = expiration;
    return auth;
  })();
  entry.pending = pending;
  try { return await pending; }
  finally { entry.pending = undefined; }
}
