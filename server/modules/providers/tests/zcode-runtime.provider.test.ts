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
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

import { protocolClient } from '../list/zcode/zcode-protocol.client.js';
import { ZCodeRuntimeProvider, zcodeRuntimePermissions } from '../list/zcode/zcode-runtime.provider.js';
import { ZCodeSessionsProvider } from '../list/zcode/zcode-sessions.provider.js';

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

// mode "abort-ok": streams until a session/stop arrives, which both answers
// and ends the turn — mirroring an engine that honors a delivered stop.
let abortTicker = null;

// mode "perm-bridge": after session/send, mirrors the engine's blocking
// permission flow — one interaction/requestPermission server request whose
// answer releases the turn. The second announcement with a fresh protocol id
// but the same requestId mirrors the engine's periodic re-announce.
let permPending = 0;

const e2ePermissionParams = {
  requestId: 'perm_e2e_1',
  sessionId,
  toolCallId: 'call_e2e_1',
  toolName: 'Bash',
  input: { command: 'rm /tmp/y' },
  reason: 'Tool Bash requires approval',
  riskLevel: 'high',
};

// A REUSED requestId whose call content differs — the decision cache must not
// answer it with the recorded decision from the earlier request.
const conflictParamsA = {
  requestId: 'perm_conflict_1',
  sessionId,
  toolCallId: 'call_conflict_a',
  toolName: 'Bash',
  input: { command: 'rm /tmp/a' },
  reason: 'Tool Bash requires approval',
  riskLevel: 'high',
};
const conflictParamsB = {
  ...conflictParamsA,
  toolCallId: 'call_conflict_b',
  input: { command: 'rm /tmp/b' },
};

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
    if (msg.id === 'server-perm-e2e') {
      log('perm_answer', msg);
      // Late re-announcement of the SAME business requestId under a fresh
      // protocol id, racing the just-recorded decision — mirrors the engine's
      // periodic re-announce. The turn completes right after so the runtime's
      // run-scoped writer is still installed when it arrives.
      send({ id: 'server-perm-e2e-late', method: 'interaction/requestPermission', params: e2ePermissionParams });
      send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'e2e done' } } });
      send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
    }
    if (msg.id === 'server-perm-e2e-late') {
      log('perm_answer', msg);
    }
    if (msg.id === 'server-perm-conflict') {
      log('perm_answer', msg);
      // Same requestId, different call content: a genuinely new request that
      // must be surfaced and decided on its own.
      send({ id: 'server-perm-conflict-b', method: 'interaction/requestPermission', params: conflictParamsB });
      send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'conflict done' } } });
      send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
    }
    if (msg.id === 'server-perm-conflict-b') {
      log('perm_answer', msg);
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
    if (readMode() === 'perm-e2e') {
      send({ id: 'server-perm-e2e', method: 'interaction/requestPermission', params: e2ePermissionParams });
      return;
    }
    if (readMode() === 'perm-e2e-conflict') {
      send({ id: 'server-perm-conflict', method: 'interaction/requestPermission', params: conflictParamsA });
      return;
    }
    if (readMode() === 'silent') {
      send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'going quiet' } } });
      // Wakes well after the runtime's silence window handed the run to the
      // background watcher, proving late output still streams to the client.
      setTimeout(() => {
        send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'late wake' } } });
        send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
      }, 1600);
      return;
    }
    if (readMode() === 'steady') {
      // Continuous activity: every delta must reset the silence window so the
      // run survives several windows' worth of wall-clock time and completes
      // normally instead of tripping the watchdog.
      let ticks = 0;
      const ticker = setInterval(() => {
        ticks += 1;
        send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'tick ' + ticks } } });
        if (ticks >= 6) {
          clearInterval(ticker);
          send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
        }
      }, 400);
      return;
    }
    if (readMode() === 'abort-ok') {
      // Streams until a session/stop arrives (see the stop handler above),
      // mirroring an engine that honors a delivered stop.
      abortTicker = setInterval(() => {
        send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'streaming' } } });
      }, 200);
      return;
    }
    if (readMode() === 'stop-fail') {
      // Keeps streaming through the refused stop attempts so the run stays
      // alive; the turn only completes when the engine's own work is done.
      let ticks = 0;
      const ticker = setInterval(() => {
        ticks += 1;
        send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'tick ' + ticks } } });
        if (ticks >= 12) {
          clearInterval(ticker);
          send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
        }
      }, 300);
      return;
    }
    if (readMode() === 'crash') {
      // Mirrors an engine process death mid-turn: acknowledge the send, emit
      // one live delta, then die. The supervisor must synthesize
      // zcode:session/lost so the run fails fast instead of timing out.
      send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'about to die' } } });
      setTimeout(() => process.exit(1), 100);
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

  if (msg.method === 'session/stop') {
    log('stop', msg.params);
    if (abortTicker) { clearInterval(abortTicker); abortTicker = null; }
    if (readMode() === 'stop-fail') {
      send({ id: msg.id, error: { code: -32000, message: 'stop refused' } });
      return;
    }
    send({ id: msg.id, result: {} });
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

test('pending permissions survive a reconnect as answerable cards and do not resurrect', async () => {
  fsSync.writeFileSync(modeFilePath, 'perm-e2e\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const runPromise = runtime.run('hello', { sessionId: 'app-sess-perm-e2e', cwd: stubDir }, writer, context);

  let permissionMessage: NormalizedMessage | undefined;
  for (let i = 0; i < 100 && !permissionMessage; i += 1) {
    permissionMessage = messages.find((msg) => msg.kind === 'permission_request');
    if (!permissionMessage) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(permissionMessage, 'the permission request must reach the chat stream');

  // What chat.subscribe replays after a page reload must be a fully shaped
  // card — the UI renders toolName from it and answers with requestId. A bare
  // request-id string here renders a dead card (empty tool badge, clicks that
  // are silently dropped because requestId is undefined). The gateway looks
  // pending approvals up by the app-facing session id, which must win even
  // though the bridge keys its writer by the engine's native id.
  const pendingByAppId = zcodeRuntimePermissions.listPending('app-sess-perm-e2e');
  assert.equal(pendingByAppId.length, 1, 'the pending request must be found by app session id');
  const entry = pendingByAppId[0] as { requestId?: string; toolName?: string; sessionId?: string; input?: unknown };
  assert.equal(entry.requestId, 'perm_e2e_1');
  assert.equal(entry.toolName, 'Bash');
  assert.equal(entry.sessionId, 'app-sess-perm-e2e');
  assert.deepEqual(entry.input, { command: 'rm /tmp/y' });
  assert.equal(zcodeRuntimePermissions.listPending('sess_stub_1').length, 1, 'the native session id must also resolve');
  assert.deepEqual(zcodeRuntimePermissions.listPending('sess_other'), [], 'other sessions must not see this request');

  zcodeRuntimePermissions.resolve('perm_e2e_1', { allow: true });
  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  // The live client must learn the card is gone even though no `complete`
  // replay will ever clear it on reconnect.
  assert.ok(
    messages.some((msg) => msg.kind === 'permission_cancelled' && msg.requestId === 'perm_e2e_1'),
    'resolving a permission must retract the card via permission_cancelled'
  );
  // The late re-announcement (fresh protocol id, same requestId) must be
  // answered from the recorded decision instead of spawning a second card
  // that outlives the run as a zombie.
  assert.equal(messages.filter((msg) => msg.kind === 'permission_request').length, 1);
  const answers = readStubLog().filter((entry) => {
    if (entry.name !== 'perm_answer') return false;
    const id = (entry.value as { id?: string }).id;
    return id === 'server-perm-e2e' || id === 'server-perm-e2e-late';
  });
  assert.equal(answers.length, 2, 'both the original and the late announcement must receive the decision');
  assert.deepEqual(zcodeRuntimePermissions.listPending('app-sess-perm-e2e'), []);
});

test('a reused requestId with different call content is a fresh request, not a cached answer', async () => {
  fsSync.writeFileSync(modeFilePath, 'perm-e2e-conflict\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const runPromise = runtime.run('hello', { sessionId: 'app-sess-conflict', cwd: stubDir }, writer, context);

  const waitForCards = async (count: number): Promise<void> => {
    for (let i = 0; i < 100; i += 1) {
      if (messages.filter((msg) => msg.kind === 'permission_request').length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await waitForCards(1);
  zcodeRuntimePermissions.resolve('perm_conflict_1', { allow: true });

  // The second announcement reuses the requestId but carries a different
  // toolCallId/input — it must surface as its own card instead of silently
  // inheriting the recorded allow.
  await waitForCards(2);
  const secondCard = messages.filter((msg) => msg.kind === 'permission_request')[1];
  assert.equal(secondCard.toolId, 'call_conflict_b', 'the new card must be the reused-id request');
  assert.deepEqual(secondCard.input, { command: 'rm /tmp/b' });
  zcodeRuntimePermissions.resolve('perm_conflict_1', { allow: false, message: 'Denied by user' });

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  const answers = readStubLog().filter((entry) => {
    if (entry.name !== 'perm_answer') return false;
    const id = (entry.value as { id?: string }).id;
    return id === 'server-perm-conflict' || id === 'server-perm-conflict-b';
  });
  assert.equal(answers.length, 2, 'both the original and the reused-id request must reach the engine');
  assert.deepEqual((answers[0].value as { result: { decision: string } }).result, { decision: 'allow' });
  assert.match((answers[1].value as { result: { reason?: string } }).result.reason ?? '', /Denied by user/);
  const cancellations = messages.filter((msg) => msg.kind === 'permission_cancelled');
  assert.equal(cancellations.length, 2, 'both cards must be retracted as they are answered');
  assert.deepEqual(zcodeRuntimePermissions.listPending('app-sess-conflict'), []);
});

test('a silent engine hands the run to a background watcher that still streams the late completion', async () => {
  process.env.CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS = '1000';
  fsSync.writeFileSync(modeFilePath, 'silent\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  try {
    // Resolves (rather than rejecting): the stall is carried by the error
    // message, and the still-attached stream keeps running in the background
    // instead of being torn down the way the old wall-clock timeout did.
    const result = await runtime.run('hello', { sessionId: 'app-sess-silent', cwd: stubDir }, writer, context);
    assert.deepEqual(result, { sessionId: 'sess_stub_1', success: false });

    const stall = messages.find((msg) => msg.kind === 'error');
    assert.ok(stall, 'the silence stall must reach the chat stream');
    assert.match(stall.text ?? '', /silent/);
    assert.equal(
      messages.filter((msg) => msg.kind === 'complete').length, 0,
      'no complete may be sent while the engine may still be working'
    );

    // The engine wakes after the handoff: the late delta must stream and the
    // watcher must deliver the real completion.
    let complete: NormalizedMessage | undefined;
    for (let i = 0; i < 250 && !complete; i += 1) {
      complete = messages.find((msg) => msg.kind === 'complete');
      if (!complete) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(complete, 'the watcher must deliver the completion after the engine wakes');
    assert.equal(complete.tokens, 7);
    assert.ok(
      messages.some((msg) => msg.kind === 'stream_delta' && msg.content === 'late wake'),
      'late engine output must stream to the client'
    );
  } finally {
    delete process.env.CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS;
  }
});

test('steady engine activity keeps the run alive past the silence window', async () => {
  process.env.CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS = '600';
  fsSync.writeFileSync(modeFilePath, 'steady\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  try {
    // ~2.4s of continuous deltas against a 600ms silence window: the run must
    // complete normally instead of stalling out (the old wall-clock timeout
    // killed any run past its budget even while it was actively streaming).
    const result = await runtime.run('hello', { sessionId: 'app-sess-steady', cwd: stubDir }, writer, context);
    assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

    assert.ok(messages.filter((msg) => msg.kind === 'stream_delta').length >= 6);
    const complete = messages.find((msg) => msg.kind === 'complete');
    assert.ok(complete, 'the run must terminate with a complete event');
    assert.equal(complete.tokens, 7);
    assert.equal(messages.filter((msg) => msg.kind === 'error').length, 0, 'an active run must never surface the silence stall');
  } finally {
    delete process.env.CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS;
  }
});

test('a delivered session/stop settles the run as aborted with a complete frame', async () => {
  fsSync.writeFileSync(modeFilePath, 'abort-ok\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const runPromise = runtime.run('hello', { sessionId: 'app-sess-abort', cwd: stubDir }, writer, context);

  // Wait until the turn is streaming, then stop it.
  let streaming = false;
  for (let i = 0; i < 100 && !streaming; i += 1) {
    streaming = messages.some((msg) => msg.kind === 'stream_delta');
    if (!streaming) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(streaming, 'the stub must be streaming before the abort');

  assert.equal(await runtime.abort('app-sess-abort'), true, 'a delivered stop must report success');

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: false });

  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.ok(complete, 'an aborted run must still end with a complete frame');
  assert.equal(complete.exitCode, 0, 'an abort is not an engine failure');
  assert.equal(messages.filter((msg) => msg.kind === 'error').length, 0, 'an abort must not surface an error bubble');
});

// Last: the crash mode kills the shared stub subprocess; the supervisor's
// restart circuit breaker brings it back, but later tests should not have to
// race the restart.
test('a failed session/stop keeps the run running to its true completion instead of reporting aborted', async () => {
  fsSync.writeFileSync(modeFilePath, 'stop-fail\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const runPromise = runtime.run('hello', { sessionId: 'app-sess-stopfail', cwd: stubDir }, writer, context);

  // Let streaming start, then abort against an engine that refuses to stop.
  // Every stop attempt must be refused before abort gives up.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const stopsBefore = readStubLog().filter((entry) => entry.name === 'stop').length;
  assert.equal(await runtime.abort('app-sess-stopfail'), false, 'abort must report failure when every stop attempt is refused');
  assert.equal(readStubLog().filter((entry) => entry.name === 'stop').length - stopsBefore, 3, 'all three stop attempts must reach the engine');

  const stopError = messages.find((msg) => msg.kind === 'error' && /Failed to stop ZCode session/.test(msg.text ?? ''));
  assert.ok(stopError, 'the failed stop must be surfaced to the chat stream');

  // The engine never stopped, so the run continues to its real completion —
  // the old code marked the run completed at abort time and ended it while
  // the turn was in fact still running.
  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });
  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.ok(complete, 'the run must terminate with a complete event');
  assert.equal(complete.tokens, 7, 'the real turn completion must be delivered, not an abort short-circuit');
});

test('an engine crash fails the run fast through session-lost instead of timing out', async () => {
  fsSync.writeFileSync(modeFilePath, 'crash\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  // Resolves (rather than hanging for the silence window): the synthetic
  // session-lost notification marks the run failed immediately.
  const result = await runtime.run('hello', { sessionId: 'app-sess-crash', cwd: stubDir }, writer, context);
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: false });

  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.ok(complete, 'the run must still terminate with a complete event');
  assert.equal(complete.exitCode, 1, 'a lost connection must complete the run as failed');

  // The run's state is gone: a late abort finds nothing left to stop.
  assert.equal(await runtime.abort('app-sess-crash'), false);
});
