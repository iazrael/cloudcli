import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';

import { OpenCodeProviderAuth } from '../list/opencode/opencode-auth.provider.js';
import {
  clearOpenCodeQuotaCache,
  fetchOpenCodeQuota,
} from '../list/opencode/opencode-quota.provider.js';

const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

type FetchCapture = {
  url?: string;
  authorization?: string;
};

/**
 * Builds a fetch stub that records the request and answers with the given
 * payload, so normalization can be exercised without network access.
 */
const createMockFetch = (
  payload: unknown,
  capture: FetchCapture = {},
): typeof globalThis.fetch => {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.authorization = new Headers(init?.headers).get('authorization') ?? undefined;
    return {
      ok: true,
      json: async () => payload,
    } as Response;
  }) as typeof globalThis.fetch;
};

const readGoApiKey = async () => 'go-test-key';

/** Writes one fixture auth store under a throwaway home directory. */
const withOpenCodeAuthStore = async (
  auth: Record<string, unknown>,
  runTest: () => Promise<void>,
): Promise<void> => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-quota-'));
  const originalHomedir = os.homedir;

  try {
    const authDir = path.join(homeDir, '.local', 'share', 'opencode');
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, 'auth.json'), JSON.stringify(auth), 'utf8');

    (os as any).homedir = () => homeDir;
    await runTest();
  } finally {
    (os as any).homedir = originalHomedir;
    await rm(homeDir, { recursive: true, force: true });
  }
};

