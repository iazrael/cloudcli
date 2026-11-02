import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { ZCodeSessionSynchronizer } from '@/modules/providers/list/zcode/zcode-session-synchronizer.provider.js';
import { ZCodeLiveEventNormalizer } from '@/modules/providers/list/zcode/zcode-live-event-normalizer.js';
import { ZCodeSessionsProvider } from '@/modules/providers/list/zcode/zcode-sessions.provider.js';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { createWorkspaceFixture } from './workspace-fixture.js';
import { withZCodeStorage } from './zcode-storage-fixture.js';

/**
 * Creates a fixture ZCode database with one user prompt and one assistant
 * message carrying reasoning/text/tool/step-finish parts (Phase 0.3 schema).
 */
const createFixtureDatabase = async (storageDir: string, sessionId: string): Promise<void> => {
  const dbDir = path.join(storageDir, 'cli', 'db');
  await mkdir(dbDir, { recursive: true });

  const db = new Database(path.join(dbDir, 'db.sqlite'));
  try {
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL,
        sequence INTEGER
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL,
        sequence INTEGER
      );
    `);

    const insertMessage = db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertPart = db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    insertMessage.run('msg_user', sessionId, 1000, 1000, JSON.stringify({ role: 'user' }), 0);
    insertPart.run('part_user_text', 'msg_user', sessionId, 1000, 1000, JSON.stringify({ type: 'text', text: 'List the files' }), 0);

    // User prompt whose text lives on the message row, without a part.
    insertMessage.run('msg_user2', sessionId, 1500, 1500, JSON.stringify({ role: 'user', text: 'Second question' }), 1);

    insertMessage.run(
      'msg_asst',
      sessionId,
      2000,
      2000,
      JSON.stringify({
        role: 'assistant',
        modelID: 'GLM-5.3',
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
      }),
      1
    );
    insertPart.run('part_reasoning', 'msg_asst', sessionId, 2000, 2000, JSON.stringify({ type: 'reasoning', text: 'Let me check the directory' }), 0);
    insertPart.run('part_text', 'msg_asst', sessionId, 2100, 2100, JSON.stringify({ type: 'text', text: 'Here are the files' }), 1);
    insertPart.run(
      'part_tool',
      'msg_asst',
      sessionId,
      2200,
      2200,
      JSON.stringify({
        type: 'tool',
        callID: 'call_1',
        tool: 'Bash',
        state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt\nb.txt' },
      }),
      2
    );
    insertPart.run('part_finish', 'msg_asst', sessionId, 2300, 2300, JSON.stringify({ type: 'step-finish' }), 3);
  } finally {
    db.close();
  }
};

test('normalizeMessage maps model_streaming text deltas to stream_delta', () => {
  const provider = new ZCodeSessionsProvider();
  const messages = provider.normalizeMessage(
    { type: 'model_streaming', sessionId: 'sess_1', payload: { kind: 'text_delta', delta: '现在我来' } },
    'sess_1'
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_delta');
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, '现在我来');
});

test('live event normalizer isolates state by session and clears it on reset', () => {
  const normalizer = new ZCodeLiveEventNormalizer();
  const first = normalizer.normalize(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'first' } },
    'sess_a',
  );
  const otherSession = normalizer.normalize(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'other' } },
    'sess_b',
  );

  normalizer.resetSession('sess_a');
  const afterReset = normalizer.normalize(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'second' } },
    'sess_a',
  );

  assert.notEqual(first[0]?.id, otherSession[0]?.id);
  assert.notEqual(first[0]?.id, afterReset[0]?.id);
});

test('normalizeMessage maps reasoning deltas to thinking', () => {
  const provider = new ZCodeSessionsProvider();
  const messages = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'Let me start' } },
    'sess_1'
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'thinking');
  assert.equal(messages[0].content, 'Let me start');
});

test('consecutive reasoning deltas of one thinking segment share one stable id', () => {
  const provider = new ZCodeSessionsProvider();
  const first = provider.normalizeMessage(
    { type: 'model_streaming', id: 'zmsg_7', payload: { kind: 'reasoning_delta', delta: 'Let me start' } },
    'sess_1'
  );
  // The engine numbers each delta separately; the segment keeps the id of the
  // event that opened it so a history read of the same block matches.
  const second = provider.normalizeMessage(
    { type: 'model_streaming', id: 'zmsg_8', payload: { kind: 'reasoning_delta', delta: ' and check' } },
    'sess_1'
  );

  assert.equal(second.length, 1);
  assert.equal(second[0].kind, 'thinking');
  assert.equal(second[0].id, first[0].id);
  assert.equal(first[0].id, 'zmsg_7_reasoning');
});

test('reasoning boundary markers emit nothing but open and close the block', () => {
  const provider = new ZCodeSessionsProvider();
  assert.deepEqual(
    provider.normalizeMessage({ type: 'model_streaming', payload: { kind: 'reasoning_start', delta: '' } }, 'sess_1'),
    []
  );
  const insideBlock = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'thinking' } },
    'sess_1'
  );
  assert.deepEqual(
    provider.normalizeMessage({ type: 'model_streaming', payload: { kind: 'reasoning_end', delta: '' } }, 'sess_1'),
    []
  );
  const nextBlock = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'more thinking' } },
    'sess_1'
  );

  assert.equal(insideBlock.length, 1);
  assert.equal(nextBlock.length, 1);
  assert.notEqual(nextBlock[0].id, insideBlock[0].id);
});

test('tool_input deltas merge into the announced call and emit parsed snapshots', () => {
  const provider = new ZCodeSessionsProvider();
  const announced = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_call', toolCallId: 'call_1', toolName: 'Bash', input: {} } },
    'sess_1'
  );
  assert.equal(announced.length, 1);
  assert.equal(announced[0].kind, 'tool_use');
  assert.equal(announced[0].toolId, 'call_1');

  // Mid-fragment JSON does not parse — nothing is emitted yet.
  const partial = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_delta', delta: '{"command":"npm ' } },
    'sess_1'
  );
  assert.deepEqual(partial, []);

  const completed = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_delta', delta: 'test"}' } },
    'sess_1'
  );
  assert.equal(completed.length, 1);
  assert.equal(completed[0].kind, 'tool_use');
  assert.equal(completed[0].toolId, 'call_1');
  assert.equal(completed[0].toolName, 'Bash');
  assert.deepEqual(completed[0].toolInput, { command: 'npm test' });
});

test('tool_input_end emits the final snapshot and engine-provided input wins', () => {
  const provider = new ZCodeSessionsProvider();
  provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_call', toolCallId: 'call_2', toolName: 'Read', input: {} } },
    'sess_1'
  );

  // A fragment whose buffer never parses still produces nothing mid-stream...
  const midStream = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_delta', delta: '{"file_path":"a' } },
    'sess_1'
  );
  assert.deepEqual(midStream, []);

  // ...but the engine's own accumulated input closes the stream with a snapshot.
  const final = provider.normalizeMessage(
    {
      type: 'model_streaming',
      payload: { kind: 'tool_input_end', input: { file_path: '/tmp/a.txt' } },
    },
    'sess_1'
  );
  assert.equal(final.length, 1);
  assert.equal(final[0].toolId, 'call_2');
  assert.deepEqual(final[0].toolInput, { file_path: '/tmp/a.txt' });

  // The stream is closed: later fragments are ignored.
  const afterEnd = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_delta', delta: '{"x":1}' } },
    'sess_1'
  );
  assert.deepEqual(afterEnd, []);
});

test('tool input fragments without an announced call are ignored', () => {
  const provider = new ZCodeSessionsProvider();
  const messages = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_delta', delta: '{"command":"ls"}' } },
    'sess_1'
  );
  assert.deepEqual(messages, []);
});

test('parallel calls keep per-call streams so interleaved snapshots stay attributed', () => {
  const provider = new ZCodeSessionsProvider();
  provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_call', toolCallId: 'call_a', toolName: 'Bash', input: {} } },
    'sess_1'
  );
  provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_call', toolCallId: 'call_b', toolName: 'Bash', input: {} } },
    'sess_1'
  );

  // The second announce must not evict the first call's stream.
  assert.deepEqual(provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_start', toolCallId: 'call_a' } },
    'sess_1'
  ), []);
  assert.deepEqual(provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_delta', toolCallId: 'call_a', delta: '{"command":"g' } },
    'sess_1'
  ), []);

  // call_b opens while call_a's buffer is mid-fragment...
  assert.deepEqual(provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_start', toolCallId: 'call_b' } },
    'sess_1'
  ), []);
  assert.deepEqual(provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_delta', toolCallId: 'call_b', delta: '{"command":"l' } },
    'sess_1'
  ), []);

  // ...and call_b finishing must not consume call_a's fragments.
  const bDone = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_end', toolCallId: 'call_b', input: { command: 'ls' } } },
    'sess_1'
  );
  assert.equal(bDone.length, 1);
  assert.equal(bDone[0].toolId, 'call_b');
  assert.deepEqual(bDone[0].toolInput, { command: 'ls' });

  const aDone = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_delta', toolCallId: 'call_a', delta: 'it -1"}' } },
    'sess_1'
  );
  assert.equal(aDone.length, 1);
  assert.equal(aDone[0].toolId, 'call_a');
  assert.deepEqual(aDone[0].toolInput, { command: 'git -1' });
});

test('tool_input_start opens an unannounced stream under its own toolCallId', () => {
  const provider = new ZCodeSessionsProvider();
  assert.deepEqual(provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_start', toolCallId: 'call_c', toolName: 'Bash' } },
    'sess_1'
  ), []);
  assert.deepEqual(provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_delta', toolCallId: 'call_c', delta: '{"command":"pw' } },
    'sess_1'
  ), []);
  const done = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'tool_input_delta', toolCallId: 'call_c', delta: 'd"}' } },
    'sess_1'
  );
  assert.equal(done.length, 1);
  assert.equal(done[0].toolId, 'call_c');
  assert.equal(done[0].toolName, 'Bash');
  assert.deepEqual(done[0].toolInput, { command: 'pwd' });
});

test('the real engine sequence ends with a scheduled re-announce that must not blank the card', () => {
  // Probe-verified 0.16.5 order: the parameter stream and tool_call snapshot
  // precede `tool.updated kind=scheduled`, which carries no input at all.
  const provider = new ZCodeSessionsProvider();
  const stream = (payload: Record<string, unknown>) =>
    provider.normalizeMessage({ type: 'model_streaming', payload }, 'sess_1');

  assert.deepEqual(stream({ kind: 'tool_input_start', toolCallId: 'call_1', toolName: 'Bash' }), []);
  assert.deepEqual(stream({ kind: 'tool_input_delta', toolCallId: 'call_1', delta: '{"command":"echo hi",' }), []);
  const midSnapshot = stream({ kind: 'tool_input_delta', toolCallId: 'call_1', delta: '"description":"greet"}' });
  assert.equal(midSnapshot.length, 1);
  assert.deepEqual(midSnapshot[0].toolInput, { command: 'echo hi', description: 'greet' });

  // end re-emits the (unchanged) final snapshot and closes the stream.
  const endSnapshot = stream({ kind: 'tool_input_end', toolCallId: 'call_1' });
  assert.equal(endSnapshot.length, 1);
  assert.deepEqual(endSnapshot[0].toolInput, { command: 'echo hi', description: 'greet' });

  const callSnapshot = stream({ kind: 'tool_call', toolCallId: 'call_1', toolName: 'Bash', input: { command: 'echo hi', description: 'greet' } });
  assert.equal(callSnapshot.length, 1);
  assert.deepEqual(callSnapshot[0].toolInput, { command: 'echo hi', description: 'greet' });

  // The scheduled re-announce (no input, only inputByteLength/inputRef) must
  // not emit a frame: previously it upserted `{}` over the populated card and
  // left every tool blank until the next history reload.
  const scheduled = provider.normalizeMessage(
    {
      type: 'tool_call_scheduled',
      payload: { kind: 'scheduled', toolCallId: 'call_1', toolName: 'Bash', inputByteLength: 42, inputOmitted: true },
    },
    'sess_1'
  );
  assert.deepEqual(scheduled, []);

  // Execution bookkeeping keeps working around the silent announce.
  assert.deepEqual(provider.normalizeMessage(
    { type: 'tool_call_scheduled', payload: { kind: 'started', toolCallId: 'call_1', toolName: 'Bash' } },
    'sess_1'
  ), []);
  const result = provider.normalizeMessage(
    { type: 'tool_call_scheduled', payload: { kind: 'result', toolCallId: 'call_1', result: { success: true, content: 'a.txt\nb.txt' } } },
    'sess_1'
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'tool_result');
});

test('text segment boundaries surface as stream_end so clients finalize each segment', () => {
  const provider = new ZCodeSessionsProvider();
  for (const kind of ['text_start', 'text_end']) {
    const messages = provider.normalizeMessage(
      { type: 'model_streaming', payload: { kind, delta: '' } },
      'sess_1'
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'stream_end');
  }
});

test('a text delta closes the reasoning block so the next segment gets a new id', () => {
  const provider = new ZCodeSessionsProvider();
  const first = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'first thought' } },
    'sess_1'
  );
  provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'text_delta', delta: 'answer part' } },
    'sess_1'
  );
  const second = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'second thought' } },
    'sess_1'
  );

  assert.equal(second.length, 1);
  assert.notEqual(second[0].id, first[0].id);
});

test('reasoning blocks are tracked per session', () => {
  const provider = new ZCodeSessionsProvider();
  const sessionA = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'session a thinks' } },
    'sess_a'
  );
  const sessionB = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'session b thinks' } },
    'sess_b'
  );

  assert.notEqual(sessionA[0].id, sessionB[0].id);
  const sessionAAgain = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: ' still thinking' } },
    'sess_a'
  );
  assert.equal(sessionAAgain[0].id, sessionA[0].id);
});

test('turn completion clears the open reasoning block', () => {
  const provider = new ZCodeSessionsProvider();
  const first = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'run one thought' } },
    'sess_1'
  );
  provider.normalizeMessage(
    { type: 'turn_complete', payload: { usage: {} } },
    'sess_1'
  );
  const second = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'run two thought' } },
    'sess_1'
  );

  assert.equal(second.length, 1);
  assert.notEqual(second[0].id, first[0].id);
});

test('normalizeMessage maps text boundaries to control stream_end frames', () => {
  const provider = new ZCodeSessionsProvider();
  // The control frame is never rendered as a message; it tells the client to
  // finalize the segment it has been streaming.
  const messages = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'text_start', delta: '' } },
    'sess_1'
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_end');
});

test('normalizeMessage maps tool_call_scheduled to tool_use', () => {
  const provider = new ZCodeSessionsProvider();
  const messages = provider.normalizeMessage(
    {
      type: 'tool_call_scheduled',
      payload: { toolCallId: 'call_9', toolName: 'Read', input: { path: 'a.txt' } },
    },
    'sess_1'
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'tool_use');
  assert.equal(messages[0].toolName, 'Read');
  assert.equal(messages[0].toolId, 'call_9');
  assert.deepEqual(messages[0].toolInput, { path: 'a.txt' });
});

test('normalizeMessage maps turn_complete usage onto a numeric token count', () => {
  const provider = new ZCodeSessionsProvider();
  const messages = provider.normalizeMessage(
    {
      type: 'turn_complete',
      payload: {
        usage: { inputTokens: 565902, outputTokens: 9160, totalTokens: 575062, reasoningTokens: 0 },
        resultType: 'success',
      },
    },
    'sess_1'
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'complete');
  assert.equal(messages[0].tokens, 565902 + 9160);
});

test('normalizeMessage unwraps session/event notification payloads', () => {
  const provider = new ZCodeSessionsProvider();
  const messages = provider.normalizeMessage(
    {
      method: 'session/event',
      params: {
        sessionId: 'sess_wrap',
        event: { type: 'model_streaming', payload: { kind: 'text_delta', delta: 'hi' } },
      },
    },
    'sess_wrap'
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_delta');
  assert.equal(messages[0].sessionId, 'sess_wrap');
});

test('normalizeMessage maps engine 0.16.5 dotted event names onto the 0.16.3 paths', () => {
  const provider = new ZCodeSessionsProvider();

  const streaming = provider.normalizeMessage(
    {
      method: 'session/event',
      params: {
        deliveryKind: 'desktop-continuous',
        eventId: 'evt_1',
        seq: 1,
        sessionId: 'sess_new',
        type: 'model.streaming',
        payload: { kind: 'text_delta', delta: 'hi' },
      },
    },
    'sess_new'
  );
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0].kind, 'stream_delta');
  assert.equal(streaming[0].content, 'hi');

  const completed = provider.normalizeMessage(
    {
      method: 'session/event',
      params: {
        deliveryKind: 'desktop-continuous',
        eventId: 'evt_2',
        seq: 2,
        sessionId: 'sess_new',
        type: 'turn.completed',
        payload: { usage: { inputTokens: 10, outputTokens: 5 } },
      },
    },
    'sess_new'
  );
  assert.equal(completed.length, 1);
  assert.equal(completed[0].kind, 'complete');
  assert.equal(completed[0].tokens, 15);

  const toolScheduled = provider.normalizeMessage(
    {
      method: 'session/event',
      params: {
        type: 'tool.updated',
        sessionId: 'sess_new',
        payload: { kind: 'scheduled', toolCallId: 'call_1', toolName: 'Read', input: { path: 'a.txt' } },
      },
    },
    'sess_new'
  );
  assert.equal(toolScheduled.length, 1);
  assert.equal(toolScheduled[0].kind, 'tool_use');
  assert.equal(toolScheduled[0].toolName, 'Read');
  assert.equal(toolScheduled[0].toolId, 'call_1');

  const toolResult = provider.normalizeMessage(
    {
      method: 'session/event',
      params: {
        type: 'tool.updated',
        sessionId: 'sess_new',
        payload: { kind: 'result', toolCallId: 'call_1', result: { success: true, content: 'file contents' } },
      },
    },
    'sess_new'
  );
  assert.equal(toolResult.length, 1);
  assert.equal(toolResult[0].kind, 'tool_result');
  assert.equal(toolResult[0].toolId, 'call_1');

  const permission = provider.normalizeMessage(
    { method: 'session/event', params: { type: 'permission.requested', sessionId: 'sess_new', payload: { toolName: 'Bash', requestId: 'perm_1', input: { command: 'ls' } } } },
    'sess_new'
  );
  assert.equal(permission.length, 1);
  assert.equal(permission[0].kind, 'permission_request');
  assert.equal(permission[0].requestId, 'perm_1');
  assert.deepEqual(permission[0].input, { command: 'ls' });
});

test('normalizeMessage maps error events', () => {
  const provider = new ZCodeSessionsProvider();
  const messages = provider.normalizeMessage(
    { type: 'error', payload: { message: 'boom' } },
    'sess_1'
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'error');
  assert.equal(messages[0].isError, true);
  assert.equal(messages[0].text, 'boom');
});

test('normalizeMessage flags cancelled model requests and reads nested adapter messages', () => {
  const provider = new ZCodeSessionsProvider();

  const cancelled = provider.normalizeMessage(
    {
      type: 'turn.failed',
      payload: {
        error: {
          name: 'AiSdkModelAdapterError',
          data: {
            message: 'Model request was cancelled.',
            code: 'model_request_cancelled',
            turnResult: 'cancelled',
          },
        },
      },
    },
    'sess_cancel'
  );
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].kind, 'error');
  assert.equal(cancelled[0].isCancelledError, true);
  assert.equal(cancelled[0].text, 'Model request was cancelled.', 'the nested data.message is the display text');

  const rateLimited = provider.normalizeMessage(
    {
      type: 'turn.failed',
      payload: {
        error: {
          name: 'AiSdkModelAdapterError',
          data: { message: 'rate limited', code: 'model_rate_limited' },
        },
      },
    },
    'sess_cancel'
  );
  assert.equal(rateLimited.length, 1);
  assert.equal(rateLimited[0].isCancelledError, false, 'a rate limit is a real failure, not a cancellation');

  const plain = provider.normalizeMessage(
    { type: 'error', payload: { message: 'boom' } },
    'sess_cancel'
  );
  assert.equal(plain[0].isCancelledError, false, 'plain errors carry no cancellation flag');
});

test('normalizeMessage ignores unknown event types', () => {
  const provider = new ZCodeSessionsProvider();
  assert.deepEqual(provider.normalizeMessage({ type: 'model_network_status' }, 'sess_1'), []);
  assert.deepEqual(provider.normalizeMessage({ noType: true }, 'sess_1'), []);
  assert.deepEqual(provider.normalizeMessage('not-an-object', 'sess_1'), []);
});

test('fetchHistory loads and paginates the fixture database', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createFixtureDatabase(storageDir, 'sess_hist');

    const provider = new ZCodeSessionsProvider();
    const result = await provider.fetchHistory('sess_hist');

    const kinds = result.messages.map((message) => message.kind);
    // No `complete`: that is a run-lifecycle signal, emitted once per live run
    // and terminating it. A stored transcript has no run in flight, and one row
    // per persisted step used to fill about a third of a real session's
    // history with rows that render nothing.
    assert.deepEqual(kinds, ['text', 'text', 'thinking', 'text', 'tool_use']);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'List the files');
    assert.equal(result.messages[1].role, 'user');
    assert.equal(result.messages[1].content, 'Second question');
    assert.equal(result.messages[2].kind, 'thinking');
    assert.equal(result.messages[3].content, 'Here are the files');
    assert.equal(result.messages[4].toolId, 'call_1');
    assert.equal(result.messages[4].toolResult?.isError, false);

    // Context usage reports the newest step's occupancy, not the lifetime sum.
    // The row stores no `total`, so occupancy is input + output + reasoning
    // (the cache read is part of the prompt the engine already counted).
    const tokenUsage = result.tokenUsage as { used: number; inputTokens: number; outputTokens: number };
    assert.equal(tokenUsage.used, 125);
    assert.equal(tokenUsage.inputTokens, 100);
    assert.equal(tokenUsage.outputTokens, 25);

    // Tail-page pagination: offset 0 + limit keeps the newest messages.
    const page = await provider.fetchHistory('sess_hist', { limit: 2, offset: 0 });
    assert.equal(page.messages.length, 2);
    assert.equal(page.hasMore, true);
  });
});

test('fetchHistory hides model-only injections and surfaces compaction summaries', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createFixtureDatabase(storageDir, 'sess_hidden');
    const db = new Database(path.join(storageDir, 'cli', 'db', 'db.sqlite'));
    try {
      const insertMessage = db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const insertPart = db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      // Model-only todo reminder: the engine marks it hidden to the UI.
      insertMessage.run(
        'msg_reminder', 'sess_hidden', 3000, 3000,
        JSON.stringify({
          role: 'user',
          agent: 'zcode-agent',
          metadata: { visibility: 'model-only' },
          semantics: { kind: 'todo_reminder', uiVisibility: 'hidden', transcriptVisibility: 'hidden' },
          anchor: { turnId: 'turn_1', origin: 'synthetic' },
        }),
        2
      );
      insertPart.run(
        'part_reminder', 'msg_reminder', 'sess_hidden', 3000, 3000,
        JSON.stringify({ type: 'text', text: "The TodoWrite tool hasn't been used recently." }),
        0
      );

      // Compaction summary: a user message carrying a structured summary field.
      insertMessage.run(
        'msg_summary', 'sess_hidden', 3100, 3100,
        JSON.stringify({ role: 'user', summary: { title: 'Compact summary', body: 'Summary of the earlier conversation.' } }),
        3
      );
      insertPart.run(
        'part_summary', 'msg_summary', 'sess_hidden', 3100, 3100,
        JSON.stringify({ type: 'text', text: 'This session is being continued from a previous conversation.' }),
        0
      );
    } finally {
      db.close();
    }

    const provider = new ZCodeSessionsProvider();
    const result = await provider.fetchHistory('sess_hidden');

    // The model-only reminder and its parts never surface.
    assert.equal(result.messages.some((message) => (message.content || '').includes('TodoWrite')), false);

    // The compaction summary surfaces as assistant-authored summary text.
    const summary = result.messages.find((message) => message.isCompactSummary === true);
    assert.ok(summary);
    assert.equal(summary.role, 'assistant');
    assert.equal(summary.content, 'This session is being continued from a previous conversation.');

    // Real user prompts are untouched.
    assert.equal(
      result.messages.some((message) => message.role === 'user' && message.content === 'List the files'),
      true
    );
  });
});

test('live compaction updates become the same rows, the summary arriving with the finished row', () => {
  const provider = new ZCodeSessionsProvider();
  const update = (payload: Record<string, unknown>) => provider.normalizeMessage({
    type: 'session.updated', sessionId: 'sess_live', timestamp: 1792770222113, eventId: `evt_${Math.random()}`, payload,
  }, 'app-live');
  const operation = { operationId: 'cmp_9', messageId: 'msg_tl', partId: 'part_op', trigger: 'manual', phase: 'standalone_turn', compactReason: 'user_requested', display: 'separator', preCompactTokenCount: 10250, startedAt: 1792770222100 };

  const [running] = update({ ...operation, status: 'started' });
  assert.equal(running.id, 'part_op_compact');
  assert.equal(running.content, 'Compacting conversation…');

  assert.deepEqual(update({ content: 'Summary: kiwi.', stopReason: 'stop', querySource: 'compact', toolCallCount: 0 }), []);
  assert.deepEqual(update({ boundaryId: 'compact_9', trigger: 'manual', preCompactTokenCount: 10250, summaryMessageIds: ['msg_sum'] }), []);

  const finished = update({ ...operation, status: 'completed', summaryMessageId: 'msg_sum', postCompactTokenCount: 12147, truePostCompactTokenCount: 11499, endedAt: 1792770277716 });
  assert.deepEqual(finished.map((row) => [row.id, row.content, row.isCompactSummary ?? false]), [
    ['part_op_compact', 'Compacted · manual · 10k → 11k tokens · 56s', false],
    ['msg_sum_summary', 'Summary: kiwi.', true],
  ]);

  // Model-request telemetry also arrives as session.updated and draws nothing.
  assert.deepEqual(update({ baseURL: 'https://example', querySource: 'compact', modelId: 'GLM-5.3' }), []);
});

test('fetchHistory replays cancelled request errors as quiet notifications, real errors as error cards', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createFixtureDatabase(storageDir, 'sess_cancel_hist');
    const db = new Database(path.join(storageDir, 'cli', 'db', 'db.sqlite'));
    try {
      const insertMessage = db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)'
      );

      // A cancelled model request, persisted with the serialized adapter
      // error shape real engines write.
      insertMessage.run(
        'msg_cancelled', 'sess_cancel_hist', 4000, 4000,
        JSON.stringify({
          role: 'assistant',
          error: {
            name: 'AiSdkModelAdapterError',
            data: {
              message: 'Model request was cancelled.',
              code: 'model_request_cancelled',
              turnResult: 'cancelled',
            },
          },
        }),
        2
      );

      // A real failure keeps its error card.
      insertMessage.run(
        'msg_failed', 'sess_cancel_hist', 4100, 4100,
        JSON.stringify({
          role: 'assistant',
          error: {
            name: 'AiSdkModelAdapterError',
            data: { message: 'rate limited', code: 'model_rate_limited' },
          },
        }),
        3
      );
    } finally {
      db.close();
    }

    const provider = new ZCodeSessionsProvider();
    const result = await provider.fetchHistory('sess_cancel_hist');

    const notice = result.messages.find((message) => message.kind === 'task_notification');
    assert.ok(notice, 'a cancelled request must replay as a quiet notification');
    assert.equal(notice.summary, '回复已中断');
    assert.equal(notice.summaryKey, 'taskNotices.replyInterrupted');
    assert.equal(notice.status, 'interrupted');

    const errorCard = result.messages.find((message) => message.kind === 'error');
    assert.ok(errorCard, 'a real failure must keep its error card');
    assert.match(errorCard.content ?? '', /rate limited/);
  });
});

test('fetchHistory materializes user image attachments into the asset store', async () => {
  await withZCodeStorage(async (storageDir) => {
    // The shared asset store lives under the user's home; redirect HOME (and
    // USERPROFILE, which os.homedir() prefers on Windows) into the temp
    // storage dir so the test never touches the real ~/.cloudcli.
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = storageDir;
    process.env.USERPROFILE = storageDir;

    try {
      await createFixtureDatabase(storageDir, 'sess_img');

      // Engine artifact: a data-URL file whose filename ends with the
      // artifact name referenced by the file part.
      const artifactsDir = path.join(storageDir, 'cli', 'artifacts', 'sess_img');
      await mkdir(artifactsDir, { recursive: true });
      const pngBase64 = Buffer.from('fake-png-bytes').toString('base64');
      await writeFile(
        path.join(artifactsDir, 'prompt-attachment-upload-x-tool-result-abc123.txt'),
        `data:image/png;base64,${pngBase64}`,
      );

      const db = new Database(path.join(storageDir, 'cli', 'db', 'db.sqlite'));
      try {
        const insertMessage = db.prepare(
          'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const insertPart = db.prepare(
          'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        insertMessage.run('msg_img', 'sess_img', 4000, 4000, JSON.stringify({ role: 'user' }), 4);
        insertPart.run(
          'part_img_text', 'msg_img', 'sess_img', 4000, 4000,
          JSON.stringify({ type: 'text', text: 'look at this' }),
          0
        );
        insertPart.run(
          'part_img_file', 'msg_img', 'sess_img', 4001, 4001,
          JSON.stringify({
            type: 'file',
            mime: 'image/png',
            url: 'zcode-artifact://sess_img/tool-result-abc123',
            metadata: { storageKind: 'artifact', artifactUri: 'zcode-artifact://sess_img/tool-result-abc123' },
          }),
          1
        );
      } finally {
        db.close();
      }

      const provider = new ZCodeSessionsProvider();
      const result = await provider.fetchHistory('sess_img');

      const imageMessage = result.messages.find(
        (message) => message.role === 'user' && message.content === 'look at this'
      );
      assert.ok(imageMessage);
      const images = imageMessage.images as Array<{ path: string; mimeType: string }>;
      assert.equal(images.length, 1);
      assert.equal(images[0].path, 'zcode-sess_img-tool-result-abc123.png');
      assert.equal(images[0].mimeType, 'image/png');

      const assetFile = path.join(storageDir, '.cloudcli', 'assets', images[0].path);
      assert.equal(existsSync(assetFile), true);
      assert.equal(readFileSync(assetFile, 'utf8'), 'fake-png-bytes');
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  });
});

test('fetchHistory restores non-image file attachments as downloadable file cards', async () => {
  await withZCodeStorage(async (storageDir) => {
    // Non-image uploads stay in cloudcli's own asset store; redirect HOME (and
    // USERPROFILE, which os.homedir() prefers on Windows) into the temp storage
    // dir so the fixture never touches the real ~/.cloudcli.
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = storageDir;
    process.env.USERPROFILE = storageDir;

    try {
      await createFixtureDatabase(storageDir, 'sess_files');

      // Two uploads stored by the assets route, named
      // `<timestamp>-<random>-<original>` per the multer storage config.
      const assetsDir = path.join(storageDir, '.cloudcli', 'assets');
      await mkdir(assetsDir, { recursive: true });
      const logStoredName = '1790841150705-59018875-mir-lite-log-20261001T073954.txt';
      const perfStoredName = '1790841167755-533268251-mir-lite-perf-20261001T074001.txt';
      await writeFile(path.join(assetsDir, logStoredName), 'a'.repeat(2048));
      await writeFile(path.join(assetsDir, perfStoredName), 'b'.repeat(4096));

      const db = new Database(path.join(storageDir, 'cli', 'db', 'db.sqlite'));
      try {
        const insertMessage = db.prepare(
          'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const insertPart = db.prepare(
          'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        insertMessage.run('msg_files', 'sess_files', 5000, 5000, JSON.stringify({ role: 'user' }), 5);
        insertPart.run(
          'part_files_text', 'msg_files', 'sess_files', 5000, 5000,
          JSON.stringify({ type: 'text', text: 'here are the logs' }),
          0
        );
        // The shape the engine persists for a non-image upload: a plain file
        // reference pointing back at cloudcli's asset store (real row,
        // session sess_a9959c2c, 2026-10-01).
        insertPart.run(
          'part_files_log', 'msg_files', 'sess_files', 5001, 5001,
          JSON.stringify({
            type: 'file',
            mime: 'text/plain',
            filename: logStoredName,
            url: path.join(assetsDir, logStoredName),
          }),
          1
        );
        insertPart.run(
          'part_files_perf', 'msg_files', 'sess_files', 5002, 5002,
          JSON.stringify({
            type: 'file',
            mime: 'text/plain',
            filename: perfStoredName,
            url: path.join(assetsDir, perfStoredName),
          }),
          2
        );
        // The engine also persists metadata-only rows when the attachment
        // could not be read at send time — nothing servable, must be skipped.
        insertPart.run(
          'part_files_failed', 'msg_files', 'sess_files', 5003, 5003,
          JSON.stringify({
            type: 'file',
            mime: 'text/plain',
            url: '',
            metadata: { errorCode: 'attachment_read_failed', recoverability: 'metadata_only', storageKind: 'metadata_only' },
          }),
          3
        );
        // A reference whose stored file has vanished must not surface either.
        insertPart.run(
          'part_files_missing', 'msg_files', 'sess_files', 5004, 5004,
          JSON.stringify({
            type: 'file',
            mime: 'text/plain',
            filename: '1790841000000-1234567890-vanished.txt',
            url: path.join(assetsDir, '1790841000000-1234567890-vanished.txt'),
          }),
          4
        );
      } finally {
        db.close();
      }

      const provider = new ZCodeSessionsProvider();
      const result = await provider.fetchHistory('sess_files');

      const message = result.messages.find(
        (candidate) => candidate.role === 'user' && candidate.content === 'here are the logs'
      );
      assert.ok(message);
      const files = message.files as Array<{ name?: string; path?: string; mimeType?: string; size?: number }>;
      assert.equal(files?.length, 2);
      assert.deepEqual(files[0], {
        name: 'mir-lite-log-20261001T073954.txt',
        path: logStoredName,
        mimeType: 'text/plain',
        size: 2048,
      });
      assert.deepEqual(files[1], {
        name: 'mir-lite-perf-20261001T074001.txt',
        path: perfStoredName,
        mimeType: 'text/plain',
        size: 4096,
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  });
});

test('fetchHistory returns empty for sub-agent sessions and missing databases', async () => {
  await withZCodeStorage(async () => {
    const provider = new ZCodeSessionsProvider();

    const subagent = await provider.fetchHistory('sess_subagent_agent_1');
    assert.equal(subagent.total, 0);

    const missing = await provider.fetchHistory('sess_missing');
    assert.equal(missing.total, 0);
    assert.deepEqual(missing.messages, []);
  });
});

test('getTokenUsage reports the newest step occupancy and keeps lifetime totals as cumulative', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createFixtureDatabase(storageDir, 'sess_tokens');

    const provider = new ZCodeSessionsProvider();
    const usage = await provider.getTokenUsage({
      appSessionId: 'app-1',
      nativeSessionId: 'sess_tokens',
      jsonlPath: null,
      projectPath: null,
    });

    // msg_asst carries tokens {input: 100, output: 20, reasoning: 5, cache.read: 10}:
    // occupancy 125 (prompt + generation; the cache read is inside `input`), the
    // output side carries the reasoning tokens. The same row is the session's
    // lifetime total here, so `cumulative` repeats it.
    assert.equal(usage.used, 125);
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 25);
    assert.deepEqual(usage.breakdown, { input: 100, output: 25 });
    assert.deepEqual(usage.cumulative, { used: 125, inputTokens: 100, outputTokens: 25 });
  });
});

test('zcode context usage reports the newest step with its declared context window', async () => {
  await withZCodeStorage(async (storageDir) => {
    const sessionId = 'sess_window';
    const dbDir = path.join(storageDir, 'cli', 'db');
    await mkdir(dbDir, { recursive: true });

    const db = new Database(path.join(dbDir, 'db.sqlite'));
    try {
      db.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL,
          sequence INTEGER
        );
      `);
      const insertMessage = db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)'
      );
      // Two steps of one turn: the older request held 500 tokens, the newer
      // one 1000 — occupancy is the newer reading, not their sum.
      insertMessage.run('msg_step_1', sessionId, 1000, 1000, JSON.stringify({
        role: 'assistant',
        providerId: 'fixture-provider',
        modelId: 'fixture-window-model',
        tokens: { total: 500, input: 480, output: 20, reasoning: 0, cache: { read: 400, write: 0 } },
      }), 0);
      insertMessage.run('msg_step_2', sessionId, 2000, 2000, JSON.stringify({
        role: 'assistant',
        providerId: 'fixture-provider',
        modelId: 'fixture-window-model',
        tokens: { total: 1000, input: 960, output: 40, reasoning: 0, cache: { read: 800, write: 0 } },
      }), 1);
    } finally {
      db.close();
    }

    // Windows come from the engine config when the engine catalog is unknown.
    const configDir = path.join(storageDir, 'v2');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        provider: {
          'fixture-provider': {
            models: { 'fixture-window-model': { limit: { context: 4000, output: 1000 } } },
          },
        },
      }),
      'utf8',
    );

    const provider = new ZCodeSessionsProvider();
    const usage = await provider.getTokenUsage({
      appSessionId: 'app-window',
      nativeSessionId: sessionId,
      jsonlPath: null,
      projectPath: null,
    });

    // Occupancy is the newer step's own `total`, and the window comes from the
    // config so the composer can turn it into a percentage.
    assert.equal(usage.used, 1000);
    assert.equal(usage.total, 4000);
    assert.deepEqual(usage.breakdown, { input: 960, output: 40 });
    assert.deepEqual(usage.cumulative, { used: 1500, inputTokens: 1440, outputTokens: 60 });
  });
});

