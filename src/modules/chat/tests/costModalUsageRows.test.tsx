import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';

import { i18n, initI18n } from '@/modules/i18n';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import type { CostCommandData, ProviderModelActions } from '@/shared/types';

/**
 * Pins the cost detail's fixed row set: every engine reports the same five
 * readings, the session total never gets the context occupancy's value, and a
 * provider that cannot report one shows a placeholder instead of dropping the
 * row. A 46K context reading against a 475K window previously surfaced as
 * "总用量 46K", which read as the conversation's total spend.
 */

await initI18n();

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authenticatedFetch: vi.fn(),
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilitiesMap: () => ({ capabilities: {}, loaded: true }),
}));

const noopActions: ProviderModelActions = {
  create: vi.fn(() => Promise.resolve()),
  update: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()),
  setCustomModelsOnly: vi.fn(() => Promise.resolve()),
};

function renderCostModal(data: CostCommandData) {
  render(
    <I18nextProvider i18n={i18n}>
      <CommandResultModal
        payload={{ kind: 'cost', data }}
        onClose={vi.fn()}
        providerModelCatalog={{}}
        providerModelActions={noopActions}
        activeProvider="codex"
        activeProviderModel="gpt-6.2-sol"
        currentSessionId={null}
        onSelectProviderModel={vi.fn(() => Promise.resolve({ scope: 'default' as const, model: 'gpt-6.2-sol' }))}
      />
    </I18nextProvider>,
  );
}

/** The value rendered to the right of one usage row. */
const valueOf = (label: string): string | null => {
  const row = screen.getByText(label).closest('div.flex.items-center.justify-between');
  return row?.querySelector('span.font-mono')?.textContent ?? null;
};

describe('CommandResultModal → cost usage rows', () => {
  it('shows the session total separately from the context reading', () => {
    renderCostModal({
      provider: 'codex',
      model: 'gpt-6.2-sol',
      tokenUsage: { used: 335_960, total: 475_000 },
      tokenBreakdown: { input: 335_462, output: 498 },
      cumulativeUsage: { used: 33_389_947, inputTokens: 33_271_701, outputTokens: 118_246 },
    });

    expect(valueOf('Total tokens (session)')).toBe('33,389,947');
    expect(valueOf('Input tokens (session)')).toBe('33,271,701');
    expect(valueOf('Output tokens (session)')).toBe('118,246');
    expect(valueOf('Current context')).toBe('335,960');
    expect(valueOf('Context window')).toBe('475,000');
  });

  it('keeps every row when an engine reports no cumulative block', () => {
    renderCostModal({
      provider: 'opencode',
      model: 'deepseek-v4.1-flash',
      tokenUsage: { used: 46_196 },
    });

    expect(valueOf('Total tokens (session)')).toBe('—');
    expect(valueOf('Input tokens (session)')).toBe('—');
    expect(valueOf('Output tokens (session)')).toBe('—');
    expect(valueOf('Current context')).toBe('46,196');
    expect(valueOf('Context window')).toBe('—');
  });
});
