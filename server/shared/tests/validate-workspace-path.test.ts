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

test('validateWorkspacePath confines an unconfigured workspace to the home directory', async () => {
  const previousRoots = process.env.WORKSPACES_ROOTS;
  const previousRoot = process.env.WORKSPACES_ROOT;
  delete process.env.WORKSPACES_ROOTS;
  delete process.env.WORKSPACES_ROOT;

  try {
    assert.equal(getConfiguredWorkspaceRoots(), null);

    const homeResult = await validateWorkspacePath(os.homedir());
    assert.equal(homeResult.valid, true);

    // A sibling of the home directory is outside the documented default root.
    const outsideHome = path.join(path.dirname(os.homedir()), 'cloudcli-outside-home-test');
    const outsideResult = await validateWorkspacePath(outsideHome);
    assert.equal(outsideResult.valid, false);
    assert.match(outsideResult.error ?? '', /Workspace path must be within the allowed workspace roots/);

    // Drive/filesystem roots are refused even while browsing unless that root
    // is explicitly configured.
    const fsRoot = process.platform === 'win32' ? 'C:\\' : '/';
    assert.equal((await validateWorkspacePath(fsRoot)).valid, false);
    assert.equal((await validateWorkspacePath(fsRoot, { allowDriveRoot: true })).valid, false);
  } finally {
    if (previousRoots !== undefined) process.env.WORKSPACES_ROOTS = previousRoots;
    if (previousRoot !== undefined) process.env.WORKSPACES_ROOT = previousRoot;
  }
});

test('validateWorkspacePath treats WORKSPACES_ROOTS as the multi-root opt-in', async () => {
  const previousRoots = process.env.WORKSPACES_ROOTS;
  const previousRoot = process.env.WORKSPACES_ROOT;
    const fsRoot = process.platform === 'win32' ? 'C:\\' : '/';
  try {
    delete process.env.WORKSPACES_ROOT;
    process.env.WORKSPACES_ROOTS = fsRoot;
    assert.deepEqual(getConfiguredWorkspaceRoots(), [fsRoot]);

    // Browsing a configured drive root is allowed; creating a project there is
    // still refused by the drive-root rule.
    assert.equal((await validateWorkspacePath(fsRoot, { allowDriveRoot: true })).valid, true);
    assert.equal((await validateWorkspacePath(fsRoot)).valid, false);
  } finally {
    delete process.env.WORKSPACES_ROOTS;
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
