/**
 * ZCode Runtime Unit Tests
 *
 * Drives the runtime against a stub app-server engine (injected via
 * CLOUDCLI_ZCODE_ENGINE) that mirrors the bidirectional protocol: while
 * handling session/create it issues a server-initiated
 * session/requestRuntimePreferences request and only completes the create once
 * the client answers — the exact flow that deadlocked against engine 0.16.3
 * (-32022 after the engine's 15s window). The create-fail mode verifies that
 * session/create failures reach the chat stream as error messages instead of
 * dying silently before the run's error reporting.
 */

import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

import { protocolClient } from '../list/zcode/zcode-protocol.client.js';
import { ZCodeRuntimeProvider, zcodeRuntimePermissions } from '../list/zcode/zcode-runtime.provider.js';
import { ZCodeSessionsProvider } from '../list/zcode/zcode-sessions.provider.js';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

const stubDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'zcode-stub-'));
const stubPath = path.join(stubDir, 'zcode-stub.cjs');
const modeFilePath = path.join(stubDir, 'mode.txt');
const logFilePath = path.join(stubDir, 'stub-log.jsonl');

// The engine's behavior mode is read from a file per session/create so both
// test cases can share one long-lived app-server subprocess.
const stubScript = `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');

const modeFile = process.env.ZCODE_STUB_MODE_FILE;
const logFile = process.env.ZCODE_STUB_LOG;
const sessionId = 'sess_stub_1';

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const log = (name, value) => {
  try { fs.appendFileSync(logFile, JSON.stringify({ name, value }) + '\\n'); } catch {}
};
const readMode = () => {
  try { return fs.readFileSync(modeFile, 'utf8').trim(); } catch { return 'ok'; }
};

let pendingCreateId = null;
const finishCreate = () => {
  if (pendingCreateId === null) return;
  send({ id: pendingCreateId, result: { sessionId } });
  pendingCreateId = null;
};

// mode "perm-bridge": after session/send, mirrors the engine's blocking
// permission flow — one interaction/requestPermission server request whose
// answer releases the turn. The second announcement with a fresh protocol id
// but the same requestId mirrors the engine's periodic re-announce.
let permPending = 0;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Responses to our server-initiated requests carry no method.
  if (msg.method === undefined) {
    if (msg.id === 'server-1') {
      log('prefs_response', msg);
      finishCreate();
    }
    if ((msg.id === 'server-perm' || msg.id === 'server-perm2') && permPending > 0) {
      log('perm_answer', msg);
      permPending -= 1;
      if (permPending === 0) {
        send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'ran it' } } });
        send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
      }
    }
    return;
  }

  if (msg.method === 'session/create') {
    if (readMode() === 'create-fail') {
      send({ id: msg.id, error: { code: -32022, message: 'Client request timed out: session/requestRuntimePreferences', data: { timeoutMs: 15000 } } });
      return;
    }
    // Mirror the real engine: ask the client for runtime preferences while
    // the create is still pending, and only finish once it answers.
    pendingCreateId = msg.id;
    send({ id: 'server-1', method: 'session/requestRuntimePreferences', params: { sessionId, scope: 'runtime-materialization' } });
    return;
  }

  if (msg.method === 'session/send') {
    // Mirror the engine's strict schema: unknown keys are rejected.
    for (const key of Object.keys(msg.params ?? {})) {
      if (key !== 'sessionId' && key !== 'content' && key !== 'attachments' && key !== 'runtimeModel') {
        send({ id: msg.id, error: { code: -32600, message: 'Invalid params — (root): Unrecognized key: "' + key + '"' } });
        return;
      }
    }
    send({ id: msg.id, result: {} });
    if (readMode() === 'send-fail') {
      send({ method: 'session/event', params: { sessionId, type: 'turn.failed', payload: { error: { message: 'provider auth failed', attribution: { statusCode: 401, reason: 'auth_failed' } } } } });
      return;
    }
    if (readMode() === 'perm-bridge') {
      // The turn blocks on a permission server request until answered.
      permPending = 2;
      const permissionParams = {
        requestId: 'perm_test_1',
        sessionId,
        toolCallId: 'call_perm_1',
        toolName: 'Bash',
        input: { command: 'touch /tmp/x' },
        reason: 'Tool Bash requires approval',
        riskLevel: 'medium',
      };
      send({ id: 'server-perm', method: 'interaction/requestPermission', params: permissionParams });
      send({ id: 'server-perm2', method: 'interaction/requestPermission', params: permissionParams });
      return;
    }
    send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'hi there' } } });
    send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
    return;
  }

  if (msg.method === 'session/resume') {
    if (readMode() === 'resume-fail') {
      send({ id: msg.id, error: { code: -32004, message: 'Session is not active: ' + (msg.params?.sessionId ?? '') } });
      return;
    }
    send({ id: msg.id, result: { messages: [] } });
    return;
  }

  if (msg.method === 'session/setModel') {
    log('setModel', msg.params);
    send({ id: msg.id, result: {} });
    return;
  }

  // subscribe / setMode / stop / anything else: empty success.
  send({ id: msg.id, result: {} });
});
`;

fsSync.writeFileSync(stubPath, stubScript);
fsSync.writeFileSync(modeFilePath, 'ok\n');
fsSync.writeFileSync(logFilePath, '');

process.env.CLOUDCLI_ZCODE_ENGINE = stubPath;
process.env.ZCODE_STUB_MODE_FILE = modeFilePath;
process.env.ZCODE_STUB_LOG = logFilePath;

