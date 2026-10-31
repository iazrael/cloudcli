import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { taskContinuationDb } from '@/modules/database/index.js';
import {
  handleGetTaskStatus,
  handleTaskFinishRequest,
  handleTaskRegisterRequest,
} from '@/modules/task-continuations/task-continuations.service.js';
import { notifyTaskActivity, suppressReportOfStoppedTask } from '@/modules/task-continuations/services/task-host-cards.service.js';
import { readAndNormalizeTaskResultFromDisk } from '@/modules/task-continuations/services/task-result.service.js';
import { getTaskContinuationTasksRoot } from '@/modules/task-continuations/services/task-storage.service.js';
import { areTaskContinuationsEnabled } from '@/modules/task-continuations/task-continuations.config.js';
import { findApplicationRoot } from '@/shared/index.js';
import type { TaskAccessScope, TaskRunCapabilityContext } from '@/shared/types.js';
import { AppError, sha256Hex } from '@/shared/utils.js';

const STARTUP_TIMEOUT_MS = 30_000;
const WORKER_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'USER', 'LOGNAME', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
] as const;

type WorkerMessage = { type?: unknown; taskId?: unknown; resultPath?: unknown };
type TaskRunReceiptStatus = 'accepted' | 'uncertain' | 'completed' | 'failed' | 'cancelled';

function toRunReceiptStatus(status: string | undefined): TaskRunReceiptStatus {
  if (status === 'registered' || status === undefined) return 'uncertain';
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  return 'accepted';
}

