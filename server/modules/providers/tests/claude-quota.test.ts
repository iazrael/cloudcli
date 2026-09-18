import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearClaudeQuotaCache,
  fetchClaudeQuota,
} from '../list/claude/claude-quota.provider.js';

const usageResponse = {
  subscription_type: 'pro',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 62, resets_at: '2027-01-15T08:00:00+00:00' },
    seven_day: { utilization: 32, resets_at: '2027-01-20T11:00:00+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
  },
};

test('fetchClaudeQuota maps the subscription windows onto quota buckets', async () => {
  clearClaudeQuotaCache();
  const quota = await fetchClaudeQuota({}, {
    readUsage: async () => usageResponse,
    now: () => 1_000,
  });

  assert.ok(quota);
  assert.equal(quota.updatedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(quota.partitioning, 'bucket');
  assert.equal(quota.groups.length, 1);
  assert.equal(quota.groups[0].name, 'Claude (PRO)');
  assert.deepEqual(
    quota.groups[0].buckets,
    [
      {
        id: 'claude-5h',
        name: 'Five Hour Limit Remaining',
        description: '62% used',
        window: '5h',
        remainingFraction: 0.38,
        resetTime: '2027-01-15T08:00:00.000Z',
      },
      {
        id: 'claude-7d',
        name: 'Weekly Limit Remaining',
        description: '32% used',
        window: 'weekly',
        remainingFraction: 0.68,
        resetTime: '2027-01-20T11:00:00.000Z',
      },
    ],
  );
});

test('fetchClaudeQuota adds the per-model weekly windows the account actually has', async () => {
  clearClaudeQuotaCache();
  const quota = await fetchClaudeQuota({}, {
    readUsage: async () => ({
      ...usageResponse,
      subscription_type: 'max',
      rate_limits: {
        ...usageResponse.rate_limits,
        seven_day_opus: { utilization: 12, resets_at: null },
        model_scoped: [
          { display_name: 'Fable', utilization: 5, resets_at: '2027-01-20T11:00:00+00:00' },
          // No label means no bucket: an unnamed meter cannot be rendered.
          { utilization: 50, resets_at: null },
        ],
      },
    }),
    now: () => 1_000,
  });

  assert.ok(quota);
  assert.equal(quota.groups[0].name, 'Claude (MAX)');
  assert.deepEqual(
    quota.groups[0].buckets.map((bucket) => bucket.id),
    ['claude-5h', 'claude-7d', 'claude-7d-opus', 'claude-7d-fable'],
  );
  // A window the server left open-ended still renders, just without a reset.
  assert.equal(quota.groups[0].buckets[2].resetTime, undefined);
});

test('fetchClaudeQuota reports no quota when plan limits do not apply to the login', async () => {
  clearClaudeQuotaCache();
  const apiKeyUsage = {
    subscription_type: null,
    rate_limits_available: false,
    rate_limits: null,
  };

  assert.equal(
    await fetchClaudeQuota({}, { readUsage: async () => apiKeyUsage, now: () => 1_000 }),
    null,
  );

  clearClaudeQuotaCache();
  // An SDK that no longer exposes the experimental usage reader answers null.
  assert.equal(
    await fetchClaudeQuota({}, { readUsage: async () => null, now: () => 1_000 }),
    null,
  );

  clearClaudeQuotaCache();
  // Limits are advertised as available but every window came back unreadable.
  assert.equal(
    await fetchClaudeQuota({}, {
      readUsage: async () => ({
        subscription_type: 'pro',
        rate_limits_available: true,
        rate_limits: { five_hour: null, seven_day: { utilization: null } },
      }),
      now: () => 1_000,
    }),
    null,
  );
});

test('fetchClaudeQuota caches reads and honours a forced refresh', async () => {
  clearClaudeQuotaCache();
  let readCount = 0;
  let response: unknown = usageResponse;
  const dependencies = {
    readUsage: async () => {
      readCount += 1;
      return response;
    },
    now: () => 10_000,
  };

  assert.ok(await fetchClaudeQuota({}, dependencies));
  assert.ok(await fetchClaudeQuota({}, dependencies));
  assert.equal(readCount, 1);

  response = { rate_limits_available: false };
  assert.equal(await fetchClaudeQuota({ forceRefresh: true }, dependencies), null);
  assert.equal(readCount, 2);
});

test('fetchClaudeQuota propagates SDK failures so the route can show an error', async () => {
  clearClaudeQuotaCache();
  await assert.rejects(
    () => fetchClaudeQuota({}, {
      readUsage: async () => { throw new Error('Claude Code CLI is unavailable'); },
      now: () => 10_000,
    }),
    /Claude Code CLI is unavailable/,
  );
});
