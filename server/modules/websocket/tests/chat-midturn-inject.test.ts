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

const SESSION_ID = 'midturn-session';

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

type InjectCall = { provider: string; command: string; options: Record<string, unknown> };

/**
 * Boots the gateway with a stub runtime whose turn stays open until the test
 * releases it, so a second `chat.send` arrives while the first is running.
 */
async function withGateway(
  injectResult: boolean,
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    runCommands: string[];
    injectCalls: InjectCall[];
    finishTurn: () => void;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-midturn-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runCommands: string[] = [];
  const injectCalls: InjectCall[] = [];
  const turnReleases: Array<() => void> = [];
  const socket = createFakeSocket();

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'opencode', tempDirectory, 'Mid-turn session', now, now, null);

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: (_provider: string, command: string) => {
            runCommands.push(command);
            return new Promise<void>((resolve) => { turnReleases.push(resolve); });
          },
          injectInput: async (provider: string, command: string, options: Record<string, unknown>) => {
            injectCalls.push({ provider, command, options });
            return injectResult;
          },
        } as never,
      },
    );

    await runTest({
      socket,
      runCommands,
      injectCalls,
      finishTurn: () => { for (const release of turnReleases.splice(0)) release(); },
    });
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

const send = (socket: ReturnType<typeof createFakeSocket>, content: string) => {
  socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content, options: {} }));
};

test('a send during a running turn goes to the runtime injection, not a new run', async () => {
  await withGateway(true, async ({ socket, runCommands, injectCalls, finishTurn }) => {
    send(socket, 'first');
    await settle();
    send(socket, 'second');
    await settle();

    assert.deepEqual(runCommands, ['first'], 'the second message must not start a run of its own');
    assert.equal(injectCalls.length, 1);
    assert.equal(injectCalls[0]?.provider, 'opencode');
    assert.equal(injectCalls[0]?.command, 'second');
    assert.equal(injectCalls[0]?.options.sessionId, SESSION_ID);
    assert.equal(
      socket.frames.some((frame) => frame.kind === 'protocol_error'),
      false,
      'an injected message is not a refused run',
    );

    finishTurn();
    await settle();
  });
});

test('a send the running turn cannot take is still refused as a run in progress', async () => {
  await withGateway(false, async ({ socket, runCommands, injectCalls, finishTurn }) => {
    send(socket, 'first');
    await settle();
    send(socket, 'second');
    await settle();

    assert.equal(injectCalls.length, 1);
    assert.deepEqual(runCommands, ['first']);
    const refusal = socket.frames.find((frame) => frame.kind === 'protocol_error');
    assert.equal(refusal?.code, 'RUN_IN_PROGRESS');

    finishTurn();
    await settle();
  });
});

test('a send to an idle session starts a run without trying injection', async () => {
  await withGateway(true, async ({ socket, runCommands, injectCalls, finishTurn }) => {
    send(socket, 'only');
    await settle();

    assert.deepEqual(runCommands, ['only']);
    assert.equal(injectCalls.length, 0);

    finishTurn();
    await settle();
  });
});
