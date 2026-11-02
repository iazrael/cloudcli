import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { sessionsDb } from '@/modules/database/index.js';
import { CursorSessionsProvider } from '@/modules/providers/list/cursor/cursor-sessions.provider.js';
import { readCanonicalAntigravityTranscript } from '@/modules/providers/list/antigravity/antigravity-transcript.provider.js';
import { readCodexRolloutItem } from '@/modules/providers/list/codex/codex-thread-items.js';
import { OpenCodeSessionEventTranslator } from '@/modules/providers/list/opencode/opencode-event-translator.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { ZCodeLiveEventNormalizer } from '@/modules/providers/list/zcode/zcode-live-event-normalizer.js';
import { ZCodeSessionsProvider } from '@/modules/providers/list/zcode/zcode-sessions.provider.js';
import * as sharedUtils from '@/shared/utils.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=';

/**
 * Storage-dir overrides production resolves before homedir. The app injects
 * ZCODE_STORAGE_DIR into every process it hosts, which would silently point
 * path-reading tests at the real database instead of the isolated home.
 */
const STORAGE_DIR_OVERRIDES = ['ZCODE_STORAGE_DIR', 'CLOUDCLI_ANTIGRAVITY_DATA_DIR'] as const;

async function withAssetStore(run: (home: string) => void | Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'provider-media-'));
  const original = os.homedir;
  const saved = STORAGE_DIR_OVERRIDES.map((key) => [key, process.env[key]] as const);
  for (const key of STORAGE_DIR_OVERRIDES) delete process.env[key];
  os.homedir = () => home;
  try {
    await run(home);
  } finally {
    os.homedir = original;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}

test('provider image results retain text and replace embedded bytes with stable assets', async () => {
  await withAssetStore(async (home) => {
    const image = { type: 'image', mimeType: 'image/png', data: PNG };
    const claudeImage = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };
    const results = [
      new ClaudeSessionsProvider().normalizeMessage({ type: 'user', uuid: 'r', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'kept' }, claudeImage] }] } }, 's'),
      readCodexRolloutItem({ id: 't', type: 'McpToolCall', server: 'mcp', tool: 'read', result: { content: [{ type: 'text', text: 'kept' }, image] }, status: 'completed' }),
      new ZCodeLiveEventNormalizer().normalize({ id: 'r', type: 'model_streaming', payload: { kind: 'tool_result', toolCallId: 't', result: { content: [{ type: 'text', text: 'kept' }, image] } } }, 's'),
    ];
    for (const result of results) {
      const json = JSON.stringify(result);
      assert.ok(!json.includes(PNG), 'embedded bytes must not survive the adapter');
      assert.ok(json.includes('kept'));
      assert.match(json, /inline-[a-f0-9]{64}\.png/);
    }
    // OpenCode deliberately renders a short label rather than an asset: its
    // engine can return hundreds of inline images per session, and the file
    // path already rides on the card.
    const openCodeResult = new OpenCodeSessionEventTranslator('s').translate({ id: 'e', created: 1, type: 'session.tool.success', location: { directory: '/tmp' }, data: { id: 't', content: [{ type: 'text', text: 'kept' }, { type: 'image', uri: `data:image/png;base64,${PNG}` }] } });
    const openCodeJson = JSON.stringify(openCodeResult);
    assert.ok(!openCodeJson.includes(PNG), 'embedded bytes must not survive the adapter');
    assert.ok(openCodeJson.includes('kept'));
    assert.ok(openCodeJson.includes('[image/png, 0 KB]'));
    const files = await readdir(path.join(home, '.cloudcli/assets'));
    assert.equal(files.length, 1, 'the asset transports reuse the same image');
    assert.deepEqual(await readFile(path.join(home, '.cloudcli/assets', files[0])), Buffer.from(PNG, 'base64'));
  });
});

test('payload compaction preserves its input and reuses data URIs inside serialized tool results', async () => {
  await withAssetStore(() => {
    const input = { uri: `data:image/png;base64,${PNG}`, nested: JSON.stringify([{ type: 'image', mimeType: 'image/png', data: PNG }]) };
    const compact = sharedUtils.compactProviderPayload(input);
    assert.ok(input.uri.includes(PNG));
    assert.ok(!JSON.stringify(compact).includes(PNG));
    assert.deepEqual(sharedUtils.compactProviderPayload(compact), compact);
  });
});

test('malformed image data is rejected instead of silently becoming a corrupt asset', async () => {
  await withAssetStore(() => {
    assert.throws(() => sharedUtils.compactProviderPayload({ uri: 'data:image/png;base64,%%%invalid%%%' }), /base64/i);
  });
});

test('large textual results keep a bounded preview and the original bytes as a downloadable file', async () => {
  await withAssetStore(async (home) => {
    const text = '完整输出\n'.repeat(100_000);
    const result = sharedUtils.compactProviderPayload({ content: text });
    assert.ok(result.content.length < 70_000);
    assert.match(result.content, /\/api\/assets\/files\/output-[a-f0-9]{64}\.txt/);
    const [filename] = await readdir(path.join(home, '.cloudcli/assets'));
    assert.equal(await readFile(path.join(home, '.cloudcli/assets', filename), 'utf8'), text);
  });
});