test('zcode context usage reports a just-compacted session by its summary size', async () => {
  await withZCodeStorage(async (storageDir) => {
    const sessionId = 'sess_compacted';
    const dbDir = path.join(storageDir, 'cli', 'db');
    await mkdir(dbDir, { recursive: true });

    const db = new Database(path.join(dbDir, 'db.sqlite'));
    try {
      db.exec(`
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL,
          sequence INTEGER
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL,
          sequence INTEGER
        );
      `);
      const insertMessage = db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)'
      );
      insertMessage.run('msg_before', sessionId, 1000, 1000, JSON.stringify({
        role: 'assistant',
        tokens: { total: 900, input: 880, output: 20, reasoning: 0, cache: { read: 800, write: 0 } },
      }), 0);
      // Compaction summary: a user row carrying `summary`; its own numbers (if
      // any) describe the conversation that was just discarded.
      insertMessage.run('msg_summary', sessionId, 2000, 2000, JSON.stringify({
        role: 'user',
        summary: { title: 'Compact summary', body: 'what happened' },
      }), 1);
      db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('part_summary', 'msg_summary', sessionId, 2000, 2000, JSON.stringify({ type: 'text', text: 'abcd' }), 0);
    } finally {
      db.close();
    }

    const provider = new ZCodeSessionsProvider();
    const usage = await provider.getTokenUsage({
      appSessionId: 'app-compacted',
      nativeSessionId: sessionId,
      jsonlPath: null,
      projectPath: null,
    });

    assert.equal(usage.compacted, true);
    assert.equal(usage.used, 0);
    assert.equal(usage.summaryBytes, 4);
    // The pre-compaction conversation survives only as the cost breakdown.
    assert.deepEqual(usage.cumulative, { used: 900, inputTokens: 880, outputTokens: 20 });
  });
});

