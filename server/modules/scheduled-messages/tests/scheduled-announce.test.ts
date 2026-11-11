import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scheduledMessagesDb, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchDueScheduledMessages, dispatchQueuedMessages } from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';

const SESSION_ID = 'scheduled-announce-session';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-announce-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('scheduler', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Scheduled session');
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

/** Lets detached runs reach the provider runtime and microtasks settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Captures every gateway frame the dispatcher and the service broadcast. */
function watchBroadcasts(): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  connectedClients.add({
    readyState: 1,
    send: (data: string) => frames.push(JSON.parse(data) as Record<string, unknown>),
  });
  return frames;
}

function scheduledChangeFrames(frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return frames.filter((frame) => frame.kind === 'scheduled_messages_changed');
}

test('scheduling and cancelling a message announce the change', async () => {
  await withIsolatedDatabase(async (userId) => {
    const frames = watchBroadcasts();

    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'run the nightly checks',
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
    });
    const last = scheduledChangeFrames(frames).at(-1);
    assert.equal(last?.kind, 'scheduled_messages_changed');
    assert.equal(last?.sessionId, SESSION_ID);
    assert.equal(typeof last?.timestamp, 'string');

    scheduledMessagesService.cancel(userId, scheduled.id);
    assert.equal(scheduledChangeFrames(frames).length, 2);
    assert.equal(scheduledChangeFrames(frames)[1].sessionId, SESSION_ID);
  });
});

test('the dispatcher announces each claimed session once, however many rows were due', async () => {
  await withIsolatedDatabase(async (userId) => {
    const past = new Date(Date.now() - 60_000).toISOString();
    scheduledMessagesService.schedule({ userId, sessionId: SESSION_ID, content: 'first', scheduledFor: past });
    scheduledMessagesService.schedule({ userId, sessionId: SESSION_ID, content: 'second', scheduledFor: past });

    const frames = watchBroadcasts();
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      run: async () => undefined,
      abort: async () => true,
    } as never;

    await dispatchDueScheduledMessages(runtime);

    // One claim announcement for the session; the follow-up rows are claimed
    // inside the pass without a second announcement per row.
    assert.equal(scheduledChangeFrames(frames).length, 1);
    assert.equal(scheduledChangeFrames(frames)[0].sessionId, SESSION_ID);
  });
});

test('a queued message waits while a scheduled send is in flight, then goes after it', async () => {
  await withIsolatedDatabase(async (userId) => {
    watchBroadcasts();
    const past = new Date(Date.now() - 60_000).toISOString();
    scheduledMessagesService.schedule({ userId, sessionId: SESSION_ID, content: 'scheduled first', scheduledFor: past });
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessage: { content: 'queued behind it', options: {}, attachments: [] },
    });

    let releaseRun: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const runs: RunCall[] = [];
    let firstRunSeen = false;
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      run: async () => {
        runs.push({ provider: 'claude', command: 'turn', options: {} });
        if (!firstRunSeen) {
          firstRunSeen = true;
          // The scheduled turn hangs until released, so its chain — and the
          // session's in-flight mark — stay alive.
          await runStarted;
        }
      },
      abort: async () => true,
    } as never;

    // The scheduled turn starts and hands off to the background drain, which
    // holds the session in flight while its run hangs.
    await dispatchDueScheduledMessages(runtime);
    await settle();
    await settle();
    assert.equal(runs.length, 1, 'the scheduled turn started');

    // Inside the window — the scheduled turn has left the run registry but its
    // chain is still going — a queued turn must not start: the session's next
    // due row would interrupt it.
    await dispatchQueuedMessages(runtime);
    assert.equal(runs.length, 1, 'no queued turn started while the scheduled chain held the session');

    releaseRun?.();
    await runStarted;
    for (let i = 0; i < 40; i += 1) {
      const rowPending = scheduledMessagesDb.listPendingForUser(userId).some((row) => row.session_id === SESSION_ID);
      if (!rowPending && !chatRunRegistry.isProcessing(SESSION_ID)) {
        break;
      }
      await settle();
    }

    await dispatchQueuedMessages(runtime);
    assert.equal(runs.length, 2, 'the queued message went once the scheduled chain settled');
  });
});