test('non-JSON logs mentioning images still obey the large text boundary', async () => {
  await withAssetStore(() => {
    for (const prefix of ['[INFO] processing "image"\n', '{ "image": ']) {
      const result = sharedUtils.compactProviderPayload({ content: prefix + 'x'.repeat(1024 * 1024) });
      assert.ok(result.content.length < 70_000);
      assert.match(result.content, /\/api\/assets\/files\/output-/);
    }
  });
});

test('long user prompts retain the complete editable text while their image attachments become references', async () => {
  await withAssetStore(() => {
    const text = 'x'.repeat(300_000) + '\nKEEP_THE_END';
    const raw = { type: 'user', uuid: 'user', message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] } };
    const rows = new ClaudeSessionsProvider().normalizeMessage(raw, 'probe');
    assert.ok(rows[0].content === text, 'editing must receive the complete original prompt');
    assert.ok(!JSON.stringify(rows[0].images).includes(PNG));
    const codex = readCodexRolloutItem({ type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] });
    assert.ok((codex?.kind === 'user_message' ? codex.text : null) === text);
  });
});

test('a failed partial asset write cannot poison future image or full-text reads', async () => {
  await withAssetStore(async (home) => {
    for (const input of [{ uri: `data:image/png;base64,${PNG}` }, { content: 'text'.repeat(100_000) }]) {
      const original = fs.writeFileSync;
      let injected = false;
      fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
        if (!injected && String(args[0]).startsWith(path.join(home, '.cloudcli', 'assets'))) {
          injected = true;
          original(args[0], Buffer.from(args[1] as string).subarray(0, 1), args[2]);
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return original(...args);
      }) as typeof fs.writeFileSync;
      try { assert.throws(() => sharedUtils.compactProviderPayload(input), /disk full/); }
      finally { fs.writeFileSync = original; }
      const result = sharedUtils.compactProviderPayload(input);
      const filename = JSON.stringify(result).match(/(?:inline|output)-[a-f0-9]{64}\.(?:png|txt)/)?.[0];
      assert.ok(filename);
      const bytes = await readFile(path.join(home, '.cloudcli/assets', filename));
      assert.deepEqual(bytes, 'uri' in input ? Buffer.from(PNG, 'base64') : Buffer.from(input.content!));
    }
  });
});

test('an existing short asset is repaired and a symlink is never reused as an asset', async () => {
  await withAssetStore(async (home) => {
    const directory = path.join(home, '.cloudcli/assets');
    await mkdir(directory, { recursive: true });
    const filename = `inline-${createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex')}.png`;
    const asset = path.join(directory, filename);
    await writeFile(asset, 'short');
    sharedUtils.compactProviderPayload({ uri: `data:image/png;base64,${PNG}` });
    assert.deepEqual(await readFile(asset), Buffer.from(PNG, 'base64'));
    await rm(asset);
    fs.symlinkSync(path.join(home, 'outside'), asset);
    assert.throws(() => sharedUtils.compactProviderPayload({ uri: `data:image/png;base64,${PNG}` }), /Invalid stored display asset/);
  });
});

test('OpenCode paged history preserves long user text and stable ids across older pages', async () => {
  await withAssetStore(async (home) => {
    const directory = path.join(home, '.local/share/opencode');
    await mkdir(directory, { recursive: true });
    const db = new Database(path.join(directory, 'opencode.db'));
    const text = 'x'.repeat(300_000) + 'END';
    try {
      db.exec('CREATE TABLE session_v2 (id TEXT, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)');
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run('u', 'native', 'user', 0, 1, 1, JSON.stringify({ text }));
      for (let i = 1; i <= 5; i += 1) db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(`a${i}`, 'native', 'assistant', i, i + 1, i + 1, JSON.stringify({ content: [{ type: 'text', text: `reply-${i}` }] }));
    } finally { db.close(); }
    const reader = new OpenCodeSessionsProvider();
    const latest = await reader.fetchHistory('app', { providerSessionId: 'native', limit: 2 });
    assert.equal(latest.total, 6);
    assert.deepEqual(latest.messages.map((row) => row.content), ['reply-4', 'reply-5']);
    const oldest = await reader.fetchHistory('app', { providerSessionId: 'native', limit: 2, offset: 4 });
    assert.ok(oldest.messages[0].content === text);
    assert.equal(oldest.hasMore, false);
    const full = await reader.fetchHistory('app', { providerSessionId: 'native' });
    assert.deepEqual(latest.messages.map((row) => row.id), full.messages.slice(-2).map((row) => row.id));
  });
});

