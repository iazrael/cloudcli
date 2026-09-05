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

import type { NormalizedMessage } from '@/shared/types';
import type { SessionHistoryPage, SessionPageFetcher } from '@/modules/chat/utils/sessionTimelineStore';
import { SessionTimelineStore } from '@/modules/chat/utils/sessionTimelineStore';
import type { SessionMessagesRequestOptions } from '@/modules/chat/utils/sessionMessagePagination';

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
    { params: { limit: 20, offset: 0 }, page },
    { params: { limit: 20, offset: 0 }, page: { messages: [msg(1), msg(2)], total: 2, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  store.upsertToolUse(SESSION_ID, {
    id: 'rt-tool-live',
    toolId: 'tool-live',
    toolName: 'Bash',
    input: {},
  } as NormalizedMessage);

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
    { params: { limit: 20, offset: 0 }, page: { messages: [msg(1), msg(2)], total: 2, hasMore: false } },
    { params: { limit: 20, offset: 0 }, page: { messages: [msg(1), msg(2)], total: 2, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  store.appendRealtime(SESSION_ID, msg(2));

  const result = await store.refreshLatestFromServer(SESSION_ID);

  assert.equal(result.changed, true, 'pruning a replay row counts as a change');
  assert.equal(store.getSessionSlot(SESSION_ID)!.realtimeMessages.length, 0);
  assert.equal(store.getMessages(SESSION_ID).filter((row) => row.id === 'm2').length, 1);
});

// ─── Older pages: drift realignment ──────────────────────────────────────────

test('a drifting offset during fetchMore realigns from the tail, then retries with the realigned offset', async () => {
  const fetchPage = scriptedFetcher([
    { params: { limit: 20, offset: 0 }, page: { messages: [msg(3), msg(4)], total: 6, hasMore: true } },
    { params: { limit: 20, offset: 2 }, page: { messages: [msg(2)], total: 7, hasMore: true } },
    { params: { limit: 20, offset: 0 }, page: { messages: [msg(3), msg(4), msg(5)], total: 7, hasMore: true } },
    { params: { limit: 20, offset: 3 }, page: { messages: [msg(2)], total: 7, hasMore: true } },
  ]);
  const store = new SessionTimelineStore({ fetchPage });

  await store.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
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
  const initial = store.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
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

  store.appendStreamDelta(SESSION_ID, 'Hel', 'claude');
  await tickThrottle();
  let streaming = store.getMessages(SESSION_ID).find((row) => row.id === `__streaming_${SESSION_ID}`);
  assert.ok(streaming);
  const anchoredTimestamp = streaming!.timestamp;

  store.appendStreamDelta(SESSION_ID, 'lo', 'claude');
  await tickThrottle();
  streaming = store.getMessages(SESSION_ID).find((row) => row.id === `__streaming_${SESSION_ID}`);
  assert.equal(streaming!.content, 'Hello');
  assert.equal(streaming!.timestamp, anchoredTimestamp, 'later deltas must not refresh the timestamp');

  const realtimeCountBefore = store.getSessionSlot(SESSION_ID)!.realtimeMessages.length;
  store.flushStream(SESSION_ID, 'claude');

  const finalized = store.getMessages(SESSION_ID).find((row) => row.content === 'Hello');
  assert.ok(finalized);
  assert.match(finalized!.id, /^text_/);
  assert.equal(finalized!.timestamp, anchoredTimestamp);
  assert.equal(store.getSessionSlot(SESSION_ID)!.realtimeMessages.length, realtimeCountBefore,
    'finalization replaces the streaming row in place');

  // A later segment starts fresh instead of concatenating onto the flushed text.
  store.appendStreamDelta(SESSION_ID, 'Next', 'claude');
  await tickThrottle();
  const nextSegment = store.getMessages(SESSION_ID).find((row) => row.id === `__streaming_${SESSION_ID}`);
  assert.ok(nextSegment);
  assert.equal(nextSegment!.content, 'Next');
});

// ─── Merged view: the three realtime-echo absorptions ────────────────────────

test('optimistic user, thinking, and same-turn assistant echoes are absorbed into the merged view', async () => {
  const fetchPage = scriptedFetcher([
    {
      params: { limit: 20, offset: 0 },
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

  await store.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });

  const at = (n: number) => new Date(BASE_TIME + n * 1000).toISOString();
  store.appendRealtime(SESSION_ID,
    msg(1, { id: 'local_user_echo', content: 'what is the answer?', timestamp: at(1) }));
  store.appendRealtime(SESSION_ID, {
    id: 'rt_thinking_echo',
    sessionId: SESSION_ID,
    kind: 'thinking',
    content: 'pondering the question carefully',
    timestamp: at(2),
    provider: 'claude',
  } as NormalizedMessage);
  store.appendRealtime(SESSION_ID, {
    id: 'text_streamed_echo',
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

// ─── Resume seq ──────────────────────────────────────────────────────────────

test('the resume seq keeps the maximum observed value per session', () => {
  const store = new SessionTimelineStore();
  store.noteSeq(SESSION_ID, 3);
  store.noteSeq(SESSION_ID, 7);
  store.noteSeq(SESSION_ID, 5);
  store.noteSeq('sess-other', 99);
  assert.equal(store.getResumeSeq(SESSION_ID), 7);
  assert.equal(store.getResumeSeq('sess-other'), 99);
  assert.equal(store.getResumeSeq('sess-unknown'), 0);
});

// ─── Notify scoping (the React seam) ─────────────────────────────────────────

test('notify fires only for the active session', async () => {
  const notified: string[] = [];
  const fetchPage = scriptedFetcher([
    { params: { limit: 20, offset: 0 }, page: { messages: [msg(1)], total: 1, hasMore: false } },
  ]);
  const store = new SessionTimelineStore({ fetchPage, notify: (sid) => notified.push(sid) });
  store.setActiveSession(SESSION_ID);

  store.appendRealtime('sess-background', msg(1, { sessionId: 'sess-background' }));
  await store.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });

  // Background writes never notify; active-session writes do.
  assert.deepEqual(notified.filter((sid) => sid === 'sess-background'), []);
  assert.ok(notified.includes(SESSION_ID));
});
