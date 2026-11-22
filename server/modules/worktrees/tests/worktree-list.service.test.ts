import assert from 'node:assert/strict';
import test from 'node:test';

import { listWorktrees } from '@/modules/worktrees/services/worktree-list.service.js';
import type { GitCommandResult } from '@/shared/types.js';

test('listWorktrees bounds concurrent per-worktree Git inspection and preserves ordering', async () => {
  const entryCount = 10;
  const porcelain = Array.from({ length: entryCount }, (_, index) => [
    `worktree /workspace/repo-${index}`,
    `HEAD ${String(index).padStart(40, '0')}`,
    `branch refs/heads/${index === 0 ? 'main' : `feature/${index}`}`,
    '',
  ].join('\n')).join('\n');
  let activeCommands = 0;
  let maximumActiveCommands = 0;

  const runGit = async (args: string[]): Promise<GitCommandResult> => {
    if (args[0] === 'worktree') {
      return { stdout: porcelain, stderr: '' };
    }

    activeCommands += 1;
    maximumActiveCommands = Math.max(maximumActiveCommands, activeCommands);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeCommands -= 1;

    if (args[0] === 'log') {
      return { stdout: 'subject\0' + '2026-01-01T00:00:00Z', stderr: '' };
    }
    if (args[0] === 'rev-list') {
      return { stdout: '0 1', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const result = await listWorktrees(
    { projectPath: '/workspace/repo-0' },
    { runGit, getProjectByPath: () => null },
  );

  assert.equal(maximumActiveCommands <= 12, true);
  assert.deepEqual(result.worktrees.map((worktree) => worktree.path.replace(/\\/g, '/')),
    Array.from({ length: entryCount }, (_, index) => `/workspace/repo-${index}`));
});

test('listWorktrees keeps prunable entries without inspecting their missing directory', async () => {
  // Real-world shape: release-pipeline worktrees under /tmp whose directories
  // were deleted leave prunable registrations behind; Git cannot run inside
  // them (spawn ENOENT) and one such failure used to blank the whole list.
  const porcelain = [
    'worktree /workspace/repo',
    'HEAD ' + 'a'.repeat(40),
    'branch refs/heads/main',
    '',
    'worktree /workspace/repo/.worktrees/feature',
    'HEAD ' + 'b'.repeat(40),
    'branch refs/heads/feature',
    '',
    'worktree /tmp/gone',
    'HEAD ' + 'c'.repeat(40),
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');

  const inspectedPaths: string[] = [];
  const runGit = async (args: string[]): Promise<GitCommandResult> => {
    if (args[0] === 'worktree') {
      return { stdout: porcelain, stderr: '' };
    }
    if (args[0] === 'status') {
      inspectedPaths.push(args[1] ?? '');
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'log') {
      if (args[1] === '/tmp/gone') {
        throw new Error('spawn git ENOENT');
      }
      return { stdout: 'subject\0' + '2026-01-01T00:00:00Z', stderr: '' };
    }
    if (args[0] === 'rev-list') {
      return { stdout: '0 1', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const result = await listWorktrees(
    { projectPath: '/workspace/repo' },
    { runGit, getProjectByPath: () => null },
  );

  assert.equal(result.worktrees.length, 3);
  const gone = result.worktrees.find((worktree) => worktree.path === '/tmp/gone');
  assert.ok(gone, 'the prunable entry stays in the list');
  assert.equal(gone.isPrunable, true);
  assert.equal(gone.changedFileCount, 0);
  // The prunable directory is never touched: no `git status` ran inside it.
  assert.equal(inspectedPaths.includes('/tmp/gone'), false);
});

test('listWorktrees survives a per-entry git failure without dropping the list', async () => {
  const porcelain = [
    'worktree /workspace/repo',
    'HEAD ' + 'a'.repeat(40),
    'branch refs/heads/main',
    '',
    'worktree /workspace/repo/.worktrees/broken',
    'HEAD ' + 'b'.repeat(40),
    'branch refs/heads/broken',
    '',
  ].join('\n');

  const runGit = async (args: string[]): Promise<GitCommandResult> => {
    if (args[0] === 'worktree') {
      return { stdout: porcelain, stderr: '' };
    }
    if (args[0] === 'status' && args[1]?.endsWith('/broken')) {
      throw new Error('git died');
    }
    if (args[0] === 'log') {
      return { stdout: 'subject\0' + '2026-01-01T00:00:00Z', stderr: '' };
    }
    if (args[0] === 'rev-list') {
      return { stdout: '0 1', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const result = await listWorktrees(
    { projectPath: '/workspace/repo' },
    { runGit, getProjectByPath: () => null },
  );

  assert.equal(result.worktrees.length, 2);
  const broken = result.worktrees.find((worktree) => worktree.path.endsWith('/broken'));
  assert.ok(broken, 'the failing entry stays in the list');
  assert.equal(broken.changedFileCount, 0);
  assert.equal(broken.isPrunable, false);
});
