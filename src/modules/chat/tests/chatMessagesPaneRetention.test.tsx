import { createRef, forwardRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { act, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { VirtualizerHandle } from 'virtua';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import type { MessageListItem } from '@/modules/chat/utils/toolGrouping';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, Project, ProjectSession } from '@/shared/types';

const { virtualizerProps } = vi.hoisted(() => ({ virtualizerProps: { current: null as null | { keepMounted?: number[]; onScroll: (offset: number) => void } } }));
// jsdom 没有真实滚动，保留真实组件链路，只替换虚拟列表的布局并截取 keepMounted。
vi.mock('virtua', () => ({
  Virtualizer: forwardRef(({ data, children, ...props }: {
    data: MessageListItem[]; children: (item: MessageListItem, index: number) => ReactNode;
    keepMounted?: number[]; onScroll: (offset: number) => void;
  }, _ref) => {
    // 断言用捕获，不是 React 状态。
    // oxlint-disable-next-line react/immutability
    virtualizerProps.current = props;
    return <>{data.map(children)}</>;
  }),
}));
vi.mock('@/modules/chat/transcript/ChatExportMenu', () => ({ default: () => null }));

const project: Project = { projectId: 'repro', displayName: 'repro', fullPath: '/tmp/repro' };
const session = (id: string | null) => (id ? ({ id } as ProjectSession) : null);

// 一行 100px、视口 600px 的均匀模型：读位 2000px 时保留窗口应为 [3, 29]。
const COUNT = 30;
const handle = {
  findItemIndex: (offset: number) => Math.round(offset / 100),
  getItemOffset: (index: number) => index * 100,
  viewportSize: 600,
} as unknown as VirtualizerHandle;

const items: ChatMessage[] = Array.from({ length: COUNT }, (_, i) => ({
  id: `m${i}`, type: 'assistant' as const, content: `row ${i}`, timestamp: '2026-11-22T00:00:00Z',
}));
const parentOnScroll = vi.fn();

const renderPane = (selectedSession: ProjectSession | null, virtualizerRef: RefObject<VirtualizerHandle>) =>
  <ThemeProvider><UiPreferencesProvider>
    <ChatMessagesPane scrollRef={createRef()} virtualizerRef={virtualizerRef} onScroll={parentOnScroll}
      shiftOnPrepend={false} transcriptItems={items} chatMessages={items} selectedSession={selectedSession}
      provider="codex" isLoadingMoreMessages={false} highlightedItemIndex={null} createDiff={() => []}
      selectedProject={project} />
  </UiPreferencesProvider></ThemeProvider>;

const range = () => virtualizerProps.current?.keepMounted;

it('keeps a window of rows around the reading position mounted via keepMounted', () => {
  const virtualizerRef = { current: handle } as RefObject<VirtualizerHandle>;
  render(renderPane(session('s1'), virtualizerRef));
  expect(range()).toBeUndefined();

  act(() => { virtualizerProps.current!.onScroll(2000); });
  expect(range()).toEqual(expect.arrayContaining([3, 29]));
  expect(range()).toHaveLength(27);

  // 滚动回调仍然转发给视口钩子。
  expect(parentOnScroll).toHaveBeenCalledWith(2000);
});

it('throttles retention updates within the interval', async () => {
  const virtualizerRef = { current: handle } as RefObject<VirtualizerHandle>;
  render(renderPane(session('s1'), virtualizerRef));
  act(() => { virtualizerProps.current!.onScroll(2000); });
  expect(range()).toEqual(expect.arrayContaining([3, 29]));

  // 间隔内的第二次滚动不更新窗口。
  act(() => { virtualizerProps.current!.onScroll(500); });
  expect(range()).toEqual(expect.arrayContaining([3, 29]));

  await new Promise((resolve) => setTimeout(resolve, 300));
  act(() => { virtualizerProps.current!.onScroll(500); });
  // 读位 500：窗口 [−1300, 2900] 覆盖到第 28 行。
  expect(range()).toEqual(expect.arrayContaining([0, 28]));
  expect(range()).toHaveLength(29);
});

it('drops the retention window when the session switches', () => {
  const virtualizerRef = { current: handle } as RefObject<VirtualizerHandle>;
  const { rerender } = render(renderPane(session('s1'), virtualizerRef));
  act(() => { virtualizerProps.current!.onScroll(2000); });
  expect(range()).toHaveLength(27);

  rerender(renderPane(session('s2'), virtualizerRef));
  expect(range()).toBeUndefined();
});
