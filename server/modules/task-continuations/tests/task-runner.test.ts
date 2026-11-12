import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import {
  parseTaskRunnerArgs,
} from '@/modules/task-continuations/cli/task-runner.js';

import { createTestUserToken } from './helpers/user-token.js';

// The CLI is spawned as a real process; resolving tsx through Node itself keeps
// the invocation working on Windows, where the POSIX `node_modules/.bin/tsx`
// shim cannot be executed directly.
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve('tsx/cli');

test('parseTaskRunnerArgs parses run command with flags and trailing command', () => {
  const argv = [
    'run',
    '--title',
    '测试复核任务',
    '--notify',
    '--',
    'echo',
    'hello',
    'world',
  ];

  const parsed = parseTaskRunnerArgs(argv);
  assert.equal(parsed.command, 'run');
  assert.equal(parsed.title, '测试复核任务');
  assert.equal(parsed.autoNotify, true);
  assert.deepEqual(parsed.taskCommand, ['echo', 'hello', 'world']);
});

test('parseTaskRunnerArgs parses status and cancel-notification commands', () => {
  const statusArgs = ['status', '--task', 'task_12345'];
  const statusParsed = parseTaskRunnerArgs(statusArgs);
  assert.equal(statusParsed.command, 'status');
  assert.equal(statusParsed.taskId, 'task_12345');

  const cancelArgs = ['cancel-notification', '--task', 'task_67890'];
  const cancelParsed = parseTaskRunnerArgs(cancelArgs);
  assert.equal(cancelParsed.command, 'cancel-notification');
  assert.equal(cancelParsed.taskId, 'task_67890');
});

test('parseTaskRunnerArgs requires the explicit duplicate-risk flag and reason for manual retry', () => {
  const parsed = parseTaskRunnerArgs([
    'retry-notification', '--task', 'task_98765', '--confirm-may-duplicate', '--reason', '已核对历史并接受重复汇报风险',
  ]);
  assert.equal(parsed.command, 'retry-notification');
  assert.equal(parsed.taskId, 'task_98765');
  assert.equal(parsed.confirmMayDuplicate, true);
  assert.equal(parsed.reason, '已核对历史并接受重复汇报风险');
});

test('parseTaskRunnerArgs reads the centralized continuation switch', () => {
  assert.deepEqual(parseTaskRunnerArgs(['continuation-config']), { command: 'continuation-config', invalidEnabled: false });
  assert.deepEqual(parseTaskRunnerArgs(['continuation-config', '--enabled', 'false']), {
    command: 'continuation-config', enabled: false, invalidEnabled: false,
  });
  assert.equal(parseTaskRunnerArgs(['continuation-config', '--enabled', 'off']).invalidEnabled, true);
});

