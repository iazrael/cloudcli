import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Opening a conversation is the user's one lever over a provider whose pending
 * asks the gateway never learned about — a question raised while the
 * provider's event feed was down exists only in the provider's own memory.
 * The subscribe ack therefore asks the runtime to re-read them; without that
 * the model waits on a card no tab can ever show.
 */

const PROVIDER_SESSION_ID = 'ses_engine_reconcile';

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
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-subscribe-reconcile-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession('running-session', 'opencode', tempDirectory);
    sessionsDb.assignProviderSessionId('running-session', PROVIDER_SESSION_ID);
    sessionsDb.createAppSession('idle-session', 'opencode', tempDirectory);
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

const settle = () => new Promise((resolve) => {
  setTimeout(resolve, 30);
});

/** A runtime that records the reconcile calls the gateway makes. */
function createRuntime(reconciles: string[]) {
  return {
    hasBackgroundWork: () => false,
    isBackgroundWorkPending: () => false,
    getPendingApprovalsForSession: () => [],
    reconcilePendingInteractions: (sessionId: string) => { reconciles.push(sessionId); },
  };
}

function connectAndSubscribe(sessionId: string, reconciles: string[]) {
  const socket = createFakeSocket();
  handleChatConnection(
    socket as never,
    { user: { id: 1 } } as never,
    { runtime: createRuntime(reconciles) as never },
  );
  socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] }));
  return socket;
}

test('subscribing to a running session re-reads the provider\'s pending asks', async () => {
  await withIsolatedDatabase(async () => {
    const reconciles: string[] = [];
    const run = chatRunRegistry.startRun({
      appSessionId: 'running-session',
      provider: 'opencode',
      providerSessionId: PROVIDER_SESSION_ID,
      connection: null,
      userId: null,
    });
    assert.ok(run, 'the fixture run must be registered');

    const tab = connectAndSubscribe('running-session', reconciles);
    await settle();

    assert.equal(tab.frames[0]?.kind, 'chat_subscribed');
    assert.equal(tab.frames[0]?.isProcessing, true);
    assert.deepEqual(reconciles, ['running-session']);
  });
});

test('an idle session is never reconciled', async () => {
  await withIsolatedDatabase(async () => {
    const reconciles: string[] = [];
    const tab = connectAndSubscribe('idle-session', reconciles);
    await settle();

    assert.equal(tab.frames[0]?.isProcessing, false);
    assert.deepEqual(reconciles, []);
  });
});
