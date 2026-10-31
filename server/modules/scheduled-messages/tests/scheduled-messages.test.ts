import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scheduledMessagesDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchDueScheduledMessages } from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

const SESSION_ID = 'scheduled-session';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-messages-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('scheduler', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Scheduled session');
    await runTest(Number(user.id));
  } finally {
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

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

function createRuntime(
  runs: RunCall[],
  behaviour: 'ok' | 'throw' = 'ok',
  aborts: string[] = [],
) {
  return {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      if (behaviour === 'throw') {
        throw new Error('provider exploded');
      }
      runs.push({ provider, command, options });
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
  } as never;
}

test('a message due in the past is sent on the next pass, not skipped', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The server was down when this came due.
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'run the nightly checks',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const sent = await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(sent, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'run the nightly checks');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a due message interrupts a run in progress instead of failing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'the schedule wins',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    const aborts: string[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs, 'ok', aborts)), 1);

    assert.deepEqual(aborts, [SESSION_ID]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'the schedule wins');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a message that is not due yet is left alone', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'later',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('a due message is claimed once, so overlapping passes cannot double-send it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'only once',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await Promise.all([
      dispatchDueScheduledMessages(runtime),
      dispatchDueScheduledMessages(runtime),
    ]);

    assert.equal(runs.length, 1);
  });
});

test('the composer settings it was scheduled with travel with it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'with options',
      options: { model: 'claude-opus-5', permissionMode: 'plan' },
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.equal(runs[0].options.permissionMode, 'plan');
  });
});

test('a provider failure is recorded on the message instead of vanishing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    await dispatchDueScheduledMessages(createRuntime([], 'throw'));

    const row = scheduledMessagesDb.listForSession(userId, SESSION_ID)[0];
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason ?? '', /provider exploded/);
  });
});

test('a deferred turn keeps the scheduled message pending instead of failing it', async () => {
  await withIsolatedDatabase(async (userId) => {
    // Claude with live background work refuses to take the input rather than
    // kill the work. Nothing was sent, so the message must stay deliverable —
    // the same treatment queued messages get — instead of being recorded as
    // failed and never retried.
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'fires while background work runs',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const deferred = {
      hasRuntime: () => true,
      hasBackgroundWork: () => true,
      // The deferred rejection only surfaces for runtimes that declare input
      // acceptance — the deferred throw is exactly that path's refusal.
      supportsInputAcceptance: () => true,
      run: async () => {
        throw new AppError('Background work is still running.', { code: 'PROVIDER_INPUT_DEFERRED', statusCode: 409 });
      },
      abort: async () => true,
    } as never;
    await dispatchDueScheduledMessages(deferred);

    const row = scheduledMessagesDb.listForSession(userId, SESSION_ID)[0];
    assert.equal(row.status, 'pending');
    assert.equal(row.failure_reason, null);

    // The background work eventually ends; the next pass delivers.
    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 1);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
    assert.equal(runs.length, 1);
  });
});

test('a cancelled message never fires', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'never mind',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    scheduledMessagesService.cancel(userId, scheduled.id);

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
  });
});

test('a failed message can be dismissed, and stays dismissed', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([], 'throw'));
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'failed');

    scheduledMessagesService.cancel(userId, scheduled.id);

    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'cancelled');
  });
});

test('cancelling something that already fired is refused', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'gone',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([]));

    assert.throws(
      () => scheduledMessagesService.cancel(userId, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
  });
});

test('one user cannot cancel another user\'s scheduled message', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'mine',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    assert.throws(
      () => scheduledMessagesService.cancel(userId + 1, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('scheduling validates its input', async () => {
  await withIsolatedDatabase(async (userId) => {
    const base = { userId, sessionId: SESSION_ID, scheduledFor: new Date(Date.now() + 1000).toISOString() };

    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: '   ' }),
      (error: Error & { code?: string }) => error.code === 'CONTENT_REQUIRED',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: 'hi', scheduledFor: 'not a date' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULE_TIME',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({
        ...base,
        content: 'hi',
        scheduledFor: new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString(),
      }),
      (error: Error & { code?: string }) => error.code === 'SCHEDULE_TOO_FAR_AHEAD',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, sessionId: 'nope', content: 'hi' }),
      (error: Error & { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
  });
});

