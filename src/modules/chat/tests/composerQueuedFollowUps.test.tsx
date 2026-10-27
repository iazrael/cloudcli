import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type * as Api from '@/shared/api';
import type { ChatMessage, Project, ProjectSession } from '@/shared/types';

const queueRequest = vi.fn();
const clearRequest = vi.fn();
const upload = vi.fn();
const readAsset = vi.fn();
let remoteDrafts: unknown[] = [];

vi.mock('@/modules/chat/utils/attachmentUpload', () => ({
  uploadAttachmentFiles: (...args: unknown[]) => upload(...args),
}));
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  api: {
    getFiles: () => Promise.resolve({ ok: false }),
    commands: { list: () => Promise.resolve(new Response('{"commands":[]}')) },
    providers: {
      capabilities: () => Promise.resolve(new Response('{}', { status: 503 })),
      skills: () => Promise.resolve(new Response('{"data":{"skills":[]}}')),
    },
    assets: { file: (...args: unknown[]) => readAsset(...args) },
    user: {
      drafts: () => Promise.resolve(new Response(JSON.stringify({ drafts: remoteDrafts }))),
      saveDraft: () => Promise.resolve(new Response('{}')),
      appendQueuedMessage: (...args: unknown[]) => queueRequest(...args),
      clearQueuedMessage: (...args: unknown[]) => clearRequest(...args),
    },
  },
}));

const project = { projectId: 'p1', name: 'p1', displayName: 'p1', path: '/tmp/p1', fullPath: '/tmp/p1' } as Project;
const event = { preventDefault: () => undefined } as never;

async function setup(options: { isConnected?: boolean; isLoading?: boolean; provider?: 'claude' | 'zcode' } = {}) {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');
  const added: ChatMessage[] = [];
  const hook = renderHook(({ sessionId }) => useChatComposerState({
    selectedProject: project,
    selectedSession: { id: sessionId } as ProjectSession,
    currentSessionId: sessionId,
    provider: options.provider ?? 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default',
    currentProviderModel: 'test-model',
    currentProviderEffort: 'default',
    isLoading: options.isLoading ?? true,
    isConnected: options.isConnected,
    hasActiveBackgroundTasks: true,
    isInputBlocked: true,
    canAbortSession: true,
    tokenBudget: null,
    sendMessage: () => undefined,
    stickToBottomAfterSend: () => undefined,
    addMessage: (message) => added.push(message),
    setPendingPermissionRequests: () => undefined,
  }), { initialProps: { sessionId: 'session-1' } });
  const type = (value: string) => act(() => {
    hook.result.current.handleInputChange({ target: { value } } as never);
  });
  return { ...hook, type, added };
}

beforeEach(async () => {
  localStorage.clear();
  remoteDrafts = [];
  (await import('@/shared/chatDrafts')).resetChatDrafts();
  queueRequest.mockReset().mockImplementation(async (_scope, queuedMessage) => new Response(JSON.stringify({
    success: true, queuedMessage, appended: false,
  })));
  clearRequest.mockReset().mockResolvedValue(new Response('{}'));
  upload.mockReset().mockResolvedValue([]);
  readAsset.mockReset().mockResolvedValue(new Response('stored attachment'));
});

test('only the new follow-up goes to the server and its merged response owns the card', async () => {
  const { result, type } = await setup();
  await type('A');
  await act(async () => { await result.current.handleSubmit(event); });
  queueRequest.mockImplementationOnce(async (_scope, queuedMessage) => new Response(JSON.stringify({
    queuedMessage: { ...queuedMessage, content: 'A\n\nfrom another tab\n\nB' }, appended: true,
  })));
  await type('B');
  await act(async () => { await result.current.handleSubmit(event); });
  assert.equal(queueRequest.mock.calls[1][1].content, 'B');
  assert.equal(result.current.queuedDraft?.content, 'A\n\nfrom another tab\n\nB');
});

test('a refused append restores before text typed while waiting and does not submit it again', async () => {
  let answer!: (response: Response) => void;
  queueRequest.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const { result, type, added } = await setup();
  await type('/compact');
  let submitting!: Promise<boolean>;
  await act(async () => { submitting = result.current.handleSubmit(event); });
  await type('later');
  await act(async () => {
    assert.equal(await result.current.handleSubmit(event), false);
    answer(new Response(JSON.stringify({ error: { code: 'QUEUED_MESSAGE_NOT_COMBINABLE', message: 'Cannot combine' } }), { status: 409 }));
    assert.equal(await submitting, false);
  });
  assert.equal(result.current.input, '/compact\n\nlater');
  assert.equal(result.current.queuedDraft, null);
  assert.equal(queueRequest.mock.calls.length, 1);
  assert.equal(added.length, 1);
});

