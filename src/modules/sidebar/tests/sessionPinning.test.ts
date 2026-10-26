import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { Project, RecentConversationListItem } from '@/shared/types';

/**
 * A pinned session sits above every unpinned one, in a project's list and in
 * the cross-project Conversations list alike; inside each group activity time
 * still decides the order. Pinning is not activity, so unpinning drops the
 * session back to where its time puts it.
 */

const recentConversationsResponse = vi.fn();
const pinSessionResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: () => recentConversationsResponse(),
    pinSession: (sessionId: string, isPinned: boolean) => pinSessionResponse(sessionId, isPinned),
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');
const { getAllSessions } = await import('@/modules/sidebar/utils/sidebarProjectFormatting');

const t = ((key: string) => key) as unknown as TFunction;

const conversation = (
  sessionId: string,
  lastActivity: string,
  isPinned = false,
): RecentConversationListItem => ({
  sessionId,
  provider: 'claude',
  projectId: 'project-1',
  projectDisplayName: 'repo',
  sessionTitle: sessionId,
  lastActivity,
  isPinned,
});

// Hoisted so every render sees the same references; fresh arrays and sets
// would re-fire the controller's effects on each render.
const NO_PROJECTS: Project[] = [];
const NO_SESSIONS: ReadonlySet<string> = new Set<string>();

const renderController = (onRefresh = vi.fn()) => {
  const callbacks = {
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
  };
  return renderHook(() => useSidebarController({
    projects: NO_PROJECTS,
    selectedProject: null,
    selectedSession: null,
    activeSessions: NO_SESSIONS,
    backgroundSessionIds: NO_SESSIONS,
    isLoading: false,
    isMobile: false,
    t,
    onRefresh,
    ...callbacks,
    sidebarVisible: true,
  }));
};

const openConversationsTab = async (onRefresh = vi.fn()) => {
  const rendered = renderController(onRefresh);
  act(() => {
    rendered.result.current.setSearchMode('conversations');
  });
  await waitFor(() => {
    assert.equal(rendered.result.current.recentConversations.length, 3);
  });
  return rendered;
};

const rowIds = (rows: RecentConversationListItem[]) => rows.map((row) => row.sessionId);

beforeEach(() => {
  localStorage.clear();
  recentConversationsResponse.mockReset();
  pinSessionResponse.mockReset();
  recentConversationsResponse.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        conversations: [
          conversation('newest', '2026-09-22T12:00:00.000Z'),
          conversation('middle', '2026-09-22T11:00:00.000Z'),
          conversation('oldest', '2026-09-22T10:00:00.000Z'),
        ],
        total: 3,
        hasMore: false,
      },
    }),
  });
  pinSessionResponse.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
});

test('a project lists pinned sessions first, each group newest first', () => {
  const project: Project = {
    projectId: 'project-1',
    displayName: 'repo',
    fullPath: '/repo',
    sessions: [
      { id: 'new', lastActivity: '2026-09-22T12:00:00.000Z' },
      { id: 'old-pinned', lastActivity: '2026-09-20T12:00:00.000Z', isPinned: true },
      { id: 'mid', lastActivity: '2026-09-21T12:00:00.000Z' },
      { id: 'mid-pinned', lastActivity: '2026-09-21T13:00:00.000Z', isPinned: true },
    ],
  };

  assert.deepEqual(getAllSessions(project).map((session) => session.id), ['mid-pinned', 'old-pinned', 'new', 'mid']);
});

test('pinning a conversation moves it to the top and refreshes the projects', async () => {
  const onRefresh = vi.fn();
  const { result } = await openConversationsTab(onRefresh);

  await act(async () => {
    await result.current.setSessionPinned('oldest', true);
  });

  assert.deepEqual(pinSessionResponse.mock.calls, [['oldest', true]]);
  assert.deepEqual(rowIds(result.current.recentConversations), ['oldest', 'newest', 'middle']);
  assert.equal(result.current.recentConversations[0]?.isPinned, true);
  assert.equal(onRefresh.mock.calls.length, 1);
});

test('unpinning a conversation puts it back where its activity time belongs', async () => {
  const { result } = await openConversationsTab();

  await act(async () => {
    await result.current.setSessionPinned('middle', true);
  });
  assert.deepEqual(rowIds(result.current.recentConversations), ['middle', 'newest', 'oldest']);

  await act(async () => {
    await result.current.setSessionPinned('middle', false);
  });
  assert.deepEqual(rowIds(result.current.recentConversations), ['newest', 'middle', 'oldest']);
});

test('a failed pin request leaves the list untouched and tells the user', async () => {
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const onRefresh = vi.fn();
  pinSessionResponse.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  const { result } = await openConversationsTab(onRefresh);

  await act(async () => {
    await result.current.setSessionPinned('oldest', true);
  });

  assert.deepEqual(rowIds(result.current.recentConversations), ['newest', 'middle', 'oldest']);
  assert.equal(result.current.recentConversations[2]?.isPinned, false);
  assert.equal(onRefresh.mock.calls.length, 0);
  assert.equal(alertSpy.mock.calls.length, 1);
  alertSpy.mockRestore();
});
