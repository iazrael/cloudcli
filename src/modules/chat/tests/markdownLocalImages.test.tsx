import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { ImageMediaRequest } from '@/shared/types';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import type * as sharedApi from '@/shared/api';

const { requestImageUrls } = vi.hoisted(() => ({ requestImageUrls: vi.fn() }));
vi.mock('@/shared/api', async (importOriginal) => ({ ...await importOriginal<typeof sharedApi>(), requestImageUrls }));
const BRAIN_SNAPSHOT = '/Users/azrael/.gemini/antigravity-cli/brain/47b517a6/gallery_npc_section_perfect.jpg';
const imageBySrc = (src: string) => screen.queryAllByRole('img').find((img) => img.getAttribute('src') === src);
const ok = async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({ images: images.map(({ id }) => ({ id, url: '/api/media/images?ticket=local', expiresAt: Date.now() + 600_000 })) }) });
beforeEach(() => {
  localStorage.setItem('auth-token', crypto.randomUUID());
  requestImageUrls.mockReset().mockImplementation(ok);
});

describe('Markdown local image resolution', () => {
  it('resolves a bare absolute filesystem path through the read-only endpoint', async () => {

    render(<Markdown>{`![NPC 对话窗口重构效果](${BRAIN_SNAPSHOT})`}</Markdown>);

    await waitFor(() => {
      expect(imageBySrc('/api/media/images?ticket=local')).toBeDefined();
    });
    expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'external', path: BRAIN_SNAPSHOT })]);
  });

  it('converts a file:// image URL to its filesystem path', async () => {

    render(<Markdown>{'![snap](file:///Users/azrael/brain/snap.png)'}</Markdown>);

    await waitFor(() => {
      expect(imageBySrc('/api/media/images?ticket=local')).toBeDefined();
    });
    expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'external', path: '/Users/azrael/brain/snap.png' })]);
  });

  it('resolves Windows absolute paths with drive letters', async () => {

    render(<Markdown>{'![win](C:\\Users\\azrael\\AppData\\brain\\snap.png)'}</Markdown>);

    await waitFor(() => {
      expect(imageBySrc('/api/media/images?ticket=local')).toBeDefined();
    });
    expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ path: 'C:\\Users\\azrael\\AppData\\brain\\snap.png' })]);  });

  it('shows the reason and path without rendering a broken image when access is refused', async () => {
    requestImageUrls.mockResolvedValue({ ok: false, status: 403 });

    render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('imageLoad.forbidden');
      expect(screen.getByRole('status').textContent).toContain(BRAIN_SNAPSHOT);
      expect(screen.queryByRole('img')).toBeNull();
    });
  });


  it.each([
    ['/a.png', '/a.png'],
    ['/output/render', '/output/render'],
    ['/srv/图 像/a#1?.png', '/srv/图 像/a#1?.png'],
    ['/srv/a%2520b.png', '/srv/a%20b.png'],
    ['/srv/a%ZZ.png', '/srv/a%ZZ.png'],
  ])('resolves filesystem source %s without guessing its directory or extension', async (source, expectedPath) => {
    render(<Markdown>{`![snap](<${source}>)`}</Markdown>);
    await waitFor(() => expect(imageBySrc('/api/media/images?ticket=local')).toBeDefined());
    expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ path: expectedPath })]);
  });

  it.each([[401, 'unauthorized'], [404, 'notFound'], [500, 'failed']])(
    'explains HTTP %s failures', async (status, reason) => {
      requestImageUrls.mockResolvedValue({ ok: false, status });
      render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain(`imageLoad.${reason}`));
      expect(screen.queryByRole('img')).toBeNull();
    },
  );

  it('retries a failed request and displays the recovered image', async () => {
    requestImageUrls.mockRejectedValueOnce(new TypeError('Network unavailable'));
    render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'common:buttons.retry' }));
    await waitFor(() => expect(imageBySrc('/api/media/images?ticket=local')).toBeDefined());
    expect(requestImageUrls).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('explains invalid image bytes even if the file request succeeded', async () => {
    render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    await waitFor(() => expect(imageBySrc('/api/media/images?ticket=local')).toBeDefined());
    fireEvent.error(imageBySrc('/api/media/images?ticket=local')!);
    await waitFor(() => expect(requestImageUrls).toHaveBeenCalledTimes(2));
    fireEvent.error(imageBySrc('/api/media/images?ticket=local')!);
    expect(screen.getByRole('status').textContent).toContain('imageLoad.decode');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('handles browser image failures without fetching the URL through the file API', () => {
    render(<Markdown>{'![remote](https://example.com/hero.png)'}</Markdown>);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('status').textContent).toContain('imageLoad.failed');
    expect(requestImageUrls).not.toHaveBeenCalled();
  });

  it('does not show a previous image or error while a changed source is loading', async () => {
    requestImageUrls.mockImplementationOnce(ok).mockImplementationOnce(() => new Promise(() => {}));
    const { rerender } = render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    await waitFor(() => expect(imageBySrc('/api/media/images?ticket=local')).toBeDefined());
    rerender(<Markdown>{'![next](/srv/next.png)'}</Markdown>);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });


  it('requests project fallback for an absolute file in a non-git project', async () => {
    render(<MarkdownWorkspaceContext.Provider value={{ projectId: 'plain-project' }}>
      <Markdown>{'![snap](/data/plain-project/render)'}</Markdown>
    </MarkdownWorkspaceContext.Provider>);
    await screen.findByRole('img');
    expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'external', path: '/data/plain-project/render', projectId: 'plain-project', projectFallback: true })]);
  });

  it('copies the decoded file reference from a failure', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    requestImageUrls.mockResolvedValue({ ok: false, status: 404 });
    render(<Markdown>{'![snap](/srv/my%20image.png)'}</Markdown>);
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'common:fileOperations.copyPath' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/srv/my image.png'));
    expect(screen.getByRole('status').textContent).toContain('imageLoad.copied');
  });

  it('explains a relative reference with no project and offers no futile retry', () => {
    render(<Markdown>{'![snap](output/shot.png)'}</Markdown>);
    expect(screen.getByRole('status').textContent).toContain('imageLoad.unresolved');
    expect(screen.queryByRole('button', { name: 'common:buttons.retry' })).toBeNull();
  });

  it('keeps protocol-relative images as browser URLs', () => {
    render(<Markdown>{'![remote](//example.com/hero.png)'}</Markdown>);
    expect(imageBySrc('//example.com/hero.png')).toBeDefined();
    expect(requestImageUrls).not.toHaveBeenCalled();
  });

  it('ignores a signing response that settles after unmount', async () => {
    let finish!: (response: unknown) => void;
    requestImageUrls.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { unmount } = render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    await waitFor(() => expect(requestImageUrls).toHaveBeenCalledTimes(1));
    const requests = requestImageUrls.mock.calls[0][0];
    unmount();
    await act(async () => finish(await ok(requests)));
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('reuses a valid signed URL after switching away and back', async () => {
    const { rerender } = render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    await screen.findByRole('img');
    rerender(<Markdown>{'![next](/srv/next.png)'}</Markdown>);
    rerender(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    await screen.findByRole('img');
    expect(requestImageUrls.mock.calls.flatMap(([images]) => images).filter((image) => image.path === BRAIN_SNAPSHOT)).toHaveLength(1);
  });

  it('leaves remote images untouched', () => {
    render(<Markdown>{'![remote](https://example.com/hero.png)'}</Markdown>);

    expect(imageBySrc('https://example.com/hero.png')).toBeDefined();
    expect(requestImageUrls).not.toHaveBeenCalled();
  });

  it('leaves web-relative static paths untouched without querying external files', () => {
    render(<Markdown>{'![logo](/logo.png) ![assets](/assets/banner.png)'}</Markdown>);

    expect(imageBySrc('/logo.png')).toBeDefined();
    expect(imageBySrc('/assets/banner.png')).toBeDefined();
    expect(requestImageUrls).not.toHaveBeenCalled();
  });

  it('stops click event propagation so parent link is not triggered', async () => {
    const linkClickHandler = vi.fn((e) => e.preventDefault());

    render(
      <a href="https://example.com" onClick={linkClickHandler}>
        <Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>
      </a>,
    );

    await waitFor(() => expect(imageBySrc('/api/media/images?ticket=local')).toBeDefined());
    const img = imageBySrc('/api/media/images?ticket=local')!;
    fireEvent.click(img);

    expect(linkClickHandler).not.toHaveBeenCalled();
  });

  it('forwards active projectId when signing worktree references', async () => {

    render(
      <MarkdownWorkspaceContext.Provider value={{ projectId: 'proj-worktree' }}>
        <Markdown>{'![worktree-shot](/Users/azrael/workspaces/MirLite-worktrees/feat/shot.png)'}</Markdown>
      </MarkdownWorkspaceContext.Provider>,
    );

    await waitFor(() => {
      expect(imageBySrc('/api/media/images?ticket=local')).toBeDefined();
    });
    expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({
      kind: 'external', path: '/Users/azrael/workspaces/MirLite-worktrees/feat/shot.png', projectId: 'proj-worktree', projectFallback: true,
    })]);  });
});
