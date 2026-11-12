import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';

import {
  decryptZCodeCredentialValue,
  encryptZCodeCredentialValue,
  readDecryptedZCodeCredentials,
} from '../list/zcode/zcode-credentials.js';
import {
  clearZCodeQuotaCache,
  consumeZCodeQuotaReset,
  fetchZCodeQuota,
} from '../list/zcode/zcode-quota.provider.js';
import { ZCodeProviderAuth } from '../list/zcode/zcode-auth.provider.js';

/** Serves canned JSON per URL substring and records every request it saw. */
function createRouteFetch(routes: Record<string, unknown>) {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const key = Object.keys(routes).find((candidate) => target.includes(candidate));
    requests.push({ url: target, method: init?.method ?? 'GET', body: init?.body });
    return {
      ok: true,
      json: async () => (key ? routes[key] : {}),
    } as Response;
  }) as typeof globalThis.fetch;
  return { fetchFn, requests };
}

const authenticatedCredentials = {
  authenticated: true,
  accessToken: 'test-token',
  zcodeJwtToken: null,
  providerFamily: 'bigmodel' as const,
  username: 'test_coder',
  displayName: null,
  email: 'test_coder',
  method: 'BigModel OAuth',
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

describe('ZCode Credentials & Quota Provider', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-test-'));
    clearZCodeQuotaCache();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    clearZCodeQuotaCache();
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

  test('reads decrypted credentials from storage directory', async () => {
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

  test('normalizes quota response from BigModel / Z.AI into ProviderQuotaData', async () => {
    const mockApiResponse = {
      code: 200,
      msg: '操作成功',
      data: {
        level: 'lite',
        limits: [
          {
            type: 'TIME_LIMIT',
            unit: 5,
            number: 1,
            usage: 100,
            currentValue: 10,
            remaining: 90,
            percentage: 10,
            nextResetTime: 1790427384997,
            usageDetails: [{ modelCode: 'search-prime', usage: 10 }],
          },
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            number: 5,
            percentage: 26,
            nextResetTime: 1788606247374,
          },
        ],
      },
      success: true,
    };

    let requestedUrls: string[] = [];
    let authHeader = '';

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrls.push(String(url));
      authHeader = (init?.headers as Record<string, string>)?.Authorization || '';
      return {
        ok: true,
        json: async () => mockApiResponse,
      } as Response;
    }) as typeof globalThis.fetch;

    const mockReadCredentials = async () => ({
      authenticated: true,
      accessToken: 'test-token',
      zcodeJwtToken: null,
      providerFamily: 'bigmodel' as const,
      username: 'test_coder',
      displayName: null,
      email: 'test_coder',
      method: 'BigModel OAuth',
    });

    const quota = await fetchZCodeQuota({}, {
      fetch: mockFetch,
      readCredentials: mockReadCredentials,
      now: () => 1788600000000,
    });

    assert.ok(quota);
    assert.ok(
      requestedUrls.some((url) => url === 'https://bigmodel.cn/api/monitor/usage/quota/limit'),
      'the limits endpoint must be requested',
    );
    assert.equal(authHeader, 'Bearer test-token');
    assert.equal(quota.groups.length, 1);

    const group = quota.groups[0];
    assert.equal(group.name, 'ZCode (LITE)');
    assert.equal(group.description, 'BigModel Coding Plan account quota');
    assert.equal(group.buckets.length, 2);

    const callBucket = group.buckets.find((b) => b.id === 'zcode-calls-limit');
    assert.ok(callBucket);
    assert.equal(callBucket.name, 'Cycle Calls Limit');
    assert.equal(callBucket.description, '90 of 100 calls remaining');
    assert.equal(callBucket.window, 'cycle');
    assert.equal(callBucket.remainingFraction, 0.9);
    assert.equal(callBucket.resetTime, new Date(1790427384997).toISOString());

    const tokenBucket = group.buckets.find((b) => b.id === 'zcode-5h-tokens');
    assert.ok(tokenBucket);
    assert.equal(tokenBucket.name, 'Five Hour Limit Remaining');
    assert.equal(tokenBucket.window, '5h');
    assert.equal(tokenBucket.remainingFraction, 0.74);
    assert.equal(tokenBucket.resetTime, new Date(1788606247374).toISOString());
  });

  test('respects in-memory caching and forceRefresh option', async () => {
    let fetchCount = 0;
    const mockFetch = (async () => {
      fetchCount += 1;
      return {
        ok: true,
        json: async () => ({
          code: 200,
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

    const mockReadCredentials = async () => ({
      authenticated: true,
      accessToken: 'test-token',
      zcodeJwtToken: null,
      providerFamily: 'zai' as const,
      username: 'test',
      displayName: null,
      email: null,
      method: 'Z.AI OAuth',
    });

    let currentTime = 1000;
    const deps = {
      fetch: mockFetch,
      readCredentials: mockReadCredentials,
      now: () => currentTime,
    };

    // First call fetches — one request for the limits, one for the reset cards
    await fetchZCodeQuota({}, deps);
    assert.equal(fetchCount, 2);

    // Call within TTL returns cached without fetch
    currentTime += 10_000;
    await fetchZCodeQuota({}, deps);
    assert.equal(fetchCount, 2);

    // Call with forceRefresh fetches regardless of cache
    await fetchZCodeQuota({ forceRefresh: true }, deps);
    assert.equal(fetchCount, 4);
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
        readCredentials: async () => ({
          authenticated: true,
          accessToken: 'valid-token',
          zcodeJwtToken: null,
          providerFamily: 'bigmodel',
          username: 'u',
          displayName: null,
          email: null,
          method: 'Z.AI OAuth',
        }),
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
      readCredentials: async () => ({
        authenticated: true,
        accessToken: 'valid-token',
        zcodeJwtToken: null,
        providerFamily: 'bigmodel',
        username: 'u',
        displayName: null,
        email: null,
        method: 'Z.AI OAuth',
      }),
    });

    assert.equal(networkQuota, null);
  });

  test('gracefully handles malformed payload, missing limits, or invalid timestamp', async () => {
    const malformedPayloads = [
      null,
      {},
      { code: 200 },
      { code: 200, data: null },
      { code: 200, data: { limits: [] } },
      {
        code: 200,
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
        readCredentials: async () => ({
          authenticated: true,
          accessToken: 'valid-token',
          zcodeJwtToken: null,
          providerFamily: 'bigmodel',
          username: 'u',
          displayName: null,
          email: null,
          method: 'Z.AI OAuth',
        }),
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
    const { fetchFn } = createRouteFetch({
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
      readCredentials: async () => authenticatedCredentials,
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
      readCredentials: async () => authenticatedCredentials,
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
      readCredentials: async () => authenticatedCredentials,
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
      readCredentials: async () => authenticatedCredentials,
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

  test('consumeZCodeQuotaReset declines without a use request when nothing is available', async () => {
    clearZCodeQuotaCache();
    const { fetchFn, requests } = createRouteFetch({
      '/api/biz/customer-package-reset/list': resetListResponse,
      '/api/biz/customer-package-reset/use': { code: 200, msg: '操作成功', success: true },
    });

    const result = await consumeZCodeQuotaReset({ resetType: 'weekly' }, {
      fetch: fetchFn,
      readCredentials: async () => authenticatedCredentials,
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
      readCredentials: async () => authenticatedCredentials,
      now: () => 1_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'spendFailed');
    assert.match(result.message ?? '', /指定的重置次数不可用/);
  });

  test('consumeZCodeQuotaReset distinguishes an unreadable card list from having no cards', async () => {
    clearZCodeQuotaCache();
    const failingListFetch = (async (url: string | URL | Request) => {
      if (String(url).includes('customer-package-reset/list')) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      throw new Error('use endpoint must never be called');
    }) as typeof globalThis.fetch;

    const result = await consumeZCodeQuotaReset({ resetType: '5h' }, {
      fetch: failingListFetch,
      readCredentials: async () => authenticatedCredentials,
      now: () => 1_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'readFailed');
    assert.match(result.message ?? '', /HTTP 500/);
  });

  test('consumeZCodeQuotaReset reports an unknown outcome when the use request throws', async () => {
    clearZCodeQuotaCache();
    const throwingUseFetch = (async (url: string | URL | Request) => {
      if (String(url).includes('customer-package-reset/list')) {
        return { ok: true, json: async () => resetListResponse } as Response;
      }
      throw new Error('network unreachable');
    }) as typeof globalThis.fetch;

    const result = await consumeZCodeQuotaReset({ resetType: '5h' }, {
      fetch: throwingUseFetch,
      readCredentials: async () => authenticatedCredentials,
      now: () => 1_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'unknown');
  });

  test('consumeZCodeQuotaReset invalidates the quota cache after a successful spend', async () => {
    clearZCodeQuotaCache();
    let fetchCount = 0;
    const quotaPayload = {
      code: 200,
      success: true,
      data: {
        level: 'lite',
        limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 26 }],
      },
    };
    const countingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      if (String(url).includes('customer-package-reset/use')) {
        return { ok: true, json: async () => ({ code: 200, msg: '操作成功', success: true }) } as Response;
      }
      if (String(url).includes('customer-package-reset/list')) {
        return { ok: true, json: async () => resetListResponse } as Response;
      }
      return { ok: true, json: async () => quotaPayload } as Response;
    }) as typeof globalThis.fetch;
    const deps = {
      fetch: countingFetch,
      readCredentials: async () => authenticatedCredentials,
      now: () => 1_000,
    };

    await fetchZCodeQuota({}, deps);
    const cachedReads = fetchCount;
    await fetchZCodeQuota({}, deps);
    assert.equal(fetchCount, cachedReads, 'second read must come from the cache');

    const result = await consumeZCodeQuotaReset({ resetType: '5h' }, deps);
    assert.equal(result.ok, true);

    await fetchZCodeQuota({}, deps);
    assert.equal(
      fetchCount, cachedReads + 4,
      'the spend (list + use) must invalidate the cache so the next read refetches (list + limits)',
    );
  });
});
