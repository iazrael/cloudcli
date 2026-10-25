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

const SESSION_ID = 'compact-session';

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

type RunCall = { provider: string; command: string; options: Record<string, unknown> };
type CompactCall = { provider: string; options: Record<string, unknown> };

/**
 * Boots the chat gateway against an in-memory session row and a stub runtime,
 * so the `chat.compact` frame can be exercised over the real connection
 * handler without a provider engine.
 */
async function withGateway(
  supportsCompaction: boolean,
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    runs: RunCall[];
    compactCalls: CompactCall[];
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-compact-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: RunCall[] = [];
  const compactCalls: CompactCall[] = [];
  const socket = createFakeSocket();

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Compact session', now, now, null);

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          supportsCompaction: () => supportsCompaction,
          run: async (provider: string, command: string, options: Record<string, unknown>) => {
            runs.push({ provider, command, options });
          },
          compact: async (provider: string, options: Record<string, unknown>) => {
            compactCalls.push({ provider, options });
          },
        } as never,
      },
    );

    await runTest({ socket, runs, compactCalls });
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

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('chat.compact dispatches the runtime compact primitive and completes the run', async () => {
  await withGateway(true, async ({ socket, runs, compactCalls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.compact', sessionId: SESSION_ID }));
    await settle();

    assert.equal(compactCalls.length, 1, 'the compact primitive must be the one executed');
    assert.equal(compactCalls[0]?.provider, 'claude');
    assert.equal(compactCalls[0]?.options.sessionId, SESSION_ID);
    assert.equal(runs.length, 0, 'no model turn may be started for a compaction frame');

    const complete = socket.frames.find((frame) => frame.kind === 'complete');
    assert.ok(complete, 'the run must terminate with a complete frame so the UI refreshes');
  });
});

test('chat.compact is rejected for providers without the compact primitive', async () => {
  await withGateway(false, async ({ socket, compactCalls }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.compact', sessionId: SESSION_ID }));
    await settle();

    assert.equal(compactCalls.length, 0);
    const failure = socket.frames.find((frame) => frame.kind === 'protocol_error');
    assert.equal(failure?.code, 'COMPACTION_UNSUPPORTED');
  });
});
