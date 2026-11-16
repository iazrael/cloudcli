import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * A session's turn ends while its agents, workflow or backgrounded command are
 * still going. The run registry marks the run completed at the turn's
 * `complete`, but the runtime keeps producing events through that run's
 * writer — task progress, and the turn the CLI pushes when the task reports.
 * A tab opened during that work has to attach to the run to see them, and the
 * run has to still be there to attach to.
 */

const SESSION_ID = 'held-session';
const FIVE_MINUTES = 5 * 60 * 1000;

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
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-background-subscribe-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    chatRunRegistry.setRetentionGuard(() => false);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Starts a run for the session and ends its turn, leaving the run completed but registered. */
function startAndCompleteRun(connection: ReturnType<typeof createFakeSocket>) {
  const run = chatRunRegistry.startRun({
    appSessionId: SESSION_ID,
    provider: 'claude',
    providerSessionId: 'native-1',
    connection: connection as never,
    userId: 1,
  });
  assert.ok(run);
  run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-1', exitCode: 0 });
  assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  return run;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('a tab that subscribes during background work receives the run\'s later events', async () => {
  await withIsolatedDatabase(async () => {
    const run = startAndCompleteRun(createFakeSocket());

    const newTab = createFakeSocket();
    handleChatConnection(
      newTab as never,
      { user: { id: 1 } } as never,
      { runtime: {
        hasBackgroundWork: (sessionId: string) => sessionId === SESSION_ID,
        isBackgroundWorkPending: (sessionId: string) => sessionId === SESSION_ID,
        getPendingApprovalsForSession: () => [],
      } as never },
    );
    newTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0, replayScope: 'current_run' }] }));
    await settle();

    // Not processing — the composer stays usable — but attached.
    assert.equal(newTab.frames[0]?.kind, 'chat_subscribed');
    assert.equal(newTab.frames[0]?.isProcessing, false);
    assert.equal(newTab.frames[0]?.backgroundWorkPending, true);
    assert.equal(typeof newTab.frames[0]?.streamEpoch, 'string');
    assert.equal(newTab.frames[0]?.replayFromSeq, 2);
    assert.equal(newTab.frames[0]?.stale, true);

    run.writer.send({ kind: 'task_status', provider: 'claude', sessionId: 'native-1', event: 'notification', taskId: 't1', status: 'completed' } as never);
    assert.ok(
      newTab.frames.some((frame) => frame.kind === 'task_status'),
      'the task event must reach the tab that subscribed after the turn ended',
    );
  });
});

test('a tab that subscribes to an idle session is not attached to its old run', async () => {
  await withIsolatedDatabase(async () => {
    const run = startAndCompleteRun(createFakeSocket());

    const newTab = createFakeSocket();
    handleChatConnection(
      newTab as never,
      { user: { id: 1 } } as never,
      { runtime: { hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [] } as never },
    );
    newTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();

    run.writer.send({ kind: 'task_status', provider: 'claude', sessionId: 'native-1', event: 'notification', taskId: 't1', status: 'completed' } as never);
    assert.ok(!newTab.frames.some((frame) => frame.kind === 'task_status'));
  });
});

test('a completed run stays registered while its session still has background work', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withIsolatedDatabase(async () => {
      let working = true;
      chatRunRegistry.setRetentionGuard((sessionId) => sessionId === SESSION_ID && working);
      startAndCompleteRun(createFakeSocket());

      mock.timers.tick(FIVE_MINUTES);
      assert.ok(chatRunRegistry.getRun(SESSION_ID), 'the run must outlive the retention window while work is outstanding');

      working = false;
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined, 'once the work is gone the run is evicted as before');
    });
  } finally {
    mock.timers.reset();
  }
});

test('a retained run\'s eviction timer cannot evict the session\'s next run early', async () => {
  // Run one completes with work outstanding and is re-armed at five minutes;
  // run two takes the slot and completes with two minutes of retention to
  // go. Run one's timer firing on the slot alone would evict run two.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await withIsolatedDatabase(async () => {
      let working = true;
      chatRunRegistry.setRetentionGuard((sessionId) => sessionId === SESSION_ID && working);
      const first = startAndCompleteRun(createFakeSocket());
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), first);

      working = false;
      mock.timers.tick(FIVE_MINUTES - 2 * 60 * 1000);
      const second = startAndCompleteRun(createFakeSocket());
      assert.equal(chatRunRegistry.getRun(SESSION_ID), second);

      // Run one's re-armed timer fires now; run two's has two minutes left.
      mock.timers.tick(2 * 60 * 1000);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), second, 'run two keeps its own retention window');
      mock.timers.tick(FIVE_MINUTES);
      assert.equal(chatRunRegistry.getRun(SESSION_ID), undefined);
    });
  } finally {
    mock.timers.reset();
  }
});