test('getTokenUsage reports zeros for a known session without usage and 404s unknown sessions', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createFixtureDatabase(storageDir, 'sess_known');

    // A known session whose messages carry no usage counters.
    const db = new Database(path.join(storageDir, 'cli', 'db', 'db.sqlite'));
    try {
      db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('msg_bare', 'sess_no_usage', 3000, 3000, JSON.stringify({ role: 'assistant' }), 0);
    } finally {
      db.close();
    }

    const provider = new ZCodeSessionsProvider();
    assert.deepEqual(
      await provider.getTokenUsage({
        appSessionId: 'app-1',
        nativeSessionId: 'sess_no_usage',
        jsonlPath: null,
        projectPath: null,
      }),
      { used: 0, inputTokens: 0, outputTokens: 0, breakdown: { input: 0, output: 0 } },
    );

    await assert.rejects(
      () => provider.getTokenUsage({
        appSessionId: 'app-1',
        nativeSessionId: 'sess_unknown',
        jsonlPath: null,
        projectPath: null,
      }),
      (error: unknown) => (
        error instanceof AppError
        && error.code === 'ZCODE_SESSION_NOT_FOUND'
        && error.statusCode === 404
      ),
    );
  });
});

test('getTokenUsage 404s when the ZCode database does not exist', async () => {
  await withZCodeStorage(async () => {
    const provider = new ZCodeSessionsProvider();
    await assert.rejects(
      () => provider.getTokenUsage({
        appSessionId: 'app-1',
        nativeSessionId: 'sess_missing_db',
        jsonlPath: null,
        projectPath: null,
      }),
      (error: unknown) => (
        error instanceof AppError
        && error.code === 'ZCODE_DATABASE_NOT_FOUND'
        && error.statusCode === 404
      ),
    );
  });
});


