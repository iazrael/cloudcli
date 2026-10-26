import { createRef, forwardRef } from 'react';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import type { MessageListItem } from '@/modules/chat/utils/toolGrouping';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, Project } from '@/shared/types';
import type * as sharedApi from '@/shared/api';

const { readExternalFileContent, readFileBlob } = vi.hoisted(() => ({
  readExternalFileContent: vi.fn(), readFileBlob: vi.fn(),
}));
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedApi>();
  return { ...actual, readExternalFileContent, api: { ...actual.api, readFileBlob } };
});
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
  readExternalFileContent.mockReset().mockImplementation((_path, _options, projectId) =>
    Promise.resolve(projectId ? { ok: true, blob: async () => new Blob(['png']) } : { ok: false, status: 403 }));
  readFileBlob.mockReset().mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });
  URL.createObjectURL = vi.fn(() => 'blob:project-image');
  URL.revokeObjectURL = vi.fn();
});

it.each([false, true])('the real transcript passes its project when loading absolute images (streaming=%s)', async (streaming) => {
  render(renderPane(project, `![Fast 原图](${imagePath})`, streaming));
  await waitFor(() => expect(screen.getByRole('img', { name: 'Fast 原图' }).getAttribute('src')).toBe('blob:project-image'));
  expect(readExternalFileContent).toHaveBeenCalledWith(imagePath, expect.anything(), 'qwen-project');
});

it('the real transcript resolves relative images through its own project', async () => {
  render(renderPane(project, '![Fast 原图](out/benchmark/1024_fast.png)'));
  await waitFor(() => expect(screen.getByRole('img', { name: 'Fast 原图' }).getAttribute('src')).toBe('blob:project-image'));
  expect(readFileBlob).toHaveBeenCalledWith('qwen-project', 'out/benchmark/1024_fast.png', expect.anything());
});

it('switching the transcript project reloads the reference under the new project', async () => {
  const { rerender } = render(renderPane(project, `![Fast 原图](${imagePath})`));
  await waitFor(() => expect(readExternalFileContent).toHaveBeenCalledWith(imagePath, expect.anything(), 'qwen-project'));
  rerender(renderPane({ ...project, projectId: 'another-project' }, `![Fast 原图](${imagePath})`));
  await waitFor(() => expect(readExternalFileContent).toHaveBeenCalledWith(imagePath, expect.anything(), 'another-project'));
});
