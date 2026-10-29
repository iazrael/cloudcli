import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import AgentsSettingsTab from '@/modules/settings/tabs/agents-settings/AgentsSettingsTab';
import type { AgentProvider, ProviderAuthStatus } from '@/shared/types';
import { initI18n } from '@/modules/i18n';

// Copy assertions need real translations; bundles load per language (see docs/design/i18n按语言懒加载.md).
await initI18n();

/**
 * The agents tab shows a "Permissions" tab for every provider, so a provider
 * whose permission branch is missing from AgentCategoryContentSection renders
 * an empty pane with no error — exactly how opencode shipped blank. Walk every
 * provider through the tab and fail when the pane has no content.
 */

const PROVIDERS: AgentProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'zcode', 'antigravity'];

/**
 * A sentence only that provider's panel can contain. Asserting it (rather than
 * merely "some text appeared") also fails when a provider renders another
 * provider's panel.
 */
const PROVIDER_ONLY_TEXT: Record<AgentProvider, string> = {
  claude: 'Controls how Claude asks for approval',
  cursor: 'Skip permission prompts',
  codex: 'Controls how Codex handles file modifications',
  opencode: 'Controls which OpenCode actions need your approval',
  zcode: 'Controls how ZCode handles file edits',
  antigravity: 'Controls how Antigravity handles file edits',
};

const authStatus = (installed: boolean): ProviderAuthStatus => ({
  installed,
  authenticated: false,
  email: null,
  method: null,
  error: null,
  loginCommand: null,
  loading: false,
});

const renderPermissionsTab = (provider: AgentProvider, allowedTools: string[] = []) => {
  const providerAuthStatus = Object.fromEntries(
    PROVIDERS.map((candidate) => [candidate, authStatus(candidate === provider)]),
  ) as Record<AgentProvider, ProviderAuthStatus>;

  // Only the provider under test reports as installed, so the tab selects it on
  // its own and the assertion covers the provider/category wiring too.
  const view = render(
    <AgentsSettingsTab
      providerAuthStatus={providerAuthStatus}
      onProviderLogin={() => {}}
      claudePermissions={{ permissionMode: 'default', allowedTools, disallowedTools: [] }}
      onClaudePermissionsChange={() => {}}
      cursorPermissions={{ skipPermissions: false, allowedCommands: [], disallowedCommands: [] }}
      onCursorPermissionsChange={() => {}}
      codexPermissionMode="default"
      onCodexPermissionModeChange={() => {}}
      antigravityPermissionMode="default"
      onAntigravityPermissionModeChange={() => {}}
      zcodePermissionMode="default"
      onZcodePermissionModeChange={() => {}}
      opencodePermissionMode="default"
      onOpencodePermissionModeChange={() => {}}
      projects={[]}
    />,
  );

  fireEvent.click(screen.getByRole('tab', { name: 'Permissions' }));

  return {
    pane: screen.getByTestId('agent-category-content'),
    unmount: view.unmount,
  };
};

test('每个提供商的权限标签都有内容', () => {
  for (const provider of PROVIDERS) {
    const { pane, unmount } = renderPermissionsTab(provider);
    assert.notEqual(
      (pane.textContent ?? '').trim(),
      '',
      `${provider} 的权限标签渲染为空`,
    );
    assert.ok(
      (pane.textContent ?? '').includes(PROVIDER_ONLY_TEXT[provider]),
      `${provider} 的权限标签渲染的是别的提供商的面板`,
    );
    unmount();
  }
});

test('a saved legacy Task rule counts as the Agent preset already being added', () => {
  // The CLI resolves a `Task` rule to `Agent`, so offering to add `Agent`
  // again would leave two rules for one tool.
  const withLegacy = renderPermissionsTab('claude', ['Task']);
  const presetWithLegacy = within(withLegacy.pane).getByRole('button', { name: 'Agent' }) as HTMLButtonElement;
  assert.equal(presetWithLegacy.disabled, true);
  withLegacy.unmount();

  const without = renderPermissionsTab('claude', []);
  const preset = within(without.pane).getByRole('button', { name: 'Agent' }) as HTMLButtonElement;
  assert.equal(preset.disabled, false);
  without.unmount();
});
