import assert from 'node:assert/strict';
import test from 'node:test';

import { createUserService } from '../user.service.js';

type UserDependencies = Parameters<typeof createUserService>[0];

function createDependencies(overrides: Partial<UserDependencies> = {}): UserDependencies {
  return {
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: () => undefined,
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    preferences: {
      getPreferences: () => ({}),
      savePreferences: () => undefined,
    },
    drafts: {
      getDrafts: () => [],
      saveDraftText: () => undefined,
      appendQueuedMessage: (_id, _scope, message) => ({ queuedMessage: message, appended: false }),
      clearQueuedMessage: () => true,
      deleteDraft: () => undefined,
    },
    readSystemGitConfig: async () => ({ git_name: null, git_email: null }),
    applyGlobalGitConfig: async () => undefined,
    logInfo: () => undefined,
    logError: () => undefined,
    ...overrides,
  };
}

test('getGitConfig imports system configuration when the repository is empty', async () => {
  const updates: unknown[][] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (...args) => updates.push(args),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    readSystemGitConfig: async () => ({ git_name: 'Alice', git_email: 'alice@example.com' }),
  }));

  const result = await service.getGitConfig(7);

  assert.equal(result.gitName, 'Alice');
  assert.deepEqual(updates, [[7, 'Alice', 'alice@example.com']]);
});

test('updateGitConfig persists valid input and invokes the Git adapter', async () => {
  const operations: string[] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (_id, name, email) => operations.push(`persist:${name}:${email}`),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    applyGlobalGitConfig: async (name, email) => {
      operations.push(`git:${name}:${email}`);
    },
  }));

  await service.updateGitConfig(1, 'Alice', 'alice@example.com');
  assert.deepEqual(operations, [
    'persist:Alice:alice@example.com',
    'git:Alice:alice@example.com',
  ]);
});

test('savePreferences forwards only the keys the client sent', () => {
  const saved: Array<Record<string, unknown>> = [];
  const service = createUserService(createDependencies({
    preferences: {
      getPreferences: () => ({ theme: 'dark' }),
      savePreferences: (_id, updates) => saved.push(updates),
    },
  }));

  const result = service.savePreferences(3, { theme: 'light' });

  assert.deepEqual(saved, [{ theme: 'light' }]);
  assert.deepEqual(result.preferences, { theme: 'dark' });
});

test('savePreferences rejects a non-object body', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.savePreferences(3, ['theme']), /object/i);
  assert.throws(() => service.savePreferences(3, 'theme'), /object/i);
});

test('savePreferences rejects an over-long preference key', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.savePreferences(3, { ['k'.repeat(201)]: 1 }), /1-200/);
});

test('legacy queue snapshots fail without changing text or queue', () => {
  const writes: unknown[] = [];
  const deps = createDependencies();
  deps.drafts.saveDraftText = (...args) => { writes.push(args); };
  const service = createUserService(deps);
  for (const queuedMessage of [{ content: 'stale' }, undefined]) {
    assert.throws(() => service.saveDraft(5, 'session', { text: 'changed', queuedMessage }), { code: 'LEGACY_QUEUE_WRITE', statusCode: 409 });
  }
  assert.deepEqual(writes, []);
  service.saveDraft(5, 'session', { text: 'typing' });
  assert.deepEqual(writes, [[5, 'session', 'typing']]);
});

test('an old page can safely save a new-chat draft with a null queue', () => {
  const writes: unknown[][] = [];
  const deps = createDependencies();
  deps.drafts.saveDraftText = (...args) => writes.push(args);
  const service = createUserService(deps);
  service.saveDraft(5, 'project:p1', { text: 'new chat unsent paragraph', queuedMessage: null });
  assert.deepEqual(writes, [[5, 'project:p1', 'new chat unsent paragraph']]);
});

test('legacy queue rejection asks the session channel to show a refresh notice', () => {
  const notices: unknown[][] = [];
  const service = createUserService(createDependencies({
    notifyLegacyQueueWrite: (...args) => notices.push(args),
  }));
  assert.throws(() => service.saveDraft(5, 'session', { text: '', queuedMessage: { content: 'unsaved' } }), { code: 'LEGACY_QUEUE_WRITE' });
  assert.deepEqual(notices, [[5, 'session']]);
});

test('append validates message and scope, preserves settings without broadening permissions, and maps conflicts', () => {
  const deps = createDependencies();
  const service = createUserService(deps);
  assert.deepEqual(service.appendQueuedMessage(1, 'session', { content: 'A', options: { permissionMode: 'plan' } }), { success: true, queuedMessage: { content: 'A', attachments: [], options: { permissionMode: 'plan' } }, appended: false });
  for (const value of [null, [], {}, { content: ' ' }, { content: 4 }, { content: 'x', attachments: 'bad' }, { content: 'x', options: [] }]) {
    assert.throws(() => service.appendQueuedMessage(1, 'session', value), { code: 'INVALID_QUEUED_MESSAGE', statusCode: 400 });
  }
  assert.throws(() => service.appendQueuedMessage(1, '', { content: 'A' }), /scope/i);
  assert.throws(() => service.appendQueuedMessage(1, 'session', { content: 'x'.repeat(100_001) }), { statusCode: 413 });
  deps.drafts.appendQueuedMessage = () => null;
  assert.throws(() => service.appendQueuedMessage(1, 'session', { content: '/help' }), { code: 'QUEUED_MESSAGE_NOT_COMBINABLE', statusCode: 409 });
});

test('saveDraft rejects a blank or over-long scope', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.saveDraft(5, '   ', { text: 'x' }), /scope/i);
  assert.throws(() => service.saveDraft(5, 'x'.repeat(201), { text: 'x' }), /scope/i);
});

test('saveDraft rejects text past the storage limit', () => {
  const service = createUserService(createDependencies());

  assert.throws(
    () => service.saveDraft(5, 'session-1', { text: 'x'.repeat(100_001) }),
    /too long/i,
  );
});
