import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLazyFileTree } from '@/modules/file-tree/hooks/useLazyFileTree';
import { createFakeDirectoryApi } from '@/modules/file-tree/tests/fakeDirectoryApi';
import type * as Api from '@/shared/api';
import type { FileTreeNode, Project } from '@/shared/types';

const listDirectories = vi.fn();

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof Api>();
  return {
    ...actual,
    api: { ...actual.api, listDirectories: (...args: unknown[]) => listDirectories(...args) },
  };
});

const ROOT = '/proj';
const project = { projectId: 'p1', displayName: 'proj', fullPath: ROOT, path: ROOT } as Project;

let fake: ReturnType<typeof createFakeDirectoryApi>;

const find = (items: FileTreeNode[], name: string) => items.find((item) => item.name === name);

async function renderTree(selected: Project = project) {
  const rendered = renderHook(({ current }) => useLazyFileTree(current), { initialProps: { current: selected } });
  await waitFor(() => expect(rendered.result.current.loading).toBe(false));
  return rendered;
}

describe('useLazyFileTree', () => {
  beforeEach(() => {
    fake = createFakeDirectoryApi(ROOT, {
      '': ['src/', 'docs/', 'empty/', 'secret/', 'README.md'],
      src: ['lib/', 'index.ts'],
      'src/lib': ['util.ts'],
      docs: ['guide.md'],
      empty: [],
      secret: [],
    });
    listDirectories.mockReset();
    listDirectories.mockImplementation(fake.listDirectories);
  });

  it('lists only the root when the project opens', async () => {
    const { result } = await renderTree();

    expect(fake.calls).toEqual([['']]);
    expect(result.current.items.map((item) => item.name)).toEqual(['src', 'docs', 'empty', 'secret', 'README.md']);
    expect(find(result.current.items, 'src')?.children).toBeUndefined();
  });

  it('loads a folder the first time it opens and reuses it when reopened', async () => {
    const { result } = await renderTree();

    act(() => result.current.toggleDirectory(`${ROOT}/src`));
    await waitFor(() => expect(find(result.current.items, 'src')?.children?.map((item) => item.name)).toEqual(['lib', 'index.ts']));
    expect(fake.calls).toEqual([[''], [`${ROOT}/src`]]);

    act(() => result.current.toggleDirectory(`${ROOT}/src`));
    expect(find(result.current.items, 'src')?.children).toBeUndefined();
    act(() => result.current.toggleDirectory(`${ROOT}/src`));
    expect(find(result.current.items, 'src')?.children?.map((item) => item.name)).toEqual(['lib', 'index.ts']);
    expect(fake.calls).toHaveLength(2);
  });

  it('reports an empty folder as loaded with no children', async () => {
    const { result } = await renderTree();

    act(() => result.current.toggleDirectory(`${ROOT}/empty`));
    await waitFor(() => expect(find(result.current.items, 'empty')?.children).toEqual([]));
  });

  it('shows a folder error and loads it again on retry', async () => {
    fake.refused.add('secret');
    const { result } = await renderTree();

    act(() => result.current.toggleDirectory(`${ROOT}/secret`));
    await waitFor(() => expect(find(result.current.items, 'secret')?.childrenStatus).toBe('error'));
    expect(find(result.current.items, 'secret')?.childrenError).toBe('Permission denied');

    fake.refused.delete('secret');
    act(() => result.current.retryDirectory(`${ROOT}/secret`));
    await waitFor(() => expect(find(result.current.items, 'secret')?.children).toEqual([]));
  });

  it('refresh re-reads the root and open folders only; collapsed ones reload when reopened', async () => {
    const { result } = await renderTree();
    act(() => result.current.toggleDirectory(`${ROOT}/src`));
    act(() => result.current.toggleDirectory(`${ROOT}/docs`));
    await waitFor(() => expect(find(result.current.items, 'docs')?.children).toHaveLength(1));
    await waitFor(() => expect(find(result.current.items, 'src')?.children).toHaveLength(2));
    act(() => result.current.toggleDirectory(`${ROOT}/docs`));
    fake.calls.length = 0;

    fake.directories.docs = ['guide.md', 'new.md'];
    act(() => result.current.refresh());
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect([...fake.calls[0]!].sort()).toEqual(['', `${ROOT}/src`]);

    act(() => result.current.toggleDirectory(`${ROOT}/docs`));
    await waitFor(() => expect(find(result.current.items, 'docs')?.children?.map((item) => item.name)).toEqual(['guide.md', 'new.md']));
  });

  it('drops an open folder that disappeared since it was opened', async () => {
    const { result } = await renderTree();
    act(() => result.current.toggleDirectory(`${ROOT}/docs`));
    await waitFor(() => expect(find(result.current.items, 'docs')?.children).toHaveLength(1));

    delete fake.directories.docs;
    fake.directories[''] = ['src/', 'README.md'];
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.expandedDirs.has(`${ROOT}/docs`)).toBe(false));
    expect(result.current.items.map((item) => item.name)).toEqual(['src', 'README.md']);
  });

  it('reopening a folder also re-reads the open folders inside it that went stale', async () => {
    const { result } = await renderTree();
    act(() => result.current.toggleDirectory(`${ROOT}/src`));
    await waitFor(() => expect(find(result.current.items, 'src')?.children).toHaveLength(2));
    act(() => result.current.toggleDirectory(`${ROOT}/src/lib`));
    await waitFor(() => expect(find(find(result.current.items, 'src')?.children ?? [], 'lib')?.children).toHaveLength(1));
    act(() => result.current.toggleDirectory(`${ROOT}/src`));

    act(() => result.current.refresh());
    await waitFor(() => expect(fake.calls.at(-1)).toEqual(['']));
    fake.directories['src/lib'] = ['util.ts', 'added.ts'];
    act(() => result.current.toggleDirectory(`${ROOT}/src`));

    await waitFor(() => expect(find(find(result.current.items, 'src')?.children ?? [], 'lib')?.children?.map((item) => item.name)).toEqual(['util.ts', 'added.ts']));
    expect(fake.calls.at(-1)).toEqual([`${ROOT}/src`, `${ROOT}/src/lib`]);
  });

  it('forgets the open folders inside a folder that disappeared', async () => {
    const { result } = await renderTree();
    act(() => result.current.toggleDirectory(`${ROOT}/src`));
    await waitFor(() => expect(find(result.current.items, 'src')?.children).toHaveLength(2));
    act(() => result.current.toggleDirectory(`${ROOT}/src/lib`));
    await waitFor(() => expect(result.current.expandedDirs.size).toBe(2));

    delete fake.directories.src;
    delete fake.directories['src/lib'];
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.expandedDirs.size).toBe(0));
  });

  it('reports why the root could not be listed', async () => {
    listDirectories.mockImplementation(async () => new Response(JSON.stringify({ error: 'Project not found' }), { status: 404 }));
    const { result } = await renderTree();

    expect(result.current.error).toBe('Project not found');
    expect(result.current.items).toEqual([]);
  });

  it('reveals a nested reference with one batched request', async () => {
    const { result } = await renderTree();
    fake.calls.length = 0;

    await act(async () => {
      await result.current.revealDirectory('src/lib/');
    });

    expect(fake.calls).toEqual([['src', 'src/lib']]);
    expect(result.current.expandedDirs).toEqual(new Set([`${ROOT}/src`, `${ROOT}/src/lib`]));
    const lib = find(find(result.current.items, 'src')?.children ?? [], 'lib');
    expect(lib?.children?.map((item) => item.name)).toEqual(['util.ts']);
  });

  it('stops revealing at the first level the tree does not show', async () => {
    // `dist` exists on disk but its parent listing hides it, like a gitignored folder.
    fake.directories['src/dist'] = ['bundle.js'];
    const { result } = await renderTree();

    await act(async () => {
      await result.current.revealDirectory(`${ROOT}/src/dist`);
    });

    expect(result.current.expandedDirs).toEqual(new Set([`${ROOT}/src`]));
  });

  it('starts over when the project changes', async () => {
    const { result, rerender } = await renderTree();
    act(() => result.current.toggleDirectory(`${ROOT}/src`));
    await waitFor(() => expect(find(result.current.items, 'src')?.children).toHaveLength(2));

    rerender({ current: { ...project, projectId: 'p2' } });

    await waitFor(() => expect(listDirectories).toHaveBeenLastCalledWith('p2', [''], expect.anything()));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.expandedDirs.size).toBe(0);
  });
});
