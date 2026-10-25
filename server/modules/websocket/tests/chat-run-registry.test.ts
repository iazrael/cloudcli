import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { clearRunOutcomes, readRunOutcomes } from '@/modules/diagnostics/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * gateway writer forwards so assertions can inspect the outbound protocol.
 */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

test('gateway stamps one epoch across runs and replay declares its complete lower bound', () => {
  chatRunRegistry.clearAll();
  try {
    const run = chatRunRegistry.startRun({ appSessionId: 'epoch-session', provider: 'codex', providerSessionId: null, connection: null, userId: null });
    assert.ok(run);
    run.writer.send({ kind: 'stream_delta', provider: 'codex', content: 'first', streamEpoch: 'provider-forgery' } as any);
    const replay = chatRunRegistry.replayEvents('epoch-session', 0);
    assert.equal(typeof (replay as any).streamEpoch, 'string');
    assert.notEqual((replay as any).streamEpoch, 'provider-forgery');
    assert.equal((replay as any).replayFromSeq, 1);
    assert.equal((replay.events[0] as any).streamEpoch, (replay as any).streamEpoch);
    run.writer.sendComplete({ exitCode: 0 });
    const next = chatRunRegistry.startRun({ appSessionId: 'epoch-session', provider: 'codex', providerSessionId: null, connection: null, userId: null });
    assert.ok(next);
    next.writer.send({ kind: 'stream_delta', provider: 'codex', content: 'next' });
    const nextReplay = chatRunRegistry.replayEvents('epoch-session', 2);
    assert.equal((nextReplay as any).streamEpoch, (replay as any).streamEpoch);
    // The replay buffer belongs to the session, so the previous round's events
    // are still replayable and the lower bound stays at the session's start.
    assert.equal((nextReplay as any).replayFromSeq, 1);
    assert.equal(nextReplay.events[0].seq, 3);
  } finally { chatRunRegistry.clearAll(); }
});

test('an event published outside a run reaches the session and is replayable', () => {
  chatRunRegistry.clearAll();
  try {
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({ appSessionId: 'session-events', provider: 'codex', providerSessionId: null, connection, userId: null });
    assert.ok(run);
    run.writer.send({ kind: 'stream_delta', provider: 'codex', content: 'from the round' });
    chatRunRegistry.publishSessionEvent('session-events', { kind: 'stream_delta', provider: 'codex', content: 'from the engine' } as any);

    const replay = chatRunRegistry.replayEvents('session-events', 0);
    assert.equal(replay.events.length, 2);
    assert.equal(replay.events[0].seq, 1);
    assert.equal(replay.events[1].seq, 2);
    assert.equal(connection.frames.length, 2);
    assert.equal((connection.frames[1] as any).content, 'from the engine');
  } finally { chatRunRegistry.clearAll(); }
});

test('a session event without a run does not make the session look busy', () => {
  chatRunRegistry.clearAll();
  try {
    chatRunRegistry.publishSessionEvent('idle-session', { kind: 'stream_delta', provider: 'codex', content: 'late report' } as any);
    assert.equal(chatRunRegistry.isProcessing('idle-session'), false);
    assert.equal(chatRunRegistry.replayEvents('idle-session', 0).events.length, 1);
  } finally { chatRunRegistry.clearAll(); }
});

test('a published terminal event is dropped, so no round is ended by it', () => {
  chatRunRegistry.clearAll();
  try {
    const run = chatRunRegistry.startRun({ appSessionId: 'published-complete', provider: 'codex', providerSessionId: null, connection: null, userId: null });
    assert.ok(run);
    chatRunRegistry.publishSessionEvent('published-complete', { kind: 'complete', provider: 'codex', exitCode: 0 } as any);
    assert.equal(chatRunRegistry.isProcessing('published-complete'), true);
    assert.equal(chatRunRegistry.replayEvents('published-complete', 0).events.length, 0);
  } finally { chatRunRegistry.clearAll(); }
});

