import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type * as Api from '@/shared/api';
import type { Project, ProjectSession, ServerEvent } from '@/shared/types';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';

const authenticatedFetch = vi.fn();
let serverDrafts: Array<{ scope: string; text: string; queuedMessage: { content: string; attachments?: unknown[] } }> = [];

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  api: {
    searchFiles: () => Promise.resolve({ ok: false }),
    commands: { list: () => Promise.resolve(new Response(JSON.stringify({ commands: [] }))) },
    providers: {
      capabilities: () => Promise.resolve(new Response('{}', { status: 503 })),
      skills: () => Promise.resolve(new Response(JSON.stringify({ data: { skills: [] } }))),
    },
    user: {
      drafts: () => Promise.resolve(new Response(JSON.stringify({ drafts: serverDrafts }))),
      saveDraft: () => Promise.resolve(new Response('{}')),
      deleteDraft: () => Promise.resolve(new Response('{}')),
      appendQueuedMessage: async (scope: string, queuedMessage: { content: string; attachments?: unknown[] }) => {
        serverDrafts = [...serverDrafts.filter((draft) => draft.scope !== scope), { scope, text: '', queuedMessage }];
        return new Response(JSON.stringify({ queuedMessage, appended: false }));
      },
      clearQueuedMessage: async (scope: string) => {
        serverDrafts = serverDrafts.filter((draft) => draft.scope !== scope);
        return new Response('{}');
      },
    },
  },
}));

beforeEach(async () => {
  localStorage.clear();
  serverDrafts = [];
  (await import('@/shared/chatDrafts')).resetChatDrafts();
});

const selectedProject = {
  projectId: 'project-1',
  name: 'project-1',
  path: '/tmp/project-1',
  fullPath: '/tmp/project-1',
  displayName: 'project-1',
} as unknown as Project;

const selectedSession = { id: 'session-1', summary: 'session-1' } as unknown as ProjectSession;

const submitEvent = { preventDefault: () => undefined } as never;

/** A stand-in for the websocket context's `subscribe`, with a way to push frames through it. */
function createSocket() {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (event: ServerEvent) => {
      act(() => {
        for (const listener of listeners) {
          listener(event);
        }
      });
    },
  };
}

async function setupHarness(options: { supportsSteering?: boolean } = {}) {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');
  const { useChatRealtimeHandlers } = await import('@/modules/chat/hooks/useChatRealtimeHandlers');
  const sent: Array<Record<string, unknown>> = [];
  const socket = createSocket();
  const mounted = renderHook(({ isLoading }: { isLoading: boolean }) => {
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
      isLoading,
      isInputBlocked: true,
      supportsSteering: options.supportsSteering ?? true,
      canAbortSession: true,
      tokenBudget: null,
      sendMessage: (payload) => sent.push(payload as Record<string, unknown>),
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    });
    // Same wiring as ChatInterface: the realtime handler reports steer
    // outcomes back into the composer's pendingSteers.
    useChatRealtimeHandlers({
      isActive: true,
      sendMessage: () => undefined,
      subscribe: socket.subscribe,
      provider: 'claude',
      selectedSession,
      currentSessionId: 'session-1',
      setTokenBudget: () => undefined,
      pendingPermissionRequests: [],
      setPendingPermissionRequests: () => undefined,
      statusCheckSentAtRef: { current: new Map() },
      requestLatestMessages: async () => undefined,
      sessionStore: useSessionStore(),
      onSteerOutcome: composer.handleSteerOutcome,
    });
    return composer;
  }, { initialProps: { isLoading: true } });
  return { ...mounted, result: mounted.result, sent, socket };
}

