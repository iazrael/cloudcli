import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeDirectoryApi } from '@/modules/file-tree/tests/fakeDirectoryApi';
import type { FileTreeSearchResponse, Project } from '@/shared/types';

const ROOT = '/proj';

let fake: ReturnType<typeof createFakeDirectoryApi>;
const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    listDirectories: (projectId: string, paths: string[]) => fake.listDirectories(projectId, paths),
    searchFiles: (...args: unknown[]) => searchFiles(...args),
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'proj', fullPath: ROOT, path: ROOT };

const searchResponse: FileTreeSearchResponse = {
  results: [
    { name: 'app', type: 'directory', path: `${ROOT}/src/app`, relativePath: 'src/app' },
    { name: 'Button.tsx', type: 'file', path: `${ROOT}/src/app/Button.tsx`, relativePath: 'src/app/Button.tsx' },
  ],
  truncated: true,
  indexIncomplete: false,
};

describe('FileTree lazy rendering', () => {
  beforeEach(() => {
    fake = createFakeDirectoryApi(ROOT, {
      '': ['src/', 'empty/', 'locked/'],
      src: ['app/'],
      'src/app': ['Button.tsx'],
      empty: [],
      locked: [],
    });
    searchFiles.mockReset();
    searchFiles.mockImplementation(async () => new Response(JSON.stringify(searchResponse)));
  });

  it('marks an opened empty folder and offers a retry for a folder that failed', async () => {
    fake.refused.add('locked');
    render(<FileTree selectedProject={project} />);
    await waitFor(() => expect(screen.getByText('empty')).toBeTruthy());

    fireEvent.click(screen.getByText('empty'));
    await waitFor(() => expect(screen.getByText(/empty ?folder/i)).toBeTruthy());

    fireEvent.click(screen.getByText('locked'));
    await waitFor(() => expect(screen.getByText('Permission denied')).toBeTruthy());
    fake.refused.delete('locked');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.queryByText('Permission denied')).toBeNull());
    expect(fake.calls.at(-1)).toEqual([`${ROOT}/locked`]);
  });

  it('searches on the server and shows matches inside their folders', async () => {
    render(<FileTree selectedProject={project} />);
    await waitFor(() => expect(screen.getByText('src')).toBeTruthy());

    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' button ' } });

    await waitFor(() => expect(screen.getByText('Button.tsx')).toBeTruthy());
    expect(searchFiles).toHaveBeenCalledWith('p1', { query: 'button', limit: 200, type: 'any' }, expect.anything());
    // The browsing tree's root entries are replaced by the result tree.
    expect(screen.queryByText('empty')).toBeNull();
    expect(screen.getByText('app')).toBeTruthy();
    expect(screen.getByText(/searchTruncated|best matches|最相关/i)).toBeTruthy();
  });

  it('clicking a folder in the results leaves search and opens it in the tree', async () => {
    render(<FileTree selectedProject={project} />);
    await waitFor(() => expect(screen.getByText('src')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'app' } });
    await waitFor(() => expect(screen.getByText('Button.tsx')).toBeTruthy());

    fireEvent.click(screen.getByText('app'));

    await waitFor(() => expect(screen.getByText('empty')).toBeTruthy());
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(screen.getByText('Button.tsx')).toBeTruthy());
    expect(fake.calls).toContainEqual(['src', 'src/app']);
  });
});
