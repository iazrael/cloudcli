import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AUTH_ACCOUNT_CHANGED_EVENT } from '@/shared/constants';
import { useSignedImage } from '@/shared/hooks/useSignedImage';
import type { ImageMediaSource } from '@/shared/types';

const source: ImageMediaSource = { kind: 'project', projectId: 'p', path: 'shot.png' };
function Probe({ image = source, eager = false }: { image?: ImageMediaSource; eager?: boolean }) {
  const { observe, ...imageState } = useSignedImage(image, { eager });
  return <div ref={observe}>
    {imageState.url && <img alt="probe" src={imageState.url} onError={imageState.onError} onLoad={imageState.onLoad} />}
    {imageState.error && <span role="alert">{imageState.error}</span>}
    <button onClick={imageState.retry}>retry</button>
  </div>;
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.setItem('auth-token', `e30.${btoa(JSON.stringify({ userId: crypto.randomUUID(), exp: 4_000_000_000, iat: 1 }))}.sig`);
  fetchMock = vi.fn(async (_url, options) => {
    const { images } = JSON.parse(options.body);
    return new Response(JSON.stringify({ images: images.map(({ id }: { id: string }) => ({ id, url: `/api/media/images?ticket=${id}`, expiresAt: Date.now() + 600_000 })) }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('waits until near the viewport, then loads a direct URL without downloading image bytes in JS', async () => {
  let intersect!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { intersect = callback; } observe() {} disconnect = disconnect; });
  render(<Probe />);
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  await screen.findByRole('img');
  expect(screen.getByRole('img').getAttribute('src')).toMatch(/^\/api\/media\/images\?ticket=/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/media/image-urls');
});

it('batches neighboring images and deduplicates identical references', async () => {
  render(<><Probe eager /><Probe eager /><Probe eager image={{ ...source, path: 'other.png' }} /></>);
  await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).images).toHaveLength(2);
  expect(screen.getAllByRole('img')[0].getAttribute('src')).toBe(screen.getAllByRole('img')[1].getAttribute('src'));
});

it('automatically renews only once after image failure and allows explicit retry', async () => {
  render(<Probe eager />);
  fireEvent.error(await screen.findByRole('img'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await screen.findByRole('img');
  fireEvent.error(screen.getByRole('img'));
  expect((await screen.findByRole('alert')).textContent).toBe('decode');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByText('retry'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  await screen.findByRole('img');
});

it('never applies results for a previous image after switching references', async () => {
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<Probe eager />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const oldId = JSON.parse(fetchMock.mock.calls[0][1].body).images[0].id;
  view.rerender(<Probe eager image={{ ...source, path: 'new.png' }} />);
  await screen.findByRole('img');
  const current = screen.getByRole('img').getAttribute('src');
  await act(async () => finish(new Response(JSON.stringify({ images: [{ id: oldId, url: '/old', expiresAt: Date.now() + 600_000 }] }))));
  expect(screen.getByRole('img').getAttribute('src')).toBe(current);
});

it('does not reuse another account’s ticket after storage changes', async () => {
  render(<Probe eager />);
  const old = (await screen.findByRole('img')).getAttribute('src');
  localStorage.setItem('auth-token', `e30.${btoa(JSON.stringify({ userId: 'next-user', exp: 4_000_000_000, iat: 1 }))}.sig`);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token' })));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).not.toBe(old));
});

it('a successfully displayed image is not renewed when returning to an old tab', async () => {
  render(<Probe eager />);
  fireEvent.load(await screen.findByRole('img'));
  const realNow = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(realNow + 700_000);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('logout invalidates tickets even while all image components are unmounted', async () => {
  const view = render(<Probe eager />);
  await screen.findByRole('img');
  view.unmount();
  act(() => window.dispatchEvent(new Event(AUTH_ACCOUNT_CHANGED_EVENT)));
  render(<Probe eager />);
  await screen.findByRole('img');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
