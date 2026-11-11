import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { opencodeBackgroundWork } from '@/modules/providers/list/opencode/opencode-background-work.js';
import { OpenCodeSessionEventTranslator } from '@/modules/providers/list/opencode/opencode-event-translator.js';
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
      CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        parent_id TEXT,
        directory TEXT,
        title TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_archived INTEGER
      );
      CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);

    db.prepare('INSERT OR IGNORE INTO project (id, worktree) VALUES (?, ?)').run('project-1', workspacePath);
    db.prepare(`
      INSERT INTO session (id, project_id, directory, title, time_created, time_updated, time_archived)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(options.sessionId, 'project-1', workspacePath, options.title, 1_700_000_000_000, 1_700_000_001_000);
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run(`message-user-${options.sessionId}`, options.sessionId, 1_700_000_001_000, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run(
        `part-user-${options.sessionId}`,
        `message-user-${options.sessionId}`,
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

test('OpenCode synchronizer follows the stored title unless the app session is user-locked', { concurrency: false }, async () => {
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
    await seedOpenCodeSession(tempRoot, workspacePath, {
      sessionId: 'oc-app-2',
      title: 'OpenCode generated title',
      firstUserText: 'OpenCode first user prompt',
    });
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'opencode', workspacePath, 'Fix the checkout crash');
      sessionsDb.assignProviderSessionId('app-1', 'oc-app-1');
      sessionsDb.createAppSession('app-2', 'opencode', workspacePath, 'Fix the checkout crash');
      sessionsDb.assignProviderSessionId('app-2', 'oc-app-2');
      sessionsDb.updateSessionCustomName('app-2', 'My rename', { lockName: true });

      await new OpenCodeSessionSynchronizer().synchronize();

      // The engine's own title replaces the unlocked initial app name…
      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'OpenCode generated title');
      // …but never a user rename.
      assert.equal(sessionsDb.getSessionById('app-2')?.custom_name, 'My rename');
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

test('getTokenUsage reads the token columns for the provider-native session', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-token-usage-'));
  const workspacePath = await createWorkspaceFixture();
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

test('OpenCode sessions provider reads v2 session_message history and token columns', { concurrency: false }, async () => {
  // v2.0.31 renamed `session` to `session_v2` and folds messages plus their
  // content blocks into `session_message` rows; the reader has to flatten
  // them back into the (message, part) shape the normalizer consumes.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-history-'));
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
          'ses_v2_hist', 'proj_1', 'v2-session', '/tmp/proj', 'V2 session', '2.0.31',
          100, 20, 5, 8, 2, 1000, 2000
        );
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES
          ('msg_u', 'ses_v2_hist', 'user', 1, 1000, 1000, '{"time":{"created":1000},"text":"Build it","files":[],"agents":[]}'),
          ('msg_a', 'ses_v2_hist', 'assistant', 2, 1100, 1200, '{"time":{"created":1100},"model":{"id":"beam-free","providerID":"opencode","variant":"high"},"content":[{"type":"reasoning","text":"thinking"},{"type":"tool","id":"call_1","name":"write","state":{"status":"completed","input":{"path":"/tmp/x"},"output":"ok"}},{"type":"text","text":"done"}]}');
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
    assert.equal(history.messages[1]?.id, 'msg_a_reasoning_0');
    assert.equal(history.messages[2]?.kind, 'tool_use');
    assert.equal(history.messages[2]?.toolName, 'write');
    assert.deepEqual(history.messages[2]?.toolInput, { path: '/tmp/x' });
    assert.deepEqual(history.messages[2]?.toolResult, { content: 'ok', isError: false });
    assert.equal(history.messages[3]?.content, 'done');
    assert.equal(history.messages[3]?.id, 'msg_a_text_0');
    // Totals come from the session_v2 token columns: 100+20+5+8+2.
    assert.deepEqual(history.tokenUsage, {
      used: 135,
      inputTokens: 108,
      outputTokens: 20,
      breakdown: { input: 108, output: 20 },
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('zero-width-space text and reasoning parts are skipped on history and live reads', { concurrency: false }, async () => {
  // ses_eb34f87e3ffe (2026-10-18): DeepSeek ended every later segment with a
  // single U+200B. `.trim()` passes it, so each persisted part surfaced as a
  // transcript row whose only visible content was its copy control.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-zwsp-'));
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
          'ses_v2_zwsp', 'proj_1', 'v2-zwsp', '/tmp/proj', 'V2 zwsp', '2.0.31',
          0, 0, 0, 0, 0, 1000, 2000
        );
      `);
      const assistantData = JSON.stringify({
        time: { created: 1100 },
        model: { id: 'beam-free', providerID: 'opencode', variant: 'high' },
        content: [
          { type: 'text', text: '​' },
          { type: 'reasoning', text: 'thinking' },
          { type: 'tool', id: 'call_1', name: 'write', state: { status: 'completed', input: { path: '/tmp/x' }, output: 'ok' } },
          { type: 'text', text: '​' },
          { type: 'reasoning', text: '​' },
        ],
      });
      db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES ('msg_u', 'ses_v2_zwsp', 'user', 1, 1000, 1000, ?),
               ('msg_a', 'ses_v2_zwsp', 'assistant', 2, 1100, 1200, ?)`)
        .run(JSON.stringify({ time: { created: 1000 }, text: 'Build it' }), assistantData);    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('ses_v2_zwsp');

    // Only the user prompt, the real reasoning block, and the tool call are
    // user-visible; the three zero-width-space parts drop out entirely.
    assert.equal(history.messages[0]?.role, 'user');
    assert.equal(history.messages[0]?.content, 'Build it');
    assert.deepEqual(history.messages.slice(1).map((message) => message.kind), ['thinking', 'tool_use']);

    // The live `opencode run` normalizer shares the blank-text contract.
    assert.deepEqual(provider.normalizeMessage({ type: 'text', text: '​' }, 'ses_v2_zwsp'), []);
    assert.deepEqual(provider.normalizeMessage({ type: 'reasoning', text: '​' }, 'ses_v2_zwsp'), []);
    const padded = provider.normalizeMessage({ type: 'text', text: '​ok' }, 'ses_v2_zwsp');
    assert.equal(padded.length, 1);
    assert.equal(padded[0]?.content, '​ok');
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('v2 history rows carry the same ids the live translator produces for the same message', { concurrency: false }, async () => {
  // The cross-transport identity contract: the SSE stream names a part
  // `${assistantMessageID}_text_${ordinal}` / `${assistantMessageID}_reasoning_${ordinal}`,
  // where ordinal counts that type's parts within the message (v2.0.31
  // initializes the counter per message). The history reader flattens the
  // same message's content blocks, so it must renumber by type the same way
  // — otherwise the timeline renders the live copy beside its persisted copy.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-ids-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session_v2 (
          id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL,
          directory text NOT NULL, title text, version text NOT NULL,
          tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
          tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
          tokens_cache_write integer DEFAULT 0 NOT NULL, time_created integer NOT NULL,
          time_updated integer NOT NULL
        );
        CREATE TABLE session_message (
          id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL,
          seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
          data text NOT NULL
        );
        INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('ses_ids', 'proj_1', 's', '/tmp/proj', 'S', '2.0.31', 1000, 2000);
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES
          ('msg_a', 'ses_ids', 'assistant', 1, 1100, 1200,
            '{"time":{"created":1100},"content":[{"type":"reasoning","text":"why"},{"type":"text","text":"first prose"},{"type":"tool","id":"call_9","name":"write","state":{"status":"completed","input":{},"output":"ok"}},{"type":"reasoning","text":"more why"},{"type":"text","text":"second prose"}]}');
      `);
    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('ses_ids');
    const historyId = (kind: string, content: string) =>
      history.messages.find((row) => row.kind === kind && row.content === content)?.id;

    // The live events the same message produces, normalized by the translator.
    const translator = new OpenCodeSessionEventTranslator('app-session');
    const liveId = (type: string, data: Record<string, unknown>) =>
      translator.translate({
        id: `evt_${type}`, created: 1792203579833, type,
        location: { directory: '/tmp/proj' },
        data: { sessionID: 'ses_ids', assistantMessageID: 'msg_a', ...data },
      }).frames[0]?.id;

    assert.equal(
      historyId('thinking', 'why'),
      liveId('session.reasoning.delta', { ordinal: 0, delta: 'why' }),
      'first reasoning part must carry the same id on both transports',
    );
    assert.equal(
      historyId('text', 'first prose'),
      liveId('session.text.delta', { ordinal: 0, delta: 'first prose' }),
      'first text part must carry the same id on both transports',
    );
    assert.equal(
      historyId('thinking', 'more why'),
      liveId('session.reasoning.delta', { ordinal: 1, delta: 'more why' }),
      'the second reasoning part counts its own type, not the block index',
    );
    assert.equal(
      historyId('text', 'second prose'),
      liveId('session.text.delta', { ordinal: 1, delta: 'second prose' }),
      'the second text part counts its own type, not the block index',
    );

    // Tool rows already reconcile through the native call id (toolId), which
    // the history rows keep publishing.
    const toolRow = history.messages.find((row) => row.kind === 'tool_use');
    assert.equal(toolRow?.toolId, 'call_9');
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('v2 compactions stay in history as the same rows the live stream showed', { concurrency: false }, async () => {
  // A compaction persists as a `compaction` session_message whose id is the
  // `inputID` its live events carry. The history reader must draw the same
  // notice under the same id, or the row the user saw vanishes on reload.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-compaction-'));
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session_v2 (
          id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL,
          directory text NOT NULL, title text, version text NOT NULL,
          tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
          tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
          tokens_cache_write integer DEFAULT 0 NOT NULL, time_created integer NOT NULL,
          time_updated integer NOT NULL
        );
        CREATE TABLE session_message (
          id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL,
          seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
          data text NOT NULL
        );
        INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('ses_cmp', 'proj_1', 's', '/tmp/proj', 'S', '2.0.31', 1000, 2000);
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES
          ('msg_u', 'ses_cmp', 'user', 1, 1100, 1100, '{"text":"remember banana"}'),
          ('msg_ok', 'ses_cmp', 'compaction', 2, 1200, 1300,
            '{"time":{"created":1200},"status":"completed","reason":"manual","summary":"## Objective\\n- remember banana"}'),
          ('msg_bad', 'ses_cmp', 'compaction', 3, 1400, 1400,
            '{"time":{"created":1400},"status":"failed","reason":"manual","error":{"type":"provider.quota","message":"Free usage limit reached."}}'),
          ('msg_run', 'ses_cmp', 'compaction', 4, 1500, 1500, '{"time":{"created":1500},"reason":"auto"}'),
          ('msg_a', 'ses_cmp', 'assistant', 5, 1600, 1700, '{"time":{"created":1600},"content":[{"type":"text","text":"ok"}]}');
      `);
    } finally {
      db.close();
    }

    const provider = new OpenCodeSessionsProvider();
    const history = await provider.fetchHistory('ses_cmp');
    assert.deepEqual(
      history.messages.map((row) => [row.kind, row.content, row.compact?.phase ?? null, row.isCompactSummary ?? false]),
      [
        ['text', 'remember banana', null, false],
        ['text', 'Compacted · manual', 'done', false],
        ['text', '## Objective\n- remember banana', null, true],
        ['text', 'Compaction failed: Free usage limit reached.', 'failed', false],
        ['text', 'ok', null, false],
      ],
    );

    const translator = new OpenCodeSessionEventTranslator('app-session');
    const live = (type: string, data: Record<string, unknown>) => translator.translate({
      id: `evt_${type}`, created: 1792203579833, type,
      location: { directory: '/tmp/proj' },
      data: { sessionID: 'ses_cmp', reason: 'manual', ...data },
    }).frames[0];
    const ended = live('session.compaction.ended', { inputID: 'msg_ok' });
    const failed = live('session.compaction.failed', { inputID: 'msg_bad', error: { type: 'provider.quota', message: 'Free usage limit reached.' } });
    const historyDone = history.messages.find((row) => row.compact?.phase === 'done');
    const historyFailed = history.messages.find((row) => row.compact?.phase === 'failed');
    assert.equal(historyDone?.id, ended?.id);
    assert.equal(historyDone?.content, ended?.content);
    assert.equal(historyFailed?.id, failed?.id);
    assert.equal(historyFailed?.content, failed?.content);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Subagent cards: OpenCode's `subagent` tool is the client's `Agent` card.
// ---------------------------------------------------------------------------

type SeededSubagent = {
  status: 'completed' | 'error' | 'running' | 'pending';
  /** Whether the parent session still has a run in flight (`time_idle` unset). */
  busy: boolean;
  withChild?: boolean;
  /** Launched with `background: true`: the call returned at once and the agent ran on. */
  background?: boolean;
  /** The `state` of the notice the engine persisted when the background agent ended; none when absent. */
  notice?: 'completed' | 'cancelled' | 'error';
  /** When that notice was written; after the call by default. */
  noticeAt?: number;
  /** When a second background call resumed the same agent; none by default. */
  resumedAt?: number;
};

/** Seeds a v2 database whose parent session called the `subagent` tool once. */
const seedSubagentSession = (homeDir: string, options: SeededSubagent): void => {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE session_v2 (
        id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
        directory text NOT NULL, title text, version text NOT NULL,
        time_created integer NOT NULL, time_updated integer NOT NULL, time_idle integer
      );
      CREATE TABLE session_message (
        id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
        time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
      );
    `);
    db.prepare(`INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_idle)
      VALUES ('ses_parent', 'proj', NULL, 'p', '/tmp/proj', 'Parent', '2.0.31', 1000, 2000, ?)`)
      .run(options.busy ? null : 5000);
    db.prepare(`INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_idle)
      VALUES ('ses_child', 'proj', 'ses_parent', 'c', '/tmp/proj', 'Child', '2.0.31', 1100, 1900, 1900)`).run();

    const state: Record<string, unknown> = {
      status: options.status,
      input: { agent: 'general', description: 'Review the diff', prompt: 'Read the diff and report.' },
    };
    if (options.background) {
      state.input = { ...(state.input as Record<string, unknown>), background: true };
      state.content = [{ type: 'text', text: 'The subagent is working in the background (sessionID: ses_child).' }];
      state.metadata = { sessionID: 'ses_child', status: 'running', truncated: false };
    } else if (options.status === 'completed') {
      state.content = [{ type: 'text', text: '<subagent sessionID="ses_child" state="completed">Found two problems.</subagent>' }];
      state.metadata = { sessionID: 'ses_child', status: 'completed', truncated: false };
    } else if (options.status === 'error') {
      state.error = 'child crashed';
    } else if (options.withChild) {
      state.metadata = { sessionID: 'ses_child' };
    }
    const parentContent = [{ type: 'tool', id: 'call_sub', name: 'subagent', state }];
    db.prepare("INSERT INTO session_message VALUES ('msg_p', 'ses_parent', 'assistant', 1, 1500, 1600, ?)")
      .run(JSON.stringify({ content: parentContent }));
    if (options.resumedAt !== undefined) {
      const again = [{ type: 'tool', id: 'call_sub_again', name: 'subagent', state: { ...state, input: { ...(state.input as Record<string, unknown>), sessionID: 'ses_child' } } }];
      db.prepare("INSERT INTO session_message VALUES ('msg_p2', 'ses_parent', 'assistant', 3, ?, ?, ?)")
        .run(options.resumedAt, options.resumedAt, JSON.stringify({ content: again }));
    }
    if (options.notice) {
      db.prepare("INSERT INTO session_message VALUES ('msg_notice', 'ses_parent', 'synthetic', 4, ?, ?, ?)")
        .run(options.noticeAt ?? 3000, options.noticeAt ?? 3000, JSON.stringify({
          metadata: { source: 'subagent', childID: 'ses_child', agent: 'General', state: options.notice },
          text: `<subagent sessionID="ses_child" state="${options.notice}">Found two problems.</subagent>`,
        }));
    }

    const childContent = [
      { type: 'text', text: 'Reading the diff.' },
      { type: 'tool', id: 'call_read', name: 'read', state: { status: 'completed', input: { path: '/tmp/a.ts' }, content: [{ type: 'text', text: 'file body' }] } },
    ];
    db.prepare("INSERT INTO session_message VALUES ('msg_c', 'ses_child', 'assistant', 1, 1200, 1800, ?)")
      .run(JSON.stringify({ content: childContent }));
  } finally {
    db.close();
  }
};

