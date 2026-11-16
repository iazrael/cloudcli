import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type * as sharedApi from '@/shared/api';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import type { SignedMediaRequest } from '@/shared/types';

const { requestSignedUrls } = vi.hoisted(() => ({ requestSignedUrls: vi.fn() }));
vi.mock('@/shared/api', async (original) => ({ ...await original<typeof sharedApi>(), requestSignedUrls }));
beforeEach(() => {
  localStorage.setItem('auth-token', crypto.randomUUID());
  requestSignedUrls.mockReset().mockImplementation(async (files: SignedMediaRequest[]) => ({ ok: true, json: async () => ({ files: files.map(({ id }) => ({ id, url: '/api/media/signed?ticket=markdown', expiresAt: Date.now() + 600_000 })) }) }));
});
const renderInProject = (markdown: string, projectId: string | null = 'project-1') => render(
  <MarkdownWorkspaceContext.Provider value={{ projectId }}><Markdown>{markdown}</Markdown></MarkdownWorkspaceContext.Provider>,
);

test('workspace images use a signed direct URL with their project and decoded reference', async () => {
  renderInProject('![gato naranja](imagenes/gato.png)');
  expect((await screen.findByRole('img')).getAttribute('src')).toBe('/api/media/signed?ticket=markdown');
  expect(requestSignedUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'project', projectId: 'project-1', path: 'imagenes/gato.png' })]);
});
test('a leading ./ is dropped before requesting a ticket', async () => {
  renderInProject('![captura](./out/captura.png)');
  await screen.findByRole('img');
  expect(requestSignedUrls).toHaveBeenCalledWith([expect.objectContaining({ path: 'out/captura.png' })]);
});
test('web URLs are left to the browser', () => {
  renderInProject('![logo](https://example.com/logo.png)');
  expect(screen.getByRole('img').getAttribute('src')).toBe('https://example.com/logo.png');
  expect(requestSignedUrls).not.toHaveBeenCalled();
});
test('a missing file keeps alt text and a recoverable error', async () => {
  requestSignedUrls.mockImplementation(async (files: SignedMediaRequest[]) => ({ ok: true, json: async () => ({ files: files.map(({ id }) => ({ id, status: 404, error: 'notFound' })) }) }));
  renderInProject('![gato](imagenes/nada.png)');
  expect((await screen.findByRole('status')).textContent).toContain('gato');
  expect(screen.queryByRole('img')).toBeNull();
});
test('without a project a relative path remains unresolved', () => {
  renderInProject('![gato](imagenes/gato.png)', null);
  expect(screen.getByRole('status').textContent).toContain('gato');
  expect(requestSignedUrls).not.toHaveBeenCalled();
});
