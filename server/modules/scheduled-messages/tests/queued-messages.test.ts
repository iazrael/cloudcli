import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchQueuedMessages } from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/index.js';

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
  supportsInputAcceptance?: boolean;
  acceptAfter?: Promise<void>;
  deferInput?: boolean;
  afterClaim?: () => void;
  /** Settles the run; by default it settles at once. */
  runSettles?: Promise<void>;
} = {}) {
  return {
    supportsInputAcceptance: () => overrides.supportsInputAcceptance ?? false,
    hasRuntime: overrides.hasRuntime ?? (() => true),
    hasBackgroundWork: overrides.hasBackgroundWork ?? (() => false),
    ...(overrides.backgroundWorkQueuesInput
      ? { backgroundWorkQueuesInput: overrides.backgroundWorkQueuesInput }
      : {}),
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      runs.push({ provider, command, options });
      if (overrides.supportsInputAcceptance) {
        await overrides.acceptAfter;
        if ((options.onBeforeInputAccepted as (() => boolean) | undefined)?.() === false) {
          throw new AppError('Queued input changed.', { code: 'PROVIDER_INPUT_DEFERRED' });
        }
        if (overrides.deferInput) throw new AppError('The held process cannot take this input.', { code: 'PROVIDER_INPUT_DEFERRED' });
        overrides.afterClaim?.();
        (options.onInputAccepted as (() => void) | undefined)?.();
      }
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

    assert.deepEqual(frames, [{
      kind: 'queued_message_dispatched', sessionId: SESSION_ID,
      messageFingerprint: createHash('sha256').update(JSON.stringify({ content: 'private text', attachments: [] })).digest('hex'),
    }]);
  });
});

test('queued input waits for engine acceptance before telling pages it was sent', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'next prompt' } });
    const frames = watchBroadcasts();
    const runs: RunCall[] = [];
    let accept!: () => void;
    const runtime = createRuntime(runs, {
      hasBackgroundWork: () => true,
      backgroundWorkQueuesInput: () => true,
      supportsInputAcceptance: true,
      acceptAfter: new Promise<void>((resolve) => { accept = resolve; }),
    });
    const dispatched = dispatchQueuedMessages(runtime);
    await settle();
    assert.equal(runs.length, 1, 'the server can try the held process despite the page queueing input');
    assert.equal(await dispatchQueuedMessages(runtime), 0, 'a second poll cannot attempt the same input');
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, { content: 'next prompt' });
    assert.equal(frames.some((frame) => frame.kind === 'queued_message_dispatched'), false);
    accept();
    assert.equal(await dispatched, 1);
    assert.equal(frames.filter((frame) => frame.kind === 'queued_message_dispatched').length, 1);
    await settle();
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a deferred engine handover restores the queue without a sent notification or error', async () => {
  await withIsolatedDatabase(async (userId) => {
    const queuedMessage = { content: 'keep the agent running', options: { model: 'haiku' }, attachments: [] };
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage });
    const frames = watchBroadcasts();
    const runtime = createRuntime([], {
      hasBackgroundWork: () => true,
      backgroundWorkQueuesInput: () => true,
      supportsInputAcceptance: true,
      deferInput: true,
    });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, queuedMessage);
    assert.equal(frames.some((frame) => frame.kind === 'queued_message_dispatched'), false);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
    // A busy handover is retried without the failure backoff.
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, queuedMessage);
  });
});

for (const replacement of [null, { content: 'edited prompt' }, { content: 'original\n追加内容' }]) {
  test(`input changed during handover is not sent: ${JSON.stringify(replacement)}`, async () => {
    await withIsolatedDatabase(async (userId) => {
      sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: { content: 'original' } });
      const frames = watchBroadcasts();
      let accept!: () => void;
      const runtime = createRuntime([], {
        supportsInputAcceptance: true,
        acceptAfter: new Promise<void>((resolve) => { accept = resolve; }),
      });
      const dispatched = dispatchQueuedMessages(runtime);
      await settle();
      sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessage: replacement });
      accept();
      await dispatched;
      assert.equal(frames.some((frame) => frame.kind === 'queued_message_dispatched'), false);
      assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage ?? null, replacement);
      if (replacement) {
        assert.equal(await dispatchQueuedMessages(runtime), 1);
        assert.equal(frames.filter((frame) => frame.kind === 'queued_message_dispatched').length, 1);
      }
    });
  });
}

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
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, { content: 'keep me', attachments: [] });
    assert.deepEqual(frames, []);

    // A provider that stays unavailable is not retried on every pass.
    assert.equal(await dispatchQueuedMessages(runtime), 0);
  });
});

