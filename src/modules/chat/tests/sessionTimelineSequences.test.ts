/**
 * Characterization tests for the session timeline's order-sensitive sequences.
 *
 * The timeline's correctness rests on cross-file call-order contracts (prune
 * before the content-level bail-out, the flush gate before any content frame
 * enters the store, offset-drift realignment before an older-page retry, the
 * streaming row's anchored timestamp). These tests drive the REAL store and
 * the REAL realtime handler together — with only the HTTP transport and the
 * websocket transport stubbed — so the sequences are pinned end-to-end before
 * the timeline store extraction reshuffles where the code lives. Every fix
 * here that looks pedantic guards a coupling point a past bug lived on.
 */

import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import type { ServerEvent } from '@/shared/context/WebSocketContext';
import type { NormalizedMessage } from '@/shared/types';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';

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

type HistoryPage = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
};

/**
 * Stubs the history endpoint with a scripted call sequence. Each scripted
 * entry also pins the exact `limit`/`offset` the timeline must request, so a
 * regression in offset bookkeeping (drift realignment, retry offsets) fails
 * loudly instead of silently fetching the wrong window.
 */
function stubHistoryFetch(script: Array<{ params: { limit: string; offset: string }; page: HistoryPage }>): void {
  const remaining = [...script];
  const fetchMock = vi.fn((url: string) => {
    assert.ok(remaining.length > 0, `unexpected history request: ${url}`);
    const expected = remaining.shift()!;
    const params = new URL(url, 'http://localhost').searchParams;
    assert.equal(params.get('limit'), expected.params.limit, `call ${script.length - remaining.length}: limit`);
    assert.equal(params.get('offset'), expected.params.offset, `call ${script.length - remaining.length}: offset`);
    const body = JSON.stringify({ success: true, data: expected.page });
    return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });
  vi.stubGlobal('fetch', fetchMock);
}

type TimelineHarness = {
  sessionStore: ReturnType<typeof useSessionStore>;
  lastSeqRef: { current: Map<string, number> };
  accumulatedStreamsRef: { current: Map<string, string> };
  streamTimersRef: { current: Map<string, number> };
  requestLatestMessages: ReturnType<typeof vi.fn>;
  onSessionIdle: ReturnType<typeof vi.fn>;
  emit: (frame: ServerEvent) => void;
  cleanup: () => void;
};

function mountTimeline(activeSessionId: string | null = SESSION_ID): TimelineHarness {
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const storeRoot = renderHook(() => useSessionStore());
  const sessionStore = storeRoot.result.current;
  sessionStore.setActiveSession(activeSessionId);

  const streamTimersRef = { current: new Map<string, number>() };
  const accumulatedStreamsRef = { current: new Map<string, string>() };
  const lastSeqRef = { current: new Map<string, number>() };
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const requestLatestMessages = vi.fn();
  const onSessionIdle = vi.fn();
  const onSessionProcessing = vi.fn();

  const handlersRoot = renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe,
    provider: 'claude',
    selectedSession: null,
    currentSessionId: activeSessionId,
    setTokenBudget: vi.fn(),
    pendingPermissionRequests: [],
    setPendingPermissionRequests: vi.fn(),
    streamTimersRef,
    accumulatedStreamsRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: vi.fn(),
    requestLatestMessages,
    sessionStore,
  }));

  const emit = (frame: ServerEvent) => {
    act(() => {
      for (const listener of listeners) {
        listener(frame);
      }
    });
  };

  const cleanup = () => {
    for (const timer of streamTimersRef.current.values()) {
      clearTimeout(timer);
    }
    streamTimersRef.current.clear();
    handlersRoot.unmount();
    storeRoot.unmount();
  };

  return { sessionStore, lastSeqRef, accumulatedStreamsRef, streamTimersRef, requestLatestMessages, onSessionIdle, emit, cleanup };
}

/** Lets the 100ms stream throttle fire exactly once and apply the row. */
const tickThrottle = () => new Promise((resolve) => setTimeout(resolve, 130));

// ─── prune before the content-level bail-out ─────────────────────────────────

