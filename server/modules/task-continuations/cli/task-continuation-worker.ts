import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, rename, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { executeCodexSandboxCommand } from '@/modules/providers/index.js';
import {
  TASK_STOP_REQUEST_FILE,
  TASK_WORKER_HEARTBEAT_FILE,
  TASK_WORKER_HEARTBEAT_INTERVAL_MS,
} from '@/modules/task-continuations/services/task-storage.service.js';
import { AppError, readObjectRecord } from '@/shared/utils.js';

const MAX_OUTPUT_LOG_BYTES = 1_000_000;
const MAX_OUTPUT_PREVIEW_BYTES = 12_000;
/** How often the worker looks for the host's stop request. */
const STOP_POLL_INTERVAL_MS = 500;

type WorkerInput = {
  taskId: string;
  title: string;
  command: string[];
  cwd: string;
  taskDirectory: string;
  sandboxPolicy: { type: 'workspaceWrite' | 'dangerFullAccess'; networkAccess: boolean };
};

function writeMessage(stdout: Writable, message: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) {
    return { value, truncated: false };
  }
  return { value: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

async function readInput(stdin: Readable): Promise<unknown> {
  let input = '';
  for await (const chunk of stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input, 'utf8') > 128 * 1024) {
      throw new AppError('Task worker input is too large.', { code: 'INVALID_TASK_WORKER_INPUT', statusCode: 400 });
    }
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new AppError('Task worker input is invalid.', { code: 'INVALID_TASK_WORKER_INPUT', statusCode: 400 });
  }
}

function parseWorkerInput(value: unknown): WorkerInput {
  const input = readObjectRecord(value);
  const policy = readObjectRecord(input?.sandboxPolicy);
  if (typeof input?.taskId !== 'string' || !/^task_[A-Za-z0-9_-]{1,180}$/.test(input.taskId)
    || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200
    || !Array.isArray(input.command) || input.command.length < 1 || input.command.length > 129
    || input.command.some((argument) => typeof argument !== 'string' || argument.length > 4096 || argument.includes('\0'))
    || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)
    || typeof input.taskDirectory !== 'string' || !path.isAbsolute(input.taskDirectory)
    || !policy || !['workspaceWrite', 'dangerFullAccess'].includes(String(policy.type))
    || typeof policy.networkAccess !== 'boolean') {
    throw new AppError('Task worker input is invalid.', { code: 'INVALID_TASK_WORKER_INPUT', statusCode: 400 });
  }
  return {
    taskId: input.taskId,
    title: input.title.trim(),
    command: input.command as string[],
    cwd: input.cwd,
    taskDirectory: input.taskDirectory,
    sandboxPolicy: {
      type: policy.type as WorkerInput['sandboxPolicy']['type'],
      networkAccess: policy.networkAccess,
    },
  };
}

