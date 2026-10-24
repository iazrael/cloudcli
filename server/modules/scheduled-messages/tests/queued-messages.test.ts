import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchQueuedMessages } from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';

const SESSION_ID = 'queued-session';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'queued-messages-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('queuer', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Queued session');
    await runTest(Number(user.id));
  } finally {
    chatRunRegistry.clearAll();
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

function createRuntime(runs: RunCall[], overrides: {
  hasRuntime?: () => boolean;
  hasBackgroundWork?: (sessionId: string) => boolean;
  backgroundWorkQueuesInput?: (provider: string, sessionId: string) => boolean;
  /** Settles the run; by default it settles at once. */
  runSettles?: Promise<void>;
} = {}) {
  return {
    hasRuntime: overrides.hasRuntime ?? (() => true),
    hasBackgroundWork: overrides.hasBackgroundWork ?? (() => false),
    ...(overrides.backgroundWorkQueuesInput
      ? { backgroundWorkQueuesInput: overrides.backgroundWorkQueuesInput }
      : {}),
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      runs.push({ provider, command, options });
      await overrides.runSettles;
    },
    abort: async () => true,
  } as never;
}

/** Lets the detached run reach the provider runtime. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function watchBroadcasts(): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  connectedClients.add({
    readyState: 1,
    send: (data: string) => frames.push(JSON.parse(data) as Record<string, unknown>),
  });
  return frames;
}

test('a queued message is sent by the server without a browser connection', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: {
        content: 'continue on the VPS',
        options: { model: 'claude-opus-5' },
        attachments: [{ path: '/tmp/upload.png' }],
      },
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    await settle();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'continue on the VPS');
    assert.equal(runs[0].options.model, 'claude-opus-5');
    // Not in the upload store, so the run drops it rather than reading an arbitrary path.
    assert.deepEqual(runs[0].options.attachments, []);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a queued message stays pending while its session is busy', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after this run' },
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    await settle();
    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, {
      content: 'send after this run',
    });
  });
});

function completeTurn(userId: number): void {
  const run = chatRunRegistry.startRun({
    appSessionId: SESSION_ID,
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId,
  });
  run!.writer.sendComplete({ exitCode: 0 });
}

test('a queued message waits for background work that holds the session\'s input', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'send after the background job' },
    });
    completeTurn(userId);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

    let backgroundWork = true;
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, {
      hasBackgroundWork: (sessionId) => sessionId === SESSION_ID && backgroundWork,
    });

    // Starting a new turn now would replace the process and stop that work.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    await settle();
    assert.equal(runs.length, 0);

    backgroundWork = false;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    await settle();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'send after the background job');
  });
});

test('a queued message goes at once when the provider takes a new turn alongside its background work', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'next prompt' },
    });
    completeTurn(userId);

    const runs: RunCall[] = [];
    // Claude's held process: the composer would not queue here either.
    const runtime = createRuntime(runs, {
      hasBackgroundWork: () => true,
      backgroundWorkQueuesInput: () => false,
    });

    assert.equal(await dispatchQueuedMessages(runtime), 1);
    await settle();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'next prompt');
  });
});

test('a pass returns once the turn has started, without waiting for it to finish', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'a long task' },
    });

    const runs: RunCall[] = [];
    // A turn that never ends inside this test.
    const runtime = createRuntime(runs, { runSettles: new Promise(() => undefined) });

    assert.equal(await dispatchQueuedMessages(runtime), 1);
    await settle();
    assert.equal(runs.length, 1);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);

    // The next pass sees the running turn and the already-claimed message.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 1);
  });
});

test('starting a queued turn tells every open page which session it went to', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'private text' },
    });
    const frames = watchBroadcasts();

    assert.equal(await dispatchQueuedMessages(createRuntime([])), 1);

    assert.deepEqual(frames, [{ kind: 'queued_message_dispatched', sessionId: SESSION_ID }]);
  });
});

test('a queued turn that cannot start is put back instead of being lost', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'keep me' },
    });
    const frames = watchBroadcasts();

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, { hasRuntime: () => false });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    await settle();

    assert.equal(runs.length, 0);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, { content: 'keep me' });
    assert.deepEqual(frames, []);

    // A provider that stays unavailable is not retried on every pass.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
  });
});
