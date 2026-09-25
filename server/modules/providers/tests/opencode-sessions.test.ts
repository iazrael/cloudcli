import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { appendImagesInputTag } from '@/shared/image-attachments.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

const createOpenCodeDatabase = async (homeDir: string, workspacePath: string): Promise<void> => {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL,
        vcs TEXT,
        name TEXT,
        icon_url TEXT,
        icon_color TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_initialized INTEGER,
        sandboxes TEXT NOT NULL,
        commands TEXT,
        icon_url_override TEXT
      );

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        share_url TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        summary_diffs TEXT,
        revert TEXT,
        permission TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_compacting INTEGER,
        time_archived INTEGER,
        workspace_id TEXT,
        path TEXT,
        agent TEXT,
        model TEXT,
        cost REAL NOT NULL DEFAULT 0,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        tokens_reasoning INTEGER NOT NULL DEFAULT 0,
        tokens_cache_read INTEGER NOT NULL DEFAULT 0,
        tokens_cache_write INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
      );

      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
      );

      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
      );

      CREATE INDEX part_session_idx ON part (session_id);
      CREATE INDEX session_project_idx ON session (project_id);
      CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
      CREATE INDEX part_message_id_id_idx ON part (message_id, id);
    `);

    db.prepare(
      'INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'project-1',
      workspacePath,
      1_700_000_000_000,
      1_700_000_001_000,
      '[]',
    );
    db.prepare(`
      INSERT INTO session (
        id, project_id, slug, directory, title, version, time_created, time_updated, time_archived,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'open-session-1',
      'project-1',
      'open-session-1',
      workspacePath,
      'OpenCode indexed title',
      '0.0.0',
      1_700_000_000_000,
      1_700_000_004_000,
      null,
      10,
      20,
      7,
      3,
      2,
    );

    const userMessageData = JSON.stringify({
      role: 'user',
      time: { created: 1_700_000_001_000 },
      agent: 'test',
      model: { providerID: 'anthropic', modelID: 'claude' },
    });
    const assistantMessageData = JSON.stringify({
      role: 'assistant',
      time: { created: 1_700_000_002_000, completed: 1_700_000_003_000 },
      parentID: 'message-user',
      modelID: 'anthropic/claude-sonnet-4-5',
      providerID: 'anthropic',
      mode: 'default',
      agent: 'test',
      path: { cwd: '.', root: '.' },
      cost: 0.01,
      tokens: {
        input: 10,
        output: 20,
        reasoning: 0,
        cache: { read: 3, write: 2 },
      },
    });

    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    ).run('message-user', 'open-session-1', 1_700_000_001_000, 1_700_000_001_500, userMessageData);
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    ).run('message-assistant', 'open-session-1', 1_700_000_002_000, 1_700_000_003_000, assistantMessageData);

    const insertPart = db.prepare(`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertPart.run(
      'part-user-text',
      'message-user',
      'open-session-1',
      1_700_000_001_000,
      1_700_000_001_000,
      JSON.stringify({
        type: 'text',
        text: JSON.stringify('Build the OpenCode integration.'),
      }),
    );
    insertPart.run(
      'part-reasoning',
      'message-assistant',
      'open-session-1',
      1_700_000_002_000,
      1_700_000_002_000,
      JSON.stringify({
        type: 'reasoning',
        text: 'I will inspect the provider shape first.',
        time: { start: 0, end: 1 },
      }),
    );
    insertPart.run(
      'part-assistant-text',
      'message-assistant',
      'open-session-1',
      1_700_000_002_500,
      1_700_000_002_500,
      JSON.stringify({
        type: 'text',
        text: 'The provider is wired.',
      }),
    );
    insertPart.run(
      'part-tool',
      'message-assistant',
      'open-session-1',
      1_700_000_003_000,
      1_700_000_003_000,
      JSON.stringify({
        type: 'tool',
        tool: 'bash',
        callID: 'tool-call-1',
        state: {
          status: 'completed',
          input: { command: 'npm test' },
          output: 'ok',
          title: 'bash',
          metadata: {},
          time: { start: 0, end: 1 },
        },
      }),
    );
  } finally {
    db.close();
  }
};

test('OpenCode session synchronizer indexes sqlite sessions without deletable transcript paths', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      const synchronizer = new OpenCodeSessionSynchronizer();
      const processed = synchronizer.synchronize();

      return Promise.resolve(processed).then((count) => {
        assert.equal(count, 1);
        const indexed = sessionsDb.getSessionById('open-session-1');
        assert.equal(indexed?.provider, 'opencode');
        assert.equal(indexed?.project_path, workspacePath);
        assert.equal(indexed?.custom_name, 'OpenCode indexed title');
        assert.equal(indexed?.jsonl_path, null);
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer returns the app session id once provider mapping exists', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-mapped-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-session-1', 'opencode', workspacePath);
      sessionsDb.assignProviderSessionId('app-session-1', 'open-session-1');

      const synchronizer = new OpenCodeSessionSynchronizer();
      return synchronizer.synchronizeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db')).then((sessionId) => {
        assert.equal(sessionId, 'app-session-1');
        assert.equal(sessionsDb.getAllSessions().length, 1);
        assert.equal(sessionsDb.getSessionById('app-session-1')?.provider_session_id, 'open-session-1');
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer adopts the pending app session before watcher sync creates a duplicate', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-race-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-session-race', 'opencode', workspacePath);

      const synchronizer = new OpenCodeSessionSynchronizer();
      return synchronizer.synchronizeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db')).then((sessionId) => {
        assert.equal(sessionId, 'app-session-race');
        assert.equal(sessionsDb.getAllSessions().length, 1);
        assert.equal(sessionsDb.getSessionById('app-session-race')?.provider_session_id, 'open-session-1');
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode sessions provider strips <images_input> from user turns and exposes attachments', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-images-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);

    // Rewrite the user text part with the tagged prompt the runtime sends.
    const taggedPrompt = appendImagesInputTag('Look at this screenshot.', [
      { path: 'C:/Users/x/.cloudcli/assets/shot.png' },
    ]);
    const db = new Database(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'));
    try {
      db.prepare('UPDATE part SET data = ? WHERE id = ?').run(
        JSON.stringify({ type: 'text', text: taggedPrompt }),
        'part-user-text',
      );
    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-session-1');
    const userMessage = history.messages.find((message) => message.kind === 'text' && message.role === 'user');

    assert.equal(userMessage?.content, 'Look at this screenshot.');
    assert.deepEqual(userMessage?.images, [{ path: 'C:/Users/x/.cloudcli/assets/shot.png' }]);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode sessions provider normalizes quoted live text and skips user echoes', () => {
  const provider = new OpenCodeSessionsProvider();
  const normalized = provider.normalizeMessage({
    type: 'text',
    sessionID: 'open-session-live',
    text: JSON.stringify('hello bro'),
  }, null);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.kind, 'stream_delta');
  assert.equal(normalized[0]?.content, 'hello bro');

  const userEcho = provider.normalizeMessage({
    type: 'text',
    sessionID: 'open-session-live',
    role: 'user',
    text: 'hello bro',
  }, null);

  assert.deepEqual(userEcho, []);
});

test('OpenCode sessions provider surfaces the nested live error message', () => {
  const provider = new OpenCodeSessionsProvider();
  // `opencode run --format json` serializes failures as
  // `{ type: 'error', error: { name, data: { message } } }`.
  const normalized = provider.normalizeMessage({
    type: 'error',
    sessionID: 'open-session-live',
    error: {
      name: 'UnknownError',
      data: { message: 'Model not found: deepseek-v4.1-flash/.', ref: 'err_1234' },
    },
  }, null);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.kind, 'error');
  assert.equal(normalized[0]?.content, 'Model not found: deepseek-v4.1-flash/.');

  const flat = provider.normalizeMessage({
    type: 'error',
    sessionID: 'open-session-live',
    error: 'plain failure',
  }, null);
  assert.equal(flat[0]?.content, 'plain failure');

  const opaque = provider.normalizeMessage({
    type: 'error',
    sessionID: 'open-session-live',
  }, null);
  assert.equal(opaque[0]?.content, 'Unknown OpenCode error');
});

test('OpenCode sessions provider reads live tool calls from the event envelope', () => {
  const provider = new OpenCodeSessionsProvider();
  // `opencode run --format json` emits `{ type, timestamp, sessionID, part }`
  // for tool calls, with the arguments and outcome under `part.state`.
  const completed = provider.normalizeMessage({
    type: 'tool_use',
    timestamp: 1_700_000_000_000,
    sessionID: 'open-session-live',
    part: {
      id: 'part-tool-1',
      type: 'tool',
      tool: 'bash',
      callID: 'call-1',
      state: {
        status: 'completed',
        input: { command: 'ls -la' },
        output: 'total 0',
      },
    },
  }, null);

  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.toolName, 'bash');
  assert.equal(completed[0]?.toolId, 'call-1');
  assert.deepEqual(completed[0]?.toolInput, { command: 'ls -la' });
  assert.deepEqual(completed[0]?.toolResult, { content: 'total 0', isError: false });

  const failed = provider.normalizeMessage({
    type: 'tool_use',
    timestamp: 1_700_000_000_001,
    sessionID: 'open-session-live',
    part: {
      id: 'part-tool-2',
      type: 'tool',
      tool: 'edit',
      callID: 'call-2',
      state: {
        status: 'error',
        input: { file_path: 'a.ts' },
        error: 'permission denied',
      },
    },
  }, null);

  assert.equal(failed[0]?.toolName, 'edit');
  assert.deepEqual(failed[0]?.toolResult, { content: 'permission denied', isError: true });

  // A flat, part-less line still normalizes.
  const flat = provider.normalizeMessage({
    type: 'tool_use',
    tool: 'read',
    callID: 'call-3',
    input: { file_path: '/a.ts' },
    output: 'ok',
  }, null);
  assert.equal(flat[0]?.toolName, 'read');
  assert.equal(flat[0]?.toolId, 'call-3');
  assert.deepEqual(flat[0]?.toolResult, { content: 'ok', isError: false });
});

test('OpenCode sessions provider reads sqlite history and token usage', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-session-1');

    assert.equal(history.total, 4);
    assert.equal(history.messages[0]?.kind, 'text');
    assert.equal(history.messages[0]?.role, 'user');
    assert.equal(history.messages[0]?.content, 'Build the OpenCode integration.');
    assert.equal(history.messages[1]?.kind, 'thinking');
    assert.equal(history.messages[2]?.content, 'The provider is wired.');
    assert.equal(history.messages[3]?.kind, 'tool_use');
    assert.deepEqual(history.messages[3]?.toolResult, { content: 'ok', isError: false });
    assert.deepEqual(history.tokenUsage, {
      used: 42,
      inputTokens: 13,
      outputTokens: 20,
      breakdown: {
        input: 13,
        output: 20,
      },
    });

    const paged = await provider.fetchHistory('open-session-1', { limit: 2, offset: 0 });
    assert.equal(paged.messages.length, 2);
    assert.equal(paged.hasMore, true);
    assert.equal(paged.messages[0]?.content, 'The provider is wired.');
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * OpenCode never names a transcript row on the live stream: assistant text
 * arrives as `message.part.delta` fragments under the part id and the
 * finished row is never sent, so `id` cannot join the streamed reply to its
 * persisted copy. The part id is what both paths carry, and both publish it as
 * the row key so the client reconciles the two by identity instead of by
 * comparing the text of one against the other.
 */
test('OpenCode publishes one row key for a reply on both paths', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-row-key-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-session-1');

    const persistedReply = history.messages.find((message) => message.content === 'The provider is wired.');
    assert.equal(persistedReply?.providerRowKey, 'opencode-part:part-assistant-text');

    const live = provider.normalizeMessage({
      type: 'text',
      id: 'part-assistant-text',
      partID: 'part-assistant-text',
      sessionID: 'open-session-1',
      text: 'The provider is wired.',
    }, null);

    assert.equal(live.length, 1);
    assert.equal(live[0]?.kind, 'stream_delta');
    assert.equal(live[0]?.providerRowKey, persistedReply?.providerRowKey);

    // The prompt is rendered from the optimistic row, never reconciled through
    // a key, so a user turn carries none.
    const persistedPrompt = history.messages.find((message) => message.role === 'user');
    assert.equal(persistedPrompt?.providerRowKey, undefined);

    // An emitter that does not name the part leaves the row unkeyed rather
    // than inventing a key that could only ever match nothing.
    const unkeyed = provider.normalizeMessage({
      type: 'text',
      sessionID: 'open-session-1',
      text: 'The provider is wired.',
    }, null);
    assert.equal(unkeyed[0]?.providerRowKey, undefined);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Seeds a single OpenCode session with a controllable stored title and first
 * user message. Uses a minimal schema (only the columns the synchronizer reads)
 * with a plain-text user part so the derived name is unambiguous.
 */
const seedOpenCodeSession = async (
  homeDir: string,
  workspacePath: string,
  options: { sessionId: string; title: string | null; firstUserText: string },
): Promise<void> => {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        directory TEXT,
        title TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_archived INTEGER
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);

    db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run('project-1', workspacePath);
    db.prepare(`
      INSERT INTO session (id, project_id, directory, title, time_created, time_updated, time_archived)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(options.sessionId, 'project-1', workspacePath, options.title, 1_700_000_000_000, 1_700_000_001_000);
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('message-user', options.sessionId, 1_700_000_001_000, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run(
        'part-user',
        'message-user',
        options.sessionId,
        1_700_000_001_000,
        // OpenCode persists the prompt as a JSON string literal inside the text
        // field, so double-encode it here to exercise the unwrap on read.
        JSON.stringify({ type: 'text', text: JSON.stringify(options.firstUserText) }),
      );
  } finally {
    db.close();
  }
};

