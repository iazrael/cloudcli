import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runTaskContinuationWorker } from '@/modules/task-continuations/cli/task-continuation-worker.js';

import { isCodexCommandSandboxAvailable } from './helpers/codex-sandbox-availability.js';

test('real Codex command/exec writes a bounded result and task output without host credentials', async (t) => {
  if (!await isCodexCommandSandboxAvailable()) {
    t.skip('Codex command sandbox is unavailable on this machine; see the helper for the Windows requirements.');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-worker-codex-'));
  const previousRegistrationToken = process.env.CLOUDCLI_REGISTRATION_TOKEN;
  const previousRunContext = process.env.CLOUDCLI_TASK_RUN_CONTEXT;
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousApiKey = process.env.API_KEY;
  process.env.CLOUDCLI_REGISTRATION_TOKEN = 'FAKE_REGISTRATION_TOKEN_FOR_TEST';
  process.env.CLOUDCLI_TASK_RUN_CONTEXT = 'FAKE_RUN_CONTEXT_FOR_TEST';
  process.env.JWT_SECRET = 'FAKE_JWT_SECRET_FOR_TEST';
  process.env.API_KEY = 'FAKE_API_KEY_FOR_TEST';
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const output: string[] = [];
  stdout.on('data', (chunk) => output.push(String(chunk)));

  try {
    const running = runTaskContinuationWorker({ stdin, stdout });
    stdin.end(JSON.stringify({
      taskId: 'task_real_codex_worker',
      title: 'Codex worker integration',
      command: [process.execPath, '-e', 'console.log("TASK_OUTPUT_MARKER"); console.log(process.env.CLOUDCLI_REGISTRATION_TOKEN ? "TOKEN_LEAK" : "TOKEN_ABSENT"); console.log(process.env.API_KEY || "API_KEY_ABSENT")'],
      cwd: directory,
      taskDirectory: directory,
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    }));
    await running;

    const messages = output.join('').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(messages[0].type, 'ready');
    assert.equal(messages.at(-1).type, 'result');
    const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    assert.equal(result.status, 'completed', result.summary);
    assert.equal(result.exitCode, 0);
    assert.match(result.summary, /TASK_OUTPUT_MARKER/);
    assert.match(result.summary, /TOKEN_ABSENT/);
    assert.match(result.summary, /API_KEY_ABSENT/);
    assert.doesNotMatch(result.summary, /FAKE_(REGISTRATION|RUN_CONTEXT|JWT_SECRET|API_KEY)/);
    const log = await readFile(path.join(directory, 'output.log'), 'utf8');
    assert.match(log, /TASK_OUTPUT_MARKER/);
    assert.match(log, /TOKEN_ABSENT/);
    assert.match(log, /API_KEY_ABSENT/);
    assert.doesNotMatch(log, /FAKE_(REGISTRATION|RUN_CONTEXT|JWT_SECRET|API_KEY)/);
  } finally {
    if (previousRegistrationToken === undefined) delete process.env.CLOUDCLI_REGISTRATION_TOKEN;
    else process.env.CLOUDCLI_REGISTRATION_TOKEN = previousRegistrationToken;
    if (previousRunContext === undefined) delete process.env.CLOUDCLI_TASK_RUN_CONTEXT;
    else process.env.CLOUDCLI_TASK_RUN_CONTEXT = previousRunContext;
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
    await rm(directory, { recursive: true, force: true });
  }
});
