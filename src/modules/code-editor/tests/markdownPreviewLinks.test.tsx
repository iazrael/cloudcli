import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import CodeEditorSurface from '@/modules/code-editor/CodeEditorSurface';
import MarkdownPreview from '@/modules/code-editor/markdown/MarkdownPreview';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
import type { ImageMediaRequest, MarkdownImageContext } from '@/shared/types';
import type * as sharedApi from '@/shared/api';

const { requestImageUrls } = vi.hoisted(() => ({ requestImageUrls: vi.fn() }));
vi.mock('@/shared/api', async (importOriginal) => ({ ...await importOriginal<typeof sharedApi>(), requestImageUrls }));
const ok = async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({ images: images.map(({ id }) => ({ id, url: '/api/media/images?ticket=preview-link', expiresAt: Date.now() + 600_000 })) }) });
const openFileInEditor = vi.fn();
const openDirectory = vi.fn();
function RegisteredOperations({ children }: { children: ReactNode }) {
  usePaletteOpsRegister({ openFileInEditor, openDirectory });
  return <>{children}</>;
}
const context: MarkdownImageContext = {
  projectId: 'qwen-project', isExternal: false,
  baseDir: '/Users/azrael/workspaces/qwen-image/artifacts/benchmark',
};
const imagePath = '/Users/azrael/workspaces/qwen-image/out/benchmark/512_fast.png';
const renderPreview = (content: string, imageContext: MarkdownImageContext | null = context) => render(
  <PaletteOpsProvider><RegisteredOperations>
    <CodeEditorSurface content={content} onChange={() => {}} markdownPreview isMarkdownFile
      isDarkMode={false} fontSize={14} showLineNumbers extensions={[]} markdownImageContext={imageContext} />
  </RegisteredOperations></PaletteOpsProvider>,
);
const clickLocal = (name = 'Fast 原图') => fireEvent.click(screen.getByText(name));

beforeEach(() => {
  localStorage.setItem('auth-token', crypto.randomUUID());
  requestImageUrls.mockReset().mockImplementation(ok);
  openFileInEditor.mockReset();
  openDirectory.mockReset();
  URL.createObjectURL = vi.fn(() => '/api/media/images?ticket=preview-link');
  URL.revokeObjectURL = vi.fn();
});

it('opens the report image through a signed URL only after clicking, keeping the report mounted', async () => {
  renderPreview('# 报告\n\n[Fast 原图](../../out/benchmark/512_fast.png)');
  expect(requestImageUrls).not.toHaveBeenCalled();
  clickLocal();
  await screen.findByRole('dialog');
  expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'project', projectId: 'qwen-project', path: imagePath })]);
  expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe('/api/media/images?ticket=preview-link');
  expect(screen.getByRole('heading', { name: '报告' })).toBeDefined();
  expect(openFileInEditor).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: 'Fast 原图' })).toBeNull();
});

it('closes and reopens the image without replacing the report or fetching it again', async () => {
  renderPreview('[Fast 原图](../../out/benchmark/512_fast.png)');
  clickLocal();
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(dialog.querySelector('[aria-label="关闭图片预览"]')!);
  expect(screen.queryByRole('dialog')).toBeNull();
  clickLocal();
  await screen.findByRole('dialog');
  expect(requestImageUrls).toHaveBeenCalledTimes(1);
});

it.each([
  ['environment.json', '/Users/azrael/workspaces/qwen-image/artifacts/benchmark/environment.json'],
  ['../../out/benchmark/compare-embedded.html', '/Users/azrael/workspaces/qwen-image/out/benchmark/compare-embedded.html'],
  ['notes.md#details', '/Users/azrael/workspaces/qwen-image/artifacts/benchmark/notes.md'],
  ['notes.md?view=raw#details', '/Users/azrael/workspaces/qwen-image/artifacts/benchmark/notes.md'],
])('opens the local file %s through existing file operations', (href, expectedPath) => {
  renderPreview(`[文件](${href})`);
  clickLocal('文件');
  expect(openFileInEditor).toHaveBeenCalledWith(expectedPath, undefined);
  expect(requestImageUrls).not.toHaveBeenCalled();
});

it.each([
  ['file:///repo/pic.png', '/repo/pic.png'],
  ['/repo/pic.png', '/repo/pic.png'],
  ['/repo/animation.apng', '/repo/animation.apng'],
  ['img/%E5%9B%BE%20a%23b.png', `${context.baseDir}/img/图 a#b.png`],
  ['img/a%2520b.png', `${context.baseDir}/img/a%20b.png`],
])('opens image reference %s with one decoding pass', async (href, expectedPath) => {
  renderPreview(`[Fast 原图](${href})`);
  clickLocal();
  await screen.findByRole('dialog');
  expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'project', projectId: 'qwen-project', path: expectedPath })]);
});

