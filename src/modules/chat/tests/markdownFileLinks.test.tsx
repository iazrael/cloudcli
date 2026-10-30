import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as sharedApi from '@/shared/api';
import type { PathExistenceRequest } from '@/shared/types';
import { Markdown } from '@/modules/chat/transcript/Markdown';
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
// every render in the provider so the components under test see one.
const renderWithTheme = (ui: React.ReactElement) =>
  render(<ThemeProvider>{ui}</ThemeProvider>);


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
});
