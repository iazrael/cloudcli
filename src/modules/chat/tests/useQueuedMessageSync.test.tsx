import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type * as Api from '@/shared/api';
import type { ChatMessage } from '@/shared/types';

/**
 * The server is the only sender of queued messages. This hook keeps the page in
 * step with it: when the server starts a queued message the card goes away, the
 * viewed conversation shows the message, and a page that was offline catches up
 * when its socket comes back.
 */

let serverDrafts: unknown[] = [];
let draftRequests = 0;

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
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
      appendQueuedMessage: async (_scope: string, queuedMessage: unknown) => new Response(JSON.stringify({ queuedMessage, appended: false })),
    },
  },
}));

type DispatchFrame = { kind: string; sessionId?: string; messageFingerprint?: string };
type Listener = (event: DispatchFrame) => void;

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

  const emit = async (event: DispatchFrame) => {
    await act(async () => {
      for (const listener of listeners) listener(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  return { drafts, echoed, processing, emit };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('crypto', webcrypto);
  localStorage.clear();
  serverDrafts = [];
  draftRequests = 0;
});

test('a queued message the server started is echoed in the viewed conversation and leaves the queue', async () => {
  const { drafts, echoed, processing, emit } = await setup('session-1');
  await drafts.appendQueuedMessage('session-1', {
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
  await drafts.appendQueuedMessage('session-2', { content: 'elsewhere' });
  serverDrafts = [];

  await emit({ kind: 'queued_message_dispatched', sessionId: 'session-2' });

  assert.equal(echoed.length, 0);
  assert.deepEqual(processing, ['session-2']);
  assert.equal(drafts.readQueuedMessage('session-2'), null);
});

test('a reconnect reloads the queue, so one the server sent while offline disappears', async () => {
  const { drafts, emit } = await setup('session-1');
  await drafts.appendQueuedMessage('session-1', { content: 'sent while the phone slept' });
  serverDrafts = [];
  const before = draftRequests;

  await emit({ kind: 'websocket_reconnected' });

  assert.equal(draftRequests, before + 1);
  assert.equal(drafts.readQueuedMessage('session-1'), null);
});

test('unrelated frames leave the queue alone', async () => {
  const { drafts, echoed, emit } = await setup('session-1');
  await drafts.appendQueuedMessage('session-1', { content: 'still waiting' });
  const before = draftRequests;

  await emit({ kind: 'session_upserted', sessionId: 'session-1' });

  assert.equal(draftRequests, before);
  assert.equal(echoed.length, 0);
  assert.equal(drafts.readQueuedMessage('session-1')?.content, 'still waiting');
});

for (const localContent of ['sent text', 'sent text\nnew unsent text']) {
  test(`dispatch confirmation only echoes the exact sent input: ${localContent}`, async () => {
    const { drafts, echoed, emit } = await setup('session-1');
    await drafts.appendQueuedMessage('session-1', { content: localContent });
    const messageFingerprint = createHash('sha256')
      .update(JSON.stringify({ content: 'sent text', attachments: [] })).digest('hex');
    await emit({ kind: 'queued_message_dispatched', sessionId: 'session-1', messageFingerprint });
    await waitFor(() => assert.ok(draftRequests > 0));
    assert.deepEqual(echoed.map((message) => message.content), localContent === 'sent text' ? ['sent text'] : []);
  });
}

test('dispatch never echoes a stale card and hydrates the authoritative next queue', async () => {
  const { drafts, echoed, processing, emit } = await setup('session-1');
  await drafts.appendQueuedMessage('session-1', { content: 'stale local queue' });
  serverDrafts = [{ scope: 'session-1', text: '', queuedMessage: {
    content: 'next message from another tab', attachments: [],
  } }];
  const before = draftRequests;
  const messageFingerprint = createHash('sha256')
    .update(JSON.stringify({ content: 'actual first\n\nfrom another tab', attachments: [] })).digest('hex');

  await emit({ kind: 'queued_message_dispatched', sessionId: 'session-1', messageFingerprint });

  await waitFor(() => assert.equal(draftRequests, before + 1));
  assert.equal(echoed.length, 0);
  assert.deepEqual(processing, ['session-1']);
  assert.equal(drafts.readQueuedMessage('session-1')?.content, 'next message from another tab');
});

for (const browserCrypto of [{}, undefined]) {
  for (const matches of [true, false]) {
    test(`HTTP dispatch echoes only matching input without ${browserCrypto ? 'crypto.subtle' : 'crypto'}: ${matches}`, async () => {
      vi.stubGlobal('crypto', browserCrypto);
      const { drafts, echoed, processing, emit } = await setup('session-1');
      const attachments = [
        { name: '截图.png', path: '/uploads/shot.png', mimeType: 'image/png' },
        { name: '说明.txt', path: '/uploads/notes.txt', mimeType: 'text/plain' },
      ];
      await drafts.appendQueuedMessage('session-1', { content: '继续处理 🚀', attachments });
      const messageFingerprint = createHash('sha256')
        .update(JSON.stringify({ content: matches ? '继续处理 🚀' : '之前的消息', attachments })).digest('hex');

      await emit({ kind: 'queued_message_dispatched', sessionId: 'session-1', messageFingerprint });

      assert.deepEqual(echoed.map((message) => message.content), matches ? ['继续处理 🚀'] : []);
      if (matches) {
        assert.deepEqual(echoed[0].images?.map((file) => file.name), ['截图.png']);
        assert.deepEqual(echoed[0].files?.map((file) => file.name), ['说明.txt']);
      }
      assert.deepEqual(processing, ['session-1']);
      assert.equal(drafts.readQueuedMessage('session-1'), null);
    });
  }
}