const readSubagentRow = async (homeDir: string, options: SeededSubagent) => {
  seedSubagentSession(homeDir, options);
  const history = await new OpenCodeSessionsProvider().fetchHistory('ses_parent');
  return history.messages.find((message) => message.kind === 'tool_use' && message.toolId === 'call_sub');
};

const withSubagentHome = async (run: (homeDir: string) => Promise<void>): Promise<void> => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-subagent-'));
  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await run(tempRoot);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
};

test('a finished subagent call is an Agent card carrying its result and its child session timeline', { concurrency: false }, async () => {
  await withSubagentHome(async (homeDir) => {
    const row = await readSubagentRow(homeDir, { status: 'completed', busy: false });

    assert.ok(row, 'the subagent call must be in the history');
    assert.equal(row.toolName, 'Agent');
    assert.deepEqual(row.toolInput, {
      subagent_type: 'general',
      description: 'Review the diff',
      prompt: 'Read the diff and report.',
    });
    assert.equal(row.toolResult?.content, '<subagent sessionID="ses_child" state="completed">Found two problems.</subagent>');
    assert.deepEqual(row.subagent, {
      id: 'ses_child', name: 'general', type: 'general', description: 'Review the diff', status: 'completed', activityCount: 2,
    });
    assert.equal(row.subagentTools?.length, 2);
    assert.equal(row.subagentTools?.[0].kind, 'text');
    assert.equal(row.subagentTools?.[1].toolName, 'read');
    assert.equal(row.subagentTools?.[1].toolResult?.content, 'file body');
  });
});