test('an identical latest refresh bails out and keeps every cached identity when nothing is prunable', async () => {
  stubHistoryFetch([
    { params: { limit: '20', offset: '0' }, page: { messages: [msg(1), msg(2)], total: 2, hasMore: false } },
    { params: { limit: '20', offset: '0' }, page: { messages: [msg(1), msg(2)], total: 2, hasMore: false } },
  ]);
  const timeline = mountTimeline();

  await act(async () => {
    await timeline.sessionStore.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  });
  // A live tool call the persisted transcript does not own yet: prunable=no.
  timeline.emit({
    kind: 'tool_use',
    id: 'rt-tool-live',
    sessionId: SESSION_ID,
    toolId: 'tool-live',
    toolName: 'Bash',
    input: { command: 'ls' },
  } as unknown as ServerEvent);

  const slot = timeline.sessionStore.getSessionSlot(SESSION_ID)!;
  const serverBefore = slot.serverMessages;
  const mergedBefore = slot.merged;
  const realtimeBefore = slot.realtimeMessages;

  let result: { changed: boolean } | undefined;
  await act(async () => {
    result = await timeline.sessionStore.refreshLatestFromServer(SESSION_ID);
  });

  // Bail-out contract: same rows, same pagination, nothing to prune → the
  // cached arrays keep their identity so consumers skip re-rendering.
  assert.equal(result!.changed, false);
  assert.equal(slot.serverMessages, serverBefore, 'server array identity must survive the bail-out');
  assert.equal(slot.merged, mergedBefore, 'merged must not be recomputed');
  assert.equal(slot.realtimeMessages, realtimeBefore, 'the live tool row must survive');

  timeline.cleanup();
});

test('a delayed replay row is pruned by an otherwise identical refresh', async () => {
  const page = { messages: [msg(1), msg(2)], total: 2, hasMore: false };
  stubHistoryFetch([
    { params: { limit: '20', offset: '0' }, page },
    { params: { limit: '20', offset: '0' }, page: { messages: [msg(1), msg(2)], total: 2, hasMore: false } },
  ]);
  const timeline = mountTimeline();

  await act(async () => {
    await timeline.sessionStore.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  });
  // The ws replay re-delivered a row the server already persisted (same id).
  timeline.emit(msg(2) as unknown as ServerEvent);
  assert.equal(timeline.sessionStore.getMessages(SESSION_ID).filter((row) => row.id === 'm2').length, 1);

  let result: { changed: boolean } | undefined;
  await act(async () => {
    result = await timeline.sessionStore.refreshLatestFromServer(SESSION_ID);
  });

  // The prune is computed BEFORE the bail-out: even though the refreshed page
  // is identical, the superseded replay row must disappear.
  assert.equal(result!.changed, true, 'pruning a replay row counts as a change');
  const slot = timeline.sessionStore.getSessionSlot(SESSION_ID)!;
  assert.equal(slot.realtimeMessages.length, 0, 'the replay row must be pruned');
  assert.equal(timeline.sessionStore.getMessages(SESSION_ID).filter((row) => row.id === 'm2').length, 1);

  timeline.cleanup();
});

// ─── fetchMore offset drift realignment ──────────────────────────────────────

test('a drifting offset during fetchMore realigns from the tail, then retries with the realigned offset', async () => {
  stubHistoryFetch([
    // Initial load: two newest rows of a six-row transcript.
    { params: { limit: '20', offset: '0' }, page: { messages: [msg(3), msg(4)], total: 6, hasMore: true } },
    // Older-page request at offset 2, but the transcript grew while the
    // request was in flight (total 6 → 7): the response is stale.
    { params: { limit: '20', offset: '2' }, page: { messages: [msg(2)], total: 7, hasMore: true } },
    // Drift handler: one bounded latest-page reconciliation from offset 0,
    // which now includes the newly appended m5.
    { params: { limit: '20', offset: '0' }, page: { messages: [msg(3), msg(4), msg(5)], total: 7, hasMore: true } },
    // Retry with the realigned raw-row offset (3 cached rows), not the stale 2.
    { params: { limit: '20', offset: '3' }, page: { messages: [msg(2)], total: 7, hasMore: true } },
  ]);
  const timeline = mountTimeline();

  await act(async () => {
    await timeline.sessionStore.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  });

  let outcome: { prependedCount: number } | undefined;
  await act(async () => {
    outcome = await timeline.sessionStore.fetchMore(SESSION_ID);
  });

  assert.equal(outcome!.prependedCount, 1);
  const slot = timeline.sessionStore.getSessionSlot(SESSION_ID)!;
  assert.deepEqual(
    slot.serverMessages.map((row) => row.id),
    ['m2', 'm3', 'm4', 'm5'],
    'the older row must prepend onto the realigned tail with no gap and no duplicate',
  );
  assert.equal(slot.offset, 4);
  assert.equal(slot.total, 7);

  timeline.cleanup();
});

