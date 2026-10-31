import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { CodexProviderModels } from '../list/codex/codex-models.provider.js';
import { codexAppServerTransport } from '../list/codex/codex-app-server.client.js';

const require = createRequire(import.meta.url);
const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id, model: id, displayName: `Label ${id}`, description: `Description ${id}`,
  hidden: false, isDefault: false, defaultReasoningEffort: 'low',
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }, { reasoningEffort: 'ultra' }],
  ...extra,
});

test('discovers visible models, reasoning efforts and default across pages without resurrecting retired models', async (t) => {
  const requests: unknown[] = [];
  let closed = 0;
  t.mock.method(codexAppServerTransport, 'open', async () => ({
    call: async (method: string, params: unknown) => {
      requests.push({ method, params });
      return requests.length === 1
        ? { data: [model('new-a'), model('hidden', { hidden: true })], nextCursor: 'page-2' }
        : { data: [model('new-b', { isDefault: true })], nextCursor: null };
    },
    close: () => { closed += 1; },
  }));
  const result = await new CodexProviderModels().getSupportedModels();
  assert.deepEqual(result.OPTIONS.map((option) => option.value), ['new-a', 'new-b']);
  assert.equal(result.DEFAULT, 'new-b');
  assert.equal(result.OPTIONS[0].label, 'Label new-a');
  assert.equal(result.OPTIONS[0].description, 'Description new-a');
  assert.deepEqual(result.OPTIONS[0].effort, {
    default: 'low', values: [{ value: 'low', description: 'Quick' }, { value: 'ultra' }],
  });
  assert.deepEqual(requests, [
    { method: 'model/list', params: { limit: 100, includeHidden: false } },
    { method: 'model/list', params: { limit: 100, includeHidden: false, cursor: 'page-2' } },
  ]);
  assert.equal(closed, 1);
});

test('bundles a Codex CLI new enough to know the GPT-6.1 Sol model', () => {
  // Codex only ships metadata for gpt-6.1-sol from 0.159.1 on. An older CLI
  // still sends the request, but on fallback metadata: it warns
  // "Model metadata ... not found" and quietly drops `ultra` to `medium`.
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 159, `bundled @openai/codex ${version} predates 0.159.0`);
});


const settle = () => new Promise((resolve) => setImmediate(resolve));

test('shares concurrent discovery, caches for five minutes, and replaces models after expiry', async (t) => {
  let now = 1_000;
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(Date, 'now', () => now);
  t.mock.method(codexAppServerTransport, 'open', async () => ({
    call: async () => {
      calls += 1;
      await gate;
      return { data: [model(calls === 1 ? 'old' : 'new')], nextCursor: null };
    },
    close() {},
  }));
  const provider = new CodexProviderModels();
  const first = provider.getSupportedModels();
  const second = provider.getSupportedModels();
  release!();
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
  now += 299_999;
  assert.equal((await provider.getSupportedModels()).DEFAULT, 'old');
  assert.equal(calls, 1);
  now += 1;
  // Expired: served at once while the listing runs behind the caller, so a
  // turn never waits on the app server.
  assert.equal((await provider.getSupportedModels()).DEFAULT, 'old');
  assert.equal(calls, 2);
  await settle();
  assert.equal((await provider.getSupportedModels()).DEFAULT, 'new');
  assert.equal(calls, 2);
});

test('retains last successful models on refresh failure, logs it, and recovers after backoff', async (t) => {
  let now = 1_000;
  let fail = false;
  let calls = 0;
  let closed = 0;
  t.mock.method(Date, 'now', () => now);
  const log = t.mock.method(console, 'error', () => {});
  t.mock.method(codexAppServerTransport, 'open', async () => ({
    call: async () => {
      calls += 1;
      if (fail) throw new Error('offline');
      return { data: [model(`available-${calls}`)], nextCursor: null };
    },
    close: () => { closed += 1; },
  }));
  const provider = new CodexProviderModels();
  const first = await provider.getSupportedModels();
  now += 300_000;
  fail = true;
  assert.deepEqual(await provider.getSupportedModels(), first);
  await settle();
  assert.equal(log.mock.callCount(), 1);
  assert.equal(closed, 2);
  // Inside the back-off the last catalog serves without another listing.
  assert.deepEqual(await provider.getSupportedModels(), first);
  assert.equal(calls, 2);
  now += 10_000;
  fail = false;
  assert.deepEqual(await provider.getSupportedModels(), first);
  await settle();
  assert.equal((await provider.getSupportedModels()).DEFAULT, 'available-3');
});

test('cold discovery failure surfaces an error and the next request can recover', async (t) => {
  let fail = true;
  t.mock.method(console, 'error', () => {});
  t.mock.method(codexAppServerTransport, 'open', async () => {
    if (fail) throw new Error('not installed');
    return { call: async () => ({ data: [model('recovered')] }), close() {} };
  });
  const provider = new CodexProviderModels();
  await assert.rejects(provider.getSupportedModels(), /not installed/);
  fail = false;
  assert.equal((await provider.getSupportedModels()).DEFAULT, 'recovered');
});

test('rejects malformed, empty and looping catalogs and always closes the connection', async (t) => {
  const badPages = [
    null, {}, { data: [] }, { data: [null] },
    { data: [model('bad', { model: '' })] },
    { data: [model('bad', { supportedReasoningEfforts: [null] })] },
    { data: [model('bad', { defaultReasoningEffort: 'unsupported' })] },
    { data: [model('hidden', { hidden: true })] },
    { data: [model('ok')], nextCursor: 12 },
    { data: [model('ok')], nextCursor: 'loop' },
  ];
  let page: unknown;
  let closed = 0;
  t.mock.method(console, 'error', () => {});
  t.mock.method(codexAppServerTransport, 'open', async () => ({
    call: async () => page,
    close: () => { closed += 1; },
  }));
  for (page of badPages) {
    await assert.rejects(new CodexProviderModels().getSupportedModels(), /invalid or empty/);
  }
  assert.equal(closed, badPages.length);
});

test('deduplicates model IDs and accepts models without reasoning controls', async (t) => {
  t.mock.method(codexAppServerTransport, 'open', async () => ({
    call: async () => ({ data: [
      model('plain', { supportedReasoningEfforts: [], defaultReasoningEffort: null, description: null }),
      model('plain', { supportedReasoningEfforts: [], defaultReasoningEffort: null, description: null }),
    ] }),
    close() {},
  }));
  assert.deepEqual(await new CodexProviderModels().getSupportedModels(), {
    DEFAULT: 'plain', OPTIONS: [{ value: 'plain', label: 'Label plain' }],
  });
});
