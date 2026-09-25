/**
 * Sequence tests for the framework-free SessionTimelineStore.
 *
 * Unlike the hook-level characterization suite, these drive the class
 * directly with an injected scripted page fetcher — no React, no global
 * fetch stub — so the timeline's internal ordering contracts (prune before
 * bail-out, drift realignment before the older-page retry, history-read
 * serialization, the anchored streaming timestamp, notify scoping) are
 * pinned at the module's own seam.
 */

import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import type { NormalizedMessage, ServerEvent } from '@/shared/types';
import type { SessionHistoryPage, SessionPageFetcher } from '@/modules/chat/utils/sessionTimelineStore';
import { SessionTimelineStore } from '@/modules/chat/utils/sessionTimelineStore';
import type { SessionMessagesRequestOptions } from '@/modules/chat/utils/sessionMessagePagination';
import { SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SESSION_ID = 'sess-a';
const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

function msg(n: number, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: `m${n}`,
    sessionId: SESSION_ID,
    timestamp: new Date(BASE_TIME + n * 1000).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: n % 2 === 1 ? 'user' : 'assistant',
    content: `message ${n}`,
    ...overrides,
  };
}

type ScriptedCall = { params: SessionMessagesRequestOptions; page: SessionHistoryPage };

/** Drives one server frame through the store's single entry point. */
function emit(store: SessionTimelineStore, frame: Record<string, unknown>): void {
  store.applyServerEvent(frame as ServerEvent, { provider: 'claude' });
}

/** Drives one Antigravity frame so its provider-native row identity is exercised. */
function emitAntigravity(store: SessionTimelineStore, frame: Record<string, unknown>): void {
  store.applyServerEvent(frame as ServerEvent, { provider: 'antigravity' });
}

/**
 * A scripted transport: each call must match the next entry's limit/offset
 * (pinning offset bookkeeping), and unexpected calls fail the test.
 */
function scriptedFetcher(script: ScriptedCall[]): SessionPageFetcher & { calls: SessionMessagesRequestOptions[] } {
  const remaining = [...script];
  const calls: SessionMessagesRequestOptions[] = [];
  const fetcher = vi.fn((sessionId: string, options: SessionMessagesRequestOptions) => {
    assert.equal(sessionId, SESSION_ID);
    assert.ok(remaining.length > 0, `unexpected history request: ${JSON.stringify(options)}`);
    const expected = remaining.shift()!;
    assert.deepEqual(options, expected.params);
    calls.push(options);
    return Promise.resolve(expected.page);
  });
  return Object.assign(fetcher as unknown as SessionPageFetcher, { calls });
}

/** Lets the 100ms stream throttle fire exactly once and apply the row. */
const tickThrottle = () => new Promise((resolve) => setTimeout(resolve, 130));

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Latest refresh: bail-out and prune ordering ─────────────────────────────

test('an identical latest refresh bails out and keeps every cached identity when nothing is prunable', async () => {
  const page = { messages: [msg(1), msg(2)], total: 2, hasMore: false };
  const fetchPage = scriptedFetcher([
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page },
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: { messages: [msg(1), msg(2)], total: 2, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emit(store, {
    kind: 'tool_use',
    id: 'rt-tool-live',
    sessionId: SESSION_ID,
    toolId: 'tool-live',
    toolName: 'Bash',
    toolInput: {},
  });

  const slot = store.getSessionSlot(SESSION_ID)!;
  const serverBefore = slot.serverMessages;
  const mergedBefore = slot.merged;

  const result = await store.refreshLatestFromServer(SESSION_ID);

  assert.equal(result.changed, false);
  assert.equal(slot.serverMessages, serverBefore, 'server array identity must survive the bail-out');
  assert.equal(slot.merged, mergedBefore, 'merged must not be recomputed');
  assert.equal(slot.realtimeMessages.length, 1, 'the live tool row must survive');
});

test('a delayed replay row is pruned by an otherwise identical refresh', async () => {
  const fetchPage = scriptedFetcher([
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: { messages: [msg(1), msg(2)], total: 2, hasMore: false } },
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: { messages: [msg(1), msg(2)], total: 2, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  store.appendRealtime(SESSION_ID, msg(2));

  const result = await store.refreshLatestFromServer(SESSION_ID);

  assert.equal(result.changed, true, 'pruning a replay row counts as a change');
  assert.equal(store.getSessionSlot(SESSION_ID)!.realtimeMessages.length, 0);
  assert.equal(store.getMessages(SESSION_ID).filter((row) => row.id === 'm2').length, 1);
});

// ─── Older pages: drift realignment ──────────────────────────────────────────

test('a drifting offset during fetchMore realigns from the tail, then retries with the realigned offset', async () => {
  const fetchPage = scriptedFetcher([
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: { messages: [msg(3), msg(4)], total: 6, hasMore: true } },
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 2 }, page: { messages: [msg(2)], total: 7, hasMore: true } },
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: { messages: [msg(3), msg(4), msg(5)], total: 7, hasMore: true } },
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 3 }, page: { messages: [msg(2)], total: 7, hasMore: true } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  const outcome = await store.fetchMore(SESSION_ID);

  assert.equal(outcome.prependedCount, 1);
  const slot = store.getSessionSlot(SESSION_ID)!;
  assert.deepEqual(
    slot.serverMessages.map((row) => row.id),
    ['m2', 'm3', 'm4', 'm5'],
  );
  assert.equal(slot.offset, 4);
  assert.equal(slot.total, 7);
});

test('an older-page read waits behind an in-flight latest refresh before calculating its offset', async () => {
  // Manual-resolution pages pin the per-slot history-read queue: the older
  // page's offset must be calculated only after the queued latest refresh
  // has applied, so it can never fetch against a stale tail-relative offset.
  const calls: number[] = [];
  const resolvers: Array<(page: SessionHistoryPage) => void> = [];
  const fetchPage: SessionPageFetcher = (_sessionId, options) => {
    calls.push(options.offset ?? 0);
    return new Promise((resolve) => {
      resolvers.push(resolve);
    });
  };
  const store = new SessionTimelineStore({ fetchPage });
  const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

  // Prime the slot: [m3, m4] of a six-row transcript.
  const initial = store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  await flushMicrotasks();
  assert.equal(resolvers.length, 1);
  resolvers[0]({ messages: [msg(3), msg(4)], total: 6, hasMore: true });
  await initial;

  // Queue a latest refresh (its page is held), then an older-page read.
  const refresh = store.refreshLatestFromServer(SESSION_ID);
  const older = store.fetchMore(SESSION_ID);
  await flushMicrotasks();

  // Only the refresh's offset-0 request is in flight; the older page must
  // not have started against the stale offset.
  assert.equal(resolvers.length, 2, 'the older-page fetch must wait behind the in-flight latest refresh');
  assert.equal(calls[1], 0, 'the second request is the latest refresh at offset 0');

  // Release the latest page (now including the appended m5): the refresh
  // applies, and only then does the older page fire — at the realigned
  // offset of 3 cached rows, not the stale 2.
  resolvers[1]({ messages: [msg(3), msg(4), msg(5)], total: 7, hasMore: true });
  await flushMicrotasks();
  assert.equal(resolvers.length, 3);
  assert.equal(calls[2], 3, 'the retry must use the realigned offset');
  resolvers[2]({ messages: [msg(2)], total: 7, hasMore: true });
  const outcome = await older;
  await refresh;

  assert.deepEqual(
    store.getSessionSlot(SESSION_ID)!.serverMessages.map((row) => row.id),
    ['m2', 'm3', 'm4', 'm5'],
  );
  assert.equal(outcome.prependedCount, 1);
});

// ─── Streaming segments ──────────────────────────────────────────────────────

test('a streaming row anchors its timestamp at segment start and finalizes in place', async () => {
  const store = new SessionTimelineStore();

  emit(store, { kind: 'stream_delta', sessionId: SESSION_ID, content: 'Hel' });
  await tickThrottle();
  let streaming = store.getMessages(SESSION_ID).find((row) => row.id === `__streaming_${SESSION_ID}`);
  assert.ok(streaming);
  const anchoredTimestamp = streaming!.timestamp;

  emit(store, { kind: 'stream_delta', sessionId: SESSION_ID, content: 'lo' });
  await tickThrottle();
  streaming = store.getMessages(SESSION_ID).find((row) => row.id === `__streaming_${SESSION_ID}`);
  assert.equal(streaming!.content, 'Hello');
  assert.equal(streaming!.timestamp, anchoredTimestamp, 'later deltas must not refresh the timestamp');

  const realtimeCountBefore = store.getSessionSlot(SESSION_ID)!.realtimeMessages.length;
  emit(store, { kind: 'stream_end', sessionId: SESSION_ID });

  const finalized = store.getMessages(SESSION_ID).find((row) => row.content === 'Hello');
  assert.ok(finalized);
  // A streamed segment with no engine row yet is held under a placeholder id;
  // the engine's own row takes its place when it arrives.
  assert.match(finalized!.id, /^__streamed_/);
  assert.equal(finalized!.timestamp, anchoredTimestamp);
  assert.equal(store.getSessionSlot(SESSION_ID)!.realtimeMessages.length, realtimeCountBefore,
    'finalization replaces the streaming row in place');

  // A later segment starts fresh instead of concatenating onto the flushed text.
  emit(store, { kind: 'stream_delta', sessionId: SESSION_ID, content: 'Next' });
  await tickThrottle();
  const nextSegment = store.getMessages(SESSION_ID).find((row) => row.id === `__streaming_${SESSION_ID}`);
  assert.ok(nextSegment);
  assert.equal(nextSegment!.content, 'Next');
});

test('a realtime row an engine names twice stays one row', async () => {
  const store = new SessionTimelineStore();

  // An engine that reports a reply while it is written sends the same row id
  // more than once. The id is derived from the engine's own record, so the
  // second frame is the first grown — not a second message. Codex shipped a
  // build that sent one frame per streamed fragment, and the transcript kept
  // every partial as its own bubble.
  emit(store, {
    kind: 'text', role: 'assistant', id: 'msg_1', sessionId: SESSION_ID,
    provider: 'claude', timestamp: new Date(BASE_TIME).toISOString(), content: 'par',
  });
  emit(store, {
    kind: 'text', role: 'assistant', id: 'msg_1', sessionId: SESSION_ID,
    provider: 'claude', timestamp: new Date(BASE_TIME + 5000).toISOString(), content: 'partial answer',
  });

  const rows = store.getSessionSlot(SESSION_ID)!.realtimeMessages;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'partial answer');
  // Kept where it first landed, so a later frame cannot reorder it past the
  // tools that ran after it.
  assert.equal(rows[0].timestamp, new Date(BASE_TIME).toISOString());
});

