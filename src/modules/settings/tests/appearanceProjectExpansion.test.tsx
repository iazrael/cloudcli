import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import AppearanceSettingsTab from '@/modules/settings/tabs/AppearanceSettingsTab';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

vi.mock('@/modules/i18n', () => ({ LanguageSelector: () => null }));
vi.mock('@/shared/ui', () => ({ DarkModeToggle: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  resetUserPreferences();
  localStorage.clear();
});

const renderAppearance = () => render(
  <UiPreferencesProvider>
    <AppearanceSettingsTab
      projectSortOrder="name"
      onProjectSortOrderChange={() => {}}
      codeEditorSettings={{ wordWrap: true, showMinimap: true, lineNumbers: true, fontSize: '14' }}
      onCodeEditorWordWrapChange={() => {}}
      onCodeEditorShowMinimapChange={() => {}}
      onCodeEditorLineNumbersChange={() => {}}
      onCodeEditorFontSizeChange={() => {}}
    />
  </UiPreferencesProvider>,
);

test('appearance exposes the opt-in expansion switch and persists toggles', () => {
  const view = renderAppearance();
  const toggle = view.getByRole('switch', { name: 'appearanceSettings.keepProjectsExpanded.label' });
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(readStoredUiPreferences().keepProjectsExpanded, true);
  fireEvent.click(toggle);
  assert.equal(readStoredUiPreferences().keepProjectsExpanded, false);
});

test('appearance reflects asynchronously loaded expansion preferences', () => {
  const view = renderAppearance();
  act(() => writeUserPreference('uiPreferences', { keepProjectsExpanded: true }));
  assert.equal(view.getByRole('switch', { name: 'appearanceSettings.keepProjectsExpanded.label' }).getAttribute('aria-checked'), 'true');
});