test('replay buffers are bounded by bytes and report a gap even from sequence zero', () => {
  chatRunRegistry.clearAll();
  try {
    const run = chatRunRegistry.startRun({ appSessionId: 'byte-budget', provider: 'codex', providerSessionId: null, connection: null, userId: null });
    assert.ok(run);
    for (let i = 0; i < 100; i += 1) {
      run.writer.send({ kind: 'stream_delta', provider: 'codex', content: `${i}:` + 'x'.repeat(200_000) });
    }
    const replay = chatRunRegistry.replayEvents('byte-budget', 0);
    assert.ok(Buffer.byteLength(JSON.stringify(replay.events)) <= 8 * 1024 * 1024);
    assert.equal(replay.stale, true);
    assert.equal(replay.lastSeq, 100);
    assert.equal(chatRunRegistry.replayEvents('byte-budget', 99).stale, false);
  } finally { chatRunRegistry.clearAll(); }
});

test('a single oversized event is not retained and cannot hide a replay gap', () => {
  chatRunRegistry.clearAll();
  try {
    const run = chatRunRegistry.startRun({ appSessionId: 'single-budget', provider: 'codex', providerSessionId: null, connection: null, userId: null });
    assert.ok(run);
    run.writer.send({ id: 'large-tool', kind: 'tool_use', provider: 'codex', toolInput: Array.from({ length: 300 }, () => 'x'.repeat(8_000)) });
    assert.equal(run.events.length, 0);
    run.writer.send({ kind: 'stream_end', provider: 'codex' });
    assert.equal(chatRunRegistry.replayEvents('single-budget', 0).stale, true);
    assert.equal(chatRunRegistry.replayEvents('single-budget', 1).stale, false);
  } finally { chatRunRegistry.clearAll(); }
});

test('many sessions share one process-wide replay byte budget', () => {
  chatRunRegistry.clearAll();
  try {
    const runs = Array.from({ length: 10 }, (_, index) => chatRunRegistry.startRun({ appSessionId: `global-budget-${index}`, provider: 'codex', providerSessionId: null, connection: null, userId: null }));
    for (const run of runs) {
      assert.ok(run);
      for (let i = 0; i < 25; i += 1) run.writer.send({ kind: 'stream_delta', provider: 'codex', content: 'x'.repeat(200_000) });
    }
    const bytes = runs.reduce((sum, run) => sum + (run?.bufferedBytes ?? 0), 0);
    assert.ok(bytes <= 32 * 1024 * 1024);
    assert.equal(chatRunRegistry.replayEvents('global-budget-0', 0).stale, true);
    assert.equal(chatRunRegistry.replayEvents('global-budget-9', 0).stale, false);
  } finally { chatRunRegistry.clearAll(); }
});

test('an expired run still reports missing events using its session watermark', (context) => {
  chatRunRegistry.clearAll();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const run = chatRunRegistry.startRun({ appSessionId: 'expired-budget', provider: 'codex', providerSessionId: null, connection: null, userId: null });
    assert.ok(run);
    run.writer.send({ id: 'large-tool', kind: 'tool_use', provider: 'codex', toolInput: Array.from({ length: 300 }, () => 'x'.repeat(8_000)) });
    run.writer.sendComplete({ exitCode: 0 });
    context.mock.timers.tick(5 * 60 * 1000 + 1);
    assert.equal(chatRunRegistry.getRun('expired-budget'), undefined);
    assert.equal(chatRunRegistry.replayEvents('expired-budget', 0).stale, true);
    assert.equal(chatRunRegistry.replayEvents('expired-budget', 2).stale, false);
  } finally { context.mock.timers.reset(); chatRunRegistry.clearAll(); }
});

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-registry-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
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

test('live events are remapped to the app session id and sequenced', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-1',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: 'user-1',
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'provider-id-9', content: 'hello' });
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'provider-id-9', content: 'hello world' });

    assert.equal(connection.frames.length, 2);
    assert.equal(connection.frames[0]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[0]?.seq, 1);
    assert.equal(connection.frames[1]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[1]?.seq, 2);
  });
});