test('rows minted per frame are never collapsed onto each other', async () => {
  const store = new SessionTimelineStore();

  // A `vol_` id promises nothing across frames, so two of them are two rows
  // even though neither is a stable identity.
  emit(store, {
    kind: 'error', id: 'vol_error_1', sessionId: SESSION_ID,
    provider: 'claude', timestamp: new Date(BASE_TIME).toISOString(), content: 'first',
  });
  emit(store, {
    kind: 'error', id: 'vol_error_2', sessionId: SESSION_ID,
    provider: 'claude', timestamp: new Date(BASE_TIME + 1000).toISOString(), content: 'second',
  });

  assert.equal(store.getSessionSlot(SESSION_ID)!.realtimeMessages.length, 2);
});

test('a persisted Antigravity row replaces its keyed stream even after a newer user turn exists', async () => {
  const streamedContent = 'A concrete implementation plan with enough text to identify the persisted row.';
  const providerRowKey = 'assistant-step:2';
  const initialUser = msg(1, { provider: 'antigravity', content: 'please propose a plan' });
  const persistedReply = msg(2, {
    id: 'msg_session_2',
    provider: 'antigravity',
    content: streamedContent,
    providerRowKey,
  });
  const newerUser = msg(3, { provider: 'antigravity', content: 'continue with the implementation' });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser, persistedReply, newerUser], total: 3, hasMore: false },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: streamedContent,
    providerRowKey,
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);

  assert.deepEqual(
    store.getMessages(SESSION_ID).filter((row) => row.content === streamedContent).map((row) => row.id),
    ['msg_session_2'],
  );
  assert.equal(store.getSessionSlot(SESSION_ID)!.realtimeMessages.length, 0);
});

test('a keyed Antigravity stream survives an empty first refresh and is pruned when the second refresh lands it', async () => {
  const streamedContent = 'The transcript is deliberately one refresh behind this completed stream.';
  const providerRowKey = 'assistant-step:4';
  const initialUser = msg(1, { provider: 'antigravity', content: 'draft the migration steps' });
  const newerUser = msg(3, { provider: 'antigravity', content: 'go ahead' });
  const persistedReply = msg(2, {
    id: 'msg_session_4',
    provider: 'antigravity',
    content: streamedContent,
    providerRowKey,
  });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser, newerUser], total: 2, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser, persistedReply, newerUser], total: 3, hasMore: false },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: streamedContent,
    providerRowKey,
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);
  let matchingRows = store.getMessages(SESSION_ID).filter((row) => row.content === streamedContent);
  assert.equal(matchingRows.length, 1);
  assert.match(matchingRows[0].id, /^__streamed_/);
  assert.equal(matchingRows[0].providerRowKey, providerRowKey);

  await store.refreshLatestFromServer(SESSION_ID);
  matchingRows = store.getMessages(SESSION_ID).filter((row) => row.content === streamedContent);
  assert.deepEqual(matchingRows.map((row) => row.id), ['msg_session_4']);
  assert.equal(store.getSessionSlot(SESSION_ID)!.realtimeMessages.length, 0);
});

