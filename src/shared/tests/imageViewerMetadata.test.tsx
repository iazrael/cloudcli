import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { UnifiedImageViewer } from '@/shared/ui/UnifiedImageViewer';

afterEach(() => vi.restoreAllMocks());

test('shows decoded pixel dimensions independently of zoom and clears them for a new source or error', () => {
  const onLoad = vi.fn();
  const { rerender } = render(<UnifiedImageViewer src="/first.png" filePath="/repo/first.png" onClose={vi.fn()} onImageLoad={onLoad} />);
  const image = screen.getByRole('img');
  Object.defineProperties(image, { naturalWidth: { configurable: true, value: 1920 }, naturalHeight: { configurable: true, value: 1080 } });
  fireEvent.load(image);
  expect(screen.getByText('1920 × 1080 px')).toBeTruthy();
  expect(onLoad).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '放大' }));
  expect(screen.getByText('1920 × 1080 px')).toBeTruthy();
  rerender(<UnifiedImageViewer src="/second.png" filePath="/repo/second.png" onClose={vi.fn()} />);
  expect(screen.queryByText('1920 × 1080 px')).toBeNull();
  fireEvent.load(screen.getByRole('img'));
  fireEvent.error(screen.getByRole('img'));
  expect(screen.queryByText('1920 × 1080 px')).toBeNull();
});

test('copies the original path instead of the signed URL and reports a failed copy', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { rerender } = render(<UnifiedImageViewer src="/api/media/images?ticket=secret" filePath="/repo/中文 image.png" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '复制路径' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('/repo/中文 image.png'));
  expect((await screen.findByRole('status')).textContent).toBe('路径已复制。');
  writeText.mockRejectedValue(new Error('blocked'));
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn().mockReturnValue(false) });
  fireEvent.click(screen.getByRole('button', { name: '复制路径' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('复制失败'));
  rerender(<UnifiedImageViewer src="/other.png" filePath="/other.png" onClose={vi.fn()} />);
  expect(screen.queryByRole('status')).toBeNull();
});

test('uses a public source URL but never presents a signed URL or embedded bytes as a file path', () => {
  const { rerender } = render(<UnifiedImageViewer src="https://example.test/image.png" onClose={vi.fn()} />);
  expect(screen.getByText('https://example.test/image.png')).toBeTruthy();
  for (const src of ['data:image/png;base64,abc', 'blob:http://localhost/temporary', '/api/media/images?ticket=secret']) {
    rerender(<UnifiedImageViewer src={src} onClose={vi.fn()} />);
    expect(screen.getByText('无文件路径')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '复制路径' })).toBeNull();
  }
});
