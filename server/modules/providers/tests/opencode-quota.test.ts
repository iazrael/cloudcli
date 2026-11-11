import assert from 'node:assert/strict';
import os from 'node:os';
import test, { afterEach, beforeEach, describe } from 'node:test';

import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  clearOpenCodeQuotaCache,
  fetchOpenCodeQuota,
  normalizeGoUsagePayload,
  type OpenCodeQuotaCredential,
} from '../list/opencode/opencode-quota.provider.js';

/** Serves canned JSON per URL substring and records every request it saw. */
function createRouteFetch(routes: Record<string, unknown>) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const key = Object.keys(routes).find((candidate) => target.includes(candidate));
    const headers = Object.fromEntries(new Headers(init?.headers)) as Record<string, string>;
    requests.push({ url: target, headers });
    if (!key) {
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => routes[key] } as Response;
  }) as typeof globalThis.fetch;
  return { fetchFn, requests };
}

const credential: OpenCodeQuotaCredential = {
  token: 'test-token',
  orgId: 'org_test1234',
  orgName: 'Gogogo',
  origin: 'https://opencode.ai',
};

const goUsagePayload = {
  usage: {
    rolling: { status: 'ok', percent: 19, resetsAt: '2026-11-09T08:07:19.000Z' },
    weekly: { status: 'ok', percent: 7, resetsAt: '2026-11-16T00:00:00.000Z' },
    monthly: { status: 'rate-limited', percent: 29, resetsAt: '2026-11-29T02:51:02.000Z' },
  },
};

