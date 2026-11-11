import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadAttachmentFiles } from '@/modules/chat/utils/attachmentUpload';

describe('uploadAttachmentFiles', () => {
  afterEach(() => vi.unstubAllGlobals());
  const createFile = (name: string, content = 'dummy') =>
    new File([content], name, { type: 'image/png' });

  it.each([400, 401, 403])('does not retry HTTP %s when error text mentions fetch or network', async (status) => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false, status, json: async () => ({ error: 'Failed to fetch network resource' }),
    });
    await expect(uploadAttachmentFiles([createFile('a.png')], { fetchFn, retryDelayMs: 0 }))
      .rejects.toThrow('Failed to fetch network resource');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reuses one upload identity across retries and creates a fresh identity for a new upload', async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ attachments: [{ path: '/assets/a.png' }] }) });
    await uploadAttachmentFiles([createFile('a.png')], { fetchFn, retryDelayMs: 0 });
    await uploadAttachmentFiles([createFile('a.png')], { fetchFn, retryDelayMs: 0 });
    const ids = fetchFn.mock.calls.map(([, init]) => init.headers['X-Upload-Request-Id']);
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('retries a network failure while reading a successful response body', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new TypeError('network body interrupted'); } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ attachments: [{ path: '/assets/a.png' }] }) });
    await expect(uploadAttachmentFiles([createFile('a.png')], { fetchFn, retryDelayMs: 0 }))
      .resolves.toEqual([{ path: '/assets/a.png' }]);
    expect(fetchFn.mock.calls[1][1].headers).toEqual(fetchFn.mock.calls[0][1].headers);
  });

  it('does not retry malformed successful responses', async () => {
    for (const body of [null, {}, { attachments: null }]) {
      const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
      await expect(uploadAttachmentFiles([createFile('a.png')], { fetchFn, retryDelayMs: 0 }))
        .rejects.toThrow('File upload returned an incomplete result');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it('does not retry syntax errors, aborts or arbitrary request failures', async () => {
    const errors = [new SyntaxError('bad json'), new DOMException('Aborted', 'AbortError'), new Error('network logic error')];
    for (const error of errors) {
      const fetchFn = vi.fn().mockRejectedValue(error);
      await expect(uploadAttachmentFiles([createFile('a.png')], { fetchFn, retryDelayMs: 0 })).rejects.toBe(error);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it('uploads from plain HTTP contexts without crypto.randomUUID', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ attachments: [{ path: '/assets/a.png' }] }) });
    await uploadAttachmentFiles([createFile('a.png')], { fetchFn });
    expect(fetchFn.mock.calls[0][1].headers['X-Upload-Request-Id']).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it('returns empty array when files is empty without making network calls', async () => {
    const fetchFn = vi.fn();
    const result = await uploadAttachmentFiles([], { fetchFn });
    expect(result).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('successfully uploads files on first attempt', async () => {
    const mockAttachments = [{ id: '1', name: 'img1.png', path: '/assets/img1.png' }];
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ attachments: mockAttachments }),
    });

    const file = createFile('img1.png');
    const result = await uploadAttachmentFiles([file], { fetchFn });

    expect(result).toEqual(mockAttachments);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('/api/assets/files');
    expect(init.method).toBe('POST');
    expect(init.body instanceof FormData).toBe(true);
  });

  it('retries on 502 Bad Gateway and succeeds on subsequent attempt', async () => {
    const mockAttachments = [{ id: '1', name: 'img1.png' }];
    const fetchFn = vi
      .fn()
      // First attempt: Cloudflare 502 Bad Gateway returning HTML
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      })
      // Second attempt: succeeds
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ attachments: mockAttachments }),
      });

    const file = createFile('img1.png');
    const result = await uploadAttachmentFiles([file], {
      fetchFn,
      maxRetries: 2,
      retryDelayMs: 10,
    });

    expect(result).toEqual(mockAttachments);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('retries on network failure (Failed to fetch) and succeeds', async () => {
    const mockAttachments = [{ id: '1', name: 'img1.png' }];
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ attachments: mockAttachments }),
      });

    const file = createFile('img1.png');
    const result = await uploadAttachmentFiles([file], {
      fetchFn,
      maxRetries: 2,
      retryDelayMs: 10,
    });

    expect(result).toEqual(mockAttachments);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx client errors (e.g. 400 Bad Request)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'Invalid file type. Only JPEG and PNG are allowed.' }),
    });

    const file = createFile('bad.exe');
    await expect(
      uploadAttachmentFiles([file], { fetchFn, maxRetries: 2, retryDelayMs: 10 }),
    ).rejects.toThrow('Invalid file type. Only JPEG and PNG are allowed.');

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws descriptive error with HTTP status when 502 retries are exhausted without JSON body', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });

    const file = createFile('img1.png');
    await expect(
      uploadAttachmentFiles([file], { fetchFn, maxRetries: 1, retryDelayMs: 10 }),
    ).rejects.toThrow('Server error (502 Bad Gateway)');

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws error when upload response returns incomplete attachments array', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ attachments: [{ id: '1' }] }), // Expected 2
    });

    const files = [createFile('img1.png'), createFile('img2.png')];
    await expect(
      uploadAttachmentFiles(files, { fetchFn, maxRetries: 0 }),
    ).rejects.toThrow('File upload returned an incomplete result');
  });

  it('retries on 500 and uses server json error when retries are exhausted', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'Disk space exhausted on server' }),
    });

    const file = createFile('img1.png');
    await expect(
      uploadAttachmentFiles([file], { fetchFn, maxRetries: 1, retryDelayMs: 10 }),
    ).rejects.toThrow('Disk space exhausted on server');

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws network error when network retries are exhausted', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const file = createFile('img1.png');
    await expect(
      uploadAttachmentFiles([file], { fetchFn, maxRetries: 1, retryDelayMs: 10 }),
    ).rejects.toThrow('Failed to fetch');

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([520, 522, 524])('retries Cloudflare status %s', async (status) => {
    const attachments = [{ name: 'img1.png' }];
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, status, statusText: '', json: async () => { throw new SyntaxError('html'); } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ attachments }) });
    await expect(uploadAttachmentFiles([createFile('a.png')], { fetchFn, retryDelayMs: 0 })).resolves.toEqual(attachments);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('uses the caller\'s upload identity on every attempt', async () => {
    const requestId = 'caller-owned-identity-0001';
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ attachments: [{ path: '/a' }] }) });
    await uploadAttachmentFiles([createFile('a.png')], { fetchFn, retryDelayMs: 0, requestId });
    expect(fetchFn.mock.calls.map(([, init]) => init.headers['X-Upload-Request-Id'])).toEqual([requestId, requestId]);
  });

  it('stops retrying once the caller aborts', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new TypeError('Failed to fetch');
    });
    await expect(uploadAttachmentFiles([createFile('a.png')], { fetchFn, retryDelayMs: 0, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries when server returns HTTP 400 with "Request aborted" and succeeds on subsequent attempt', async () => {
    const mockAttachments = [{ id: '1', name: 'img1.png' }];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ error: 'Request aborted' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ attachments: mockAttachments }),
      });

    const file = createFile('img1.png');
    const result = await uploadAttachmentFiles([file], {
      fetchFn,
      maxRetries: 2,
      retryDelayMs: 10,
    });

    expect(result).toEqual(mockAttachments);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('retries when server returns HTTP 400 with "Upload interrupted" and succeeds on subsequent attempt', async () => {
    const mockAttachments = [{ id: '1', name: 'img1.png' }];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ error: 'Upload interrupted' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ attachments: mockAttachments }),
      });

    const file = createFile('img1.png');
    const result = await uploadAttachmentFiles([file], {
      fetchFn,
      maxRetries: 2,
      retryDelayMs: 10,
    });

    expect(result).toEqual(mockAttachments);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