test('session_created is swallowed and persisted as the provider-id mapping', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-run-2', 'cursor', '/workspace/demo');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-2',
      provider: 'cursor',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'cursor',
      sessionId: 'cursor-native-7',
      newSessionId: 'cursor-native-7',
    });

    // The upsert is broadcast without blocking the run: resolving the owning
    // project's display name is async, so let that settle before asserting.
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // The provider-native event itself is never forwarded...
    const sessionUpserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.equal(sessionUpserts.length, 1);
    assert.equal(sessionUpserts[0]?.sessionId, 'app-run-2');
    assert.equal(sessionUpserts[0]?.providerSessionId, 'cursor-native-7');
    // ...but the canonical mapping is recorded and persisted in the database.
    assert.equal(run.providerSessionId, 'cursor-native-7');
    assert.equal(sessionsDb.getSessionById('app-run-2')?.provider_session_id, 'cursor-native-7');
  });
});

/**
 * Seeds an app session that already runs on one provider session and
 * transcript, the state a Claude session is in before its first prompt is
 * edited.
 */
function seedClaudeSession(appSessionId: string, providerSessionId: string, jsonlPath: string): void {
  sessionsDb.createAppSession(appSessionId, 'claude', '/workspace/demo', 'Edited session');
  sessionsDb.assignProviderSessionId(appSessionId, providerSessionId);
  sessionsDb.createSession(
    providerSessionId,
    'claude',
    '/workspace/demo',
    'Edited session',
    undefined,
    undefined,
    jsonlPath,
  );
}

test('a replacement provider session moves the row onto the new transcript', async () => {
  await withIsolatedDatabase(async () => {
    seedClaudeSession('app-replace-1', 'native-old-1', '/transcripts/native-old-1.jsonl');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-replace-1',
      provider: 'claude',
      providerSessionId: 'native-old-1',
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.setSessionId('native-new-1', {
      transcriptPath: '/transcripts/native-new-1.jsonl',
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    assert.equal(run.providerSessionId, 'native-new-1');
    const row = sessionsDb.getSessionById('app-replace-1');
    assert.equal(row?.provider_session_id, 'native-new-1');
    // The whole point of the replacement descriptor: `jsonl_path` moves too,
    // so history reads the new conversation instead of the superseded one.
    assert.equal(row?.jsonl_path, '/transcripts/native-new-1.jsonl');
    // The transcript left behind must not come back as its own session.
    assert.equal(sessionsDb.isProviderSessionSuperseded('native-old-1', 'claude'), true);
  });
});

test('a replacement merges the row the watcher already indexed for the new transcript', async () => {
  await withIsolatedDatabase(async () => {
    seedClaudeSession('app-replace-2', 'native-old-2', '/transcripts/native-old-2.jsonl');
    // The filesystem watcher can index the new transcript before the runtime
    // announces its id to the gateway: a second row keyed by that id.
    sessionsDb.createSession(
      'native-new-2',
      'claude',
      '/workspace/demo',
      'Watcher name',
      undefined,
      undefined,
      '/transcripts/native-new-2.jsonl',
    );
    assert.equal(sessionsDb.getAllSessions().length, 2);

    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-replace-2',
      provider: 'claude',
      providerSessionId: 'native-old-2',
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.setSessionId('native-new-2', {
      transcriptPath: '/transcripts/native-new-2.jsonl',
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    const rows = sessionsDb.getAllSessions();
    assert.equal(rows.length, 1, 'the watcher duplicate is merged into the app row');
    assert.equal(rows[0]?.session_id, 'app-replace-2');
    assert.equal(rows[0]?.provider_session_id, 'native-new-2');
    assert.equal(rows[0]?.jsonl_path, '/transcripts/native-new-2.jsonl');
    assert.equal(sessionsDb.isProviderSessionSuperseded('native-old-2', 'claude'), true);

    // A later watcher pass resolves the transcript through the mapping and
    // updates the app row instead of creating the duplicate again.
    sessionsDb.createSession(
      'native-new-2',
      'claude',
      '/workspace/demo',
      'Watcher name',
      undefined,
      undefined,
      '/transcripts/native-new-2.jsonl',
    );
    assert.equal(sessionsDb.getAllSessions().length, 1);
  });
});

test('complete marks the run finished and duplicate completes are dropped', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-3', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-3',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 0 });
    // Late duplicate from a killed runtime's exit handler.
    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 1 });

    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.actualSessionId, 'app-run-3');
    assert.equal(chatRunRegistry.isProcessing('app-run-3'), false);

    // completeRun is also a no-op once the run already completed.
    chatRunRegistry.completeRun('app-run-3', { exitCode: 1, reason: 'client_abort' });
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
  });
});