test('a subagent call that errored is a failed Agent card', { concurrency: false }, async () => {
  await withSubagentHome(async (homeDir) => {
    const row = await readSubagentRow(homeDir, { status: 'error', busy: false });
    assert.equal(row?.toolName, 'Agent');
    assert.equal(row?.subagent?.status, 'failed');
    assert.equal(row?.toolResult?.isError, true);
  });
});

test('a subagent call left running reads as running only while its session still has a run in flight', { concurrency: false }, async () => {
  await withSubagentHome(async (homeDir) => {
    const live = await readSubagentRow(homeDir, { status: 'running', busy: true, withChild: true });
    assert.equal(live?.subagent?.status, 'running');
  });
  await withSubagentHome(async (homeDir) => {
    const orphan = await readSubagentRow(homeDir, { status: 'running', busy: false, withChild: true });
    assert.equal(orphan?.subagent?.status, 'stopped', 'the run that owned the call is gone, so it can never finish');
  });
  await withSubagentHome(async (homeDir) => {
    const pending = await readSubagentRow(homeDir, { status: 'pending', busy: false });
    assert.equal(pending?.subagent?.status, 'stopped');
  });
});

test('a background agent reads from the notice the engine persisted when it ended', { concurrency: false }, async () => {
  await withSubagentHome(async (homeDir) => {
    const done = await readSubagentRow(homeDir, { status: 'completed', busy: false, background: true, notice: 'completed' });
    assert.equal(done?.subagent?.status, 'completed');
  });
  await withSubagentHome(async (homeDir) => {
    const cancelled = await readSubagentRow(homeDir, { status: 'completed', busy: false, background: true, notice: 'cancelled' });
    assert.equal(cancelled?.subagent?.status, 'stopped');
  });
  await withSubagentHome(async (homeDir) => {
    const failed = await readSubagentRow(homeDir, { status: 'completed', busy: false, background: true, notice: 'error' });
    assert.equal(failed?.subagent?.status, 'failed');
  });
});

