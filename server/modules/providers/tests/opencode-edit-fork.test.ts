import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { OpenCodeForkProvider, resolveOpenCodeForkCut } from '@/modules/providers/list/opencode/opencode-fork.provider.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';

/**
 * A home directory holding a v2 `opencode.db` with one three-turn session,
 * interleaved with the bookkeeping rows a real v2.1.4 session carries
 * (`model-switched`, `system`, `idle`) — the cuts must skip those — plus an
 * isolated app database mapping `app-1` onto that session.
 */
const withOpenCodeSession = async (run: () => Promise<void>): Promise<void> => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-edit-fork-'));
  const originalHomedir = os.homedir;
  (os as any).homedir = () => tempRoot;
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session_message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          type text NOT NULL,
          seq integer NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          data text NOT NULL
        );
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES
          ('msg_model', 'ses_src', 'model-switched', 1, 1, 1, '{}'),
          ('msg_u1', 'ses_src', 'user', 2, 2, 2, '{"text":"one"}'),
          ('msg_sys', 'ses_src', 'system', 3, 3, 3, '{}'),
          ('msg_a1', 'ses_src', 'assistant', 4, 4, 4, '{"content":[{"type":"text","text":"1"}]}'),
          ('msg_idle1', 'ses_src', 'idle', 5, 5, 5, '{}'),
          ('msg_u2', 'ses_src', 'user', 6, 6, 6, '{"text":"two"}'),
          ('msg_a2', 'ses_src', 'assistant', 7, 7, 7, '{"content":[{"type":"text","text":"2"}]}'),
          ('msg_idle2', 'ses_src', 'idle', 8, 8, 8, '{}'),
          ('msg_u3', 'ses_src', 'user', 9, 9, 9, '{"text":"three"}'),
          ('msg_a3', 'ses_src', 'assistant', 10, 10, 10, '{"content":[{"type":"text","text":"3"}]}');
      `);
    } finally {
      db.close();
    }
    sessionsDb.createAppSession('app-1', 'opencode', tempRoot);
    sessionsDb.assignProviderSessionId('app-1', 'ses_src');

    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    (os as any).homedir = originalHomedir;
    await rm(tempRoot, { recursive: true, force: true });
  }
};

test('user rows carry their provider message id as the transcript anchor', { concurrency: false }, async () => {
  await withOpenCodeSession(async () => {
    const history = await new OpenCodeSessionsProvider().fetchHistory('app-1', { providerSessionId: 'ses_src' });
    const anchored = history.messages.filter((message) => message.transcriptAnchorId);
    assert.deepEqual(anchored.map((message) => [message.role, message.transcriptAnchorId]), [
      ['user', 'msg_u1'],
      ['user', 'msg_u2'],
      ['user', 'msg_u3'],
    ]);
  });
});

test('an edit keeps the conversation message before the anchor and reverts at the edited prompt', { concurrency: false }, async () => {
  await withOpenCodeSession(async () => {
    const reverts: Array<[string, string, { files: boolean }]> = [];
    const provider = new OpenCodeSessionsProvider({
      connectClient: async () => ({
        revertSession: async (sessionId, messageId, options) => {
          reverts.push([sessionId, messageId, options]);
        },
      }),
    });

    assert.deepEqual(await provider.resolveEditAnchor('app-1', 'msg_u2'), { found: true, resumeThroughId: 'msg_a1' });
    assert.deepEqual(await provider.resolveEditAnchor('app-1', 'msg_u1'), { found: true, resumeThroughId: null });
    assert.deepEqual(await provider.resolveEditAnchor('app-1', 'msg_gone'), { found: false, resumeThroughId: null });

    await provider.rewindSession('app-1', 'msg_a1');
    // Keeping nothing drops the first prompt but not the model selection before it.
    await provider.rewindSession('app-1', null);
    // Nothing follows the last answer, so there is nothing to revert.
    await provider.rewindSession('app-1', 'msg_a3');
    assert.deepEqual(reverts, [
      ['ses_src', 'msg_u2', { files: true }],
      ['ses_src', 'msg_u1', { files: true }],
    ]);

    // An unknown keep point must not degrade into wiping the conversation.
    await assert.rejects(provider.rewindSession('app-1', 'msg_gone'), /no longer in the transcript/);
    assert.equal(reverts.length, 2);
  });
});

test('a fork copies through the anchor turn by cutting before the next prompt', { concurrency: false }, async () => {
  await withOpenCodeSession(async () => {
    const forks: Array<[string, string | null]> = [];
    const provider = new OpenCodeForkProvider({
      connectClient: async () => ({
        forkSession: async (sessionId, before) => {
          forks.push([sessionId, before]);
          return { id: 'ses_forked' };
        },
      }),
    });
    const input = { providerSessionId: 'ses_src', jsonlPath: null, projectPath: '/tmp/project' };

    assert.deepEqual(
      await provider.forkSession({ ...input, upToAnchorId: 'msg_u1' }),
      { providerSessionId: 'ses_forked', jsonlPath: null },
    );
    await provider.forkSession({ ...input, upToAnchorId: 'msg_u3' });
    await provider.forkSession(input);
    assert.deepEqual(forks, [
      ['ses_src', 'msg_u2'],
      ['ses_src', null],
      ['ses_src', null],
    ]);
    await assert.rejects(provider.forkSession({ ...input, upToAnchorId: 'msg_gone' }), /no longer in the transcript/);
  });
});

test('resolveOpenCodeForkCut names the first prompt after the anchor', () => {
  const order = [
    { id: 'u1', role: 'user' as const },
    { id: 'a1', role: 'assistant' as const },
    { id: 'a1b', role: 'assistant' as const },
    { id: 'u2', role: 'user' as const },
  ];
  assert.equal(resolveOpenCodeForkCut(order, 'u1'), 'u2');
  assert.equal(resolveOpenCodeForkCut(order, 'a1'), 'u2');
  assert.equal(resolveOpenCodeForkCut(order, 'u2'), null);
});
