import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import type * as sharedApi from '@/shared/api';
import { ChatMessageImage } from '@/modules/chat/transcript/ChatMessageImages';
import type { ImageMediaRequest } from '@/shared/types';

const { requestImageUrls } = vi.hoisted(() => ({ requestImageUrls: vi.fn() }));
vi.mock('@/shared/api', async (original) => ({ ...await original<typeof sharedApi>(), requestImageUrls }));
beforeEach(() => {
  localStorage.setItem('auth-token', crypto.randomUUID());
  requestImageUrls.mockReset().mockImplementation(async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({ images: images.map(({ id }) => ({ id, url: '/api/media/images?ticket=attachment', expiresAt: Date.now() + 600_000 })) }) }));
});
it('loads a stored reference in the legacy data field through a signed asset URL', async () => {
  const filename = `inline-${'a'.repeat(64)}.png`;
  render(<ChatMessageImage image={{ data: `/api/assets/images/${filename}`, name: 'screenshot' }} />);
  expect((await screen.findByRole('img')).getAttribute('src')).toBe('/api/media/images?ticket=attachment');
  expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'asset', filename })]);
});
it('keeps existing inline images usable without an API request', () => {
  render(<ChatMessageImage image={{ data: 'data:image/png;base64,QUJD', name: 'inline' }} />);
  expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,QUJD');
  expect(requestImageUrls).not.toHaveBeenCalled();
});
it('preserves legacy project attachment fallback information when signing', async () => {
  render(<ChatMessageImage image={{ path: '/old/project/image.png', name: 'old' }} projectId="legacy" />);
  await screen.findByRole('img');
  expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'asset', filename: 'image.png', projectId: 'legacy', fallbackPath: '/old/project/image.png' })]);
});
it('reserves the decoded box for an assistant image when its row remounts', async () => {
  const image = { path: '/api/assets/images/remount-box.png', name: 'generated' };
  const first = render(<ChatMessageImage image={image} variant="assistant" />);
  const loaded = await screen.findByRole('img');
  Object.defineProperty(loaded, 'naturalWidth', { value: 852, configurable: true });
  Object.defineProperty(loaded, 'naturalHeight', { value: 1846, configurable: true });
  fireEvent.load(loaded);
  await waitFor(() => expect(screen.getByRole('button').style.aspectRatio).toBe('852 / 1846'));
  first.unmount();

  // 票据还有效：挂载首帧就出图，不经过占位。
  render(<ChatMessageImage image={image} variant="assistant" />);
  expect(screen.getByRole('img').getAttribute('src')).toBe('/api/media/images?ticket=attachment');
  expect(screen.getByRole('button').style.aspectRatio).toBe('852 / 1846');
});
it('keeps the reserved box while a remounted image waits for a new ticket', async () => {
  const image = { path: '/api/assets/images/expired-box.png', name: 'generated' };
  requestImageUrls.mockImplementationOnce(async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({ images: images.map(({ id }) => ({ id, url: '/api/media/images?ticket=short', expiresAt: Date.now() + 1_000 })) }) }));
  const first = render(<ChatMessageImage image={image} variant="assistant" />);
  const loaded = await screen.findByRole('img');
  Object.defineProperty(loaded, 'naturalWidth', { value: 800, configurable: true });
  Object.defineProperty(loaded, 'naturalHeight', { value: 400, configurable: true });
  fireEvent.load(loaded);
  await waitFor(() => expect(screen.getByRole('button').style.aspectRatio).toBe('800 / 400'));
  first.unmount();

  const { container } = render(<ChatMessageImage image={image} variant="assistant" />);
  const placeholder = container.querySelector<HTMLElement>('.animate-pulse');
  expect(placeholder?.style.aspectRatio).toBe('800 / 400');
  expect(placeholder?.className).not.toContain('h-28');
});
it('keeps attachment thumbnails on their fixed square', async () => {
  render(<ChatMessageImage image={{ path: '/api/assets/images/thumb.png', name: 'thumb' }} />);
  const loaded = await screen.findByRole('img');
  Object.defineProperty(loaded, 'naturalWidth', { value: 852, configurable: true });
  Object.defineProperty(loaded, 'naturalHeight', { value: 1846, configurable: true });
  fireEvent.load(loaded);
  expect(screen.getByRole('button').style.aspectRatio).toBe('');
  expect(loaded.className).toContain('h-28');
});
