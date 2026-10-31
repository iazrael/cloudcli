import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type * as sharedApi from '@/shared/api';
import type { ImageMediaRequest, PathExistenceRequest } from '@/shared/types';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';

const { requestImageUrls, requestPathsExist, openFileInEditor, openDirectory } = vi.hoisted(() => ({
  requestImageUrls: vi.fn(), requestPathsExist: vi.fn(), openFileInEditor: vi.fn(), openDirectory: vi.fn(),
}));
vi.mock('@/shared/api', async (original) => ({ ...await original<typeof sharedApi>(), requestImageUrls, requestPathsExist }));
vi.mock('@/modules/command-palette', () => ({ usePaletteOps: () => ({ openFileInEditor, openDirectory }) }));

beforeEach(() => {
  localStorage.setItem('auth-token', crypto.randomUUID());
  vi.clearAllMocks();
  requestImageUrls.mockImplementation(async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({
    images: images.map(({ id }) => ({ id, url: '/api/media/images?ticket=reference', expiresAt: Date.now() + 600_000 })),
  }) }));
  requestPathsExist.mockImplementation(async (items: PathExistenceRequest[]) => ({ ok: true, json: async () => ({
    results: items.map(({ id }) => ({ id, status: 200 })),
  }) }));
});

function renderMessage(content: string, projectId: string | null = 'project-images', worktreePath: string | null = null) {
  return render(<ThemeProvider><MarkdownWorkspaceContext.Provider value={{ projectId, worktreePath }}>
    <Markdown>{content}</Markdown>
  </MarkdownWorkspaceContext.Provider></ThemeProvider>);
}

// 按签名请求里的路径区分候选：工作树拼接路径给 wt 票，其余给 root 票。
const mockTicketsByPath = (wtPrefix: string) => async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({
  images: images.map((image) => ({
    id: image.id,
    url: 'path' in image && image.path?.startsWith(wtPrefix) ? '/api/media/images?ticket=wt' : '/api/media/images?ticket=root',
    expiresAt: Date.now() + 600_000,
  })),
}) });

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
  expect(screen.queryByRole('img')).toBeNull();
  // 挂载即探测存在性；确认存在后引用保持可点，点击复用已签名的地址。
  await waitFor(() => expect(requestImageUrls).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button'));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('img').getAttribute('src')).toBe('/api/media/images?ticket=reference');
  expect(within(within(dialog).getByRole('contentinfo')).getByText(path)).toBeTruthy();
  expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind, path, projectId: 'project-images' })]);
  expect(openFileInEditor).not.toHaveBeenCalled();
  expect(requestImageUrls).toHaveBeenCalledTimes(1);
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

test('reports a missing project without requesting a ticket', () => {
  const view = renderMessage('`out/missing.png`', null);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('status').textContent).toContain('imageLoad.unresolved');
  expect(requestImageUrls).not.toHaveBeenCalled();
  view.unmount();
});

test.each([404, 403])('renders a local image reference as plain text when the probe reports %i', async (status) => {
  requestImageUrls.mockResolvedValue({ ok: false, status });
  renderMessage('`/Users/test/project/gone.png`');
  // 默认样式：只保留原引用文字，不追加提示、路径或重试入口。
  await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByText('/Users/test/project/gone.png')).toBeTruthy();
});

test('keeps a local image reference clickable when the probe fails transiently', async () => {
  requestImageUrls.mockResolvedValueOnce({ ok: false, status: 500 });
  renderMessage('`/Users/test/project/flaky.png`');
  // 探测失败但非明确不存在：引用保持可点，点击后自动重试并打开查看器。
  fireEvent.click(await screen.findByRole('button'));
  await screen.findByRole('dialog');
  expect(requestImageUrls).toHaveBeenCalledTimes(2);
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

test('probes relative image references against the session worktree first', async () => {
  requestImageUrls.mockImplementation(mockTicketsByPath('/repo/.worktrees/feat'));
  renderMessage('`out/海岸.png`', 'project-images', '/repo/.worktrees/feat');

  await waitFor(() => expect(requestImageUrls).toHaveBeenCalled());
  expect(requestImageUrls).toHaveBeenCalledWith([
    expect.objectContaining({ kind: 'external', path: '/repo/.worktrees/feat/out/海岸.png', projectFallback: true }),
    expect.objectContaining({ kind: 'project', path: 'out/海岸.png', projectId: 'project-images' }),
  ]);

  fireEvent.click(screen.getByRole('button'));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('img').getAttribute('src')).toBe('/api/media/images?ticket=wt');
});

test('falls back to the project copy when the worktree image is missing', async () => {
  requestImageUrls.mockImplementation(async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({
    images: images.map(({ id, kind }) => ({
      id,
      ...(kind === 'external' ? { status: 404, error: 'notFound' } : { url: '/api/media/images?ticket=root', expiresAt: Date.now() + 600_000 }),
    })),
  }) }));
  renderMessage('`out/海岸.png`', 'project-images', '/repo/.worktrees/feat');

  fireEvent.click(await screen.findByRole('button'));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('img').getAttribute('src')).toBe('/api/media/images?ticket=root');
});

test('renders a relative image reference plain when both candidates are missing', async () => {
  requestImageUrls.mockResolvedValue({ ok: false, status: 404 });
  renderMessage('`out/gone.png`', 'project-images', '/repo/.worktrees/feat');

  await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  expect(screen.getByText('out/gone.png')).toBeTruthy();
});
