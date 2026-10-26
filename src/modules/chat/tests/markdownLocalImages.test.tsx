import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import type * as sharedApi from '@/shared/api';

/**
 * Pins the local-image resolution contract for chat markdown: Antigravity
 * embeds verification snapshots as bare absolute filesystem paths (or
 * `file://` URLs), which no browser can load as plain <img> src. They must be
 * fetched through the allowlisted read-only endpoint into blob URLs; refused
 * paths show a recoverable error, and remote images never touch the endpoint.
 */

const { readExternalFileContent, readFileBlob } = vi.hoisted(() => ({
  readExternalFileContent: vi.fn(),
  readFileBlob: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedApi>();
  return { ...actual, readExternalFileContent, api: { ...actual.api, readFileBlob } };
});

// jsdom lacks the blob URL APIs; stub them once for the file (component
// cleanups may run after afterEach, so the stubs must never disappear).
Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:mock-image' });
Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });

const BRAIN_SNAPSHOT = '/Users/azrael/.gemini/antigravity-cli/brain/47b517a6/gallery_npc_section_perfect.jpg';

const imageBySrc = (src: string): HTMLElement | undefined =>
  screen.queryAllByRole('img').find((img) => img.getAttribute('src') === src);

afterEach(() => {
  readExternalFileContent.mockReset();
  readFileBlob.mockReset();
});