async function withIsolatedAppDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'zcode-sync-app-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('synchronizer maps fixture rows through the shared SQLite skeleton', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createFixtureDatabase(storageDir, 'sess_sync');

    // Session indexing only admits a workspace that exists on disk outside
    // the system temporary directories, so the fixture's directory has to be
    // a real one beside the tests.
    const workspaceDir = await createWorkspaceFixture();

    // The synchronizer reads the session table, which the history fixture
    // does not create: add the top-level row plus a subagent row to filter.
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(storageDir, 'cli', 'db', 'db.sqlite'));
    try {
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          directory TEXT,
          title TEXT,
          title_source TEXT,
          time_created INTEGER,
          time_updated INTEGER,
          time_title_updated INTEGER
        )
      `);
      const insertSession = db.prepare(
        'INSERT INTO session (id, parent_id, directory, title, title_source, time_created, time_updated, time_title_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      insertSession.run('sess_sync', null, workspaceDir, 'Fixture session', 'first_input', 1000, 2000, null);
      insertSession.run('sess_subagent_agent_x', 'sess_sync', workspaceDir, 'Subagent', 'first_input', 9000, 9500, null);
    } finally {
      db.close();
    }

    await withIsolatedAppDatabase(async () => {
      const synchronizer = new ZCodeSessionSynchronizer();
      assert.equal(await synchronizer.synchronize(), 1);

      const indexed = sessionsDb.getSessionByProviderSessionId('sess_sync');
      assert.equal(indexed?.provider, 'zcode');
      assert.equal(indexed?.project_path, workspaceDir);
      assert.equal(indexed?.custom_name, 'Fixture session');
      assert.equal(indexed?.jsonl_path, null);

      // The watch target points at the db directory and matches the WAL file.
      const target = synchronizer.getSessionWatchTarget();
      assert.equal(target.rootPath, path.join(storageDir, 'cli', 'db'));
      assert.equal(target.isTargetFile(path.join(storageDir, 'cli', 'db', 'db.sqlite-wal')), true);
    });
  });
});

test('a generated title is re-synced even when message activity has gone quiet', async () => {
  await withZCodeStorage(async (storageDir) => {
    const workspaceDir = await createWorkspaceFixture();
    await createFixtureDatabase(storageDir, 'sess_retitle');

    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.join(storageDir, 'cli', 'db', 'db.sqlite');
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          directory TEXT,
          title TEXT,
          title_source TEXT,
          time_created INTEGER,
          time_updated INTEGER,
          time_title_updated INTEGER
        )
      `);
      const insertSession = db.prepare(
        'INSERT INTO session (id, parent_id, directory, title, title_source, time_created, time_updated, time_title_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      // The engine seeds the title with the raw first input; only the raw
      // message is on record so far.
      insertSession.run('sess_retitle', null, workspaceDir, '帮我看看登录重定向的问题', 'first_input', 1000, 2000, 2000);
    } finally {
      db.close();
    }

    await withIsolatedAppDatabase(async () => {
      const synchronizer = new ZCodeSessionSynchronizer();
      assert.equal(await synchronizer.synchronize(), 1);
      assert.equal(
        sessionsDb.getSessionByProviderSessionId('sess_retitle')?.custom_name,
        '帮我看看登录重定向的问题',
      );

      // The engine later generates its title while the session stays idle:
      // time_updated does not move, only time_title_updated does.
      const engine = new Database(dbPath);
      try {
        engine.prepare(
          'UPDATE session SET title = ?, title_source = ?, time_title_updated = ? WHERE id = ?',
        ).run('登录重定向问题修复', 'generated', 2500, 'sess_retitle');
      } finally {
        engine.close();
      }

      // The watcher-triggered incremental pass must still pick the row up.
      assert.equal(await synchronizer.synchronizeFile(dbPath), 'sess_retitle');
      assert.equal(
        sessionsDb.getSessionByProviderSessionId('sess_retitle')?.custom_name,
        '登录重定向问题修复',
      );
    });
  });
});

