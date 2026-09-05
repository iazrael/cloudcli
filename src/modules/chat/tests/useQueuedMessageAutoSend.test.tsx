import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import { readQueuedMessage, writeQueuedMessage } from '@/modules/chat/utils/chatStorage';

/**
 * Pins the app-level half of message queuing. The composer flush only covers
 * the viewed session; this hook covers every other session. It was lost in the
 * #1206 restructure, which made queued messages for background sessions never
 * dispatch when their run completed.
 */

vi.mock('@/shared/api', () => ({
  api: { runningSessions: () => Promise.resolve({ ok: false }) },
}));

type SentFrame = { type: string; sessionId?: string; content?: string };

type ProtectionActions = {
  markSessionProcessing: (id: string) => void;
  markSessionIdle: (id: string) => void;
};

async function setup(opts: { activeSessionId: string | null; isConnected?: boolean }) {
  // vi.resetModules() gives every dynamic import a fresh module instance, so
  // the hook must be imported through the same instance as the provider it
  // renders under, or the two contexts would not match.
  const [{ useQueuedMessageAutoSend }, { SessionProtectionProvider, useSessionProtectionActions }] =
    await Promise.all([
      import('@/modules/chat/hooks/useQueuedMessageAutoSend'),
      import('@/shared/context/SessionProtectionContext'),
    ]);
  const sent: SentFrame[] = [];
  const isConnected = opts.isConnected ?? true;

  const { result } = renderHook(
    () => {
      useQueuedMessageAutoSend({
        activeSessionId: opts.activeSessionId,
        isConnected,
        sendMessage: (message: unknown) => sent.push(message as SentFrame),
      });
      return useSessionProtectionActions() as unknown as ProtectionActions;
    },
    {
      wrapper: ({ children }: { children: React.ReactNode }) =>
        React.createElement(SessionProtectionProvider, null, children),
    },
  );

  return { result, sent };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

test('dispatches a queued message when a background session finishes its run', async () => {
  writeQueuedMessage('session-a', { content: 'follow-up question', options: { model: 'm1' } });
  const { result, sent } = await setup({ activeSessionId: 'session-view' });

  act(() => result.current.markSessionProcessing('session-a'));
  assert.deepEqual([...sent], [], 'nothing to dispatch while the run is still live');

  act(() => result.current.markSessionIdle('session-a'));

  assert.equal(sent.length, 1);
  const frame = sent[0];
  assert.equal(frame.type, 'chat.send');
  assert.equal(frame.sessionId, 'session-a');
  assert.equal(frame.content, 'follow-up question');
  assert.equal(readQueuedMessage('session-a'), null, 'the storage key is the claim ticket');
});

test('never dispatches for the session the user is viewing — the composer owns it', async () => {
  writeQueuedMessage('session-view', { content: 'viewed draft' });
  const { result, sent } = await setup({ activeSessionId: 'session-view' });

  act(() => {
    result.current.markSessionProcessing('session-view');
    result.current.markSessionIdle('session-view');
  });

  assert.deepEqual(sent, []);
  assert.ok(readQueuedMessage('session-view'), 'the draft stays for the composer flush');
});

test('keeps the draft when disconnected and sends nothing', async () => {
  writeQueuedMessage('session-a', { content: 'while offline' });
  const { result, sent } = await setup({ activeSessionId: 'session-view', isConnected: false });

  act(() => {
    result.current.markSessionProcessing('session-a');
    result.current.markSessionIdle('session-a');
  });

  assert.deepEqual(sent, []);
  assert.ok(readQueuedMessage('session-a'), 'an offline send would drop the frame silently');
});

test('a completed session without a queued draft dispatches nothing', async () => {
  const { result, sent } = await setup({ activeSessionId: 'session-view' });

  act(() => {
    result.current.markSessionProcessing('session-b');
    result.current.markSessionIdle('session-b');
  });

  assert.deepEqual(sent, []);
});
