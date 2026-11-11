import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFileTreeUpload } from '@/modules/file-tree/hooks/useFileTreeUpload';
import type * as Api from '@/shared/api';
import type { Project } from '@/shared/types';

const upload = vi.fn();

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  authenticatedUpload: (...args: unknown[]) => upload(...args),
}));

const project = { projectId: 'p1', displayName: 'p1', fullPath: '/tmp/p1' } as Project;

const run = async () => {
  const showToast = vi.fn();
  const onRefresh = vi.fn();
  const { result } = renderHook(() => useFileTreeUpload({ selectedProject: project, onRefresh, showToast }));
  await act(async () => { await result.current.uploadFiles([new File(['x'], 'a.txt')]); });
  return { showToast, onRefresh };
};

describe('useFileTreeUpload', () => {
  beforeEach(() => { upload.mockReset(); });

  it('uploads to the project endpoint and reports success', async () => {
    upload.mockResolvedValue(new Response(JSON.stringify({ uploadedCount: 1, requestedFileCount: 1 })));
    const { showToast, onRefresh } = await run();
    expect(upload.mock.calls[0][0]).toBe('/api/file-tree/projects/p1/files/upload');
    expect(upload.mock.calls[0][1].method).toBe('POST');
    expect(showToast).toHaveBeenCalledWith('Uploaded 1 file successfully', 'success');
    expect(onRefresh).toHaveBeenCalled();
  });

  it('shows the server error from a failed response', async () => {
    upload.mockResolvedValue(new Response(JSON.stringify({ error: 'Disk full' }), { status: 507 }));
    const { showToast } = await run();
    expect(showToast).toHaveBeenCalledWith('Disk full', 'error');
  });

  it('falls back to the status for a non-JSON failure', async () => {
    upload.mockResolvedValue(new Response('<html>', { status: 502 }));
    const { showToast } = await run();
    expect(showToast).toHaveBeenCalledWith('Upload failed with status 502', 'error');
  });

  it('keeps the connection hint for a network failure', async () => {
    upload.mockRejectedValue(new TypeError('Failed to fetch'));
    const { showToast } = await run();
    expect(showToast).toHaveBeenCalledWith('Upload failed. Check your connection and try again.', 'error');
  });
});