// ─── flush gate: any content frame closes the streaming segment ──────────────

test('a content frame finalizes the buffered text segment before entering the store', async () => {
  const timeline = mountTimeline();

  // First segment streams, then the model switches to a tool call.
  timeline.emit({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'Hello ' } as unknown as ServerEvent);
  await tickThrottle();
  timeline.emit({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'there' } as unknown as ServerEvent);

  timeline.emit({
    kind: 'tool_use',
    id: 'rt-tool-1',
    sessionId: SESSION_ID,
    toolId: 'tool-1',
    toolName: 'Bash',
    input: {},
    timestamp: new Date(BASE_TIME + 50_000).toISOString(),
  } as unknown as ServerEvent);

  const rowsAfterTool = timeline.sessionStore.getMessages(SESSION_ID);
  const textRow = rowsAfterTool.find((row) => row.kind === 'text' && row.content === 'Hello there');
  const toolRow = rowsAfterTool.find((row) => row.kind === 'tool_use');
  assert.ok(textRow, 'the buffered text must finalize as its own row when a content frame arrives');
  assert.match(textRow!.id, /^text_/, 'the finalized row must carry the text_ id prefix');
  assert.ok(toolRow, 'the tool frame must enter the store');
  assert.ok(
    rowsAfterTool.indexOf(textRow!) < rowsAfterTool.indexOf(toolRow!),
    'the finalized text must sort ahead of the tool call that followed it',
  );

  // A later segment must open a NEW streaming row instead of joining the
  // finalized one (the zcode engine emits no text-boundary events).
  timeline.emit({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'World' } as unknown as ServerEvent);
  await tickThrottle();

  const rowsAfterSecondSegment = timeline.sessionStore.getMessages(SESSION_ID);
  const streamingRow = rowsAfterSecondSegment.find((row) => row.id === `__streaming_${SESSION_ID}`);
  assert.ok(streamingRow, 'the second segment must stream into its own row');
  assert.equal(streamingRow!.content, 'World');
  assert.equal(
    rowsAfterSecondSegment.filter((row) => row.content === 'Hello there').length,
    1,
    'the finalized first segment must stay untouched',
  );

  timeline.cleanup();
});

// ─── streaming row: anchored timestamp, in-place finalize ────────────────────

test('a streaming row anchors its timestamp at segment start and finalizes in place', async () => {
  const timeline = mountTimeline();

  timeline.emit({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'Hel' } as unknown as ServerEvent);
  await tickThrottle();
  let streaming = timeline.sessionStore.getMessages(SESSION_ID).find((row) => row.id === `__streaming_${SESSION_ID}`);
  assert.ok(streaming, 'the throttled update must create the streaming row');
  assert.equal(streaming!.content, 'Hel');
  const anchoredTimestamp = streaming!.timestamp;

  timeline.emit({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'lo' } as unknown as ServerEvent);
  await tickThrottle();
  streaming = timeline.sessionStore.getMessages(SESSION_ID).find((row) => row.id === `__streaming_${SESSION_ID}`);
  assert.equal(streaming!.content, 'Hello');
  assert.equal(
    streaming!.timestamp,
    anchoredTimestamp,
    'later deltas must never refresh the row timestamp (finalized text would drift below the turn\'s tool calls)',
  );

  const realtimeCountBefore = timeline.sessionStore.getSessionSlot(SESSION_ID)!.realtimeMessages.length;
  timeline.emit({ kind: 'stream_end', sessionId: SESSION_ID } as unknown as ServerEvent);

  const finalized = timeline.sessionStore.getMessages(SESSION_ID).find((row) => row.content === 'Hello');
  assert.ok(finalized, 'stream_end must finalize the buffered text');
  assert.match(finalized!.id, /^text_/);
  assert.equal(finalized!.timestamp, anchoredTimestamp, 'finalization must keep the anchored timestamp');
  assert.equal(
    timeline.sessionStore.getSessionSlot(SESSION_ID)!.realtimeMessages.length,
    realtimeCountBefore,
    'finalization replaces the streaming row in place — no extra row may appear',
  );
  assert.equal(timeline.accumulatedStreamsRef.current.size, 0, 'the buffer must be drained');

  timeline.cleanup();
});

// ─── merged view: the three realtime-echo absorptions ────────────────────────