test('an append failure after switching sessions restores only the original session', async () => {
  let answer!: (response: Response) => void;
  queueRequest.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const { result, rerender, type } = await setup();
  await type('for first session');
  let submitting!: Promise<boolean>;
  await act(async () => { submitting = result.current.handleSubmit(event); });
  rerender({ sessionId: 'session-2' });
  await type('second session draft');
  await act(async () => {
    answer(new Response('{"error":{"message":"refused"}}', { status: 400 }));
    await submitting;
  });
  assert.equal(result.current.input, 'second session draft');
  rerender({ sessionId: 'session-1' });
  assert.equal(result.current.input, 'for first session');
});

test('a failed append keeps text typed after it before switching away and back', async () => {
  let answer!: (response: Response) => void;
  queueRequest.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const { result, rerender, type } = await setup();
  await type('first');
  let submitting!: Promise<boolean>;
  await act(async () => { submitting = result.current.handleSubmit(event); });
  await type('typed while waiting');
  rerender({ sessionId: 'session-2' });
  await act(async () => {
    answer(new Response('{"error":{"message":"refused"}}', { status: 503 }));
    await submitting;
  });
  rerender({ sessionId: 'session-1' });
  assert.equal(result.current.input, 'first\n\ntyped while waiting');
});

test('a failed append completed after logout and unmount cannot restore private text', async () => {
  const drafts = await import('@/shared/chatDrafts');
  let answer!: (response: Response) => void;
  queueRequest.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const { result, rerender, unmount, type } = await setup();
  await type('private first session');
  let submitting!: Promise<boolean>;
  await act(async () => { submitting = result.current.handleSubmit(event); });
  rerender({ sessionId: 'session-2' });
  drafts.resetChatDrafts();
  unmount();
  answer(new Response('{"queuedMessage":{"content":"private first session"}}'));
  await submitting;
  assert.equal(drafts.readDraftText('session-1'), '');
  assert.equal(localStorage.getItem('chat-drafts'), null);
});

test('switching sessions during attachment recovery cancels only the original queue', async () => {
  const drafts = await import('@/shared/chatDrafts');
  const queuedMessage = { content: 'same content', attachments: [{ path: '/assets/stored.txt' }] };
  await drafts.appendQueuedMessage('session-1', queuedMessage);
  await drafts.appendQueuedMessage('session-2', queuedMessage);
  let answer!: (response: Response) => void;
  readAsset.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const { result, rerender } = await setup();
  let editing!: Promise<void>;
  await act(async () => { editing = result.current.editQueuedDraft(); });
  rerender({ sessionId: 'session-2' });
  await act(async () => {
    answer(new Response('file'));
    await editing;
  });
  assert.equal(clearRequest.mock.calls[0][0], 'session-1');
  assert.equal(drafts.readQueuedMessage('session-2')?.content, 'same content');
});

test('returning to a failed submission keeps a newer draft received from another device', async () => {
  const drafts = await import('@/shared/chatDrafts');
  let answer!: (response: Response) => void;
  queueRequest.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const { result, rerender, type } = await setup();
  await type('first');
  let submitting!: Promise<boolean>;
  await act(async () => { submitting = result.current.handleSubmit(event); });
  rerender({ sessionId: 'session-2' });
  await act(async () => {
    answer(new Response('{"error":{"message":"refused"}}', { status: 503 }));
    await submitting;
    await new Promise((resolve) => setTimeout(resolve, 1100));
  });
  remoteDrafts = [{ scope: 'session-1', text: 'first plus phone edit', queuedMessage: null }];
  await act(async () => { await drafts.hydrateChatDrafts(); });
  rerender({ sessionId: 'session-1' });
  assert.equal(result.current.input, 'first plus phone edit');
});