test('OpenCode synchronizer preserves the title assigned when CloudCLI creates a session', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-app-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Both provider-owned values differ from the CloudCLI title so either one
    // leaking through would change the assertion below.
    await seedOpenCodeSession(tempRoot, workspacePath, {
      sessionId: 'oc-app-1',
      title: 'OpenCode generated title',
      firstUserText: 'OpenCode first user prompt',
    });
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'opencode', workspacePath, 'Fix the checkout crash');
      sessionsDb.assignProviderSessionId('app-1', 'oc-app-1');

      await new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Fix the checkout crash');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode synchronizer keeps the stored title for indexed sessions', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-indexed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await seedOpenCodeSession(tempRoot, workspacePath, {
      sessionId: 'oc-indexed-1',
      title: 'OpenCode generated title',
      firstUserText: 'This prompt should be ignored',
    });
    await withIsolatedDatabase(async () => {
      await new OpenCodeSessionSynchronizer().synchronize();

      assert.equal(sessionsDb.getSessionById('oc-indexed-1')?.custom_name, 'OpenCode generated title');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('getTokenUsage reads the token columns for the provider-native session', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-token-usage-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);

    const provider = new OpenCodeSessionsProvider();
    // Seeded session row: tokens 10/20/7/3/2 → used 42, input incl. cache reads 13.
    assert.deepEqual(
      await provider.getTokenUsage({
        appSessionId: 'app-1',
        nativeSessionId: 'open-session-1',
        jsonlPath: null,
        projectPath: null,
      }),
      { used: 42, inputTokens: 13, outputTokens: 20, breakdown: { input: 13, output: 20 } },
    );
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Rewrites the seeded assistant message into the current OpenCode shape
 * (`tokens.total`, provider/model ids) and seeds OpenCode's model cache with a
 * context limit for it.
 */
const seedCurrentOpenCodeUsage = async (
  homeDir: string,
  options: { messageTokens?: Record<string, unknown>; contextLimit?: number } = {},
): Promise<void> => {
  const db = new Database(path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db'));
  try {
    const row = db.prepare('SELECT data FROM message WHERE id = ?').get('message-assistant') as { data: string };
    const info = JSON.parse(row.data);
    info.providerID = 'opencode-go';
    info.modelID = 'deepseek-v4.1-flash';
    info.tokens = options.messageTokens ?? {
      total: 52_027,
      input: 13_510,
      output: 366,
      reasoning: 0,
      cache: { read: 38_151, write: 0 },
    };
    db.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify(info), 'message-assistant');
  } finally {
    db.close();
  }

  if (options.contextLimit !== undefined) {
    const cacheDir = path.join(homeDir, '.cache', 'opencode');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, 'models.json'),
      JSON.stringify({
        'opencode-go': {
          models: {
            'deepseek-v4.1-flash': { limit: { context: options.contextLimit, output: 384_000 } },
          },
        },
      }),
    );
  }
};