it('signs links from external documents using the read-only policy', async () => {
  renderPreview('[Fast 原图](images/a.png)', { projectId: 'qwen-project', isExternal: true, baseDir: '/ext/report' });
  clickLocal();
  await screen.findByRole('dialog');
  expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'external', projectId: 'qwen-project', path: '/ext/report/images/a.png' })]);
});

it.each([403, 404, 500])('shows a recoverable failure for HTTP %s without navigating to the web origin', async (status) => {
  requestImageUrls.mockResolvedValueOnce({ ok: false, status });
  renderPreview('[Fast 原图](../../out/benchmark/512_fast.png)');
  clickLocal();
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain(
    status === 403 ? 'imageLoad.forbidden' : status === 404 ? 'imageLoad.notFound' : 'imageLoad.failed',
  ));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Fast 原图' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'common:buttons.retry' }));
  await screen.findByRole('dialog');
});

it('leaves external, protocol-relative and email links to the browser', () => {
  renderPreview('[网站](https://example.com/a) [网络](//example.com/a) [邮件](mailto:hello@example.com)');
  expect(screen.getByRole('link', { name: '网站' }).getAttribute('href')).toBe('https://example.com/a');
  expect(screen.getByRole('link', { name: '网络' }).getAttribute('href')).toBe('//example.com/a');
  expect(screen.getByRole('link', { name: '邮件' }).getAttribute('href')).toBe('mailto:hello@example.com');
  expect(requestImageUrls).not.toHaveBeenCalled();
});

it('keeps a same-document fragment in the current document', () => {
  renderPreview('[章节](#details)');
  const link = screen.getByRole('link', { name: '章节' });
  expect(link.getAttribute('href')).toBe('#details');
  expect(link.getAttribute('target')).toBeNull();
});

it('opens directory references in the file tree', () => {
  renderPreview('[目录](./images/)');
  clickLocal('目录');
  expect(openDirectory).toHaveBeenCalledWith(`${context.baseDir}/images`);
});

it('does not navigate local references when no document context is available', () => {
  renderPreview('[Fast 原图](out/a.png)', null);
  clickLocal();
  expect(screen.queryByRole('link')).toBeNull();
  expect(requestImageUrls).not.toHaveBeenCalled();
  expect(openFileInEditor).not.toHaveBeenCalled();
});

it('ignores a pending signing response after the document unmounts', async () => {
  let finish!: (response: unknown) => void;
  requestImageUrls.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { unmount } = renderPreview('[Fast 原图](../../out/benchmark/512_fast.png)');
  clickLocal();
  await waitFor(() => expect(requestImageUrls).toHaveBeenCalledTimes(1));
  const requests = requestImageUrls.mock.calls[0][0];
  unmount();
  await act(async () => { finish(await ok(requests)); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('keeps inline-image behavior when the same document also contains a linked image', async () => {
  render(<MarkdownPreview content={'![内嵌](../../out/benchmark/512_default.png)\n\n[Fast 原图](../../out/benchmark/512_fast.png)'} imageContext={context} />);
  await screen.findByRole('img', { name: '内嵌' });
  expect(requestImageUrls).toHaveBeenCalledTimes(1);
  clickLocal();
  await screen.findByRole('dialog');
  expect(requestImageUrls).toHaveBeenCalledTimes(2);
});

it('a linked thumbnail opens only its linked original image', async () => {
  renderPreview('[![缩略图](thumb.png)](../../out/benchmark/512_fast.png)');
  const thumbnail = await screen.findByRole('img', { name: '缩略图' });
  fireEvent.click(thumbnail);
  await screen.findByRole('dialog');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(requestImageUrls).toHaveBeenLastCalledWith([expect.objectContaining({ projectId: 'qwen-project', path: imagePath })]);
});

it('does not duplicate a pending image request on repeated clicks', async () => {
  requestImageUrls.mockImplementation(() => new Promise(() => {}));
  renderPreview('[Fast 原图](../../out/benchmark/512_fast.png)');
  clickLocal();
  clickLocal();
  await waitFor(() => expect(requestImageUrls).toHaveBeenCalledTimes(1));
});

it('changing the document closes its old image and signs the new reference', async () => {
  const { rerender } = render(<MarkdownPreview content={'[Fast 原图](pic.png)'} imageContext={context} />);
  clickLocal();
  await screen.findByRole('dialog');
  rerender(<MarkdownPreview content={'[Fast 原图](pic.png)'} imageContext={{ ...context, baseDir: '/repo/other' }} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  clickLocal();
  await screen.findByRole('dialog');
  expect(requestImageUrls).toHaveBeenLastCalledWith([expect.objectContaining({ projectId: 'qwen-project', path: '/repo/other/pic.png' })]);
});
