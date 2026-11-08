import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type * as Api from '@/shared/api';
import type { ChatMessage, Project, ProjectSession } from '@/shared/types';

type UploadCall = {
  files: File[];
  options: { requestId: string; signal: AbortSignal; onProgress: (progress: number) => void };
  resolve: (value: unknown[]) => void;
  reject: (error: unknown) => void;
};

const queueRequest = vi.fn();
const clearRequest = vi.fn();
const upload = vi.fn();
let uploads: UploadCall[] = [];

vi.mock('@/modules/chat/utils/attachmentUpload', () => ({
  uploadAttachmentFiles: (...args: unknown[]) => upload(...args),
}));
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  api: {
    searchFiles: () => Promise.resolve({ ok: false }),
    commands: { list: () => Promise.resolve(new Response('{"commands":[]}')) },
    providers: {
      capabilities: () => Promise.resolve(new Response('{}', { status: 503 })),
      skills: () => Promise.resolve(new Response('{"data":{"skills":[]}}')),
    },
    assets: { file: () => Promise.resolve(new Response('stored')) },
    user: {
      drafts: () => Promise.resolve(new Response('{"drafts":[]}')),
      saveDraft: () => Promise.resolve(new Response('{}')),
      appendQueuedMessage: (...args: unknown[]) => queueRequest(...args),
      clearQueuedMessage: (...args: unknown[]) => clearRequest(...args),
    },
  },
}));