test('a complete keyed history row owns its realtime counterpart regardless of body differences', async () => {
  const providerRowKey = 'assistant-step:6';
  const initialUser = msg(1, { provider: 'antigravity', content: 'prepare the final answer' });
  const persistedReply = msg(2, {
    id: 'msg_session_6',
    provider: 'antigravity',
    content: 'Persisted partial answer.',
    providerRowKey,
  });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser, persistedReply], total: 2, hasMore: false },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: 'Live complete answer with content that has not landed in history.',
    providerRowKey,
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);

  assert.deepEqual(
    store.getMessages(SESSION_ID)
      .filter((row) => row.role === 'assistant')
      .map((row) => row.content),
    ['Persisted partial answer.'],
  );
});

test('a keyed history prefix yields to the complete Antigravity stream', async () => {
  const providerRowKey = 'assistant-step:7';
  const completeReply = `${'A detailed implementation step with concrete safeguards. '.repeat(8)}Final verification.`;
  const persistedPrefix = completeReply.slice(0, Math.floor(completeReply.length * 0.3));
  const initialUser = msg(1, { provider: 'antigravity', content: 'write the complete plan' });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: {
        messages: [initialUser, msg(2, {
          id: 'msg_session_7',
          provider: 'antigravity',
          content: persistedPrefix,
          providerRowKey,
          contentCompleteness: 'truncated',
        })],
        total: 2,
        hasMore: false,
      },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: completeReply,
    providerRowKey,
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);

  assert.deepEqual(
    store.getMessages(SESSION_ID)
      .filter((row) => row.role === 'assistant')
      .map((row) => row.content),
    [completeReply],
  );
});

test('a near-identical keyed Antigravity history row yields to richer markdown-formatted stream text', async () => {
  const providerRowKey = 'assistant-step:7b';
  const shared = '游戏世界与界面分工协作是现代 Web 游戏的常见架构。'.repeat(18);
  const persistedReply = `${shared}原版客户端在同一绘制表面中逐层绘制。`;
  const streamedReply = `## 结论\n\n${shared}\n\n**原版客户端**在同一绘制表面中逐层绘制。\n\n- Canvas 负责动态世界\n- DOM 负责复杂交互`;
  const initialUser = msg(1, { provider: 'antigravity', content: '解释 Canvas 和 DOM 的分工' });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: {
        messages: [initialUser, msg(2, {
          id: 'msg_session_7b',
          provider: 'antigravity',
          content: persistedReply,
          providerRowKey,
          contentCompleteness: 'truncated',
        })],
        total: 2,
        hasMore: false,
      },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: streamedReply,
    providerRowKey,
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);

  assert.deepEqual(
    store.getMessages(SESSION_ID)
      .filter((row) => row.role === 'assistant')
      .map((row) => row.content),
    [streamedReply],
  );
});

test('a unique provider row key treats changed wording as the same persisted row', async () => {
  const providerRowKey = 'assistant-step:7c';
  const shared = '这一段用于保证回答足够长，同时验证不能因为大部分文字相同就吞掉修改过的事实。'.repeat(5);
  const persistedReply = `该方案支持离线模式。${shared}`;
  const streamedReply = `该方案不支持离线模式。${shared}`;
  const initialUser = msg(1, { provider: 'antigravity', content: '确认离线模式是否可用' });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: {
        messages: [initialUser, msg(2, {
          id: 'msg_session_7c',
          provider: 'antigravity',
          content: persistedReply,
          providerRowKey,
        })],
        total: 2,
        hasMore: false,
      },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: streamedReply,
    providerRowKey,
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);

  assert.deepEqual(
    store.getMessages(SESSION_ID)
      .filter((row) => row.role === 'assistant')
      .map((row) => row.content),
    [persistedReply],
  );
});

test('a partial Antigravity stream suffix yields to the complete persisted history row', async () => {
  const providerRowKey = 'assistant-step:7d';
  const prefix = '在系统设计中，界面的对话消息有两条流向：第一条路是 REST 历史记录；第二条路是 WebSocket 实时流。'.repeat(4);
  const suffix = '去重机制如果失效，就会在时间线上留下两个分身并被折叠显示。'.repeat(5);
  const completePersistedReply = `${prefix}${suffix}`;
  const partialStreamedSuffix = suffix;
  const initialUser = msg(1, { provider: 'antigravity', content: '解释去重机制' });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: {
        messages: [initialUser, msg(2, {
          id: 'msg_session_7d',
          provider: 'antigravity',
          content: completePersistedReply,
          providerRowKey,
        })],
        total: 2,
        hasMore: false,
      },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: partialStreamedSuffix,
    providerRowKey,
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);

  assert.deepEqual(
    store.getMessages(SESSION_ID)
      .filter((row) => row.role === 'assistant')
      .map((row) => row.content),
    [completePersistedReply],
  );
});

test('a keyed Antigravity stream suffix with pangu spacing and missing markdown newlines yields to complete formatted history', async () => {
  const providerRowKey = 'assistant-step:7e';
  const prefix = '从你的截图来看，每一个显示 x2 的工具调用，点开后里面其实都是同一个操作的两个分身：后端历史记录与 WebSocket 实时流。'.repeat(3);
  const formattedSuffix = [
    '### 为什么会出现两个分身？（根本原因）',
    '',
    '在 CloudCLI 的设计中，界面的对话消息有**两条流向**：',
    '- **第一条路（REST 历史记录）**：当你打开页面、切换会话时，前端拉取最新的历史记录。',
    '- **第二条路（WebSocket 实时流）**：正在运行的 Codex 任务，会把实时事件一条条推送给前端。',
    '',
    '#### 1. 两边的“身份证（ID）”天然对不上',
    'Codex SDK 实时推过来的事件使用的是 SDK 内部临时生成的 ID，而写入日志历史文件的则是底层的 ID。',
    '',
    '#### 2. “指纹比对”因为 diff 数据缺失导致不一致',
    '比对算法发现两者的参数内容完全不同，判定它们是两次不同的工具调用。',
    '',
    '2. 在后端实时流处理时补齐对应的 tool_result 完成帧。',
  ].join('\n');

  const rawStreamSuffix = [
    '的对话消息有**两条流向**：',
    '- **第一条路（REST历史记录）**：当你打开页面、切换会话时，前端拉取最新的历史记录。- **第二条路（WebSocket 实时流）**：正在运行的 Codex任务，会把实时事件一条条推送给前端。',
    '#### 1.两边的“身份证（ID）”天然对不上Codex SDK实时推过来的事件使用的是SDK内部临时生成的 ID，而写入日志历史文件的则是底层的 ID。',
    '#### 2. “指纹比对”因为diff数据缺失导致不一致比对算法发现两者的参数内容完全不同，判定它们是两次不同的工具调用。',
    '2.在后端实时流处理时补齐对应的 tool_result完成帧。',
  ].join('\n');

  const completePersistedReply = `${prefix}\n\n${formattedSuffix}`;
  const initialUser = msg(1, { provider: 'antigravity', content: '分析原因' });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: {
        messages: [initialUser, msg(2, {
          id: 'msg_session_7e',
          provider: 'antigravity',
          content: completePersistedReply,
          providerRowKey,
        })],
        total: 2,
        hasMore: false,
      },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: rawStreamSuffix,
    providerRowKey,
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);

  assert.deepEqual(
    store.getMessages(SESSION_ID)
      .filter((row) => row.role === 'assistant')
      .map((row) => row.content),
    [completePersistedReply],
  );
});