describe('OpenCode Go Quota Provider', () => {
  beforeEach(() => {
    clearOpenCodeQuotaCache();
  });

  afterEach(() => {
    clearOpenCodeQuotaCache();
  });

  test('normalizes the official usage payload into one quota group', async () => {
    const capture: FetchCapture = {};
    const quota = await fetchOpenCodeQuota({}, {
      fetch: createMockFetch({
        usage: {
          rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:27:38.287Z' },
          weekly: { status: 'ok', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' },
          monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-13T06:06:01.287Z' },
        },
      }, capture),
      readApiKey: readGoApiKey,
      now: () => 1_000,
    });

    assert.equal(capture.url, OPENCODE_GO_USAGE_URL);
    assert.equal(capture.authorization, 'Bearer go-test-key');
    assert.ok(quota);
    assert.equal(quota.groups.length, 1);
    assert.equal(quota.groups[0].name, 'OpenCode Go');
    assert.equal(quota.groups[0].description, 'OpenCode Go subscription account quota');
    assert.deepEqual(
      quota.groups[0].buckets.map((bucket) => ({
        id: bucket.id,
        window: bucket.window,
        remainingFraction: bucket.remainingFraction,
        resetTime: bucket.resetTime,
      })),
      [
        {
          id: 'opencode-go-rolling',
          window: '5h',
          remainingFraction: 0.96,
          resetTime: '2026-08-13T16:27:38.287Z',
        },
        {
          id: 'opencode-go-weekly',
          window: 'weekly',
          remainingFraction: 0.97,
          resetTime: '2026-08-17T00:00:00.287Z',
        },
        {
          id: 'opencode-go-monthly',
          window: 'monthly',
          remainingFraction: 0.99,
          resetTime: '2026-09-13T06:06:01.287Z',
        },
      ],
    );
    assert.equal(quota.updatedAt, new Date(1_000).toISOString());
  });

  test('treats non-ok windows as spent and skips windows without a percent', async () => {
    const quota = await fetchOpenCodeQuota({ forceRefresh: true }, {
      fetch: createMockFetch({
        usage: {
          rolling: { status: 'rate_limited', percent: 42 },
          weekly: { status: 'ok' },
          monthly: { status: 'ok', percent: 150 },
        },
      }),
      readApiKey: readGoApiKey,
    });

    assert.ok(quota);
    assert.deepEqual(
      quota.groups[0].buckets.map((bucket) => [bucket.id, bucket.remainingFraction]),
      [
        ['opencode-go-rolling', 0],
        ['opencode-go-monthly', 0],
      ],
    );
    assert.equal(quota.groups[0].buckets[0].resetTime, undefined);
  });

  test('returns null without calling the API when no Go key is stored', async () => {
    let fetchCount = 0;
    const quota = await fetchOpenCodeQuota({}, {
      fetch: (async () => {
        fetchCount += 1;
        throw new Error('fetch should not be called without an API key');
      }) as unknown as typeof globalThis.fetch,
      readApiKey: async () => null,
    });

    assert.equal(quota, null);
    assert.equal(fetchCount, 0);
  });

  test('degrades to null on HTTP errors, network failures, or malformed payloads', async () => {
    for (const status of [401, 403, 429, 500]) {
      clearOpenCodeQuotaCache();
      const quota = await fetchOpenCodeQuota({ forceRefresh: true }, {
        fetch: (async () => ({
          ok: false,
          status,
          json: async () => ({}),
        })) as unknown as typeof globalThis.fetch,
        readApiKey: readGoApiKey,
      });

      assert.equal(quota, null, `Expected null on HTTP ${status}`);
    }

    for (const payload of [null, {}, { usage: null }, { usage: { rolling: {} } }]) {
      clearOpenCodeQuotaCache();
      const quota = await fetchOpenCodeQuota({ forceRefresh: true }, {
        fetch: createMockFetch(payload),
        readApiKey: readGoApiKey,
      });

      assert.equal(quota, null);
    }

    clearOpenCodeQuotaCache();
    const networkQuota = await fetchOpenCodeQuota({ forceRefresh: true }, {
      fetch: (async () => {
        throw new Error('Network timeout');
      }) as unknown as typeof globalThis.fetch,
      readApiKey: readGoApiKey,
    });

    assert.equal(networkQuota, null);
  });

  test('caches quota reads and honors forceRefresh', async () => {
    let fetchCount = 0;
    let currentTime = 1_000;
    const dependencies = {
      fetch: (async () => {
        fetchCount += 1;
        return {
          ok: true,
          json: async () => ({ usage: { rolling: { status: 'ok', percent: 1 } } }),
        } as Response;
      }) as typeof globalThis.fetch,
      readApiKey: readGoApiKey,
      now: () => currentTime,
    };

    await fetchOpenCodeQuota({}, dependencies);
    assert.equal(fetchCount, 1);

    currentTime += 10_000;
    await fetchOpenCodeQuota({}, dependencies);
    assert.equal(fetchCount, 1);

    currentTime += 60_000;
    await fetchOpenCodeQuota({}, dependencies);
    assert.equal(fetchCount, 2);

    await fetchOpenCodeQuota({ forceRefresh: true }, dependencies);
    assert.equal(fetchCount, 3);
  });

  test('reads the opencode-go key from the real auth store', async () => {
    await withOpenCodeAuthStore(
      {
        opencode: { type: 'api', key: 'zen-key' },
        'opencode-go': { type: 'api', key: 'go-fixture-key' },
      },
      async () => {
        const capture: FetchCapture = {};
        const quota = await fetchOpenCodeQuota({ forceRefresh: true }, {
          fetch: createMockFetch({ usage: { rolling: { status: 'ok', percent: 5 } } }, capture),
        });

        assert.equal(capture.authorization, 'Bearer go-fixture-key');
        assert.ok(quota);
        assert.equal(quota.groups[0].buckets[0].remainingFraction, 0.95);
      },
    );
  });

  test('returns null for a Zen-only auth store', async () => {
    await withOpenCodeAuthStore(
      { opencode: { type: 'api', key: 'zen-key' } },
      async () => {
        let fetchCount = 0;
        const quota = await fetchOpenCodeQuota({ forceRefresh: true }, {
          fetch: (async () => {
            fetchCount += 1;
            throw new Error('fetch should not be called for a Zen-only store');
          }) as unknown as typeof globalThis.fetch,
        });

        assert.equal(quota, null);
        assert.equal(fetchCount, 0);
      },
    );
  });

  test('OpenCodeProviderAuth exposes getQuota', () => {
    const auth = new OpenCodeProviderAuth();
    assert.equal(typeof auth.getQuota, 'function');
  });
});
