import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getConfiguredWorkspaceRoots,
  getAvailableWindowsDrives,
  isDriveOrFsRoot,
  isForbiddenSystemDirectory,
  validateWorkspacePath,
} from '@/shared/utils.js';

test('isDriveOrFsRoot correctly identifies drive and filesystem roots', () => {
  assert.equal(isDriveOrFsRoot('/'), true);
  assert.equal(isDriveOrFsRoot('C:\\'), true);
  assert.equal(isDriveOrFsRoot('C:'), true);
  assert.equal(isDriveOrFsRoot('E:\\'), true);
  assert.equal(isDriveOrFsRoot('d:'), true);

  assert.equal(isDriveOrFsRoot('C:\\Projects'), false);
  assert.equal(isDriveOrFsRoot('/home/user'), false);
  assert.equal(isDriveOrFsRoot('~'), false);
});

test('isForbiddenSystemDirectory blocks critical system directories', () => {
  assert.equal(isForbiddenSystemDirectory('/').forbidden, true);
  assert.equal(isForbiddenSystemDirectory('/etc').forbidden, true);
  assert.equal(isForbiddenSystemDirectory('/etc/passwd').forbidden, true);

  if (process.platform === 'win32') {
    assert.equal(isForbiddenSystemDirectory('C:\\Windows').forbidden, true);
    assert.equal(isForbiddenSystemDirectory('c:\\windows\\system32').forbidden, true);
    assert.equal(isForbiddenSystemDirectory('E:\\$RECYCLE.BIN').forbidden, true);
    assert.equal(isForbiddenSystemDirectory('D:\\System Volume Information').forbidden, true);
    assert.equal(isForbiddenSystemDirectory('E:\\Projects').forbidden, false);
  }
});

test('validateWorkspacePath allows projects outside home directory when WORKSPACES_ROOT is unconfigured', async () => {
  const previousRoots = process.env.WORKSPACES_ROOTS;
  const previousRoot = process.env.WORKSPACES_ROOT;
  delete process.env.WORKSPACES_ROOTS;
  delete process.env.WORKSPACES_ROOT;

  try {
    // Valid existing directory (the current repo workspace)
    const repoPath = process.cwd();
    const result = await validateWorkspacePath(repoPath);
    assert.equal(result.valid, true);
    assert.ok(result.resolvedPath);

    // Reject drive roots for workspace creation
    const driveRootResult = await validateWorkspacePath(process.platform === 'win32' ? 'C:\\' : '/');
    assert.equal(driveRootResult.valid, false);
    assert.match(driveRootResult.error ?? '', /Cannot use a drive root/);

    // Allow drive roots when explicitly browsing
    const browseDriveResult = await validateWorkspacePath(
      process.platform === 'win32' ? 'C:\\' : '/',
      { allowDriveRoot: true },
    );
    assert.equal(browseDriveResult.valid, true);
  } finally {
    if (previousRoots !== undefined) process.env.WORKSPACES_ROOTS = previousRoots;
    if (previousRoot !== undefined) process.env.WORKSPACES_ROOT = previousRoot;
  }
});

test('validateWorkspacePath enforces configured workspace roots when set', async () => {
  const previousRoots = process.env.WORKSPACES_ROOTS;
  const previousRoot = process.env.WORKSPACES_ROOT;

  try {
    const fakeRoot = path.join(os.tmpdir(), 'allowed-root');
    process.env.WORKSPACES_ROOT = fakeRoot;

    const result = await validateWorkspacePath(path.join(os.homedir(), 'some-other-place'));
    assert.equal(result.valid, false);
    assert.match(result.error ?? '', /Workspace path must be within the allowed workspace roots/);
  } finally {
    delete process.env.WORKSPACES_ROOTS;
    delete process.env.WORKSPACES_ROOT;
    if (previousRoots !== undefined) process.env.WORKSPACES_ROOTS = previousRoots;
    if (previousRoot !== undefined) process.env.WORKSPACES_ROOT = previousRoot;
  }
});

test('getAvailableWindowsDrives returns accessible drives on Windows', async () => {
  const drives = await getAvailableWindowsDrives();
  if (process.platform === 'win32') {
    assert.ok(Array.isArray(drives));
    assert.ok(drives.length > 0);
    assert.ok(drives.includes('C:\\'));
  } else {
    assert.deepEqual(drives, []);
  }
});
