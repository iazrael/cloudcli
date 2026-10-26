import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import CodeEditorSurface from '@/modules/code-editor/CodeEditorSurface';
import MarkdownPreview from '@/modules/code-editor/markdown/MarkdownPreview';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
import type { MarkdownImageContext } from '@/shared/types';
import type * as sharedApi from '@/shared/api';

const { readFileBlob, readExternalFileContent } = vi.hoisted(() => ({
  readFileBlob: vi.fn(), readExternalFileContent: vi.fn(),
}));
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedApi>();
  return { ...actual, api: { ...actual.api, readFileBlob }, readExternalFileContent };
});
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
  readFileBlob.mockReset().mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });
  readExternalFileContent.mockReset().mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });
  openFileInEditor.mockReset();
  openDirectory.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:preview-link');
  URL.revokeObjectURL = vi.fn();
});

it('opens the report image through the authenticated API only after clicking, keeping the report mounted', async () => {
  renderPreview('# 报告\n\n[Fast 原图](../../out/benchmark/512_fast.png)');
  expect(readFileBlob).not.toHaveBeenCalled();
  clickLocal();
  await screen.findByRole('dialog');
  expect(readFileBlob).toHaveBeenCalledWith('qwen-project', imagePath, expect.anything());
  expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe('blob:preview-link');
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
  expect(readFileBlob).toHaveBeenCalledTimes(1);
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
  expect(readFileBlob).not.toHaveBeenCalled();
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
  expect(readFileBlob).toHaveBeenCalledWith('qwen-project', expectedPath, expect.anything());
});

it('reads links from external documents through the existing read-only endpoint', async () => {
  renderPreview('[Fast 原图](images/a.png)', { projectId: 'qwen-project', isExternal: true, baseDir: '/ext/report' });
  clickLocal();
  await screen.findByRole('dialog');
  expect(readExternalFileContent).toHaveBeenCalledWith('/ext/report/images/a.png', expect.anything(), 'qwen-project');
  expect(readFileBlob).not.toHaveBeenCalled();
});

it.each([403, 404, 500])('shows a recoverable failure for HTTP %s without navigating to the web origin', async (status) => {
  readFileBlob.mockResolvedValueOnce({ ok: false, status });
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
  expect(readFileBlob).not.toHaveBeenCalled();
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
  expect(readFileBlob).not.toHaveBeenCalled();
  expect(openFileInEditor).not.toHaveBeenCalled();
});

it('aborts a pending request and never creates an object URL after the preview unmounts', async () => {
  let finish!: (response: unknown) => void;
  readFileBlob.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { unmount } = renderPreview('[Fast 原图](../../out/benchmark/512_fast.png)');
  clickLocal();
  await waitFor(() => expect(readFileBlob).toHaveBeenCalledTimes(1));
  const signal = readFileBlob.mock.calls[0][2].signal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { finish({ ok: true, blob: async () => new Blob(['png']) }); });
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('releases the image object URL when the document is closed', async () => {
  const { unmount } = renderPreview('[Fast 原图](../../out/benchmark/512_fast.png)');
  clickLocal();
  await screen.findByRole('dialog');
  unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-link');
});

it('keeps inline-image behavior when the same document also contains a linked image', async () => {
  render(<MarkdownPreview content={'![内嵌](../../out/benchmark/512_default.png)\n\n[Fast 原图](../../out/benchmark/512_fast.png)'} imageContext={context} />);
  await screen.findByRole('img', { name: '内嵌' });
  expect(readFileBlob).toHaveBeenCalledTimes(1);
  clickLocal();
  await screen.findByRole('dialog');
  expect(readFileBlob).toHaveBeenCalledTimes(2);
});

it('a linked thumbnail opens only its linked original image', async () => {
  renderPreview('[![缩略图](thumb.png)](../../out/benchmark/512_fast.png)');
  const thumbnail = await screen.findByRole('img', { name: '缩略图' });
  fireEvent.click(thumbnail);
  await screen.findByRole('dialog');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(readFileBlob).toHaveBeenLastCalledWith('qwen-project', imagePath, expect.anything());
});

it('does not duplicate a pending image request on repeated clicks', async () => {
  readFileBlob.mockImplementation(() => new Promise(() => {}));
  renderPreview('[Fast 原图](../../out/benchmark/512_fast.png)');
  clickLocal();
  clickLocal();
  await waitFor(() => expect(readFileBlob).toHaveBeenCalledTimes(1));
});

it('changing the document closes its old image and releases the old URL', async () => {
  const { rerender } = render(<MarkdownPreview content={'[Fast 原图](pic.png)'} imageContext={context} />);
  clickLocal();
  await screen.findByRole('dialog');
  rerender(<MarkdownPreview content={'[Fast 原图](pic.png)'} imageContext={{ ...context, baseDir: '/repo/other' }} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-link');
  clickLocal();
  await screen.findByRole('dialog');
  expect(readFileBlob).toHaveBeenLastCalledWith('qwen-project', '/repo/other/pic.png', expect.anything());
});
