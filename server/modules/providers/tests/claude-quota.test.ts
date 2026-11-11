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

/** The direct read is primary; tests that don't exercise it fall back to the SDK fixture. */
const noDirectUsage = async () => null;

/** Direct usage fixture: the SDK fixture's windows plus a reset-grant block. */
const directUsageWithGrants = (cedarEmber: unknown) => ({
  payload: { ...usageResponse.rate_limits, cedar_ember: cedarEmber },
  subscriptionType: 'pro',
});

test('fetchClaudeQuota maps the subscription windows onto quota buckets', async () => {
  clearClaudeQuotaCache();
  const quota = await fetchClaudeQuota({}, {
    readUsage: async () => usageResponse,
    readDirectUsage: noDirectUsage,
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
    readDirectUsage: noDirectUsage,
    now: () => 1_000,
  });

  assert.ok(quota);
  assert.equal(quota.groups[0].name, 'Claude (MAX)');
  assert.deepEqual(
    quota.groups[0].buckets.map((bucket) => bucket.id),
    ['claude-5h', 'claude-7d', 'claude-7d-opus', 'claude-7d-fable'],
  );
  // Only the narrower windows name a model family; the all-models window does not.
  assert.equal(quota.groups[0].buckets[1].modelScope, undefined);
  assert.equal(quota.groups[0].buckets[2].modelScope, 'Opus');
  assert.equal(quota.groups[0].buckets[3].modelScope, 'Fable');
  // A window the server left open-ended still renders, just without a reset.
  assert.equal(quota.groups[0].buckets[2].resetTime, undefined);
});

test('fetchClaudeQuota labels a Pro account\'s model-scoped weekly window', async () => {
  clearClaudeQuotaCache();
  // 2026-11-11 observed Pro payload: the Sonnet/Opus legacy windows are null,
  // but a Fable model-scoped window still ships and the official /usage renders it.
  const quota = await fetchClaudeQuota({}, {
    readUsage: async () => ({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 10, resets_at: '2026-11-11T04:39:59+00:00' },
        seven_day: { utilization: 8, resets_at: '2026-11-15T10:59:59+00:00' },
        seven_day_opus: null,
        seven_day_sonnet: null,
        model_scoped: [
          { display_name: 'Fable', utilization: 0, resets_at: '2026-11-15T11:00:00+00:00' },
        ],
      },
    }),
    readDirectUsage: noDirectUsage,
    now: () => 1_000,
  });

  assert.ok(quota);
  assert.equal(quota.groups[0].name, 'Claude (PRO)');
  assert.deepEqual(
    quota.groups[0].buckets.map((bucket) => [bucket.id, bucket.modelScope]),
    [
      ['claude-5h', undefined],
      ['claude-7d', undefined],
      ['claude-7d-fable', 'Fable'],
    ],
  );
});

test('fetchClaudeQuota derives a model-scoped window from the limits array', async () => {
  clearClaudeQuotaCache();
  // The direct usage body can leave model_scoped null while the same Fable
  // window is present as a weekly_scoped row in limits[].
  const quota = await fetchClaudeQuota({}, {
    readUsage: async () => ({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        ...usageResponse.rate_limits,
        model_scoped: null,
        limits: [
          { kind: 'session', percent: 10, resets_at: '2026-11-11T04:39:59+00:00', scope: null },
          { kind: 'weekly_all', percent: 8, resets_at: '2026-11-15T10:59:59+00:00', scope: null },
          {
            kind: 'weekly_scoped',
            percent: 0,
            resets_at: '2026-11-15T11:00:00+00:00',
            scope: { model: { display_name: 'Fable' }, surface: null },
          },
        ],
      },
    }),
    readDirectUsage: noDirectUsage,
    now: () => 1_000,
  });

  assert.ok(quota);
  assert.deepEqual(
    quota.groups[0].buckets.map((bucket) => [bucket.id, bucket.modelScope]),
    [
      ['claude-5h', undefined],
      ['claude-7d', undefined],
      ['claude-7d-fable', 'Fable'],
    ],
  );
});

test('fetchClaudeQuota reports no quota when plan limits do not apply to the login', async () => {
  clearClaudeQuotaCache();
  const apiKeyUsage = {
    subscription_type: null,
    rate_limits_available: false,
    rate_limits: null,
  };

  assert.equal(
    await fetchClaudeQuota({}, {
      readUsage: async () => apiKeyUsage,
      readDirectUsage: noDirectUsage,
      now: () => 1_000,
    }),
    null,
  );

  clearClaudeQuotaCache();
  // An SDK that no longer exposes the experimental usage reader answers null.
  assert.equal(
    await fetchClaudeQuota({}, {
      readUsage: async () => null,
      readDirectUsage: noDirectUsage,
      now: () => 1_000,
    }),
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
      readDirectUsage: noDirectUsage,
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
    readDirectUsage: noDirectUsage,
    now: () => 10_000,
  };

  assert.ok(await fetchClaudeQuota({}, dependencies));
  assert.ok(await fetchClaudeQuota({}, dependencies));
  assert.equal(readCount, 1);

  response = { rate_limits_available: false };
  assert.equal(await fetchClaudeQuota({ forceRefresh: true }, dependencies), null);
  assert.equal(readCount, 2);
});