test('a finished run\'s safety net cannot complete the session\'s next run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-9', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const firstRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(firstRun);
    firstRun.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-9', exitCode: 0 });

    // A queued message starts the next run before the first run's runtime
    // promise settles (the chat handler's `finally` hasn't executed yet).
    const secondRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(secondRun);

    // First run's safety net fires late: it must not touch the new run.
    chatRunRegistry.completeRunIfCurrent(firstRun, { exitCode: 1, reason: 'dispatch_failed' });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), true);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);

    // The second run's own safety net still works while it is current.
    chatRunRegistry.completeRunIfCurrent(secondRun, { exitCode: 1, reason: 'dispatch_failed' });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), false);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 2);
  });
});

test('listRunningRuns returns only currently running app sessions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-7', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-run-8', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const completedRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-7',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(completedRun);

    const runningRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-8',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(runningRun);

    chatRunRegistry.completeRun('app-run-7', { exitCode: 0, reason: 'engine_completed' });

    const runningSessions = chatRunRegistry.listRunningRuns();
    assert.deepEqual(runningSessions.map((session) => session.sessionId), ['app-run-8']);
    assert.equal(runningSessions[0]?.provider, 'codex');
  });
});

test('replayEvents returns only events after the requested seq', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-4',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'c' });

    const replayed = chatRunRegistry.replayEvents('app-run-4', 1);
    assert.deepEqual(replayed.events.map((event) => event.content), ['b', 'c']);
    assert.deepEqual(replayed.events.map((event) => event.seq), [2, 3]);
    assert.equal(replayed.lastSeq, 3);
    assert.equal(replayed.stale, false);
  });
});

test('seq continues across runs so a client lastSeq stays comparable', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-10', 'claude', '/workspace/demo');
    const connection = new FakeConnection();

    const firstRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-10',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(firstRun);
    firstRun.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    firstRun.writer.send({ kind: 'text', provider: 'claude', sessionId: 'x', content: 'done' });
    firstRun.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-10', exitCode: 0 });

    // The next run for the same session continues the session watermark
    // instead of restarting at 1 — otherwise a reconnecting client that kept
    // run one's lastSeq would silently drop all of run two's replay.
    const secondRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-10',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(secondRun);
    secondRun.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });
    secondRun.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-10', exitCode: 0 });

    const sequenced = connection.frames.filter((frame) => typeof frame.seq === 'number');
    assert.deepEqual(sequenced.map((frame) => frame.seq), [1, 2, 3, 4, 5]);

    // A client that saw everything up to run one (lastSeq 3) gets exactly
    // run two's events replayed, including its terminal complete.
    const replay = chatRunRegistry.replayEvents('app-run-10', 3);
    assert.deepEqual(replay.events.map((event) => event.seq), [4, 5]);
    assert.equal(replay.events[0]?.content, 'b');
    assert.equal(replay.lastSeq, 5);
    assert.equal(replay.stale, false);
  });
});