test('live and history mint the same toolId for one call (engine callID == toolCallId)', async () => {
  // The engine persists `callID: y.toolCallId` on the tool part itself —
  // 0 missing across 28k real parts — so the realtime path (payload
  // toolCallId) and the transcript path (part callID) must agree
  // byte-for-byte. This parity is what lets the timeline's exact-id pruning
  // work for zcode; the fingerprint matcher in toolIdentity.ts exists for the
  // engines that cannot promise it (codex, antigravity, opencode edges).
  await withZCodeStorage(async (storageDir) => {
    await createFixtureDatabase(storageDir, 'sess_parity');
    const provider = new ZCodeSessionsProvider();

    const live = provider.normalizeMessage(
      { type: 'model_streaming', payload: { kind: 'tool_call', toolCallId: 'call_1', toolName: 'Bash', input: {} } },
      'sess_parity'
    );
    assert.equal(live.length, 1);
    assert.equal(live[0].kind, 'tool_use');
    assert.equal(live[0].toolId, 'call_1');

    const history = await provider.fetchHistory('sess_parity');
    const historyToolRow = history.messages.find((message) => message.kind === 'tool_use');
    assert.ok(historyToolRow, 'the fixture must carry a persisted tool row');
    assert.equal(
      historyToolRow.toolId,
      live[0].toolId,
      'the persisted toolId must equal the live one, or exact-id pruning breaks',
    );
  });
});

