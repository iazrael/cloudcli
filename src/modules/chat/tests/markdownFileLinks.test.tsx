import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as sharedApi from '@/shared/api';
import type { PathExistenceRequest } from '@/shared/types';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { ThemeProvider } from '@/shared/context/ThemeContext';

const { openFileInEditor, requestPathsExist } = vi.hoisted(() => ({
  openFileInEditor: vi.fn(),
  requestPathsExist: vi.fn(),
}));

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor }),
}));
vi.mock('@/shared/api', async (original) => ({
  ...await original<typeof sharedApi>(),
  requestPathsExist,
}));

afterEach(() => {
  openFileInEditor.mockReset();
});

const resolveStatuses = (status: number) => async (items: PathExistenceRequest[]) => ({
  ok: true,
  json: async () => ({ results: items.map(({ id }) => ({ id, status })) }),
});

// Markdown's code blocks read the theme for syntax-highlight colors; wrap
// every render in the provider so the components under test see one. The
// workspace context supplies the project that relative references resolve
// against — without it they stay unprobed and always clickable.
const renderWithTheme = (ui: React.ReactElement, projectId: string | null = 'project-links') =>
  render(
    <ThemeProvider>
      <MarkdownWorkspaceContext.Provider value={{ projectId }}>{ui}</MarkdownWorkspaceContext.Provider>
    </ThemeProvider>,
  );


describe('Markdown file links', () => {
  it('opens a percent-escaped non-ASCII href as its real filesystem path', () => {
    const filePath = '/Users/tester/workspaces/game/reports/体验修复批次_2026-09-17/批V3-11/验收报告.md';

    renderWithTheme(<Markdown>{`[验收报告.md](${filePath})`}</Markdown>);
    fireEvent.click(screen.getByRole('link', { name: '验收报告.md' }));

    expect(openFileInEditor).toHaveBeenCalledOnce();
    // The resolver forwards an optional line anchor after the path; the
    // editor opens at that line when one was quoted in the reference.
    expect(openFileInEditor.mock.calls[0][0]).toBe(filePath);
  });

  it('renders a reference the probe reports missing as plain text', async () => {
    requestPathsExist.mockImplementation(resolveStatuses(404));

    renderWithTheme(<Markdown>{'See [/tmp/gone.ts](/tmp/gone.ts).'}</Markdown>);
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull());

    expect(openFileInEditor).not.toHaveBeenCalled();
    // 引用退回普通文字后原文本仍在消息里。
    expect(screen.getAllByText(/\/tmp\/gone\.ts/).length).toBeGreaterThan(0);
  });

  it('keeps a reference clickable when the probe cannot decide', async () => {
    requestPathsExist.mockImplementation(async (items: PathExistenceRequest[]) => {
      void items;
      return { ok: false, status: 500 };
    });

    renderWithTheme(<Markdown>{'See [/tmp/maybe.ts](/tmp/maybe.ts).'}</Markdown>);
    await waitFor(() => expect(requestPathsExist).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('link', { name: '/tmp/maybe.ts' }));

    expect(openFileInEditor).toHaveBeenCalledWith('/tmp/maybe.ts', null);
  });

  it('links standalone inline-code file paths once the probe confirms them', async () => {
    renderWithTheme(<Markdown>{'已提交（`463df49`），改动有 `nexus.config.json`、`tasks/autoplay-s3-past.md`，运行 `cat out/a.png` 查看。'}</Markdown>);

    expect(await screen.findByRole('link', { name: 'nexus.config.json' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'tasks/autoplay-s3-past.md' })).toBeTruthy();
    // 非路径的行内代码和带空格的命令片段不转链接，也不产生探测。
    expect(screen.queryByRole('link', { name: '463df49' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'cat out/a.png' })).toBeNull();
    expect(requestPathsExist).toHaveBeenCalledTimes(1);
    expect(requestPathsExist).toHaveBeenCalledWith([
      expect.objectContaining({ path: 'nexus.config.json' }),
      expect.objectContaining({ path: 'tasks/autoplay-s3-past.md' }),
    ]);
    fireEvent.click(screen.getByRole('link', { name: 'nexus.config.json' }));
    expect(openFileInEditor).toHaveBeenCalledWith('nexus.config.json', null);
  });

  it('keeps an inline-code file path as plain code when the probe reports it missing', async () => {
    requestPathsExist.mockImplementation(resolveStatuses(404));

    renderWithTheme(<Markdown>{'改动有 `AGENTS.md` 和 `docs/设计/后续工作计划.md`。'}</Markdown>);
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull());

    expect(screen.getByText('AGENTS.md')).toBeTruthy();
    expect(openFileInEditor).not.toHaveBeenCalled();
  });
});