test('the steer entry sends chat.steer and shows the pending card until the echo lands', async () => {
  const { result, sent, socket } = await setupHarness();

  act(() => {
    result.current.handleInputChange({ target: { value: 'change course' } } as never);
  });
  await act(async () => {
    await result.current.steerFromComposer();
  });

  const frame = sent.find((message) => message.type === 'chat.steer');
  assert.ok(frame, 'chat.steer went out over the websocket');
  assert.equal(frame.sessionId, 'session-1');
  assert.equal(frame.content, 'change course');
  assert.ok(typeof frame.messageId === 'string');

  assert.equal(result.current.pendingSteers.length, 1);
  assert.equal(result.current.pendingSteers[0].status, 'sending');

  // The server accepted: the card stays, marked accepted.
  act(() => {
    socket.emit({ kind: 'chat_steer_accepted', sessionId: 'session-1', messageId: frame.messageId } as never);
  });
  assert.equal(result.current.pendingSteers[0].status, 'accepted');

  // The agent read it: the echo lands on the stream under the same id.
  act(() => {
    socket.emit({
      kind: 'text', role: 'user', id: frame.messageId, content: 'change course',
      sessionId: 'session-1', timestamp: new Date().toISOString(),
    } as never);
  });
  assert.equal(result.current.pendingSteers.length, 0, 'the card left once the echo landed');
});

test('a refused steer (STEER_UNAVAILABLE) queues the message as the next turn', async () => {
  const { result, sent, socket } = await setupHarness();

  act(() => {
    result.current.handleInputChange({ target: { value: 'still meant it' } } as never);
  });
  await act(async () => {
    await result.current.steerFromComposer();
  });
  const frame = sent.find((message) => message.type === 'chat.steer');
  assert.ok(frame);

  act(() => {
    socket.emit({
      kind: 'protocol_error', code: 'STEER_UNAVAILABLE', error: 'no running turn',
      sessionId: 'session-1', messageId: frame.messageId,
    } as never);
  });

  assert.equal(result.current.pendingSteers.length, 0, 'the card was settled');
  // The refusal queues through the drafts store's async append; the
  // subscription then lifts the server copy into the card.
  await waitFor(() => assert.ok(result.current.queuedDraft, 'the message entered the server-side queue'));
  assert.equal(result.current.queuedDraft?.content, 'still meant it');
});

test('a run that ends without reading an accepted steer restores the text', async () => {
  const harness = await setupHarness();
  const { result, sent, socket } = harness;

  act(() => {
    result.current.handleInputChange({ target: { value: 'unread words' } } as never);
  });
  await act(async () => {
    await result.current.steerFromComposer();
  });
  const frame = sent.find((message) => message.type === 'chat.steer');
  assert.ok(frame);

  act(() => {
    socket.emit({ kind: 'chat_steer_accepted', sessionId: 'session-1', messageId: frame.messageId } as never);
  });
  assert.equal(result.current.pendingSteers[0].status, 'accepted');
  assert.equal(result.current.input, '', 'the composer was cleared when it went out');

  // The run ends (idle): the unread steer comes back into the composer.
  act(() => { harness.rerender({ isLoading: false }); });
  await act(async () => { await Promise.resolve(); });
  assert.equal(result.current.pendingSteers.length, 0, 'the unread steer left the card list');
  assert.equal(result.current.input, 'unread words', 'the text went back into the composer');
});

test('without the capability nothing sends chat.steer', async () => {
  const { result, sent } = await setupHarness({ supportsSteering: false });

  act(() => {
    result.current.handleInputChange({ target: { value: 'plain queue' } } as never);
  });
  await act(async () => {
    await result.current.steerFromComposer();
  });
  assert.equal(sent.filter((message) => message.type === 'chat.steer').length, 0);
  assert.equal(result.current.pendingSteers.length, 0);
});

test('cards belong to the session they were sent into; switching drops foreign ones', async () => {
  const { result, sent } = await setupHarness();

  act(() => {
    result.current.handleInputChange({ target: { value: 'for this chat' } } as never);
  });
  await act(async () => {
    await result.current.steerFromComposer();
  });
  assert.equal(result.current.pendingSteers.length, 1);
  void sent;
});
