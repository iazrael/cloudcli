import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { isCodexCommandSandboxAvailable } from './helpers/codex-sandbox-availability.js';

/**
 * Builds the specifier the generated harnesses use for `import()`. Windows
 * absolute paths are not valid ESM specifiers (`D:\...` parses as a `d:`
 * scheme), while file URLs work on every platform.
 */
const moduleSpecifier = (filePath: string): string => pathToFileURL(filePath).href;

/** Kills a detached worker and everything it spawned on the current platform. */
const killWorkerTree = (pid: number): void => {
  if (process.platform === 'win32') {
    // Windows has no process groups, so SIGKILL on -pid cannot work; taskkill
    // walks the tree instead.
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  process.kill(-pid, 'SIGKILL');
};

test('a detached Codex worker survives host exit and its result is recovered from disk', async (t) => {
  // The worker executes its command through Codex's own sandbox, so the test
  // only runs where that sandbox can start.
  if (!await isCodexCommandSandboxAvailable()) {
    t.skip('Codex command sandbox is unavailable on this machine; see the helper for the Windows requirements.');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-worker-host-crash-'));
  const databasePath = path.join(directory, 'auth.db');
  const tasksRoot = path.join(directory, 'tasks');
  const workspace = path.join(directory, 'workspace');
  await writeFile(databasePath, '');
  await mkdir(workspace);
  const harnessPath = path.join(directory, 'host-harness.mts');
  const databaseModule = moduleSpecifier(path.join(process.cwd(), 'server/modules/database/index.ts'));
  const capabilityModule = moduleSpecifier(path.join(process.cwd(), 'server/modules/task-continuations/services/task-run-context.service.ts'));
  const managerModule = moduleSpecifier(path.join(process.cwd(), 'server/modules/task-continuations/services/task-continuation-worker-manager.service.ts'));
  const harness = `
process.env.DATABASE_PATH = ${JSON.stringify(databasePath)};
process.env.CLOUDCLI_TASKS_DIR = ${JSON.stringify(tasksRoot)};
process.env.JWT_SECRET = 'isolated-host-crash-jwt';
process.env.API_KEY = 'FAKE_HOST_API_KEY';
const db = await import(${JSON.stringify(databaseModule)});
await db.initializeDatabase();
const taskConfig = await import(${JSON.stringify(moduleSpecifier(path.join(process.cwd(), 'server/modules/task-continuations/task-continuations.config.ts')))});
taskConfig.setTaskContinuationsEnabled(true);
db.userDb.createUser('crash-host-user', 'hashed-password');
db.sessionsDb.createSession('crash-host-session', 'codex', ${JSON.stringify(workspace)}, 'Crash host session');
const capabilities = await import(${JSON.stringify(capabilityModule)});
const { token } = capabilities.createTaskRunCapability({
  userId: 1,
  sessionId: 'crash-host-session',
  runId: 'crash-host-run',
  providerThreadId: 'native-crash-thread',
  sessionProjectPath: ${JSON.stringify(workspace)},
  cwd: ${JSON.stringify(workspace)},
  sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
  approvalPolicy: 'on-request',
});


const manager = await import(${JSON.stringify(managerModule)});
const receipt = await manager.registerAndStartTaskFromRun({
  context: {
    userId: 1,
    sessionId: 'crash-host-session',
    runId: 'crash-host-run',
    providerThreadId: 'native-crash-thread',
    sessionProjectPath: ${JSON.stringify(workspace)},
    cwd: ${JSON.stringify(workspace)},
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    approvalPolicy: 'on-request',
  },
  capabilityToken: token,
  requestId: 'host-ack-then-exit',
  title: '宿主退出后继续执行',
  command: [process.execPath, '-e', 'setTimeout(() => { require("node:fs").writeFileSync("HOST_CRASH_MARKER", "ok"); console.log("HOST_CRASH_MARKER") }, 1500)'],
  autoNotify: false,
});
process.stdout.write(JSON.stringify(receipt) + '\\n', () => process.exit(0));
`;
  await writeFile(harnessPath, harness);

  const child = spawn(process.execPath, [
    path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
    '--tsconfig',
    path.join(process.cwd(), 'server/tsconfig.json'),
    harnessPath,
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      DATABASE_PATH: databasePath,
      JWT_SECRET: 'isolated-test-jwt',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });

  try {
    const [exitCode] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    assert.equal(exitCode, 0, stderr);
    const receiptLine = stdout.trim().split('\n').at(-1) ?? '';
    const receipt = JSON.parse(receiptLine) as { taskId: string; status: string };
    assert.match(receipt.taskId, /^task_/);
    assert.equal(receipt.status, 'accepted');

    const resultPath = path.join(tasksRoot, receipt.taskId, 'result.json');
    let resultJson = '';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        resultJson = await readFile(resultPath, 'utf8');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const result = JSON.parse(resultJson) as { status: string; summary: string };
    assert.equal(result.status, 'completed', resultJson);
    assert.match(result.summary, /HOST_CRASH_MARKER/);

    process.env.DATABASE_PATH = databasePath;
    process.env.CLOUDCLI_TASKS_DIR = tasksRoot;
    process.env.JWT_SECRET = 'isolated-host-crash-jwt';
    const database = await import('@/modules/database/index.js');
    database.closeConnection();
    await database.initializeDatabase();
    const { scanAndRecoverTaskResultsFromDisk } = await import('@/modules/task-continuations/index.js');
    assert.equal(await scanAndRecoverTaskResultsFromDisk(tasksRoot), 1);
    assert.equal(database.taskContinuationDb.getTaskById(receipt.taskId)?.status, 'completed');
    assert.match(database.taskContinuationDb.getTaskById(receipt.taskId)?.result_summary ?? '', /HOST_CRASH_MARKER/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    const database = await import('@/modules/database/index.js');
    database.closeConnection();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a new process recovers each persisted continuation crash checkpoint without blind resend', async (t) => {
  const checkpoints = [
    'result-before-callback',
    'committed-before-wakeup',
    'claimed-before-send',
    'sending-before-engine-call',
    'accepted-before-reply',
    'reply-finished-before-delivery',
    'history-unavailable',
    'partial-result',
  ] as const;

  for (const checkpoint of checkpoints) {
    await t.test(checkpoint, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'task-checkpoint-crash-'));
      const databasePath = path.join(directory, 'auth.db');
      const tasksRoot = path.join(directory, 'tasks');
      const workspace = path.join(directory, 'workspace');
      const harnessPath = path.join(directory, 'checkpoint-harness.mts');
      await writeFile(databasePath, '');
      await mkdir(workspace);
      const databaseModule = moduleSpecifier(path.join(process.cwd(), 'server/modules/database/index.ts'));
      const taskId = `task_${checkpoint}`;
      const harness = `
process.env.DATABASE_PATH = ${JSON.stringify(databasePath)};
process.env.CLOUDCLI_TASKS_DIR = ${JSON.stringify(tasksRoot)};
process.env.JWT_SECRET = 'isolated-checkpoint-jwt';
const db = await import(${JSON.stringify(databaseModule)});
await db.initializeDatabase();
db.userDb.createUser('checkpoint-user', 'hashed-password');
db.sessionsDb.createSession('checkpoint-session', 'codex', ${JSON.stringify(workspace)}, 'Checkpoint session');
db.taskContinuationDb.registerAsyncTask({ taskId: ${JSON.stringify(taskId)}, userId: 1, sessionId: 'checkpoint-session', title: 'Crash checkpoint', autoNotify: true, tokenHash: 'fake-hash' });
let eventId = null;
if (${JSON.stringify(checkpoint)} === 'result-before-callback') {
  const folder = ${JSON.stringify(tasksRoot)} + '/' + ${JSON.stringify(taskId)};
  await (await import('node:fs/promises')).mkdir(folder, { recursive: true });
  await (await import('node:fs/promises')).writeFile(folder + '/result.json', JSON.stringify({ version: 1, taskId: ${JSON.stringify(taskId)}, status: 'completed', exitCode: 0, summary: 'crash result' }));
} else if (${JSON.stringify(checkpoint)} === 'partial-result') {
  const folder = ${JSON.stringify(tasksRoot)} + '/' + ${JSON.stringify(taskId)};
  await (await import('node:fs/promises')).mkdir(folder, { recursive: true });
  await (await import('node:fs/promises')).writeFile(folder + '/result.json', '{"version":');
} else {
  const completion = db.taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({ taskId: ${JSON.stringify(taskId)}, status: 'completed', exitCode: 0, resultDigest: 'checkpoint-digest', resultSummary: 'checkpoint result' });
  eventId = completion.eventId;
  if (${JSON.stringify(checkpoint)} === 'claimed-before-send') db.taskContinuationDb.claimEventById({ eventId, leaseOwner: 'crashed-host', leaseDurationMs: 1 });
  if (['sending-before-engine-call', 'accepted-before-reply', 'reply-finished-before-delivery', 'history-unavailable'].includes(${JSON.stringify(checkpoint)})) {
    db.taskContinuationDb.claimEventById({ eventId, leaseOwner: 'crashed-host', leaseDurationMs: 30000 });
    db.taskContinuationDb.updateEventSending({ eventId, leaseOwner: 'crashed-host', hostRunId: 'crashed-run' });
  }
  if (['accepted-before-reply', 'reply-finished-before-delivery', 'history-unavailable'].includes(${JSON.stringify(checkpoint)})) {
    db.taskContinuationDb.updateEventAccepted({ eventId, engineTurnId: 'turn-checkpoint', hostRunId: 'crashed-run' });
  }
}
process.stdout.write(JSON.stringify({ eventId }) + '\\n');
process.exit(73);
`;
      await writeFile(harnessPath, harness);

      const child = spawn(process.execPath, [
        path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
        '--tsconfig', path.join(process.cwd(), 'server/tsconfig.json'), harnessPath,
      ], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CODEX_HOME: process.env.CODEX_HOME,
          TMPDIR: process.env.TMPDIR,
          DATABASE_PATH: databasePath,
          JWT_SECRET: 'isolated-checkpoint-jwt',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });

      try {
        const [exitCode] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
        assert.equal(exitCode, 73, stderr);
        const database = await import('@/modules/database/index.js');
        database.closeConnection();
        process.env.DATABASE_PATH = databasePath;
        process.env.CLOUDCLI_TASKS_DIR = tasksRoot;
        process.env.JWT_SECRET = 'isolated-checkpoint-jwt';
        await database.initializeDatabase();
        const task = database.taskContinuationDb.getTaskById(taskId);
        assert.ok(task, `task missing after ${checkpoint}`);

        if (checkpoint === 'result-before-callback') {
          const { scanAndRecoverTaskResultsFromDisk } = await import('@/modules/task-continuations/services/task-continuation-recovery.service.js');
          assert.equal(await scanAndRecoverTaskResultsFromDisk(tasksRoot), 1);
          assert.equal(database.taskContinuationDb.getTaskById(taskId)?.status, 'completed');
          assert.equal(database.taskContinuationDb.getEventByTaskId(taskId)?.status, 'pending');
        } else if (checkpoint === 'partial-result') {
          const { scanAndRecoverTaskResultsFromDisk } = await import('@/modules/task-continuations/services/task-continuation-recovery.service.js');
          assert.equal(await scanAndRecoverTaskResultsFromDisk(tasksRoot), 0);
          assert.equal(database.taskContinuationDb.getTaskById(taskId)?.status, 'registered');
          assert.match(database.taskContinuationDb.getTaskById(taskId)?.last_error ?? '', /JSON|parse/i);
          assert.equal(database.taskContinuationDb.getEventByTaskId(taskId), null);
        } else {
          const event = database.taskContinuationDb.getEventByTaskId(taskId);
          assert.ok(event);
          if (checkpoint === 'committed-before-wakeup') {
            assert.equal(event.status, 'pending');
            assert.ok(database.taskContinuationDb.claimPendingEvent({ leaseOwner: 'recovered-host', leaseDurationMs: 30_000 }));
          } else if (checkpoint === 'claimed-before-send') {
            await new Promise((resolve) => setTimeout(resolve, 10));
            assert.ok(database.taskContinuationDb.claimPendingEvent({ leaseOwner: 'recovered-host', leaseDurationMs: 30_000 }));
          } else if (checkpoint === 'sending-before-engine-call') {
            const { reconcileIncompleteContinuationEvents } = await import('@/modules/task-continuations/services/task-continuation-recovery.service.js');
            await reconcileIncompleteContinuationEvents({ historyChecker: async () => ({ found: false }) });
            assert.equal(database.taskContinuationDb.getEventById(event.event_id)?.status, 'needs_review');
          } else if (checkpoint === 'accepted-before-reply') {
            const { reconcileIncompleteContinuationEvents } = await import('@/modules/task-continuations/services/task-continuation-recovery.service.js');
            await reconcileIncompleteContinuationEvents({ historyChecker: async () => ({ found: true, engineTurnId: 'turn-checkpoint', status: 'inProgress' }) });
            assert.equal(database.taskContinuationDb.getEventById(event.event_id)?.status, 'accepted');
          } else if (checkpoint === 'reply-finished-before-delivery') {
            const { reconcileIncompleteContinuationEvents } = await import('@/modules/task-continuations/services/task-continuation-recovery.service.js');
            await reconcileIncompleteContinuationEvents({ historyChecker: async () => ({ found: true, engineTurnId: 'turn-checkpoint', status: 'completed' }) });
            assert.equal(database.taskContinuationDb.getEventById(event.event_id)?.status, 'delivered');
          } else if (checkpoint === 'history-unavailable') {
            const { reconcileIncompleteContinuationEvents } = await import('@/modules/task-continuations/services/task-continuation-recovery.service.js');
            await reconcileIncompleteContinuationEvents({ historyChecker: async () => { throw new Error('isolated history unavailable'); } });
            assert.equal(database.taskContinuationDb.getEventById(event.event_id)?.status, 'needs_review');
            assert.match(database.taskContinuationDb.getEventById(event.event_id)?.last_error ?? '', /isolated history unavailable/);
          }
        }
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        const database = await import('@/modules/database/index.js');
        database.closeConnection();
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });
  }
});

test('dispatcher acceptance crash checkpoints use one persisted fake-engine turn and never create a second', async (t) => {
  for (const checkpoint of ['engine-accepted-before-receipt', 'reply-completed-before-delivery-receipt'] as const) {
    await t.test(checkpoint, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'task-dispatcher-crash-'));
      const databasePath = path.join(directory, 'auth.db');
      const workspace = path.join(directory, 'workspace');
      const historyPath = path.join(directory, 'fake-engine-history.json');
      const harnessPath = path.join(directory, 'dispatcher-host.mts');
      await writeFile(databasePath, '');
      await mkdir(workspace);
      const databaseModule = moduleSpecifier(path.join(process.cwd(), 'server/modules/database/index.ts'));
      const dispatcherModule = moduleSpecifier(path.join(process.cwd(), 'server/modules/task-continuations/services/task-continuation-dispatcher.service.ts'));
      const taskId = `task_dispatcher_${checkpoint}`;
      const harness = `
process.env.DATABASE_PATH = ${JSON.stringify(databasePath)};
process.env.JWT_SECRET = 'isolated-dispatcher-crash-jwt';
const db = await import(${JSON.stringify(databaseModule)});
await db.initializeDatabase();
db.userDb.createUser('dispatcher-crash-user', 'hashed-password');
db.sessionsDb.createSession('dispatcher-crash-session', 'codex', ${JSON.stringify(workspace)}, 'Dispatcher crash session');
db.sessionsDb.assignProviderSessionId('dispatcher-crash-session', 'native-dispatcher-thread');
db.taskContinuationDb.registerAsyncTask({ taskId: ${JSON.stringify(taskId)}, userId: 1, sessionId: 'dispatcher-crash-session', providerThreadId: 'native-dispatcher-thread', sessionProjectPath: ${JSON.stringify(workspace)}, workingDirectory: ${JSON.stringify(workspace)}, sandboxPolicyType: 'workspaceWrite', networkAccess: false, approvalPolicy: 'on-request', title: 'dispatcher crash', autoNotify: true, tokenHash: 'fake-hash' });
const completion = db.taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({ taskId: ${JSON.stringify(taskId)}, status: 'completed', exitCode: 0, resultDigest: 'dispatcher-crash-digest', resultSummary: 'task output' });
const dispatcher = await import(${JSON.stringify(dispatcherModule)});
await dispatcher.dispatchTaskContinuationEvent({ eventId: completion.eventId, leaseOwner: 'dispatcher-crash-host', runner: async (params) => {
  const history = { turns: [{ id: 'fake-engine-turn-1', eventId: params.eventId, taskId: params.taskId, attemptId: params.attemptId, status: 'completed' }] };
  if (${JSON.stringify(checkpoint)} === 'reply-completed-before-delivery-receipt') params.onEngineTurnStarted('fake-engine-turn-1');
  await (await import('node:fs/promises')).writeFile(${JSON.stringify(historyPath)}, JSON.stringify(history));
  process.exit(74);
} });
process.exit(75);
`;
      await writeFile(harnessPath, harness);
      const child = spawn(process.execPath, [
        path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
        '--tsconfig', path.join(process.cwd(), 'server/tsconfig.json'), harnessPath,
      ], {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME,
          TMPDIR: process.env.TMPDIR, DATABASE_PATH: databasePath, JWT_SECRET: 'isolated-dispatcher-crash-jwt',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
      try {
        const [exitCode] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
        assert.equal(exitCode, 74, stderr);
        const database = await import('@/modules/database/index.js');
        database.closeConnection();
        process.env.DATABASE_PATH = databasePath;
        await database.initializeDatabase();
        const event = database.taskContinuationDb.getEventByTaskId(taskId);
        assert.ok(event);
        assert.equal(event.status, checkpoint === 'engine-accepted-before-receipt' ? 'sending' : 'accepted');
        const persistedHistory = JSON.parse(await readFile(historyPath, 'utf8')) as {
          turns: Array<{ id: string; eventId: string; taskId: string; attemptId: string; status: string }>;
        };
        const turnsForEvent = persistedHistory.turns.filter((turn) => turn.eventId === event.event_id && turn.taskId === taskId);
        assert.equal(turnsForEvent.length, 1);
        assert.equal(turnsForEvent[0].status, 'completed');

        const { reconcileIncompleteContinuationEvents } = await import('@/modules/task-continuations/services/task-continuation-recovery.service.js');
        await reconcileIncompleteContinuationEvents({ historyChecker: async (eventId) => {
          const matches = persistedHistory.turns.filter((turn) => turn.eventId === eventId && turn.taskId === taskId);
          return matches.length === 1
            ? { found: true, engineTurnId: matches[0].id, status: matches[0].status as 'completed' }
            : { found: false };
        } });
        assert.equal(database.taskContinuationDb.getEventById(event.event_id)?.status, 'delivered');
        assert.equal(database.taskContinuationDb.claimPendingEvent({ leaseOwner: 'recovered-host', leaseDurationMs: 10_000 }), null);
        assert.equal(persistedHistory.turns.length, 1);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        const database = await import('@/modules/database/index.js');
        database.closeConnection();
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    });
  }
});

test('a ready worker killed before its result leaves the task explicitly unknown', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-worker-exit-unknown-'));
  const databasePath = path.join(directory, 'auth.db');
  const tasksRoot = path.join(directory, 'tasks');
  const workspace = path.join(directory, 'workspace');
  const harnessPath = path.join(directory, 'worker-exit-host.mts');
  await writeFile(databasePath, '');
  await mkdir(workspace);
  const databaseModule = moduleSpecifier(path.join(process.cwd(), 'server/modules/database/index.ts'));
  const capabilityModule = moduleSpecifier(path.join(process.cwd(), 'server/modules/task-continuations/services/task-run-context.service.ts'));
  const managerModule = moduleSpecifier(path.join(process.cwd(), 'server/modules/task-continuations/services/task-continuation-worker-manager.service.ts'));
  const harness = `
process.env.DATABASE_PATH = ${JSON.stringify(databasePath)};
process.env.CLOUDCLI_TASKS_DIR = ${JSON.stringify(tasksRoot)};
process.env.JWT_SECRET = 'isolated-worker-exit-jwt';
const db = await import(${JSON.stringify(databaseModule)});
await db.initializeDatabase();
const taskConfig = await import(${JSON.stringify(moduleSpecifier(path.join(process.cwd(), 'server/modules/task-continuations/task-continuations.config.ts')))});
taskConfig.setTaskContinuationsEnabled(true);
db.userDb.createUser('worker-exit-user', 'hashed-password');
db.sessionsDb.createSession('worker-exit-session', 'codex', ${JSON.stringify(workspace)}, 'Worker exit session');
const capability = await import(${JSON.stringify(capabilityModule)});
const { token } = capability.createTaskRunCapability({ userId: 1, sessionId: 'worker-exit-session', runId: 'worker-exit-run', providerThreadId: 'worker-exit-thread', sessionProjectPath: ${JSON.stringify(workspace)}, cwd: ${JSON.stringify(workspace)}, sandboxPolicy: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'on-request' });
const childProcess = (await import('node:child_process')).default;
const { syncBuiltinESMExports } = await import('node:module');
const originalSpawn = childProcess.spawn;
let workerPid = null;
childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn(...args);
  workerPid = child.pid;
  return child;
}) as typeof childProcess.spawn;
syncBuiltinESMExports();
const manager = await import(${JSON.stringify(managerModule)});
const receipt = await manager.registerAndStartTaskFromRun({ context: { userId: 1, sessionId: 'worker-exit-session', runId: 'worker-exit-run', providerThreadId: 'worker-exit-thread', sessionProjectPath: ${JSON.stringify(workspace)}, cwd: ${JSON.stringify(workspace)}, sandboxPolicy: { type: 'workspaceWrite', networkAccess: false }, approvalPolicy: 'on-request' }, capabilityToken: token, requestId: 'ready-worker-will-exit', title: 'worker exit', command: [process.execPath, '-e', 'setTimeout(() => console.log("SHOULD_NOT_COMPLETE"), 30000)'], autoNotify: false });
process.stdout.write('RECEIPT ' + JSON.stringify({ ...receipt, workerPid }) + '\\n');
for (let attempt = 0; attempt < 200; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  const task = db.taskContinuationDb.getTaskById(receipt.taskId);
  if (task?.last_error) {
    process.stdout.write('TASK ' + JSON.stringify({ status: task.status, lastError: task.last_error }) + '\\n');
    process.exit(0);
  }
}
process.stdout.write('TASK ' + JSON.stringify({ status: db.taskContinuationDb.getTaskById(receipt.taskId)?.status, lastError: null }) + '\\n');
process.exit(0);
`;
  await writeFile(harnessPath, harness);
  const host = spawn(process.execPath, [
    path.join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
    '--tsconfig', path.join(process.cwd(), 'server/tsconfig.json'), harnessPath,
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      TMPDIR: process.env.TMPDIR,
      DATABASE_PATH: databasePath,
      JWT_SECRET: 'isolated-worker-exit-jwt',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  host.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  host.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });

  try {
    const receipt = await new Promise<{ taskId: string; workerPid: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker did not become ready. ${stderr}`)), 30_000);
      host.once('exit', (code) => {
        if (!stdout.includes('RECEIPT ')) {
          clearTimeout(timer);
          reject(new Error(`Worker host exited before registering a worker (code ${code}). ${stderr}`));
        }
      });
      host.stdout.on('data', () => {
        const line = stdout.split('\n').find((value) => value.startsWith('RECEIPT '));
        if (!line) return;
        clearTimeout(timer);
        resolve(JSON.parse(line.slice('RECEIPT '.length)) as { taskId: string; workerPid: number });
      });
    });
    assert.match(receipt.taskId, /^task_/);

    assert.ok(Number.isInteger(receipt.workerPid) && receipt.workerPid > 0, 'the isolated host did not record the worker PID it spawned');
    killWorkerTree(receipt.workerPid);

    const [exitCode] = await once(host, 'exit') as [number | null, NodeJS.Signals | null];
    assert.equal(exitCode, 0, stderr);
    const taskLine = stdout.split('\n').find((value) => value.startsWith('TASK '));
    assert.ok(taskLine, stdout);
    const task = JSON.parse(taskLine.slice('TASK '.length)) as { status: string; lastError: string | null };
    assert.equal(task.status, 'running');
    assert.match(task.lastError ?? '', /worker exited after startup|outcome is unknown/i);
    assert.equal(await import('node:fs/promises').then(({ access }) => access(path.join(tasksRoot, receipt.taskId, 'result.json')).then(() => true).catch(() => false)), false);
  } finally {
    if (host.exitCode === null) host.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
