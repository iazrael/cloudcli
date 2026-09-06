import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
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

  // 1 failed attempt (all providers) + 1 successful retry round
  assert.equal(modelsCalls().length, PROVIDER_COUNT * 2);
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