/**
 * The engine stamps every session event with a fresh `crypto.randomUUID()`,
 * so the envelope id changes on every delta. Only `payload.assistantMessageId`
 * names the reply, and the client closes a streamed segment whenever the row
 * key changes — deriving the key from the envelope therefore cuts one reply
 * into one bubble per delta.
 */
test('text deltas of one reply share a row key across changing event ids', () => {
  const provider = new ZCodeSessionsProvider();
  const deltas = ['加', '两个「石头纹理强、', '带裂纹」的重口味方案'].map((delta, index) =>
    provider.normalizeMessage(
      {
        type: 'model_streaming',
        id: `evt_${index}_${Math.random()}`,
        sessionId: 'sess_key',
        payload: { kind: 'text_delta', delta, assistantMessageId: 'msg_reply_1' },
      },
      'sess_key'
    )[0]
  );

  for (const delta of deltas) {
    assert.equal(delta.kind, 'stream_delta');
    assert.equal(delta.providerRowKey, 'zcode-message:msg_reply_1');
  }
});

test('an engine that omits assistantMessageId still keeps one key per text segment', () => {
  const provider = new ZCodeSessionsProvider();
  const emit = (kind: string, delta?: string) =>
    provider.normalizeMessage(
      { type: 'model_streaming', id: `evt_${Math.random()}`, sessionId: 'sess_legacy', payload: { kind, delta } },
      'sess_legacy'
    );

  emit('text_start');
  const first = emit('text_delta', 'first')[0];
  const second = emit('text_delta', ' second')[0];
  assert.equal(first.providerRowKey, second.providerRowKey);

  emit('text_end');
  emit('text_start');
  const nextSegment = emit('text_delta', 'other')[0];
  assert.notEqual(nextSegment.providerRowKey, first.providerRowKey);
});