test('token usage reports the newest assistant message context plus the model window', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-context-usage-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await seedCurrentOpenCodeUsage(tempRoot, { contextLimit: 1_000_000 });

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('open-session-1');

    assert.deepEqual(history.tokenUsage, {
      // Newest message: total 52027 = input 13510 + output 366 + cache read
      // 38151; inputTokens is that whole prompt (input + cache), the same
      // convention Claude's reader uses. The seeded session columns (used 42)
      // stay as cumulative.
      used: 52_027,
      total: 1_000_000,
      inputTokens: 51_661,
      outputTokens: 366,
      breakdown: { input: 51_661, output: 366 },
      cumulative: { used: 42, inputTokens: 13, outputTokens: 20 },
    });

    assert.deepEqual(
      await provider.getTokenUsage({
        appSessionId: 'app-1',
        nativeSessionId: 'open-session-1',
        jsonlPath: null,
        projectPath: null,
      }),
      history.tokenUsage,
    );
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('token usage reports a compaction reset instead of the pre-compaction context', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-compacted-usage-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await seedCurrentOpenCodeUsage(tempRoot, { contextLimit: 1_000_000 });

    const databasePath = path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db');
    const insertAssistantMessage = (id: string, timeCreated: number, info: Record<string, unknown>) => {
      const db = new Database(databasePath);
      try {
        db.prepare(
          'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
        ).run(id, 'open-session-1', timeCreated, timeCreated, JSON.stringify(info));
      } finally {
        db.close();
      }
    };
    const insertSummaryPart = (id: string, messageId: string, info: Record<string, unknown>) => {
      const db = new Database(databasePath);
      try {
        db.prepare(
          'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, messageId, 'open-session-1', 1_700_000_010_000, 1_700_000_010_000, JSON.stringify(info));
      } finally {
        db.close();
      }
    };

    // A compaction summary carries the whole pre-compaction conversation as its
    // request usage; reporting it as current occupancy is exactly backwards.
    insertAssistantMessage('message-summary', 1_700_000_010_000, {
      role: 'assistant',
      summary: true,
      modelID: 'deepseek-v4.1-flash',
      providerID: 'opencode-go',
      tokens: {
        total: 319_336,
        input: 312_690,
        output: 6_646,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });

    // The summary text is the conversation the next turn will be given, so its
    // size is the one occupancy reading available while `compacted`; reasoning
    // parts are not context and must not count toward it.
    insertSummaryPart('part-summary-text', 'message-summary', { type: 'text', text: 'compacted' });
    insertSummaryPart('part-summary-reasoning', 'message-summary', { type: 'reasoning', text: 'x'.repeat(500) });

    const provider = new OpenCodeSessionsProvider();
    const usageInput = {
      appSessionId: 'app-1',
      nativeSessionId: 'open-session-1',
      jsonlPath: null,
      projectPath: null,
    };

    assert.deepEqual(await provider.getTokenUsage(usageInput), {
      used: 0,
      total: 1_000_000,
      inputTokens: 0,
      outputTokens: 0,
      breakdown: { input: 0, output: 0 },
      compacted: true,
      summaryBytes: 9,
      cumulative: { used: 42, inputTokens: 13, outputTokens: 20 },
    });

    // The next real turn is the first record that knows the compacted context,
    // so it becomes the reported occupancy and clears the reset flag.
    insertAssistantMessage('message-after-compaction', 1_700_000_020_000, {
      role: 'assistant',
      modelID: 'deepseek-v4.1-flash',
      providerID: 'opencode-go',
      tokens: {
        total: 900,
        input: 600,
        output: 100,
        reasoning: 0,
        cache: { read: 200, write: 0 },
      },
    });

    const afterCompaction = await provider.getTokenUsage(usageInput);
    assert.equal(afterCompaction?.used, 900);
    assert.equal(afterCompaction?.total, 1_000_000);
    assert.equal(afterCompaction?.compacted, undefined);
    assert.equal(afterCompaction?.inputTokens, 800);
    assert.equal(afterCompaction?.outputTokens, 100);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('token usage falls back to the cumulative columns when the model cache has no window', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-context-window-missing-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await seedCurrentOpenCodeUsage(tempRoot);

    const provider = new OpenCodeSessionsProvider();
    const usage = await provider.getTokenUsage({
      appSessionId: 'app-1',
      nativeSessionId: 'open-session-1',
      jsonlPath: null,
      projectPath: null,
    });

    assert.equal(usage?.used, 52_027);
    assert.equal(usage?.total, undefined);
    assert.deepEqual(usage?.cumulative, { used: 42, inputTokens: 13, outputTokens: 20 });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode edit anchors expose provider message ids and resolve to the predecessor', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-edit-anchor-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(async () => {
      const appSessionId = sessionsDb.createSession('open-session-1', 'opencode', workspacePath, 'Edit anchor');
      const provider = new OpenCodeSessionsProvider();

      const history = await provider.fetchHistory(appSessionId, { providerSessionId: 'open-session-1' });
      const userMessage = history.messages.find((message) => message.role === 'user');
      const assistantMessage = history.messages.find((message) => message.role === 'assistant');
      assert.equal(userMessage?.transcriptAnchorId, 'message-user');
      assert.equal(assistantMessage?.transcriptAnchorId, 'message-assistant');

      // Editing the assistant message keeps the user prompt before it.
      assert.deepEqual(
        await provider.resolveEditAnchor(appSessionId, 'message-assistant'),
        { found: true, resumeThroughId: 'message-user' },
      );
      // Editing the first prompt keeps nothing.
      assert.deepEqual(
        await provider.resolveEditAnchor(appSessionId, 'message-user'),
        { found: true, resumeThroughId: null },
      );
      // An unknown anchor is reported, never guessed at.
      assert.deepEqual(
        await provider.resolveEditAnchor(appSessionId, 'missing-message'),
        { found: false, resumeThroughId: null },
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
