import assert from 'node:assert/strict';

import { test } from 'vitest';

import { revealRequestPaths } from '@/modules/file-tree/utils/revealDirectory';

/**
 * Regression guard: an in-chat directory reference is written the way the model
 * wrote it — usually relative, sometimes absolute — while the server lists
 * directories by paths relative to the project root.
 */

const ROOT = '/home/odoo/workspace/personal';

test('a relative reference lists every level from the project root down', () => {
  assert.deepEqual(revealRequestPaths(ROOT, 'decisions/'), ['decisions']);
  assert.deepEqual(revealRequestPaths(ROOT, 'src/modules/'), ['src', 'src/modules']);
});

test('an absolute reference inside the project resolves to the same levels', () => {
  assert.deepEqual(revealRequestPaths(ROOT, `${ROOT}/src/modules`), ['src', 'src/modules']);
});

test('a sibling directory that merely shares the root prefix reveals nothing', () => {
  assert.deepEqual(revealRequestPaths(ROOT, `${ROOT}-backup/src`), []);
});

test('a path outside the project, the root itself, and parent hops reveal nothing', () => {
  assert.deepEqual(revealRequestPaths(ROOT, '/etc/ssl'), []);
  assert.deepEqual(revealRequestPaths(ROOT, ROOT), []);
  assert.deepEqual(revealRequestPaths(ROOT, `${ROOT}/`), []);
  assert.deepEqual(revealRequestPaths(ROOT, '../elsewhere'), []);
  assert.deepEqual(revealRequestPaths(ROOT, 'src/../../elsewhere'), []);
});

test('windows separators, ./ prefixes and repeated slashes are levelled', () => {
  assert.deepEqual(revealRequestPaths(ROOT, './src//modules/./'), ['src', 'src/modules']);
  assert.deepEqual(
    revealRequestPaths('C:\\Users\\odoo\\personal', 'C:\\Users\\odoo\\personal\\src\\modules'),
    ['src', 'src/modules'],
  );
});

test('a project without a known root still reveals relative references', () => {
  assert.deepEqual(revealRequestPaths('', 'src/'), ['src']);
  assert.deepEqual(revealRequestPaths('', '/abs/src'), []);
});
