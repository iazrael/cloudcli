import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { UnifiedImageViewer } from '@/shared/ui/UnifiedImageViewer';
import { saveOrShareBlob } from '@/shared/utils';

vi.mock('@/shared/utils', () => ({ saveOrShareBlob: vi.fn().mockResolvedValue(undefined) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test.each([
  ['blob:http://localhost/original', '截图.png', undefined, '截图.png'],
  ['data:image/png;base64,aGVsbG8=', '附件.png', undefined, '附件.png'],
  ['blob:http://localhost/workspace', '示意图', '/workspace/图纸.svg', '图纸.svg'],
  ['https://images.example.test/photo.jpg', '', undefined, 'photo.jpg'],
  ['https://images.example.test/photo.jpg?size=full', 'https://images.example.test/photo.jpg?size=full', undefined, 'photo.jpg'],
  ['https://images.example.test/100%.png', 'photo.png', undefined, 'photo.png'],
  ['blob:http://localhost/description', '示意图', undefined, '示意图.png'],
])('downloads original bytes from %s without closing the viewer', async (src, title, filePath, filename) => {
  const blob = new Blob(['original bytes'], { type: 'image/png' });
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
  vi.stubGlobal('fetch', fetchMock);
  const onClose = vi.fn();
  render(<UnifiedImageViewer src={src} title={title} alt="" filePath={filePath} onClose={onClose} />);

  fireEvent.click(screen.getByRole('button', { name: '放大' }));
  fireEvent.click(screen.getByRole('button', { name: '下载图片' }));

  await waitFor(() => expect(saveOrShareBlob).toHaveBeenCalledWith(blob, filename));
  expect(fetchMock).toHaveBeenCalledWith(src, { referrerPolicy: 'no-referrer' });
  expect(onClose).not.toHaveBeenCalled();
});

test.each([
  [() => Promise.resolve({ ok: false, status: 403 }), 'HTTP failure'],
  [() => Promise.reject(new TypeError('Failed to fetch')), 'network or CORS failure'],
])('shows a visible error and allows retry after %s (%s)', async (request) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetchMock = vi.fn().mockImplementationOnce(request)
    .mockResolvedValue({ ok: true, blob: async () => new Blob(['retry'], { type: 'image/png' }) });
  vi.stubGlobal('fetch', fetchMock);
  render(<UnifiedImageViewer src="blob:http://localhost/image" title="image.png" onClose={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: '下载图片' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '图片下载失败，请重试；外链图片可能不允许下载。');
  expect(saveOrShareBlob).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '下载图片' }));
  await waitFor(() => expect(saveOrShareBlob).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('disables duplicate downloads while the save hand-off is pending', async () => {
  let finishSave!: () => void;
  vi.mocked(saveOrShareBlob).mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['image']) }));
  render(<UnifiedImageViewer src="blob:http://localhost/image" title="image.png" onClose={vi.fn()} />);

  fireEvent.click(screen.getByRole('button', { name: '下载图片' }));
  await waitFor(() => expect(saveOrShareBlob).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: '正在下载图片' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: '正在下载图片' }));
  expect(saveOrShareBlob).toHaveBeenCalledTimes(1);
  finishSave();
  await waitFor(() => expect(screen.getByRole('button', { name: '下载图片' })).toHaveProperty('disabled', false));
});
