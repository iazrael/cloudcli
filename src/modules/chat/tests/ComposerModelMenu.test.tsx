import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || _key,
  }),
}));

describe('ComposerModelMenu', () => {
  const modelOptions = [
    {
      value: 'GLM-5.3',
      label: 'GLM-5.3',
      group: 'BigModel (个人)',
    },
    {
      value: 'GLM-5.3-Flash',
      label: 'GLM-5.3-Flash',
      group: 'BigModel (个人)',
    },
    {
      value: 'account:bigmodel-start-plan/GLM-5.3-Flash',
      label: 'GLM-5.3-Flash',
      group: 'BigModel (体验)',
    },
  ];

  it('renders friendly label on trigger and never leaks raw provider id', () => {
    const { rerender } = render(
      <ComposerModelMenu
        effort="default"
        effortOptions={[]}
        onSelectEffort={vi.fn()}
        model="account:bigmodel-start-plan/GLM-5.3-Flash"
        modelOptions={modelOptions}
        onSelectModel={vi.fn()}
        modelsLoading={false}
        modelsError={false}
        onReloadModels={vi.fn()}
      />
    );

    const trigger = screen.getByRole('button');
    assert.equal(trigger.textContent?.trim(), 'GLM-5.3-Flash');
    assert.equal(trigger.textContent?.includes('account:bigmodel-start-plan'), false);

    // Even if options are still loading and model is just raw id string, it should not leak raw providerId
    rerender(
      <ComposerModelMenu
        effort="default"
        effortOptions={[]}
        onSelectEffort={vi.fn()}
        model="account:bigmodel-start-plan/GLM-5.3-Flash"
        modelOptions={[]}
        onSelectModel={vi.fn()}
        modelsLoading={true}
        modelsError={false}
        onReloadModels={vi.fn()}
      />
    );
    assert.equal(screen.getByRole('button').textContent?.trim(), 'GLM-5.3-Flash');
  });

  it('renders grouped headings and friendly labels inside dropdown', () => {
    const onSelectModel = vi.fn();
    render(
      <ComposerModelMenu
        effort="default"
        effortOptions={[]}
        onSelectEffort={vi.fn()}
        model="account:bigmodel-start-plan/GLM-5.3-Flash"
        modelOptions={modelOptions}
        onSelectModel={onSelectModel}
        modelsLoading={false}
        modelsError={false}
        onReloadModels={vi.fn()}
      />
    );

    // Open menu
    fireEvent.click(screen.getByRole('button'));

    // The sub-item collapsible parent shows modelLabel and group
    const modelRow = screen.getByText('GLM-5.3-Flash · BigModel (体验)');
    assert.ok(modelRow);

    // Expand model section
    fireEvent.click(modelRow);

    // Check headings
    assert.ok(screen.getByText('BigModel (个人)'));
    assert.ok(screen.getByText('BigModel (体验)'));

    // Check all 3 model options are rendered
    const items = screen.getAllByText('GLM-5.3-Flash');
    assert.ok(items.length >= 2); // In menu and button

    // Click the start-plan option
    const startPlanItem = screen.getByRole('menuitemradio', {
      name: /GLM-5.3-Flash/i,
      checked: true,
    });
    assert.ok(startPlanItem);
    fireEvent.click(startPlanItem);
    expect(onSelectModel).toHaveBeenCalledWith('account:bigmodel-start-plan/GLM-5.3-Flash');
  });

  // OpenCode Zen and OpenCode Go share model names (GLM 5.3, Kimi K3, ...), so
  // without the catalog description the duplicate entries were
  // indistinguishable and picking the right gateway was guesswork.
  it('names the gateway of the selected model and of every option', () => {
    const gatewayOptions = [
      { value: 'opencode/glm-5.3', label: 'GLM 5.3', description: 'OpenCode Zen' },
      { value: 'opencode-go/glm-5.3', label: 'GLM 5.3', description: 'OpenCode Go' },
    ];
    const { container, getAllByText, getByRole, getByText } = render(
      <ComposerModelMenu
        effort="default"
        effortOptions={[]}
        onSelectEffort={vi.fn()}
        model="opencode/glm-5.3"
        modelOptions={gatewayOptions}
        onSelectModel={vi.fn()}
        modelsLoading={false}
        modelsError={false}
        onReloadModels={vi.fn()}
      />
    );

    fireEvent.click(container.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement);

    // Collapsed: the section row names the gateway of the current selection...
    assert.ok(getByText('OpenCode Zen'));

    // ...and expanding the section names the gateway of every duplicate label.
    fireEvent.click(getByRole('menuitem'));
    assert.ok(getByText('OpenCode Go'));
    assert.equal(getAllByText('GLM 5.3').length >= 2, true);
  });
});