test('background work without a tracked reply phase does not mark the subscriber pending', async () => {
  await withIsolatedDatabase(async () => {
    startAndCompleteRun(createFakeSocket());
    const newTab = createFakeSocket();
    handleChatConnection(
      newTab as never,
      { user: { id: 1 } } as never,
      { runtime: {
        hasBackgroundWork: () => true,
        isBackgroundWorkPending: () => false,
        getPendingApprovalsForSession: () => [],
      } as never },
    );
    newTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();

    // A provider that never broadcasts `background_tasks` could not clear it again.
    assert.equal(newTab.frames[0]?.kind, 'chat_subscribed');
    assert.equal(newTab.frames[0]?.backgroundWorkPending, false);
  });
});

test('the subscribe ack says whether the session\'s background work can still be stopped', async () => {
  await withIsolatedDatabase(async () => {
    startAndCompleteRun(createFakeSocket());
    const newTab = createFakeSocket();
    handleChatConnection(
      newTab as never,
      { user: { id: 1 } } as never,
      { runtime: {
        hasBackgroundWork: () => true,
        isBackgroundWorkPending: () => false,
        getPendingApprovalsForSession: () => [],
        getBackgroundTasksForSession: () => [{ id: 'call_agent', toolName: 'Agent', startedAt: 1 }],
        canInterruptBackgroundWork: (sessionId: string) => sessionId !== SESSION_ID,
        backgroundWorkQueuesInput: (provider: string) => provider !== 'claude',
      } as never },
    );
    newTab.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }] }));
    await settle();

    assert.equal(newTab.frames[0]?.kind, 'chat_subscribed');
    assert.equal(newTab.frames[0]?.backgroundCanInterrupt, false);
    // The session row is a Claude session, whose next turn joins its held process.
    assert.equal(newTab.frames[0]?.backgroundWorkQueuesInput, false);
  });
});

test('subscribe validates replay metadata and a previous epoch cannot suppress current events', async () => {
  await withIsolatedDatabase(async () => {
    const run = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: 'native-1', connection: null, userId: 1 });
    assert.ok(run);
    run.writer.send({ kind: 'stream_delta', provider: 'claude', content: 'new output' });
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: {
      hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [], isBackgroundWorkPending: () => false,
    } as never });
    for (const cursor of [{ lastSeq: -1 }, { lastSeq: 0.5 }, { lastSeq: '1' }, { streamEpoch: '' }, { streamEpoch: 1 }]) {
      socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, ...cursor }] }));
      await settle();
      assert.equal(socket.frames.pop()?.kind, 'protocol_error');
    }
    socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq: 999, streamEpoch: 'previous-gateway' }] }));
    await settle();
    assert.equal(socket.frames[0]?.kind, 'chat_subscribed');
    assert.equal(socket.frames[0]?.stale, true);
    assert.equal(socket.frames[0]?.lastSeq, 1);
    assert.equal(socket.frames[1]?.seq, 1);
    assert.equal(socket.frames[1]?.streamEpoch, socket.frames[0]?.streamEpoch);
  });
});

test('a fresh tab replays only the active turn while a reconnect catches up across turns', async () => {
  await withIsolatedDatabase(async () => {
    const previous = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'antigravity', providerSessionId: 'native-1', connection: null, userId: 1 });
    assert.ok(previous);
    previous.writer.send({ kind: 'stream_delta', provider: 'antigravity', content: 'old proposal' });
    previous.writer.send({ kind: 'error', provider: 'antigravity', content: 'interrupted' });
    previous.writer.send({ kind: 'complete', provider: 'antigravity', exitCode: 0 });
    const boundary = previous.lastSeq;
    const current = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'antigravity', providerSessionId: 'native-1', connection: null, userId: 1 });
    assert.ok(current);
    current.writer.send({ kind: 'stream_delta', provider: 'antigravity', content: 'generating images' });

    const subscribe = async (cursor: Record<string, unknown>) => {
      const socket = createFakeSocket();
      handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: {
        hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [], isBackgroundWorkPending: () => false,
      } as never });
      socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, ...cursor }] }));
      await settle();
      return socket.frames;
    };

    const fresh = await subscribe({ lastSeq: 0, replayScope: 'current_run' });
    assert.equal(fresh[0]?.replayAfterSeq, boundary);
    assert.equal(fresh[0]?.stale, false);
    assert.deepEqual(fresh.slice(1).map((frame) => frame.content), ['generating images']);
    assert.equal(fresh[1]?.seq, boundary + 1);

    const legacy = await subscribe({ lastSeq: 0 });
    assert.equal(legacy[0]?.replayAfterSeq, undefined);
    assert.deepEqual(legacy.slice(1).map((frame) => frame.kind), ['stream_delta', 'error', 'complete', 'stream_delta']);

    const reconnect = await subscribe({ lastSeq: 1, streamEpoch: fresh[0]?.streamEpoch, replayScope: 'current_run' });
    assert.equal(reconnect[0]?.replayAfterSeq, undefined);
    assert.deepEqual(reconnect.slice(1).map((frame) => frame.kind), ['error', 'complete', 'stream_delta']);
  });
});
