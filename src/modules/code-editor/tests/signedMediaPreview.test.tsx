import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type * as sharedApi from '@/shared/api';
import type { ImageMediaRequest } from '@/shared/types';
import CodeEditorMediaPreview from '@/modules/code-editor/CodeEditorMediaPreview';

const { requestImageUrls } = vi.hoisted(() => ({ requestImageUrls: vi.fn() }));

vi.mock('@/shared/api', async (original) => ({ ...await original<typeof sharedApi>(), requestImageUrls }));
beforeEach(() => {
  localStorage.setItem('auth-token', crypto.randomUUID());
  requestImageUrls.mockReset().mockImplementation(async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({ images: images.map(({ id }) => ({ id, url: '/api/media/images?ticket=editor', expiresAt: Date.now() + 600_000 })) }) }));
});
afterEach(() => { vi.clearAllMocks(); });

it('the image editor loads a signed URL instead of fetching image bytes as a Blob', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  render(<CodeEditorMediaPreview file={{ name: 'shot.png', path: '/repo/shot.png', projectId: 'editor-p' }}
    kind="image" projectId="editor-p" isSidebar isFullscreen={false} onClose={() => {}} onToggleFullscreen={() => {}}
    labels={{ loading: 'loading', error: 'error', openInNewTab: 'open', fullscreen: 'full', exitFullscreen: 'exit', close: 'close' }} />);
  expect((await screen.findByRole('img')).getAttribute('src')).toBe('/api/media/images?ticket=editor');
  expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'project', projectId: 'editor-p', path: '/repo/shot.png' })]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('renews an expired ticket before opening an image in a new tab', async () => {
  const replace = vi.fn();
  const popup = { opener: {}, document: { title: '' }, location: { replace }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  render(<CodeEditorMediaPreview file={{ name: 'other.png', path: '/repo/other.png', projectId: 'editor-p' }}
    kind="image" projectId="editor-p" isSidebar isFullscreen={false} onClose={() => {}} onToggleFullscreen={() => {}}
    labels={{ loading: 'loading', error: 'error', openInNewTab: 'open', fullscreen: 'full', exitFullscreen: 'exit', close: 'close' }} />);
  await screen.findByRole('img');
  const realNow = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(realNow + 700_000);
  requestImageUrls.mockImplementation(async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({ images: images.map(({ id }) => ({ id, url: '/api/media/images?ticket=renewed', expiresAt: Date.now() + 600_000 })) }) }));
  fireEvent.click(screen.getByRole('link', { name: 'open' }));
  await waitFor(() => expect(replace).toHaveBeenCalledWith('/api/media/images?ticket=renewed'));
  expect(popup.opener).toBeNull();
});
