import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ProjectSession, ServerEvent } from '@/shared/types';

const session = { id: 'session-1' } as ProjectSession;
const runningBudget = { used: 429_000, total: 475_000 };
let frameCounter = 0;

function mount(viewSession: ProjectSession | null) {
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const budgetUpdates: Array<Record<string, unknown> | null> = [];
  renderHook(() => {
    const sessionStore = useSessionStore();
    useChatRealtimeHandlers({
      sendMessage: () => {},
      isActive: true, subscribe, selectedSession: viewSession,
      currentSessionId: viewSession?.id ?? null, provider: 'zcode',
      setTokenBudget: (budget) => { budgetUpdates.push(budget); },
      pendingPermissionRequests: [], setPendingPermissionRequests: () => {},
      statusCheckSentAtRef: { current: new Map() }, requestLatestMessages: async () => {},
      sessionStore,
    });
  });
  const emit = (frame: Record<string, unknown>) => {
    frameCounter += 1;
    act(() => {
      for (const listener of listeners) {
        listener({
          id: `f${frameCounter}`,
          sessionId: viewSession?.id ?? null,
          provider: 'zcode',
          timestamp: '2026-01-01T00:00:00.000Z',
          ...frame,
        } as ServerEvent);
      }
    });
  };
  return { budgetUpdates, emit };
}

const tokenBudgetFrame = (sessionId: string | null) => ({
  kind: 'status', text: 'token_budget', tokenBudget: runningBudget, sessionId,
});

test('a running session budget frame never reaches the empty new-session view', () => {
  // Draft state: no session selected yet — this is the reported repro.
  const { budgetUpdates, emit } = mount(null);
  emit(tokenBudgetFrame('running-session'));

  expect(budgetUpdates).toEqual([]);
});

test('another session budget frame does not overwrite the viewed session', () => {
  const { budgetUpdates, emit } = mount(session);
  emit(tokenBudgetFrame('other-session'));

  expect(budgetUpdates).toEqual([]);
});

test('the viewed session own budget frame still updates the badge', () => {
  const { budgetUpdates, emit } = mount(session);
  emit(tokenBudgetFrame(session.id));

  expect(budgetUpdates).toEqual([runningBudget]);
});

test('a budget frame without a session id falls back to the viewed session', () => {
  // The store fills unknown senders with the viewed session id, so the
  // legacy early-frame behavior (badge before the runtime captured its id)
  // is preserved.
  const { budgetUpdates, emit } = mount(session);
  emit(tokenBudgetFrame(null));

  expect(budgetUpdates).toEqual([runningBudget]);
});
