import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type * as Api from '@/shared/api';
import type { Project, ProjectSession } from '@/shared/types';

const authenticatedFetch = vi.fn();
let serverDrafts: Array<{ scope: string; text: string; queuedMessage: { content: string; attachments?: unknown[] } }> = [];

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  api: {
    searchFiles: () => Promise.resolve({ ok: false }),
    commands: {
      list: () => Promise.resolve(new Response(JSON.stringify({ commands: [] }))),
    },
    providers: {
      capabilities: () => Promise.resolve(new Response('{}', { status: 503 })),
      skills: () => Promise.resolve(new Response(JSON.stringify({ data: { skills: [] } }))),
    },
    user: {
      drafts: () => Promise.resolve(new Response(JSON.stringify({ drafts: serverDrafts }))),
      saveDraft: () => Promise.resolve(new Response('{}')),
      deleteDraft: () => Promise.resolve(new Response('{}')),
      appendQueuedMessage: async (scope: string, queuedMessage: { content: string; attachments?: unknown[] }) => {
        const earlier = serverDrafts.find((draft) => draft.scope === scope);
        const merged = earlier?.queuedMessage ? {
          ...queuedMessage,
          content: [earlier.queuedMessage.content, queuedMessage.content].join('\n\n'),
          attachments: [...(earlier.queuedMessage.attachments ?? []), ...(queuedMessage.attachments ?? [])],
        } : queuedMessage;
        serverDrafts = [...serverDrafts.filter((draft) => draft.scope !== scope), { scope, text: '', queuedMessage: merged }];
        return new Response(JSON.stringify({ queuedMessage: merged, appended: Boolean(earlier?.queuedMessage) }));
      },
      clearQueuedMessage: async (scope: string) => {
        serverDrafts = serverDrafts.filter((draft) => draft.scope !== scope);
        return new Response('{}');
      },
    },
  },
}));

// The capability matrix the composer reads. Null (still loading) means every
// provider queues while busy, which is what most cases need.
let providerCapabilities: Record<string, Record<string, unknown>> | null = null;

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilitiesMap: () => ({ capabilities: providerCapabilities, loaded: true }),
}));

beforeEach(async () => {
  localStorage.clear();
  serverDrafts = [];
  // The queue lives in a module-level store; one test's queued message must
  // not leak into the next.
  (await import('@/shared/chatDrafts')).resetChatDrafts();
  providerCapabilities = null;
});

const selectedProject = {
  projectId: 'project-1',
  name: 'project-1',
  path: '/tmp/project-1',
  fullPath: '/tmp/project-1',
  displayName: 'project-1',
} as unknown as Project;

const selectedSession = {
  id: 'session-1',
  summary: 'session-1',
} as unknown as ProjectSession;

const submitEvent = { preventDefault: () => undefined } as never;

/**
 * Drives one submit that is expected to stop at the send-over-background-work
 * prompt. Returns the pending submit promise, with the prompt now open.
 */
async function submitUpToPrompt(
  result: { current: { handleSubmit: (event: typeof submitEvent) => Promise<boolean>; backgroundSendPrompt: { work: string[] } | null } },
) {
  let submitPromise: Promise<boolean> | undefined;
  await act(async () => {
    submitPromise = result.current.handleSubmit(submitEvent);
    // Let the submit run to the prompt's await; act flushes the state update.
    await Promise.resolve();
    await Promise.resolve();
  });
  return { submitPromise: submitPromise as Promise<boolean>, prompt: result.current.backgroundSendPrompt };
}

