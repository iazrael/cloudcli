import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/modules/i18n/locales/en/chat.json';
import zhCN from '@/modules/i18n/locales/zh-CN/chat.json';
import zhTW from '@/modules/i18n/locales/zh-TW/chat.json';
import ComposerAttachment from '@/modules/chat/composer/ComposerAttachment';
import { createAttachmentUploadQueue } from '@/modules/chat/utils/attachmentUploadQueue';
import { MAX_ATTACHMENT_SIZE_BYTES } from '@/shared/constants';
import type { ComposerAttachmentQueue } from '@/shared/types';

type Call = {
  onProgress: (progress: number) => void;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const SCOPE = 'scope';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ComposerAttachment', () => {
  let calls: Call[];
  let queue: ComposerAttachmentQueue;

  const show = () => render(<ComposerAttachment item={queue.getItems(SCOPE)[0]} queue={queue} />);
  const view = (file: File) => {
    queue.add(SCOPE, [file]);
    return show();
  };
  const refresh = (rerender: ReturnType<typeof render>['rerender']) => {
    rerender(<ComposerAttachment item={queue.getItems(SCOPE)[0]} queue={queue} />);
  };

  beforeEach(() => {
    calls = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    queue = createAttachmentUploadQueue((_file, options) => new Promise((resolve, reject) => {
      calls.push({ onProgress: options.onProgress, resolve, reject });
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the live percent over an image and drops the mask when done', async () => {
    const { rerender } = view(new File(['x'], 'a.png', { type: 'image/png' }));
    expect(screen.getByRole('progressbar').textContent).toBe('0%');
    act(() => calls[0].onProgress(42));
    expect(screen.getByRole('progressbar').textContent).toBe('42%');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    await act(async () => { calls[0].resolve({ path: '/a.png' }); await tick(); });
    refresh(rerender);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('masks a non-image file card the same way', () => {
    view(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(screen.getByRole('progressbar').textContent).toBe('0%');
  });

  it('offers retry on a failed upload and explains the error', async () => {
    const { rerender } = view(new File(['x'], 'a.png', { type: 'image/png' }));
    await act(async () => { calls[0].reject(new Error('Server error (524)')); await tick(); });
    refresh(rerender);
    const retry = screen.getByTitle('Server error (524)');
    fireEvent.click(retry);
    expect(calls).toHaveLength(2);
  });

  it('labels an oversized file and offers no retry', () => {
    view(new File([new Uint8Array(MAX_ATTACHMENT_SIZE_BYTES + 1)], 'big.png', { type: 'image/png' }));
    expect(screen.getByText('input.attachments.tooLarge')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryAllByRole('button').filter((button) => button.getAttribute('aria-label') === 'input.attachments.retry')).toHaveLength(0);
  });

  it('has every label in the three maintained languages', () => {
    const keys = Object.keys(en.input.attachments).sort();
    expect(keys).toEqual(['needsAttention', 'progress', 'retry', 'stillUploading', 'tooLarge']);
    expect(Object.keys(zhCN.input.attachments).sort()).toEqual(keys);
    expect(Object.keys(zhTW.input.attachments).sort()).toEqual(keys);
  });

  it('can be removed while uploading', () => {
    view(new File(['x'], 'a.png', { type: 'image/png' }));
    fireEvent.click(screen.getByLabelText('Remove a.png'));
    expect(queue.getItems(SCOPE)).toHaveLength(0);
  });
});
