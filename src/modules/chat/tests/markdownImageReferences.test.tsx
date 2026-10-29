import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type * as sharedApi from '@/shared/api';
import type { ImageMediaRequest } from '@/shared/types';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';

const { requestImageUrls, openFileInEditor, openDirectory } = vi.hoisted(() => ({
  requestImageUrls: vi.fn(), openFileInEditor: vi.fn(), openDirectory: vi.fn(),
}));
vi.mock('@/shared/api', async (original) => ({ ...await original<typeof sharedApi>(), requestImageUrls }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ openFileInEditor, openDirectory }) }));

beforeEach(() => {
  localStorage.setItem('auth-token', crypto.randomUUID());
  vi.clearAllMocks();
  requestImageUrls.mockImplementation(async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({
    images: images.map(({ id }) => ({ id, url: '/api/media/images?ticket=reference', expiresAt: Date.now() + 600_000 })),
  }) }));
});

function renderMessage(content: string, projectId: string | null = 'project-images') {
  return render(<ThemeProvider><MarkdownWorkspaceContext.Provider value={{ projectId }}>
    <Markdown>{content}</Markdown>
  </MarkdownWorkspaceContext.Provider></ThemeProvider>);
}

test.each([
  ['`/Users/test/project/composite-2048.png`', '/Users/test/project/composite-2048.png', 'external'],
  ['`/repo/图 像/crop.png`', '/repo/图 像/crop.png', 'external'],
  ['`./out/crop.webp`', 'out/crop.webp', 'project'],
  ['图在 out/海岸.png，请查看。', 'out/海岸.png', 'project'],
  ['请看 sample.AVIF。', 'sample.AVIF', 'project'],
  ['[原图](../out/crop.jpg)', '../out/crop.jpg', 'project'],
  ['`file:///repo/crop.png`', '/repo/crop.png', 'external'],
])('opens %s only when clicked', async (content, path, kind) => {
  renderMessage(content);
  expect(requestImageUrls).not.toHaveBeenCalled();
  expect(screen.queryByRole('img')).toBeNull();
  fireEvent.click(screen.getByRole('button'));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('img').getAttribute('src')).toBe('/api/media/images?ticket=reference');
  expect(within(within(dialog).getByRole('contentinfo')).getByText(path)).toBeTruthy();
  expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind, path, projectId: 'project-images' })]);
  expect(openFileInEditor).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭图片预览' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test.each([
  'https://example.test/render.png?size=full#preview',
  '[查看原图](https://example.test/render.png?size=full#preview)',
  '`https://example.test/render.png?size=full#preview`',
])('opens a remote image reference without requesting a local ticket: %s', (content) => {
  renderMessage(content);
  fireEvent.click(screen.getByRole('button'));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('img').getAttribute('src')).toBe('https://example.test/render.png?size=full#preview');
  expect(requestImageUrls).not.toHaveBeenCalled();
});

test('does not link code blocks, commands, non-image files or links nested inside existing links', () => {
  renderMessage('```sh\ncat out/a.png\n```\n\n`cat out/a.png`\n\n普通文件 readme.md 和 fake.png.ts\n\n[参考](docs/readme.md)\n\n[普通网页](https://example.test/page?image=a.png)\n\n[![缩略图](https://example.test/thumb.jpg)](https://example.test/page)');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('link', { name: '参考' })).toBeTruthy();
  expect(screen.getByRole('link', { name: '普通网页' })).toBeTruthy();
  expect(requestImageUrls).not.toHaveBeenCalled();
});

test('reports a missing project and allows retry after a failed file request', async () => {
  const view = renderMessage('`out/missing.png`', null);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('status').textContent).toContain('imageLoad.unresolved');
  expect(requestImageUrls).not.toHaveBeenCalled();
  view.unmount();
  requestImageUrls.mockResolvedValueOnce({ ok: false, status: 404 });
  renderMessage('`out/missing.png`');
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('imageLoad.notFound'));
  fireEvent.click(screen.getByRole('button', { name: 'common:buttons.retry' }));
  await screen.findByRole('dialog');
});

test('closes the previous viewer when the message reference changes', async () => {
  const view = renderMessage('`out/first.png`');
  fireEvent.click(screen.getByRole('button'));
  await screen.findByRole('dialog');
  view.rerender(<ThemeProvider><MarkdownWorkspaceContext.Provider value={{ projectId: 'project-images' }}>
    <Markdown>{'`out/second.png`'}</Markdown>
  </MarkdownWorkspaceContext.Provider></ThemeProvider>);
  expect(screen.queryByRole('dialog')).toBeNull();
});