test('runMainTaskRunner sends confirmed manual retry with the user JWT', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; init: any }[] = [];
  try {
    globalThis.fetch = (async (url: any, init: any) => {
      requests.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ success: true }) } as any;
    }) as any;
    const { runMainTaskRunner } = await import('@/modules/task-continuations/cli/task-runner.js');
    const exitCode = await runMainTaskRunner([
      'retry-notification', '--task', 'task_cli_retry', '--confirm-may-duplicate', '--reason', '已人工核对历史',
    ], { CLOUDCLI_API_URL: 'http://localhost:3030', CLOUDCLI_USER_TOKEN: 'user-jwt-marker' });
    assert.equal(exitCode, 0);
    assert.equal(requests[0]?.url, 'http://localhost:3030/api/tasks/task_cli_retry/retry-notification');
    assert.equal(requests[0]?.init.headers.authorization, 'Bearer user-jwt-marker');
    assert.deepEqual(JSON.parse(requests[0]?.init.body), {
      confirmMayDuplicate: true, reason: '已人工核对历史',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('real task-runner process retries through the authenticated HTTP route', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousApiKey = process.env.API_KEY;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'task-runner-real-http-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');
  process.env.DATABASE_PATH = databasePath;
  process.env.JWT_SECRET = 'isolated-real-cli-http-jwt';
  process.env.API_KEY = 'isolated-real-cli-api-key';
  await writeFile(databasePath, '');

  const database = await import('@/modules/database/index.js');
  database.closeConnection();
  await database.initializeDatabase();
  database.userDb.createUser('real-cli-owner', 'hashed-password');
  database.sessionsDb.createSession('real-cli-session', 'codex', temporaryDirectory, 'Real CLI session');
  const registered = await (await import('@/modules/task-continuations/task-continuations.service.js')).handleTaskRegisterRequest({
    userId: 1, sessionId: 'real-cli-session', title: '真实 CLI 处置', autoNotify: true,
  });
  const completion = database.taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
    taskId: registered.taskId, status: 'completed', exitCode: 0,
    resultDigest: 'real-cli-needs-review', resultSummary: '需人工核对',
  });
  database.taskContinuationDb.updateEventFailed({
    eventId: completion.eventId!, error: 'history unavailable', terminalStatus: 'needs_review', expectedStatus: 'pending',
  });
  const token = createTestUserToken(1, 'real-cli-owner');
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
  try {
    const child = spawn(process.execPath, [
      tsxCliPath, '--tsconfig', 'server/tsconfig.json', 'server/modules/task-continuations/cli/task-runner.ts',
      'retry-notification', '--task', registered.taskId, '--confirm-may-duplicate', '--reason', '已真实检查过任务输出',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLOUDCLI_API_URL: apiUrl,
        CLOUDCLI_USER_TOKEN: token,
        CLOUDCLI_API_KEY: process.env.API_KEY,
        DATABASE_PATH: databasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const [exitCode, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    assert.equal(signal, null, stderr);
    assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
    assert.equal(database.taskContinuationDb.getEventById(completion.eventId!)?.status, 'pending');
    const audit = database.getConnection().prepare(
      'SELECT user_id, reason FROM task_continuation_manual_actions WHERE event_id = ?',
    ).get(completion.eventId!) as { user_id: number; reason: string };
    assert.deepEqual(audit, { user_id: 1, reason: '已真实检查过任务输出' });

    const runCli = async (args: string[]) => {
      const configChild = spawn(process.execPath, [
        tsxCliPath,
        '--tsconfig', 'server/tsconfig.json', 'server/modules/task-continuations/cli/task-runner.ts',
        ...args,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLOUDCLI_API_URL: apiUrl,
          CLOUDCLI_USER_TOKEN: token,
          CLOUDCLI_API_KEY: process.env.API_KEY,
          DATABASE_PATH: databasePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let cliOutput = '';
      let cliError = '';
      configChild.stdout.setEncoding('utf8').on('data', (chunk) => { cliOutput += chunk; });
      configChild.stderr.setEncoding('utf8').on('data', (chunk) => { cliError += chunk; });
      const [code, childSignal] = await once(configChild, 'close') as [number | null, NodeJS.Signals | null];
      assert.equal(childSignal, null, cliError);
      assert.equal(code, 0, `${cliOutput}\n${cliError}`);
      return cliOutput;
    };
    await runCli(['continuation-config', '--enabled', 'true']);
    assert.equal(database.appConfigDb.get('async_task_continuations_enabled'), 'true');
    assert.match(await runCli(['continuation-config']), /"enabled": true/);
    await runCli(['continuation-config', '--enabled', 'false']);
    assert.equal(database.appConfigDb.get('async_task_continuations_enabled'), 'false');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('runMainTaskRunner never executes legacy external commands with or without notification credentials', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'task-runner-main-'));
  const markerPath = path.join(tempDir, 'must-not-exist');

  try {
    const { runMainTaskRunner } = await import('@/modules/task-continuations/cli/task-runner.js');
    const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`];
    const cases: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [
      { args: ['run', '--title', '缺凭证任务', '--notify', '--', ...command], env: {} },
      { args: ['run', '--title', '关闭通知任务', '--', ...command], env: { CLOUDCLI_USER_TOKEN: 'jwt-marker' } },
      {
        args: ['run', '--title', '旧注册凭证任务', '--notify', '--', ...command],
        env: { CLOUDCLI_REGISTRATION_TOKEN: 'registration-marker', CLOUDCLI_USER_TOKEN: 'jwt-marker' },
      },
    ];
    for (const scenario of cases) {
      assert.equal(await runMainTaskRunner(scenario.args, scenario.env), 1);
      await assert.rejects(stat(markerPath), { code: 'ENOENT' });
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
