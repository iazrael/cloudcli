import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readQueuedCompact } from '@/modules/chat/utils/chatStorage';
import type { Project, ProjectSession } from '@/shared/types';

const authenticatedFetch = vi.fn();

vi.mock('@/shared/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  api: {
    getFiles: () => Promise.resolve({ ok: false }),
    commands: {
      list: () => Promise.resolve(new Response(JSON.stringify({ commands: [] }))),
    },
    providers: {
      skills: () => Promise.resolve(new Response(JSON.stringify({ data: { skills: [] } }))),
    },
  },
}));

// The capability matrix the composer reads: a provider whose runtime can
// compact, and which queues messages while a turn is running.
let providerCapabilities: Record<string, Record<string, unknown>> = {};

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilitiesMap: () => ({ capabilities: providerCapabilities, loaded: true }),
}));

beforeEach(() => {
  localStorage.clear();
  providerCapabilities = {
    opencode: { inputWhileBusy: 'queue', supportsCompaction: true },
  };
  sentFrames = [];
  processingMarks = [];
});

const selectedProject = {
  projectId: 'project-compact',
  name: 'project-compact',
  path: '/tmp/project-compact',
  fullPath: '/tmp/project-compact',
  displayName: 'project-compact',
} as unknown as Project;

const submitEvent = { preventDefault: () => undefined } as never;

type SentFrame = {
  type?: string;
  sessionId?: string;
  content?: string;
  options?: Record<string, unknown>;
};

let sentFrames: SentFrame[] = [];
let processingMarks: string[] = [];

function renderComposer(sessionId: string, isLoading: boolean) {
  const { result, rerender } = renderHook(
    ({ loading }: { loading: boolean }) => useChatComposerState({
      selectedProject,
      selectedSession: { id: sessionId, summary: sessionId } as unknown as ProjectSession,
      currentSessionId: sessionId,
      provider: 'opencode',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default',
      currentProviderModel: 'some-model',
      currentProviderEffort: 'max',
      isLoading: loading,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (payload) => sentFrames.push(payload as SentFrame),
      onSessionProcessing: (id) => {
        if (typeof id === 'string') processingMarks.push(id);
      },
      stickToBottomAfterSend: () => undefined,
      addMessage: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    { initialProps: { loading: isLoading } },
  );

  return { result, rerender };
}

async function submitCompact(result: { current: ReturnType<typeof useChatComposerState> }) {
  act(() => {
    result.current.handleInputChange({ target: { value: '/compact' } } as never);
  });
  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });
}

test('parks /compact while a turn is running and dispatches it when that turn ends', async () => {
  const { result, rerender } = renderComposer('session-compact-busy', true);

  await submitCompact(result);

  assert.equal(sentFrames.length, 0, 'a mid-turn /compact must not race the live run');
  assert.equal(result.current.pendingCompact, true);
  assert.deepEqual(
    readQueuedCompact('session-compact-busy'),
    { options: { model: 'some-model', effort: 'max' } },
    'the request is persisted so a reload or session switch cannot lose it',
  );

  rerender({ loading: false });

  await waitFor(() => {
    assert.equal(sentFrames.length, 1, 'the parked compaction runs once the turn ends');
  });
  assert.equal(sentFrames[0]?.type, 'chat.compact');
  assert.equal(sentFrames[0]?.sessionId, 'session-compact-busy');
  assert.equal(result.current.pendingCompact, false);
  assert.equal(readQueuedCompact('session-compact-busy'), null, 'the storage key is the claim ticket');
  assert.deepEqual(processingMarks, ['session-compact-busy']);
});

test('sends /compact straight away when the session is idle', async () => {
  const { result } = renderComposer('session-compact-idle', false);

  await submitCompact(result);

  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0]?.type, 'chat.compact');
  assert.equal(result.current.pendingCompact, false);
  assert.equal(readQueuedCompact('session-compact-idle'), null);
});

test('cancelling a parked compaction leaves nothing to dispatch', async () => {
  const { result, rerender } = renderComposer('session-compact-cancel', true);

  await submitCompact(result);
  assert.equal(result.current.pendingCompact, true);

  act(() => result.current.cancelPendingCompact());

  assert.equal(result.current.pendingCompact, false);
  assert.equal(readQueuedCompact('session-compact-cancel'), null);

  rerender({ loading: false });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  assert.deepEqual(sentFrames, []);
});
