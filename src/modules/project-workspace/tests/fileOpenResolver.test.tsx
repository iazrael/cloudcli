import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard: an absolute path must open the file it names.
 *
 * `findBestMatch` falls back to matching by filename, which is what makes bare
 * references like `foo.ts` work. Applied to an absolute path it silently
 * rewrote the reference: asking for `/home/user/.config/CLAUDE.md` opened the
 * project's own `CLAUDE.md` — a different file, with no error, indistinguishable
 * from the right one.
 */

const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { searchFiles: (...args: unknown[]) => searchFiles(...args) },
}));

const { useFileOpenResolver } = await import('@/modules/project-workspace/hooks/useFileOpenResolver');

const ROOT = '/home/odoo/workspace/personal';
const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT };

// The project's files; the fake server matches the query against their paths
// like the real search, putting the shortest path first.
let projectFiles = ['CLAUDE.md', 'src/foo.ts'];

const answerSearch = async (_projectId: string, { query }: { query: string }) => ({
  ok: true,
  json: async () => ({
    results: projectFiles
      .filter((relativePath) => relativePath.toLowerCase().includes(query.toLowerCase()))
      .sort((left, right) => left.length - right.length)
      .map((relativePath) => ({
        type: 'file',
        name: relativePath.split('/').pop(),
        path: `${ROOT}/${relativePath}`,
        relativePath,
      })),
    truncated: false,
    indexIncomplete: false,
  }),
});

const setup = () => {
  searchFiles.mockReset();
  searchFiles.mockImplementation(answerSearch);
  const onFileOpen = vi.fn();
  const { result } = renderHook(() => useFileOpenResolver(project, onFileOpen));
  return { resolve: result.current, onFileOpen };
};

test('an absolute path outside the project is passed through untouched', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('/home/odoo/.claude/CLAUDE.md');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], '/home/odoo/.claude/CLAUDE.md');
  // It does not even need a search, so no request goes out.
  assert.equal(searchFiles.mock.calls.length, 0);
});

test('an absolute path inside the project resolves to itself, as before', async () => {
  const { resolve, onFileOpen } = setup();
  resolve(`${ROOT}/src/foo.ts`);
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);
});

test('partial references still match against the project files', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('foo.ts');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);
  // Searched by the file name, which every candidate must contain.
  assert.deepEqual(searchFiles.mock.calls[0].slice(0, 2), ['p1', { query: 'foo.ts', limit: 200, type: 'file' }]);

  const second = setup();
  second.resolve('src/foo.ts');
  await waitFor(() => assert.equal(second.onFileOpen.mock.calls.length, 1));
  assert.equal(second.onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);
});

test('diffInfo and line survive the absolute-path shortcut', async () => {
  const { resolve, onFileOpen } = setup();
  const diffInfo = { old_string: 'a', new_string: 'b' };
  resolve('/home/odoo/.claude/CLAUDE.md', diffInfo, 150);
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.deepEqual(onFileOpen.mock.calls[0].slice(1), [diffInfo, 150]);
});

test('surrounding whitespace never reaches the API as part of the path', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('  /home/odoo/.claude/CLAUDE.md ');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], '/home/odoo/.claude/CLAUDE.md');

  const second = setup();
  second.resolve('nope.ts ');
  await waitFor(() => assert.equal(second.onFileOpen.mock.calls.length, 1));
  assert.equal(second.onFileOpen.mock.calls[0][0], 'nope.ts');
});

test('a path suffix beats a shorter same-named file, and the bare name is the fallback', async () => {
  projectFiles = ['lib/foo.ts', 'src/utils/foo.ts'];
  try {
    const { resolve, onFileOpen } = setup();
    resolve('utils/foo.ts');
    await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
    assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/utils/foo.ts`);

    const second = setup();
    second.resolve('other/foo.ts');
    await waitFor(() => assert.equal(second.onFileOpen.mock.calls.length, 1));
    assert.equal(second.onFileOpen.mock.calls[0][0], `${ROOT}/lib/foo.ts`);
  } finally {
    projectFiles = ['CLAUDE.md', 'src/foo.ts'];
  }
});