// The runtime reads the session row (model/effort) via sessionsDb during a
// run, so the tests need a migrated app database. Without this the lazy
// connection falls back to the legacy working-directory shell database,
// which has no tables and fails every run with SQLITE_ERROR.
const runtimeTestDbPath = path.join(stubDir, 'auth.db');
fsSync.writeFileSync(runtimeTestDbPath, '');
process.env.DATABASE_PATH = runtimeTestDbPath;

before(async () => {
  await initializeDatabase();
});

const sessionsProvider = new ZCodeSessionsProvider();

const context: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'glm-5.3' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

const createWriter = (): { messages: NormalizedMessage[]; writer: ProviderRuntimeWriter } => {
  const messages: NormalizedMessage[] = [];
  const writer: ProviderRuntimeWriter = {
    userId: null,
    send: (data: unknown) => messages.push(data as NormalizedMessage),
    setSessionId: () => undefined,
  };
  return { messages, writer };
};

const readStubLog = (): Array<{ name: string; value: unknown }> =>
  fsSync.readFileSync(logFilePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { name: string; value: unknown });

after(async () => {
  closeConnection();
  await protocolClient.shutdown();
});

test('runtime completes a run when the engine asks for runtime preferences mid-create', async () => {
  fsSync.writeFileSync(modeFilePath, 'ok\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const result = await runtime.run('hello', { sessionId: 'app-sess-ok', cwd: stubDir }, writer, context);

  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  // The engine's server-initiated request was answered, unblocking create.
  const prefsResponse = readStubLog().find((entry) => entry.name === 'prefs_response');
  assert.ok(prefsResponse, 'engine must receive a response to its runtime preferences request');
  assert.deepEqual(prefsResponse.value, {
    id: 'server-1',
    result: { nativeSearchEnhancementsEnabled: false },
  });

  assert.equal(messages.filter((msg) => msg.kind === 'session_created').length, 1);
  const delta = messages.find((msg) => msg.kind === 'stream_delta');
  assert.equal(delta?.content, 'hi there');
  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.equal(complete?.tokens, 7);
});

test('runtime surfaces session/create failures as error messages', async () => {
  fsSync.writeFileSync(modeFilePath, 'create-fail\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  await assert.rejects(
    runtime.run('hello', { sessionId: 'app-sess-fail', cwd: stubDir }, writer, context),
    /Failed to create ZCode session/
  );

  const error = messages.find((msg) => msg.kind === 'error');
  assert.ok(error, 'session/create failure must reach the chat stream');
  assert.match(error.text ?? '', /Failed to create ZCode session/);
});

test('runtime reports turn.failed as an error and completes with a failing exit code', async () => {
  fsSync.writeFileSync(modeFilePath, 'send-fail\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  // Resolves (rather than throwing): the failure is carried by the error
  // message plus a complete with exitCode 1, matching the claude pattern.
  await runtime.run('hello', { sessionId: 'app-sess-sendfail', cwd: stubDir }, writer, context);

  const error = messages.find((msg) => msg.kind === 'error');
  assert.ok(error, 'turn.failed must surface as an error message');
  assert.equal(error.text, 'provider auth failed');
  assert.equal(error.content, 'provider auth failed');
  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.ok(complete, 'run must still terminate with a complete event');
  assert.equal(complete.exitCode, 1);
});

test('runtime configures model and reasoning effort variant', async () => {
  fsSync.writeFileSync(modeFilePath, 'ok\n');
  const runtime = new ZCodeRuntimeProvider();
  const { writer } = createWriter();

  await runtime.run('hello', {
    sessionId: 'app-sess-effort',
    model: 'GLM-5.3',
    effort: 'high',
    cwd: stubDir,
  }, writer, context);

  const setModelEntry = readStubLog().find((entry) => entry.name === 'setModel');
  assert.ok(setModelEntry, 'session/setModel must be called when model and effort are specified');
  const setModelPayload = setModelEntry.value as { model: { modelId: string; variant?: string } };
  assert.equal(setModelPayload.model.modelId, 'GLM-5.3');
  assert.equal(setModelPayload.model.variant, 'high');
});

test('runtime bridges interaction/requestPermission to the chat stream and answers the engine', async () => {
  fsSync.writeFileSync(modeFilePath, 'perm-bridge\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  // The run parks on the permission until it is resolved.
  const runPromise = runtime.run('hello', { sessionId: 'app-sess-perm', cwd: stubDir }, writer, context);

  let permissionMessage: NormalizedMessage | undefined;
  for (let i = 0; i < 100 && !permissionMessage; i += 1) {
    permissionMessage = messages.find((msg) => msg.kind === 'permission_request');
    if (!permissionMessage) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  assert.ok(permissionMessage, 'the permission request must reach the chat stream');
  assert.equal(permissionMessage.requestId, 'perm_test_1');
  assert.equal(permissionMessage.toolName, 'Bash');
  assert.deepEqual(permissionMessage.input, { command: 'touch /tmp/x' });

  // Answering through the permissions facet unblocks the engine-side turn.
  // One decision must satisfy BOTH stacked announcements (the engine
  // re-announces pending permissions as fresh protocol requests).
  zcodeRuntimePermissions.resolve('perm_test_1', { allow: true });

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  const answers = readStubLog().filter((entry) => entry.name === 'perm_answer');
  assert.equal(answers.length, 2, 'both announcements must receive the decision');
  for (const answer of answers) {
    assert.deepEqual((answer.value as { result: { decision: string } }).result, { decision: 'allow' });
  }
  const delta = messages.find((msg) => msg.kind === 'stream_delta');
  assert.equal(delta?.content, 'ran it');
});
