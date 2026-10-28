import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as sharedApi from '@/shared/api';
import type { ImageMediaRequest, MarkdownImageContext } from '@/shared/types';
import MarkdownPreview from '@/modules/code-editor/markdown/MarkdownPreview';
import { imageBaseDirFromFilePath, resolveDocumentRelativePath, resolveMarkdownImageTarget } from '@/modules/code-editor/utils/markdownImagePath';

const { requestImageUrls } = vi.hoisted(() => ({ requestImageUrls: vi.fn() }));
vi.mock('@/shared/api', async (original) => ({ ...await original<typeof sharedApi>(), requestImageUrls }));
beforeEach(() => {
  localStorage.setItem('auth-token', crypto.randomUUID());
  requestImageUrls.mockReset().mockImplementation(async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({ images: images.map(({ id }) => ({ id, url: '/api/media/images?ticket=preview', expiresAt: Date.now() + 600_000 })) }) }));
});
const projectContext: MarkdownImageContext = { projectId: 'project-1', baseDir: '/repo/docs', isExternal: false };

describe('resolveDocumentRelativePath', () => {
  it('climbs out of the document directory for ../ references', () => {
    assert.equal(resolveDocumentRelativePath('/repo/docs', '../public/a.png'), '/repo/public/a.png');
  });

  it('keeps the document directory for plain relative references', () => {
    assert.equal(resolveDocumentRelativePath('/repo/docs', 'images/a.png'), '/repo/docs/images/a.png');
    assert.equal(resolveDocumentRelativePath('/repo/docs', './a.png'), '/repo/docs/a.png');
  });

  it('treats a leading slash as absolute and ignores the document directory', () => {
    assert.equal(resolveDocumentRelativePath('/repo/docs', '/other/a.png'), '/other/a.png');
    assert.equal(resolveDocumentRelativePath('/repo/docs', '/other/../a.png'), '/a.png');
  });

  it('never climbs above the filesystem root', () => {
    assert.equal(resolveDocumentRelativePath('/repo/docs', '../../../../a.png'), '/a.png');
  });
});

describe('imageBaseDirFromFilePath', () => {
  it('returns the document directory', () => {
    assert.equal(imageBaseDirFromFilePath('/repo/docs/README.md'), '/repo/docs');
    assert.equal(imageBaseDirFromFilePath('/README.md'), '/');
  });

  it('normalizes windows separators', () => {
    assert.equal(imageBaseDirFromFilePath('C:/repo/docs/a.md'), 'C:/repo/docs');
  });

  it('returns undefined when the path carries no directory', () => {
    assert.equal(imageBaseDirFromFilePath('README.md'), undefined);
  });
});

describe('resolveMarkdownImageTarget', () => {
  it('lets the browser load web, data and blob sources', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('https://example.com/a.png', projectContext),
      { kind: 'browser', src: 'https://example.com/a.png' },
    );
    assert.deepEqual(
      resolveMarkdownImageTarget('data:image/png;base64,AA', projectContext),
      { kind: 'browser', src: 'data:image/png;base64,AA' },
    );
  });

  it('decodes escaped characters before building a workspace path', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('my%20im%C3%A1genes/gato.png', projectContext),
      { kind: 'file', path: '/repo/docs/my imágenes/gato.png', external: false },
    );
  });

  it('resolves a relative path against the document directory', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('../public/a.png', projectContext),
      { kind: 'file', path: '/repo/public/a.png', external: false },
    );
  });

  it('passes an absolute path through on the project route', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('/repo/images/a.png', projectContext),
      { kind: 'file', path: '/repo/images/a.png', external: false },
    );
    assert.deepEqual(
      resolveMarkdownImageTarget('file:///repo/images/a.png', projectContext),
      { kind: 'file', path: '/repo/images/a.png', external: false },
    );
  });

  it('routes an external document through the read-only route', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('images/a.png', { baseDir: '/ext/docs', isExternal: true }),
      { kind: 'file', path: '/ext/docs/images/a.png', external: true },
    );
    assert.deepEqual(
      resolveMarkdownImageTarget('/ext/images/a.png', { isExternal: true }),
      { kind: 'file', path: '/ext/images/a.png', external: true },
    );
  });

  it('falls back to the project root when the caller has no document directory', () => {
    assert.deepEqual(
      resolveMarkdownImageTarget('images/a.png', { projectId: 'project-1', isExternal: false }),
      { kind: 'file', path: 'images/a.png', external: false },
    );
  });

  it('is unresolved without a route to read from', () => {
    assert.deepEqual(resolveMarkdownImageTarget('', projectContext), { kind: 'unresolved' });
    assert.deepEqual(
      resolveMarkdownImageTarget('images/a.png', { isExternal: false }),
      { kind: 'unresolved' },
    );
    assert.deepEqual(
      resolveMarkdownImageTarget('images/a.png', { isExternal: true }),
      { kind: 'unresolved' },
    );
  });
});

describe('MarkdownPreview images', () => {
  it.each([
    ['../public/gato.png', '/repo/public/gato.png'],
    ['file:///repo/images/gato.png', '/repo/images/gato.png'],
  ])('signs the resolved document path %s', async (source, path) => {
    render(<MarkdownPreview content={`![gato](${source})`} imageContext={projectContext} />);
    expect((await screen.findByRole('img')).getAttribute('src')).toBe('/api/media/images?ticket=preview');
    expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'project', projectId: 'project-1', path })]);
  });
  it('leaves web images to the browser', () => {
    render(<MarkdownPreview content="![logo](https://example.com/logo.png)" imageContext={projectContext} />);
    expect(screen.getByRole('img').getAttribute('src')).toBe('https://example.com/logo.png');
    expect(requestImageUrls).not.toHaveBeenCalled();
  });
  it('signs external references relative to the external document', async () => {
    render(<MarkdownPreview content="![plan](img/plan.png)" imageContext={{ baseDir: '/ext/docs', isExternal: true }} />);
    await screen.findByRole('img');
    expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'external', path: '/ext/docs/img/plan.png' })]);
  });
  it('shows alt text and allows retry when signing fails', async () => {
    requestImageUrls.mockResolvedValueOnce({ ok: false, status: 403 });
    render(<MarkdownPreview content="![gato](images/gato.png)" imageContext={projectContext} />);
    await screen.findByText('gato');
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'common:buttons.retry' }));
    await screen.findByRole('img');
    expect(requestImageUrls).toHaveBeenCalledTimes(2);
  });
  it('shows alt text without a workspace context', () => {
    render(<MarkdownPreview content="![gato](images/gato.png)" />);
    expect(screen.getByText('gato')).toBeTruthy();
    expect(requestImageUrls).not.toHaveBeenCalled();
  });
  it('opens and closes the shared viewer without downloading image bytes in JS', async () => {
    render(<MarkdownPreview content="![gato](images/gato.png)" imageContext={projectContext} />);
    fireEvent.click(await screen.findByRole('img'));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: '关闭图片预览' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
