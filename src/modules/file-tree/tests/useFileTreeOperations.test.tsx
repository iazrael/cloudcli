import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '@/shared/types';

const createFile = vi.fn();
const renameFile = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    createFile: (...args: unknown[]) => createFile(...args),
    renameFile: (...args: unknown[]) => renameFile(...args),
    readFileBlob: vi.fn(),
  },
}));

const { useFileTreeOperations } = await import('@/modules/file-tree/hooks/useFileTreeOperations');

const project: Project = { projectId: 'p1', displayName: 'proj', fullPath: '/proj', path: '/proj' };

function okResponse() {
  return { ok: true, json: async () => ({}) } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('useFileTreeOperations duplicate confirmation guard', () => {
  beforeEach(() => {
    createFile.mockReset();
    renameFile.mockReset();
  });

  it('fires one create request when Enter and the blur fallback both confirm', async () => {
    const pending = deferred<Response>();
    createFile.mockReturnValue(pending.promise);
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileTreeOperations({ selectedProject: project, onRefresh: vi.fn(), showToast }),
    );

    act(() => result.current.handleStartCreate('', 'directory'));
    act(() => result.current.setNewItemName('raw'));

    // Enter sends the request; the request disables the input, which blurs it
    // and arms the 100ms fallback while the first request is still in flight.
    let first!: Promise<void>;
    act(() => { first = result.current.handleConfirmCreate(); });
    act(() => { void result.current.handleConfirmCreate(); });
    pending.resolve(okResponse());
    await act(async () => { await first; });

    expect(createFile).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls.filter(([message]) => String(message).includes('already exists'))).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith('Folder created successfully', 'success');
  });

  it('fires one rename request when Enter and the blur fallback both confirm', async () => {
    const pending = deferred<Response>();
    renameFile.mockReturnValue(pending.promise);
    const showToast = vi.fn();
    const { result } = renderHook(() =>
      useFileTreeOperations({ selectedProject: project, onRefresh: vi.fn(), showToast }),
    );

    act(() => result.current.handleStartRename({ name: 'a.txt', type: 'file', path: '/proj/a.txt' }));
    act(() => result.current.setRenameValue('b.txt'));

    let first!: Promise<void>;
    act(() => { first = result.current.handleConfirmRename(); });
    act(() => { void result.current.handleConfirmRename(); });
    pending.resolve(okResponse());
    await act(async () => { await first; });

    expect(renameFile).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls.filter(([message]) => String(message).includes('not found'))).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith('Renamed successfully', 'success');
  });

  it('allows a second create after the first one finished', async () => {
    createFile.mockResolvedValue(okResponse());
    const { result } = renderHook(() =>
      useFileTreeOperations({ selectedProject: project, onRefresh: vi.fn(), showToast: vi.fn() }),
    );

    act(() => result.current.handleStartCreate('', 'file'));
    act(() => result.current.setNewItemName('one.txt'));
    await act(async () => { await result.current.handleConfirmCreate(); });

    act(() => result.current.handleStartCreate('', 'file'));
    act(() => result.current.setNewItemName('two.txt'));
    await act(async () => { await result.current.handleConfirmCreate(); });

    expect(createFile).toHaveBeenCalledTimes(2);
  });
});