test('different provider row keys preserve identical Antigravity text as distinct rows', async () => {
  const repeatedContent = 'This answer is intentionally repeated in two distinct provider steps.';
  const initialUser = msg(1, { provider: 'antigravity', content: 'answer twice' });
  const persistedReply = msg(2, {
    id: 'msg_session_8',
    provider: 'antigravity',
    content: repeatedContent,
    providerRowKey: 'assistant-step:8',
  });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser, persistedReply], total: 2, hasMore: false },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: repeatedContent,
    providerRowKey: 'assistant-step:9',
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);

  assert.equal(
    store.getMessages(SESSION_ID).filter((row) => row.content === repeatedContent).length,
    2,
  );
});

test('a duplicated persisted provider row key does not discard any candidate by content', async () => {
  const repeatedContent = 'A provider key collision must stay visible instead of deleting user-visible text.';
  const providerRowKey = 'assistant-step:9';
  const initialUser = msg(1, { provider: 'antigravity', content: 'show the plan' });
  const firstPersistedReply = msg(2, {
    id: 'msg_session_9_a',
    provider: 'antigravity',
    content: repeatedContent,
    providerRowKey,
  });
  const secondPersistedReply = msg(4, {
    id: 'msg_session_9_b',
    provider: 'antigravity',
    content: repeatedContent,
    providerRowKey,
  });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [initialUser], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: {
        messages: [initialUser, firstPersistedReply, secondPersistedReply],
        total: 3,
        hasMore: false,
      },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: repeatedContent,
    providerRowKey,
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);

  assert.equal(
    store.getMessages(SESSION_ID).filter((row) => row.content === repeatedContent).length,
    3,
  );
  assert.equal(store.getSessionSlot(SESSION_ID)!.realtimeMessages.length, 1);
});

test('a new provider row key splits Antigravity deltas even when no stream_end arrives', () => {
  const store = new SessionTimelineStore();

  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: 'First provider step.',
    providerRowKey: 'assistant-step:10',
  });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: 'Second provider step.',
    providerRowKey: 'assistant-step:11',
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  assert.deepEqual(
    store.getMessages(SESSION_ID)
      .filter((row) => row.kind === 'text' && row.role === 'assistant')
      .map((row) => ({ content: row.content, providerRowKey: row.providerRowKey })),
    [
      { content: 'First provider step.', providerRowKey: 'assistant-step:10' },
      { content: 'Second provider step.', providerRowKey: 'assistant-step:11' },
    ],
  );
});

test('crossing between unkeyed stdout and keyed Antigravity text closes each stream segment', () => {
  const store = new SessionTimelineStore();

  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: 'Unkeyed notice before the answer.',
  });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: 'Persistable provider answer.',
    providerRowKey: 'assistant-step:12',
  });
  emitAntigravity(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: 'Unkeyed notice after the answer.',
  });
  emitAntigravity(store, { kind: 'complete', sessionId: SESSION_ID });

  assert.deepEqual(
    store.getMessages(SESSION_ID)
      .filter((row) => row.kind === 'text' && row.role === 'assistant')
      .map((row) => ({ content: row.content, providerRowKey: row.providerRowKey })),
    [
      { content: 'Unkeyed notice before the answer.', providerRowKey: undefined },
      { content: 'Persistable provider answer.', providerRowKey: 'assistant-step:12' },
      { content: 'Unkeyed notice after the answer.', providerRowKey: undefined },
    ],
  );
});

// ─── Merged view: the three realtime-echo absorptions ────────────────────────

test('optimistic user, thinking, and same-turn assistant echoes are absorbed into the merged view', async () => {
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: {
        messages: [
          msg(1, { content: 'what is the answer?' }),
          msg(2, { kind: 'thinking', role: undefined, content: 'pondering the question carefully' }),
          msg(4, { content: 'here is a thorough answer spanning plenty of words to be matchable' }),
        ],
        total: 3,
        hasMore: false,
      },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  const at = (n: number) => new Date(BASE_TIME + n * 1000).toISOString();
  // Sent before this page existed, which is the only order reality produces:
  // a prompt is not on disk until it has been sent. The store records the
  // transcript's last row at that moment — here, nothing at all.
  store.appendRealtime(SESSION_ID,
    msg(1, {
      id: 'local_user_echo',
      content: 'what is the answer?',
      timestamp: at(1),
    }));

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  store.appendRealtime(SESSION_ID, {
    id: 'rt_thinking_echo',
    sessionId: SESSION_ID,
    kind: 'thinking',
    content: 'pondering the question carefully',
    timestamp: at(2),
    provider: 'claude',
  } as NormalizedMessage);
  // The live reply arrives under the engine's own id — the same id the
  // persisted row carries — so recognising it as the same row is a lookup,
  // not a comparison of what it says.
  store.appendRealtime(SESSION_ID, {
    id: 'm4',
    sessionId: SESSION_ID,
    kind: 'text',
    role: 'assistant',
    content: 'here is a thorough answer spanning plenty of words to be matchable',
    timestamp: at(4),
    provider: 'claude',
  } as NormalizedMessage);

  assert.deepEqual(
    store.getMessages(SESSION_ID).map((row) => row.id),
    ['m1', 'm2', 'm4'],
  );
});

test('a live provider echo merges into its optimistic user row before history refreshes', async () => {
  const prompt = 'archive the architecture docs, then discuss resource management';
  const providerEcho = msg(2, {
    id: 'claude-user-uuid',
    content: prompt,
    role: 'user',
    timestamp: '2026-09-20T00:40:13.139Z',
    transcriptAnchorId: 'claude-user-uuid',
  });
  const store = new SessionTimelineStore({
    fetchPage: async () => ({ messages: [providerEcho], total: 1, hasMore: false }),
  });

  store.appendRealtime(SESSION_ID, msg(1, {
    id: 'local_prompt',
    content: prompt,
    timestamp: '2026-09-20T00:39:58.000Z',
  }));
  emit(store, providerEcho);

  // The echo takes the stand-in's place, so the prompt carries the engine's
  // own identity — and its edit/fork anchor — before any refresh.
  let userRows = store.getMessages(SESSION_ID).filter((row) => row.role === 'user');
  assert.deepEqual(
    userRows.map((row) => ({ id: row.id, transcriptAnchorId: row.transcriptAnchorId })),
    [{ id: 'claude-user-uuid', transcriptAnchorId: 'claude-user-uuid' }],
  );

  await store.refreshLatestFromServer(SESSION_ID, { limit: 50 });
  userRows = store.getMessages(SESSION_ID).filter((row) => row.role === 'user');
  assert.deepEqual(userRows.map((row) => row.id), ['claude-user-uuid']);
});

