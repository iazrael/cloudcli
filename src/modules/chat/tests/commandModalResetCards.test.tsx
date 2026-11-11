import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';

import { i18n, initI18n } from '@/modules/i18n';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import type { ProviderModelActions, ProviderQuotaData } from '@/shared/types';

/**
 * Pins the Claude reset-card presentation: the grant list is data, while the
 * "Use" action is capability-driven. Claude has no spend endpoint wired, so its
 * cards must render read-only — the app must never offer an irreversible reset
 * it cannot perform, and these tests never click or call one.
 */

await initI18n();

const capabilityState = vi.hoisted(() => ({ supportsQuotaReset: false }));

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authenticatedFetch: vi.fn(),
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilitiesMap: () => ({
    capabilities: {
      claude: {
        supportsQuota: true,
        supportsQuotaReset: capabilityState.supportsQuotaReset,
      },
    },
    loaded: true,
  }),
}));

const noopActions: ProviderModelActions = {
  create: vi.fn(() => Promise.resolve()),
  update: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()),
  setCustomModelsOnly: vi.fn(() => Promise.resolve()),
};

const quota: ProviderQuotaData = {
  updatedAt: '2026-11-11T00:00:00.000Z',
  partitioning: 'bucket',
  groups: [{
    name: 'Claude (PRO)',
    description: 'Claude subscription plan limits',
    buckets: [
      {
        id: 'claude-5h',
        name: 'Five Hour Limit Remaining',
        description: '40% used',
        window: '5h',
        remainingFraction: 0.6,
        resetTime: '2026-11-11T04:40:00.000Z',
      },
      {
        id: 'claude-7d',
        name: 'Weekly Limit Remaining',
        description: '12% used',
        window: 'weekly',
        remainingFraction: 0.88,
        resetTime: '2026-11-15T11:00:00.000Z',
      },
    ],
  }],
  resetCredits: {
    credits: [
      {
        id: 'full-reset-2611',
        resetType: 'all',
        title: 'One full limit reset (November 2026)',
        grantType: 'full',
        available: true,
        expireTime: '2026-12-10T22:00:00.000Z',
        remaining: 1,
      },
      {
        id: 'launch-2610-fable-week',
        resetType: 'fable',
        title: 'New model launch: one Fable reset for Pro and Team Standard',
        grantType: 'full',
        available: true,
        expireTime: '2026-11-17T07:59:00.000Z',
        remaining: 1,
      },
    ],
  },
};

function renderCostModal() {
  render(
    <I18nextProvider i18n={i18n}>
      <CommandResultModal
        payload={{
          kind: 'cost',
          data: {
            provider: 'claude',
            model: 'claude-opus-5',
            tokenUsage: { used: 1_000, total: 200_000 },
            quota,
          },
        }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelActions={noopActions}
        activeProvider="claude"
        activeProviderModel="claude-opus-5"
        currentSessionId={null}
        onSelectProviderModel={vi.fn(() => Promise.resolve({ scope: 'default' as const, model: 'claude-opus-5' }))}
      />
    </I18nextProvider>,
  );
}

describe('CommandResultModal → Claude reset cards', () => {
  it('shows the grants read-only when the provider cannot spend them', () => {
    capabilityState.supportsQuotaReset = false;
    renderCostModal();

    expect(screen.getByText('Full allowance (5-hour + weekly)')).toBeTruthy();
    expect(screen.getByText('Fable Reset')).toBeTruthy();
    expect(screen.getByText("Use this reset on the provider's website.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull();
  });

  it('keeps the spend action for providers whose quota capability supports it', () => {
    capabilityState.supportsQuotaReset = true;
    renderCostModal();

    expect(screen.getByText('Fable Reset')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Use' })).toHaveLength(2);
  });
});
