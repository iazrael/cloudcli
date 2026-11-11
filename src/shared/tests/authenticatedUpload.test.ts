import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeXhr {
  static instances: FakeXhr[] = [];
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  statusText = '';
  responseText = '';
  method = '';
  url = '';
  body: unknown = null;
  requestHeaders: Record<string, string> = {};
  responseHeaders: Record<string, string> = {};
  aborted = false;

  constructor() { FakeXhr.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.requestHeaders[name] = value; }
  getResponseHeader(name: string) { return this.responseHeaders[name] ?? null; }
  send(body: unknown) { this.body = body; }
  abort() { this.aborted = true; this.onabort?.(); }
  respond(status: number, responseText: string, headers: Record<string, string> = {}, statusText = '') {
    this.status = status;
    this.statusText = statusText;
    this.responseText = responseText;
    this.responseHeaders = headers;
    this.onload?.();
  }
}

const load = async () => {
  vi.stubEnv('VITE_IS_PLATFORM', 'false');
  vi.resetModules();
  return import('@/shared/api');
};
const authToken = () => import('@/shared/authToken');
const liveToken = (name: string) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ name, exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
};

describe('authenticatedUpload', () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends method, body, caller headers and the bearer token, then resolves a Response', async () => {
    const { authenticatedUpload } = await load();
    const { storeAuthToken } = await authToken();
    const token = liveToken('one');
    storeAuthToken(token);
    const body = new FormData();
    const pending = authenticatedUpload('/api/assets/files', { method: 'POST', headers: { 'X-Upload-Request-Id': 'abc' }, body });
    const xhr = FakeXhr.instances[0];
    expect([xhr.method, xhr.url, xhr.body]).toEqual(['POST', '/api/assets/files', body]);
    expect(xhr.requestHeaders).toEqual({ Authorization: `Bearer ${token}`, 'X-Upload-Request-Id': 'abc' });
    xhr.respond(200, '{"attachments":[]}');
    const response = await pending;
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ attachments: [] });
  });

  it('keeps HTTP failures as responses with their status', async () => {
    const { authenticatedUpload } = await load();
    const pending = authenticatedUpload('/x', { method: 'POST' });
    FakeXhr.instances[0].respond(524, '<html>', {}, 'Timeout');
    const response = await pending;
    expect(response.status).toBe(524);
    expect(response.statusText).toBe('Timeout');
  });

  it('handles an empty-body status such as 204', async () => {
    const { authenticatedUpload } = await load();
    const pending = authenticatedUpload('/x', { method: 'POST' });
    FakeXhr.instances[0].respond(204, '');
    expect((await pending).status).toBe(204);
  });

  it('reports whole percents capped at 99 and ignores unknown totals', async () => {
    const { authenticatedUpload } = await load();
    const seen: number[] = [];
    const pending = authenticatedUpload('/x', { method: 'POST' }, (progress) => seen.push(progress));
    const xhr = FakeXhr.instances[0];
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 5, total: 0 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 3 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 3 });
    expect(seen).toEqual([33, 99]);
    xhr.respond(200, '{}');
    await pending;
  });

  it('stores a refreshed token and expires the session only on a real 401', async () => {
    const { authenticatedUpload } = await load();
    const tokens = await authToken();
    const expired = vi.fn();
    window.addEventListener(tokens.AUTH_SESSION_EXPIRED_EVENT, expired);
    const token = liveToken('two');
    const refreshed = authenticatedUpload('/x', { method: 'POST' });
    FakeXhr.instances[0].respond(200, '{}', { 'X-Refreshed-Token': token });
    await refreshed;
    expect(tokens.getStoredAuthToken()).toBe(token);

    const notAuthFailure = authenticatedUpload('/x', { method: 'POST' });
    FakeXhr.instances[1].respond(200, '{}', { 'X-Auth-Error': 'stale' });
    await notAuthFailure;
    expect(expired).not.toHaveBeenCalled();

    const rejected = authenticatedUpload('/x', { method: 'POST' });
    FakeXhr.instances[2].respond(401, '{}', { 'X-Auth-Error': 'expired' });
    await rejected;
    expect(expired).toHaveBeenCalledTimes(1);
    window.removeEventListener(tokens.AUTH_SESSION_EXPIRED_EVENT, expired);
  });

  it('rejects a network failure with TypeError like fetch', async () => {
    const { authenticatedUpload } = await load();
    const pending = authenticatedUpload('/x', { method: 'POST' });
    FakeXhr.instances[0].onerror?.();
    await expect(pending).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects with AbortError when the signal aborts', async () => {
    const { authenticatedUpload } = await load();
    const controller = new AbortController();
    const pending = authenticatedUpload('/x', { method: 'POST', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.instances[0].aborted).toBe(true);
  });

  it('never opens a request for an already aborted signal', async () => {
    const { authenticatedUpload } = await load();
    const controller = new AbortController();
    controller.abort();
    await expect(authenticatedUpload('/x', { method: 'POST', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.instances).toHaveLength(0);
  });
});