describe('Markdown local image resolution', () => {
  it('resolves a bare absolute filesystem path through the read-only endpoint', async () => {
    readExternalFileContent.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
    });

    render(<Markdown>{`![NPC 对话窗口重构效果](${BRAIN_SNAPSHOT})`}</Markdown>);

    await waitFor(() => {
      expect(imageBySrc('blob:mock-image')).toBeDefined();
    });
    expect(readExternalFileContent).toHaveBeenCalledWith(BRAIN_SNAPSHOT, expect.anything());
  });

  it('converts a file:// image URL to its filesystem path', async () => {
    readExternalFileContent.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['png-bytes'], { type: 'image/png' }),
    });

    render(<Markdown>{'![snap](file:///Users/azrael/brain/snap.png)'}</Markdown>);

    await waitFor(() => {
      expect(imageBySrc('blob:mock-image')).toBeDefined();
    });
    expect(readExternalFileContent).toHaveBeenCalledWith('/Users/azrael/brain/snap.png', expect.anything());
  });

  it('resolves Windows absolute paths with drive letters', async () => {
    readExternalFileContent.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['png-bytes'], { type: 'image/png' }),
    });

    render(<Markdown>{'![win](C:\\Users\\azrael\\AppData\\brain\\snap.png)'}</Markdown>);

    await waitFor(() => {
      expect(imageBySrc('blob:mock-image')).toBeDefined();
    });
    expect(readExternalFileContent).toHaveBeenCalledWith(
      'C:\\Users\\azrael\\AppData\\brain\\snap.png',
      expect.anything(),
    );
  });

  it('shows the reason and path without rendering a broken image when access is refused', async () => {
    readExternalFileContent.mockResolvedValue({ ok: false, status: 403 });

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
    readExternalFileContent.mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });
    render(<Markdown>{`![snap](<${source}>)`}</Markdown>);
    await waitFor(() => expect(imageBySrc('blob:mock-image')).toBeDefined());
    expect(readExternalFileContent).toHaveBeenCalledWith(expectedPath, expect.anything());
  });

  it.each([[401, 'unauthorized'], [404, 'notFound'], [500, 'failed']])(
    'explains HTTP %s failures', async (status, reason) => {
      readExternalFileContent.mockResolvedValue({ ok: false, status });
      render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain(`imageLoad.${reason}`));
      expect(screen.queryByRole('img')).toBeNull();
    },
  );

  it('retries a failed request and displays the recovered image', async () => {
    readExternalFileContent.mockRejectedValueOnce(new TypeError('Network unavailable'))
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['png']) });
    render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'common:buttons.retry' }));
    await waitFor(() => expect(imageBySrc('blob:mock-image')).toBeDefined());
    expect(readExternalFileContent).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('explains invalid image bytes even if the file request succeeded', async () => {
    readExternalFileContent.mockResolvedValue({ ok: true, blob: async () => new Blob(['not an image']) });
    render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    await waitFor(() => expect(imageBySrc('blob:mock-image')).toBeDefined());
    fireEvent.error(imageBySrc('blob:mock-image')!);
    expect(screen.getByRole('status').textContent).toContain('imageLoad.decode');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('handles browser image failures without fetching the URL through the file API', () => {
    render(<Markdown>{'![remote](https://example.com/hero.png)'}</Markdown>);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('status').textContent).toContain('imageLoad.failed');
    expect(readExternalFileContent).not.toHaveBeenCalled();
  });

  it('does not show a previous image or error while a changed source is loading', async () => {
    readExternalFileContent.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['png']) })
      .mockImplementationOnce(() => new Promise(() => {}));
    const { rerender } = render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    await waitFor(() => expect(imageBySrc('blob:mock-image')).toBeDefined());
    rerender(<Markdown>{'![next](/srv/next.png)'}</Markdown>);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });


  it('reads an absolute file inside a non-git project when the external route denies it', async () => {
    readExternalFileContent.mockResolvedValue({ ok: false, status: 403 });
    readFileBlob.mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });
    render(<MarkdownWorkspaceContext.Provider value={{ projectId: 'plain-project' }}>
      <Markdown>{'![snap](/data/plain-project/render)'}</Markdown>
    </MarkdownWorkspaceContext.Provider>);
    await waitFor(() => expect(imageBySrc('blob:mock-image')).toBeDefined());
    expect(readFileBlob).toHaveBeenCalledWith('plain-project', '/data/plain-project/render', expect.anything());
  });

  it('copies the decoded file reference from a failure', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    readExternalFileContent.mockResolvedValue({ ok: false, status: 404 });
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
    expect(readExternalFileContent).not.toHaveBeenCalled();
  });

  it('ignores bytes returned after an unmounted request is aborted', async () => {
    let finish!: (response: unknown) => void;
    readExternalFileContent.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const { unmount } = render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    const signal = readExternalFileContent.mock.calls[0][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    const blob = vi.fn(async () => new Blob(['png']));
    await act(async () => { finish({ ok: true, blob }); });
    expect(blob).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('does not reuse a revoked image when switching away and back before requests settle', async () => {
    readExternalFileContent.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['png']) })
      .mockImplementation(() => new Promise(() => {}));
    const { rerender } = render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    await waitFor(() => expect(imageBySrc('blob:mock-image')).toBeDefined());
    rerender(<Markdown>{'![next](/srv/next.png)'}</Markdown>);
    rerender(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('leaves remote images untouched', () => {
    render(<Markdown>{'![remote](https://example.com/hero.png)'}</Markdown>);

    expect(imageBySrc('https://example.com/hero.png')).toBeDefined();
    expect(readExternalFileContent).not.toHaveBeenCalled();
  });

  it('leaves web-relative static paths untouched without querying external files', () => {
    render(<Markdown>{'![logo](/logo.png) ![assets](/assets/banner.png)'}</Markdown>);

    expect(imageBySrc('/logo.png')).toBeDefined();
    expect(imageBySrc('/assets/banner.png')).toBeDefined();
    expect(readExternalFileContent).not.toHaveBeenCalled();
  });

  it('releases each resolved blob URL when its image unmounts', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:released-image');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL');
    readExternalFileContent.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
    });

    const rendered = render(<Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>);
    await waitFor(() => expect(imageBySrc('blob:released-image')).toBeDefined());
    rendered.unmount();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:released-image');
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('stops click event propagation so parent link is not triggered', async () => {
    readExternalFileContent.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
    });
    const linkClickHandler = vi.fn((e) => e.preventDefault());

    render(
      <a href="https://example.com" onClick={linkClickHandler}>
        <Markdown>{`![snap](${BRAIN_SNAPSHOT})`}</Markdown>
      </a>,
    );

    await waitFor(() => expect(imageBySrc('blob:mock-image')).toBeDefined());
    const img = imageBySrc('blob:mock-image')!;
    fireEvent.click(img);

    expect(linkClickHandler).not.toHaveBeenCalled();
  });

  it('forwards active projectId to readExternalFileContent for worktree resolution', async () => {
    readExternalFileContent.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['png-bytes'], { type: 'image/png' }),
    });

    render(
      <MarkdownWorkspaceContext.Provider value={{ projectId: 'proj-worktree' }}>
        <Markdown>{'![worktree-shot](/Users/azrael/workspaces/MirLite-worktrees/feat/shot.png)'}</Markdown>
      </MarkdownWorkspaceContext.Provider>,
    );

    await waitFor(() => {
      expect(imageBySrc('blob:mock-image')).toBeDefined();
    });
    expect(readExternalFileContent).toHaveBeenCalledWith(
      '/Users/azrael/workspaces/MirLite-worktrees/feat/shot.png',
      expect.anything(),
      'proj-worktree',
    );
  });
});