test('sending over background work asks first; Queue puts the message on the server queue', async () => {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');

  const sent: Array<Record<string, unknown>> = [];

  const { result } = renderHook(() => {
    const sessionStore = useSessionStore();
    sessionStore.setActiveSession('session-1');
    if (!sessionStore.getSessionSlot('session-1')) {
      sessionStore.applyServerEvent({
        kind: 'status', sessionId: 'session-1', text: 'background_tasks',
        id: 'bg-start', timestamp: '2026-10-07T00:00:00.000Z', provider: 'claude',
        backgroundTasks: [{ id: 't1', toolName: 'Bash', startedAt: 1 }], backgroundWorkPending: true,
      });
    }
    const composer = useChatComposerState({
      selectedProject,
      selectedSession,
      currentSessionId: 'session-1',
      provider: 'claude',
      permissionMode: 'bypassPermissions',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'bypassPermissions',
      currentProviderModel: 'claude-3-7-sonnet',
      currentProviderEffort: 'default',
      isLoading: false,
      hasActiveBackgroundTasks: sessionStore.hasPendingBackgroundWork('session-1'),
      backgroundTasks: sessionStore.getBackgroundTasks('session-1'),
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (payload) => sent.push(payload as Record<string, unknown>),
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    });
    return { ...composer, sessionStore };
  });

  act(() => {
    result.current.handleInputChange({ target: { value: 'next command' } } as never);
  });

  const { submitPromise, prompt } = await submitUpToPrompt(result);
  assert.ok(prompt, 'the send-over-background-work prompt opened');
  assert.deepEqual((prompt as { work: string[] }).work, ['Bash']);

  await act(async () => {
    result.current.resolveBackgroundSendPrompt('queue');
    await submitPromise;
  });

  // Message should be queued, not sent
  assert.equal(sent.length, 0, 'no message sent over websocket');
  assert.ok(result.current.queuedDraft, 'message entered queued draft');
  assert.equal(result.current.queuedDraft?.content, 'next command');
  assert.equal(result.current.backgroundSendPrompt, null, 'the prompt closed once answered');

  // Execution has finished, but its follow-up reply must finish before sending.
  act(() => result.current.sessionStore.applyServerEvent({
    kind: 'status', sessionId: 'session-1', text: 'background_tasks',
    id: 'bg-reply', timestamp: '2026-10-07T00:00:01.000Z', provider: 'claude',
    backgroundTasks: [], backgroundWorkPending: true,
  }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  assert.equal(sent.length, 0, 'card removal must not send over the background reply');
  act(() => result.current.sessionStore.applyServerEvent({
    kind: 'status', sessionId: 'session-1', text: 'background_tasks',
    id: 'bg-finished', timestamp: '2026-10-07T00:00:02.000Z', provider: 'claude',
    backgroundTasks: [], backgroundWorkPending: false,
  }));

  // The page never sends it: the server does, once the work is done, whether
  // or not this page is still open or connected by then.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  assert.equal(sent.length, 0, 'the page leaves the queued message to the server');
  const { readQueuedMessage } = await import('@/shared/chatDrafts');
  assert.equal(readQueuedMessage('session-1')?.content, 'next command');
});

test('cancelling returns the message to the composer without queueing', async () => {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');

  const sent: Array<Record<string, unknown>> = [];

  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession,
      currentSessionId: 'session-1',
      provider: 'codex',
      permissionMode: 'bypassPermissions',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'bypassPermissions',
      currentProviderModel: 'gpt-5',
      currentProviderEffort: 'default',
      isLoading: false,
      hasActiveBackgroundTasks: true,
      backgroundTasks: [{ id: 't1', toolName: 'Bash', command: 'npm test', startedAt: Date.now() }],
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (payload) => sent.push(payload as Record<string, unknown>),
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  act(() => {
    result.current.handleInputChange({ target: { value: 'not yet' } } as never);
  });

  const { submitPromise, prompt } = await submitUpToPrompt(result);
  assert.ok(prompt, 'the send-over-background-work prompt opened');
  assert.deepEqual((prompt as { work: string[] }).work, ['npm test']);

  await act(async () => {
    result.current.resolveBackgroundSendPrompt('cancel');
    await submitPromise;
  });

  assert.equal(result.current.input, 'not yet', 'the draft went back into the composer');
  assert.equal(result.current.queuedDraft, null, 'nothing was queued');
  assert.equal(result.current.backgroundSendPrompt, null);
  assert.equal(sent.length, 0, 'no message sent over websocket');
  assert.deepEqual(serverDrafts, [], 'nothing reached the server queue');
});

test('"Send anyway" sends now with forceInterrupt instead of queueing', async () => {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');

  const sent: Array<Record<string, unknown>> = [];

  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession,
      currentSessionId: 'session-1',
      provider: 'codex',
      permissionMode: 'bypassPermissions',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'bypassPermissions',
      currentProviderModel: 'gpt-5',
      currentProviderEffort: 'default',
      isLoading: false,
      hasActiveBackgroundTasks: true,
      backgroundTasks: [{ id: 't1', toolName: 'Bash', command: 'npm test', startedAt: Date.now() }],
      canAbortSession: true,
      tokenBudget: null,
      sendMessage: (payload) => sent.push(payload as Record<string, unknown>),
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  act(() => {
    result.current.handleInputChange({ target: { value: 'stop waiting, go' } } as never);
  });

  const { submitPromise, prompt } = await submitUpToPrompt(result);
  assert.ok(prompt, 'the send-over-background-work prompt opened');

  await act(async () => {
    result.current.resolveBackgroundSendPrompt('send');
    await submitPromise;
  });

  await waitFor(() => assert.equal(sent.length, 1, 'the message went out over websocket'));
  assert.equal(sent[0]?.content, 'stop waiting, go');
  assert.equal((sent[0]?.options as Record<string, unknown> | undefined)?.forceInterrupt, true);
  assert.equal(result.current.queuedDraft, null);
  assert.equal(result.current.backgroundSendPrompt, null);
  assert.deepEqual(serverDrafts, [], 'the server queue stayed empty');
});

test.each(['claude', 'zcode'] as const)('%s only offers force send when it can preserve background work', async (provider) => {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');

  const sent: Array<Record<string, unknown>> = [];

  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession,
      currentSessionId: 'session-1',
      provider,
      permissionMode: 'bypassPermissions',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'bypassPermissions',
      currentProviderModel: 'claude-3-7-sonnet',
      currentProviderEffort: 'default',
      isLoading: true,
      hasActiveBackgroundTasks: true,
      backgroundTasks: [
        { id: 't1', toolName: 'Bash', command: 'npm test', startedAt: Date.now() },
      ],
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (payload) => sent.push(payload as Record<string, unknown>),
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  act(() => {
    result.current.handleInputChange({ target: { value: 'force stop and run' } } as never);
  });

  // Queueing over running background work goes through the prompt first.
  const { submitPromise } = await submitUpToPrompt(result);
  await act(async () => {
    result.current.resolveBackgroundSendPrompt('queue');
    await submitPromise;
  });

  assert.equal(sent.length, 0);
  assert.ok(result.current.queuedDraft);
  assert.equal(result.current.canForceSendQueuedDraft, provider !== 'claude');

  // User explicitly clicks force send
  await act(async () => {
    await result.current.forceSendQueuedDraft();
  });

  if (provider === 'claude') {
    assert.equal(sent.length, 0);
    assert.ok(result.current.queuedDraft);
    assert.equal(serverDrafts[0]?.queuedMessage.content, 'force stop and run');
    return;
  }
  await waitFor(() => {
    assert.equal(sent.length, 1, 'message sent after force send');
  });
  assert.equal(sent[0]?.content, 'force stop and run');
  assert.equal((sent[0]?.options as any)?.forceInterrupt, true);
});

test('appends subsequent inputs into existing queued draft without overwriting, without asking again', async () => {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');
  const sent: Array<{ content?: string; options?: Record<string, unknown> }> = [];

  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession,
      currentSessionId: 'session-1',
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default',
      currentProviderModel: 'claude-3-7-sonnet',
      currentProviderEffort: 'default',
      isLoading: false,
      hasActiveBackgroundTasks: true,
      canAbortSession: false,
      tokenBudget: null,
      setTokenBudget: () => undefined,
      sendMessage: (payload) => {
        sent.push(payload as never);
      },
      onSessionProcessing: () => undefined,
      onSessionEstablished: () => undefined,
      onFileOpen: () => undefined,
      onShowSettings: () => undefined,
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  act(() => {
    result.current.handleInputChange({ target: { value: 'first part' } } as never);
  });
  let submitPromise: Promise<boolean> | undefined;
  await act(async () => {
    submitPromise = result.current.handleSubmit(submitEvent);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.ok(result.current.backgroundSendPrompt, 'the first send asked');
  await act(async () => {
    result.current.resolveBackgroundSendPrompt('queue');
    await submitPromise;
  });
  assert.equal(result.current.queuedDraft?.content, 'first part');

  act(() => {
    result.current.handleInputChange({ target: { value: 'second part' } } as never);
  });
  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });

  // Once something is queued, follow-ups append unasked.
  assert.equal(result.current.backgroundSendPrompt, null);
  assert.equal(result.current.queuedDraft?.content, 'first part\n\nsecond part');
});

test('a queued draft offers no force send while a reply is still in flight', async () => {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');
  // The server refuses a second run while one is going (RUN_IN_PROGRESS), so
  // a force send mid-turn could only fail.
  const responding = new Map([['session-1', { statusText: 'Thinking', canInterrupt: true, startedAt: 1 }]]);
  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession,
      currentSessionId: 'session-1',
      provider: 'codex',
      permissionMode: 'bypassPermissions',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'bypassPermissions',
      currentProviderModel: 'gpt-5',
      currentProviderEffort: 'default',
      isLoading: true,
      hasActiveBackgroundTasks: true,
      backgroundTasks: [{ id: 'call_agent', toolName: 'Agent', command: 'Review', startedAt: 1 }],
      canAbortSession: true,
      processingSessions: responding,
      tokenBudget: null,
      sendMessage: () => undefined,
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  assert.equal(result.current.canForceSendQueuedDraft, false);
});

test('a reply still producing output queues silently without asking', async () => {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');
  const sent: Array<Record<string, unknown>> = [];
  const responding = new Map([['session-1', { statusText: 'Thinking', canInterrupt: true, startedAt: 1 }]]);
  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession,
      currentSessionId: 'session-1',
      provider: 'codex',
      permissionMode: 'bypassPermissions',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'bypassPermissions',
      currentProviderModel: 'gpt-5',
      currentProviderEffort: 'default',
      isLoading: true,
      hasActiveBackgroundTasks: true,
      backgroundTasks: [{ id: 'call_agent', toolName: 'Agent', command: 'Review', startedAt: 1 }],
      canAbortSession: true,
      processingSessions: responding,
      tokenBudget: null,
      sendMessage: (payload) => sent.push(payload as Record<string, unknown>),
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  act(() => {
    result.current.handleInputChange({ target: { value: 'after this turn' } } as never);
  });
  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });

  assert.equal(result.current.backgroundSendPrompt, null, 'no prompt while the reply runs');
  assert.ok(result.current.queuedDraft);
  assert.equal(sent.length, 0);
});

