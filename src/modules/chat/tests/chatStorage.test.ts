import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';

/**
 * readProviderToolsSettings is the one read path `chat.send` uses for
 * per-provider tool permissions. The mapping must stay per-provider: a key
 * falling through to Claude's would silently hand another engine Claude's
 * allow-list or skipPermissions.
 *
 * Fresh module copies per test because the preference store reads its
 * localStorage mirror once at module scope.
 */

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: async () =>
        new Response(JSON.stringify({ success: true, preferences: {} }), { status: 200 }),
      savePreferences: async () => new Response('{}', { status: 200 }),
    },
  },
}));

const loadModules = async () => {
  vi.resetModules();
  const userSettings = await import('@/shared/userSettings');
  const chatStorage = await import('@/modules/chat/utils/chatStorage');
  return { userSettings, chatStorage };
};

beforeEach(() => {
  localStorage.clear();
});

test('reads each provider permissions from its own preference key', async () => {
  const { userSettings, chatStorage } = await loadModules();

  userSettings.writeUserPreference('claudePermissions', {
    allowedTools: ['Read'],
    disallowedTools: [],
    skipPermissions: false,
  });
  userSettings.writeUserPreference('codexPermissions', { permissionMode: 'acceptEdits' });
  userSettings.writeUserPreference('zcodePermissions', { permissionMode: 'plan' });

  assert.deepEqual(chatStorage.readProviderToolsSettings('claude'), {
    allowedTools: ['Read'],
    disallowedTools: [],
    skipPermissions: false,
  });
  assert.deepEqual(chatStorage.readProviderToolsSettings('codex'), { permissionMode: 'acceptEdits' });
  assert.deepEqual(chatStorage.readProviderToolsSettings('zcode'), { permissionMode: 'plan' });
});

test("an unset provider comes back empty instead of inheriting claude's settings", async () => {
  const { userSettings, chatStorage } = await loadModules();

  userSettings.writeUserPreference('claudePermissions', { skipPermissions: true });

  assert.deepEqual(chatStorage.readProviderToolsSettings('opencode'), {});
  assert.deepEqual(chatStorage.readProviderToolsSettings('cursor'), {});
});