for (const operation of ['append', 'clear'] as const) {
  test(`atomic ${operation} during engine preparation invalidates only the old snapshot`, async () => {
    await withIsolatedDatabase(async (userId) => {
      const sessionId = `prepared-${operation}`;
      sessionsDb.createAppSession(sessionId, 'claude', '/tmp', 'Prepared');
      const original = { content: 'A', attachments: [] };
      sessionDraftsDb.appendQueuedMessage(userId, sessionId, original);
      let accept!: () => void;
      const runs: RunCall[] = [];
      const frames = watchBroadcasts();
      const runtime = createRuntime(runs, {
        supportsInputAcceptance: true,
        acceptAfter: new Promise<void>((resolve) => { accept = resolve; }),
      });
      const dispatched = dispatchQueuedMessages(runtime);
      await settle();
      assert.equal(runs.length, 1);
      if (operation === 'append') {
        sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content: 'B', attachments: [] });
      } else {
        assert.equal(sessionDraftsDb.clearQueuedMessage(userId, sessionId, original), true);
      }
      accept();
      await dispatched;
      assert.deepEqual(frames, []);
      assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage ?? null,
        operation === 'append' ? { content: 'A\n\nB', attachments: [] } : null);
      if (operation === 'append') {
        await dispatchQueuedMessages(runtime);
        assert.equal(frames.length, 1);
        assert.deepEqual(sessionDraftsDb.getDrafts(userId), []);
      }
    });
  });
}

test('engine input confirmation removes the claimed message while keeping a later append', async () => {
  await withIsolatedDatabase(async (userId) => {
    const sessionId = 'confirmed-append';
    sessionsDb.createAppSession(sessionId, 'claude', '/tmp', 'Confirmed');
    sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content: 'A', attachments: [] });
    const frames = watchBroadcasts();
    await dispatchQueuedMessages(createRuntime([], {
      supportsInputAcceptance: true,
      afterClaim: () => {
        sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content: 'B', attachments: [] });
      },
    }));
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, { content: 'B', attachments: [] });
    assert.deepEqual(frames[0], { kind: 'queued_message_dispatched', sessionId,
      messageFingerprint: createHash('sha256').update(JSON.stringify({ content: 'A', attachments: [] })).digest('hex') });
  });
});

test('dispatch fingerprints the claimed snapshot and leaves a later append for the next turn', async () => {
  await withIsolatedDatabase(async (userId) => {
    const sessionId = 'snapshot-race';
    sessionsDb.createAppSession(sessionId, 'claude', '/tmp', 'Snapshot');
    sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content: 'A', attachments: [] });
    const frames = watchBroadcasts();
    let appended = false;
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, { hasRuntime: () => {
      if (!appended) {
        appended = true;
        sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content: 'B', attachments: [] });
      }
      return true;
    } });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    await settle();
    assert.equal(runs[0]?.command, 'A');
    assert.deepEqual(frames[0], { kind: 'queued_message_dispatched', sessionId,
      messageFingerprint: createHash('sha256').update(JSON.stringify({ content: 'A', attachments: [] })).digest('hex') });
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, { content: 'B', attachments: [] });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    await settle();
    assert.deepEqual(runs.map((run) => run.command), ['A', 'B']);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), []);
  });
});

test('failed startup restores before concurrent appends and refuses slash mixing during reservation', async () => {
  await withIsolatedDatabase(async (userId) => {
    for (const [first, next] of [['A', 'B'], ['/compact', 'B'], ['A', '/compact']]) {
      const sessionId = `failure-${first}-${next}`;
      sessionsDb.createAppSession(sessionId, 'claude', '/tmp', 'Failure');
      sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content: first, attachments: [] });
      let appendResult: unknown;
      const runtime = createRuntime([], { hasRuntime: () => {
        appendResult = sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content: next, attachments: [] });
        return false;
      } });
      await dispatchQueuedMessages(runtime);
      const stored = sessionDraftsDb.getDrafts(userId).find((draft) => draft.scope === sessionId);
      const combinable = !first.startsWith('/') && !next.startsWith('/');
      assert.equal(appendResult !== null, combinable);
      assert.deepEqual(stored?.queuedMessage, { content: combinable ? `${first}\n\n${next}` : first, attachments: [] });
    }
  });
});

test('unexpected exceptions before startup restore the queue instead of losing it', async () => {
  await withIsolatedDatabase(async (userId) => {
    const sessionId = 'throw-before-start';
    sessionsDb.createAppSession(sessionId, 'claude', '/tmp', 'Throw');
    sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content: 'keep', attachments: [] });
    const runtime = createRuntime([], { hasRuntime: () => { throw new Error('probe unavailable'); } });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessage, { content: 'keep', attachments: [] });
  });
});

test('one broken broadcast socket cannot prevent provider submission or other pages receiving the snapshot', async () => {
  await withIsolatedDatabase(async (userId) => {
    const sessionId = 'broken-socket';
    sessionsDb.createAppSession(sessionId, 'claude', '/tmp', 'Socket');
    sessionDraftsDb.appendQueuedMessage(userId, sessionId, { content: 'send', attachments: [] });
    connectedClients.add({ readyState: 1, send: () => { throw new Error('socket closed'); } });
    const frames = watchBroadcasts();
    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    await settle();
    assert.equal(runs[0]?.command, 'send');
    assert.equal(frames[0]?.kind, 'queued_message_dispatched');
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), []);
  });
});
