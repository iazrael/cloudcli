import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAttachmentUploadQueue } from '@/modules/chat/utils/attachmentUploadQueue';
import { MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_SIZE_BYTES } from '@/shared/constants';

type Call = {
  file: File;
  requestId: string;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const SCOPE = 'session-1';
const file = (name: string, size = 4) => new File(['x'.repeat(size)], name, { type: 'image/png' });

describe('createAttachmentUploadQueue', () => {
  let calls: Call[];
  const upload = vi.fn();
  const create = () => createAttachmentUploadQueue(upload);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    calls = [];
    upload.mockReset().mockImplementation((uploaded: File, options: Omit<Call, 'file' | 'resolve' | 'reject'>) =>
      new Promise((resolve, reject) => { calls.push({ file: uploaded, ...options, resolve, reject }); }));
  });

  it('starts uploading on add and sends one request per file', () => {
    const queue = create();
    queue.add(SCOPE, [file('a.png'), file('b.png')]);
    expect(calls.map((call) => call.file.name)).toEqual(['a.png', 'b.png']);
    expect(queue.getItems(SCOPE).map((item) => item.status)).toEqual(['uploading', 'uploading']);
  });

  it('runs at most three uploads and starts the next one as a slot frees', async () => {
    const queue = create();
    queue.add(SCOPE, ['a', 'b', 'c', 'd', 'e'].map((name) => file(name)));
    expect(calls).toHaveLength(3);
    expect(queue.getItems(SCOPE).map((item) => item.status))
      .toEqual(['uploading', 'uploading', 'uploading', 'queued', 'queued']);
    calls[1].resolve({ path: '/b' });
    await settle();
    expect(calls).toHaveLength(4);
    expect(calls[3].file.name).toBe('d');
  });

  it('shares the three slots across scopes because they share one network', () => {
    const queue = create();
    queue.add('one', [file('a'), file('b')]);
    queue.add('two', [file('c'), file('d')]);
    expect(calls.map((call) => call.file.name)).toEqual(['a', 'b', 'c']);
    expect(queue.getItems('two').map((item) => item.status)).toEqual(['uploading', 'queued']);
  });

  it('keeps the added order whatever order the uploads finish in', async () => {
    const queue = create();
    queue.add(SCOPE, [file('a'), file('b'), file('c')]);
    calls[2].resolve({ path: '/c' });
    calls[0].resolve({ path: '/a' });
    await settle();
    calls[1].resolve({ path: '/b' });
    await settle();
    expect(queue.getItems(SCOPE).map((item) => item.uploaded))
      .toEqual([{ path: '/a' }, { path: '/b' }, { path: '/c' }]);
  });

  it('is ready only when every item is done', async () => {
    const queue = create();
    expect(queue.isReady(SCOPE)).toBe(true);
    queue.add(SCOPE, [file('a'), file('b')]);
    expect(queue.isReady(SCOPE)).toBe(false);
    calls[0].resolve({ path: '/a' });
    await settle();
    expect(queue.isReady(SCOPE)).toBe(false);
    calls[1].reject(new Error('Server error (524)'));
    await settle();
    expect(queue.isReady(SCOPE)).toBe(false);
    expect(queue.getItems(SCOPE)[1]).toMatchObject({ status: 'failed', error: 'Server error (524)' });
    queue.remove(queue.getItems(SCOPE)[1].id);
    expect(queue.isReady(SCOPE)).toBe(true);
  });

  it('removing an uploading item aborts it and frees its slot', () => {
    const queue = create();
    queue.add(SCOPE, ['a', 'b', 'c', 'd'].map((name) => file(name)));
    queue.remove(queue.getItems(SCOPE)[0].id);
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls).toHaveLength(4);
    expect(queue.getItems(SCOPE).map((item) => item.file.name)).toEqual(['b', 'c', 'd']);
  });

  it('removing a queued item never sends its request', async () => {
    const queue = create();
    queue.add(SCOPE, ['a', 'b', 'c', 'd'].map((name) => file(name)));
    queue.remove(queue.getItems(SCOPE)[3].id);
    calls[0].resolve({ path: '/a' });
    await settle();
    expect(calls).toHaveLength(3);
  });

  it('ignores the late result of a removed upload', async () => {
    const queue = create();
    const listener = vi.fn();
    queue.add(SCOPE, [file('a')]);
    const [{ id }] = queue.getItems(SCOPE);
    queue.remove(id);
    queue.subscribe(listener);
    calls[0].resolve({ path: '/a' });
    calls[0].onProgress(50);
    await settle();
    expect(listener).not.toHaveBeenCalled();
    expect(queue.getItems(SCOPE)).toHaveLength(0);
  });

  it('retries a failed item under the same upload identity', async () => {
    const queue = create();
    queue.add(SCOPE, [file('a')]);
    calls[0].reject(new Error('boom'));
    await settle();
    queue.retry(queue.getItems(SCOPE)[0].id);
    expect(calls).toHaveLength(2);
    expect(calls[1].requestId).toBe(calls[0].requestId);
    expect(queue.getItems(SCOPE)[0]).toMatchObject({ status: 'uploading' });
    expect(queue.getItems(SCOPE)[0].error).toBeUndefined();
  });

  it('gives every item its own identity even when names match', async () => {
    const queue = create();
    queue.add(SCOPE, [file('image.png'), file('image.png')]);
    expect(calls[0].requestId).not.toBe(calls[1].requestId);
    calls[0].onProgress(40);
    const [first, second] = queue.getItems(SCOPE);
    expect(queue.getProgress(first.id)).toBe(40);
    expect(queue.getProgress(second.id)).toBe(0);
    calls[1].reject(new Error('boom'));
    await settle();
    expect(queue.getItems(SCOPE).map((item) => item.status)).toEqual(['uploading', 'failed']);
  });

  it('keeps scopes apart', async () => {
    const queue = create();
    queue.add('one', [file('a')]);
    queue.add('two', [file('b')]);
    calls[0].resolve({ path: '/a' });
    await settle();
    expect(queue.isReady('one')).toBe(true);
    expect(queue.isReady('two')).toBe(false);
    expect(queue.take('one').map((item) => item.file.name)).toEqual(['a']);
    expect(queue.getItems('one')).toHaveLength(0);
    expect(queue.getItems('two')).toHaveLength(1);
  });

  it('marks an oversized file without uploading it, and it blocks sending', () => {
    const queue = create();
    queue.add(SCOPE, [file('big.png', MAX_ATTACHMENT_SIZE_BYTES + 1)]);
    expect(calls).toHaveLength(0);
    expect(queue.getItems(SCOPE)[0].status).toBe('tooLarge');
    expect(queue.isReady(SCOPE)).toBe(false);
    queue.retry(queue.getItems(SCOPE)[0].id);
    expect(calls).toHaveLength(0);
  });

  it('drops files past the attachment limit without uploading them', () => {
    const queue = create();
    queue.add(SCOPE, Array.from({ length: MAX_ATTACHMENT_COUNT + 2 }, (_, index) => file(`${index}`)));
    expect(queue.getItems(SCOPE)).toHaveLength(MAX_ATTACHMENT_COUNT);
    queue.add(SCOPE, [file('late')]);
    expect(queue.getItems(SCOPE)).toHaveLength(MAX_ATTACHMENT_COUNT);
  });

  it('restores uploaded entries as done, ahead of newer attachments, without uploading', () => {
    const queue = create();
    queue.add(SCOPE, [file('new')]);
    queue.restore(SCOPE, [{ file: file('old'), uploaded: { path: '/old' } }]);
    expect(calls).toHaveLength(1);
    expect(queue.getItems(SCOPE).map((item) => [item.file.name, item.status]))
      .toEqual([['old', 'done'], ['new', 'uploading']]);
  });

  it('abortAll cancels everything and late results change nothing', async () => {
    const queue = create();
    queue.add(SCOPE, ['a', 'b', 'c', 'd'].map((name) => file(name)));
    queue.abortAll();
    expect(calls.every((call) => call.signal.aborted)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(queue.getItems(SCOPE)).toHaveLength(0);
    calls[0].resolve({ path: '/a' });
    await settle();
    expect(queue.getItems(SCOPE)).toHaveLength(0);
    expect(calls).toHaveLength(3);
  });

  it('keeps the item list identity through progress and tells only that item', () => {
    const queue = create();
    queue.add(SCOPE, [file('a'), file('b')]);
    const items = queue.getItems(SCOPE);
    const listener = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    queue.subscribe(listener);
    queue.subscribeProgress(items[0].id, first);
    queue.subscribeProgress(items[1].id, second);
    calls[0].onProgress(10);
    calls[0].onProgress(10);
    calls[0].onProgress(11);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(queue.getItems(SCOPE)).toBe(items);
  });

  it('returns one stable empty list so an idle composer never re-renders', () => {
    const queue = create();
    expect(queue.getItems('one')).toBe(queue.getItems('two'));
  });
});
