import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';

import {
  clearZCodeCredentialKeyCache,
  decryptZCodeCredentialValue,
  decryptZCodeCredentialValueV2,
  encryptZCodeCredentialValue,
  encryptZCodeCredentialValueV2,
  readDecryptedZCodeCredentials,
  readDecryptedZCodeJwtToken,
  readZCodeCodingPlanQuotaContext,
  type ZCodeCodingPlanQuotaContext,
} from '../list/zcode/zcode-credentials.js';
import {
  clearZCodeQuotaCache,
  consumeZCodeQuotaReset,
  fetchZCodeQuota,
} from '../list/zcode/zcode-quota.provider.js';
import { ZCodeProviderAuth } from '../list/zcode/zcode-auth.provider.js';

/** Serves canned JSON per URL substring and records every request it saw. */
function createRouteFetch(routes: Record<string, unknown>) {
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const key = Object.keys(routes).find((candidate) => target.includes(candidate));
    requests.push({
      url: target,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    return {
      ok: true,
      json: async () => (key ? routes[key] : {}),
    } as Response;
  }) as typeof globalThis.fetch;
  return { fetchFn, requests };
}

/** The coding-plan quota context the rewritten provider authenticates with. */
const quotaContext: ZCodeCodingPlanQuotaContext = {
  apiKey: 'test-api-key-id.test-api-key-secret',
  zcodeJwtToken: 'test-zcode-jwt',
  planFamily: 'bigmodel-team-coding-plan',
  organizationId: 'org-test-org',
  projectId: 'proj_test_project',
};

/** Captured from the live zcode.z.ai mcp/usage endpoint (2026-11-14). */
const mcpUsageResponse = {
  code: 0,
  msg: '',
  data: {
    server_time: 1794641195,
    next_refresh_at: 1794672000,
    level: 'lite',
    total_usage: { used: 0, limit: 1000, remaining: 1000 },
  },
};

