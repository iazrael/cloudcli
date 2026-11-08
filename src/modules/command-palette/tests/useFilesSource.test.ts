import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFilesSource } from '@/modules/command-palette/hooks/useFilesSource';
import type * as Api from '@/shared/api';

const searchFiles = vi.fn();

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof Api>();
  return { ...actual, api: { ...actual.api, searchFiles: (...args: unknown[]) => searchFiles(...args) } };
});

describe('useFilesSource', () => {
  beforeEach(() => {
    searchFiles.mockReset();
    searchFiles.mockImplementation(async (_projectId: string, { query }: { query: string }) => new Response(JSON.stringify({
      results: [{ name: `${query || 'first'}.ts`, type: 'file', path: `/proj/${query || 'first'}.ts`, relativePath: `${query || 'first'}.ts` }],
      truncated: false,
      indexIncomplete: false,
    })));
  });

  it('asks the server for files matching the settled search text', async () => {
    const { result, rerender } = renderHook(({ query }) => useFilesSource('p1', true, query), { initialProps: { query: '' } });
    await waitFor(() => expect(result.current).toEqual([{ name: 'first.ts', path: '/proj/first.ts' }]));

    rerender({ query: 'b' });
    rerender({ query: 'bu' });
    rerender({ query: 'button ' });

    await waitFor(() => expect(result.current).toEqual([{ name: 'button.ts', path: '/proj/button.ts' }]));
    // The intermediate keystrokes never reach the server.
    expect(searchFiles.mock.calls.map(([, params]) => params.query)).toEqual(['', 'button']);
    expect(searchFiles).toHaveBeenLastCalledWith('p1', { query: 'button', limit: 50, type: 'file' }, expect.anything());
  });

  it('stays idle while the palette does not show files', async () => {
    const { result } = renderHook(() => useFilesSource('p1', false, 'x'));

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(result.current).toEqual([]);
    expect(searchFiles).not.toHaveBeenCalled();
  });
});
