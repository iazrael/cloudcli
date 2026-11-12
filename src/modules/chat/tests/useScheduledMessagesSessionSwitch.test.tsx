import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
import type { ServerEvent } from '@/shared/types';

function listResponse(data: unknown[]): Response {
  return { json: async () => ({ data }) } as unknown as Response;
}

const MESSAGE_A = {
  id: 'sm-a',
  sessionId: 'session-a',
  content: 'from session a',
  scheduledFor: '2026-08-28T12:00:00.000Z',
  status: 'pending',
};

afterEach(() => {
  vi.restoreAllMocks();
});

test('switching sessions clears the previous session\'s scheduled messages immediately', async () => {
  vi.spyOn(api.scheduledMessages, 'list').mockImplementation(async (sessionId?: string) =>
    listResponse(sessionId === 'session-a' ? [MESSAGE_A] : []));

  const { result, rerender } = renderHook(({ sessionId }) => useScheduledMessages(sessionId), {
    initialProps: { sessionId: 'session-a' },
  });
  await waitFor(() => assert.equal(result.current.scheduledMessages.length, 1));

  rerender({ sessionId: 'session-b' });

  // The banner must not linger with session A's message while B's list loads.
  assert.equal(result.current.scheduledMessages.length, 0);
});

test('a slow fetch for the previous session cannot land on the next one', async () => {
  let releaseSessionA: (() => void) | undefined;
  vi.spyOn(api.scheduledMessages, 'list').mockImplementation((sessionId?: string) => {
    if (sessionId === 'session-a') {
      return new Promise<Response>((resolve) => {
        releaseSessionA = () => resolve(listResponse([MESSAGE_A]));
      });
    }
    return Promise.resolve(listResponse([]));
  });

  const { result, rerender } = renderHook(({ sessionId }) => useScheduledMessages(sessionId), {
    initialProps: { sessionId: 'session-a' },
  });
  rerender({ sessionId: 'session-b' });
  await waitFor(() => assert.ok(releaseSessionA));

  await act(async () => {
    releaseSessionA?.();
  });

  assert.equal(result.current.scheduledMessages.length, 0);
});

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

test('a scheduled_messages_changed frame for the open session refetches the list', async () => {
  let calls = 0;
  vi.spyOn(api.scheduledMessages, 'list').mockImplementation(async (sessionId?: string) => {
    if (sessionId === 'session-a') {
      calls += 1;
      return listResponse(calls === 1 ? [] : [MESSAGE_A]);
    }
    return listResponse([]);
  });

  const socket = createSocket();
  const { result } = renderHook(({ sessionId }) => useScheduledMessages(sessionId, socket.subscribe), {
    initialProps: { sessionId: 'session-a' },
  });
  await waitFor(() => assert.ok(calls >= 1));

  socket.emit({ kind: 'scheduled_messages_changed', sessionId: 'session-a', timestamp: new Date().toISOString() });
  await waitFor(() => assert.equal(result.current.scheduledMessages.length, 1, 'the banner picked up the server-side change'));
});

test('a scheduled_messages_changed frame for another session does not refetch', async () => {
  const list = vi.spyOn(api.scheduledMessages, 'list').mockImplementation(async () => listResponse([]));

  const socket = createSocket();
  renderHook(({ sessionId }) => useScheduledMessages(sessionId, socket.subscribe), {
    initialProps: { sessionId: 'session-a' },
  });
  await waitFor(() => assert.ok(list.mock.calls.length >= 1));
  list.mockClear();

  socket.emit({ kind: 'scheduled_messages_changed', sessionId: 'session-b', timestamp: new Date().toISOString() });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(list.mock.calls.length, 0, "another session's change must not refetch this one");
});

test('a websocket reconnect refetches, because announcements are lost while the socket is down', async () => {
  const list = vi.spyOn(api.scheduledMessages, 'list').mockImplementation(async () => listResponse([]));

  const socket = createSocket();
  renderHook(({ sessionId }) => useScheduledMessages(sessionId, socket.subscribe), {
    initialProps: { sessionId: 'session-a' },
  });
  await waitFor(() => assert.ok(list.mock.calls.length >= 1));
  list.mockClear();

  socket.emit({ kind: 'websocket_reconnected', timestamp: Date.now() });
  await waitFor(() => assert.ok(list.mock.calls.length >= 1, 'the list was read again after the reconnect'));
});

test('the one-argument call still works and never subscribes', async () => {
  const list = vi.spyOn(api.scheduledMessages, 'list').mockImplementation(async () => listResponse([]));

  const { result } = renderHook(({ sessionId }) => useScheduledMessages(sessionId), {
    initialProps: { sessionId: 'session-a' },
  });
  await waitFor(() => assert.ok(list.mock.calls.length >= 1));
  assert.equal(result.current.scheduledMessages.length, 0);
});

test('cancel resolves true when the server accepts it and false when it refuses', async () => {
  vi.spyOn(api.scheduledMessages, 'list').mockImplementation(async () => listResponse([]));
  const cancelSpy = vi.spyOn(api.scheduledMessages, 'cancel')
    .mockResolvedValueOnce({ ok: true } as unknown as Response)
    .mockRejectedValueOnce(new Error('offline'));

  const { result } = renderHook(({ sessionId }) => useScheduledMessages(sessionId), {
    initialProps: { sessionId: 'session-a' },
  });
  await waitFor(() => assert.ok(result.current.cancel));

  await act(async () => {
    assert.equal(await result.current.cancel('sm-1'), true);
    assert.equal(await result.current.cancel('sm-1'), false);
  });
  assert.equal(cancelSpy.mock.calls.length, 2);
});
