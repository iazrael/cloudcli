/**
 * ZCode Runtime Resume/Fallback Tests
 *
 * Owns its stub app-server process so the resume flows don't share the
 * long-lived stub instance in `zcode-runtime.provider.test.ts` (sequential
 * creates against one stub interleave their pending server-request ids).
 *
 * Covers the -32004 recovery path: when the stored `provider_session_id` no
 * longer exists engine-side (engine restart/storage reset), `session/resume`
 * is attempted first and a replacement session is created only when the
 * resume fails, with the gateway's `setSessionId` making the new mapping
 * sticky.
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
import { ZCodeRuntimeProvider } from '../list/zcode/zcode-runtime.provider.js';
import { ZCodeSessionsProvider } from '../list/zcode/zcode-sessions.provider.js';

const stubDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'zcode-resume-stub-'));
const stubPath = path.join(stubDir, 'zcode-stub.cjs');
const modeFilePath = path.join(stubDir, 'mode.txt');

// Same contract as the shared runtime stub, plus a `session/resume` branch:
// mode "resume-fail" rejects with -32004, any other mode resumes cleanly.
const stubScript = `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');

const modeFile = process.env.ZCODE_STUB_MODE_FILE;
const sessionId = 'sess_stub_resume';

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const readMode = () => {
  try { return fs.readFileSync(modeFile, 'utf8').trim(); } catch { return 'ok'; }
};

let pendingCreateId = null;
let activeSession = null;
const finishCreate = () => {
  if (pendingCreateId === null) return;
  send({ id: pendingCreateId, result: { sessionId } });
  pendingCreateId = null;
  activeSession = sessionId;
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === undefined) {
    if (msg.id === 'server-1') finishCreate();
    return;
  }

  if (msg.method === 'session/resume') {
    if (readMode() === 'resume-fail') {
      send({ id: msg.id, error: { code: -32004, message: 'Session is not active: ' + (msg.params?.sessionId ?? '') } });
      return;
    }
    activeSession = msg.params?.sessionId;
    send({ id: msg.id, result: { messages: [] } });
    return;
  }

  if (msg.method === 'session/create') {
    pendingCreateId = msg.id;
    send({ id: 'server-1', method: 'session/requestRuntimePreferences', params: { sessionId, scope: 'runtime-materialization' } });
    return;
  }

  if (msg.method === 'session/send') {
    send({ id: msg.id, result: {} });
    send({ method: 'session/event', params: { sessionId: activeSession, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'hi there' } } });
    send({ method: 'session/event', params: { sessionId: activeSession, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
    return;
  }

  send({ id: msg.id, result: {} });
});
`;

fsSync.writeFileSync(stubPath, stubScript);
fsSync.writeFileSync(modeFilePath, 'ok\n');

process.env.CLOUDCLI_ZCODE_ENGINE = stubPath;
process.env.ZCODE_STUB_MODE_FILE = modeFilePath;

// See the shared runtime test file: the run reads the session row via
// sessionsDb, which needs a migrated app database to exist.
const resumeTestDbPath = path.join(stubDir, 'auth.db');
fsSync.writeFileSync(resumeTestDbPath, '');
process.env.DATABASE_PATH = resumeTestDbPath;

before(async () => {
  await initializeDatabase();
});

after(async () => {
  closeConnection();
  await protocolClient.shutdown();
});

const sessionsProvider = new ZCodeSessionsProvider();

const resumedContext: ProviderRuntimeContext = {
  resolveProviderSessionId: () => 'sess_existing_1',
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'GLM-5.3-Flash' }),
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

test('runtime resumes an existing provider session without creating a new one', async () => {
  fsSync.writeFileSync(modeFilePath, 'ok\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const result = await runtime.run('hello', { sessionId: 'app-sess-resume', cwd: stubDir }, writer, resumedContext);

  // The resumed run keeps the stored provider session id and skips the
  // create path (no session_created event).
  assert.deepEqual(result, { sessionId: 'sess_existing_1', success: true });
  assert.equal(messages.filter((msg) => msg.kind === 'session_created').length, 0);
  const delta = messages.find((msg) => msg.kind === 'stream_delta');
  assert.equal(delta?.content, 'hi there');
});

test('runtime falls back to a replacement session when resume fails', async () => {
  fsSync.writeFileSync(modeFilePath, 'resume-fail\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();
  const assignedIds: string[] = [];
  const recordingWriter: ProviderRuntimeWriter = {
    ...writer,
    setSessionId: (id: string) => assignedIds.push(id),
  };
  const fallbackContext: ProviderRuntimeContext = {
    ...resumedContext,
    resolveProviderSessionId: () => 'sess_orphaned_1',
  };

  const result = await runtime.run('hello', { sessionId: 'app-sess-orphan', cwd: stubDir }, recordingWriter, fallbackContext);

  // The orphaned id is replaced: the run uses the fresh session and the
  // gateway's setSessionId call makes the replacement mapping sticky.
  assert.deepEqual(result, { sessionId: 'sess_stub_resume', success: true });
  assert.deepEqual(assignedIds, ['sess_stub_resume']);
  assert.equal(messages.filter((msg) => msg.kind === 'session_created').length, 1);
});
