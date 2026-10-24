import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { ChatMessage } from '@/shared/types';

/**
 * The server is the only sender of queued messages. This hook keeps the page in
 * step with it: when the server starts a queued message the card goes away, the
 * viewed conversation shows the message, and a page that was offline catches up
 * when its socket comes back.
 */

let serverDrafts: unknown[] = [];
let draftRequests = 0;

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      drafts: async () => {
        draftRequests += 1;
        return new Response(JSON.stringify({ success: true, drafts: serverDrafts }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      saveDraft: async () => new Response('{}', { status: 200 }),
      deleteDraft: async () => new Response('{}', { status: 200 }),
    },
  },
}));

type Listener = (event: { kind?: string; sessionId?: string }) => void;

async function setup(activeSessionId: string | null) {
  const drafts = await import('@/shared/chatDrafts');
  const { useQueuedMessageSync } = await import('@/modules/chat/hooks/useQueuedMessageSync');
  const listeners = new Set<Listener>();
  const echoed: ChatMessage[] = [];
  const processing: string[] = [];

  renderHook(() => useQueuedMessageSync({
    activeSessionId,
    subscribe: (listener) => {
      listeners.add(listener as Listener);
      return () => listeners.delete(listener as Listener);
    },
    addMessage: (message) => echoed.push(message),
    onSessionProcessing: (sessionId) => { if (sessionId) processing.push(sessionId); },
  }));

  const emit = async (event: { kind: string; sessionId?: string }) => {
    await act(async () => {
      for (const listener of listeners) listener(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  return { drafts, echoed, processing, emit };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  serverDrafts = [];
  draftRequests = 0;
});

test('a queued message the server started is echoed in the viewed conversation and leaves the queue', async () => {
  const { drafts, echoed, processing, emit } = await setup('session-1');
  drafts.writeQueuedMessage('session-1', {
    content: 'next step',
    attachments: [
      { name: 'shot.png', path: '/uploads/shot.png', mimeType: 'image/png' },
      { name: 'notes.txt', path: '/uploads/notes.txt', mimeType: 'text/plain' },
    ],
  });
  // The server claimed it, so its copy no longer has the queued message.
  serverDrafts = [];

  await emit({ kind: 'queued_message_dispatched', sessionId: 'session-1' });

  assert.equal(echoed.length, 1);
  assert.equal(echoed[0].type, 'user');
  assert.equal(echoed[0].content, 'next step');
  assert.deepEqual(echoed[0].images?.map((file) => file.name), ['shot.png']);
  assert.deepEqual(echoed[0].files?.map((file) => file.name), ['notes.txt']);
  assert.deepEqual(processing, ['session-1']);
  assert.equal(drafts.readQueuedMessage('session-1'), null);
});

test('a queued message started for another session is not echoed here, but marks that session busy', async () => {
  const { drafts, echoed, processing, emit } = await setup('session-1');
  drafts.writeQueuedMessage('session-2', { content: 'elsewhere' });
  serverDrafts = [];

  await emit({ kind: 'queued_message_dispatched', sessionId: 'session-2' });

  assert.equal(echoed.length, 0);
  assert.deepEqual(processing, ['session-2']);
  assert.equal(drafts.readQueuedMessage('session-2'), null);
});

test('a reconnect reloads the queue, so one the server sent while offline disappears', async () => {
  const { drafts, emit } = await setup('session-1');
  drafts.writeQueuedMessage('session-1', { content: 'sent while the phone slept' });
  serverDrafts = [];
  const before = draftRequests;

  await emit({ kind: 'websocket_reconnected' });

  assert.equal(draftRequests, before + 1);
  assert.equal(drafts.readQueuedMessage('session-1'), null);
});

test('unrelated frames leave the queue alone', async () => {
  const { drafts, echoed, emit } = await setup('session-1');
  drafts.writeQueuedMessage('session-1', { content: 'still waiting' });
  const before = draftRequests;

  await emit({ kind: 'session_upserted', sessionId: 'session-1' });

  assert.equal(draftRequests, before);
  assert.equal(echoed.length, 0);
  assert.equal(drafts.readQueuedMessage('session-1')?.content, 'still waiting');
});
