import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';

async function withDatabase(run: (id: number) => void): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'queue-drafts-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    const user = userDb.createUser('queue-test', 'hash');
    sessionsDb.createAppSession('session', 'claude', directory, 'Queue');
    run(Number(user.id));
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
const message = (content: string) => ({ content, attachments: [] });

test('A/B/C append atomically, preserve files, use latest options, and text writes cannot overwrite the queue', async () => {
  await withDatabase((id) => {
    sessionDraftsDb.saveDraft(id, 'session', { text: 'draft', queuedMessage: { content: 'A', images: [{ name: 'a' }], options: { model: 'old' } } });
    const result = sessionDraftsDb.appendQueuedMessage(id, 'session', { content: 'B', attachments: [{ name: 'b' }], options: { model: 'new' } });
    assert.equal(result?.appended, true);
    sessionDraftsDb.appendQueuedMessage(id, 'session', { content: 'C', attachments: [{ name: 'c' }] });
    sessionDraftsDb.saveDraftText(id, 'session', 'typing');
    sessionDraftsDb.deleteDraft(id, 'session');
    assert.deepEqual(sessionDraftsDb.getDrafts(id)[0]?.queuedMessage, { content: 'A\n\nB\n\nC', attachments: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], options: { model: 'new' } });
    assert.equal(sessionDraftsDb.getDrafts(id)[0]?.text, '');
  });
});

test('stale claim loses to append; successful claim isolates subsequent append and restores once in order', async () => {
  await withDatabase((id) => {
    sessionDraftsDb.appendQueuedMessage(id, 'session', message('A'));
    const stale = sessionDraftsDb.listQueuedMessages()[0];
    sessionDraftsDb.appendQueuedMessage(id, 'session', message('B'));
    assert.equal(sessionDraftsDb.claimQueuedMessage(stale), false);
    const claim = sessionDraftsDb.listQueuedMessages()[0];
    assert.equal(sessionDraftsDb.claimQueuedMessage(claim), true);
    assert.equal(sessionDraftsDb.claimQueuedMessage(claim), false);
    assert.equal(sessionDraftsDb.appendQueuedMessage(id, 'session', message('C'))?.appended, false);
    sessionDraftsDb.restoreQueuedMessage(claim);
    sessionDraftsDb.restoreQueuedMessage(claim);
    assert.deepEqual(sessionDraftsDb.getDrafts(id)[0]?.queuedMessage, message('A\n\nB\n\nC'));
  });
});

test('slash conflicts are rejected both before and during claims and restored commands stay commands', async () => {
  await withDatabase((id) => {
    for (const [first, next] of [['/compact', 'B'], ['A', '/compact'], ['/compact', '/help']]) {
      sessionDraftsDb.clearQueuedMessage(id, 'session');
      sessionDraftsDb.appendQueuedMessage(id, 'session', message(first));
      assert.equal(sessionDraftsDb.appendQueuedMessage(id, 'session', message(next)), null);
      const claim = sessionDraftsDb.listQueuedMessages()[0];
      assert.equal(sessionDraftsDb.claimQueuedMessage(claim), true);
      assert.equal(sessionDraftsDb.appendQueuedMessage(id, 'session', message(next)), null);
      sessionDraftsDb.restoreQueuedMessage(claim);
      assert.deepEqual(sessionDraftsDb.getDrafts(id)[0]?.queuedMessage, message(first));
    }
  });
});

test('clear and requeue during a claim preserves the new message when the claim completes', async () => {
  await withDatabase((id) => {
    sessionDraftsDb.appendQueuedMessage(id, 'session', message('A'));
    const claim = sessionDraftsDb.listQueuedMessages()[0];
    sessionDraftsDb.claimQueuedMessage(claim);
    sessionDraftsDb.appendQueuedMessage(id, 'session', message('B'));
    sessionDraftsDb.clearQueuedMessage(id, 'session');
    sessionDraftsDb.saveDraftText(id, 'session', '');
    sessionDraftsDb.deleteEmptyDraft(id, 'session');
    sessionDraftsDb.appendQueuedMessage(id, 'session', message('C'));
    sessionDraftsDb.completeQueuedMessage(claim);
    sessionDraftsDb.restoreQueuedMessage(claim);
    assert.deepEqual(sessionDraftsDb.getDrafts(id)[0]?.queuedMessage, message('C'));
  });
});

test('unacknowledged claims survive closing the connection and are recovered before newer messages', async () => {
  await withDatabase((id) => {
    sessionDraftsDb.appendQueuedMessage(id, 'session', message('A'));
    const claim = sessionDraftsDb.listQueuedMessages()[0];
    sessionDraftsDb.claimQueuedMessage(claim);
    sessionDraftsDb.appendQueuedMessage(id, 'session', message('B'));
    closeConnection();
    getConnection();
    const recovered = sessionDraftsDb.listQueuedMessages()[0];
    assert.deepEqual(recovered.queuedMessage, message('A\n\nB'));
    assert.equal(sessionDraftsDb.claimQueuedMessage(recovered), true);
    sessionDraftsDb.completeQueuedMessage(recovered);
    assert.deepEqual(sessionDraftsDb.getDrafts(id), []);
  });
});

test('attachments-only queues merge; clear preserves text and affects only the authenticated user', async () => {
  await withDatabase((id) => {
    sessionDraftsDb.saveDraftText(id, 'session', 'draft');
    sessionDraftsDb.appendQueuedMessage(id, 'session', { content: '', attachments: [{ name: 'a' }] });
    sessionDraftsDb.appendQueuedMessage(id, 'session', message('B'));
    assert.deepEqual(sessionDraftsDb.getDrafts(id)[0]?.queuedMessage, { content: 'B', attachments: [{ name: 'a' }] });
    sessionDraftsDb.clearQueuedMessage(id + 1, 'session');
    assert.notEqual(sessionDraftsDb.getDrafts(id)[0]?.queuedMessage, null);
    sessionDraftsDb.clearQueuedMessage(id, 'session');
    assert.equal(sessionDraftsDb.getDrafts(id)[0]?.text, 'draft');
    assert.equal(sessionDraftsDb.getDrafts(id)[0]?.queuedMessage, null);
  });
});

test('compare-and-clear refuses stale, absent and reserved queues without touching newer text or messages', async () => {
  await withDatabase((id) => {
    sessionDraftsDb.saveDraftText(id, 'session', 'typing');
    sessionDraftsDb.appendQueuedMessage(id, 'session', message('A'));
    sessionDraftsDb.appendQueuedMessage(id, 'session', message('B'));
    assert.equal(sessionDraftsDb.clearQueuedMessage(id, 'session', message('A')), false);
    const claim = sessionDraftsDb.listQueuedMessages()[0];
    assert.equal(sessionDraftsDb.claimQueuedMessage(claim), true);
    assert.equal(sessionDraftsDb.clearQueuedMessage(id, 'session', message('A\n\nB')), false);
    sessionDraftsDb.appendQueuedMessage(id, 'session', message('C'));
    assert.equal(sessionDraftsDb.clearQueuedMessage(id, 'session', message('C')), false);
    sessionDraftsDb.restoreQueuedMessage(claim);
    assert.equal(sessionDraftsDb.clearQueuedMessage(id, 'session', message('A\n\nB\n\nC')), true);
    assert.equal(sessionDraftsDb.getDrafts(id)[0]?.text, 'typing');
    assert.equal(sessionDraftsDb.clearQueuedMessage(id, 'session', message('A')), false);
  });
});