test('a resumed background agent is not ended by the notice of its earlier run', { concurrency: false }, async () => {
  await withSubagentHome(async (homeDir) => {
    // The notice is stamped before the call (1500): it belongs to an earlier run of the same child.
    seedSubagentSession(homeDir, { status: 'completed', busy: false, background: true, notice: 'completed', noticeAt: 1000 });
    const history = await new OpenCodeSessionsProvider().fetchHistory('ses_parent');
    const row = history.messages.find((message) => message.kind === 'tool_use' && message.toolId === 'call_sub');
    assert.equal(row?.subagent?.status, 'stopped', 'no notice of its own and nothing runs it');
  });
});

test('a background call does not take the notice of a later call on the same agent', { concurrency: false }, async () => {
  await withSubagentHome(async (homeDir) => {
    // call_sub at 1500 never got its notice; the agent was resumed at 2500 and that run's notice is at 3000.
    seedSubagentSession(homeDir, { status: 'completed', busy: false, background: true, notice: 'completed', noticeAt: 3000, resumedAt: 2500 });
    const history = await new OpenCodeSessionsProvider().fetchHistory('ses_parent');
    const first = history.messages.find((message) => message.kind === 'tool_use' && message.toolId === 'call_sub');
    const resumed = history.messages.find((message) => message.kind === 'tool_use' && message.toolId === 'call_sub_again');
    assert.equal(first?.subagent?.status, 'stopped');
    assert.equal(resumed?.subagent?.status, 'completed');
  });
});

