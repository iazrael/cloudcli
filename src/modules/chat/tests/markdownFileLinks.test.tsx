import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';

const { openFileInEditor } = vi.hoisted(() => ({
  openFileInEditor: vi.fn(),
}));

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor }),
}));

afterEach(() => {
  openFileInEditor.mockReset();
});

describe('Markdown file links', () => {
  it('opens a percent-escaped non-ASCII href as its real filesystem path', () => {
    const filePath = '/Users/tester/workspaces/game/reports/体验修复批次_2026-09-17/批V3-11/验收报告.md';

    render(<Markdown>{`[验收报告.md](${filePath})`}</Markdown>);
    fireEvent.click(screen.getByRole('link', { name: '验收报告.md' }));

    expect(openFileInEditor).toHaveBeenCalledOnce();
    expect(openFileInEditor).toHaveBeenCalledWith(filePath);
  });
});
