import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';

/**
 * Regression coverage for the composer's model list, which rendered labels
 * only. OpenCode Zen and OpenCode Go share model names (GLM 5.3, Kimi K3, ...),
 * so without the catalog description the duplicate entries were
 * indistinguishable and picking the right gateway was guesswork.
 */

const MODEL_OPTIONS = [
  { value: 'opencode/glm-5.3', label: 'GLM 5.3', description: 'OpenCode Zen' },
  { value: 'opencode-go/glm-5.3', label: 'GLM 5.3', description: 'OpenCode Go' },
];

const renderMenu = () => render(
  <ComposerModelMenu
    effort="default"
    effortOptions={[]}
    onSelectEffort={() => {}}
    model="opencode/glm-5.3"
    modelOptions={MODEL_OPTIONS}
    onSelectModel={() => {}}
    modelsLoading={false}
    modelsError={false}
    onReloadModels={() => {}}
  />,
);

test('the composer menu names the gateway of the selected model and of every option', () => {
  const { container, getAllByText, getByRole, getByText } = renderMenu();

  // The trigger's accessible name is translated, so it is located structurally.
  fireEvent.click(container.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement);

  // Collapsed: the section row names the gateway of the current selection...
  assert.ok(getByText('OpenCode Zen'));

  // ...and expanding the section names the gateway of every duplicate label.
  fireEvent.click(getByRole('menuitem'));
  assert.ok(getByText('OpenCode Go'));
  assert.equal(getAllByText('GLM 5.3').length >= 2, true);
});
