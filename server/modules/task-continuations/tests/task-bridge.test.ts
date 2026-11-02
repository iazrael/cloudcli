/**
 * The bridge between a resident Codex process and the host's task routes.
 *
 * A resident process outlives the round that started it, so it carries a
 * narrow session credential instead of the round's capability. The credential
 * alone must not be able to operate a task: a call is only accepted when the
 * host has seen the engine call it names.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/index.js';

test('a bridge credential resolves only its own session', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'task-bridge-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-bridge-test-jwt';
  const {
    createTaskBridgeCredential,
    resolveTaskBridgeCredential,
    revokeTaskBridgeCredential,
  } = await import('@/modules/task-continuations/index.js');

  try {
    const credential = createTaskBridgeCredential({
      userId: 7,
      appSessionId: 'session-resident',
      generation: 3,
    });

    assert.ok(credential.token.startsWith('tbc_'));
    assert.deepEqual(resolveTaskBridgeCredential(credential.token), {
      userId: 7,
      appSessionId: 'session-resident',
      generation: 3,
    });
    assert.equal(resolveTaskBridgeCredential('client-forged-token'), null);
    assert.equal(revokeTaskBridgeCredential(credential.token), true);
    assert.equal(resolveTaskBridgeCredential(credential.token), null);
  } finally {
    closeConnection();
    process.env.DATABASE_PATH = previousDatabasePath;
    process.env.JWT_SECRET = previousJwtSecret;
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('an observed engine call is matched by the session and the call id', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'task-bridge-calls-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-bridge-calls-test-jwt';
  const {
    registerTaskBridgeCall,
    resolveTaskBridgeCall,
    waitForTaskBridgeCall,
  } = await import('@/modules/task-continuations/index.js');

  try {
    registerTaskBridgeCall({
      appSessionId: 'session-resident',
      threadId: 'native-thread-1',
      turnId: 'native-turn-1',
      callId: 'call-1',
      server: 'cloudcli_task_continuations',
      tool: 'cloudcli_task_run',
      runToken: 'trc_round_1',
      generation: 3,
      arguments: {},
    });

    const found = resolveTaskBridgeCall('session-resident', 'call-1', 3);
    assert.equal(found?.threadId, 'native-thread-1');
    assert.equal(found?.turnId, 'native-turn-1');
    assert.equal(found?.runToken, 'trc_round_1');

    assert.equal(resolveTaskBridgeCall('session-resident', 'call-1', 4), null);
    registerTaskBridgeCall({
      appSessionId: 'session-resident', generation: 4, threadId: 'new-native-thread', turnId: 'new-native-turn',
      callId: 'call-1', server: 'cloudcli_task_continuations', tool: 'cloudcli_task_run',
      arguments: {}, runToken: 'trc_round_2',
    });
    assert.equal(resolveTaskBridgeCall('session-resident', 'call-1', 3)?.runToken, 'trc_round_1');
    assert.equal(resolveTaskBridgeCall('session-resident', 'call-1', 4)?.runToken, 'trc_round_2');

    // A call of another session is not this call.
    assert.equal(resolveTaskBridgeCall('session-other', 'call-1', 3), null);
    assert.equal(resolveTaskBridgeCall('session-resident', 'call-unknown', 3), null);
  } finally {
    closeConnection();
    process.env.DATABASE_PATH = previousDatabasePath;
    process.env.JWT_SECRET = previousJwtSecret;
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a bridge call waits for the engine call and gives up when it never comes', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'task-bridge-wait-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-bridge-wait-test-jwt';
  const {
    registerTaskBridgeCall,
    waitForTaskBridgeCall,
  } = await import('@/modules/task-continuations/index.js');

  try {
    // The engine's record arrives after the call does: the two travel on
    // different channels.
    const pending = waitForTaskBridgeCall('session-resident', 'call-late', 3, 2_000);
    setTimeout(() => {
      registerTaskBridgeCall({
        appSessionId: 'session-resident',
        threadId: 'native-thread-1',
        turnId: 'native-turn-1',
        callId: 'call-late',
        server: 'cloudcli_task_continuations',
        tool: 'cloudcli_task_run',
        runToken: 'trc_round_1',
      generation: 3,
      arguments: {},
      });
    }, 60);

    const found = await pending;
    assert.equal(found?.callId, 'call-late');

    const never = await waitForTaskBridgeCall('session-resident', 'call-never', 3, 100);
    assert.equal(never, null);
  } finally {
    closeConnection();
    process.env.DATABASE_PATH = previousDatabasePath;
    process.env.JWT_SECRET = previousJwtSecret;
    await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
