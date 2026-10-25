import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { isSystemTemporaryWorkspacePath } from '@/shared/utils.js';

test('isSystemTemporaryWorkspacePath rejects the temporary-directory roots themselves', () => {
  assert.equal(isSystemTemporaryWorkspacePath(os.tmpdir()), true);
  if (process.platform === 'win32') {
    // The POSIX staging roots are not part of a Windows root list; only the OS
    // temporary directory is.
    assert.equal(isSystemTemporaryWorkspacePath('/tmp'), false);
    return;
  }
  assert.equal(isSystemTemporaryWorkspacePath('/tmp'), true);
  // Trailing separators must not break the match.
  assert.equal(isSystemTemporaryWorkspacePath('/tmp/'), true);
  assert.equal(isSystemTemporaryWorkspacePath('/private/tmp'), true);
});

test('isSystemTemporaryWorkspacePath rejects directories nested inside a temporary root', () => {
  // The reported shape: engine-driven scratch runs (task review sandboxes,
  // test fixtures) record a directory below the user temporary root as their
  // workspace, and those cluttered the project list.
  assert.equal(isSystemTemporaryWorkspacePath(path.join(os.tmpdir(), 'task-review-X3ZEvD')), true);
  assert.equal(isSystemTemporaryWorkspacePath(path.join(os.tmpdir(), 'a', 'b', 'c')), true);
  if (process.platform !== 'win32') {
    assert.equal(isSystemTemporaryWorkspacePath('/tmp/some-scratch'), true);
    assert.equal(isSystemTemporaryWorkspacePath('/private/tmp/some-scratch'), true);
  }
});

test('isSystemTemporaryWorkspacePath matches the /private alias of the temporary root', { skip: process.platform !== 'darwin' }, () => {
  // macOS records real paths (/private/var/folders/...) while os.tmpdir()
  // returns the /var/folders/... alias for the same directory, so the roots
  // must be compared in both spellings.
  const realTemporaryRoot = fsSync.realpathSync(os.tmpdir());
  assert.notEqual(realTemporaryRoot, os.tmpdir());
  assert.equal(isSystemTemporaryWorkspacePath(realTemporaryRoot), true);
  assert.equal(isSystemTemporaryWorkspacePath(path.join(realTemporaryRoot, 'task-review-X3ZEvD')), true);
  assert.equal(isSystemTemporaryWorkspacePath('/private/var/folders/task-review-X3ZEvD'), true);
});

test('isSystemTemporaryWorkspacePath keeps real user projects', () => {
  assert.equal(isSystemTemporaryWorkspacePath('/Users/azrael/workspaces/cloudcli'), false);
  assert.equal(isSystemTemporaryWorkspacePath('/home/dev/my-project'), false);
  // A directory whose name merely extends a root's name is not inside it.
  assert.equal(isSystemTemporaryWorkspacePath('/var/folders2/project'), false);
  assert.equal(isSystemTemporaryWorkspacePath('/var/folders-sibling/project'), false);
  assert.equal(isSystemTemporaryWorkspacePath('/tmp-mirror/build'), false);
  // Empty / whitespace-only paths carry no workspace information.
  assert.equal(isSystemTemporaryWorkspacePath(''), false);
  assert.equal(isSystemTemporaryWorkspacePath('   '), false);
});