for (const type of ['tool.updated', 'tool_call_scheduled', 'model.streaming', 'model_streaming']) {
  const resultKind = type.startsWith('model') ? 'tool_result' : 'result';
  test(`${type} displays native tool output immediately without history`, () => {
    const provider = new ZCodeSessionsProvider();
    for (const [toolCallId, content] of [['call_bash', 'a.txt\nb.txt'], ['call_read', 'file contents'], ['call_edit', ''], ['call_mcp', [{ type: 'text', text: 'structured output' }]]] as const) {
      const rows = provider.normalizeMessage({type, payload: {kind: resultKind, toolCallId, result: {success: true, content}}}, 'sess_live');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].toolId, toolCallId);
      assert.deepEqual(rows[0].toolResult, {content: typeof content === 'string' ? content : JSON.stringify(content, null, 2), isError: false});
      assert.equal(rows[0].content, rows[0].toolResult?.content);
      assert.equal(rows[0].isError, false);
    }
  });
  test(`${type} preserves failed result content and status`, () => {
    const rows = new ZCodeSessionsProvider().normalizeMessage({type, payload: {kind: resultKind, toolCallId:'call_failed', result:{success:false, content:'Permission denied'}}}, 'sess_live');
    assert.deepEqual(rows[0]?.toolResult, {content:'Permission denied', isError:true});
    assert.equal(rows[0]?.isError, true);
  });
  test(`${type} preserves native errors`, () => {
    const kind = type.startsWith('model') ? 'tool_error' : 'error';
    for (const error of ['command failed', {message:'command failed', code:'FAILED'}]) {
      const rows = new ZCodeSessionsProvider().normalizeMessage({type, payload:{kind, toolCallId:'call_failed', error}}, 'sess_live');
      assert.equal(rows[0]?.toolResult?.isError, true);
      assert.equal(rows[0]?.isError, true);
      assert.match(rows[0]?.toolResult?.content ?? '', /command failed/);
    }
  });
}

