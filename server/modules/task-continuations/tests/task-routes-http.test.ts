import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase, sessionsDb, taskContinuationDb, userDb } from '@/modules/database/index.js';
import { runTaskContinuationsMcp } from '@/modules/task-continuations/cli/task-continuations-mcp.js';
import { handleTaskRegisterRequest } from '@/modules/task-continuations/task-continuations.service.js';

import { createTestUserToken } from './helpers/user-token.js';
import { isCodexCommandSandboxAvailable } from './helpers/codex-sandbox-availability.js';

async function callMcpTool(name: string, args: Record<string, unknown>, env: NodeJS.ProcessEnv, id = 1): Promise<any> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on('data', (chunk) => chunks.push(String(chunk)));
  const done = runTaskContinuationsMcp({ stdin, stdout, env });
  stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  })}\n`);
  stdin.end();
  await done;
  return JSON.parse(chunks.join('').trim());
}

test('task status requires a user-authenticated HTTP request', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-routes-http-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-routes-http-suite-jwt';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('http-user', 'hashed-password');
  sessionsDb.createSession('http-session', 'codex', '/workspace/demo', 'HTTP test session');

  const registered = await handleTaskRegisterRequest({
    userId: 1,
    sessionId: 'http-session',
    runId: 'http-run',
    title: 'HTTP 状态权限',
  });
  taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
    taskId: registered.taskId, status: 'completed', exitCode: 0,
    resultDigest: 'status-disabled-digest', resultSummary: 'result saved',
  });
  const userToken = createTestUserToken(1, 'http-user');
  const { taskContinuationsRouter } = await import('@/modules/task-continuations/task-continuations.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', taskContinuationsRouter);
  app.use((error: { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/api/tasks/${registered.taskId}`);
    assert.equal(response.status, 401);
    const body = await response.json() as { code?: string };
    assert.equal(body.code, 'AUTH_TOKEN_INVALID');

    const authenticated = await fetch(`${baseUrl}/api/tasks/${registered.taskId}`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(authenticated.status, 200);
    const status = await authenticated.json() as { data?: { continuationHint?: { code?: string; next_step?: string } } };
    assert.equal(status.data?.continuationHint?.code, 'continuations_disabled');
    assert.match(status.data?.continuationHint?.next_step ?? '', /--enabled true/);
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

test('legacy task registration route rejects requests without a trusted run capability', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-legacy-register-http-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-routes-http-suite-jwt';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('legacy-register-user', 'hashed-password');
  sessionsDb.createSession('legacy-register-session', 'codex', temporaryDirectory, 'Legacy register session');
  const userToken = createTestUserToken(1, 'legacy-register-user');
  const { taskContinuationsRouter } = await import('@/modules/task-continuations/task-continuations.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', taskContinuationsRouter);
  app.use((error: { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${baseUrl}/api/tasks/register`, {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'legacy-register-session', runId: 'client-selected-run',
        title: 'untrusted task', command: 'echo must not register',
      }),
    });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { code: 'TASK_REGISTRATION_UNSUPPORTED' });
    const taskRows = getConnection().prepare('SELECT COUNT(*) AS count FROM async_tasks').get() as { count: number };
    assert.equal(taskRows.count, 0);
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

test('manual retry requires owner confirmation and leaves an audit warning', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manual-retry-http-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-routes-http-suite-jwt';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('manual-owner', 'hashed-password');
  userDb.createUser('manual-other', 'hashed-password');
  sessionsDb.createSession('manual-session', 'codex', temporaryDirectory, 'Manual retry session');
  const registered = await handleTaskRegisterRequest({
    userId: 1, sessionId: 'manual-session', title: '人工确认后重试', autoNotify: true,
  });
  const completion = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
    taskId: registered.taskId, status: 'completed', exitCode: 0,
    resultDigest: 'manual-retry-http-digest', resultSummary: '已完成',
  });
  taskContinuationDb.updateEventFailed({
    eventId: completion.eventId!, error: 'history is incomplete', terminalStatus: 'needs_review', expectedStatus: 'pending',
  });
  const ownerToken = createTestUserToken(1, 'manual-owner');
  const otherToken = createTestUserToken(2, 'manual-other');
  const { taskContinuationsRouter } = await import('@/modules/task-continuations/task-continuations.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', taskContinuationsRouter);
  app.use((error: { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const pathName = `/api/tasks/${registered.taskId}/retry-notification`;
    const unconfirmed = await fetch(`${baseUrl}${pathName}`, {
      method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '检查过任务输出' }),
    });
    assert.equal(unconfirmed.status, 400);

    const wrongOwner = await fetch(`${baseUrl}${pathName}`, {
      method: 'POST', headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmMayDuplicate: true, reason: '确认重复风险' }),
    });
    assert.equal(wrongOwner.status, 404);

    const confirmed = await fetch(`${baseUrl}${pathName}`, {
      method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmMayDuplicate: true, reason: '确认检查产物并接受重复汇报风险' }),
    });
    assert.equal(confirmed.status, 200);
    assert.equal(taskContinuationDb.getEventById(completion.eventId!)?.status, 'pending');
    assert.match(taskContinuationDb.getEventById(completion.eventId!)?.last_error ?? '', /may already have run/i);
    const audit = getConnection().prepare(
      'SELECT user_id, reason FROM task_continuation_manual_actions WHERE event_id = ?',
    ).get(completion.eventId!) as { user_id: number; reason: string };
    assert.deepEqual(audit, { user_id: 1, reason: '确认检查产物并接受重复汇报风险' });
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

test('cancelling future notification is authorized and an accepted turn returns conflict', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-cancel-future-http-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-routes-http-suite-jwt';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('cancel-owner', 'hashed-password');
  sessionsDb.createSession('cancel-session', 'codex', temporaryDirectory, 'Cancel future notification');
  const registered = await handleTaskRegisterRequest({
    userId: 1, sessionId: 'cancel-session', title: '稍后完成', autoNotify: true,
  });
  const jwtToken = createTestUserToken(1, 'cancel-owner');
  const { taskContinuationsRouter } = await import('@/modules/task-continuations/task-continuations.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', taskContinuationsRouter);
  app.use((error: { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const cancelResponse = await fetch(`${baseUrl}/api/tasks/${registered.taskId}/cancel-notification`, {
      method: 'POST', headers: { authorization: `Bearer ${jwtToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '不要自动回聊天' }),
    });
    assert.equal(cancelResponse.status, 200);
    assert.equal(taskContinuationDb.getTaskById(registered.taskId)?.notification_cancelled_reason, '不要自动回聊天');

    const finishResponse = await fetch(`${baseUrl}/api/tasks/${registered.taskId}/finish`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskToken: registered.taskToken, status: 'completed', exitCode: 0,
        resultDigest: 'client-finish-digest',
        resultSummary: '任务继续完成',
        resultJson: JSON.stringify({ version: 1, taskId: registered.taskId, status: 'completed', exitCode: 0, summary: '任务继续完成' }),
      }),
    });
    assert.equal(finishResponse.status, 200);
    assert.equal(taskContinuationDb.getTaskById(registered.taskId)?.status, 'completed');
    assert.equal(taskContinuationDb.getEventByTaskId(registered.taskId), null);

    const accepted = await handleTaskRegisterRequest({
      userId: 1, sessionId: 'cancel-session', title: '已经发送', autoNotify: true,
    });
    const completed = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
      taskId: accepted.taskId, status: 'completed', exitCode: 0,
      resultDigest: 'accepted-cancel-digest', resultSummary: '已完成',
    });
    const claim = taskContinuationDb.claimPendingEvent({ leaseOwner: 'cancel-http', leaseDurationMs: 10_000 });
    assert.equal(claim?.event_id, completed.eventId);
    taskContinuationDb.updateEventSending({ eventId: completed.eventId!, leaseOwner: 'cancel-http', hostRunId: 'cancel-run' });
    taskContinuationDb.updateEventAccepted({ eventId: completed.eventId!, engineTurnId: 'engine-turn', hostRunId: 'cancel-run' });
    const acceptedCancel = await fetch(`${baseUrl}/api/tasks/${accepted.taskId}/cancel-notification`, {
      method: 'POST', headers: { authorization: `Bearer ${jwtToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '太迟的取消' }),
    });
    assert.equal(acceptedCancel.status, 409);
    assert.equal((await acceptedCancel.json() as { code?: string }).code, 'TASK_NOTIFICATION_ALREADY_SENDING');
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

test('authenticated continuation config endpoint can turn dispatch off and back on', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-config-http-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-routes-http-suite-jwt';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('config-user', 'hashed-password');
  const token = createTestUserToken(1, 'config-user');
  const { taskContinuationsRouter } = await import('@/modules/task-continuations/task-continuations.routes.js');
  const { areTaskContinuationsEnabled } = await import('@/modules/task-continuations/task-continuations.config.js');
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', taskContinuationsRouter);
  app.use((error: { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tasks/config/continuations`;
  try {
    const anonymous = await fetch(baseUrl);
    assert.equal(anonymous.status, 401);
    assert.equal(areTaskContinuationsEnabled(), false);

    const enabled = await fetch(baseUrl, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enabled.status, 200);
    assert.equal(areTaskContinuationsEnabled(), true);

    const disabled = await fetch(baseUrl, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);
    assert.equal(areTaskContinuationsEnabled(), false);

    const invalid = await fetch(baseUrl, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'false' }),
    });
    assert.equal(invalid.status, 400);
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

test('MCP task status is scoped to the capability user and chat without exposing credentials', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-mcp-status-http-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-routes-http-suite-jwt';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('mcp-user', 'hashed-password');
  sessionsDb.createSession('mcp-session', 'codex', temporaryDirectory, 'MCP status session');
  const registered = await handleTaskRegisterRequest({
    userId: 1,
    sessionId: 'mcp-session',
    runId: 'original-run',
    title: 'MCP 权限校验',
  });

  const taskModule = await import('@/modules/task-continuations/index.js');
  const ownerCapability = taskModule.createTaskRunCapability({
    userId: 1,
    sessionId: 'mcp-session',
    runId: 'new-chat-run',
    providerThreadId: 'mcp-session',
    sessionProjectPath: temporaryDirectory,
    cwd: temporaryDirectory,
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    approvalPolicy: 'on-request',
  });
  const otherChatCapability = taskModule.createTaskRunCapability({
    userId: 1,
    sessionId: 'other-session',
    runId: 'other-run',
    providerThreadId: 'other-session',
    sessionProjectPath: temporaryDirectory,
    cwd: temporaryDirectory,
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    approvalPolicy: 'on-request',
  });
  const { taskContinuationsRouter } = await import('@/modules/task-continuations/task-continuations.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', taskContinuationsRouter);
  app.use((error: { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const ownResponse = await fetch(`${baseUrl}/api/tasks/mcp/${registered.taskId}`, {
      headers: { authorization: `Bearer ${ownerCapability.token}` },
    });
    assert.equal(ownResponse.status, 200);
    const ownBody = await ownResponse.json() as { data?: { task?: Record<string, unknown> } };
    assert.equal(ownBody.data?.task?.task_id, registered.taskId);
    assert.equal('token_hash' in (ownBody.data?.task ?? {}), false);
    assert.equal('result_digest' in (ownBody.data?.task ?? {}), false);

    const otherResponse = await fetch(`${baseUrl}/api/tasks/mcp/${registered.taskId}`, {
      headers: { authorization: `Bearer ${otherChatCapability.token}` },
    });
    assert.equal(otherResponse.status, 404);
    assert.equal((await otherResponse.json() as { code?: string }).code, 'TASK_NOT_FOUND');
  } finally {
    taskModule.revokeTaskRunCapability(ownerCapability.token);
    taskModule.revokeTaskRunCapability(otherChatCapability.token);
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

test('task finish rejects wrong field types through the real HTTP callback boundary', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-finish-http-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-routes-http-suite-jwt';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('finish-user', 'hashed-password');
  sessionsDb.createSession('finish-session', 'codex', '/workspace/demo', 'HTTP finish test');

  const registered = await handleTaskRegisterRequest({
    userId: 1,
    sessionId: 'finish-session',
    runId: 'finish-run',
    title: 'HTTP 结果类型校验',
  });
  const { taskContinuationsRouter } = await import('@/modules/task-continuations/task-continuations.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', taskContinuationsRouter);
  app.use((error: { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const invalidFields = [
      { exitCode: 'bad' },
      { resultJson: { status: 'unknown' } },
      { resultSummary: { secret: 'lost' } },
    ];
    for (const invalidField of invalidFields) {
      const response = await fetch(`${baseUrl}/api/tasks/${registered.taskId}/finish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskToken: registered.taskToken,
          status: 'completed',
          resultDigest: 'client-value-is-ignored',
          ...invalidField,
        }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code?: string }).code, 'INVALID_TASK_RESULT');
      assert.equal(taskContinuationDb.getTaskById(registered.taskId)?.status, 'registered');
      assert.equal(taskContinuationDb.getEventByTaskId(registered.taskId), null);
    }
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

test('global API key protects task callbacks while a valid host key can finish a task', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousApiKey = process.env.API_KEY;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-api-key-http-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-routes-http-suite-jwt';
  process.env.API_KEY = 'fake-task-gateway-key';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('api-key-user', 'hashed-password');
  sessionsDb.createSession('api-key-session', 'codex', temporaryDirectory, 'API key test session');
  const registered = await handleTaskRegisterRequest({
    userId: 1,
    sessionId: 'api-key-session',
    runId: 'api-key-run',
    title: 'API key callback',
  });

  const [{ taskContinuationsRouter }, { validateApiKey }] = await Promise.all([
    import('@/modules/task-continuations/task-continuations.routes.js'),
    import('@/modules/auth/index.js'),
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api', validateApiKey);
  app.use('/api/tasks', taskContinuationsRouter);
  app.use((error: { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const callbackBody = {
    taskToken: registered.taskToken,
    status: 'completed',
    exitCode: 0,
    resultJson: JSON.stringify({
      version: 1,
      taskId: registered.taskId,
      status: 'completed',
      exitCode: 0,
      summary: 'API_KEY_CALLBACK_MARKER',
    }),
    resultSummary: 'API_KEY_CALLBACK_MARKER',
    resultDigest: 'client-digest-is-ignored',
  };

  try {
    const missingKey = await fetch(`${baseUrl}/api/tasks/${registered.taskId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(callbackBody),
    });
    assert.equal(missingKey.status, 401);
    assert.deepEqual(await missingKey.json(), { error: 'Invalid API key' });

    const wrongKey = await fetch(`${baseUrl}/api/tasks/${registered.taskId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'wrong-key' },
      body: JSON.stringify(callbackBody),
    });
    assert.equal(wrongKey.status, 401);
    assert.deepEqual(await wrongKey.json(), { error: 'Invalid API key' });
    assert.equal(taskContinuationDb.getTaskById(registered.taskId)?.status, 'registered');

    const validKey = await fetch(`${baseUrl}/api/tasks/${registered.taskId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.API_KEY },
      body: JSON.stringify(callbackBody),
    });
    assert.equal(validKey.status, 200);
    assert.equal(taskContinuationDb.getTaskById(registered.taskId)?.status, 'completed');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('stdio MCP sends the configured global API key through the protected task API', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousApiKey = process.env.API_KEY;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-mcp-api-key-http-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  process.env.JWT_SECRET = 'isolated-task-routes-http-suite-jwt';
  process.env.API_KEY = 'fake-task-gateway-key';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('mcp-api-key-user', 'hashed-password');
  sessionsDb.createSession('mcp-api-key-session', 'codex', temporaryDirectory, 'MCP API key test session');
  const registered = await handleTaskRegisterRequest({
    userId: 1,
    sessionId: 'mcp-api-key-session',
    runId: 'mcp-api-key-run',
    title: 'MCP API key callback',
  });
  const taskModule = await import('@/modules/task-continuations/index.js');
  const capability = taskModule.createTaskRunCapability({
    userId: 1,
    sessionId: 'mcp-api-key-session',
    runId: 'new-mcp-api-key-run',
    providerThreadId: 'mcp-api-key-session',
    sessionProjectPath: temporaryDirectory,
    cwd: temporaryDirectory,
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    approvalPolicy: 'on-request',
  });
  const { taskContinuationsRouter } = await import('@/modules/task-continuations/task-continuations.routes.js');
  const { validateApiKey } = await import('@/modules/auth/index.js');
  const app = express();
  app.use(express.json());
  app.use('/api', validateApiKey);
  app.use('/api/tasks', taskContinuationsRouter);
  app.use((error: { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const baseEnv = {
    CLOUDCLI_TASK_API_URL: apiUrl,
    CLOUDCLI_TASK_RUN_CONTEXT: capability.token,
  };

  try {
    const withoutApiKey = await callMcpTool('cloudcli_task_status', { taskId: registered.taskId }, baseEnv);
    assert.equal(withoutApiKey.result.isError, true);
    assert.match(withoutApiKey.result.content[0].text, /HTTP 401/);

    const withApiKey = await callMcpTool('cloudcli_task_status', { taskId: registered.taskId }, {
      ...baseEnv,
      CLOUDCLI_TASK_API_KEY: process.env.API_KEY,
    });
    assert.equal(withApiKey.result.isError, undefined);
    assert.match(withApiKey.result.content[0].text, new RegExp(registered.taskId));
  } finally {
    taskModule.revokeTaskRunCapability(capability.token);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('stdio MCP registers a real sandbox worker and returns its output through task status', async (t) => {
  if (!await isCodexCommandSandboxAvailable()) {
    t.skip('Codex command sandbox is unavailable on this machine; see the helper for the Windows requirements.');
    return;
  }
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousApiKey = process.env.API_KEY;
  const previousTasksDirectory = process.env.CLOUDCLI_TASKS_DIR;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-mcp-worker-http-'));
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  process.env.CLOUDCLI_TASKS_DIR = path.join(temporaryDirectory, 'tasks');
  process.env.JWT_SECRET = 'isolated-task-routes-http-suite-jwt';
  process.env.API_KEY = 'fake-task-worker-gateway-key';
  closeConnection();
  await initializeDatabase();
  userDb.createUser('mcp-worker-user', 'hashed-password');
  sessionsDb.createSession('mcp-worker-session', 'codex', temporaryDirectory, 'MCP worker test session');
  const taskModule = await import('@/modules/task-continuations/index.js');
  taskModule.setTaskContinuationsEnabled(true);
  const capability = taskModule.createTaskRunCapability({
    userId: 1,
    sessionId: 'mcp-worker-session',
    runId: 'mcp-worker-run',
    providerThreadId: 'mcp-worker-session',
    sessionProjectPath: temporaryDirectory,
    cwd: temporaryDirectory,
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    approvalPolicy: 'on-request',
  });
  const { taskContinuationsRouter } = await import('@/modules/task-continuations/task-continuations.routes.js');
  const { validateApiKey } = await import('@/modules/auth/index.js');
  const app = express();
  app.use(express.json());
  app.use('/api', validateApiKey);
  app.use('/api/tasks', taskContinuationsRouter);
  app.use((error: { statusCode?: number; code?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({ code: error.code ?? 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = {
    CLOUDCLI_TASK_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    CLOUDCLI_TASK_API_KEY: process.env.API_KEY,
    CLOUDCLI_TASK_RUN_CONTEXT: capability.token,
  };

  try {
    taskModule.setTaskContinuationsEnabled(false);
    const disabledMarker = path.join(temporaryDirectory, 'disabled-task-ran');
    const disabledRun = await callMcpTool('cloudcli_task_run', {
      title: '停用后不能登记',
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(disabledMarker)}, 'executed')`],
      notify: false,
    }, env, 10);
    assert.equal(disabledRun.result.isError, true);
    assert.match(disabledRun.result.content[0].text, /HTTP 409 \(TASK_CONTINUATIONS_DISABLED\)/);
    const taskRows = getConnection().prepare('SELECT COUNT(*) AS count FROM async_tasks').get() as { count: number };
    assert.equal(taskRows.count, 0);
    await assert.rejects(fs.access(disabledMarker), { code: 'ENOENT' });
    taskModule.setTaskContinuationsEnabled(true);

    const runCommand = [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(path.join(temporaryDirectory, 'worker-runs'))}, 'x'); console.log("HOSTED_TASK_OUTPUT_MARKER")`,
    ];
    const run = await callMcpTool('cloudcli_task_run', {
      title: '真实 worker 输出',
      command: runCommand[0],
      args: runCommand.slice(1),
      notify: false,
    }, env, 11);
    assert.equal(run.result.isError, undefined, JSON.stringify(run));
    const runPayload = JSON.parse(run.result.content[0].text);
    assert.match(runPayload.taskId, /^task_/);

    const retried = await callMcpTool('cloudcli_task_run', {
      title: '真实 worker 输出',
      command: runCommand[0],
      args: runCommand.slice(1),
      notify: false,
    }, env, 11);
    const retryPayload = JSON.parse(retried.result.content[0].text);
    assert.equal(retryPayload.taskId, runPayload.taskId);
    assert.equal(retryPayload.duplicate, true);
    const conflictingRetry = await callMcpTool('cloudcli_task_run', {
      title: '不同命令不能复用同一请求身份',
      command: process.execPath,
      args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(path.join(temporaryDirectory, 'conflicting-runs'))}, 'x')`],
      notify: false,
    }, env, 11);
    assert.equal(conflictingRetry.result.isError, true);
    assert.match(conflictingRetry.result.content[0].text, /HTTP 409 \(TASK_REGISTRATION_IDENTITY_CONFLICT\)/);

    let status: any;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      status = await callMcpTool('cloudcli_task_status', { taskId: runPayload.taskId }, env, 12 + attempt);
      const payload = JSON.parse(status.result.content[0].text);
      if (payload.task?.status === 'completed' || payload.task?.status === 'failed') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const finalPayload = JSON.parse(status.result.content[0].text);
    assert.equal(finalPayload.task.status, 'completed', JSON.stringify(finalPayload));
    assert.match(finalPayload.task.result_summary, /HOSTED_TASK_OUTPUT_MARKER/);
    assert.equal(finalPayload.task.output_url, `/api/tasks/mcp/${runPayload.taskId}/output`);
    const outputResponse = await fetch(`${env.CLOUDCLI_TASK_API_URL}${finalPayload.task.output_url}`, {
      headers: {
        authorization: `Bearer ${capability.token}`,
        'x-api-key': process.env.API_KEY,
      },
    });
    assert.equal(outputResponse.status, 200, JSON.stringify(await outputResponse.clone().json()));
    const outputPayload = await outputResponse.json() as { data?: { output?: string } };
    assert.match(outputPayload.data?.output ?? '', /HOSTED_TASK_OUTPUT_MARKER/);
    const otherChatCapability = taskModule.createTaskRunCapability({
      userId: 1,
      sessionId: 'another-chat',
      runId: 'another-chat-run',
      providerThreadId: 'another-chat',
      sessionProjectPath: temporaryDirectory,
      cwd: temporaryDirectory,
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      approvalPolicy: 'on-request',
    });
    try {
      const crossChatOutput = await fetch(`${env.CLOUDCLI_TASK_API_URL}${finalPayload.task.output_url}`, {
        headers: {
          authorization: `Bearer ${otherChatCapability.token}`,
          'x-api-key': process.env.API_KEY,
        },
      });
      assert.equal(crossChatOutput.status, 404);
      assert.equal((await crossChatOutput.json() as { code?: string }).code, 'TASK_NOT_FOUND');
    } finally {
      taskModule.revokeTaskRunCapability(otherChatCapability.token);
    }
    assert.equal((await fs.readFile(path.join(temporaryDirectory, 'worker-runs'), 'utf8')), 'x');
    await assert.rejects(fs.stat(path.join(temporaryDirectory, 'conflicting-runs')), { code: 'ENOENT' });
  } finally {
    taskModule.revokeTaskRunCapability(capability.token);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
    if (previousTasksDirectory === undefined) delete process.env.CLOUDCLI_TASKS_DIR;
    else process.env.CLOUDCLI_TASKS_DIR = previousTasksDirectory;
    // The spawned worker and its Codex runner release their temp files a moment
    // after exit on Windows, so the cleanup retries instead of failing EBUSY.
    await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
