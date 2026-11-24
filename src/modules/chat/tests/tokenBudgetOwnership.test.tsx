import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { Project, ProjectSession } from '@/shared/types';

const project: Project = {
  projectId: 'project-1', name: 'project-1', displayName: 'Project 1', fullPath: '/tmp/project-1',
};
const sessionA = { id: 'session-a' } as ProjectSession;
const sessionB = { id: 'session-b' } as ProjectSession;

const jsonResponse = (data: unknown) => new Response(JSON.stringify({ success: true, data }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

function mount(initialSession: ProjectSession) {
  return renderHook(
    ({ session }: { session: ProjectSession }) => {
      const sessionStore = useSessionStore();
      const state = useChatSessionState({
        isActive: true,
        selectedProject: project,
        selectedSession: session,
        ws: null,
        sendMessage: vi.fn(),
        resetStreamingState: vi.fn(),
        statusCheckSentAtRef: { current: new Map<string, number>() },
        sessionStore,
        showThinking: false,
      });
      return { ...state, sessionStore };
    },
    { initialProps: { session: initialSession } },
  );
}

afterEach(() => vi.unstubAllGlobals());

test('a late history page from the previous session never repaints the viewed budget', async () => {
  // The previous session's history request is still in flight when the view
  // switches (slow link). Its response carries that session's context usage.
  let resolvePreviousHistory: ((response: Response) => void) | null = null;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/token-usage')) {
      return Promise.resolve(jsonResponse({ used: 0, total: 0 }));
    }
    if (url.includes('session-a')) {
      return new Promise<Response>((resolve) => { resolvePreviousHistory = resolve; });
    }
    return Promise.resolve(jsonResponse({
      messages: [], total: 0, hasMore: false, tokenUsage: { used: 4_000, total: 160_000 },
    }));
  }));

  const { result, rerender } = mount(sessionA);
  await waitFor(() => expect(resolvePreviousHistory).not.toBeNull());
  rerender({ session: sessionB });
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));

  expect(result.current.tokenBudget).toEqual({ used: 4_000, total: 160_000 });

  await act(async () => {
    resolvePreviousHistory?.(jsonResponse({
      messages: [], total: 99, hasMore: false, tokenUsage: { used: 230_000, total: 160_000 },
    }));
  });

  // The late page did reach the store — the switch guard is what keeps its
  // usage out of the composer.
  await waitFor(() => expect(result.current.sessionStore.getSessionSlot('session-a')?.total).toBe(99));
  expect(result.current.tokenBudget).toEqual({ used: 4_000, total: 160_000 });
});

test('switching to a session with no readable usage clears the previous session number', async () => {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/token-usage')) {
      return Promise.resolve(jsonResponse({ used: 0, total: 0 }));
    }
    if (url.includes('session-a')) {
      return Promise.resolve(jsonResponse({
        messages: [], total: 0, hasMore: false, tokenUsage: { used: 230_000, total: 160_000 },
      }));
    }
    return Promise.resolve(jsonResponse({ messages: [], total: 0, hasMore: false }));
  }));

  const { result, rerender } = mount(sessionA);
  await waitFor(() => expect(result.current.tokenBudget).toEqual({ used: 230_000, total: 160_000 }));

  rerender({ session: sessionB });
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));

  expect(result.current.tokenBudget).toBeNull();
});