test('a live assistant reply cannot overtake the optimistic user row when clocks disagree', async () => {
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: {
        messages: [msg(2, { content: 'answer from an earlier turn' })],
        total: 1,
        hasMore: false,
      },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  // The browser clock is ahead of the server clock, but append order still
  // captures causality: the question was sent before its reply arrived.
  store.appendRealtime(SESSION_ID, msg(3, {
    id: 'local_current_question',
    content: 'current question',
    timestamp: '2026-01-01T00:00:08.900Z',
  }));
  store.appendRealtime(SESSION_ID, msg(4, {
    id: 'live_assistant_reply',
    content: 'reply to current question',
    timestamp: '2026-01-01T00:00:08.388Z',
  }));

  assert.deepEqual(
    store.getMessages(SESSION_ID).map((row) => row.id),
    ['m2', 'local_current_question', 'live_assistant_reply'],
  );
});

// ─── Resume seq ──────────────────────────────────────────────────────────────

test('the resume seq keeps the maximum observed value per session', () => {
  const store = new SessionTimelineStore();
  emit(store, { kind: 'status', sessionId: SESSION_ID, seq: 3 });
  emit(store, { kind: 'status', sessionId: SESSION_ID, seq: 7 });
  emit(store, { kind: 'status', sessionId: SESSION_ID, seq: 5 });
  emit(store, { kind: 'status', sessionId: 'sess-other', seq: 99 });
  assert.equal(store.getResumeSeq(SESSION_ID), 7);
  assert.equal(store.getResumeSeq('sess-other'), 99);
  assert.equal(store.getResumeSeq('sess-unknown'), 0);
});

// ─── Notify scoping (the React seam) ─────────────────────────────────────────

test('notify fires only for the active session', async () => {
  const notified: string[] = [];
  const fetchPage = scriptedFetcher([
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: { messages: [msg(1)], total: 1, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage, notify: (sid) => notified.push(sid) });
  store.setActiveSession(SESSION_ID);

  store.appendRealtime('sess-background', msg(1, { sessionId: 'sess-background' }));
  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  // Background writes never notify; active-session writes do.
  assert.deepEqual(notified.filter((sid) => sid === 'sess-background'), []);
  assert.ok(notified.includes(SESSION_ID));
});

// ─── Tool identity: the two paths mint different ids for one call ────────────

const liveWriteCard = (toolId: string): NormalizedMessage => ({
  id: `rt-${toolId}`,
  sessionId: SESSION_ID,
  timestamp: new Date(BASE_TIME + 60_000).toISOString(),
  provider: 'zcode',
  kind: 'tool_use',
  toolName: 'Write',
  toolInput: { file_path: '/a.ts', content: 'hello' },
  toolId,
});

const persistedWriteCard = (toolId: string): NormalizedMessage => ({
  id: `m-${toolId}`,
  sessionId: SESSION_ID,
  timestamp: new Date(BASE_TIME + 61_000).toISOString(),
  provider: 'zcode',
  kind: 'tool_use',
  toolName: 'Write',
  toolInput: { file_path: '/a.ts', content: 'hello' },
  toolId,
});

test('a live card whose call is not persisted yet survives the refresh', async () => {
  const fetchPage = scriptedFetcher([
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: { messages: [msg(1)], total: 1, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });
  emit(store, liveWriteCard('live_zcode_1'));

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  const merged = store.getMessages(SESSION_ID);
  assert.equal(merged.filter((message) => message.kind === 'tool_use').length, 1);
  assert.ok(merged.some((message) => message.id === 'rt-live_zcode_1'));
});

test('tool cards without a provable user turn remain visible rather than cross-turn claiming', async () => {
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: {
        messages: [persistedWriteCard('msg_1_part_2'), persistedWriteCard('msg_3_part_4')],
        total: 2,
        hasMore: false,
      },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });
  emit(store, liveWriteCard('live_zcode_1'));
  emit(store, liveWriteCard('live_zcode_2'));

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  const toolCards = store.getMessages(SESSION_ID).filter((message) => message.kind === 'tool_use');
  assert.equal(toolCards.length, 4, 'unanchored calls stay visible');
  assert.deepEqual(
    toolCards.map((message) => message.toolId).sort(),
    ['live_zcode_1', 'live_zcode_2', 'msg_1_part_2', 'msg_3_part_4'],
  );
});

// ─── Gateway frames that are not timeline rows ───────────────────────────────

