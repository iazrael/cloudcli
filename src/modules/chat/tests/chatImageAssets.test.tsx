import { render, screen } from '@testing-library/react';
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
