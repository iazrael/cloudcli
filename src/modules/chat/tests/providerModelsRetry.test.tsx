import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, afterEach, test, vi } from 'vitest';

import type { ProviderModelsDefinition } from '@/shared/types';

/**
 * Pins the model-catalog load resilience in useChatProviderState. A fresh PWA
 * install that mounts during a server-restart window used to lose its only
 * fetch and keep the composer model menu silently blank until the page was
 * reloaded; the hook must retry on its own and surface an error state with a
 * manual reload when retries are exhausted.
 */

vi.mock('@/shared/api', () => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilitiesMap: () => ({ capabilities: {} }),
}));

const { authenticatedFetch } = await import('@/shared/api');
const mockAuthenticatedFetch = vi.mocked(authenticatedFetch);

const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');

const PROVIDER_COUNT = 6;
const RETRY_DELAYS_MS = [2_000, 8_000];

const modelsPayload = (model: string) => ({
  success: true,
  data: {
    models: {
      OPTIONS: [{ value: model, label: model }],
      DEFAULT: model,
    },
  },
}) as unknown as { success: boolean; data: { models: ProviderModelsDefinition } };

function renderProviderState() {
  return renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null }),
  );
}

const modelsCalls = () =>
  mockAuthenticatedFetch.mock.calls.filter(([url]) => String(url).includes('/models'));

async function settleRetries() {
  for (const delay of RETRY_DELAYS_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(delay);
    });
  }
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.useFakeTimers();
  mockAuthenticatedFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test('retries after network failures and recovers when the server comes back', async () => {
  mockAuthenticatedFetch
    .mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')))
    .mockImplementation(() => Promise.resolve({ json: () => Promise.resolve(modelsPayload('glm-a')) } as Response));

  const { result } = renderProviderState();
  await settleRetries();

  // The initial round loads all providers; only the failed provider retries.
  assert.equal(modelsCalls().length, PROVIDER_COUNT + 1);
  assert.equal(result.current.providerModelsError, false);
  assert.equal(result.current.providerModelsLoading, false);
  assert.equal(result.current.providerModelCatalog.zcode?.DEFAULT, 'glm-a');
});

test('marks the error state once retries are exhausted and reload clears it', async () => {
  mockAuthenticatedFetch.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));

  const { result } = renderProviderState();
  await settleRetries();

  // Initial round + two retry rounds
  assert.equal(modelsCalls().length, PROVIDER_COUNT * 3);
  assert.equal(result.current.providerModelsError, true);
  assert.equal(result.current.providerModelsLoading, false);
  assert.deepEqual(Object.keys(result.current.providerModelCatalog), []);

  mockAuthenticatedFetch.mockImplementation(() =>
    Promise.resolve({ json: () => Promise.resolve(modelsPayload('glm-b')) } as Response));
  await act(async () => {
    await result.current.providerModelsReload();
  });

  assert.equal(result.current.providerModelsError, false);
  assert.equal(result.current.providerModelCatalog.zcode?.DEFAULT, 'glm-b');
});

test('an all-empty catalog (success:false responses) also retries and errors', async () => {
  mockAuthenticatedFetch.mockImplementation(() =>
    Promise.resolve({ json: () => Promise.resolve({ success: false }) } as Response));

  const { result } = renderProviderState();
  await settleRetries();

  assert.equal(modelsCalls().length, PROVIDER_COUNT * 3);
  assert.equal(result.current.providerModelsError, true);
  assert.equal(result.current.providerModelsLoading, false);
});

test('a single failing provider does not block the rest of the catalog', async () => {
  mockAuthenticatedFetch.mockImplementation((url) => {
    const isZcode = String(url).includes('/zcode/');
    return Promise.resolve({
      json: () =>
        isZcode
          ? Promise.resolve({ success: false })
          : Promise.resolve(modelsPayload('m-ok')),
    } as Response);
  });

  const { result } = renderProviderState();
  // No retry should be needed: flush the fetch microtasks without advancing
  // the retry timers — waitFor would hang under fake timers.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  assert.equal(result.current.providerModelsLoading, false);
  assert.equal(result.current.providerModelsError, false);
  assert.equal(result.current.providerModelCatalog.zcode, undefined);
  assert.equal(result.current.providerModelCatalog.claude?.DEFAULT, 'm-ok');
});

test('a Codex-only failure retries and exposes manual recovery when Codex is selected', async () => {
  mockAuthenticatedFetch.mockImplementation((url) => Promise.resolve({
    json: () => Promise.resolve(String(url).includes('/codex/') ? { success: false } : modelsPayload('ok')),
  } as Response));
  const { result } = renderProviderState();
  await settleRetries();
  await act(async () => { result.current.setProvider('codex'); });
  assert.equal(result.current.providerModelsError, true);
  assert.equal(result.current.providerModelsLoading, false);
  assert.equal(result.current.providerModelCatalog.claude?.DEFAULT, 'ok');
  assert.equal(modelsCalls().filter(([url]) => String(url).includes('/codex/')).length, 3);
  await act(async () => { result.current.setProvider('claude'); });
  assert.equal(result.current.providerModelsError, false);
  mockAuthenticatedFetch.mockImplementation(() => Promise.resolve({ json: () => Promise.resolve(modelsPayload('recovered')) } as Response));
  await act(async () => { await result.current.providerModelsReload(); });
  await act(async () => { result.current.setProvider('codex'); });
  assert.equal(result.current.providerModelsError, false);
  assert.equal(result.current.providerModelCatalog.codex?.DEFAULT, 'recovered');
});