test('optimistic user, thinking, and same-turn assistant echoes are absorbed into the merged view', async () => {
  stubHistoryFetch([
    {
      params: { limit: '20', offset: '0' },
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
  const timeline = mountTimeline();

  await act(async () => {
    await timeline.sessionStore.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  });

  const at = (n: number) => new Date(BASE_TIME + n * 1000).toISOString();
  // Realtime echoes: the optimistic user row (pre-send), the thinking block,
  // and the streamed assistant text that the server already persisted.
  timeline.emit(
    msg(1, { id: 'local_user_echo', content: 'what is the answer?', timestamp: at(1) }) as unknown as ServerEvent
  );
  timeline.emit({
    kind: 'thinking',
    sessionId: SESSION_ID,
    id: 'rt_thinking_echo',
    content: 'pondering the question carefully',
    timestamp: at(2),
  } as unknown as ServerEvent);
  timeline.emit({
    kind: 'text',
    sessionId: SESSION_ID,
    id: 'text_streamed_echo',
    role: 'assistant',
    content: 'here is a thorough answer spanning plenty of words to be matchable',
    timestamp: at(4),
  } as unknown as ServerEvent);

  const merged = timeline.sessionStore.getMessages(SESSION_ID);
  assert.deepEqual(
    merged.map((row) => row.id),
    ['m1', 'm2', 'm4'],
    'the three realtime echoes must be absorbed, leaving only the persisted rows',
  );

  timeline.cleanup();
});

// ─── replay progress: seq recording ──────────────────────────────────────────

test('every sequenced frame advances the per-session resume seq, sessionless frames count toward the viewed session', () => {
  const timeline = mountTimeline();

  timeline.emit({ kind: 'status', sessionId: SESSION_ID, text: 'working', seq: 3 } as unknown as ServerEvent);
  timeline.emit({ kind: 'status', sessionId: SESSION_ID, text: 'working', seq: 7 } as unknown as ServerEvent);
  timeline.emit({ kind: 'status', sessionId: SESSION_ID, text: 'working', seq: 5 } as unknown as ServerEvent);
  assert.equal(timeline.lastSeqRef.current.get(SESSION_ID), 7, 'the resume seq must be the max observed');

  // A frame without its own sessionId attributes to the viewed session.
  timeline.emit({ kind: 'status', text: 'working', seq: 9 } as unknown as ServerEvent);
  assert.equal(timeline.lastSeqRef.current.get(SESSION_ID), 9);

  // Unsequenced frames never touch it.
  timeline.emit({ kind: 'status', sessionId: SESSION_ID, text: 'working' } as unknown as ServerEvent);
  assert.equal(timeline.lastSeqRef.current.get(SESSION_ID), 9);

  timeline.cleanup();
});

// ─── complete: flush first, tail refresh only for the viewed session ─────────

test('complete flushes the stream and requests the persisted tail only for the viewed session', async () => {
  stubHistoryFetch([
    { params: { limit: '20', offset: '0' }, page: { messages: [msg(1)], total: 1, hasMore: false } },
  ]);
  const timeline = mountTimeline();

  await act(async () => {
    await timeline.sessionStore.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  });

  timeline.emit({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'partial' } as unknown as ServerEvent);
  await tickThrottle();
  timeline.emit({ kind: 'complete', sessionId: SESSION_ID, success: true } as unknown as ServerEvent);

  // complete must flush the buffered text into a finalized row before the
  // run's idle handling, and trigger the persisted-tail sync for the viewed
  // session.
  assert.ok(
    timeline.sessionStore.getMessages(SESSION_ID).some((row) => row.kind === 'text' && row.content === 'partial'),
    'complete must finalize the buffered stream text',
  );
  assert.equal(timeline.accumulatedStreamsRef.current.size, 0);
  assert.equal(timeline.requestLatestMessages.mock.calls.length, 1);
  assert.deepEqual(timeline.requestLatestMessages.mock.calls[0], [SESSION_ID, true]);

  // A background session completing must not trigger a tail refresh.
  timeline.emit({ kind: 'complete', sessionId: 'sess-background', success: true } as unknown as ServerEvent);
  assert.equal(timeline.requestLatestMessages.mock.calls.length, 1);
  assert.equal(timeline.onSessionIdle.mock.calls.filter(([sid]) => sid === 'sess-background').length, 1,
    'the background session still reports idle');

  timeline.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});