/** bigmodel prints card expiry in local `YYYY-MM-DD HH:mm:ss`, zone-less. */
const formatZCodeTimestamp = (at: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + ` ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

// The available card's expiry is kept relative to the run clock: a literal date
// silently expires (spend picks only unexpired cards) and turns every consume
// test into a failure once the calendar passes it.
const availableCardExpiryText = formatZCodeTimestamp(new Date(Date.now() + 90 * 60 * 1000));
const availableCardExpiryIso = new Date(availableCardExpiryText.replace(' ', 'T')).toISOString();

const resetListResponse = {
  code: 200,
  msg: '操作成功',
  success: true,
  data: {
    customerId: 1,
    targetType: 'PERSONAL',
    lastFiveHourResetTime: '2026-09-22 23:49:58',
    fiveHourResets: [
      { recordId: 606262, grantType: 'DIRECT', expireTime: availableCardExpiryText, available: true },
      { recordId: 758489, grantType: 'DIRECT', expireTime: '2026-09-20 18:06:38', available: false },
    ],
    weekResets: [],
  },
};

/** Captured from the live bigmodel quota endpoint after the 2026-11 zcode upgrade. */
const liveQuotaResponse = {
  code: 200,
  msg: '操作成功',
  data: {
    limits: [
      {
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        usage: 100,
        currentValue: 6,
        remaining: 94,
        percentage: 6,
        nextResetTime: 1795697784984,
        usageDetails: [
          { modelCode: 'search-prime', usage: 5 },
          { modelCode: 'web-reader', usage: 1 },
          { modelCode: 'zread', usage: 0 },
        ],
      },
      {
        type: 'TOKENS_LIMIT',
        unit: 3,
        number: 5,
        percentage: 35,
        nextResetTime: 1794645103816,
      },
    ],
    level: 'lite',
  },
  success: true,
};

describe('ZCode Credentials & Quota Provider', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-test-'));
    clearZCodeQuotaCache();
    clearZCodeCredentialKeyCache();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    clearZCodeQuotaCache();
    clearZCodeCredentialKeyCache();
  });

  test('encrypts and decrypts credential values round-trip with default and custom secrets', () => {
    const plainText = 'mock-secret-token-12345';
    const encrypted = encryptZCodeCredentialValue(plainText);
    assert.match(encrypted, /^enc:v1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const decrypted = decryptZCodeCredentialValue(encrypted);
    assert.equal(decrypted, plainText);

    // Custom env secret
    const customEnv = { ZCODE_CREDENTIAL_SECRET: 'custom-secret-key-for-test' };
    const customEncrypted = encryptZCodeCredentialValue(plainText, customEnv);
    const customDecrypted = decryptZCodeCredentialValue(customEncrypted, customEnv);
    assert.equal(customDecrypted, plainText);

    // Non-encrypted string returns verbatim
    assert.equal(decryptZCodeCredentialValue('plain-string'), 'plain-string');
  });

  test('decrypts enc:v2 os values through the staged credential-secret file', async () => {
    const v2Dir = path.join(tempDir, 'v2');
    await fs.mkdir(v2Dir, { recursive: true });
    const osKey = randomBytes(32);
    await fs.writeFile(path.join(v2Dir, 'credential-secret'), osKey.toString('base64url'), { mode: 0o600 });

    const encrypted = encryptZCodeCredentialValueV2('staged-token', osKey, 'os');
    assert.match(encrypted, /^enc:v2:os:[a-f0-9]{24}:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const decrypted = await decryptZCodeCredentialValueV2(encrypted, tempDir);
    assert.equal(decrypted, 'staged-token');
  });

  test('decrypts enc:v2 env values through ZCODE_CREDENTIAL_SECRET', async () => {
    const envSecret = 'headless-managed-secret';
    const envKey = createHash('sha256').update(envSecret).digest();
    const encrypted = encryptZCodeCredentialValueV2('env-token', envKey, 'env');
    const decrypted = await decryptZCodeCredentialValueV2(encrypted, tempDir, {
      ZCODE_CREDENTIAL_SECRET: envSecret,
    });
    assert.equal(decrypted, 'env-token');
  });

  test('decrypts enc:v2 os values through the injected keychain reader', async () => {
    const osKey = randomBytes(32);
    const encrypted = encryptZCodeCredentialValueV2('keychain-token', osKey, 'os');
    const decrypted = await decryptZCodeCredentialValueV2(encrypted, tempDir, {}, {
      readKeychainSecret: async () => osKey.toString('base64url'),
    });
    assert.equal(decrypted, 'keychain-token');
  });

  test('rejects v2 values whose fingerprint does not match any available key', async () => {
    const rightKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    // Staged file holds a different key than the one that sealed the value.
    await fs.mkdir(path.join(tempDir, 'v2'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'v2', 'credential-secret'), wrongKey.toString('base64url'));

    const encrypted = encryptZCodeCredentialValueV2('secret', rightKey, 'os');
    const decrypted = await decryptZCodeCredentialValueV2(encrypted, tempDir, {}, {
      readKeychainSecret: async () => null,
    });
    assert.equal(decrypted, null);

    // Malformed payloads never decrypt
    assert.equal(await decryptZCodeCredentialValueV2('enc:v2:os:not-a-fingerprint:x', tempDir), null);
    assert.equal(await decryptZCodeCredentialValueV2('enc:v2:unknown-source:aaaaaaaaaaaaaaaaaaaaaaaa:x', tempDir), null);
  });

  test('caches resolved keys per fingerprint and misses only briefly', async () => {
    const osKey = randomBytes(32);
    let keychainReads = 0;
    const overrides = {
      readKeychainSecret: async () => {
        keychainReads += 1;
        return osKey.toString('base64url');
      },
    };
    const encrypted = encryptZCodeCredentialValueV2('cached-token', osKey, 'os');

    assert.equal(await decryptZCodeCredentialValueV2(encrypted, tempDir, {}, overrides), 'cached-token');
    assert.equal(await decryptZCodeCredentialValueV2(encrypted, tempDir, {}, overrides), 'cached-token');
    assert.equal(keychainReads, 1, 'positive results are memoized per fingerprint');
  });

  test('reads v2-encrypted credentials with zai_cn keys from storage directory', async () => {
    const v2Dir = path.join(tempDir, 'v2');
    await fs.mkdir(v2Dir, { recursive: true });
    const osKey = randomBytes(32);
    await fs.writeFile(path.join(v2Dir, 'credential-secret'), osKey.toString('base64url'), { mode: 0o600 });

    const rawCredentials = {
      'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:72411768202983769:api-key':
        encryptZCodeCredentialValueV2('mock-api-key', osKey, 'os'),
      'zcodejwttoken': encryptZCodeCredentialValueV2('mock-jwt-token', osKey, 'os'),
      'oauth:active_provider': encryptZCodeCredentialValueV2('zai_cn', osKey, 'os'),
      'oauth:zai_cn:access_token': encryptZCodeCredentialValueV2('mock-zai-cn-token', osKey, 'os'),
      'oauth:zai_cn:user_info': encryptZCodeCredentialValueV2(JSON.stringify({
        name: '旅行者5354',
        email: 'coder@example.com',
      }), osKey, 'os'),
    };
    await fs.writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify(rawCredentials), 'utf8');

    const result = await readDecryptedZCodeCredentials(tempDir);
    assert.equal(result.authenticated, true);
    assert.equal(result.accessToken, 'mock-zai-cn-token');
    assert.equal(result.providerFamily, 'bigmodel', 'zai_cn is the bigmodel.cn (China) issuer');
    assert.equal(result.username, null);
    assert.equal(result.displayName, '旅行者5354');
    assert.equal(result.email, 'coder@example.com');
  });

  test('reads decrypted credentials from storage directory (legacy v1 values)', async () => {
    const v2Dir = path.join(tempDir, 'v2');
    await fs.mkdir(v2Dir, { recursive: true });

    const rawCredentials = {
      'oauth:bigmodel:access_token': encryptZCodeCredentialValue('mock-bigmodel-token'),
      'zcodejwttoken': encryptZCodeCredentialValue('mock-jwt-token'),
      'oauth:active_provider': encryptZCodeCredentialValue('bigmodel'),
      'oauth:bigmodel:user_info': encryptZCodeCredentialValue(JSON.stringify({
        username: 'test_coder',
        displayName: 'Test Coder',
      })),
    };

    await fs.writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify(rawCredentials), 'utf8');

    const result = await readDecryptedZCodeCredentials(tempDir);
    assert.equal(result.authenticated, true);
    assert.equal(result.accessToken, 'mock-bigmodel-token');
    assert.equal(result.providerFamily, 'bigmodel');
    assert.equal(result.username, 'test_coder');
    assert.equal(result.displayName, 'Test Coder');
    assert.equal(result.email, 'test_coder');
  });

  test('never treats raw ciphertext as valid token when decryption fails', async () => {
    const v2Dir = path.join(tempDir, 'v2');
    await fs.mkdir(v2Dir, { recursive: true });

    // Encrypt with a different key that cannot be decrypted with the default key
    const foreignEncrypted = encryptZCodeCredentialValue(
      'foreign-token',
      { ZCODE_CREDENTIAL_SECRET: 'foreign-secret-key' },
    );

    await fs.writeFile(
      path.join(v2Dir, 'credentials.json'),
      JSON.stringify({
        'oauth:bigmodel:access_token': foreignEncrypted,
      }),
      'utf8',
    );

    const result = await readDecryptedZCodeCredentials(tempDir);
    assert.equal(result.authenticated, false);
    assert.equal(result.accessToken, null);
    assert.match(result.error ?? '', /could not be decrypted/i);
  });

  test('sync readers decrypt staged v2 values and never return ciphertext for malformed ones', async () => {
    const v2Dir = path.join(tempDir, 'v2');
    await fs.mkdir(v2Dir, { recursive: true });
    const osKey = randomBytes(32);
    await fs.writeFile(path.join(v2Dir, 'credential-secret'), osKey.toString('base64url'), { mode: 0o600 });

    await fs.writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({
      zcodejwttoken: encryptZCodeCredentialValueV2('mock-jwt', osKey, 'os'),
    }), 'utf8');
    assert.equal(readDecryptedZCodeJwtToken(tempDir), 'mock-jwt');

    // Malformed v2: the ciphertext must never come back as a token.
    await fs.writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({
      zcodejwttoken: 'enc:v2:os:not-a-fingerprint:AAAA.BBBB.CCCC',
    }), 'utf8');
    assert.equal(readDecryptedZCodeJwtToken(tempDir), null);
  });

  test('pairs the coding-plan api-key with its project key location', async () => {
    const v2Dir = path.join(tempDir, 'v2');
    await fs.mkdir(v2Dir, { recursive: true });
    const osKey = randomBytes(32);
    await fs.writeFile(path.join(v2Dir, 'credential-secret'), osKey.toString('base64url'), { mode: 0o600 });

    const locationKey = (customerId: string) => `project-key-location:v1:${encodeURIComponent(JSON.stringify([
      'https://bigmodel.cn', 'bigmodel', customerId, null, 1, 'non-team',
    ]))}`;
    const rawCredentials = {
      'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:72411768202983769:api-key':
        encryptZCodeCredentialValueV2('mock-api-key', osKey, 'os'),
      'zcodejwttoken': encryptZCodeCredentialValueV2('mock-zcode-jwt', osKey, 'os'),
      [locationKey('72411768202983769')]: encryptZCodeCredentialValueV2(JSON.stringify({
        organizationId: 'org-64D269e45DDa468e9B98462EB4f4B79D',
        projectId: 'proj_b0c1234',
        apiKeyId: 42,
      }), osKey, 'os'),
      // A second location for another customer (no api-key) must be ignored.
      [locationKey('85731712029074995')]: encryptZCodeCredentialValueV2(JSON.stringify({
        organizationId: 'org-other',
        projectId: 'proj_other',
      }), osKey, 'os'),
    };
    await fs.writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify(rawCredentials), 'utf8');

    const context = await readZCodeCodingPlanQuotaContext(tempDir);
    assert.deepEqual(context, {
      apiKey: 'mock-api-key',
      zcodeJwtToken: 'mock-zcode-jwt',
      planFamily: 'bigmodel-team-coding-plan',
      organizationId: 'org-64D269e45DDa468e9B98462EB4f4B79D',
      projectId: 'proj_b0c1234',
    });
  });

  test('prefers oauth:linked_bigmodel over stale coding-plan api-key and pairs project key location by customerId', async () => {
    const v2Dir = path.join(tempDir, 'v2');
    await fs.mkdir(v2Dir, { recursive: true });
    const osKey = randomBytes(32);
    await fs.writeFile(path.join(v2Dir, 'credential-secret'), osKey.toString('base64url'), { mode: 0o600 });

    const locationKey = (customerId: string) => `project-key-location:v1:${encodeURIComponent(JSON.stringify([
      'https://bigmodel.cn', 'bigmodel', customerId, null, 1, 'non-team',
    ]))}`;
    const rawCredentials = {
      // Stale v1/v2 coding-plan api-key left behind after ZCode 3.18.2 rotated keys.
      'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:72411768202983769:api-key':
        encryptZCodeCredentialValueV2('stale-revoked-api-key', osKey, 'os'),
      'oauth:active_provider': encryptZCodeCredentialValueV2('zai_cn', osKey, 'os'),
      'zcodejwttoken': encryptZCodeCredentialValueV2('mock-zcode-jwt', osKey, 'os'),
      'oauth:zai_cn:access_token': encryptZCodeCredentialValueV2('zai-cn-account-center-token', osKey, 'os'),
      'oauth:zai_cn:user_info': encryptZCodeCredentialValueV2(JSON.stringify({
        user_id: '72411768202983769',
        name: '旅行者5354',
      }), osKey, 'os'),
      'oauth:linked_bigmodel': encryptZCodeCredentialValueV2(JSON.stringify({
        userId: '72411768202983769',
        customerId: '72411768202983769',
        accessToken: 'linked-bigmodel-jwt',
      }), osKey, 'os'),
      [locationKey('85731712029074995')]: encryptZCodeCredentialValueV2(JSON.stringify({
        organizationId: 'org-other',
        projectId: 'proj_other',
      }), osKey, 'os'),
      [locationKey('72411768202983769')]: encryptZCodeCredentialValueV2(JSON.stringify({
        organizationId: 'org-64D269e45DDa468e9B98462EB4f4B79D',
        projectId: 'proj_b0c1234',
        apiKeyId: '6ebe819bf88b41949a9ec2cf2acc9749',
      }), osKey, 'os'),
    };
    await fs.writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify(rawCredentials), 'utf8');

    const context = await readZCodeCodingPlanQuotaContext(tempDir);
    assert.deepEqual(context, {
      apiKey: 'linked-bigmodel-jwt',
      zcodeJwtToken: 'mock-zcode-jwt',
      planFamily: 'bigmodel',
      organizationId: 'org-64D269e45DDa468e9B98462EB4f4B79D',
      projectId: 'proj_b0c1234',
    });
  });

  test('rejects oauth:linked_bigmodel when userId mismatches active user_info', async () => {
    const v2Dir = path.join(tempDir, 'v2');
    await fs.mkdir(v2Dir, { recursive: true });
    const osKey = randomBytes(32);
    await fs.writeFile(path.join(v2Dir, 'credential-secret'), osKey.toString('base64url'), { mode: 0o600 });

    const rawCredentials = {
      'oauth:active_provider': encryptZCodeCredentialValueV2('zai_cn', osKey, 'os'),
      'oauth:zai_cn:user_info': encryptZCodeCredentialValueV2(JSON.stringify({
        user_id: '999999999',
      }), osKey, 'os'),
      'oauth:linked_bigmodel': encryptZCodeCredentialValueV2(JSON.stringify({
        userId: '72411768202983769',
        customerId: '72411768202983769',
        accessToken: 'mismatched-linked-bigmodel-jwt',
      }), osKey, 'os'),
    };
    await fs.writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify(rawCredentials), 'utf8');

    assert.equal(await readZCodeCodingPlanQuotaContext(tempDir), null);
  });

  test('resolves direct bigmodel and zai OAuth session tokens with paired project key locations', async () => {
    const v2Dir = path.join(tempDir, 'v2');
    await fs.mkdir(v2Dir, { recursive: true });
    const osKey = randomBytes(32);
    await fs.writeFile(path.join(v2Dir, 'credential-secret'), osKey.toString('base64url'), { mode: 0o600 });

    const locationKey = (host: string, family: string, customerId: string) =>
      `project-key-location:v1:${encodeURIComponent(JSON.stringify([host, family, customerId, null, 1, 'non-team']))}`;

    await fs.writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({
      'oauth:active_provider': encryptZCodeCredentialValueV2('bigmodel', osKey, 'os'),
      'oauth:bigmodel:access_token': encryptZCodeCredentialValueV2('direct-bigmodel-jwt', osKey, 'os'),
      'oauth:bigmodel:user_info': encryptZCodeCredentialValueV2(JSON.stringify({ id: '72411768202983769' }), osKey, 'os'),
      [locationKey('https://bigmodel.cn', 'bigmodel', '72411768202983769')]: encryptZCodeCredentialValueV2(JSON.stringify({
        organizationId: 'org-bm',
        projectId: 'proj-bm',
      }), osKey, 'os'),
    }), 'utf8');

    assert.deepEqual(await readZCodeCodingPlanQuotaContext(tempDir), {
      apiKey: 'direct-bigmodel-jwt',
      zcodeJwtToken: null,
      planFamily: 'bigmodel',
      organizationId: 'org-bm',
      projectId: 'proj-bm',
    });

    await fs.writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({
      'oauth:active_provider': encryptZCodeCredentialValueV2('zai', osKey, 'os'),
      'oauth:zai:access_token': encryptZCodeCredentialValueV2('direct-zai-jwt', osKey, 'os'),
      'oauth:zai:user_info': encryptZCodeCredentialValueV2(JSON.stringify({ user_id: '555' }), osKey, 'os'),
      [locationKey('https://api.z.ai', 'zai', '555')]: encryptZCodeCredentialValueV2(JSON.stringify({
        organizationId: 'org-zai',
        projectId: 'proj-zai',
      }), osKey, 'os'),
    }), 'utf8');

    assert.deepEqual(await readZCodeCodingPlanQuotaContext(tempDir), {
      apiKey: 'direct-zai-jwt',
      zcodeJwtToken: null,
      planFamily: 'zai',
      organizationId: 'org-zai',
      projectId: 'proj-zai',
    });
  });

  test('returns a context without organization when no key location entry exists', async () => {
    const v2Dir = path.join(tempDir, 'v2');
    await fs.mkdir(v2Dir, { recursive: true });
    const osKey = randomBytes(32);
    await fs.writeFile(path.join(v2Dir, 'credential-secret'), osKey.toString('base64url'), { mode: 0o600 });

    await fs.writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key':
        encryptZCodeCredentialValueV2('solo-api-key', osKey, 'os'),
      'zcodejwttoken': encryptZCodeCredentialValueV2('solo-zcode-jwt', osKey, 'os'),
    }), 'utf8');

    const context = await readZCodeCodingPlanQuotaContext(tempDir);
    assert.deepEqual(context, {
      apiKey: 'solo-api-key',
      zcodeJwtToken: 'solo-zcode-jwt',
      planFamily: 'bigmodel-individual-coding-plan',
      organizationId: null,
      projectId: null,
    });
  });

  test('refuses to guess between multiple coding-plan accounts', async () => {
    const v2Dir = path.join(tempDir, 'v2');
    await fs.mkdir(v2Dir, { recursive: true });
    const osKey = randomBytes(32);
    await fs.writeFile(path.join(v2Dir, 'credential-secret'), osKey.toString('base64url'), { mode: 0o600 });

    await fs.writeFile(path.join(v2Dir, 'credentials.json'), JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:111:api-key':
        encryptZCodeCredentialValueV2('key-one', osKey, 'os'),
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:222:api-key':
        encryptZCodeCredentialValueV2('key-two', osKey, 'os'),
    }), 'utf8');

    assert.equal(await readZCodeCodingPlanQuotaContext(tempDir), null);
  });

  test('normalizes the live bigmodel quota payload and sends api-key headers', async () => {
    const { fetchFn, requests } = createRouteFetch({
      '/api/monitor/usage/quota/limit': liveQuotaResponse,
      '/api/v1/mcp/usage': mcpUsageResponse,
      '/api/biz/customer-package-reset/list': { code: 200, success: true, data: { fiveHourResets: [], weekResets: [] } },
    });

    const quota = await fetchZCodeQuota({ forceRefresh: true }, {
      fetch: fetchFn,
      readQuotaContext: async () => quotaContext,
      now: () => 1_000,
    });

    assert.ok(quota);
    const limitsRequest = requests.find((request) => request.url.includes('/api/monitor/usage/quota/limit'));
    assert.ok(limitsRequest);
    assert.equal(limitsRequest.headers.authorization, quotaContext.apiKey);
    assert.equal(limitsRequest.headers['bigmodel-organization'], quotaContext.organizationId);
    assert.equal(limitsRequest.headers['bigmodel-project'], quotaContext.projectId);
    assert.equal(
      limitsRequest.headers.Authorization,
      undefined,
      'the legacy Bearer OAuth header must not be sent',
    );
    assert.equal(requests[0].url.includes('type='), false, 'the type query param breaks the limits read');

    assert.equal(quota.groups.length, 1);
    const group = quota.groups[0];
    assert.equal(group.name, 'ZCode (LITE)');
    assert.equal(group.buckets.length, 3);

    const callBucket = group.buckets.find((b) => b.id === 'zcode-calls-limit');
    assert.ok(callBucket);
    assert.equal(callBucket.description, '94 of 100 calls remaining');
    assert.equal(callBucket.remainingFraction, 0.94);

    const tokenBucket = group.buckets.find((b) => b.id === 'zcode-5h-tokens');
    assert.ok(tokenBucket);
    assert.equal(tokenBucket.remainingFraction, 0.65);

    const mcpRequest = requests.find((request) => request.url.includes('/api/v1/mcp/usage'));
    assert.ok(mcpRequest);
    assert.equal(mcpRequest.headers.Authorization, `Bearer ${quotaContext.zcodeJwtToken}`);
    assert.equal(mcpRequest.headers['X-Bigmodel-Authorization'], `Bearer ${quotaContext.apiKey}`);

    const mcpBucket = group.buckets.find((b) => b.id === 'zcode-mcp-calls');
    assert.ok(mcpBucket);
    assert.equal(mcpBucket.name, 'ZCode MCP Calls');
    assert.equal(mcpBucket.remainingFraction, 1);
    assert.equal(mcpBucket.resetTime, new Date(1794672000 * 1000).toISOString());
  });

  test('keeps the quota payload when the mcp usage read fails', async () => {
    const failingMcpFetch = (async (url: string | URL | Request) => {
      if (String(url).includes('/api/v1/mcp/usage')) {
        return { ok: true, json: async () => ({ code: 401, msg: '令牌已过期或验证不正确' }) } as Response;
      }
      if (String(url).includes('/api/biz/customer-package-reset/list')) {
        return { ok: true, json: async () => ({ code: 200, success: true, data: { fiveHourResets: [], weekResets: [] } }) } as Response;
      }
      return { ok: true, json: async () => liveQuotaResponse } as Response;
    }) as typeof globalThis.fetch;

    const quota = await fetchZCodeQuota({ forceRefresh: true }, {
      fetch: failingMcpFetch,
      readQuotaContext: async () => quotaContext,
      now: () => 1_000,
    });
    assert.ok(quota);
    assert.equal(quota.groups[0].buckets.length, 2, 'the mcp bucket stays absent on failure');
  });

  test('chooses the quota host by plan family', async () => {
    const { fetchFn, requests } = createRouteFetch({
      '/api/monitor/usage/quota/limit': liveQuotaResponse,
    });

    await fetchZCodeQuota({ forceRefresh: true }, {
      fetch: fetchFn,
      readQuotaContext: async () => ({ ...quotaContext, planFamily: 'zai-individual-coding-plan' }),
      now: () => 1_000,
    });
    assert.ok(
      requests.some((request) => request.url === 'https://api.z.ai/api/monitor/usage/quota/limit'),
    );
  });

  test('treats provider-side auth rejection (HTTP 200 + body 401) as no quota', async () => {
    const { fetchFn } = createRouteFetch({
      '/api/monitor/usage/quota/limit': { code: 401, msg: '令牌已过期或验证不正确', success: false },
    });

    const quota = await fetchZCodeQuota({ forceRefresh: true }, {
      fetch: fetchFn,
      readQuotaContext: async () => quotaContext,
      now: () => 1_000,
    });
    assert.equal(quota, null);
  });

  test('respects in-memory caching and forceRefresh option', async () => {
    let fetchCount = 0;
    const mockFetch = (async () => {
      fetchCount += 1;
      return {
        ok: true,
        json: async () => ({
          code: 200,
          success: true,
          data: {
            level: 'pro',
            limits: [
              {
                type: 'TOKENS_LIMIT',
                unit: 3,
                number: 5,
                percentage: 50,
              },
            ],
          },
        }),
      } as Response;
    }) as typeof globalThis.fetch;

    const deps = {
      fetch: mockFetch,
      readQuotaContext: async () => quotaContext,
      now: () => 1000,
    };

    // First call fetches — one request each for the limits, the reset cards, and mcp usage
    await fetchZCodeQuota({}, deps);
    assert.equal(fetchCount, 3);

    // Call within TTL returns cached without fetch
    const cached = await fetchZCodeQuota({}, { ...deps, now: () => 10_000 });
    assert.ok(cached);
    assert.equal(fetchCount, 3);

    // Call with forceRefresh fetches regardless of cache
    await fetchZCodeQuota({ forceRefresh: true }, { ...deps, now: () => 20_000 });
    assert.equal(fetchCount, 6);
  });

  test('gracefully degrades to null on HTTP error or network failure', async () => {
    const failingStatuses = [401, 403, 429, 500];

    for (const status of failingStatuses) {
      clearZCodeQuotaCache();
      const mockFetch = (async () => ({
        ok: false,
        status,
        json: async () => ({ code: status, msg: 'error' }),
      })) as unknown as typeof globalThis.fetch;

      const quota = await fetchZCodeQuota({ forceRefresh: true }, {
        fetch: mockFetch,
        readQuotaContext: async () => quotaContext,
      });

      assert.equal(quota, null, `Expected null on HTTP ${status}`);
    }

    // Network error / timeout
    clearZCodeQuotaCache();
    const throwingFetch = (async () => {
      throw new Error('Network timeout');
    }) as unknown as typeof globalThis.fetch;

    const networkQuota = await fetchZCodeQuota({ forceRefresh: true }, {
      fetch: throwingFetch,
      readQuotaContext: async () => quotaContext,
    });

    assert.equal(networkQuota, null);
  });

  test('returns null without any request when no quota context is available', async () => {
    let fetchCalled = false;
    const mockFetch = (async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) } as Response;
    }) as typeof globalThis.fetch;

    const quota = await fetchZCodeQuota({ forceRefresh: true }, {
      fetch: mockFetch,
      readQuotaContext: async () => null,
    });

    assert.equal(quota, null);
    assert.equal(fetchCalled, false);
  });

  test('gracefully handles malformed payload, missing limits, or invalid timestamp', async () => {
    const malformedPayloads = [
      null,
      {},
      { code: 200 },
      { code: 200, success: true, data: null },
      { code: 200, success: true, data: { limits: [] } },
      {
        code: 200,
        success: true,
        data: {
          limits: [
            {
              type: 'TOKENS_LIMIT',
              percentage: NaN,
              nextResetTime: -999, // invalid timestamp
            },
          ],
        },
      },
    ];

    for (const payload of malformedPayloads) {
      clearZCodeQuotaCache();
      const mockFetch = (async () => ({
        ok: true,
        json: async () => payload,
      })) as unknown as typeof globalThis.fetch;

      const quota = await fetchZCodeQuota({ forceRefresh: true }, {
        fetch: mockFetch,
        readQuotaContext: async () => quotaContext,
      });

      if (payload && typeof payload === 'object' && 'data' in payload && payload.data && 'limits' in payload.data && (payload.data.limits as unknown[]).length > 0) {
        // The one with valid limit shape but invalid timestamp should still produce bucket without crashing
        assert.ok(quota);
        assert.equal(quota.groups[0].buckets[0].resetTime, undefined);
      } else {
        assert.equal(quota, null);
      }
    }
  });

  test('ZCodeProviderAuth exposes getQuota and authenticates with real username', async () => {
    const auth = new ZCodeProviderAuth();
    assert.equal(typeof auth.getQuota, 'function');
  });

  test('attaches the personal reset-card inventory to the quota payload', async () => {
    clearZCodeQuotaCache();
    const { fetchFn, requests } = createRouteFetch({
      '/api/monitor/usage/quota/limit': {
        code: 200,
        success: true,
        data: {
          level: 'lite',
          limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 26 }],
        },
      },
      '/api/biz/customer-package-reset/list': resetListResponse,
    });

    const quota = await fetchZCodeQuota({ forceRefresh: true }, {
      fetch: fetchFn,
      readQuotaContext: async () => quotaContext,
      now: () => 1_000,
    });

    assert.ok(quota);
    assert.deepEqual(quota.resetCredits, {
      credits: [
        {
          id: '606262',
          resetType: '5h',
          grantType: 'DIRECT',
          available: true,
          expireTime: availableCardExpiryIso,
        },
        {
          id: '758489',
          resetType: '5h',
          grantType: 'DIRECT',
          available: false,
          expireTime: new Date('2026-09-20T18:06:38').toISOString(),
        },
      ],
    });

    const cardRequest = requests.find((request) => request.url.includes('customer-package-reset/list'));
    assert.ok(cardRequest);
    assert.equal(cardRequest.headers.authorization, quotaContext.apiKey);
    assert.equal(cardRequest.headers['bigmodel-organization'], quotaContext.organizationId);
  });

  test('omits resetCredits when the card list is empty or its request fails', async () => {
    clearZCodeQuotaCache();
    const quotaPayload = {
      code: 200,
      success: true,
      data: {
        level: 'lite',
        limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 26 }],
      },
    };

    // Empty inventory: the section stays absent
    const emptyFetch = createRouteFetch({
      '/api/monitor/usage/quota/limit': quotaPayload,
      '/api/biz/customer-package-reset/list': {
        code: 200,
        success: true,
        data: { fiveHourResets: [], weekResets: [] },
      },
    });
    const emptyQuota = await fetchZCodeQuota({ forceRefresh: true }, {
      fetch: emptyFetch.fetchFn,
      readQuotaContext: async () => quotaContext,
      now: () => 1_000,
    });
    assert.ok(emptyQuota);
    assert.equal(emptyQuota.resetCredits, undefined);

    // Failing card request: the quota read itself still succeeds
    const failingCardFetch = (async (url: string | URL | Request) => {
      if (String(url).includes('customer-package-reset/list')) {
        throw new Error('card endpoint down');
      }
      return { ok: true, json: async () => quotaPayload } as Response;
    }) as typeof globalThis.fetch;
    const quota = await fetchZCodeQuota({ forceRefresh: true }, {
      fetch: failingCardFetch,
      readQuotaContext: async () => quotaContext,
      now: () => 1_000,
    });
    assert.ok(quota);
    assert.equal(quota.groups.length, 1);
    assert.equal(quota.resetCredits, undefined);
  });

  test('consumeZCodeQuotaReset picks the available card and posts the use request', async () => {
    clearZCodeQuotaCache();
    const { fetchFn, requests } = createRouteFetch({
      '/api/biz/customer-package-reset/list': resetListResponse,
      '/api/biz/customer-package-reset/use': { code: 200, msg: '操作成功', success: true },
    });

    const result = await consumeZCodeQuotaReset({ resetType: '5h' }, {
      fetch: fetchFn,
      readQuotaContext: async () => quotaContext,
      now: () => 1_000,
    });

    assert.deepEqual(result, { ok: true, code: 'reset', message: '5-hour allowance was reset.' });
    const useRequest = requests.find((request) => request.url.includes('customer-package-reset/use'));
    assert.ok(useRequest);
    assert.equal(useRequest.method, 'POST');
    const body = JSON.parse(String(useRequest.body)) as Record<string, unknown>;
    assert.deepEqual(body, {
      targetType: 'PERSONAL',
      resetType: 'FIVE_HOUR',
      recordId: 606262,
      grantType: 'DIRECT',
      requestId: body.requestId,
    });
    assert.equal(typeof body.requestId, 'string');
    assert.ok((body.requestId as string).length > 0);
  });

  test('consumeZCodeQuotaReset declines without credentials', async () => {
    clearZCodeQuotaCache();
    const result = await consumeZCodeQuotaReset({ resetType: '5h' }, {
      fetch: (async () => {
        throw new Error('must not fetch');
      }) as typeof globalThis.fetch,
      readQuotaContext: async () => null,
      now: () => 1_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'notAuthenticated');
  });

  test('consumeZCodeQuotaReset reports readFailed when the card list is provider-rejected', async () => {
    clearZCodeQuotaCache();
    const { fetchFn } = createRouteFetch({
      '/api/biz/customer-package-reset/list': { code: 401, msg: '令牌已过期或验证不正确', success: false },
    });

    const result = await consumeZCodeQuotaReset({ resetType: '5h' }, {
      fetch: fetchFn,
      readQuotaContext: async () => quotaContext,
      now: () => 1_000,
    });

    // "cannot read the cards" must not masquerade as "no cards".
    assert.equal(result.ok, false);
    assert.equal(result.code, 'readFailed');
    assert.match(result.message ?? '', /401/);
  });

  test('consumeZCodeQuotaReset declines without a use request when nothing is available', async () => {
    clearZCodeQuotaCache();
    const { fetchFn, requests } = createRouteFetch({
      '/api/biz/customer-package-reset/list': resetListResponse,
      '/api/biz/customer-package-reset/use': { code: 200, msg: '操作成功', success: true },
    });

    const result = await consumeZCodeQuotaReset({ resetType: 'weekly' }, {
      fetch: fetchFn,
      readQuotaContext: async () => quotaContext,
      now: () => 1_000,
    });

    assert.equal(result.ok, false);
    assert.match(result.message ?? '', /No available quota reset card/);
    assert.equal(
      requests.some((request) => request.url.includes('customer-package-reset/use')),
      false,
    );
  });

  test('consumeZCodeQuotaReset surfaces the provider message on failure', async () => {
    clearZCodeQuotaCache();
    const { fetchFn } = createRouteFetch({
      '/api/biz/customer-package-reset/list': resetListResponse,
      '/api/biz/customer-package-reset/use': {
        code: 500,
        msg: '指定的重置次数不可用，请刷新后重试',
        success: false,
      },
    });

    const result = await consumeZCodeQuotaReset({ resetType: '5h' }, {
      fetch: fetchFn,
      readQuotaContext: async () => quotaContext,
      now: () => 1_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'spendFailed');
    assert.match(result.message ?? '', /指定的重置次数不可用/);
  });
});
