import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * A conversation the opencode engine resumes on its own — a background
 * subagent completing makes the service enqueue a synthetic message and keep
 * going, with no client prompt behind it — must reach the tabs already
 * watching it. The socket that will see the run live is the one that
 * subscribed while the session was idle; `adoptExternalRun` is what opens the
 * run and attaches it.
 */

const SESSION_ID = 'adopted-session';
const ENGINE_SESSION_ID = 'ses_engine_adopted';
const OTHER_SESSION_ID = 'other-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-external-run-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'opencode', tempDirectory);
    sessionsDb.assignProviderSessionId(SESSION_ID, ENGINE_SESSION_ID);
    sessionsDb.createAppSession(OTHER_SESSION_ID, 'opencode', tempDirectory);
    sessionsDb.assignProviderSessionId(OTHER_SESSION_ID, 'ses_engine_other');
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const IDLE_RUNTIME = {
  hasBackgroundWork: () => false,
  isBackgroundWorkPending: () => false,
  getPendingApprovalsForSession: () => [],
};

const settle = () => new Promise((resolve) => {
  setTimeout(resolve, 30);
});

function connectAndSubscribe(sessionId: string) {
  const socket = createFakeSocket();
  handleChatConnection(
    socket as never,
    { user: { id: 1 } } as never,
    { runtime: { ...IDLE_RUNTIME } as never },
  );
  socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] }));
  return socket;
}

test('a tab watching an idle session receives an adopted engine run live', async () => {
  await withIsolatedDatabase(async () => {
    const tab = connectAndSubscribe(SESSION_ID);
    await settle();
    assert.equal(tab.frames[0]?.kind, 'chat_subscribed');
    assert.equal(tab.frames[0]?.isProcessing, false);

    const adopted = chatRunRegistry.adoptExternalRun({ provider: 'opencode', providerSessionId: ENGINE_SESSION_ID });
    assert.ok(adopted);
    assert.equal(adopted.appSessionId, SESSION_ID);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);

    adopted.writer.send({
      kind: 'permission_request',
      provider: 'opencode',
      sessionId: ENGINE_SESSION_ID,
      requestId: 'frm_card_1',
      toolName: 'AskUserQuestion',
      input: { questions: [] },
      canInterrupt: true,
    } as never);
    adopted.writer.send({ kind: 'complete', provider: 'opencode', sessionId: ENGINE_SESSION_ID, exitCode: 0 });

    const kinds = tab.frames.map((frame) => frame.kind);
    assert.ok(kinds.includes('permission_request'), 'the question card must reach the watching tab');
    assert.ok(kinds.includes('complete'), 'the terminal frame must reach the watching tab');
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  });
});

test('a tab watching another session never sees the adopted run', async () => {
  await withIsolatedDatabase(async () => {
    const otherTab = connectAndSubscribe(OTHER_SESSION_ID);
    await settle();

    const adopted = chatRunRegistry.adoptExternalRun({ provider: 'opencode', providerSessionId: ENGINE_SESSION_ID });
    assert.ok(adopted);
    adopted.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: ENGINE_SESSION_ID, content: 'elsewhere' });
    adopted.writer.send({ kind: 'complete', provider: 'opencode', sessionId: ENGINE_SESSION_ID, exitCode: 0 });

    assert.deepEqual(
      otherTab.frames.map((frame) => frame.kind),
      ['chat_subscribed'],
      'only the subscribing session receives the adopted run',
    );
  });
});
