/**
 * The bridge entry a resident Codex process calls.
 *
 * The credential it carries names a session, not a run. The authority for a
 * call comes from the engine call the host observed, so a call the engine
 * never made — or one that names another thread — is refused.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';

test('the bridge entry needs the engine call it names, not just the credential', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-bridge-routes-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-bridge-routes-jwt';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('bridge-user', 'hashed-password');
  sessionsDb.createSession('bridge-session', 'codex', temporaryDirectory, 'Bridge session');

  const {
    createTaskBridgeCredential,
    createTaskRunCapability,
    registerTaskBridgeCall,
    setTaskContinuationsEnabled,
    handleGetTaskStatus,
  } = await import('@/modules/task-continuations/index.js');
  const { taskBridgeRouter } = await import('@/modules/task-continuations/task-continuations.routes.js');

  const capability = createTaskRunCapability({
    userId: 1,
    sessionId: 'bridge-session',
    runId: 'bridge-run',
    providerThreadId: 'native-thread-1',
    sessionProjectPath: temporaryDirectory,
    cwd: temporaryDirectory,
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    approvalPolicy: 'never',
  });
  const credential = createTaskBridgeCredential({
    userId: 1,
    appSessionId: 'bridge-session',
    generation: 1,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', taskBridgeRouter);
  app.use((error: { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const invoke = (identity: Record<string, unknown>, args = { taskId: 'task_unknown' }) => fetch(`${baseUrl}/api/tasks/mcp/invoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tool: 'cloudcli_task_status',
      arguments: args,
      identity,
    }),
  });

  try {
    // With the switch off no round carries a run token, so no call is ever
    // announced. The bridge says so at once instead of waiting for one.
    const disabledStartedAt = Date.now();
    const disabled = await invoke({ callId: 'call-disabled', threadId: 'native-thread-1', turnId: 'native-turn-1' });
    assert.equal(disabled.status, 409);
    assert.equal((await disabled.json() as { code?: string }).code, 'TASK_CONTINUATIONS_DISABLED');
    assert.ok(Date.now() - disabledStartedAt < 1_000, 'a disabled bridge must not wait for an engine call');
    setTaskContinuationsEnabled(true);

    // The credential alone proves nothing: the engine never announced this
    // call, so there is no authority behind it.
    const unannounced = await invoke({ callId: 'call-unknown', threadId: 'native-thread-1', turnId: 'native-turn-1' });
    assert.equal(unannounced.status, 403);
    assert.equal((await unannounced.json() as { code?: string }).code, 'TASK_BRIDGE_CALL_UNKNOWN');

    registerTaskBridgeCall({
      appSessionId: 'bridge-session',
      threadId: 'native-thread-1',
      turnId: 'native-turn-1',
      callId: 'call-1',
      server: 'cloudcli_task_continuations',
      tool: 'cloudcli_task_status',
      runToken: capability.token,
      generation: 1,
      arguments: { taskId: 'task_unknown' },
    });

    // The announced call passes the gate; the task itself does not exist,
    // which is a different failure.
    const announced = await invoke({ callId: 'call-1', threadId: 'native-thread-1', turnId: 'native-turn-1' });
    assert.equal(announced.status, 404);
    assert.equal((await announced.json() as { code?: string }).code, 'TASK_NOT_FOUND');

    const tampered = await invoke({ callId: 'call-1', threadId: 'native-thread-1', turnId: 'native-turn-1' }, { taskId: 'another-task' });
    assert.equal(tampered.status, 403);
    assert.equal((await tampered.json() as { code?: string }).code, 'TASK_BRIDGE_CALL_MISMATCH');

    // A call that names another thread is not the call the engine made.
    const mismatched = await invoke({ callId: 'call-1', threadId: 'native-thread-other', turnId: 'native-turn-1' });
    assert.equal(mismatched.status, 403);
    assert.equal((await mismatched.json() as { code?: string }).code, 'TASK_BRIDGE_CALL_MISMATCH');

    // Native identity, rather than a restarted stdio counter, owns registration.
    const previousTasksRoot = process.env.CLOUDCLI_TASKS_DIR;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CLOUDCLI_TASKS_DIR = path.join(temporaryDirectory, 'tasks');
    process.env.CODEX_HOME = path.join(temporaryDirectory, 'codex');
    await fs.mkdir(process.env.CODEX_HOME);
    const taskArguments = { title: 'isolated bridge identity', command: process.execPath, args: ['-e', 'process.exit(0)'], notify: false };
    const taskIds = new Set<string>();
    const register = async (callId: string, requestId: string) => {
      registerTaskBridgeCall({
        appSessionId: 'bridge-session', generation: 1, threadId: 'native-thread-1', turnId: 'native-turn-1',
        callId, server: 'cloudcli_task_continuations', tool: 'cloudcli_task_run', arguments: taskArguments, runToken: capability.token,
      });
      const response = await fetch(`${baseUrl}/api/tasks/mcp/invoke`, {
        method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'cloudcli_task_run', arguments: taskArguments, requestId,
          identity: { callId, threadId: 'native-thread-1', turnId: 'native-turn-1' } }),
      });
      const payload = await response.json() as { data?: { taskId: string; duplicate: boolean }; code?: string };
      assert.ok(response.ok, JSON.stringify(payload));
      taskIds.add(payload.data!.taskId);
      return payload.data!;
    };
    try {
      const first = await register('native-register-1', 'stdio-1');
      const retry = await register('native-register-1', 'stdio-2');
      assert.equal(retry.taskId, first.taskId);
      assert.equal(retry.duplicate, true);
      const afterRestart = await register('native-register-2', 'stdio-1');
      assert.notEqual(afterRestart.taskId, first.taskId);
    } finally {
      // The detached worker only runs node's immediate exit in this test. Wait
      // for its real result before closing the isolated database and directory.
      const until = Date.now() + 15_000;
      for (const taskId of taskIds) {
        while (Date.now() < until) {
          const { task } = await handleGetTaskStatus(taskId, { userId: 1, sessionId: 'bridge-session' });
          if (['completed', 'failed', 'cancelled'].includes(task.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      if (previousTasksRoot === undefined) delete process.env.CLOUDCLI_TASKS_DIR;
      else process.env.CLOUDCLI_TASKS_DIR = previousTasksRoot;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }

    // A call without a credential is refused outright.
    const anonymous = await fetch(`${baseUrl}/api/tasks/mcp/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'cloudcli_task_status',
        arguments: { taskId: 'task_unknown' },
        identity: { callId: 'call-1', threadId: 'native-thread-1' },
      }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json() as { code?: string }).code, 'TASK_BRIDGE_CREDENTIAL_INVALID');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
