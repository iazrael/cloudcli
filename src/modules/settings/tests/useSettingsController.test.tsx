import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type * as ChatModule from '@/modules/chat';

/**
 * The settings dialog is one of two writers of per-provider tool permissions
 * (the other is an in-chat grant). These tests pin the channel switch: the
 * dialog reads and writes the preference store, and the legacy localStorage
 * blobs are no longer a source of truth in either direction.
 */

vi.mock('@/shared/api', () => ({
  authenticatedFetch: vi.fn(async () =>
    new Response(
      JSON.stringify({ success: true, preferences: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  ),
  api: {
    user: {
      preferences: async () =>
        new Response(JSON.stringify({ success: true, preferences: {} }), { status: 200 }),
      savePreferences: async () => new Response('{}', { status: 200 }),
    },
  },
}));

vi.mock('@/modules/chat', async (importOriginal) => {
  // Keep the real storage helpers: the permissions assertions below must
  // exercise the same helpers the controller reads through.
  const actual = (await importOriginal()) as typeof ChatModule;
  return {
    setNotificationSoundEnabled: vi.fn(),
    readProviderToolsSettings: actual.readProviderToolsSettings,
    toClaudePermissionMode: actual.toClaudePermissionMode,
  };
});

vi.mock('@/modules/provider-auth', () => {
  // The controller lists refreshProviderAuthStatuses in an effect's dependency
  // array, so the mock must hand back a stable identity per render — a fresh
  // vi.fn() per call would re-trigger the load effect forever.
  const checkProviderAuthStatus = vi.fn();
  const refreshProviderAuthStatuses = vi.fn();
  return {
    useProviderAuthStatus: () => ({
      providerAuthStatus: {},
      checkProviderAuthStatus,
      refreshProviderAuthStatuses,
    }),
  };
});

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({
    isDarkMode: true,
    toggleDarkMode: vi.fn(),
  }),
}));

const load = async () => {
  const [hooks, userSettings] = await Promise.all([
    import('@/modules/settings/hooks/useSettingsController'),
    import('@/shared/userSettings'),
  ]);
  // One store instance backs the whole file; drop any writes a previous test
  // left behind so each test starts from an empty account.
  userSettings.resetUserPreferences();
  return {
    useSettingsController: hooks.useSettingsController,
    userSettings,
  };
};

beforeEach(() => {
  localStorage.clear();
});

test('loads permissions from the preference store', async () => {
  const { useSettingsController, userSettings } = await load();

  userSettings.writeUserPreference('claudePermissions', {
    permissionMode: 'acceptEdits',
    allowedTools: ['Bash(git:*)'],
    disallowedTools: [],
  });
  userSettings.writeUserPreference('codexPermissions', { permissionMode: 'bypassPermissions' });
  userSettings.writeUserPreference('projectSortOrder', 'date');

  const { result } = renderHook(() => useSettingsController({ isOpen: true, initialTab: 'agents' }));

  await waitFor(() => assert.equal(result.current.projectSortOrder, 'date'));
  assert.deepEqual(result.current.claudePermissions.allowedTools, ['Bash(git:*)']);
  assert.equal(result.current.claudePermissions.permissionMode, 'acceptEdits');
  assert.equal(result.current.codexPermissionMode, 'bypassPermissions');
});

test('a stale legacy localStorage blob no longer feeds the dialog', async () => {
  const { useSettingsController, userSettings } = await load();

  localStorage.setItem('claude-settings', JSON.stringify({
    allowedTools: ['LegacyTool'],
    skipPermissions: true,
    projectSortOrder: 'name',
  }));
  userSettings.writeUserPreference('claudePermissions', {
    allowedTools: ['StoreTool'],
    disallowedTools: [],
  });

  const { result } = renderHook(() => useSettingsController({ isOpen: true, initialTab: 'agents' }));

  await waitFor(() => assert.deepEqual(result.current.claudePermissions.allowedTools, ['StoreTool']));
  assert.equal(result.current.claudePermissions.permissionMode, 'default');
});

test('auto-save writes the preference store and leaves legacy keys untouched', async () => {
  const { useSettingsController, userSettings } = await load();

  const { result } = renderHook(() => useSettingsController({ isOpen: true, initialTab: 'agents' }));
  await waitFor(() => assert.equal(result.current.projectSortOrder, 'name'));

  act(() => {
    result.current.setClaudePermissions({
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash(npm run:*)'],
      disallowedTools: [],
    });
    result.current.setCodexPermissionMode('bypassPermissions');
    result.current.setProjectSortOrder('date');
  });

  // The dialog has no save button for these — the debounced auto-save is the
  // real write path, so wait out its 500ms.
  await new Promise((resolve) => setTimeout(resolve, 800));

  assert.deepEqual(userSettings.readUserPreference('claudePermissions', null), {
    permissionMode: 'acceptEdits',
    allowedTools: ['Bash(npm run:*)'],
    disallowedTools: [],
  });
  assert.deepEqual(userSettings.readUserPreference('codexPermissions', null), {
    permissionMode: 'bypassPermissions',
  });
  assert.equal(userSettings.readUserPreference('projectSortOrder', 'name'), 'date');
  assert.equal(localStorage.getItem('claude-settings'), null);
  assert.equal(localStorage.getItem('codex-settings'), null);
});

test('editor setting changes land in the preference store, not legacy keys', async () => {
  const { useSettingsController, userSettings } = await load();

  const { result } = renderHook(() => useSettingsController({ isOpen: true, initialTab: 'appearance' }));
  await waitFor(() => assert.equal(result.current.projectSortOrder, 'name'));

  act(() => {
    result.current.updateCodeEditorSetting('fontSize', '18');
  });

  assert.equal(
    (userSettings.readUserPreference<Record<string, unknown>>('codeEditorSettings', {}) as Record<string, unknown>).fontSize,
    '18',
  );
  assert.equal(localStorage.getItem('codeEditorFontSize'), null);
});
