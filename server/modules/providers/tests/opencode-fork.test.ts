/**
 * OpenCode fork-cut tests.
 *
 * OpenCode's `fork` cut is exclusive, so the provider maps a turn-inclusive
 * anchor onto the next turn's first user message. Getting that mapping wrong
 * either drops the anchor's answer or drags in the following turn.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  readOpenCodeMessageOrder,
  resolveOpenCodeForkCut,
} from '@/modules/providers/list/opencode/opencode-fork.provider.js';

function createMessageDb(entries: Array<{ id: string; role: string }>): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
  entries.forEach((entry, index) => {
    insert.run(entry.id, 'ses_1', index, index, JSON.stringify({ role: entry.role }));
  });
  return db;
}

test('the fork cut keeps the anchor turn and stops before the next one', () => {
  const entries = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
    { id: 'u2', role: 'user' },
    { id: 'a2', role: 'assistant' },
  ];
  const db = createMessageDb(entries);
  try {
    const order = readOpenCodeMessageOrder(db, 'ses_1');
    assert.deepEqual(order, entries);

    // From the first prompt: keep its answer, drop the second turn.
    assert.equal(resolveOpenCodeForkCut(order, 'u1'), 'u2');
    // From the first answer: same whole-turn copy.
    assert.equal(resolveOpenCodeForkCut(order, 'a1'), 'u2');
    // From the last turn: there is no next prompt, so nothing is cut.
    assert.equal(resolveOpenCodeForkCut(order, 'u2'), null);
    assert.equal(resolveOpenCodeForkCut(order, 'a2'), null);
  } finally {
    db.close();
  }
});

test('an unknown fork anchor is reported rather than guessed at', () => {
  const db = createMessageDb([{ id: 'u1', role: 'user' }]);
  try {
    const order = readOpenCodeMessageOrder(db, 'ses_1');
    assert.throws(
      () => resolveOpenCodeForkCut(order, 'missing-message'),
      /no longer in the transcript/,
    );
  } finally {
    db.close();
  }
});
