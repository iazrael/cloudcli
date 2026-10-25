import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { useSessionFork } from '@/shared/hooks/useSessionFork';

vi.mock('@/shared/api', () => ({
  api: { forkSession: vi.fn() },
}));

const forkSessionMock = api.forkSession as unknown as ReturnType<typeof vi.fn>;

const jsonResponse = (body: unknown, ok = true): Response => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
} as Response);

afterEach(() => {
  forkSessionMock.mockReset();
});

test('a second fork for the same session is ignored while the first is in flight', async () => {
  let resolveFork!: (value: Response) => void;
  forkSessionMock.mockImplementation(
    () => new Promise<Response>((resolve) => {
      resolveFork = resolve;
    }),
  );

  const { result } = renderHook(() => useSessionFork());

  let first!: ReturnType<typeof result.current.forkSession>;
  let second!: ReturnType<typeof result.current.forkSession>;
  await act(async () => {
    first = result.current.forkSession('session-1');
    second = result.current.forkSession('session-1');
  });

  expect(api.forkSession).toHaveBeenCalledTimes(1);
  expect(result.current.forkingSessionIds.has('session-1')).toBe(true);

  await act(async () => {
    resolveFork(jsonResponse({ data: { sessionId: 'fork-1', sessionName: 'Session (fork)' } }));
    await first;
    await second;
  });

  await expect(first).resolves.toEqual({ sessionId: 'fork-1', sessionName: 'Session (fork)' });
  await expect(second).resolves.toBeNull();
  expect(result.current.forkingSessionIds.has('session-1')).toBe(false);
});

test('a failed fork releases the session so it can be retried', async () => {
  forkSessionMock.mockResolvedValue(jsonResponse({ message: 'nope' }, false));

  const { result } = renderHook(() => useSessionFork());

  await act(async () => {
    await expect(result.current.forkSession('session-2')).rejects.toThrow('nope');
  });

  expect(result.current.forkingSessionIds.has('session-2')).toBe(false);
});
