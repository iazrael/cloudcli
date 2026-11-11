import { act, renderHook, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import type * as Api from '@/shared/api';
import type { FileTreeSearchResponse, Project } from '@/shared/types';

const searchFiles = vi.fn();

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof Api>();
  return { ...actual, api: { ...actual.api, searchFiles: (...args: unknown[]) => searchFiles(...args) } };
});

const project = { projectId: 'p1', displayName: 'proj', fullPath: '/proj', path: '/proj' } as Project;

const response: FileTreeSearchResponse = {
  results: Array.from({ length: 12 }, (_, index) => ({
    name: `button-${index}.ts`,
    type: 'file',
    path: `/proj/src/button-${index}.ts`,
    relativePath: `src/button-${index}.ts`,
  })),
  truncated: false,
  indexIncomplete: false,
};

function renderMentions(input: string, selectedProject: Project = project) {
  return renderHook(
    ({ current, text }) => useFileMentions({
      selectedProject: current,
      input: text,
      setInput: vi.fn(),
      textareaRef: createRef<HTMLTextAreaElement>(),
    }),
    { initialProps: { current: selectedProject, text: input } },
  );
}

describe('useFileMentions', () => {
  beforeEach(() => {
    searchFiles.mockReset();
    searchFiles.mockImplementation(async () => new Response(JSON.stringify(response)));
  });

  it('searches the server for the text after @ and offers the first ten files', async () => {
    const { result } = renderMentions('look at @butt');
    act(() => result.current.setCursorPosition('look at @butt'.length));

    await waitFor(() => expect(result.current.filteredFiles).toHaveLength(10));
    expect(searchFiles).toHaveBeenCalledTimes(1);
    expect(searchFiles).toHaveBeenCalledWith('p1', { query: 'butt', limit: 20, type: 'file' }, expect.anything());
    expect(result.current.showFileDropdown).toBe(true);
    expect(result.current.filteredFiles[0]).toEqual({
      name: 'button-0.ts',
      path: 'src/button-0.ts',
      relativePath: '/proj/src/button-0.ts',
    });
  });

  it('does not search while no @ query is active', async () => {
    const { result } = renderMentions('plain text');
    act(() => result.current.setCursorPosition('plain text'.length));

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(searchFiles).not.toHaveBeenCalled();
    expect(result.current.showFileDropdown).toBe(false);
  });

  it('never shows the previous project files after a project switch', async () => {
    const { result, rerender } = renderMentions('@b');
    act(() => result.current.setCursorPosition(2));
    await waitFor(() => expect(result.current.filteredFiles).toHaveLength(10));

    searchFiles.mockImplementation(() => new Promise(() => undefined));
    rerender({ current: { ...project, projectId: 'p2' }, text: '@b' });

    expect(result.current.filteredFiles).toEqual([]);
  });
});
