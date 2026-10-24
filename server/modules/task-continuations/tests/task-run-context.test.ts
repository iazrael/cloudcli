import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('task run capability resolves only its trusted run context and expires on revocation', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'task-run-context-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-context-test-jwt';
  const {
    createTaskRunCapability,
    revokeTaskRunCapability,
    resolveTaskRunCapability,
  } = await import('@/modules/task-continuations/index.js');

  try {
  const context = {
    userId: 7,
    sessionId: 'session-trusted',
    runId: 'run-trusted',
    providerThreadId: null,
    sessionProjectPath: '/workspace/project',
    cwd: '/workspace/project',
    sandboxPolicy: { type: 'workspaceWrite' as const, networkAccess: false as const },
    approvalPolicy: 'never' as const,
  };
  const capability = createTaskRunCapability(context);

  assert.ok(capability.token.length >= 40);
  assert.deepEqual(resolveTaskRunCapability(capability.token), context);
  const { setTaskRunProviderThreadId } = await import('@/modules/task-continuations/index.js');
  assert.equal(setTaskRunProviderThreadId(capability.token, 'native-thread-1'), true);
  assert.equal(resolveTaskRunCapability(capability.token)?.providerThreadId, 'native-thread-1');
  assert.equal(setTaskRunProviderThreadId(capability.token, 'native-thread-current'), true);
  assert.equal(resolveTaskRunCapability(capability.token)?.providerThreadId, 'native-thread-current');
  assert.equal(resolveTaskRunCapability('client-forged-token'), null);
  assert.equal(revokeTaskRunCapability(capability.token), true);
  assert.equal(resolveTaskRunCapability(capability.token), null);
  assert.equal(revokeTaskRunCapability(capability.token), false);
  } finally {
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    // The capability store opened the temp database lazily; Windows keeps the
    // file busy until the connection closes, so close it before removing the
    // directory (and retry the removal for slower file-handle release).
    const database = await import('@/modules/database/index.js');
    database.closeConnection();
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
