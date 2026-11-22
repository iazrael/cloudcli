import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
} from '@/modules/database/index.js';

import {
  buildNotificationPayload,
} from '../services/notification-orchestrator.service.js';
import {
  clearSessionReplyPreview,
  getSessionReplyPreview,
  rememberSessionReplyPreview,
  PREVIEW_REGISTRY_CAPACITY,
} from '../services/run-notification-content.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notification-preview-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

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
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('reply preview registry remembers, overwrites and clears per session', () => {
  rememberSessionReplyPreview('sess-a', 'first reply');
  assert.equal(getSessionReplyPreview('sess-a'), 'first reply');

  // A later text row for the same session (streaming upsert or next segment)
  // replaces the remembered snippet instead of stacking.
  rememberSessionReplyPreview('sess-a', 'second reply');
  assert.equal(getSessionReplyPreview('sess-a'), 'second reply');

  rememberSessionReplyPreview('sess-b', 'other session');
  assert.equal(getSessionReplyPreview('sess-a'), 'second reply');

  clearSessionReplyPreview('sess-a');
  assert.equal(getSessionReplyPreview('sess-a'), null);
  assert.equal(getSessionReplyPreview('sess-b'), 'other session');
  clearSessionReplyPreview('sess-b');
});

test('reply preview registry evicts the oldest session beyond its capacity', () => {
  const first = 'evict-0';
  rememberSessionReplyPreview(first, 'oldest');
  for (let i = 1; i < PREVIEW_REGISTRY_CAPACITY; i += 1) {
    rememberSessionReplyPreview(`evict-${i}`, `reply-${i}`);
  }
  assert.equal(getSessionReplyPreview(first), 'oldest');

  // One more session pushes the oldest entry out of the bounded map.
  rememberSessionReplyPreview('evict-new', 'newest');
  assert.equal(getSessionReplyPreview(first), null);
  assert.equal(getSessionReplyPreview('evict-new'), 'newest');
  for (let i = 1; i < PREVIEW_REGISTRY_CAPACITY; i += 1) {
    clearSessionReplyPreview(`evict-${i}`);
  }
  clearSessionReplyPreview('evict-new');
});

test('a completed stop with a remembered reply puts the reply snippet in the body', async () => {
  await withIsolatedDatabase(() => {
    rememberSessionReplyPreview('app-preview-1', '验收跑完了，三个用例全绿。');
    const payload = buildNotificationPayload({
      provider: 'codex',
      sessionId: 'app-preview-1',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });
    assert.equal(payload.body, '验收跑完了，三个用例全绿。');
    clearSessionReplyPreview('app-preview-1');
  });
});

test('a long reply preview collapses whitespace and truncates with an ellipsis', async () => {
  await withIsolatedDatabase(() => {
    rememberSessionReplyPreview('app-preview-2', `第一行\n${'很长的一句'.repeat(40)}`);
    const payload = buildNotificationPayload({
      provider: 'codex',
      sessionId: 'app-preview-2',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });
    assert.ok(payload.body.length <= 161, `body too long: ${payload.body.length}`);
    assert.ok(!payload.body.includes('\n'));
    assert.ok(payload.body.endsWith('…'));
    clearSessionReplyPreview('app-preview-2');
  });
});

test('an aborted stop prefixes the snippet so the user can tell it apart', async () => {
  await withIsolatedDatabase(() => {
    rememberSessionReplyPreview('app-preview-3', '写到一半的回复');
    const payload = buildNotificationPayload({
      provider: 'claude',
      sessionId: 'app-preview-3',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'aborted' },
    });
    assert.equal(payload.body, 'Stopped — 写到一半的回复');
    clearSessionReplyPreview('app-preview-3');
  });
});

test('a stop without a remembered reply keeps the legacy status-word body', async () => {
  await withIsolatedDatabase(() => {
    const payload = buildNotificationPayload({
      provider: 'codex',
      sessionId: 'app-preview-none',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });
    assert.equal(payload.body, 'Codex: completed');
  });
});

test('a failed run keeps the error body even when a reply preview exists', async () => {
  await withIsolatedDatabase(() => {
    rememberSessionReplyPreview('app-preview-4', '无关的旧回复');
    const payload = buildNotificationPayload({
      provider: 'antigravity',
      sessionId: 'app-preview-4',
      kind: 'error',
      code: 'run.failed',
      meta: { error: 'Our servers are experiencing high traffic right now.' },
    });
    assert.equal(payload.body, 'Antigravity: Run Failed: Our servers are experiencing high traffic right now.');
    clearSessionReplyPreview('app-preview-4');
  });
});
