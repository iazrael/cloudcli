import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';

import { i18n, initI18n } from '@/modules/i18n';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import type { ProviderModelActions, ProviderQuotaData } from '@/shared/types';

/**
 * Pins the account-quota card's weekly labels: a plan can meter an all-models
 * window and a model-scoped window side by side (Claude's Pro payload ships
 * both `seven_day` and a Fable `model_scoped` entry), and two rows both titled
 * "Weekly Quota" hide which one is which.
 */

await initI18n();

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authenticatedFetch: vi.fn(),
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilitiesMap: () => ({
    capabilities: { claude: { supportsQuota: true, supportsQuotaReset: false } },
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
  updatedAt: '2026-11-11T02:00:00.000Z',
  partitioning: 'bucket',
  groups: [{
    name: 'Claude (PRO)',
    description: 'Claude subscription plan limits',
    buckets: [
      {
        id: 'claude-5h',
        name: 'Five Hour Limit Remaining',
        description: '10% used',
        window: '5h',
        remainingFraction: 0.9,
        resetTime: '2026-11-11T04:39:59.000Z',
      },
      {
        id: 'claude-7d',
        name: 'Weekly Limit Remaining',
        description: '8% used',
        window: 'weekly',
        remainingFraction: 0.92,
        resetTime: '2026-11-15T10:59:59.000Z',
      },
      {
        id: 'claude-7d-fable',
        name: 'Weekly Fable Limit Remaining',
        description: '0% used',
        window: 'weekly',
        remainingFraction: 1,
        resetTime: '2026-11-15T11:00:00.000Z',
        modelScope: 'Fable',
      },
    ],
  }],
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

describe('CommandResultModal → quota weekly labels', () => {
  it('separates the all-models window from a model-scoped window', () => {
    renderCostModal();

    expect(screen.getByText('Weekly Quota (All Models)')).toBeTruthy();
    expect(screen.getByText('Weekly Quota (Fable)')).toBeTruthy();
  });
});
