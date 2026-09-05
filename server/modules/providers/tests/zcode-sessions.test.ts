import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { ZCodeSessionSynchronizer } from '@/modules/providers/list/zcode/zcode-session-synchronizer.provider.js';
import { ZCodeSessionsProvider } from '@/modules/providers/list/zcode/zcode-sessions.provider.js';
import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/** Redirects ZCODE_STORAGE_DIR to a temp dir for fixture isolation. */
const withZCodeStorage = async (runTest: (storageDir: string) => Promise<void>): Promise<void> => {
  const previous = process.env.ZCODE_STORAGE_DIR;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-sessions-'));
  process.env.ZCODE_STORAGE_DIR = tempDir;

  try {
    await runTest(tempDir);
  } finally {
    if (previous === undefined) {
      delete process.env.ZCODE_STORAGE_DIR;
    } else {
      process.env.ZCODE_STORAGE_DIR = previous;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
};

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
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: 'Let me start' } },
    'sess_1'
  );
  const second = provider.normalizeMessage(
    { type: 'model_streaming', payload: { kind: 'reasoning_delta', delta: ' and check' } },
    'sess_1'
  );

  assert.equal(second.length, 1);
  assert.equal(second[0].kind, 'thinking');
  assert.equal(second[0].id, first[0].id);
  assert.match(first[0].id, /^zcode_reasoning_/);
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

test('normalizeMessage skips streaming boundary markers with empty deltas', () => {
  const provider = new ZCodeSessionsProvider();
  assert.deepEqual(
    provider.normalizeMessage({ type: 'model_streaming', payload: { kind: 'text_start', delta: '' } }, 'sess_1'),
    []
  );
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
        payload: { kind: 'result', toolCallId: 'call_1', resultPartId: 'part_7' },
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
    assert.deepEqual(kinds, ['text', 'text', 'thinking', 'text', 'tool_use', 'complete']);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'List the files');
    assert.equal(result.messages[1].role, 'user');
    assert.equal(result.messages[1].content, 'Second question');
    assert.equal(result.messages[2].kind, 'thinking');
    assert.equal(result.messages[3].content, 'Here are the files');
    assert.equal(result.messages[4].toolId, 'call_1');
    assert.equal(result.messages[4].toolResult?.isError, false);

    // Token usage aggregates the SQLite tokens shape (cache as read/write).
    const tokenUsage = result.tokenUsage as { inputTokens: number; outputTokens: number };
    assert.equal(tokenUsage.inputTokens, 100);
    assert.equal(tokenUsage.outputTokens, 20);

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

test('fetchHistory materializes user image attachments into the asset store', async () => {
  await withZCodeStorage(async (storageDir) => {
    // The shared asset store lives under the user's home; redirect HOME into
    // the temp storage dir so the test never touches the real ~/.cloudcli.
    const previousHome = process.env.HOME;
    process.env.HOME = storageDir;

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

test('getTokenUsage aggregates message token totals from the fixture database', async () => {
  await withZCodeStorage(async (storageDir) => {
    await createFixtureDatabase(storageDir, 'sess_tokens');

    const provider = new ZCodeSessionsProvider();
    assert.deepEqual(
      await provider.getTokenUsage({
        appSessionId: 'app-1',
        nativeSessionId: 'sess_tokens',
        jsonlPath: null,
        projectPath: null,
      }),
      // msg_asst carries tokens {input: 100, output: 20, reasoning: 5, cache.read: 10}
      { used: 135, inputTokens: 100, outputTokens: 20, breakdown: { input: 100, output: 20 } },
    );
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
          time_created INTEGER,
          time_updated INTEGER
        )
      `);
      const insertSession = db.prepare(
        'INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
      );
      insertSession.run('sess_sync', null, '/workspace/sess_sync', 'Fixture session', 1000, 2000);
      insertSession.run('sess_subagent_agent_x', 'sess_sync', '/workspace/sess_sync', 'Subagent', 9000, 9500);
    } finally {
      db.close();
    }

    await withIsolatedAppDatabase(async () => {
      const synchronizer = new ZCodeSessionSynchronizer();
      assert.equal(await synchronizer.synchronize(), 1);

      const indexed = sessionsDb.getSessionByProviderSessionId('sess_sync');
      assert.equal(indexed?.provider, 'zcode');
      assert.equal(indexed?.project_path, '/workspace/sess_sync');
      assert.equal(indexed?.custom_name, 'Fixture session');
      assert.equal(indexed?.jsonl_path, null);

      // The watch target points at the db directory and matches the WAL file.
      const target = synchronizer.getSessionWatchTarget();
      assert.equal(target.rootPath, path.join(storageDir, 'cli', 'db'));
      assert.equal(target.isTargetFile(path.join(storageDir, 'cli', 'db', 'db.sqlite-wal')), true);
    });
  });
});
