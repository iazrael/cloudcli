import { createRef, forwardRef } from 'react';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import type { MessageListItem } from '@/modules/chat/utils/toolGrouping';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, Project, ImageMediaRequest } from '@/shared/types';
import type * as sharedApi from '@/shared/api';

const { requestImageUrls } = vi.hoisted(() => ({ requestImageUrls: vi.fn() }));
vi.mock('@/shared/api', async (importOriginal) => ({ ...await importOriginal<typeof sharedApi>(), requestImageUrls }));
// jsdom 没有真实视口，保留真实消息和 Markdown 链路，只替换虚拟列表的布局。
vi.mock('virtua', () => ({
  Virtualizer: forwardRef(({ data, children }: {
    data: MessageListItem[]; children: (item: MessageListItem, index: number) => ReactNode;
  }, _ref) => <>{data.map(children)}</>),
}));
vi.mock('@/modules/chat/transcript/ChatExportMenu', () => ({ default: () => null }));

const imagePath = '/Users/azrael/workspaces/qwen-image/out/benchmark/1024_fast.png';
const project: Project = {
  projectId: 'qwen-project', displayName: 'qwen-image', fullPath: '/Users/azrael/workspaces/qwen-image',
};
const renderPane = (selectedProject: Project, content: string, isStreaming = false) => {
  const message: ChatMessage = { id: 'reply', type: 'assistant', content, isStreaming, timestamp: '2026-10-26T07:24:16Z' };
  return <ThemeProvider><UiPreferencesProvider>
    <ChatMessagesPane scrollRef={createRef()} virtualizerRef={createRef()} onScroll={() => {}}
      shiftOnPrepend={false} transcriptItems={[message]} chatMessages={[message]} selectedSession={null}
      provider="codex" isLoadingMoreMessages={false} highlightedItemIndex={null} createDiff={() => []}
      selectedProject={selectedProject} />
  </UiPreferencesProvider></ThemeProvider>;
};

beforeEach(() => {
  localStorage.setItem('auth-token', crypto.randomUUID());
  requestImageUrls.mockReset().mockImplementation(async (images: ImageMediaRequest[]) => ({ ok: true, json: async () => ({ images: images.map(({ id }) => ({ id, url: '/api/media/images?ticket=transcript', expiresAt: Date.now() + 600_000 })) }) }));
});

it.each([false, true])('the real transcript passes its project when loading absolute images (streaming=%s)', async (streaming) => {
  render(renderPane(project, `![Fast 原图](${imagePath})`, streaming));
  await waitFor(() => expect(screen.getByRole('img', { name: 'Fast 原图' }).getAttribute('src')).toBe('/api/media/images?ticket=transcript'));
  expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'external', path: imagePath, projectId: 'qwen-project' })]);
});

it('the real transcript resolves relative images through its own project', async () => {
  render(renderPane(project, '![Fast 原图](out/benchmark/1024_fast.png)'));
  await waitFor(() => expect(screen.getByRole('img', { name: 'Fast 原图' }).getAttribute('src')).toBe('/api/media/images?ticket=transcript'));
  expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'project', path: 'out/benchmark/1024_fast.png', projectId: 'qwen-project' })]);
});

it('switching the transcript project reloads the reference under the new project', async () => {
  const { rerender } = render(renderPane(project, `![Fast 原图](${imagePath})`));
  await waitFor(() => expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'external', path: imagePath, projectId: 'qwen-project' })]));
  rerender(renderPane({ ...project, projectId: 'another-project' }, `![Fast 原图](${imagePath})`));
  await waitFor(() => expect(requestImageUrls).toHaveBeenCalledWith([expect.objectContaining({ kind: 'external', path: imagePath, projectId: 'another-project' })]));
});