test('due messages across multiple sessions and projects start concurrently without waiting for a long turn to finish', async () => {
  await withIsolatedDatabase(async (userId) => {
    const sessionB = 'scheduled-session-project-b';
    const sessionC = 'scheduled-session-project-c';
    sessionsDb.createAppSession(sessionB, 'claude', '/tmp/project-b', 'Project B session');
    sessionsDb.createAppSession(sessionC, 'claude', '/tmp/project-c', 'Project C session');

    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'long task in project a',
      scheduledFor: new Date(Date.now() - 3_000).toISOString(),
    });
    scheduledMessagesService.schedule({
      userId,
      sessionId: sessionB,
      content: 'task in project b',
      scheduledFor: new Date(Date.now() - 2_000).toISOString(),
    });
    scheduledMessagesService.schedule({
      userId,
      sessionId: sessionC,
      content: 'task in project c',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    let finishFirstTurn!: () => void;
    const firstTurnBlocked = new Promise<void>((resolve) => {
      finishFirstTurn = resolve;
    });

    const runs: RunCall[] = [];
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      run: async (provider: string, command: string, options: Record<string, unknown>) => {
        runs.push({ provider, command, options });
        if (command === 'long task in project a') {
          await firstTurnBlocked;
        }
      },
      abort: async () => true,
    } as never;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const sent = await Promise.race([
        dispatchDueScheduledMessages(runtime),
        new Promise<number>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('dispatchDueScheduledMessages hung waiting for long turn')),
            500,
          );
        }),
      ]);

      assert.equal(sent, 3);
      assert.deepEqual(
        runs.map((run) => run.command),
        ['long task in project a', 'task in project b', 'task in project c'],
      );
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      finishFirstTurn();
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
});

test('a subsequent poll pass dispatches newly due messages for other sessions while an earlier session turn is still running', async () => {
  await withIsolatedDatabase(async (userId) => {
    const sessionB = 'scheduled-session-next-poll';
    sessionsDb.createAppSession(sessionB, 'claude', '/tmp/project-b', 'Project B session');

    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'first poll long turn',
      scheduledFor: new Date(Date.now() - 2_000).toISOString(),
    });

    let finishFirstTurn!: () => void;
    const firstTurnBlocked = new Promise<void>((resolve) => {
      finishFirstTurn = resolve;
    });

    const runs: RunCall[] = [];
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      run: async (provider: string, command: string, options: Record<string, unknown>) => {
        runs.push({ provider, command, options });
        if (command === 'first poll long turn') {
          await firstTurnBlocked;
        }
      },
      abort: async () => true,
    } as never;

    try {
      assert.equal(await dispatchDueScheduledMessages(runtime), 1);
      assert.equal(runs.length, 1);
      assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);

      scheduledMessagesService.schedule({
        userId,
        sessionId: sessionB,
        content: 'second poll other project',
        scheduledFor: new Date(Date.now() - 1_000).toISOString(),
      });

      assert.equal(await dispatchDueScheduledMessages(runtime), 1);
      assert.deepEqual(
        runs.map((run) => run.command),
        ['first poll long turn', 'second poll other project'],
      );
    } finally {
      finishFirstTurn();
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
});

test('multiple due messages for the same session run sequentially without aborting each other or marking queued-behind messages as sent early', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'step 1',
      scheduledFor: new Date(Date.now() - 2_000).toISOString(),
    });
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'step 2',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    let finishStep1!: () => void;
    const step1Blocked = new Promise<void>((resolve) => {
      finishStep1 = resolve;
    });

    const runs: RunCall[] = [];
    const aborts: string[] = [];
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      run: async (provider: string, command: string, options: Record<string, unknown>) => {
        runs.push({ provider, command, options });
        if (command === 'step 1') {
          await step1Blocked;
        }
      },
      abort: async (_provider: string, sessionId: string) => {
        aborts.push(sessionId);
        return true;
      },
    } as never;

    try {
      assert.equal(await dispatchDueScheduledMessages(runtime), 1);
      assert.deepEqual(runs.map((run) => run.command), ['step 1']);
      assert.deepEqual(aborts, []);

      const rowsDuringStep1 = scheduledMessagesDb.listForSession(userId, SESSION_ID);
      assert.equal(rowsDuringStep1[0].status, 'sent');
      assert.equal(rowsDuringStep1[1].status, 'pending');

      // An overlapping pass while step 1 is still running must not claim step 2 early or abort step 1.
      assert.equal(await dispatchDueScheduledMessages(runtime), 0);
      assert.deepEqual(runs.map((run) => run.command), ['step 1']);
      assert.deepEqual(aborts, []);
    } finally {
      finishStep1();
    }

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(runs.map((run) => run.command), ['step 1', 'step 2']);
    assert.deepEqual(aborts, []);
    const rowsAfterBoth = scheduledMessagesDb.listForSession(userId, SESSION_ID);
    assert.equal(rowsAfterBoth[0].status, 'sent');
    assert.equal(rowsAfterBoth[1].status, 'sent');
  });
});