describe('OpenCode Quota Provider', () => {
  beforeEach(() => {
    clearOpenCodeQuotaCache();
  });

  afterEach(() => {
    clearOpenCodeQuotaCache();
  });

  test('normalizes the Go usage payload into one group with three buckets', () => {
    const result = normalizeGoUsagePayload(goUsagePayload, 'Gogogo', 1_700_000_000_000);

    assert.ok(result);
    assert.equal(result.groups.length, 1);
    const group = result.groups[0];
    assert.equal(group.name, 'OpenCode Go (Gogogo)');
    assert.equal(result.partitioning, 'bucket');
    assert.equal(result.updatedAt, new Date(1_700_000_000_000).toISOString());

    assert.deepEqual(
      group.buckets.map((bucket) => bucket.window),
      ['5h', 'weekly', 'monthly'],
    );
    const [rolling, weekly, monthly] = group.buckets;
    assert.equal(rolling.id, 'opencode-go-5h');
    assert.ok(Math.abs(rolling.remainingFraction - 0.81) < 1e-9);
    assert.equal(rolling.resetTime, '2026-11-09T08:07:19.000Z');
    // A rate-limited window has no allowance left even below 100%.
    assert.equal(monthly.remainingFraction, 0);
    assert.ok(Math.abs(weekly.remainingFraction - 0.93) < 1e-9);
  });

  test('drops windows the payload does not describe and rejects unreadable payloads', () => {
    const partial = normalizeGoUsagePayload(
      { usage: { rolling: { status: 'ok', percent: 0, resetsAt: 'bad-date' } } },
      undefined,
      1,
    );
    assert.ok(partial);
    assert.equal(partial.groups[0].buckets.length, 1);
    assert.equal(partial.groups[0].buckets[0].resetTime, undefined);
    assert.equal(partial.groups[0].name, 'OpenCode Go');

    assert.equal(normalizeGoUsagePayload({}, undefined, 1), null);
    assert.equal(normalizeGoUsagePayload({ usage: {} }, undefined, 1), null);
    assert.equal(normalizeGoUsagePayload('nope', undefined, 1), null);
    // Percent outside 0..100 clamps into range instead of painting a negative bar.
    const clamped = normalizeGoUsagePayload(
      { usage: { rolling: { status: 'ok', percent: 140, resetsAt: '2026-11-09T08:07:19.000Z' } } },
      undefined,
      1,
    );
    assert.ok(clamped);
    assert.equal(clamped.groups[0].buckets[0].remainingFraction, 0);
  });

  test('fetches usage with the Go endpoint headers and returns normalized data', async () => {
    const { fetchFn, requests } = createRouteFetch({ '/zen/go/v1/usage': goUsagePayload });

    const result = await fetchOpenCodeQuota({}, {
      readCredential: async () => credential,
      fetch: fetchFn,
    });

    assert.ok(result);
    assert.equal(result.groups[0].buckets.length, 3);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(requests[0].headers.authorization, 'Bearer test-token');
    assert.equal(requests[0].headers['x-opencode-org-id'], 'org_test1234');
  });

  test('returns null without a credential or without a workspace id', async () => {
    const { fetchFn, requests } = createRouteFetch({ '/zen/go/v1/usage': goUsagePayload });

    const noCredential = await fetchOpenCodeQuota({}, {
      readCredential: async () => null,
      fetch: fetchFn,
    });
    assert.equal(noCredential, null);

    const noOrg = await fetchOpenCodeQuota({}, {
      readCredential: async () => ({ ...credential, orgId: '' }),
      fetch: fetchFn,
    });
    assert.equal(noOrg, null);

    assert.equal(requests.length, 0);
  });

  test('degrades to null on 403, 401, transport errors, and unreadable payloads', async () => {
    const notSubscribed = (async () => ({
      ok: false, status: 403, json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;
    assert.equal(await fetchOpenCodeQuota({}, {
      readCredential: async () => credential,
      fetch: notSubscribed,
    }), null);

    const expired = (async () => ({
      ok: false, status: 401, json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;
    assert.equal(await fetchOpenCodeQuota({}, {
      readCredential: async () => credential,
      fetch: expired,
    }), null);

    const failing = (async () => {
      throw new Error('network down');
    }) as typeof globalThis.fetch;
    assert.equal(await fetchOpenCodeQuota({}, {
      readCredential: async () => credential,
      fetch: failing,
    }), null);

    const emptyBody = createRouteFetch({ '/zen/go/v1/usage': {} });
    assert.equal(await fetchOpenCodeQuota({}, {
      readCredential: async () => credential,
      fetch: emptyBody.fetchFn,
    }), null);
  });

  test('caches reads until forceRefresh pierces the cache', async () => {
    let calls = 0;
    const countingFetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => goUsagePayload } as Response;
    }) as typeof globalThis.fetch;
    const deps = { readCredential: async () => credential, fetch: countingFetch };

    const first = await fetchOpenCodeQuota({}, deps);
    const second = await fetchOpenCodeQuota({}, deps);
    assert.ok(first && second);
    assert.equal(calls, 1);

    const refreshed = await fetchOpenCodeQuota({ forceRefresh: true }, deps);
    assert.ok(refreshed);
    assert.equal(calls, 2);
  });

  test('reads the JSON-string credential value from a real CLI database layout', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-quota-db-'));
    const originalHomedir = os.homedir;
    (os as any).homedir = () => tempRoot;
    let db: Database.Database | undefined;
    try {
      const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
      await mkdir(dataDir, { recursive: true });
      db = new Database(path.join(dataDir, 'opencode.db'));
      db.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)');
      db.prepare('INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'cred_1', 'opencode', 'Gogogo',
        JSON.stringify({
          type: 'oauth',
          access: 'db-token',
          metadata: { orgID: 'org_from_db', orgName: 'Gogogo', server: 'https://opencode.ai/console' },
        }),
        1, 1, 2,
      );

      const { fetchFn, requests } = createRouteFetch({ '/zen/go/v1/usage': goUsagePayload });
      const result = await fetchOpenCodeQuota({}, { fetch: fetchFn });

      assert.ok(result);
      assert.equal(result.groups[0].name, 'OpenCode Go (Gogogo)');
      assert.equal(requests[0].url, 'https://opencode.ai/zen/go/v1/usage');
      assert.equal(requests[0].headers.authorization, 'Bearer db-token');
      assert.equal(requests[0].headers['x-opencode-org-id'], 'org_from_db');
    } finally {
      db?.close();
      (os as any).homedir = originalHomedir;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
