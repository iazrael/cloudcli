import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { ChatAttachment } from '@/shared/types';
import { api } from '@/shared/api';
import ChatMessageFiles from '@/modules/chat/transcript/ChatMessageFiles';

vi.mock('@/shared/api', () => ({
  api: { assets: { file: vi.fn() } },
}));

const mockAssetsFile = vi.mocked(api.assets.file);

function stubShareApis(supported: boolean, share: (data: ShareData) => Promise<void> = () => Promise.resolve()): void {
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: (data?: ShareData) => supported && (data?.files?.length ?? 0) > 0,
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: vi.fn(share),
  });
}

function restoreShareApis(): void {
  Reflect.deleteProperty(navigator, 'canShare');
  Reflect.deleteProperty(navigator, 'share');
}

// The share hand-off is a touch-screen behaviour; jsdom reports a desktop,
// so the touch cases have to opt in explicitly.
function setTouchDevice(touch: boolean): void {
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: touch ? 1 : 0 });
}

function stubBlobUrls(): void {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:mock' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
}

function restoreBlobUrls(): void {
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
}

const fileAttachments: ChatAttachment[] = [
  { name: 'mir-lite-log.txt', path: '/home/x/.cloudcli/assets/123-456-mir-lite-log.txt', mimeType: 'text/plain', size: 10 },
];

// On touch screens (the iOS installed PWA especially) an <a download> click
// navigates the webview to the blob URL and returning reloads the app, so a
// file card hands the download to the Web Share API there whenever the
// platform can share files — the same hand-off the transcript export uses.
// Desktop browsers keep the classic download link.
describe('ChatMessageFiles download hand-off', () => {
  afterEach(async () => {
    setTouchDevice(false);
    restoreShareApis();
    // The hand-off revokes its object URL one task after the click; let that
    // timer run before the URL stubs disappear.
    await new Promise((resolve) => setTimeout(resolve, 0));
    restoreBlobUrls();
    vi.restoreAllMocks();
  });

  it('shares the fetched blob as a file instead of navigating', async () => {
    stubShareApis(true);
    setTouchDevice(true);
    stubBlobUrls();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mockAssetsFile.mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['log-bytes'], { type: 'text/plain' })),
    } as Awaited<ReturnType<typeof api.assets.file>>);

    render(<ChatMessageFiles files={fileAttachments} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download mir-lite-log.txt' }));

    await waitFor(() => {
      expect(navigator.share).toHaveBeenCalledTimes(1);
    });
    const shareData = vi.mocked(navigator.share).mock.calls[0][0];
    expect(shareData?.files?.[0]?.name).toBe('mir-lite-log.txt');
    // The blob link is what navigates iOS away; it must never be created.
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('falls back to the download link when file sharing is unavailable', async () => {
    stubShareApis(false);
    stubBlobUrls();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mockAssetsFile.mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['log-bytes'], { type: 'text/plain' })),
    } as Awaited<ReturnType<typeof api.assets.file>>);

    render(<ChatMessageFiles files={fileAttachments} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download mir-lite-log.txt' }));

    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
    expect(navigator.share).not.toHaveBeenCalled();
  });
});