test('a new user follows the engine default while a stored model choice remains selected', async () => {
  mockAuthenticatedFetch.mockImplementation(() => Promise.resolve({
    json: () => Promise.resolve({ success: true, data: { models: {
      DEFAULT: 'engine-default',
      OPTIONS: [{ value: 'engine-default', label: 'New default' }, { value: 'gpt-6.1-sol', label: 'Previous default' }],
    } } }),
  } as Response));
  const first = renderProviderState();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); first.result.current.setProvider('codex'); });
  assert.equal(first.result.current.currentProviderModel, 'engine-default');
  first.unmount();
  localStorage.setItem('codex-model', 'gpt-6.1-sol');
  const second = renderProviderState();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); second.result.current.setProvider('codex'); });
  assert.equal(second.result.current.currentProviderModel, 'gpt-6.1-sol');
});

test('a slow Codex request does not delay an already loaded Claude catalog', async () => {
  let finish: ((response: Response) => void) | undefined;
  const slow = new Promise<Response>((resolve) => { finish = resolve; });
  mockAuthenticatedFetch.mockImplementation((url) => String(url).includes('/codex/')
    ? slow : Promise.resolve({ json: () => Promise.resolve(modelsPayload('ready')) } as Response));
  const { result } = renderProviderState();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  assert.equal(result.current.providerModelCatalog.claude?.DEFAULT, 'ready');
  assert.equal(result.current.providerModelsLoading, false);
  await act(async () => { result.current.setProvider('codex'); });
  assert.equal(result.current.providerModelsLoading, true);
  await act(async () => { finish!({ json: () => Promise.resolve(modelsPayload('codex-ready')) } as Response); });
  assert.equal(result.current.providerModelsLoading, false);
});

test('removing a custom entry still offered by the engine preserves the selected model and effort', async () => {
  localStorage.setItem('codex-model', 'available');
  localStorage.setItem('codex-effort', 'high');
  const option = { value: 'available', label: 'My name', isCustom: true, recordId: 12,
    effort: { default: 'low', values: [{ value: 'low' }, { value: 'high' }] } };
  const models = { DEFAULT: 'other', OPTIONS: [{ value: 'other', label: 'Other' }, option] };
  mockAuthenticatedFetch.mockImplementation((_url, init) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: true, data: init?.method === 'DELETE'
      ? { model: option, models: { ...models, OPTIONS: [models.OPTIONS[0], { ...option, label: 'Official', isCustom: false, recordId: undefined }] } }
      : { models } }),
  } as Response));
  const { result } = renderProviderState();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); result.current.setProvider('codex'); });
  await act(async () => { await result.current.providerModelActions.remove('codex', option); });
  assert.equal(result.current.currentProviderModel, 'available');
  assert.equal(result.current.currentProviderEffort, 'high');
  assert.equal(result.current.currentProviderModelOptions.find((item) => item.value === 'available')?.label, 'Official');
});

test('a fallback catalog is shown at once and replaced when the live catalog arrives', async () => {
  localStorage.setItem('opencode-model', 'opencode-go/deepseek-v4-pro');
  const fallback = { success: true, data: { models: {
    DEFAULT: 'opencode/anchor', OPTIONS: [{ value: 'opencode/anchor', label: 'Anchor' }], FALLBACK: true,
  } } };
  const live = { success: true, data: { models: {
    DEFAULT: 'opencode/anchor',
    OPTIONS: [{ value: 'opencode/anchor', label: 'Anchor' }, { value: 'opencode-go/deepseek-v4-pro', label: 'DeepSeek' }],
  } } };
  let opencodeCalls = 0;
  mockAuthenticatedFetch.mockImplementation((url) => {
    const isOpencode = String(url).includes('/opencode/');
    if (isOpencode) opencodeCalls += 1;
    const payload = !isOpencode ? modelsPayload('ok') : opencodeCalls < 3 ? fallback : live;
    return Promise.resolve({ json: () => Promise.resolve(payload) } as Response);
  });

  const { result } = renderProviderState();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });

  // The stand-in is published and loading settles; the saved choice survives it.
  assert.equal(result.current.providerModelsLoading, false);
  assert.equal(result.current.providerModelCatalog.opencode?.OPTIONS.length, 1);
  assert.equal(localStorage.getItem('opencode-model'), 'opencode-go/deepseek-v4-pro');

  // First refresh still answers with the fallback, the second one is live.
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  assert.equal(result.current.providerModelCatalog.opencode?.OPTIONS.length, 2);
  await act(async () => { result.current.setProvider('opencode'); });
  assert.equal(result.current.currentProviderModel, 'opencode-go/deepseek-v4-pro');

  // Polling stops once the live catalog landed; other providers never re-polled.
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  assert.equal(opencodeCalls, 3);
  assert.equal(modelsCalls().length, PROVIDER_COUNT + 2);
});