test('an upload completed after sign-out never appends to the next user\'s queue', async () => {
  const drafts = await import('@/shared/chatDrafts');
  let finishUpload!: (value: unknown[]) => void;
  upload.mockImplementationOnce(() => new Promise<unknown[]>((resolve) => { finishUpload = resolve; }));
  const { result, unmount, type } = await setup();
  await type('private uploaded message');
  let submitting!: Promise<boolean>;
  await act(async () => { submitting = result.current.handleSubmit(event); });
  drafts.resetChatDrafts();
  unmount();
  finishUpload([]);
  await submitting;
  assert.equal(queueRequest.mock.calls.length, 0);
  assert.equal(localStorage.getItem('chat-drafts'), null);
});

test('clearing input through the public setter cannot revive scheduled text on a session switch', async () => {
  const { result, rerender, type } = await setup();
  await type('already scheduled prompt');
  act(() => result.current.setInput(''));
  rerender({ sessionId: 'session-2' });
  rerender({ sessionId: 'session-1' });
  assert.equal(result.current.input, '');
});

test('functional input updates used by completions persist in their original scope', async () => {
  const { result, rerender, type } = await setup();
  await type('partial');
  act(() => result.current.setInput((previous) => `${previous} completion`));
  rerender({ sessionId: 'session-2' });
  rerender({ sessionId: 'session-1' });
  assert.equal(result.current.input, 'partial completion');
});

test('a failed clear leaves the queued card and never edits a message that may still be sent', async () => {
  const { result, type } = await setup();
  await type('queued');
  await act(async () => { await result.current.handleSubmit(event); });
  clearRequest.mockResolvedValueOnce(new Response('{}', { status: 503 }));
  await act(async () => { await result.current.editQueuedDraft(); });
  assert.equal(result.current.queuedDraft?.content, 'queued');
  assert.equal(result.current.input, '');
});

test('a transport failure is reported without silently retrying an append', async () => {
  queueRequest.mockRejectedValueOnce(new Error('connection lost'));
  const { result, type, added } = await setup();
  await type('might be stored');
  await act(async () => { await result.current.handleSubmit(event); });
  assert.equal(queueRequest.mock.calls.length, 1);
  assert.equal(result.current.input, 'might be stored');
  assert.match(added[0].content ?? '', /confirm|确认|connection lost/);
});

test('editing a restored attachment-only queue recovers every file before cancellation', async () => {
  const drafts = await import('@/shared/chatDrafts');
  await drafts.appendQueuedMessage('session-1', { content: '', attachments: [
    { path: '/home/.cloudcli/assets/stored.txt', name: 'original.txt', mimeType: 'text/plain' },
  ] });
  const { result } = await setup();
  await act(async () => { await result.current.editQueuedDraft(); });
  assert.equal(result.current.attachedFiles[0]?.name, 'original.txt');
  assert.equal(result.current.attachedFiles[0]?.size, 'stored attachment'.length);
  assert.equal(readAsset.mock.calls[0]?.[0], 'stored.txt');
  assert.equal(result.current.queuedDraft, null);
});

test('an attachment download failure keeps the queue on the server', async () => {
  const drafts = await import('@/shared/chatDrafts');
  await drafts.appendQueuedMessage('session-1', { content: 'with file', attachments: [{ path: '/assets/gone.txt' }] });
  readAsset.mockResolvedValueOnce(new Response('', { status: 404 }));
  const { result } = await setup();
  await act(async () => { await result.current.editQueuedDraft(); });
  assert.equal(clearRequest.mock.calls.length, 0);
  assert.equal(result.current.queuedDraft?.content, 'with file');
});

test('a force-send failure followed by a queue failure restores editable input instead of a phantom card', async () => {
  const { result, type } = await setup({ isConnected: false, isLoading: false, provider: 'zcode' });
  await type('must survive');
  await act(async () => { await result.current.handleSubmit(event); });
  queueRequest.mockResolvedValueOnce(new Response('{"error":{"message":"unavailable"}}', { status: 503 }));
  assert.equal(result.current.canForceSendQueuedDraft, true);
  await act(async () => { await result.current.forceSendQueuedDraft(); });
  assert.equal(clearRequest.mock.calls.length, 1);
  assert.equal(clearRequest.mock.calls[0][0], 'session-1');
  assert.equal(clearRequest.mock.calls[0][1]?.content, 'must survive');
  assert.equal(queueRequest.mock.calls.length, 2);
  assert.equal(result.current.queuedDraft, null);
  assert.equal(result.current.input, 'must survive');
});