test('Codex history propagates failed asset writes instead of dropping a valid tool result', async () => {
  await withAssetStore(async (home) => {
    await mkdir(path.join(home, '.cloudcli'), { recursive: true });
    await writeFile(path.join(home, '.cloudcli/assets'), 'not a directory');
    const filename = path.join(home, 'rollout.jsonl');
    await writeFile(filename, [
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'before', content: [{ type: 'text', text: 'before' }] } } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', id: 'tool', server: 'mcp', tool: 'read', status: 'completed', result: { content: [{ type: 'text', text: 'keep me' }, { type: 'image', mimeType: 'image/png', data: PNG }] } } } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const original = sessionsDb.getSessionById;
    sessionsDb.getSessionById = () => ({ jsonl_path: filename }) as ReturnType<typeof original>;
    try {
      await assert.rejects(new CodexSessionsProvider().fetchHistory('probe', { limit: 20 }), /display asset/i);
    } finally { sessionsDb.getSessionById = original; }
  });
});

test('Cursor database reads preserve DAG order and pair compacted image tool results', async () => {
  await withAssetStore(async (home) => {
    const project = '/workspace/probe';
    const cwdId = createHash('md5').update(project).digest('hex');
    const directory = path.join(home, '.cursor/chats', cwdId, 'probe');
    await mkdir(directory, { recursive: true });
    const db = new Database(path.join(directory, 'store.db'));
    const callId = '11'.repeat(32);
    const resultId = '22'.repeat(32);
    const linkId = '33'.repeat(32);
    try {
      db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
      const insert = db.prepare('INSERT INTO blobs VALUES (?, ?)');
      // Deliberately insert result first: binary DAG references define order.
      insert.run(resultId, Buffer.from(JSON.stringify({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 't', result: JSON.stringify([{ type: 'image', mimeType: 'image/png', data: PNG }]) }] })));
      insert.run(callId, Buffer.from(JSON.stringify({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't', toolName: 'Read', args: {} }] })));
      insert.run(linkId, Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(callId, 'hex'), Buffer.from([0x0a, 0x20]), Buffer.from(resultId, 'hex')]));
    } finally { db.close(); }
    const history = await new CursorSessionsProvider().fetchHistory('probe', { projectPath: project, limit: 20 });
    const tool = history.messages.find((message) => message.kind === 'tool_use');
    assert.ok(tool?.toolResult);
    assert.ok(!JSON.stringify(history).includes(PNG));
    assert.match(String(tool.toolResult.content), /inline-[a-f0-9]{64}\.png/);
    assert.equal(history.messages[0].kind, 'tool_use');
  });
});

test('ZCode SQLite history compacts results attached after the tool call is created', async () => {
  await withAssetStore(async (home) => {
    const directory = path.join(home, '.zcode/cli/db');
    await mkdir(directory, { recursive: true });
    const db = new Database(path.join(directory, 'db.sqlite'));
    const prompt = 'x'.repeat(300_000) + 'KEEP_THE_END';
    try {
      db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, sequence INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('m', 'native', 1, 1, JSON.stringify({ role: 'assistant' }));
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p', 'm', 'native', 1, JSON.stringify({ type: 'tool', tool: 'read', callID: 't', state: { status: 'completed', input: {}, output: [{ type: 'image', mimeType: 'image/png', data: PNG }] } }));
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('u', 'native', 2, 2, JSON.stringify({ role: 'user' }));
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('up', 'u', 'native', 2, JSON.stringify({ type: 'text', text: prompt }));
    } finally { db.close(); }
    const result = await new ZCodeSessionsProvider().fetchHistory('app', { providerSessionId: 'native', limit: 20 });
    assert.equal(result.messages.length, 2);
    assert.ok(!JSON.stringify(result).includes(PNG));
    assert.match(String(result.messages[0].toolResult?.content), /inline-[a-f0-9]{64}\.png/);
    assert.ok(result.messages[1].content === prompt, 'ZCode history must preserve the complete editable prompt');
  });
});

test('Antigravity compact/full transcript merge preserves order and replaces image bodies', async () => {
  await withAssetStore(async (home) => {
    const directory = path.join(home, '.gemini/antigravity-cli/brain/probe/.system_generated/logs');
    await mkdir(directory, { recursive: true });
    const image = JSON.stringify([{ type: 'image', mimeType: 'image/png', data: PNG }]);
    await writeFile(path.join(directory, 'transcript.jsonl'), JSON.stringify({ step_index: 2, type: 'TOOL_RESPONSE', content: 'partial', truncated_fields: ['content'] }) + '\n');
    await writeFile(path.join(directory, 'transcript_full.jsonl'), [
      { step_index: 2, type: 'TOOL_RESPONSE', content: image },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: 'before' },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const history = await readCanonicalAntigravityTranscript('probe');
    assert.deepEqual(history.map((row) => row.entry.step_index), [1, 2]);
    assert.equal(history[1].contentCompleteness, 'complete');
    assert.ok(!JSON.stringify(history).includes(PNG));
    assert.match(history[1].entry.content, /inline-[a-f0-9]{64}\.png/);
  });
});
