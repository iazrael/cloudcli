/**
 * ZCode permission-mode push tests.
 *
 * The engine persists a session's permission mode (`session.permission` in
 * ZCode's own database), and the model can move the live session into plan
 * mode mid-turn. Re-pushing the configured mode on every send therefore
 * silently cancels plan mode between turns: the next `ExitPlanMode` fails with
 * "can only be used while plan mode is active" and never reaches the approval
 * card, which the model is free to misread as approval.
 *
 * So the mode is a setting the run pushes on a *change*, not a per-turn
 * reassertion. Owns its own stub app-server process for the same reason the
 * resume tests do.
 */

import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

import { protocolClient } from '../list/zcode/zcode-protocol.client.js';
import { ZCodeRuntimeProvider } from '../list/zcode/zcode-runtime.provider.js';
import { ZCodeSessionsProvider } from '../list/zcode/zcode-sessions.provider.js';

const stubDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'zcode-mode-stub-'));
const stubPath = path.join(stubDir, 'zcode-stub.cjs');
const logFilePath = path.join(stubDir, 'stub-log.jsonl');

const stubScript = `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');

const logFile = process.env.ZCODE_STUB_LOG;
const sessionId = 'sess_stub_mode';

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const log = (name, value) => {
  try { fs.appendFileSync(logFile, JSON.stringify({ name, value }) + '\\n'); } catch {}
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

  if (msg.method === 'session/create') {
    pendingCreateId = msg.id;
    send({ id: 'server-1', method: 'session/requestRuntimePreferences', params: { sessionId, scope: 'runtime-materialization' } });
    return;
  }

  if (msg.method === 'session/resume') {
    activeSession = msg.params?.sessionId;
    send({ id: msg.id, result: { messages: [] } });
    return;
  }

  if (msg.method === 'session/setMode') {
    log('setMode', msg.params);
    send({ id: msg.id, result: {} });
    return;
  }

  // A created session's first prompt comes as the legacy session/send, later
  // ones as the v4 sendText command.
  if (msg.method === 'session/send' || (msg.method === 'v4/command' && msg.params?.type === 'sendText')) {
    send({ id: msg.id, result: msg.method === 'v4/command' ? { commandId: msg.params.commandId, status: 'accepted', revisionAtDecision: 1 } : {} });
    send({ method: 'session/event', params: { sessionId: activeSession, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'hi there' } } });
    send({ method: 'session/event', params: { sessionId: activeSession, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
    return;
  }

  send({ id: msg.id, result: {} });
});
`;

fsSync.writeFileSync(stubPath, stubScript);
fsSync.writeFileSync(logFilePath, '');

const cliConfigDir = path.join(stubDir, 'cli');
fsSync.mkdirSync(cliConfigDir, { recursive: true });
fsSync.writeFileSync(path.join(cliConfigDir, 'config.json'), JSON.stringify({
  provider: {
    'bigmodel-coding-plan': {
      kind: 'anthropic',
      options: {
        apiKey: 'mode-test-key',
        baseURL: 'https://example.invalid/api/anthropic',
      },
      models: {
        'GLM-5.3-Flash': {
          reasoning: { enabled: true, levels: ['low', 'high', 'max'], defaultLevel: 'max' },
        },
      },
    },
  },
  model: 'bigmodel-coding-plan/GLM-5.3-Flash',
}));

process.env.CLOUDCLI_ZCODE_ENGINE = stubPath;
process.env.ZCODE_STUB_LOG = logFilePath;
process.env.ZCODE_STORAGE_DIR = stubDir;

const modeTestDbPath = path.join(stubDir, 'auth.db');
fsSync.writeFileSync(modeTestDbPath, '');
process.env.DATABASE_PATH = modeTestDbPath;

before(async () => {
  await initializeDatabase();
});

after(async () => {
  closeConnection();
  await protocolClient.shutdown();
});

const sessionsProvider = new ZCodeSessionsProvider();

/** The modes pushed so far, oldest first. */
const pushedModes = (): string[] => fsSync.readFileSync(logFilePath, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as { name: string; value: { mode?: string } })
  .filter((entry) => entry.name === 'setMode')
  .map((entry) => entry.value.mode ?? '');

const createWriter = (): { messages: NormalizedMessage[]; writer: ProviderRuntimeWriter } => {
  const messages: NormalizedMessage[] = [];
  const writer: ProviderRuntimeWriter = {
    userId: null,
    send: (data: unknown) => messages.push(data as NormalizedMessage),
    setSessionId: () => undefined,
  };
  return { messages, writer };
};

const contextFor = (providerSessionId: string | null): ProviderRuntimeContext => ({
  resolveProviderSessionId: () => providerSessionId,
  resolveResumeModel: async () => 'GLM-5.3-Flash',
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'GLM-5.3-Flash' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
});

const runtime = new ZCodeRuntimeProvider();

test('a new session gets the configured permission mode pushed once', async () => {
  const { writer } = createWriter();

  await runtime.run(
    'hello',
    { sessionId: 'app-sess-mode', cwd: stubDir, permissionMode: 'bypassPermissions' },
    writer,
    contextFor(null),
  );

  assert.deepEqual(pushedModes(), ['yolo']);
});

test('a follow-up turn under the same mode does not re-push it', async () => {
  const { writer } = createWriter();

  await runtime.run(
    'hello again',
    { sessionId: 'app-sess-mode', cwd: stubDir, permissionMode: 'bypassPermissions' },
    writer,
    contextFor('sess_stub_mode'),
  );

  // Re-pushing here is what used to cancel a plan mode the model had entered
  // during the previous turn.
  assert.deepEqual(pushedModes(), ['yolo']);
});

test('changing the configured mode pushes the new one', async () => {
  const { writer } = createWriter();

  await runtime.run(
    'now plan it',
    { sessionId: 'app-sess-mode', cwd: stubDir, permissionMode: 'plan' },
    writer,
    contextFor('sess_stub_mode'),
  );

  assert.deepEqual(pushedModes(), ['yolo', 'plan']);
});
