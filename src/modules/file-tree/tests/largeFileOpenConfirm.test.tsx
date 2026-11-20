import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeDirectoryApi } from '@/modules/file-tree/tests/fakeDirectoryApi';
import type { Project } from '@/shared/types';
import type * as SharedUtils from '@/shared/utils';

const ROOT = '/proj';
const LARGE_FILE_BYTES = 21 * 1024 * 1024;

let fake: ReturnType<typeof createFakeDirectoryApi>;
const searchFiles = vi.fn();
const onFileOpen = vi.fn();
const saveOrShareBlob = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    listDirectories: (projectId: string, paths: string[]) => fake.listDirectories(projectId, paths),
    searchFiles: (...args: unknown[]) => searchFiles(...args),
    readFileBlob: async () => new Response(JSON.stringify({ content: 'bytes' }), { status: 200 }),
  },
}));

vi.mock('@/shared/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedUtils>();
  return { ...actual, saveOrShareBlob: (...args: unknown[]) => saveOrShareBlob(...args) };
});

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'proj', fullPath: ROOT, path: ROOT };

describe('FileTree large file open confirm', () => {
  beforeEach(() => {
    fake = createFakeDirectoryApi(
      ROOT,
      { '': ['big.html', 'plain.txt'] },
      // `plain.txt` carries no size on its node, like entries whose listing
      // omitted it; only `big.html` crosses the ask-before-open threshold.
      { 'big.html': LARGE_FILE_BYTES },
    );
    searchFiles.mockReset();
    searchFiles.mockImplementation(async () => new Response(JSON.stringify({ results: [], truncated: false, indexIncomplete: false })));
    onFileOpen.mockReset();
    saveOrShareBlob.mockReset();
    saveOrShareBlob.mockResolvedValue(undefined);
  });

  it('opens a file below the threshold directly, without asking', async () => {
    render(<FileTree selectedProject={project} onFileOpen={onFileOpen} />);
    await waitFor(() => expect(screen.getByText('plain.txt')).toBeTruthy());

    fireEvent.click(screen.getByText('plain.txt'));

    expect(onFileOpen).toHaveBeenCalledWith(`${ROOT}/plain.txt`);
    expect(screen.queryByText(/Download instead/i)).toBeNull();
  });

  it('asks before opening a file larger than the threshold and opens on confirmation', async () => {
    render(<FileTree selectedProject={project} onFileOpen={onFileOpen} />);
    await waitFor(() => expect(screen.getByText('big.html')).toBeTruthy());

    fireEvent.click(screen.getByText('big.html'));

    // The dialog is up and the editor was not started behind it.
    await waitFor(() => expect(screen.getByText(/Download instead/i)).toBeTruthy());
    expect(onFileOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Open anyway/i }));
    await waitFor(() => expect(onFileOpen).toHaveBeenCalledWith(`${ROOT}/big.html`));
    expect(screen.queryByText(/Download instead/i)).toBeNull();
  });

  it('offers a direct download from the confirm dialog instead of opening', async () => {
    render(<FileTree selectedProject={project} onFileOpen={onFileOpen} />);
    await waitFor(() => expect(screen.getByText('big.html')).toBeTruthy());

    fireEvent.click(screen.getByText('big.html'));
    await waitFor(() => expect(screen.getByText(/Download instead/i)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Download instead/i }));
    await waitFor(() => expect(saveOrShareBlob).toHaveBeenCalledTimes(1));
    const saved = saveOrShareBlob.mock.calls[0];
    expect((saved[1] as string)).toBe('big.html');
    expect(onFileOpen).not.toHaveBeenCalled();
    expect(screen.queryByText(/Download instead/i)).toBeNull();
  });

  it('cancelling the dialog opens nothing', async () => {
    render(<FileTree selectedProject={project} onFileOpen={onFileOpen} />);
    await waitFor(() => expect(screen.getByText('big.html')).toBeTruthy());

    fireEvent.click(screen.getByText('big.html'));
    await waitFor(() => expect(screen.getByText(/Download instead/i)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(screen.queryByText(/Download instead/i)).toBeNull();
    expect(onFileOpen).not.toHaveBeenCalled();
    expect(saveOrShareBlob).not.toHaveBeenCalled();
  });
});
