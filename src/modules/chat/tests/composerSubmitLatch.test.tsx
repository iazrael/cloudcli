import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type * as Api from '@/shared/api';
import type { ChatMessage, Project } from '@/shared/types';

/**
 * Pins the composer's submit latch.
 *
 * `handleSubmit` is async: uploading attachments and allocating the session id
 * both happen before anything in the UI changes. Without a latch every click
 * landing in that window ran the whole submit again — and since the session id
 * only exists once the first POST returns, each of those clicks allocated its
 * own conversation. One long message or one image was enough to make the
 * button look dead and open five chats.
 */

const authenticatedFetch = vi.fn();

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  api: {
    getFiles: () => Promise.resolve({ ok: false }),
    slashCommands: () => Promise.resolve({ ok: false }),
    user: {
      saveDraft: () => Promise.resolve(new Response('{}')),
      deleteDraft: () => Promise.resolve(new Response('{}')),
    },
  },
}));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const selectedProject = {
  projectId: 'project-1',
  name: 'project-1',
  path: '/tmp/project-1',
  fullPath: '/tmp/project-1',
  displayName: 'project-1',
} as unknown as Project;

const submitEvent = { preventDefault: () => undefined } as never;

async function setup(options: { isConnected?: boolean } = {}) {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');

  const sent: Array<Record<string, unknown>> = [];
  const added: ChatMessage[] = [];

  const { result } = renderHook(() =>
    useChatComposerState({
      selectedProject,
      selectedSession: null,
      currentSessionId: null,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default',
      currentProviderModel: 'test-model',
      currentProviderEffort: '',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message: unknown) => sent.push(message as Record<string, unknown>),
      stickToBottomAfterSend: () => undefined,
      addMessage: (message: ChatMessage) => added.push(message),
      setPendingPermissionRequests: () => undefined,
      isConnected: options.isConnected,
    }),
  );

  const type = (value: string) =>
    act(() => {
      result.current.handleInputChange({
        target: { value, selectionStart: value.length, style: {} },
      } as never);
    });

  return { result, sent, added, type };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  authenticatedFetch.mockReset();
});

test('clicking send repeatedly while the session is being allocated opens exactly one conversation', async () => {
  const pending = deferred<Response>();
  authenticatedFetch.mockReturnValue(pending.promise);

  const { result, sent, type } = await setup();
  await type('hello world');

  await act(async () => {
    // Three clicks inside the await window, exactly as an unresponsive-looking
    // button provokes.
    void result.current.handleSubmit(submitEvent);
    void result.current.handleSubmit(submitEvent);
    void result.current.handleSubmit(submitEvent);
  });

  const createCalls = authenticatedFetch.mock.calls.filter(
    (call) => call[0] === '/api/providers/sessions',
  );
  assert.equal(createCalls.length, 1);

  await act(async () => {
    pending.resolve({
      ok: true,
      json: async () => ({ data: { sessionId: 'session-1', sessionName: 'hello world' } }),
    } as unknown as Response);
    await pending.promise;
  });

  await waitFor(() => {
    assert.equal(sent.filter((frame) => frame.type === 'chat.send').length, 1);
  });
  assert.equal(sent[0].sessionId, 'session-1');
});

test('the composer empties as soon as the send starts, not when it finishes', async () => {
  const pending = deferred<Response>();
  authenticatedFetch.mockReturnValue(pending.promise);

  const { result, type } = await setup();
  await type('hello world');
  assert.equal(result.current.input, 'hello world');

  await act(async () => {
    void result.current.handleSubmit(submitEvent);
  });

  // Still waiting on the session allocation, yet the box is already clear and
  // the button reports the in-flight send.
  assert.equal(result.current.input, '');
  assert.equal(result.current.isSubmitting, true);

  await act(async () => {
    pending.resolve({
      ok: true,
      json: async () => ({ data: { sessionId: 'session-1' } }),
    } as unknown as Response);
    await pending.promise;
  });

  await waitFor(() => {
    assert.equal(result.current.isSubmitting, false);
  });
});

test('a failed send puts the text back in the composer instead of losing it', async () => {
  authenticatedFetch.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

  const { result, sent, added, type } = await setup();
  await type('hello world');

  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });

  assert.equal(result.current.input, 'hello world');
  assert.equal(result.current.isSubmitting, false);
  assert.equal(sent.length, 0);
  assert.equal(added.length, 1);
  assert.equal(added[0].type, 'error');
});

test('the latch releases after a failure so the next click can retry', async () => {
  authenticatedFetch.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

  const { result, type } = await setup();
  await type('hello world');

  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });
  await act(async () => {
    await result.current.handleSubmit(submitEvent);
  });

  const createCalls = authenticatedFetch.mock.calls.filter(
    (call) => call[0] === '/api/providers/sessions',
  );
  assert.equal(createCalls.length, 2);
});

test('a submit refused by the latch says so, so its caller can keep the draft', async () => {
  const pending = deferred<Response>();
  authenticatedFetch.mockReturnValue(pending.promise);

  const { result, type } = await setup();
  await type('hello world');

  let accepted: boolean | undefined;
  let refused: boolean | undefined;
  await act(async () => {
    void result.current.handleSubmit(submitEvent).then((value) => {
      accepted = value;
    });
    // The queued-draft flush replays through the same entry point; it must be
    // able to tell that its message was not taken, or it would drop a draft it
    // already cleared.
    refused = await result.current.handleSubmit(submitEvent);
  });

  assert.equal(refused, false);

  await act(async () => {
    pending.resolve({
      ok: true,
      json: async () => ({ data: { sessionId: 'session-1' } }),
    } as unknown as Response);
    await pending.promise;
  });

  await waitFor(() => {
    assert.equal(accepted, true);
  });
});

test('an empty submit is refused too', async () => {
  const { result } = await setup();
  let accepted: boolean | undefined;
  await act(async () => {
    accepted = await result.current.handleSubmit(submitEvent);
  });
  assert.equal(accepted, false);
});

test('a queued message that fails to send goes back to the queue, not into the composer', async () => {
  authenticatedFetch.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

  const { result, type } = await setup();
  // The user is already typing the next message while the queued one flushes.
  await type('the next message');

  const queued = { content: 'the queued message', attachments: [] };
  await act(async () => {
    await result.current.handleSubmit(submitEvent, queued);
  });

  // The composer keeps what the user is typing, and the queued message is
  // recoverable instead of silently gone.
  assert.equal(result.current.input, 'the next message');
  assert.equal(result.current.queuedDraft?.content, 'the queued message');
});

test('a send while the socket is down keeps the text instead of dropping the message', async () => {
  const { result, sent, added, type } = await setup({ isConnected: false });
  await type('hello world');

  let accepted: boolean | undefined;
  await act(async () => {
    accepted = await result.current.handleSubmit(submitEvent);
  });

  // No session is allocated and no frame leaves: the socket would drop it.
  assert.equal(authenticatedFetch.mock.calls.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(accepted, false);
  assert.equal(result.current.input, 'hello world');
  assert.deepEqual(added.map((message) => message.type), ['error']);
});
