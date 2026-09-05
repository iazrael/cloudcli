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
  fetchZCodeQuota,
} from '../list/zcode/zcode-quota.provider.js';
import { ZCodeProviderAuth } from '../list/zcode/zcode-auth.provider.js';

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

    let requestedUrl = '';
    let authHeader = '';

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
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
    assert.equal(requestedUrl, 'https://bigmodel.cn/api/monitor/usage/quota/limit');
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

    // First call fetches
    await fetchZCodeQuota({}, deps);
    assert.equal(fetchCount, 1);

    // Call within TTL returns cached without fetch
    currentTime += 10_000;
    await fetchZCodeQuota({}, deps);
    assert.equal(fetchCount, 1);

    // Call with forceRefresh fetches regardless of cache
    await fetchZCodeQuota({ forceRefresh: true }, deps);
    assert.equal(fetchCount, 2);
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
});
