import assert from 'node:assert/strict';
import test from 'node:test';

import { createStaleWhileRefreshValue } from '../utils.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('the first read waits for the load; a fresh value is served without loading again', async () => {
  let clock = 0;
  let loads = 0;
  const value = createStaleWhileRefreshValue({
    load: async () => { loads += 1; return `v${loads}`; },
    ttlMs: () => 100,
    failureRetryMs: 10,
    now: () => clock,
  });

  assert.equal(await value.get(), 'v1');
  clock = 99;
  assert.equal(await value.get(), 'v1');
  assert.equal(loads, 1);
});

test('an expired value is served at once while one shared refresh replaces it', async () => {
  let clock = 0;
  const loads: Array<ReturnType<typeof deferred<string>>> = [];
  const value = createStaleWhileRefreshValue({
    load: () => { const next = deferred<string>(); loads.push(next); return next.promise; },
    ttlMs: () => 100,
    failureRetryMs: 10,
    now: () => clock,
  });

  const first = value.get();
  loads[0].resolve('old');
  assert.equal(await first, 'old');

  clock = 150;
  // Neither caller waits on the slow refresh, and they share it.
  assert.equal(await value.get(), 'old');
  assert.equal(await value.get(), 'old');
  assert.equal(loads.length, 2);

  loads[1].resolve('new');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await value.get(), 'new');
});

test('concurrent first reads share one load', async () => {
  let loads = 0;
  const gate = deferred<string>();
  const value = createStaleWhileRefreshValue({
    load: () => { loads += 1; return gate.promise; },
    ttlMs: () => 100,
    failureRetryMs: 10,
  });

  const reads = [value.get(), value.get()];
  gate.resolve('only');
  assert.deepEqual(await Promise.all(reads), ['only', 'only']);
  assert.equal(loads, 1);
});

test('the ttl can depend on what was loaded', async () => {
  let clock = 0;
  const results = ['fallback', 'real'];
  const value = createStaleWhileRefreshValue({
    load: async () => results.shift()!,
    ttlMs: (loaded) => (loaded === 'fallback' ? 5 : 1_000),
    failureRetryMs: 10,
    now: () => clock,
  });

  assert.equal(await value.get(), 'fallback');
  clock = 6;
  assert.equal(await value.get(), 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  clock = 500;
  assert.equal(await value.get(), 'real');
});

test('a failed refresh keeps the previous value and waits before trying again', async () => {
  let clock = 0;
  let loads = 0;
  const errors: unknown[] = [];
  const value = createStaleWhileRefreshValue({
    load: async () => {
      loads += 1;
      if (loads > 1) throw new Error('cli down');
      return 'good';
    },
    ttlMs: () => 100,
    failureRetryMs: 50,
    now: () => clock,
    onRefreshError: (error) => errors.push(error),
  });

  assert.equal(await value.get(), 'good');
  clock = 200;
  assert.equal(await value.get(), 'good');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);

  // Inside the retry wait, nothing is loaded again.
  clock = 240;
  assert.equal(await value.get(), 'good');
  assert.equal(loads, 2);
});

test('a first read whose load fails rejects, and the next read tries again', async () => {
  let loads = 0;
  const value = createStaleWhileRefreshValue({
    load: async () => {
      loads += 1;
      if (loads === 1) throw new Error('not yet');
      return 'second time';
    },
    ttlMs: () => 100,
    failureRetryMs: 50,
  });

  await assert.rejects(value.get(), /not yet/);
  assert.equal(await value.get(), 'second time');
});

test('clear drops the value, and a load that was running when cleared is not kept', async () => {
  const loads: Array<ReturnType<typeof deferred<string>>> = [];
  const value = createStaleWhileRefreshValue({
    load: () => { const next = deferred<string>(); loads.push(next); return next.promise; },
    ttlMs: () => 100,
    failureRetryMs: 10,
  });

  const stale = value.get();
  value.clear();
  loads[0].resolve('from before the clear');
  assert.equal(await stale, 'from before the clear');

  const fresh = value.get();
  assert.equal(loads.length, 2);
  loads[1].resolve('after');
  assert.equal(await fresh, 'after');
});