test('a sidebar-global session_removed frame never enters the timeline', async () => {
  const fetchPage = scriptedFetcher([
    { params: { limit: 20, offset: 0 }, page: { messages: [msg(1), msg(2)], total: 2, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  const slot = store.getSessionSlot(SESSION_ID)!;
  const mergedBefore = slot.merged;

  store.applyServerEvent(
    { kind: 'session_removed', sessionIds: ['sess-archived-elsewhere'] } as ServerEvent,
    { fallbackSessionId: SESSION_ID, provider: 'claude' },
  );

  assert.equal(slot.realtimeMessages.length, 0, 'global frames must not become realtime rows');
  assert.equal(slot.merged, mergedBefore, 'merged must not be recomputed');
});

test('appendRealtime drops a frame whose id is missing instead of poisoning the slot', () => {
  const store = new SessionTimelineStore();

  store.appendRealtime(SESSION_ID, { ...msg(1), id: undefined as unknown as string });
  store.appendRealtime(SESSION_ID, msg(2));

  assert.deepEqual(
    store.getMessages(SESSION_ID).map((row) => row.id),
    ['m2'],
    'the id-less frame is ignored and the following append still works',
  );
});

test('a repeated local user prompt cannot prove a stale server turn for tool reconciliation', async () => {
  const staleServerUser = msg(1, { id: 'server-old-user', content: '继续', role: 'user' });
  const staleServerTool = persistedWriteCard('server-old-tool');
  const fetchPage = scriptedFetcher([{
    params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
    page: { messages: [staleServerUser, staleServerTool], total: 2, hasMore: false },
  }]);
  const store = new SessionTimelineStore({ fetchPage });
  const currentLocalUser = msg(2, { id: 'local-current-user', content: '继续', role: 'user' });

  store.appendRealtime(SESSION_ID, currentLocalUser);
  store.appendRealtime(SESSION_ID, liveWriteCard('live-current-tool'));
  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  const toolCards = store.getMessages(SESSION_ID).filter((message) => message.kind === 'tool_use');
  assert.deepEqual(
    toolCards.map((message) => message.toolId).sort(),
    ['live-current-tool', 'server-old-tool'],
  );
});

test('an Edit for the same path in a later user turn cannot claim an earlier persisted Edit', async () => {
  const firstUser = msg(1, { id: 'server-user-one', content: 'first edit' });
  const secondUser = msg(3, { id: 'server-user-two', content: 'second edit' });
  const firstEdit = persistedWriteCard('server-edit-one');
  const secondEdit = persistedWriteCard('server-edit-two');
  firstEdit.toolInput = { file_path: '/a.ts', content: 'first change' };
  secondEdit.toolInput = { file_path: '/a.ts', content: 'second change' };
  const fetchPage = scriptedFetcher([{
    params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
    page: { messages: [firstUser, firstEdit, secondUser, secondEdit], total: 4, hasMore: false },
  }]);
  const store = new SessionTimelineStore({ fetchPage });
  emit(store, firstUser);
  emit(store, firstEdit);
  emit(store, secondUser);
  emit(store, liveWriteCard('live-second-edit'));

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  assert.ok(store.getMessages(SESSION_ID).some((message) => message.id === 'rt-live-second-edit'));
});

// ─── Cross-source ordering: causal anchor over wall clock ────────────────────

/**
 * The reported Codex symptom: the live reply renders *above* the user message
 * that caused it.
 *
 * The two sources carry timestamps from two machines — the streaming row is
 * stamped by the browser, the persisted user turn by the engine. While the
 * optimistic `local_` row is still present both rows sit in `realtimeMessages`
 * and array order keeps them straight; once the history refresh retires the
 * optimistic row, the pair is split across sources and a browser clock running
 * slightly behind the engine's flips them.
 *
 * Ordering must come from the causal anchor (this stream belongs to that user
 * turn), never from comparing two machines' clocks.
 */
test('a live stream stays below its user turn when the browser clock lags the engine', async () => {
  const ENGINE_USER_TIME = new Date(BASE_TIME + 60_000).toISOString();
  const BROWSER_SKEW_MS = 2_000;

  const persistedUserTurn: NormalizedMessage = {
    id: 'engine-user-1',
    sessionId: SESSION_ID,
    timestamp: ENGINE_USER_TIME,
    provider: 'codex',
    kind: 'text',
    role: 'user',
    content: 'explain the merge',
  };

  const fetchPage = scriptedFetcher([
    { params: { limit: 50, offset: 0 }, page: { messages: [persistedUserTurn], total: 1, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  // The browser stamps the optimistic user row and the stream that follows it
  // with a clock running behind the engine's.
  vi.setSystemTime(new Date(BASE_TIME + 60_000 - BROWSER_SKEW_MS));

  store.appendRealtime(SESSION_ID, {
    id: 'local_1',
    sessionId: SESSION_ID,
    timestamp: new Date(BASE_TIME + 60_000 - BROWSER_SKEW_MS).toISOString(),
    provider: 'codex',
    kind: 'text',
    role: 'user',
    content: 'explain the merge',
  });

  store.applyServerEvent(
    { kind: 'stream_delta', sessionId: SESSION_ID, content: 'The merge interleaves' } as unknown as ServerEvent,
    { provider: 'codex' },
  );
  await tickThrottle();

  // The history refresh lands the engine's copy of the user turn, retiring the
  // optimistic row and splitting the pair across the two sources.
  await store.refreshLatestFromServer(SESSION_ID, { limit: 50 });

  const rows = store.getMessages(SESSION_ID);
  const userIndex = rows.findIndex((row) => row.role === 'user');
  const streamIndex = rows.findIndex((row) => row.id === `__streaming_${SESSION_ID}`);

  assert.ok(userIndex >= 0, 'the user turn must survive the refresh');
  assert.ok(streamIndex >= 0, 'the live stream must survive the refresh');
  assert.ok(
    userIndex < streamIndex,
    `the live stream must stay below its user turn (user@${userIndex}, stream@${streamIndex})`,
  );
});

/**
 * The same split, minus the causal anchor: a second tab (or a tab that
 * reconnected mid-run) never created an optimistic row, so nothing records
 * which turn the live stream belongs to. Placement falls back to the clocks,
 * and this tab's clock also lags the engine's.
 */
test('a live stream stays below its user turn even without an optimistic row to anchor it', async () => {
  const ENGINE_USER_TIME = new Date(BASE_TIME + 60_000).toISOString();

  const persistedUserTurn: NormalizedMessage = {
    id: 'engine-user-1',
    sessionId: SESSION_ID,
    timestamp: ENGINE_USER_TIME,
    provider: 'codex',
    kind: 'text',
    role: 'user',
    content: 'explain the merge',
  };

  const fetchPage = scriptedFetcher([
    { params: { limit: 50, offset: 0 }, page: { messages: [persistedUserTurn], total: 1, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.refreshLatestFromServer(SESSION_ID, { limit: 50 });

  vi.setSystemTime(new Date(BASE_TIME + 60_000 - 2_000));
  store.applyServerEvent(
    { kind: 'stream_delta', sessionId: SESSION_ID, content: 'The merge interleaves' } as unknown as ServerEvent,
    { provider: 'codex' },
  );
  await tickThrottle();

  const rows = store.getMessages(SESSION_ID);
  const userIndex = rows.findIndex((row) => row.role === 'user');
  const streamIndex = rows.findIndex((row) => row.id === `__streaming_${SESSION_ID}`);

  assert.ok(userIndex >= 0 && streamIndex >= 0);
  assert.ok(
    userIndex < streamIndex,
    `the live stream must stay below its user turn (user@${userIndex}, stream@${streamIndex})`,
  );
});

/**
 * With a provider row key present, reconciliation is decided by identity.
 *
 * This is what the key is for: two bodies that differ only because one was
 * still streaming used to be judged by a text-similarity rule, and two bodies
 * that genuinely differ could be collapsed by it. A key says outright whether
 * these are one row, and a *different* key says outright that they are two.
 */
test('two Codex replies with different provider row keys both survive the refresh', async () => {
  const first: NormalizedMessage = {
    id: 'hist-1',
    sessionId: SESSION_ID,
    timestamp: new Date(BASE_TIME + 1000).toISOString(),
    provider: 'codex',
    kind: 'text',
    role: 'assistant',
    providerRowKey: 'msg_first',
    content: 'Checking the merge helper to see how the two sources interleave today.',
  };

  const fetchPage = scriptedFetcher([
    { params: { limit: 50, offset: 0 }, page: { messages: [first], total: 1, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  // A second reply that begins with the same long prefix — the shape the
  // text-similarity rule would have collapsed into the first one.
  store.appendRealtime(SESSION_ID, {
    id: 'live-2',
    sessionId: SESSION_ID,
    timestamp: new Date(BASE_TIME + 2000).toISOString(),
    provider: 'codex',
    kind: 'text',
    role: 'assistant',
    providerRowKey: 'msg_second',
    content: 'Checking the merge helper to see how the two sources interleave today, and the anchors now decide it.',
  });

  await store.refreshLatestFromServer(SESSION_ID, { limit: 50 });

  const keys = store.getMessages(SESSION_ID)
    .filter((row) => row.kind === 'text' && row.role === 'assistant')
    .map((row) => row.providerRowKey);

  assert.deepEqual(keys, ['msg_first', 'msg_second'], 'distinct keys are distinct rows');
});

/**
 * Re-sending a prompt the transcript already contains must not make the new
 * message disappear into the old turn.
 */
test('a repeated prompt is not retired by the identical prompt already on screen', async () => {
  const earlier: NormalizedMessage = {
    id: 'srv-old', sessionId: SESSION_ID, timestamp: new Date(BASE_TIME).toISOString(),
    provider: 'antigravity', kind: 'text', role: 'user', content: 'continue',
  };
  const reply: NormalizedMessage = { ...earlier, id: 'srv-reply', role: 'assistant', content: 'done' };

  const fetchPage = scriptedFetcher([
    { params: { limit: 50, offset: 0 }, page: { messages: [earlier, reply], total: 2, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });
  await store.fetchFromServer(SESSION_ID, { limit: 50, offset: 0 });

  store.appendRealtime(SESSION_ID, {
    id: 'local_repeat', sessionId: SESSION_ID, timestamp: new Date(BASE_TIME + 60_000).toISOString(),
    provider: 'antigravity', kind: 'text', role: 'user', content: 'continue',
  });

  const userRows = store.getMessages(SESSION_ID).filter((row) => row.role === 'user');
  assert.equal(userRows.length, 2, 'the newly sent prompt must still be visible');
});

test('a wholesale session reload keeps a genuinely pending repeated prompt', async () => {
  const earlier = msg(1, { id: 'srv-old', content: 'continue' });
  const reply = msg(2, { id: 'srv-reply', content: 'done' });
  const page = { messages: [earlier, reply], total: 2, hasMore: false };
  const fetchPage = scriptedFetcher([
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page },
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: { ...page, messages: [earlier, reply] } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });
  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  store.appendRealtime(SESSION_ID, msg(3, { id: 'local_repeat', content: 'continue' }));
  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  assert.deepEqual(
    store.getMessages(SESSION_ID).filter((row) => row.role === 'user').map((row) => row.id),
    ['srv-old', 'local_repeat'],
  );
});

/**
 * The send-time row count has to survive the pages that arrive after it.
 *
 * `replacesAfterRowCount` records how much transcript was on screen when a
 * prompt was sent, and retiring the optimistic echo trusts it as an index into
 * `serverMessages`. Loading an older page prepends rows, so every index shifts;
 * left unadjusted, the stamp points into the middle of history and an
 * identical earlier prompt retires the message the user just sent.
 */
test('an older page prepended after sending does not strand the optimistic prompt', async () => {
  const newest: NormalizedMessage = {
    id: 'srv-new', sessionId: SESSION_ID, timestamp: new Date(BASE_TIME + 10_000).toISOString(),
    provider: 'claude', kind: 'text', role: 'assistant', content: 'newest reply',
  };
  const older: NormalizedMessage = {
    id: 'srv-older', sessionId: SESSION_ID, timestamp: new Date(BASE_TIME).toISOString(),
    provider: 'claude', kind: 'text', role: 'user', content: 'continue',
  };

  const fetchPage = scriptedFetcher([
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: { messages: [newest], total: 2, hasMore: true } },
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 1 }, page: { messages: [older], total: 2, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });
  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  // Sent when one row was on screen.
  store.appendRealtime(SESSION_ID, {
    id: 'local_repeat', sessionId: SESSION_ID, timestamp: new Date(BASE_TIME + 20_000).toISOString(),
    provider: 'claude', kind: 'text', role: 'user', content: 'continue',
  });
  assert.equal(
    store.getSessionSlot(SESSION_ID)?.pendingPrompts.get('local_repeat')?.afterRowId,
    'srv-new',
    'the prompt anchors on the row the transcript ended with when it was sent',
  );

  await store.fetchMore(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE });

  // The anchor is an id, so prepending an older page above it changes
  // nothing. The row-count stamp this replaced had to be rewritten on every
  // such page, and a wholesale refresh left it pointing past the prompt's own
  // copy — after which the prompt could never retire at all.
  assert.equal(
    store.getSessionSlot(SESSION_ID)?.pendingPrompts.get('local_repeat')?.afterRowId,
    'srv-new',
  );

  const userRows = store.getMessages(SESSION_ID).filter((row) => row.role === 'user');
  assert.equal(userRows.length, 2, 'the sent prompt must not be retired by the older identical one');
});

test('returning to a tool-heavy tail does not resurrect retired user echoes', async () => {
  const turn1 = [
    msg(1, { id: 'server-u1', content: 'u1' }),
    msg(2, { id: 'server-a1', content: 'a1' }),
  ];
  const turn2 = [
    ...turn1,
    msg(3, { id: 'server-u2', content: 'u2' }),
    msg(4, { id: 'server-a2', content: 'a2' }),
  ];
  const fetchPage = scriptedFetcher([
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: { messages: turn1, total: 2, hasMore: false } },
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: { messages: turn2, total: 4, hasMore: false } },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: {
        messages: [msg(6, { id: 'tail-tool', kind: 'tool_use', role: undefined, content: '' })],
        total: 6,
        hasMore: true,
      },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  store.appendRealtime(SESSION_ID, msg(1, { id: 'local_u1', content: 'u1' }));
  await store.refreshLatestFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE });
  store.appendRealtime(SESSION_ID, msg(3, { id: 'local_u2', content: 'u2' }));
  await store.refreshLatestFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE });
  store.appendRealtime(SESSION_ID, msg(5, { id: 'local_u3', content: 'u3' }));

  assert.deepEqual(
    store.getMessages(SESSION_ID).filter((row) => row.role === 'user').map((row) => row.id),
    ['server-u1', 'server-u2', 'local_u3'],
    'precondition: two persisted turns precede the current pending prompt',
  );

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  assert.deepEqual(
    store.getMessages(SESSION_ID).filter((row) => row.role === 'user').map((row) => row.id),
    ['local_u3'],
    'only the current prompt survives when older server rows fall outside the returned tail page',
  );
});

/**
 * A user row can reach the live stream without ever having been an optimistic
 * prompt: a second tab (or phone) sent it, or the engine echoed it back on a
 * resume. It arrives under the engine's own id, the same id the transcript
 * will hold, so the refresh recognises it without looking at what it says.
 */
test('a user row that never was an optimistic prompt is pruned once the transcript holds it', async () => {
  const store = new SessionTimelineStore({
    fetchPage: async () => ({
      messages: [
        msg(1, { id: 'srv_user', content: 'ship it' }),
        msg(2, { id: 'srv_reply', content: 'done' }),
      ],
      total: 2,
      hasMore: false,
    }),
  });

  store.appendRealtime(SESSION_ID, msg(1, { id: 'srv_user', content: 'ship it' }));
  await store.refreshLatestFromServer(SESSION_ID, { limit: 50 });

  const prompts = store.getMessages(SESSION_ID).filter(
    (row) => row.kind === 'text' && row.role === 'user' && row.content === 'ship it',
  );
  assert.equal(prompts.length, 1, 'the prompt must not render as both a live copy and a persisted one');
});

/** Two genuinely distinct sends of the same text must both survive: they are
 * two engine rows with two ids, and nothing collapses rows by content. */
test('repeated identical prompts each keep exactly one row', async () => {
  const store = new SessionTimelineStore({
    fetchPage: async () => ({
      messages: [
        msg(1, { id: 'srv_a', content: 'again' }),
        msg(3, { id: 'srv_b', content: 'again' }),
      ],
      total: 2,
      hasMore: false,
    }),
  });

  store.appendRealtime(SESSION_ID, msg(1, { id: 'srv_a', content: 'again' }));
  store.appendRealtime(SESSION_ID, msg(3, { id: 'srv_b', content: 'again' }));
  await store.refreshLatestFromServer(SESSION_ID, { limit: 50 });

  const prompts = store.getMessages(SESSION_ID).filter(
    (row) => row.kind === 'text' && row.role === 'user' && row.content === 'again',
  );
  assert.equal(prompts.length, 2, 'two real sends must not collapse into one');
});

/**
 * The reported failure, end to end.
 *
 * The user sends a prompt, then switches away and back (or the search jump
 * or load-all path runs), which reloads the whole window. That page already
 * contains the engine's copy of the prompt, because the engine persisted it
 * the moment it arrived. The send-time stamp used to be rewritten to the end
 * of that page on every wholesale load, which put the prompt's own copy
 * *before* the first row it was allowed to pair with — so it never paired,
 * and the prompt stayed on screen beside its persisted copy until the page
 * was reloaded. A second refresh could not fix it either: the stamp was
 * rewritten to the new end each time.
 */
test('a full reload that already holds the prompt still retires it', async () => {
  const page = {
    messages: [
      msg(1, { id: 'srv-old-user', content: 'earlier question' }),
      msg(2, { id: 'srv-old-reply', content: 'earlier answer', role: 'assistant' }),
    ],
    total: 2,
    hasMore: false,
  };
  const pageWithPrompt = {
    messages: [
      ...page.messages,
      msg(3, { id: 'srv-prompt', content: 'fix it' }),
      msg(4, { id: 'srv-reply', content: 'fixing', role: 'assistant' }),
    ],
    total: 4,
    hasMore: false,
  };
  const fetchPage = scriptedFetcher([
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page },
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: pageWithPrompt },
    { params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 }, page: pageWithPrompt },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  store.appendRealtime(SESSION_ID, msg(5, { id: 'local_fix', content: 'fix it' }));

  // Switching to another tab and back reloads the whole window, and by then
  // the engine has written the prompt.
  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });

  const prompts = store.getMessages(SESSION_ID).filter(
    (row) => row.kind === 'text' && row.role === 'user' && row.content === 'fix it',
  );
  assert.deepEqual(
    prompts.map((row) => row.id),
    ['srv-prompt'],
    'the prompt must render once, as its persisted copy',
  );

  // And it stays retired across further reloads.
  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  assert.equal(
    store.getMessages(SESSION_ID).filter(
      (row) => row.kind === 'text' && row.role === 'user' && row.content === 'fix it',
    ).length,
    1,
  );
});

/** Drives one OpenCode frame: its live stream names the part, never the row. */
function emitOpenCode(store: SessionTimelineStore, frame: Record<string, unknown>): void {
  store.applyServerEvent(frame as ServerEvent, { provider: 'opencode' });
}

/**
 * The reported OpenCode duplicate.
 *
 * OpenCode streams a reply as `message.part.delta` fragments and never sends
 * the finished row, so the bubble the client assembles from them has no
 * engine id its persisted copy could be recognised by. The part id is the one
 * identity both transports carry; published as the row key it lets the
 * persisted row claim the stream. Without it the reply stood beside its own
 * persisted copy for the rest of the session.
 */
test('a streamed OpenCode reply is claimed by the persisted row for its part', async () => {
  const providerRowKey = 'opencode-part:prt_reply';
  const reply = 'No problem — say the word if the console flashes anywhere else.';
  const prompt = msg(1, { provider: 'opencode', content: 'thanks, the flicker is gone' });
  const persistedReply = msg(2, {
    id: 'msg_turn_prt_reply',
    provider: 'opencode',
    content: reply,
    providerRowKey,
  });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [prompt], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [prompt, persistedReply], total: 2, hasMore: false },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitOpenCode(store, { kind: 'stream_delta', sessionId: SESSION_ID, content: reply.slice(0, 12), providerRowKey });
  emitOpenCode(store, { kind: 'stream_delta', sessionId: SESSION_ID, content: reply.slice(12), providerRowKey });
  emitOpenCode(store, { kind: 'stream_end', sessionId: SESSION_ID });
  emitOpenCode(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);

  assert.deepEqual(
    store.getMessages(SESSION_ID).filter((row) => row.content === reply).map((row) => row.id),
    ['msg_turn_prt_reply'],
    'the reply must render once, as its persisted row',
  );
  assert.equal(store.getSessionSlot(SESSION_ID)!.realtimeMessages.length, 0);
});

/**
 * One OpenCode turn that writes, calls a tool, then writes again persists two
 * text rows. Keying the stream per part is what lets each persisted row claim
 * its own segment: a key shared by both segments matches two rows, which is
 * ambiguous, and an ambiguous key reconciles nothing — both streamed copies
 * would stay on screen.
 */
test('two text parts of one OpenCode turn are each claimed by their own persisted row', async () => {
  const first = 'Checking the runtime first.';
  const second = 'Done — the console no longer flashes.';
  const prompt = msg(1, { provider: 'opencode', content: 'fix the console flash' });
  const persistedFirst = msg(2, {
    id: 'msg_turn_prt_a',
    provider: 'opencode',
    content: first,
    providerRowKey: 'opencode-part:prt_a',
  });
  const persistedSecond = msg(4, {
    id: 'msg_turn_prt_b',
    provider: 'opencode',
    content: second,
    providerRowKey: 'opencode-part:prt_b',
  });
  const fetchPage = scriptedFetcher([
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [prompt], total: 1, hasMore: false },
    },
    {
      params: { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 },
      page: { messages: [prompt, persistedFirst, persistedSecond], total: 3, hasMore: false },
    },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  emitOpenCode(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: first,
    providerRowKey: 'opencode-part:prt_a',
  });
  emitOpenCode(store, {
    kind: 'stream_delta',
    sessionId: SESSION_ID,
    content: second,
    providerRowKey: 'opencode-part:prt_b',
  });
  emitOpenCode(store, { kind: 'stream_end', sessionId: SESSION_ID });
  emitOpenCode(store, { kind: 'complete', sessionId: SESSION_ID });

  await store.refreshLatestFromServer(SESSION_ID);

  assert.deepEqual(
    store.getMessages(SESSION_ID)
      .filter((row) => row.content === first || row.content === second)
      .map((row) => row.id),
    ['msg_turn_prt_a', 'msg_turn_prt_b'],
    'each segment must render once, as its own persisted row',
  );
  assert.equal(store.getSessionSlot(SESSION_ID)!.realtimeMessages.length, 0);
});
