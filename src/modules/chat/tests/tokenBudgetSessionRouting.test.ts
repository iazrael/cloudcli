import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { SessionTimelineStore } from '@/modules/chat/utils/sessionTimelineStore';
import type { ServerEvent } from '@/shared/context/WebSocketContext';
import type { ProjectSession } from '@/shared/types';

/**
 * Pins which session a `token_budget` frame is allowed to repaint. Every
 * session's frames share one socket, so an unrouted budget let a background
 * run overwrite the composer badge of the conversation on screen — and gave a
 * brand-new session an occupancy it had never spent.
 */

const budgetFrame = (sessionId: string, used: number): ServerEvent => ({
  kind: 'status',
  text: 'token_budget',
  sessionId,
  provider: 'claude',
  tokenBudget: { used, total: 200000 },
} as unknown as ServerEvent);

function setup(viewedSessionId: string | null) {
  const budgets: Array<Record<string, unknown> | null> = [];
  let emit: (event: ServerEvent) => void = () => {};

  renderHook(() => {
    const store = useRef(new SessionTimelineStore({ notify: () => {} })).current;
    const statusCheckSentAtRef = useRef(new Map<string, number>());
    useChatRealtimeHandlers({
      isActive: true,
      subscribe: (listener) => {
        emit = listener;
        return () => {};
      },
      provider: 'claude',
      selectedSession: viewedSessionId ? ({ id: viewedSessionId } as ProjectSession) : null,
      currentSessionId: null,
      setTokenBudget: (budget) => budgets.push(budget),
      pendingPermissionRequests: [],
      setPendingPermissionRequests: () => {},
      statusCheckSentAtRef,
      requestLatestMessages: async () => {},
      sessionStore: store,
    });
  });

  return { budgets, send: (event: ServerEvent) => act(() => emit(event)) };
}

test('a budget frame from another session leaves the viewed badge alone', () => {
  const { budgets, send } = setup('session-a');

  send(budgetFrame('session-b', 66000));
  assert.deepEqual(budgets, []);

  send(budgetFrame('session-a', 1200));
  assert.equal(budgets.length, 1);
  assert.equal((budgets[0] as { used: number }).used, 1200);
});

test('a new session with no id yet takes no budget from a running session', () => {
  const { budgets, send } = setup(null);

  send(budgetFrame('session-b', 66000));
  assert.deepEqual(budgets, []);
});
