import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  OpenCodeSessionEventTranslator,
  buildOpenCodeTextRowKey,
} from '@/modules/providers/list/opencode/opencode-event-translator.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { appendImagesInputTag } from '@/shared/image-attachments.js';

import { createWorkspaceFixture } from './workspace-fixture.js';

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
    db.prepare(`
      INSERT INTO session (
        id, project_id, parent_id, slug, directory, title, version, time_created, time_updated,
        time_archived, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
        tokens_cache_write
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'open-child-session-1',
      'project-1',
      'open-session-1',
      'open-child-session-1',
      workspacePath,
      'OpenCode child session',
      '0.0.0',
      1_700_000_002_000,
      1_700_000_005_000,
      null,
      5,
      10,
      2,
      1,
      1,
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
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    await withIsolatedDatabase(() => {
      sessionsDb.createAppSession('app-child-session-1', 'opencode', workspacePath);
      sessionsDb.assignProviderSessionId('app-child-session-1', 'open-child-session-1');

      const synchronizer = new OpenCodeSessionSynchronizer();
      const processed = synchronizer.synchronize();

      return Promise.resolve(processed).then(async (count) => {
        assert.equal(count, 1);
        const indexed = sessionsDb.getSessionById('open-session-1');
        assert.equal(indexed?.provider, 'opencode');
        assert.equal(indexed?.project_path, workspacePath);
        assert.equal(indexed?.custom_name, 'OpenCode indexed title');
        assert.equal(indexed?.jsonl_path, null);
        assert.equal(sessionsDb.getSessionById('app-child-session-1'), null);
        assert.equal(sessionsDb.getSessionByProviderSessionId('open-child-session-1'), null);

        sessionsDb.createAppSession('app-child-session-2', 'opencode', workspacePath);
        sessionsDb.assignProviderSessionId('app-child-session-2', 'open-child-session-1');
        await synchronizer.synchronize(new Date(1_700_000_004_500));
        assert.equal(
          sessionsDb.getSessionById('app-child-session-2')?.provider_session_id,
          'open-child-session-1',
        );
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer returns the app session id once provider mapping exists', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-mapped-'));
  const workspacePath = await createWorkspaceFixture();
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
        assert.equal(sessionsDb.getSessionById('open-child-session-1'), null);
      });
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode session synchronizer adopts the pending app session before watcher sync creates a duplicate', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-race-'));
  const workspacePath = await createWorkspaceFixture();
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
  const workspacePath = await createWorkspaceFixture();
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

test('OpenCode sessions provider normalizes v2 part-wrapped live events', () => {
  // Shapes captured verbatim from `opencode run --format json` on v2.0.31:
  // the payload rides in a `part` object instead of on the event itself.
  const provider = new OpenCodeSessionsProvider();

  const text = provider.normalizeMessage({
    type: 'text',
    timestamp: 1792166313551,
    sessionID: 'ses_v2',
    part: { id: 'prt_text', sessionID: 'ses_v2', messageID: 'msg_1', type: 'text', text: 'pong' },
  }, null);
  assert.equal(text.length, 1);
  assert.equal(text[0]?.kind, 'stream_delta');
  assert.equal(text[0]?.content, 'pong');
  assert.equal(text[0]?.sessionId, 'ses_v2');

  const tool = provider.normalizeMessage({
    type: 'tool_use',
    sessionID: 'ses_v2',
    part: {
      id: 'call-1',
      type: 'tool',
      tool: 'write',
      state: { status: 'completed', input: { path: '/tmp/x' }, output: 'Created file successfully' },
    },
  }, null);
  assert.equal(tool.length, 1);
  assert.equal(tool[0]?.kind, 'tool_use');
  assert.equal(tool[0]?.toolName, 'write');
  assert.equal(tool[0]?.toolId, 'call-1');
  assert.deepEqual(tool[0]?.toolInput, { path: '/tmp/x' });
  assert.deepEqual(tool[0]?.toolResult, { content: 'Created file successfully', isError: false });

  const streamEnd = provider.normalizeMessage({
    type: 'step_finish',
    sessionID: 'ses_v2',
    part: { type: 'step-finish', reason: 'stop' },
  }, null);
  assert.equal(streamEnd.length, 1);
  assert.equal(streamEnd[0]?.kind, 'stream_end');
});

test('OpenCode sessions provider surfaces v2 error events with their detail', () => {
  const provider = new OpenCodeSessionsProvider();
  const normalized = provider.normalizeMessage({
    type: 'error',
    sessionID: 'ses_v2',
    error: { type: 'provider.no-route', message: 'Variant unavailable for opencode/beam-free: nope' },
  }, null);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.kind, 'error');
  assert.equal(normalized[0]?.content, 'Variant unavailable for opencode/beam-free: nope');
});

test('OpenCode sessions provider reads sqlite history and token usage', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-history-'));
  const workspacePath = await createWorkspaceFixture();
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
    // Occupancy from message-assistant (input 10 + cache 3+2, output 20);
    // the session row's lifetime columns surface only as `cumulative`.
    assert.deepEqual(history.tokenUsage, {
      used: 35,
      inputTokens: 15,
      outputTokens: 20,
      breakdown: {
        input: 15,
        output: 20,
      },
      cumulative: {
        used: 42,
        inputTokens: 13,
        outputTokens: 20,
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
        parent_id TEXT,
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

test('the engine title outranks a first-sentence name, and a user rename outranks both', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-app-'));
  const workspacePath = await createWorkspaceFixture();
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

      // The engine names its own sessions now; a name CloudCLI derived from
      // the first sentence grows into the engine title, while a user rename
      // (`name_locked`) is what no sync may overwrite.
      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'OpenCode generated title');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode synchronizer keeps the stored title for indexed sessions', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-sync-indexed-'));
  const workspacePath = await createWorkspaceFixture();
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

test('getTokenUsage reports the newest message occupancy, not the session lifetime totals', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-token-usage-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);

    const provider = new OpenCodeSessionsProvider();
    // Seeded message-assistant tokens: input 10 + cache read 3 + write 2 →
    // prompt 15, output 20; the session row's lifetime columns (42 total leak
    // into it) must only surface as `cumulative`, never as `used`.
    assert.deepEqual(
      await provider.getTokenUsage({
        appSessionId: 'app-1',
        nativeSessionId: 'open-session-1',
        jsonlPath: null,
        projectPath: null,
      }),
      {
        used: 35,
        inputTokens: 15,
        outputTokens: 20,
        breakdown: { input: 15, output: 20 },
        cumulative: { used: 42, inputTokens: 13, outputTokens: 20 },
      },
    );
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('getTokenUsage 404s an unknown session and reports unsupported for old schemas', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-token-usage-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const provider = new OpenCodeSessionsProvider();

    await assert.rejects(
      () => provider.getTokenUsage({
        appSessionId: 'app-1',
        nativeSessionId: 'missing-session',
        jsonlPath: null,
        projectPath: null,
      }),
      /OpenCode session was not found/,
    );
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode sessions provider reads v2 session_message history and token columns', { concurrency: false }, async () => {
  // v2.0.31 renamed `session` to `session_v2` and folds messages plus their
  // content blocks into `session_message` rows; the reader has to flatten
  // them back into the (message, part) shape the normalizer consumes.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-history-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    // The model cache is the only source of a model's context window; seed it
    // so the reading carries the window (and with it, a percentage) the way a
    // real install would.
    const cacheDir = path.join(tempRoot, '.cache', 'opencode');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, 'models.json'),
      JSON.stringify({
        opencode: { models: { 'beam-free': { limit: { context: 200_000 } } } },
      }),
    );
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session_v2 (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          slug text NOT NULL,
          directory text NOT NULL,
          title text,
          version text NOT NULL,
          tokens_input integer DEFAULT 0 NOT NULL,
          tokens_output integer DEFAULT 0 NOT NULL,
          tokens_reasoning integer DEFAULT 0 NOT NULL,
          tokens_cache_read integer DEFAULT 0 NOT NULL,
          tokens_cache_write integer DEFAULT 0 NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        );
        CREATE TABLE session_message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          type text NOT NULL,
          seq integer NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          data text NOT NULL
        );
        INSERT INTO session_v2 (
          id, project_id, slug, directory, title, version,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          time_created, time_updated
        ) VALUES (
          'ses_v2_hist', 'proj_1', 'v2-session', '/tmp/proj', 'V2 session', '2.0.31',
          100, 20, 5, 8, 2, 1000, 2000
        );
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES
          ('msg_u', 'ses_v2_hist', 'user', 1, 1000, 1000, '{"time":{"created":1000},"text":"Build it","files":[],"agents":[]}'),
          ('msg_a', 'ses_v2_hist', 'assistant', 2, 1100, 1200, '{"time":{"created":1100},"model":{"id":"beam-free","providerID":"opencode","variant":"high"},"tokens":{"input":30,"output":10,"reasoning":5,"cache":{"read":2000,"write":100}},"content":[{"type":"reasoning","text":"thinking"},{"type":"tool","id":"call_1","name":"write","state":{"status":"completed","input":{"path":"/tmp/x"},"output":"ok"}},{"type":"text","text":"done"}]}');
      `);
    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('ses_v2_hist');

    assert.equal(history.total, 4);
    assert.equal(history.messages[0]?.role, 'user');
    assert.equal(history.messages[0]?.content, 'Build it');
    assert.equal(history.messages[1]?.kind, 'thinking');
    assert.equal(history.messages[1]?.content, 'thinking');
    assert.equal(history.messages[2]?.kind, 'tool_use');
    assert.equal(history.messages[2]?.toolName, 'write');
    assert.deepEqual(history.messages[2]?.toolInput, { path: '/tmp/x' });
    assert.deepEqual(history.messages[2]?.toolResult, { content: 'ok', isError: false });
    assert.equal(history.messages[3]?.content, 'done');
    // Occupancy comes from the newest message: prompt 30 + 2000 + 100, output
    // 10 + 5 reasoning. The session_v2 columns (135 lifetime) are `cumulative`.
    assert.deepEqual(history.tokenUsage, {
      used: 2145,
      total: 200_000,
      inputTokens: 2130,
      outputTokens: 15,
      breakdown: { input: 2130, output: 15 },
      cumulative: { used: 135, inputTokens: 108, outputTokens: 20 },
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('persisted OpenCode text parts carry the row key the live stream publishes', { concurrency: false }, async () => {
  // A streamed bubble and its persisted row share no row id (the service
  // streams fragments of a row it never announces), so the client retires the
  // streamed copy through `providerRowKey`. Both paths must derive it from the
  // same native coordinates — the message id plus the part's ordinal among
  // that message's text parts — or every reply renders twice until the
  // session is reloaded (the duplicate reported from a live session).
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-text-keys-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session_v2 (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          slug text NOT NULL,
          directory text NOT NULL,
          title text,
          version text NOT NULL,
          tokens_input integer DEFAULT 0 NOT NULL,
          tokens_output integer DEFAULT 0 NOT NULL,
          tokens_reasoning integer DEFAULT 0 NOT NULL,
          tokens_cache_read integer DEFAULT 0 NOT NULL,
          tokens_cache_write integer DEFAULT 0 NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        );
        CREATE TABLE session_message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          type text NOT NULL,
          seq integer NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          data text NOT NULL
        );
        INSERT INTO session_v2 (
          id, project_id, slug, directory, title, version,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          time_created, time_updated
        ) VALUES (
          'ses_v2_text', 'proj_1', 'v2-text', '/tmp/proj', 'Text keys', '2.0.32',
          0, 0, 0, 0, 0, 1000, 3000
        );
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES
          ('msg_u', 'ses_v2_text', 'user', 1, 1000, 1000, '{"time":{"created":1000},"text":"Write it"}'),
          ('msg_a', 'ses_v2_text', 'assistant', 2, 1100, 1200, '{"time":{"created":1100},"content":[{"type":"reasoning","text":"thinking"},{"type":"text","text":"first answer"}]}'),
          ('msg_b', 'ses_v2_text', 'assistant', 3, 1300, 1400, '{"time":{"created":1300},"content":[{"type":"text","text":"before the tool"},{"type":"tool","id":"call_1","name":"write","state":{"status":"completed","input":{"path":"/tmp/x"},"output":"ok"}},{"type":"text","text":"after the tool"}]}');
      `);
    } finally {
      db.close();
    }

    const history = await new OpenCodeSessionsProvider().fetchHistory('ses_v2_text');

    assert.deepEqual(
      history.messages
        .filter((message) => message.kind === 'text' && message.role === 'assistant')
        .map((row) => [row.content, row.providerRowKey]),
      [
        ['first answer', buildOpenCodeTextRowKey('msg_a', 0)],
        ['before the tool', buildOpenCodeTextRowKey('msg_b', 0)],
        ['after the tool', buildOpenCodeTextRowKey('msg_b', 1)],
      ],
      'the ordinal counts text parts within the message, never content blocks',
    );
    assert.equal(
      history.messages.find((message) => message.role === 'user')?.providerRowKey,
      undefined,
      'a prompt is not a streamed part; the client pairs it through its own anchor',
    );

    // The cross-path proof: the live frames for the same coordinates publish
    // exactly the keys those persisted rows carry.
    const translator = new OpenCodeSessionEventTranslator('app-session-1');
    for (const [messageId, ordinal] of [['msg_a', 0], ['msg_b', 0], ['msg_b', 1]] as const) {
      const frame = translator.translate({
        type: 'session.text.delta',
        data: { sessionID: 'ses_v2_text', assistantMessageID: messageId, ordinal, delta: 'x' },
      }).frames[0];
      assert.equal(
        frame?.providerRowKey,
        buildOpenCodeTextRowKey(messageId, ordinal),
        `${messageId}/${ordinal}: the two transports disagree about the row key`,
      );
    }
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a v2 compaction summary resets the reading to compacted with its byte size', { concurrency: false }, async () => {
  // The summary's own tokens describe the summarization request (the whole
  // pre-compaction conversation), so it must never be reported as occupancy;
  // only the summary's text size is honest until the next turn runs.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-compacted-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session_v2 (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          slug text NOT NULL,
          directory text NOT NULL,
          title text,
          version text NOT NULL,
          tokens_input integer DEFAULT 0 NOT NULL,
          tokens_output integer DEFAULT 0 NOT NULL,
          tokens_reasoning integer DEFAULT 0 NOT NULL,
          tokens_cache_read integer DEFAULT 0 NOT NULL,
          tokens_cache_write integer DEFAULT 0 NOT NULL,
          model text,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        );
        CREATE TABLE session_message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          type text NOT NULL,
          seq integer NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          data text NOT NULL
        );
        INSERT INTO session_v2 (
          id, project_id, slug, directory, title, version,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          model, time_created, time_updated
        ) VALUES (
          'ses_v2_compacted', 'proj_1', 'v2-compacted', '/tmp/proj', 'Compacted session', '2.0.31',
          500, 50, 10, 400000, 0,
          '{"providerID":"opencode-go","id":"glm-5.3"}', 1000, 3000
        );
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES
          ('msg_a', 'ses_v2_compacted', 'assistant', 1, 1000, 1000, '{"time":{"created":1000},"tokens":{"input":10,"output":5,"reasoning":0,"cache":{"read":100,"write":0}},"content":[{"type":"text","text":"done"}]}'),
          ('msg_summary', 'ses_v2_compacted', 'assistant', 2, 2000, 2000, '{"time":{"created":2000},"summary":true,"tokens":{"input":20,"output":10,"reasoning":0,"cache":{"read":400000,"write":0}},"content":[{"type":"text","text":"The conversation so far, summarized."}]}');
      `);
    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('ses_v2_compacted');
    const summaryBytes = Buffer.byteLength('The conversation so far, summarized.', 'utf8');
    assert.deepEqual(history.tokenUsage, {
      used: 0,
      inputTokens: 0,
      outputTokens: 0,
      breakdown: { input: 0, output: 0 },
      compacted: true,
      summaryBytes,
      cumulative: { used: 400560, inputTokens: 400500, outputTokens: 50 },
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a v2 compaction message renders as its own row with the summary flagged', { concurrency: false }, async () => {
  // v2.0.32 keeps a compaction beside the conversation — a `compaction`
  // message row (status completed/failed, the summary text in `summary`)
  // instead of folding it into an assistant message — so the transcript
  // reader turns it into what the other engines produce: a row saying what
  // happened plus the summary itself, flagged for the client's disclosure.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-compaction-row-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    const cacheDir = path.join(tempRoot, '.cache', 'opencode');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, 'models.json'),
      JSON.stringify({ 'opencode-go': { models: { 'glm-5.3': { limit: { context: 200_000 } } } } }),
    );
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session_v2 (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          slug text NOT NULL,
          directory text NOT NULL,
          title text,
          version text NOT NULL,
          tokens_input integer DEFAULT 0 NOT NULL,
          tokens_output integer DEFAULT 0 NOT NULL,
          tokens_reasoning integer DEFAULT 0 NOT NULL,
          tokens_cache_read integer DEFAULT 0 NOT NULL,
          tokens_cache_write integer DEFAULT 0 NOT NULL,
          model text,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        );
        CREATE TABLE session_message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          type text NOT NULL,
          seq integer NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          data text NOT NULL
        );
        INSERT INTO session_v2 (
          id, project_id, slug, directory, title, version,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          model, time_created, time_updated
        ) VALUES (
          'ses_v2_compacted', 'proj_1', 'v2-compacted', '/tmp/proj', 'Compacted session', '2.0.32',
          500, 50, 10, 400000, 0,
          '{"providerID":"opencode-go","id":"glm-5.3"}', 1000, 3000
        );
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES
          ('msg_u', 'ses_v2_compacted', 'user', 1, 1000, 1000, '{"time":{"created":1000},"text":"Build it"}'),
          ('msg_a', 'ses_v2_compacted', 'assistant', 2, 1100, 1200, '{"time":{"created":1100},"tokens":{"input":30,"output":10,"reasoning":5,"cache":{"read":2000,"write":0}},"content":[{"type":"text","text":"done"}]}'),
          ('msg_c', 'ses_v2_compacted', 'compaction', 3, 2000, 2100, '{"time":{"created":2000},"status":"completed","reason":"manual","summary":"The conversation so far, summarized.","tokens":{"input":600,"output":90,"reasoning":50,"cache":{"read":6500,"write":0}}}');
      `);
    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('ses_v2_compacted');

    const compactRow = history.messages.find((message) => message.compact);
    assert.equal(compactRow?.role, 'assistant');
    assert.equal(compactRow?.content, 'Compacted · manual');
    assert.deepEqual(compactRow?.compact, { phase: 'done', trigger: 'manual' });

    const summaryRow = history.messages.find((message) => message.isCompactSummary === true);
    assert.equal(summaryRow?.role, 'assistant', 'the summary is assistant-authored, never a user bubble');
    assert.equal(summaryRow?.content, 'The conversation so far, summarized.');
    assert.equal(
      summaryRow?.providerRowKey,
      undefined,
      'the summary is written by the engine, not streamed as a text part; it has no live copy to reconcile with',
    );
    assert.ok(
      history.messages.indexOf(compactRow!) < history.messages.indexOf(summaryRow!),
      'the row saying what happened comes before the summary itself',
    );

    // The compaction's own tokens describe the summarization request — the
    // whole conversation that was just replaced — so the reading is
    // `compacted` with the summary's byte size, never that occupancy.
    assert.deepEqual(history.tokenUsage, {
      used: 0,
      total: 200_000,
      inputTokens: 0,
      outputTokens: 0,
      breakdown: { input: 0, output: 0 },
      compacted: true,
      summaryBytes: Buffer.byteLength('The conversation so far, summarized.', 'utf8'),
      cumulative: { used: 400560, inputTokens: 400500, outputTokens: 50 },
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a v2 subagent launch carries the child session timeline, agent and settled status', { concurrency: false }, async () => {
  // The parent's launch block names the child in `state.metadata.sessionID`
  // but keeps `metadata.status: "running"` forever for a background spawn.
  // The child session row is where the agent's name, title and final outcome
  // live, and its own messages are the timeline the card shows.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-subagent-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session_v2 (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          parent_id text,
          slug text NOT NULL,
          directory text NOT NULL,
          title text,
          version text NOT NULL,
          agent text,
          model text,
          idle_outcome text,
          tokens_input integer DEFAULT 0 NOT NULL,
          tokens_output integer DEFAULT 0 NOT NULL,
          tokens_reasoning integer DEFAULT 0 NOT NULL,
          tokens_cache_read integer DEFAULT 0 NOT NULL,
          tokens_cache_write integer DEFAULT 0 NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          time_idle integer
        );
        CREATE TABLE session_message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          type text NOT NULL,
          seq integer NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          data text NOT NULL
        );
      `);
      const insertSession = db.prepare(`
        INSERT INTO session_v2 (
          id, project_id, parent_id, slug, directory, title, version, agent, model,
          idle_outcome, time_created, time_updated, time_idle
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertSession.run(
        'ses_parent', 'proj_1', null, 'parent', '/tmp/proj', 'Parent', '2.0.32',
        'build', null, null, 1000, 4000, null,
      );
      insertSession.run(
        'ses_child', 'proj_1', 'ses_parent', 'child', '/tmp/proj', 'Echo the marker', '2.0.32',
        'general', '{"providerID":"opencode-go","id":"glm-5.3"}', 'succeeded',
        1100, 3500, 3400,
      );

      const insertMessage = db.prepare(`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertMessage.run('msg_parent', 'ses_parent', 'assistant', 1, 1200, 1300, JSON.stringify({
        time: { created: 1200 },
        content: [{
          type: 'tool',
          id: 'call_subagent',
          name: 'subagent',
          state: {
            status: 'completed',
            input: { agent: 'general', description: 'Echo the marker', background: true },
            metadata: { sessionID: 'ses_child', status: 'running', truncated: false },
            content: [{
              type: 'text',
              text: 'The subagent is working in the background (sessionID: ses_child). You will be notified automatically when it finishes.',
            }],
          },
        }],
      }));
      insertMessage.run('msg_child_user', 'ses_child', 'user', 1, 1100, 1100, JSON.stringify({
        time: { created: 1100 },
        text: 'Run the echo tool',
      }));
      insertMessage.run('msg_child_assistant', 'ses_child', 'assistant', 2, 1200, 3400, JSON.stringify({
        time: { created: 1200 },
        model: { providerID: 'opencode-go', id: 'glm-5.3' },
        content: [
          { type: 'reasoning', text: 'The child is thinking' },
          {
            type: 'tool',
            id: 'call_child_bash',
            name: 'bash',
            state: {
              status: 'completed',
              input: { command: 'echo SUBAGENT_OK' },
              content: [{ type: 'text', text: 'SUBAGENT_OK\n' }],
              metadata: { status: 'completed' },
            },
          },
          { type: 'text', text: 'SUBAGENT_OK' },
        ],
      }));
    } finally {
      db.close();
    }

    const history = await new OpenCodeSessionsProvider().fetchHistory('ses_parent');
    const task = history.messages.find((message) => message.toolId === 'call_subagent');

    assert.equal(task?.kind, 'tool_use');
    assert.equal(task?.toolName, 'subagent');
    assert.equal(task?.subagent?.id, 'ses_child');
    assert.equal(task?.subagent?.name, 'general');
    assert.equal(task?.subagent?.type, 'general');
    assert.equal(task?.subagent?.description, 'Echo the marker');
    assert.equal(task?.subagent?.status, 'completed', 'the child row settles a background launch');
    assert.equal(task?.subagent?.model, 'opencode-go/glm-5.3');
    assert.equal(task?.subagent?.activityCount, 3);
    assert.deepEqual(
      task?.subagentTools?.map((entry) => entry.kind),
      ['thinking', 'tool', 'text'],
    );
    assert.equal(task?.subagentTools?.[1].toolResult?.content, 'SUBAGENT_OK');
    assert.equal(task?.toolResult?.content, 'SUBAGENT_OK', 'the launch acknowledgement is not the result');
    assert.deepEqual(task?.toolResult, { content: 'SUBAGENT_OK', isError: false });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a resumed v2 child that is mid-turn reads as running, not as its last settle', { concurrency: false }, async () => {
  // The engine does not clear a session's idle stamps when it is woken again:
  // a child that settled once and was prompted a second time keeps the old
  // `succeeded`/`time_idle` while it works, so the row's newer `time_updated`
  // is what proves it is running. Reading the stamps blindly made a plainly
  // alive background agent render as completed.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-subagent-resumed-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session_v2 (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          parent_id text,
          slug text NOT NULL,
          directory text NOT NULL,
          title text,
          version text NOT NULL,
          agent text,
          model text,
          idle_outcome text,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          time_idle integer
        );
        CREATE TABLE session_message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          type text NOT NULL,
          seq integer NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          data text NOT NULL
        );
      `);
      const insertSession = db.prepare(`
        INSERT INTO session_v2 (
          id, project_id, parent_id, slug, directory, title, version, agent, model,
          idle_outcome, time_created, time_updated, time_idle
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertSession.run(
        'ses_parent', 'proj_1', null, 'parent', '/tmp/proj', 'Parent', '2.0.32',
        'build', null, 'succeeded', 1000, 9000, 9000,
      );
      // Settled once at t=3400, prompted again at t=5000, still working at t=9000.
      insertSession.run(
        'ses_child_resumed', 'proj_1', 'ses_parent', 'child-a', '/tmp/proj', 'Watch the batch', '2.0.32',
        'general', '{"providerID":"opencode-go","id":"glm-5.3"}', 'succeeded',
        1100, 9000, 3400,
      );
      // Settled at t=3400 and untouched since: genuinely completed.
      insertSession.run(
        'ses_child_settled', 'proj_1', 'ses_parent', 'child-b', '/tmp/proj', 'Echo the marker', '2.0.32',
        'general', '{"providerID":"opencode-go","id":"glm-5.3"}', 'succeeded',
        1100, 3400, 3400,
      );

      const insertMessage = db.prepare(`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [callId, childId, description] of [
        ['call_resumed', 'ses_child_resumed', 'Watch the batch'],
        ['call_settled', 'ses_child_settled', 'Echo the marker'],
      ] as const) {
        insertMessage.run(`msg_parent_${callId}`, 'ses_parent', 'assistant', 1, 1200, 1300, JSON.stringify({
          time: { created: 1200 },
          content: [{
            type: 'tool',
            id: callId,
            name: 'subagent',
            state: {
              status: 'completed',
              input: { agent: 'general', description, background: true },
              metadata: { sessionID: childId, status: 'running', truncated: false },
              content: [{
                type: 'text',
                text: `The subagent is working in the background (sessionID: ${childId}). You will be notified automatically when it finishes.`,
              }],
            },
          }],
        }));
      }
      insertMessage.run('msg_child_running', 'ses_child_resumed', 'assistant', 1, 5000, 9000, JSON.stringify({
        time: { created: 5000 },
        content: [
          { type: 'text', text: 'Tools are ready. Now waiting for batch 23 to finish' },
          {
            type: 'tool',
            id: 'call_child_wait',
            name: 'bash',
            state: { status: 'running', input: { command: 'while true; do grep -q DRIVE_OK drive23.log && break; sleep 30; done' } },
          },
        ],
      }));
      insertMessage.run('msg_child_settled', 'ses_child_settled', 'assistant', 1, 3000, 3400, JSON.stringify({
        time: { created: 3000 },
        content: [{ type: 'text', text: 'DONE' }],
      }));
    } finally {
      db.close();
    }

    const history = await new OpenCodeSessionsProvider().fetchHistory('ses_parent');
    const resumed = history.messages.find((message) => message.toolId === 'call_resumed');
    const settled = history.messages.find((message) => message.toolId === 'call_settled');

    assert.equal(
      resumed?.subagent?.status,
      'running',
      'activity after the idle stamp means the child was resumed and is still working',
    );
    assert.equal(resumed?.subagent?.activityCount, 2);
    assert.equal(
      resumed?.subagentTools?.at(-1)?.toolName,
      'bash',
      'the running shell the agent is waiting on is part of its timeline',
    );
    assert.equal(
      settled?.subagent?.status,
      'completed',
      'a child whose last write is its settle still reads as completed',
    );
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a failed v2 compaction says so and leaves the occupancy reading alone', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-compaction-failed-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    const cacheDir = path.join(tempRoot, '.cache', 'opencode');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, 'models.json'),
      JSON.stringify({ 'opencode-go': { models: { 'glm-5.3': { limit: { context: 200_000 } } } } }),
    );
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session_v2 (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          slug text NOT NULL,
          directory text NOT NULL,
          title text,
          version text NOT NULL,
          tokens_input integer DEFAULT 0 NOT NULL,
          tokens_output integer DEFAULT 0 NOT NULL,
          tokens_reasoning integer DEFAULT 0 NOT NULL,
          tokens_cache_read integer DEFAULT 0 NOT NULL,
          tokens_cache_write integer DEFAULT 0 NOT NULL,
          model text,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        );
        CREATE TABLE session_message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          type text NOT NULL,
          seq integer NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          data text NOT NULL
        );
        INSERT INTO session_v2 (
          id, project_id, slug, directory, title, version,
          tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          model, time_created, time_updated
        ) VALUES (
          'ses_v2_failed', 'proj_1', 'v2-failed', '/tmp/proj', 'Failed compaction', '2.0.32',
          100, 20, 5, 8, 2,
          '{"providerID":"opencode-go","id":"glm-5.3"}', 1000, 3000
        );
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES
          ('msg_a', 'ses_v2_failed', 'assistant', 1, 1100, 1200, '{"time":{"created":1100},"tokens":{"input":30,"output":10,"reasoning":5,"cache":{"read":2000,"write":0}},"content":[{"type":"text","text":"done"}]}'),
          ('msg_c', 'ses_v2_failed', 'compaction', 2, 2000, 2000, '{"time":{"created":2000},"status":"failed","reason":"manual","error":{"type":"provider.no-route","message":"Model unavailable: opencode/gpt-5.6-terra"}}');
      `);
    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('ses_v2_failed');

    const compactRow = history.messages.find((message) => message.compact);
    assert.equal(compactRow?.content, 'Compaction failed: Model unavailable: opencode/gpt-5.6-terra');
    assert.deepEqual(compactRow?.compact, {
      phase: 'failed',
      error: 'Model unavailable: opencode/gpt-5.6-terra',
    });
    assert.ok(
      !history.messages.some((message) => message.isCompactSummary === true),
      'a failed compaction replaced nothing, so there is no summary to fold',
    );

    // The conversation is untouched: the newest real turn still reports its
    // occupancy instead of the `compacted` marker.
    assert.deepEqual(history.tokenUsage, {
      used: 2045,
      total: 200_000,
      inputTokens: 2030,
      outputTokens: 15,
      breakdown: { input: 2030, output: 15 },
      cumulative: { used: 135, inputTokens: 108, outputTokens: 20 },
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