/**
 * Renders the composer for a session whose turn is still running, with the
 * given provider's `inputWhileBusy`, and submits one message.
 */
async function submitDuringRunningTurn(provider: string, inputWhileBusy: string, sessionId: string) {
  providerCapabilities = { [provider]: { inputWhileBusy } };
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');
  const sent: Array<Record<string, unknown>> = [];

  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      // Its own session: queued drafts persist per session across cases.
      selectedSession: { id: sessionId, summary: sessionId } as unknown as ProjectSession,
      currentSessionId: sessionId,
      provider: provider as never,
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default',
      currentProviderModel: 'some-model',
      currentProviderEffort: 'default',
      isLoading: true,
      canAbortSession: true,
      tokenBudget: null,
      sendMessage: (payload) => sent.push(payload as Record<string, unknown>),
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  act(() => {
    result.current.handleInputChange({ target: { value: 'mid-turn note' } } as never);
  });
  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });

  return { result, sent };
}

test('sends during a running turn when the provider absorbs mid-turn input', async () => {
  const { result, sent } = await submitDuringRunningTurn('opencode', 'always', 'session-midturn-always');

  assert.equal(result.current.queuesInput, false);
  assert.equal(result.current.backgroundSendPrompt, null, 'no prompt when the input is not held');
  assert.equal(result.current.queuedDraft, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, 'chat.send');
  assert.equal(sent[0]?.content, 'mid-turn note');
});

