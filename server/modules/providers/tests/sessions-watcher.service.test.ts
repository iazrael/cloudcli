import assert from 'node:assert/strict';
import test from 'node:test';

import { applySessionLifecycleDeltaToQueue } from '../services/sessions-watcher.service.js';

test('a restored session replaces its queued removal before the watcher flushes', () => {
  const updatedSessionIds = new Set<string>();
  const removedSessionIds = new Set<string>();

  applySessionLifecycleDeltaToQueue(updatedSessionIds, removedSessionIds, null, ['app-session-1']);
  applySessionLifecycleDeltaToQueue(updatedSessionIds, removedSessionIds, 'app-session-1', []);

  assert.deepEqual([...updatedSessionIds], ['app-session-1']);
  assert.deepEqual([...removedSessionIds], []);
});

test('a later removal replaces its queued update before the watcher flushes', () => {
  const updatedSessionIds = new Set<string>();
  const removedSessionIds = new Set<string>();

  applySessionLifecycleDeltaToQueue(updatedSessionIds, removedSessionIds, 'app-session-1', []);
  applySessionLifecycleDeltaToQueue(updatedSessionIds, removedSessionIds, null, ['app-session-1']);

  assert.deepEqual([...updatedSessionIds], []);
  assert.deepEqual([...removedSessionIds], ['app-session-1']);
});