test('replay reports stale when the client lastSeq predates the buffer window', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-11', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-11',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });

    // Client saw seq 1 and the buffer starts at seq 2: contiguous, so replay
    // bridges the reconnect without help.
    const bridging = chatRunRegistry.replayEvents('app-run-11', 1);
    assert.equal(bridging.stale, false);

    // Simulate cap/retention truncation (buffer now starts at seq 5): the
    // gap is unbridgeable and the client must be told to refresh over REST.
    run.events.splice(0, run.events.length, { ...run.events[1], seq: 5 });
    const stale = chatRunRegistry.replayEvents('app-run-11', 1);
    assert.deepEqual(stale.events.map((event) => event.seq), [5]);
    assert.equal(stale.stale, true);
    // The watermark is owned by the session, not the buffer contents.
    assert.equal(stale.lastSeq, 2);
  });
});

test('attachConnection adds a socket without cutting off the ones already watching', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5', 'opencode', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5',
      provider: 'opencode',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'before' });

    // A second tab on the same session subscribes mid-run.
    const secondConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5', secondConnection), true);
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });

    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['before', 'after']);
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), ['after']);
  });
});

test('a refreshed tab stops receiving once its old socket is closed', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5b', 'opencode', '/workspace/demo');
    const staleConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5b',
      provider: 'opencode',
      providerSessionId: null,
      connection: staleConnection,
      userId: null,
    });
    assert.ok(run);

    // The page reloads: the original socket closes and the fresh one subscribes.
    staleConnection.readyState = 3;
    const reloadedConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5b', reloadedConnection), true);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'later' });

    assert.deepEqual(staleConnection.frames, []);
    assert.deepEqual(reloadedConnection.frames.map((frame) => frame.content), ['after', 'later']);
  });
});

test('startRun rejects a second concurrent run for the same session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'opencode', '/workspace/demo');
    const connection = new FakeConnection();
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(first);

    const second = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.equal(second, null);

    // After the run finishes a new one is allowed again.
    chatRunRegistry.completeRun('app-run-6', { exitCode: 0, reason: 'engine_completed' });
    const third = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(third);
  });
});


/**
 * Every engine ends its runs through the same registry branch, so the reason
 * a run stopped must be recorded identically for all of them. Pinning all four
 * engines in use keeps a provider-specific regression from hiding behind the
 * one engine a bug report happened to mention.
 */
for (const provider of ['claude', 'codex', 'antigravity', 'zcode'] as const) {
  test(`${provider}: an engine's own clean completion is recorded as engine_completed`, async () => {
    await withIsolatedDatabase(() => {
      clearRunOutcomes();
      sessionsDb.createAppSession(`outcome-ok-${provider}`, provider, '/workspace/demo');
      const run = chatRunRegistry.startRun({
        appSessionId: `outcome-ok-${provider}`,
        provider,
        providerSessionId: null,
        connection: new FakeConnection(),
        userId: null,
      });
      assert.ok(run);

      run.writer.send({ kind: 'complete', provider, sessionId: 'native', exitCode: 0 });

      const [recorded] = readRunOutcomes();
      assert.equal(recorded?.sessionId, `outcome-ok-${provider}`);
      assert.equal(recorded?.provider, provider);
      assert.equal(recorded?.reason, 'engine_completed');
    });
  });

  test(`${provider}: an engine that ends non-zero is recorded as engine_failed`, async () => {
    await withIsolatedDatabase(() => {
      clearRunOutcomes();
      sessionsDb.createAppSession(`outcome-fail-${provider}`, provider, '/workspace/demo');
      const run = chatRunRegistry.startRun({
        appSessionId: `outcome-fail-${provider}`,
        provider,
        providerSessionId: null,
        connection: new FakeConnection(),
        userId: null,
      });
      assert.ok(run);

      run.writer.send({ kind: 'complete', provider, sessionId: 'native', exitCode: 1 });

      assert.equal(readRunOutcomes()[0]?.reason, 'engine_failed');
    });
  });

  test(`${provider}: a client abort outranks the exit code the abort produced`, async () => {
    await withIsolatedDatabase(() => {
      clearRunOutcomes();
      sessionsDb.createAppSession(`outcome-abort-${provider}`, provider, '/workspace/demo');
      const run = chatRunRegistry.startRun({
        appSessionId: `outcome-abort-${provider}`,
        provider,
        providerSessionId: null,
        connection: new FakeConnection(),
        userId: null,
      });
      assert.ok(run);

      chatRunRegistry.completeRun(`outcome-abort-${provider}`, {
        exitCode: 0,
        aborted: true,
        reason: 'client_abort',
      });

      const [recorded] = readRunOutcomes();
      assert.equal(recorded?.reason, 'client_abort');
      assert.equal(recorded?.exitCode, 0);
    });
  });
}