const project = { projectId: 'p1', name: 'p1', displayName: 'p1', path: '/tmp/p1', fullPath: '/tmp/p1' } as Project;
const event = { preventDefault: () => undefined } as never;
const image = (name: string) => new File(['png'], name, { type: 'image/png' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(options: { isLoading?: boolean; isConnected?: boolean } = {}) {
  const { useChatComposerState } = await import('@/modules/chat/hooks/useChatComposerState');
  const added: ChatMessage[] = [];
  const sent: Array<{ type: string; content?: string; options?: { attachments?: unknown[] } }> = [];
  const busy = options.isLoading ?? false;
  const hook = renderHook(({ sessionId }) => useChatComposerState({
    selectedProject: project,
    selectedSession: { id: sessionId } as ProjectSession,
    currentSessionId: sessionId,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default',
    currentProviderModel: 'test-model',
    currentProviderEffort: 'default',
    isLoading: busy,
    isConnected: options.isConnected,
    hasActiveBackgroundTasks: busy,
    isInputBlocked: busy,
    canAbortSession: busy,
    tokenBudget: null,
    sendMessage: (message) => { sent.push(message as never); },
    stickToBottomAfterSend: () => undefined,
    addMessage: (message) => added.push(message),
    setPendingPermissionRequests: () => undefined,
  }), { initialProps: { sessionId: 'session-1' } });
  const type = (value: string) => act(() => {
    hook.result.current.handleInputChange({ target: { value } } as never);
  });
  const attach = (...files: File[]) => act(() => {
    hook.result.current.handlePaste({
      clipboardData: { items: files.map((file) => ({ type: file.type, getAsFile: () => file })), files: [] },
    } as never);
  });
  const finish = (index: number, descriptor: unknown) => act(async () => {
    uploads[index].resolve([descriptor]);
    await tick();
  });
  return { ...hook, added, sent, type, attach, finish };
}

beforeEach(async () => {
  localStorage.clear();
  uploads = [];
  (await import('@/shared/chatDrafts')).resetChatDrafts();
  queueRequest.mockReset().mockImplementation(async (_scope, queuedMessage) => new Response(JSON.stringify({
    success: true, queuedMessage, appended: false,
  })));
  clearRequest.mockReset().mockResolvedValue(new Response('{}'));
  upload.mockReset().mockImplementation((files: File[], options: UploadCall['options']) =>
    new Promise((resolve, reject) => { uploads.push({ files, options, resolve, reject }); }));
});

test('adding an attachment uploads it at once, one file per request', async () => {
  const { attach, result } = await setup();
  await attach(image('a.png'), image('b.png'));
  assert.deepEqual(uploads.map((call) => call.files.map((file) => file.name)), [['a.png'], ['b.png']]);
  assert.equal(result.current.attachmentBlock, 'uploading');
});

test('Enter while uploading sends nothing and keeps the text', async () => {
  const { attach, type, result, sent, added } = await setup();
  await type('look at this');
  await attach(image('a.png'));
  await act(async () => { assert.equal(await result.current.handleSubmit(event), false); });
  assert.equal(result.current.input, 'look at this');
  assert.equal(result.current.attachments.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(added.length, 0);
});

test('a text-only draft is still blocked by an unfinished attachment', async () => {
  const { attach, type, result, sent } = await setup();
  await attach(image('a.png'));
  await type('no attachment needed');
  await act(async () => { await result.current.handleSubmit(event); });
  assert.equal(sent.length, 0);
});

test('a finished attachment is sent by its descriptor without uploading again', async () => {
  const { attach, finish, type, result, sent, added } = await setup();
  await type('look at this');
  await attach(image('b.png'), image('a.png'));
  await finish(1, { path: '/a.png', name: 'a.png', mimeType: 'image/png' });
  await finish(0, { path: '/b.png', name: 'b.png', mimeType: 'image/png' });
  assert.equal(result.current.attachmentBlock, null);
  await act(async () => { assert.equal(await result.current.handleSubmit(event), true); });
  assert.equal(upload.mock.calls.length, 2);
  assert.deepEqual(sent[0].options?.attachments?.map((entry) => (entry as { name: string }).name), ['b.png', 'a.png']);
  assert.equal(result.current.attachments.length, 0);
  assert.equal(result.current.input, '');
  assert.deepEqual(added[0].images?.map((entry) => entry.name), ['b.png', 'a.png']);
});

test('a failed upload stays on the thumbnail, not in the timeline, and blocks until retried', async () => {
  const { attach, finish, result, sent, added } = await setup();
  await attach(image('a.png'));
  await act(async () => { uploads[0].reject(new Error('Server error (524)')); await tick(); });
  assert.equal(result.current.attachmentBlock, 'failed');
  assert.equal(added.length, 0);
  await act(async () => { assert.equal(await result.current.handleSubmit(event), false); });

  act(() => result.current.attachmentQueue.retry(result.current.attachments[0].id));
  assert.equal(result.current.attachmentBlock, 'uploading');
  await finish(1, { path: '/a.png' });
  await act(async () => { await result.current.handleSubmit(event); });
  assert.equal(sent.length, 1);
});

test('removing a failed attachment releases the send', async () => {
  const { attach, type, result, sent } = await setup();
  await type('text');
  await attach(image('a.png'));
  await act(async () => { uploads[0].reject(new Error('boom')); await tick(); });
  act(() => result.current.attachmentQueue.remove(result.current.attachments[0].id));
  assert.equal(result.current.attachmentBlock, null);
  await act(async () => { await result.current.handleSubmit(event); });
  assert.equal(sent.length, 1);
});

test('a failed send puts the attachment back finished, so it is not uploaded again', async () => {
  const { attach, finish, type, result, added } = await setup({ isConnected: false });
  await type('keep me');
  await attach(image('a.png'));
  await finish(0, { path: '/a.png' });
  await act(async () => { await result.current.handleSubmit(event); });
  assert.equal(added[0].type, 'error');
  assert.equal(result.current.input, 'keep me');
  assert.equal(result.current.attachments[0].status, 'done');
  assert.deepEqual(result.current.attachments[0].uploaded, { path: '/a.png' });
  assert.equal(upload.mock.calls.length, 1);
});

test('a queued flush goes out even while the composer holds an unfinished attachment', async () => {
  const { attach, result, sent } = await setup();
  await attach(image('a.png'));
  const queued = { content: 'queued earlier', attachments: [], uploadedAttachments: [{ path: '/old.png' }] };
  await act(async () => { assert.equal(await result.current.handleSubmit(event, queued), true); });
  assert.equal(sent[0].content, 'queued earlier');
  assert.deepEqual(sent[0].options?.attachments, [{ path: '/old.png' }]);
  assert.equal(result.current.attachments.length, 1);
});

test('a session switch does not interrupt an upload', async () => {
  const { attach, finish, rerender, result } = await setup();
  await attach(image('a.png'));
  rerender({ sessionId: 'session-2' });
  assert.equal(result.current.attachments.length, 0);
  assert.equal(result.current.attachmentBlock, null);
  assert.equal(uploads[0].options.signal.aborted, false);
  await finish(0, { path: '/a.png' });
  rerender({ sessionId: 'session-1' });
  assert.equal(result.current.attachments[0].status, 'done');
});

test('queueing while busy stores the descriptor without uploading again', async () => {
  const { attach, finish, type, result } = await setup({ isLoading: true });
  await type('next');
  await attach(image('a.png'));
  await finish(0, { path: '/a.png' });
  await act(async () => { await result.current.handleSubmit(event); });
  assert.deepEqual(queueRequest.mock.calls[0][1].attachments, [{ path: '/a.png' }]);
  assert.equal(upload.mock.calls.length, 1);
  assert.equal(result.current.queuedDraft?.attachments[0].name, 'a.png');
});

test('editing a queued message restores its attachments finished', async () => {
  const { attach, finish, type, result } = await setup({ isLoading: true });
  await type('next');
  await attach(image('a.png'));
  await finish(0, { path: '/a.png' });
  await act(async () => { await result.current.handleSubmit(event); });
  await act(async () => { await result.current.editQueuedDraft(); });
  assert.equal(result.current.attachments[0].status, 'done');
  assert.deepEqual(result.current.attachments[0].uploaded, { path: '/a.png' });
  assert.equal(result.current.attachmentBlock, null);
  assert.equal(upload.mock.calls.length, 1);
});

test('voice stop-and-send during an upload leaves the transcript in the input', async () => {
  const { attach, result, sent } = await setup();
  await attach(image('a.png'));
  await act(async () => { result.current.handleVoiceTranscript('spoken words', true); await tick(); });
  assert.equal(sent.length, 0);
  assert.equal(result.current.input, 'spoken words');
});

test('an oversized file shows as an item and is never uploaded', async () => {
  const { MAX_ATTACHMENT_SIZE_BYTES } = await import('@/shared/constants');
  const { attach, result } = await setup();
  const big = new File([new Uint8Array(MAX_ATTACHMENT_SIZE_BYTES + 1)], 'big.png', { type: 'image/png' });
  await attach(big);
  assert.equal(upload.mock.calls.length, 0);
  assert.equal(result.current.attachments[0].status, 'tooLarge');
  assert.equal(result.current.attachmentBlock, 'failed');
});

test('unmounting aborts running uploads', async () => {
  const { attach, unmount } = await setup();
  await attach(image('a.png'));
  unmount();
  assert.equal(uploads[0].options.signal.aborted, true);
});

test('signing out aborts uploads and a late result queues nothing for the next user', async () => {
  const drafts = await import('@/shared/chatDrafts');
  const { attach, type, result } = await setup({ isLoading: true });
  await type('private');
  await attach(image('a.png'));
  await act(async () => { drafts.resetChatDrafts(); await tick(); });
  assert.equal(uploads[0].options.signal.aborted, true);
  assert.equal(result.current.attachments.length, 0);
  await act(async () => { uploads[0].resolve([{ path: '/a.png' }]); await tick(); });
  assert.equal(result.current.attachments.length, 0);
  assert.equal(queueRequest.mock.calls.length, 0);
});
