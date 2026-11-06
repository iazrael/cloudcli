import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import type * as sharedApi from '@/shared/api';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';
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
it('shows a generated image as a fixed thumbnail with the whole image visible', async () => {
  render(<ChatMessageImage image={{ path: '/api/assets/images/thumbnail.png', name: 'generated' }} variant="assistant" />);
  const image = await screen.findByRole('img');
  expect(image.className).toContain('h-28 w-28');
  expect(image.className).toContain('object-contain');
});
it('keeps the same fixed box while a generated image waits for its ticket', () => {
  const { container } = render(<ChatMessageImage image={{ path: '/api/assets/images/waiting.png', name: 'generated' }} variant="assistant" />);
  expect(container.querySelector('.animate-pulse')?.className).toContain('h-28 w-28');
});
it('shows a generated image at reading size in exports, which have no viewer to open', () => {
  render(
    <TranscriptRenderContext.Provider value={{ isExporting: true, assetData: { '/api/assets/images/exported.png': 'data:image/png;base64,QUJD' } }}>
      <ChatMessageImage image={{ path: '/api/assets/images/exported.png', name: 'generated' }} variant="assistant" />
    </TranscriptRenderContext.Provider>,
  );
  expect(screen.getByRole('img').className).toContain('max-h-[32rem]');
});
it('keeps user attachments cropped to their square', async () => {
  render(<ChatMessageImage image={{ path: '/api/assets/images/thumb.png', name: 'thumb' }} />);
  expect((await screen.findByRole('img')).className).toContain('h-28 w-28 object-cover');
});