test('an adopted engine run attaches the sockets already watching the session', async () => {
  await withIsolatedDatabase(() => {
    clearRunOutcomes();
    sessionsDb.createAppSession('app-adopt', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-adopt', 'ses_engine_1');

    const watcher = new FakeConnection();
    const forgotten = new FakeConnection();
    const deadWatcher = new FakeConnection();
    deadWatcher.readyState = 3; // CLOSED
    chatRunRegistry.noteSessionSubscriber('app-adopt', watcher as never);
    chatRunRegistry.noteSessionSubscriber('app-adopt', forgotten as never);
    chatRunRegistry.noteSessionSubscriber('app-adopt', deadWatcher as never);
    chatRunRegistry.forgetSessionSubscriber(forgotten as never);

    const adopted = chatRunRegistry.adoptExternalRun({ provider: 'opencode', providerSessionId: 'ses_engine_1' });
    assert.ok(adopted);
    assert.equal(adopted.appSessionId, 'app-adopt');
    assert.equal(chatRunRegistry.isProcessing('app-adopt'), true);

    adopted.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'ses_engine_1', content: 'live' });
    assert.equal(watcher.frames.length, 1);
    assert.equal(watcher.frames[0]?.sessionId, 'app-adopt');
    assert.equal(watcher.frames[0]?.seq, 1);
    assert.equal(forgotten.frames.length, 0, 'a forgotten socket is not attached');
    assert.equal(deadWatcher.frames.length, 0, 'a closed socket is pruned, not attached');

    adopted.writer.send({ kind: 'complete', provider: 'opencode', sessionId: 'ses_engine_1', exitCode: 0 });
    assert.equal(chatRunRegistry.isProcessing('app-adopt'), false);
    const [recorded] = readRunOutcomes();
    assert.equal(recorded?.sessionId, 'app-adopt');
    assert.equal(recorded?.reason, 'engine_completed');
  });
});

test('adoption refuses unknown, mismatched, archived and busy sessions', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(
      chatRunRegistry.adoptExternalRun({ provider: 'opencode', providerSessionId: 'ses_unknown' }),
      null,
      'a provider session with no app row is not adoptable',
    );

    sessionsDb.createAppSession('app-open', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-open', 'ses_engine_2');
    assert.equal(
      chatRunRegistry.adoptExternalRun({ provider: 'claude', providerSessionId: 'ses_engine_2' }),
      null,
      'a provider disagreement is not adoptable',
    );

    const active = chatRunRegistry.startRun({
      appSessionId: 'app-open',
      provider: 'opencode',
      providerSessionId: 'ses_engine_2',
      connection: null,
      userId: null,
    });
    assert.ok(active);
    assert.equal(
      chatRunRegistry.adoptExternalRun({ provider: 'opencode', providerSessionId: 'ses_engine_2' }),
      null,
      'a session with a run in flight is not adoptable',
    );

    sessionsDb.archiveSessionsByIds(sessionsDb.listSessionsOlderThanCutoff('2999-01-01T00:00:00Z'));
    sessionsDb.createAppSession('app-archived', 'opencode', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-archived', 'ses_engine_3');
    sessionsDb.archiveSessionsByIds(sessionsDb.listSessionsOlderThanCutoff('2999-01-01T00:00:00Z'));
    assert.equal(
      chatRunRegistry.adoptExternalRun({ provider: 'opencode', providerSessionId: 'ses_engine_3' }),
      null,
      'an archived session is not adoptable',
    );
  });
});