/** Resolves the worker entrypoint from the running module kind, not artifact presence. */
export function resolveTaskWorkerCommand(moduleFilePath: string, appRoot: string): { command: string; args: string[] } {
  const compiledEntrypoint = path.join(appRoot, 'dist-server', 'server', 'modules', 'task-continuations', 'cli', 'task-continuation-worker.js');
  if (path.extname(moduleFilePath) === '.js') {
    if (!existsSync(compiledEntrypoint)) {
      throw new AppError(`Compiled task worker is missing: ${compiledEntrypoint}`, {
        code: 'TASK_WORKER_ENTRYPOINT_MISSING',
        statusCode: 500,
      });
    }
    return { command: process.execPath, args: [compiledEntrypoint] };
  }
  if (path.extname(moduleFilePath) !== '.ts') {
    throw new AppError('Unsupported task worker host module extension.', {
      code: 'TASK_WORKER_ENTRYPOINT_INVALID',
      statusCode: 500,
    });
  }
  const sourceEntrypoint = path.join(appRoot, 'server', 'modules', 'task-continuations', 'cli', 'task-continuation-worker.ts');
  return {
    command: process.execPath,
    args: [
      path.join(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      '--tsconfig',
      path.join(appRoot, 'server', 'tsconfig.json'),
      sourceEntrypoint,
    ],
  };
}

function workerCommand(): { command: string; args: string[] } {
  const moduleFilePath = fileURLToPath(import.meta.url);
  const appRoot = findApplicationRoot(path.dirname(moduleFilePath));
  return resolveTaskWorkerCommand(moduleFilePath, appRoot);
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of WORKER_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function buildRegistrationKey(context: TaskRunCapabilityContext, token: string, requestId: string): string {
  return sha256Hex(`${token}\0${context.runId}\0${requestId}`);
}

async function finishResultFile(taskId: string, taskToken: string, taskDirectory: string, resultPath: string): Promise<void> {
  const expectedPath = path.join(taskDirectory, 'result.json');
  if (path.resolve(resultPath) !== expectedPath) {
    throw new AppError('Task worker returned an unexpected result path.', {
      code: 'TASK_WORKER_RESULT_PATH_INVALID',
      statusCode: 500,
    });
  }
  const result = await readAndNormalizeTaskResultFromDisk({
    taskId,
    tasksRootDir: path.dirname(taskDirectory),
    resultFilePath: expectedPath,
  });
  suppressReportOfStoppedTask(taskId, result.status);
  await handleTaskFinishRequest({
    taskId,
    taskToken,
    status: result.status,
    exitCode: result.exitCode,
    resultSummary: result.resultSummary,
    resultJson: result.resultJson,
    resultPath: expectedPath,
    resultDigest: result.resultDigest,
  });
}

/**
 * Registers and starts one task from an active trusted Codex run. The request identity makes MCP retries return the same task instead of executing its command twice.
 */
/**
 * Registers an asynchronous task for a trusted run.
 *
 * A run reaches the host through two entries: the per-round capability and
 * the narrow bridge a resident process carries. Both go through this one
 * function, so the validation and the registration cannot drift apart.
 */
export async function handleTaskRegisterForRun(input: {
  context: TaskRunCapabilityContext;
  capabilityToken: string;
  requestId: string;
  title: string;
  command: string[];
  autoNotify: boolean;
}): Promise<{ taskId: string; title: string; status: TaskRunReceiptStatus; duplicate: boolean }> {
  if (!input.title || input.title.length > 200) {
    throw new AppError('Task title is invalid.', { code: 'INVALID_TASK_REGISTRATION', statusCode: 400 });
  }
  if (!input.requestId || input.requestId.length > 256) {
    throw new AppError('Task registration requires a request id.', {
      code: 'INVALID_TASK_REGISTRATION',
      statusCode: 400,
    });
  }
  if (input.command.length < 1 || input.command.length > 129
    || input.command.some((argument) => typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0'))
    || typeof input.command[0] !== 'string' || !input.command[0].trim()) {
    throw new AppError('Task command is invalid.', { code: 'INVALID_TASK_REGISTRATION', statusCode: 400 });
  }
  return registerAndStartTaskFromRun(input);
}

export async function registerAndStartTaskFromRun(input: {
  context: TaskRunCapabilityContext;
  capabilityToken: string;
  requestId: string;
  title: string;
  command: string[];
  autoNotify: boolean;
}): Promise<{ taskId: string; title: string; status: TaskRunReceiptStatus; duplicate: boolean }> {
  if (!areTaskContinuationsEnabled()) {
    throw new AppError('Asynchronous task registration is disabled by the CloudCLI continuation setting.', {
      code: 'TASK_CONTINUATIONS_DISABLED',
      statusCode: 409,
    });
  }
  if (!input.context.providerThreadId) {
    throw new AppError('Codex has not bound this run to a native conversation yet.', {
      code: 'TASK_NATIVE_THREAD_NOT_READY',
      statusCode: 409,
    });
  }
  const registrationKey = buildRegistrationKey(input.context, input.capabilityToken, input.requestId);
  const task = await handleTaskRegisterRequest({
    userId: input.context.userId,
    sessionId: input.context.sessionId,
    runId: input.context.runId,
    providerThreadId: input.context.providerThreadId,
    sessionProjectPath: input.context.sessionProjectPath,
    workingDirectory: input.context.cwd,
    sandboxPolicyType: input.context.sandboxPolicy.type,
    networkAccess: input.context.sandboxPolicy.networkAccess,
    approvalPolicy: input.context.approvalPolicy,
    title: input.title,
    command: JSON.stringify(input.command),
    autoNotify: input.autoNotify,
    registrationKey,
  });
  if (!task.created) {
    const existing = taskContinuationDb.getTaskById(task.taskId);
    return {
      taskId: task.taskId,
      title: task.title,
      status: toRunReceiptStatus(existing?.status),
      duplicate: true,
    };
  }

  const taskRoot = getTaskContinuationTasksRoot();
  const taskDirectory = path.join(taskRoot, task.taskId);
  let child: ReturnType<typeof spawn>;
  try {
    await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
    const worker = workerCommand();
    child = spawn(worker.command, worker.args, {
      cwd: input.context.cwd,
      env: workerEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    taskContinuationDb.updateTaskRecoveryError({ taskId: task.taskId, error: `Worker start failed: ${reason}`.slice(0, 4000) });
    return { taskId: task.taskId, title: task.title, status: 'uncertain', duplicate: false };
  }
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    taskContinuationDb.updateTaskRecoveryError({ taskId: task.taskId, error: 'Worker pipes could not be created.' });
    return { taskId: task.taskId, title: task.title, status: 'uncertain', duplicate: false };
  }
  child.stdin.end(JSON.stringify({
    taskId: task.taskId,
    title: task.title,
    command: input.command,
    cwd: input.context.cwd,
    taskDirectory,
    sandboxPolicy: input.context.sandboxPolicy,
  }));
  child.unref();

  let ready = false;
  let settled = false;
  let stderr = '';
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const consumeFinal = async (message: WorkerMessage) => {
    if (settled || typeof message.resultPath !== 'string') return;
    settled = true;
    try {
      await finishResultFile(task.taskId, task.taskToken!, taskDirectory, message.resultPath);
    } catch (error) {
      taskContinuationDb.updateTaskRecoveryError({
        taskId: task.taskId,
        error: `Worker result callback failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000),
      });
    }
  };

  const consumeLine = (line: string) => {
    if (!line || Buffer.byteLength(line, 'utf8') > 64 * 1024) return;
    let message: WorkerMessage;
    try {
      message = JSON.parse(line) as WorkerMessage;
    } catch {
      return;
    }
    if (message.taskId !== task.taskId) return;
    if (message.type === 'ready') {
      ready = true;
      resolveReady();
      return;
    }
    if (message.type === 'result' || message.type === 'startup_error') {
      if (!ready) {
        rejectReady(new Error('Worker finished before confirming startup.'));
      }
      void consumeFinal(message);
    }
  };

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', consumeLine);
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-2000);
  });
  child.once('error', (error) => rejectReady(error));
  child.once('exit', (code, signal) => {
    if (!ready) rejectReady(new Error(`Worker exited before startup (code ${code ?? 'null'}, signal ${signal ?? 'null'}). ${stderr.trim()}`));
    else if (!settled) {
      taskContinuationDb.updateTaskRecoveryError({
        taskId: task.taskId,
        error: `Worker exited after startup without a verified result (code ${code ?? 'null'}, signal ${signal ?? 'null'}). The command outcome is unknown; no automatic retry was started. ${stderr.trim()}`.slice(0, 4000),
      });
      notifyTaskActivity(input.context.sessionId);
    }
  });

  const startupTimer = setTimeout(() => rejectReady(new Error('Worker startup outcome is unknown.')), STARTUP_TIMEOUT_MS);
  try {
    // The worker writes its heartbeat before it reports ready, so the card
    // is drawable by the time the start is announced.
    await readyPromise;
    const running = taskContinuationDb.getTaskById(task.taskId);
    if (running?.status === 'registered' && taskContinuationDb.markTaskRunning(task.taskId)) {
      notifyTaskActivity(input.context.sessionId);
    }
    const current = taskContinuationDb.getTaskById(task.taskId);
    return { taskId: task.taskId, title: task.title, status: toRunReceiptStatus(current?.status), duplicate: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    taskContinuationDb.updateTaskRecoveryError({ taskId: task.taskId, error: `Worker start outcome uncertain: ${reason}`.slice(0, 4000) });
    return { taskId: task.taskId, title: task.title, status: 'uncertain', duplicate: false };
  } finally {
    clearTimeout(startupTimer);
  }
}

/** Reads a completed task's bounded log after applying the same user/session ownership check as status. */
export async function readTaskOutputForScope(taskId: string, scope: TaskAccessScope): Promise<string> {
  const { task } = await handleGetTaskStatus(taskId, scope);
  if (!task.result_path) {
    throw new AppError('Task output is not available.', { code: 'TASK_OUTPUT_NOT_FOUND', statusCode: 404 });
  }
  const root = await realpath(getTaskContinuationTasksRoot());
  const resultPath = path.resolve(task.result_path);
  const resultInfo = await lstat(resultPath);
  if (resultInfo.isSymbolicLink() || !resultInfo.isFile()) {
    throw new AppError('Task result file is invalid.', { code: 'TASK_OUTPUT_PATH_INVALID', statusCode: 400 });
  }
  const resolvedResultPath = await realpath(resultPath);
  const resolvedTaskDirectory = path.join(root, taskId);
  if (resolvedResultPath !== path.join(resolvedTaskDirectory, 'result.json')) {
    throw new AppError('Task result path escapes the task root.', { code: 'TASK_OUTPUT_PATH_INVALID', statusCode: 400 });
  }
  const directoryInfo = await lstat(path.dirname(resultPath));
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new AppError('Task output directory is invalid.', { code: 'TASK_OUTPUT_PATH_INVALID', statusCode: 400 });
  }
  const resolvedDirectory = await realpath(path.dirname(resultPath));
  if (resolvedDirectory !== resolvedTaskDirectory) {
    throw new AppError('Task output directory escapes the task root.', { code: 'TASK_OUTPUT_PATH_INVALID', statusCode: 400 });
  }
  const outputPath = path.join(resolvedDirectory, 'output.log');
  const outputInfo = await lstat(outputPath);
  if (outputInfo.isSymbolicLink() || !outputInfo.isFile() || outputInfo.size > 1_000_000) {
    throw new AppError('Task output file is invalid or too large.', { code: 'TASK_OUTPUT_PATH_INVALID', statusCode: 400 });
  }
  const resolvedOutput = await realpath(outputPath);
  if (path.dirname(resolvedOutput) !== resolvedDirectory) {
    throw new AppError('Task output file escapes its task directory.', { code: 'TASK_OUTPUT_PATH_INVALID', statusCode: 400 });
  }
  return readFile(resolvedOutput, 'utf8');
}
