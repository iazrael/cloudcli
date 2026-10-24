import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { readQueuedMessage, resetChatDrafts } from '@/shared/chatDrafts';
import { useSessionProtection } from '@/shared/hooks/useSessionProtection';
import type { ActiveBackgroundTask, Project, ProjectSession, ServerEvent, SessionActivityMap } from '@/shared/types';

const project: Project = {
  projectId: 'project-1', name: 'project-1', fullPath: '/tmp/project-1', displayName: 'Project 1',
};
const session = { id: 'session-1' } as ProjectSession;
const task: ActiveBackgroundTask = { id: 'toolu_bash', taskId: 'bash-1', toolName: 'Bash', command: 'npm test', startedAt: 1 };

beforeEach(() => {
  localStorage.clear();
  // The queue lives in a module-level store; one test's queued message must
  // not leak into the next.
  resetChatDrafts();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/files') ? [] : {
    success: true, data: { messages: [], total: 0, hasMore: false, commands: [], skills: [] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => vi.unstubAllGlobals());

function backgroundStatus(tasks: ActiveBackgroundTask[], pending = tasks.length > 0) {
  return {
    id: 'background-status', kind: 'status' as const, sessionId: session.id, provider: 'claude' as const,
    timestamp: '2026-10-09T00:00:00.000Z', text: 'background_tasks',
    backgroundTasks: tasks, backgroundWorkPending: pending,
  };
}

async function mountComposer(tasks: ActiveBackgroundTask[], processingSessions?: SessionActivityMap) {
  const sendMessage = vi.fn();
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const mounted = renderHook(({ selectedSession }: { selectedSession: ProjectSession | null }) => {
    const sessionStore = useSessionStore();
    const protection = useSessionProtection();
    const activities = processingSessions ?? protection.processingSessions;
    if (!sessionStore.getSessionSlot(session.id)) sessionStore.applyServerEvent(backgroundStatus(tasks));
    const state = useChatSessionState({
      isActive: true, selectedProject: project, selectedSession, ws: null, sendMessage,
      resetStreamingState: () => {}, statusCheckSentAtRef: { current: new Map() },
      sessionStore, showThinking: false, processingSessions: activities,
    });
    useChatRealtimeHandlers({
      sendMessage: () => {},
      isActive: true, subscribe, selectedSession, currentSessionId: state.currentSessionId,
      provider: 'claude', setTokenBudget: () => {}, pendingPermissionRequests: [],
      setPendingPermissionRequests: () => {}, statusCheckSentAtRef: { current: new Map() },
      requestLatestMessages: async () => {}, sessionStore,
      onSessionIdle: protection.markSessionIdle, onSessionProcessing: protection.markSessionProcessing,
      processingSessions: activities,
    });
    const composer = useChatComposerState({
      selectedProject: project, selectedSession, currentSessionId: state.currentSessionId,
      provider: 'claude', permissionMode: 'default', cyclePermissionMode: () => {},
      resolvePermissionModeForProvider: () => 'default', currentProviderModel: 'test-model',
      currentProviderEffort: '', isLoading: state.isProcessing, canAbortSession: state.canAbortSession,
      backgroundTasks: state.backgroundTasks, hasActiveBackgroundTasks: state.hasActiveBackgroundTasks,
      processingSessions: activities, tokenBudget: null, sendMessage, stickToBottomAfterSend: () => {},
      addMessage: () => {}, setPendingPermissionRequests: () => {},
    });
    return { ...composer, sessionStore, isLoadingSessionMessages: state.isLoadingSessionMessages,
      isProcessing: state.isProcessing, canAbortSession: state.canAbortSession,
      markSessionProcessing: protection.markSessionProcessing, activities,
    };
  }, { initialProps: { selectedSession: session } });
  await waitFor(() => expect(mounted.result.current.isLoadingSessionMessages).toBe(false));
  // Frames passed together reach the handlers before React re-renders, the
  // way two socket messages can land between renders.
  return { ...mounted, sendMessage, emit: (...frames: ServerEvent[]) => {
    act(() => { for (const frame of frames) for (const listener of listeners) listener(frame); });
  } };
}

test('stopping after the reply ends addresses the running Bash task instead of aborting a completed turn', async () => {
  const { result, sendMessage } = await mountComposer([task]);
  act(() => result.current.handleAbortSession());
  expect(sendMessage.mock.calls.map(([frame]) => frame)).toEqual([
    { type: 'chat.stop-task', sessionId: 'session-1', taskId: 'bash-1' },
  ]);
  expect(result.current.sessionStore.getBackgroundTasks(session.id)).toEqual([task]);
});

test('the background strip stops its tasks while a foreground reply is also running', async () => {
  const foreground = new Map([[session.id, { statusText: 'Thinking', canInterrupt: true, startedAt: 5 }]]);
  const { result, sendMessage } = await mountComposer([task], foreground);
  act(() => result.current.handleAbortBackgroundTasks());
  expect(sendMessage.mock.calls.map(([frame]) => frame)).toEqual([
    { type: 'chat.stop-task', sessionId: 'session-1', taskId: 'bash-1' },
  ]);
});

test.each(['Agent', 'Workflow', 'Bash'])(
  'stops every %s task using its engine id, with duplicate snapshots sent only once', async (toolName) => {
    const tasks = [
      { ...task, toolName },
      { ...task, id: 'toolu_second', taskId: 'task-2', toolName },
      { ...task, toolName },
    ];
    const { result, sendMessage } = await mountComposer(tasks);
    act(() => result.current.handleAbortSession());
    expect(sendMessage.mock.calls.map(([frame]) => frame)).toEqual([
      { type: 'chat.stop-task', sessionId: 'session-1', taskId: 'bash-1' },
      { type: 'chat.stop-task', sessionId: 'session-1', taskId: 'task-2' },
    ]);
  },
);

test('ordinary stop prioritizes a foreground reply over its background tasks', async () => {
  const foreground = new Map([[session.id, { statusText: 'Thinking', canInterrupt: true, startedAt: 5 }]]);
  const { result, sendMessage } = await mountComposer([task], foreground);
  act(() => result.current.handleAbortSession());
  expect(sendMessage.mock.calls.map(([frame]) => frame)).toEqual([
    { type: 'chat.abort', sessionId: 'session-1' },
  ]);
});

test('a noninterruptible foreground phase does not prevent stopping a background task', async () => {
  const foreground = new Map([[session.id, { statusText: 'Compacting', canInterrupt: false, startedAt: 5 }]]);
  const { result, sendMessage } = await mountComposer([task], foreground);
  act(() => result.current.handleAbortSession());
  expect(sendMessage).not.toHaveBeenCalled();
  act(() => result.current.handleAbortBackgroundTasks());
  expect(sendMessage).toHaveBeenCalledWith({ type: 'chat.stop-task', sessionId: 'session-1', taskId: 'bash-1' });
});

test('work without a task stop handle is cancelled through the held session', async () => {
  const { result, sendMessage } = await mountComposer([{ id: 'toolu_wakeup', toolName: 'ScheduleWakeup', startedAt: 1 }]);
  act(() => result.current.handleAbortSession());
  expect(sendMessage.mock.calls.map(([frame]) => frame)).toEqual([
    { type: 'chat.abort', sessionId: 'session-1' },
  ]);
});

test('queued input stays queued for the server and a pending reply can still be stopped after cards disappear', async () => {
  const { result, sendMessage } = await mountComposer([task]);
  act(() => result.current.handleInputChange({ target: { value: 'next prompt' } } as never));
  await act(async () => { await result.current.handleSubmit({ preventDefault: () => {} } as never); });
  expect(result.current.queuedDraft?.content).toBe('next prompt');
  act(() => result.current.handleAbortSession());
  expect(result.current.queuedDraft?.content).toBe('next prompt');
  expect(result.current.sessionStore.getBackgroundTasks(session.id)).toEqual([task]);

  act(() => result.current.sessionStore.applyServerEvent(backgroundStatus([], true)));
  expect(sendMessage.mock.calls.some(([frame]) => frame.type === 'chat.send')).toBe(false);
  act(() => result.current.handleAbortSession());
  expect(sendMessage).toHaveBeenLastCalledWith({ type: 'chat.abort', sessionId: 'session-1' });

  // Once the work is done the server sends it; the page never does, so a
  // page that is closed or offline by then cannot hold it back or drop it.
  act(() => result.current.sessionStore.applyServerEvent(backgroundStatus([], false)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(sendMessage.mock.calls.some(([frame]) => frame.type === 'chat.send')).toBe(false);
  expect(readQueuedMessage(session.id)?.content).toBe('next prompt');
});

test('stopping after the final completion event sends no stale abort or task request', async () => {
  const { result, sendMessage } = await mountComposer([task]);
  act(() => result.current.sessionStore.applyServerEvent(backgroundStatus([], false)));
  act(() => {
    result.current.handleAbortSession();
    result.current.handleAbortBackgroundTasks();
  });
  expect(sendMessage).not.toHaveBeenCalled();
});

test('switching sessions cannot stop the previous session tasks', async () => {
  const { result, rerender, sendMessage } = await mountComposer([task]);
  const otherSession = { id: 'session-2' } as ProjectSession;
  act(() => result.current.sessionStore.applyServerEvent({
    ...backgroundStatus([{ ...task, taskId: 'other-task' }]), sessionId: otherSession.id,
  }));
  rerender({ selectedSession: otherSession });
  await waitFor(() => expect(result.current.isLoadingSessionMessages).toBe(false));
  act(() => result.current.handleAbortSession());
  expect(sendMessage.mock.calls.map(([frame]) => frame)).toEqual([
    { type: 'chat.stop-task', sessionId: 'session-2', taskId: 'other-task' },
  ]);
});

test.each(['NO_SUCH_TASK', 'TASK_ID_REQUIRED', 'TASK_STOP_FAILED', 'ABORT_FAILED', 'RUN_IN_PROGRESS'])(
  '%s cannot clear a still running foreground reply or flush queued input', async (code) => {
  const { result, sendMessage, emit } = await mountComposer([task]);
  act(() => result.current.markSessionProcessing(session.id, { canInterrupt: true }));
  act(() => result.current.handleInputChange({ target: { value: 'wait for reply' } } as never));
  await act(async () => { await result.current.handleSubmit({ preventDefault: () => {} } as never); });
  act(() => result.current.handleAbortBackgroundTasks());
  emit({
    kind: 'protocol_error', sessionId: session.id, code,
    error: 'The task has already ended.', timestamp: '2026-10-09T00:00:01.000Z',
  });
  act(() => result.current.sessionStore.applyServerEvent(backgroundStatus([], false)));
  expect(result.current.isProcessing).toBe(true);
  expect(result.current.canAbortSession).toBe(true);
  expect(result.current.queuedDraft?.content).toBe('wait for reply');
  expect(sendMessage.mock.calls.some(([frame]) => frame.type === 'chat.send')).toBe(false);
  expect(result.current.sessionStore.getMessages(session.id).some((message) => message.content === 'The task has already ended.')).toBe(true);
  },
);

test('agents that come and go during a reply leave the reply in flight and stoppable', async () => {
  const { result, sendMessage, emit } = await mountComposer([]);
  act(() => result.current.markSessionProcessing(session.id, { canInterrupt: true }));
  const agent: ActiveBackgroundTask = { id: 'call_agent', toolName: 'Agent', command: 'Review', startedAt: 2 };

  // Codex and ZCode announce agents mid-turn; the strip lists them, but the
  // turn is still the thing in flight.
  emit(backgroundStatus([agent], false));
  expect(result.current.isProcessing).toBe(true);
  expect(result.current.activities.get(session.id)?.background).toBeUndefined();

  // The agent settling before the turn ends must not end the reply with it.
  emit(backgroundStatus([], false));
  expect(result.current.isProcessing).toBe(true);
  act(() => result.current.handleAbortSession());
  expect(sendMessage).toHaveBeenLastCalledWith({ type: 'chat.abort', sessionId: 'session-1' });
});

test('agents that settle right after the turn completes end the background phase even before a re-render', async () => {
  const { result, emit } = await mountComposer([]);
  act(() => result.current.markSessionProcessing(session.id, { canInterrupt: true }));
  const agent: ActiveBackgroundTask = { id: 'call_agent', toolName: 'Agent', command: 'Review', startedAt: 2 };
  emit(backgroundStatus([agent], false));

  emit(
    { kind: 'complete', sessionId: session.id, provider: 'claude', exitCode: 0, timestamp: '2026-10-19T00:00:01.000Z' } as ServerEvent,
    backgroundStatus([], false),
  );
  expect(result.current.activities.has(session.id)).toBe(false);
  expect(result.current.isProcessing).toBe(false);
});