test('a background agent with no notice yet runs while the runtime tracks it, else it was lost', { concurrency: false }, async () => {
  await withSubagentHome(async (homeDir) => {
    opencodeBackgroundWork.start('app-history', {
      taskId: 'ses_child', toolUseId: 'call_sub', taskType: 'local_agent', description: 'Review the diff',
    });
    try {
      const live = await readSubagentRow(homeDir, { status: 'completed', busy: false, background: true });
      assert.equal(live?.subagent?.status, 'running', 'the launch acknowledgement is not the agent finishing');
    } finally {
      opencodeBackgroundWork.end('app-history', 'ses_child');
    }
  });
  await withSubagentHome(async (homeDir) => {
    const lost = await readSubagentRow(homeDir, { status: 'completed', busy: false, background: true });
    assert.equal(lost?.subagent?.status, 'stopped', 'nothing runs it any more and no notice will come');
  });
});

test('an agent part is an @-mention of an agent, not a spawned one, and draws no Agent card', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-agent-part-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await createOpenCodeDatabase(tempRoot, workspacePath);
    const db = new Database(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'));
    try {
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run('part-agent', 'message-user', 'open-session-1', 1_700_000_000_500, 1_700_000_000_500, JSON.stringify({ type: 'agent', name: 'general', source: { value: '@general', start: 0, end: 8 } }));
    } finally {
      db.close();
    }

    const history = await new OpenCodeSessionsProvider().fetchHistory('open-session-1');
    assert.equal(history.messages.some((message) => message.toolName === 'Agent'), false);
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