test('queues during a running turn when the provider only takes input over background work', async () => {
  const { result, sent } = await submitDuringRunningTurn('claude', 'background', 'session-midturn-background');

  assert.equal(result.current.queuesInput, true);
  assert.equal(sent.length, 0);
  assert.equal(result.current.queuedDraft?.content, 'mid-turn note');
});

test('queues during a running turn when the provider declares queue', async () => {
  const { result, sent } = await submitDuringRunningTurn('codex', 'queue', 'session-midturn-queue');

  assert.equal(result.current.queuesInput, true);
  assert.equal(sent.length, 0);
  assert.equal(result.current.queuedDraft?.content, 'mid-turn note');
});

test('the queued card follows the server: it leaves once sent and shows one queued elsewhere', async () => {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');
  const drafts = await import('@/shared/chatDrafts');
  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession,
      currentSessionId: 'session-1',
      provider: 'claude',
      permissionMode: 'bypassPermissions',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'bypassPermissions',
      currentProviderModel: 'claude-3-7-sonnet',
      currentProviderEffort: 'default',
      isLoading: true,
      canAbortSession: true,
      tokenBudget: null,
      sendMessage: () => undefined,
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

  act(() => {
    result.current.handleInputChange({ target: { value: 'after this turn' } } as never);
  });
  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });
  assert.equal(result.current.queuedDraft?.content, 'after this turn');

  // The server sent it: its copy is gone, and the page reloads the queue.
  serverDrafts = [];
  await act(async () => { await drafts.hydrateChatDrafts(); });
  assert.equal(result.current.queuedDraft, null);

  // Queued from the phone while this page was open.
  serverDrafts = [{ scope: 'session-1', text: '', queuedMessage: { content: 'from the phone' } }];
  await act(async () => { await drafts.hydrateChatDrafts(); });
  // Re-read through a cast: the null assertion above narrowed this path.
  const shown = result.current.queuedDraft as { content: string } | null;
  assert.equal(shown?.content, 'from the phone');
});