async function writeTaskResult(input: WorkerInput, result: {
  status: 'completed' | 'failed' | 'cancelled';
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}): Promise<string> {
  await mkdir(input.taskDirectory, { recursive: true });
  const combinedOutput = [
    result.stdout ? `stdout:\n${result.stdout}` : '',
    result.stderr ? `stderr:\n${result.stderr}` : '',
    result.error ? `error:\n${result.error}` : '',
  ].filter(Boolean).join('\n\n');
  const log = truncateUtf8(combinedOutput, MAX_OUTPUT_LOG_BYTES);
  const preview = truncateUtf8(combinedOutput, MAX_OUTPUT_PREVIEW_BYTES);
  const logPath = path.join(input.taskDirectory, 'output.log');
  await writeFile(logPath, log.value, { encoding: 'utf8', mode: 0o600 });
  const summary = [
    `Task "${input.title}" ${result.status === 'cancelled' ? 'was stopped by the user' : result.status} (exit code ${result.exitCode}).`,
    preview.value ? `\n${preview.value}` : '',
    preview.truncated || log.truncated ? '\n[Output truncated; use the task output endpoint for the saved log.]' : '',
  ].join('');
  const payload = {
    version: 1,
    taskId: input.taskId,
    title: input.title,
    status: result.status,
    exitCode: result.exitCode,
    completedAt: new Date().toISOString(),
    summary,
    outputLog: 'output.log',
    outputTruncated: log.truncated,
  };
  const resultPath = path.join(input.taskDirectory, 'result.json');
  const temporaryPath = `${resultPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, resultPath);
  return resultPath;
}

/** Runs one detached command through Codex app-server and writes an atomic result. */
export async function runTaskContinuationWorker(io: {
  stdin: Readable;
  stdout: Writable;
}): Promise<void> {
  // A detached worker must finish and write its result even if the host exits
  // after accepting the task and closes the worker's status pipe.
  io.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') {
      throw error;
    }
  });
  const input = parseWorkerInput(await readInput(io.stdin));
  let started = false;
  let commandResult: { exitCode: number; stdout: string; stderr: string };
  let startupError: string | undefined;
  // The host asks for a stop by creating a file in the task directory; see
  // TASK_STOP_REQUEST_FILE.
  const stop = new AbortController();
  const stopPath = path.join(input.taskDirectory, TASK_STOP_REQUEST_FILE);
  const stopWatch = setInterval(() => {
    if (!stop.signal.aborted && existsSync(stopPath)) {
      stop.abort();
    }
  }, STOP_POLL_INTERVAL_MS);
  // The heartbeat is written before the command starts, so the host can draw
  // the card as soon as it hears `ready`; see TASK_WORKER_HEARTBEAT_FILE.
  const heartbeatPath = path.join(input.taskDirectory, TASK_WORKER_HEARTBEAT_FILE);
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    await mkdir(input.taskDirectory, { recursive: true });
    await writeFile(heartbeatPath, JSON.stringify({ startedAt: Date.now() }), { encoding: 'utf8', mode: 0o600 });
    heartbeat = setInterval(() => {
      const now = new Date();
      utimes(heartbeatPath, now, now).catch((error: unknown) => {
        // A missed beat only hides the card; the command keeps running.
        console.error('[TaskWorker] Could not refresh the heartbeat:', error instanceof Error ? error.message : error);
      });
    }, TASK_WORKER_HEARTBEAT_INTERVAL_MS);
  } catch (error) {
    console.error('[TaskWorker] Could not write the heartbeat; the task shows no card:', error instanceof Error ? error.message : error);
  }
  try {
    commandResult = await executeCodexSandboxCommand({
      command: input.command,
      cwd: input.cwd,
      sandboxPolicy: input.sandboxPolicy,
      signal: stop.signal,
      onStarted: () => {
        started = true;
        writeMessage(io.stdout, { type: 'ready', taskId: input.taskId });
      },
    });
  } catch (error) {
    commandResult = { exitCode: 1, stdout: '', stderr: '' };
    startupError = error instanceof Error ? error.message.slice(0, 1000) : 'Codex command execution failed.';
  } finally {
    clearInterval(stopWatch);
    clearInterval(heartbeat);
  }

  const cleanExit = commandResult.exitCode === 0 && !startupError;
  // A stopped command is `cancelled`, unless it finished cleanly before the
  // stop landed. A stop that had to close the app-server ends command/exec
  // with an error instead of an exit code; the user still stopped it, but
  // nobody saw the command exit, so the result says so.
  if (stop.signal.aborted && started && startupError) {
    startupError = `The stop could not be confirmed; the command may still be running. ${startupError}`.slice(0, 1000);
  }
  const status = stop.signal.aborted && started && !cleanExit
    ? 'cancelled'
    : cleanExit ? 'completed' : 'failed';
  const resultPath = await writeTaskResult(input, {
    status,
    exitCode: commandResult.exitCode,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    ...(startupError ? { error: startupError } : {}),
  });
  writeMessage(io.stdout, {
    type: started ? 'result' : 'startup_error',
    taskId: input.taskId,
    resultPath,
    ...(started ? {} : { error: 'Codex command worker could not start.' }),
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runTaskContinuationWorker({ stdin: process.stdin, stdout: process.stdout });
}