test('parallel live results and repeated notifications keep their native call and session identities', () => {
  const provider = new ZCodeSessionsProvider();
  for (const [sessionId, toolCallId, content] of [['sess_a','call_b','second'], ['sess_b','call_a','other session'], ['sess_a','call_a','first'], ['sess_a','call_b','second']]) {
    const rows = provider.normalizeMessage({type:'tool.updated', payload:{kind:'result', toolCallId, result:{success:true, content}}}, sessionId);
    assert.equal(rows[0]?.sessionId, sessionId);
    assert.equal(rows[0]?.toolId, toolCallId);
    assert.equal(rows[0]?.toolResult?.content, content);
  }
});

test('missing result content warns instead of fabricating a successful output', (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  const provider = new ZCodeSessionsProvider();
  assert.deepEqual(provider.normalizeMessage({type:'tool.updated', payload:{kind:'result', toolCallId:'call_missing', resultPartId:'part_missing'}}, 'sess_missing'), []);
  const failure = provider.normalizeMessage({type:'tool.updated', payload:{kind:'error', toolCallId:'call_missing'}}, 'sess_missing');
  assert.equal(failure[0]?.isError, true);
  assert.deepEqual(failure[0]?.toolResult, {content:'', isError:true});
  assert.equal(warnings.length, 2);
  assert.match(String(warnings[0][0]), /no content/);
});

test('failed result without content preserves its nested error', () => {
  const rows = new ZCodeSessionsProvider().normalizeMessage({type:'tool.updated', payload:{kind:'result', toolCallId:'call_failed', result:{success:false, error:{message:'tool failed'}}}}, 'sess_live');
  assert.deepEqual(rows[0]?.toolResult, {content:JSON.stringify({message:'tool failed'}, null, 2), isError:true});
});

test('live native output matches the persisted result after refresh', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createFixtureDatabase(storageDir, 'sess_output_parity');
    const provider = new ZCodeSessionsProvider();
    const history = await provider.fetchHistory('sess_output_parity', {limit:null});
    const stored = history.messages.find((row) => row.kind === 'tool_use' && row.toolId === 'call_1');
    const live = provider.normalizeMessage({type:'tool.updated', payload:{kind:'result', toolCallId:'call_1', result:{success:true, content:'a.txt\nb.txt'}}}, 'sess_output_parity');
    assert.deepEqual(live[0]?.toolResult, stored?.toolResult);
    assert.equal(live[0]?.content, stored?.toolResult?.content);
  });
});
