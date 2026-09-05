/**
 * Three-state tests for the shared provider-capabilities fetch point:
 * success (cached, deduped across mounts), failure (uncached — the next
 * mount retries; consumers fall back), and concurrent first paint (one
 * request serves every simultaneous mount).
 */

import assert from 'node:assert/strict';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';

import type { ProviderCapabilities } from '@/shared/hooks/useProviderCapabilities';

const CAPABILITIES_BODY = {
  success: true,
  data: {
    providers: [
      { provider: 'claude', permissionModes: ['default'], defaultPermissionMode: 'default', supportsSessionForking: true },
      { provider: 'zcode', permissionModes: ['default'], defaultPermissionMode: 'default', supportsSessionForking: false },
    ],
  },
};

type ProbeState = {
  capabilities: Partial<Record<string, ProviderCapabilities>> | null;
  loaded: boolean;
  forkable: string[];
};

/**
 * Each test imports the hook module fresh (vi.resetModules) so the
 * module-level cache and in-flight dedup start clean, then stubs fetch and
 * counts how many times the capabilities endpoint was hit.
 */
async function mountFresh() {
  vi.resetModules();
  let requestCount = 0;
  const fetchMock = vi.fn(() => {
    requestCount += 1;
    return Promise.resolve(new Response(JSON.stringify(CAPABILITIES_BODY), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);

  const { useProviderCapabilitiesMap, useSessionForkingProviders } = await import('@/shared/hooks/useProviderCapabilities');

  // The probe reports through a callback into this array: the hook states
  // observed so far, last entry = latest.
  const states: ProbeState[] = [];
  function Probe(): ReactNode {
    const { capabilities, loaded } = useProviderCapabilitiesMap();
    const forkable = useSessionForkingProviders();
    useEffect(() => {
      states.push({
        capabilities: capabilities as ProbeState['capabilities'],
        loaded,
        forkable: Array.from(forkable),
      });
    });
    return null;
  }

  const mount = () => render(<Probe />);
  return { mount, latest: () => states[states.length - 1], getRequestCount: () => requestCount };
}

describe('useProviderCapabilitiesMap', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the matrix, marks loaded, and serves later mounts from the cache', async () => {
    const { mount, latest, getRequestCount } = await mountFresh();

    const first = mount();
    await act(async () => {});
    assert.equal(latest()!.loaded, true);
    assert.deepEqual(Object.keys(latest()!.capabilities ?? {}), ['claude', 'zcode']);
    first.unmount();

    // A later mount must be served by the module cache, not a new request.
    const second = mount();
    await act(async () => {});
    second.unmount();

    assert.equal(getRequestCount(), 1);
  });

  it('reports a failed request as loaded-with-no-capabilities and retries on the next mount', async () => {
    vi.resetModules();
    let requestCount = 0;
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(() => {
      requestCount += 1;
      return fail
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(new Response(JSON.stringify(CAPABILITIES_BODY), { status: 200 }));
    }));

    const { useProviderCapabilitiesMap } = await import('@/shared/hooks/useProviderCapabilities');
    const states: ProbeState[] = [];
    function Probe(): ReactNode {
      const { capabilities, loaded } = useProviderCapabilitiesMap();
      useEffect(() => {
        states.push({ capabilities: capabilities as ProbeState['capabilities'], loaded, forkable: [] });
      });
      return null;
    }

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = render(<Probe />);
    await act(async () => {});
    assert.deepEqual(states[states.length - 1], { capabilities: null, loaded: true, forkable: [] },
      'a failure must settle as loaded with no capabilities so consumers use their fallback');
    first.unmount();
    consoleError.mockRestore();

    // The failure was not cached: the next mount retries and succeeds.
    fail = false;
    const second = render(<Probe />);
    await act(async () => {});
    second.unmount();
    assert.ok(states[states.length - 1]!.capabilities !== null, 'the retried mount must receive the matrix');
    assert.equal(requestCount, 2);
  });

  it('serves simultaneous first mounts with a single in-flight request', async () => {
    const { mount, getRequestCount } = await mountFresh();

    const a = mount();
    const b = mount();
    const c = mount();
    await act(async () => {});
    a.unmount();
    b.unmount();
    c.unmount();

    assert.equal(getRequestCount(), 1);
  });

  it('derives the forkable set only from providers the matrix says can fork', async () => {
    const { mount, latest } = await mountFresh();
    const root = mount();
    await act(async () => {});
    assert.deepEqual(latest()!.forkable, ['claude']);
    root.unmount();
  });

  it('never offers forking before the matrix has loaded', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { useSessionForkingProviders } = await import('@/shared/hooks/useProviderCapabilities');
    const states: string[][] = [];
    function Probe(): ReactNode {
      const forkable = useSessionForkingProviders();
      useEffect(() => {
        states.push(Array.from(forkable));
      });
      return null;
    }
    const root = render(<Probe />);
    await act(async () => {});
    root.unmount();
    expect(states[states.length - 1]).toEqual([]);
    assert.deepEqual(states[states.length - 1], [], 'an affordance must never be offered and then withdrawn');
  });
});