test('fetchClaudeQuota lists the account\'s Claude reset grants', async () => {
  clearClaudeQuotaCache();
  // 2026-11-11 observed Pro response: a Fable launch-week reset beside a full reset.
  const quota = await fetchClaudeQuota({}, {
    readUsage: async () => usageResponse,
    readDirectUsage: async () => directUsageWithGrants({
      eligible: true,
      grants: [
        {
          id: 'launch-2610-fable-week',
          label: 'New model launch: one Fable reset for Pro and Team Standard, launch week only',
          resets_total: 1,
          resets_left: 1,
          starts_at: '2026-11-09T18:00:00+00:00',
          ends_at: '2026-11-17T07:59:00+00:00',
          clears: ['five_hour', 'seven_day_overage_included'],
          paused: false,
          usable_now: true,
          type: 'full',
          gives_back_weekly: true,
        },
        {
          id: 'full-reset-2611',
          label: 'One full limit reset (November 2026)',
          resets_total: 1,
          resets_left: 1,
          starts_at: '2026-11-10T21:30:00+00:00',
          ends_at: '2026-12-10T22:00:00+00:00',
          clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
          paused: false,
          usable_now: true,
          type: 'full',
          gives_back_weekly: false,
        },
      ],
    }),
    now: () => Date.parse('2026-11-11T00:00:00Z'),
  });

  assert.ok(quota);
  assert.deepEqual(quota.resetCredits?.credits, [
    {
      id: 'launch-2610-fable-week',
      resetType: 'fable',
      title: 'New model launch: one Fable reset for Pro and Team Standard, launch week only',
      grantType: 'full',
      available: true,
      expireTime: '2026-11-17T07:59:00.000Z',
      remaining: 1,
    },
    {
      id: 'full-reset-2611',
      resetType: 'all',
      title: 'One full limit reset (November 2026)',
      grantType: 'full',
      available: true,
      expireTime: '2026-12-10T22:00:00.000Z',
      remaining: 1,
    },
  ]);
});

test('fetchClaudeQuota marks used, paused and expired reset grants unavailable', async () => {
  clearClaudeQuotaCache();
  const quota = await fetchClaudeQuota({}, {
    readUsage: async () => usageResponse,
    readDirectUsage: async () => directUsageWithGrants({
      eligible: true,
      grants: [
        { id: 'used', resets_left: 0, clears: ['seven_day'], paused: false, usable_now: false },
        { id: 'paused', resets_left: 1, clears: ['five_hour'], paused: true, usable_now: true },
        {
          id: 'expired',
          resets_left: 1,
          clears: ['five_hour', 'seven_day'],
          paused: false,
          usable_now: true,
          ends_at: '2026-11-01T00:00:00+00:00',
        },
      ],
    }),
    now: () => Date.parse('2026-11-11T00:00:00Z'),
  });

  assert.ok(quota);
  assert.deepEqual(
    quota.resetCredits?.credits.map((credit) => [
      credit.id,
      credit.resetType,
      credit.available,
      credit.remaining,
    ]),
    [
      ['used', 'weekly', false, 0],
      ['paused', '5h', false, 1],
      ['expired', 'all', false, 1],
    ],
  );
});

test('fetchClaudeQuota keeps the quota windows when reset grants cannot be read', async () => {
  clearClaudeQuotaCache();
  const quota = await fetchClaudeQuota({}, {
    readUsage: async () => usageResponse,
    readDirectUsage: async () => { throw new Error('reset endpoint unavailable'); },
    now: () => 1_000,
  });

  assert.ok(quota);
  assert.equal(quota.resetCredits, undefined);
  assert.equal(quota.groups[0].buckets.length, 2);
});

test('fetchClaudeQuota ignores a malformed reset-grant payload', async () => {
  for (const cedarEmber of [
    null,
    { eligible: false, grants: [] },
    { eligible: true, grants: 'not-an-array' },
  ]) {
    clearClaudeQuotaCache();
    const quota = await fetchClaudeQuota({}, {
      readUsage: async () => usageResponse,
      readDirectUsage: async () => directUsageWithGrants(cedarEmber),
      now: () => 1_000,
    });
    assert.ok(quota);
    assert.equal(quota.resetCredits, undefined);
  }
});

test('fetchClaudeQuota propagates SDK failures so the route can show an error', async () => {
  clearClaudeQuotaCache();
  await assert.rejects(
    () => fetchClaudeQuota({}, {
      readUsage: async () => { throw new Error('Claude Code CLI is unavailable'); },
      readDirectUsage: noDirectUsage,
      now: () => 10_000,
    }),
    /Claude Code CLI is unavailable/,
  );
});
