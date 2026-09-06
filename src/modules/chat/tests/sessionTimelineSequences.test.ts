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
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';

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
  requestLatestMessages: ReturnType<typeof vi.fn>;
  onSessionIdle: ReturnType<typeof vi.fn>;
  onSessionProcessing: ReturnType<typeof vi.fn>;
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
    sessionStore.resetStreamingState();
    handlersRoot.unmount();
    storeRoot.unmount();
  };

  return { sessionStore, requestLatestMessages, onSessionIdle, onSessionProcessing, emit, cleanup };
}

/** Lets the 100ms stream throttle fire exactly once and apply the row. */
const tickThrottle = () => new Promise((resolve) => setTimeout(resolve, 130));

// ─── prune before the content-level bail-out ─────────────────────────────────

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

test('every sequenced frame advances the per-session resume seq, sessionless frames count toward the viewed session', () => {
  const timeline = mountTimeline();

  timeline.emit({ kind: 'status', sessionId: SESSION_ID, text: 'working', seq: 3 } as unknown as ServerEvent);
  timeline.emit({ kind: 'status', sessionId: SESSION_ID, text: 'working', seq: 7 } as unknown as ServerEvent);
  timeline.emit({ kind: 'status', sessionId: SESSION_ID, text: 'working', seq: 5 } as unknown as ServerEvent);
  assert.equal(timeline.sessionStore.getResumeSeq(SESSION_ID), 7, 'the resume seq must be the max observed');

  // A frame without its own sessionId attributes to the viewed session.
  timeline.emit({ kind: 'status', text: 'working', seq: 9 } as unknown as ServerEvent);
  assert.equal(timeline.sessionStore.getResumeSeq(SESSION_ID), 9);

  // Unsequenced frames never touch it.
  timeline.emit({ kind: 'status', sessionId: SESSION_ID, text: 'working' } as unknown as ServerEvent);
  assert.equal(timeline.sessionStore.getResumeSeq(SESSION_ID), 9);

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
  // Buffer drained, proven behaviorally: a later segment starts fresh.
  timeline.emit({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'Next' } as unknown as ServerEvent);
  await tickThrottle();
  const nextSegment = timeline.sessionStore.getMessages(SESSION_ID).find((row) => row.id === `__streaming_${SESSION_ID}`);
  assert.ok(nextSegment);
  assert.equal(nextSegment!.content, 'Next');
  assert.equal(timeline.requestLatestMessages.mock.calls.length, 1);
  assert.deepEqual(timeline.requestLatestMessages.mock.calls[0], [SESSION_ID, true]);

  // A background session completing must not trigger a tail refresh.
  timeline.emit({ kind: 'complete', sessionId: 'sess-background', success: true } as unknown as ServerEvent);
  assert.equal(timeline.requestLatestMessages.mock.calls.length, 1);
  assert.equal(timeline.onSessionIdle.mock.calls.filter(([sid]) => sid === 'sess-background').length, 1,
    'the background session still reports idle');

  timeline.cleanup();
});

// ─── suspension return: a pruned streaming row must not revive ───────────────

test('returning from a suspension must not revive pruned stream text as a duplicate bubble', async () => {
  // The production shape of the "two identical replies after leaving the PWA
  // mid-stream" bug: a long agent turn pushed the current user row past the
  // 20-row tail page, so the return refresh lands a server view whose only
  // user rows belong to OLDER turns, while the raw local user echo survives
  // (the server row it could reconcile with was never fetched). In that shape
  // the echo matcher misses, the pruned streaming row revives from the stale
  // delta buffer, and the revived bubble renders next to its transcript copy.
  const now = Date.now();
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
  const transcriptPage = {
    messages: [
      msg(1, { content: 'earlier question', timestamp: at(60) }),
      msg(2, { content: 'older answer', timestamp: at(59) }),
      msg(4, { content: 'Segment one.', timestamp: at(30) }),
      msg(6, { content: 'Segment two.', timestamp: at(20) }),
    ],
    total: 4,
    hasMore: false,
  };
  stubHistoryFetch([
    { params: { limit: '20', offset: '0' }, page: transcriptPage },
    { params: { limit: '20', offset: '0' }, page: transcriptPage },
  ]);
  const timeline = mountTimeline();

  // The question's local echo (its server row is beyond the tail page) and the
  // first segment streaming in.
  timeline.emit({
    kind: 'text',
    id: 'local_question',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'analyze codegraph',
    timestamp: at(45),
  } as unknown as ServerEvent);
  timeline.emit({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'Segment one.' } as unknown as ServerEvent);
  await tickThrottle();
  assert.ok(
    timeline.sessionStore.getMessages(SESSION_ID).some((row) => row.id === `__streaming_${SESSION_ID}`),
    'precondition: the segment is on screen as the streaming row',
  );

  // The user leaves; on return the reconnect refresh lands the tail page
  // without the current turn's user row.
  await act(async () => {
    await timeline.sessionStore.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  });

  // Replayed deltas for the missed segment arrive on top of the stale buffer,
  // then the replayed stream_end flushes and finalizes whatever accumulated.
  timeline.emit({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'Segment two.' } as unknown as ServerEvent);
  await tickThrottle();
  timeline.emit({ kind: 'stream_end', sessionId: SESSION_ID } as unknown as ServerEvent);

  const renderedTexts = () => timeline.sessionStore.getMessages(SESSION_ID)
    .filter((row) => row.kind === 'text' && row.role === 'assistant')
    .map((row) => row.content ?? '');
  assert.equal(
    renderedTexts().filter((content) => content.includes('Segment one.')).length,
    1,
    `'Segment one.' must render exactly once after the return, got: ${JSON.stringify(renderedTexts())}`,
  );

  // The complete-driven tail refresh must converge to one row per segment.
  await act(async () => {
    await timeline.sessionStore.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  });
  assert.deepEqual(
    renderedTexts().filter((content) => content.includes('Segment')),
    ['Segment one.', 'Segment two.'],
  );

  timeline.cleanup();
});

// ─── complete: settle unmatched tool cards ───────────────────────────────────

test('complete settles a tool card whose result frame never arrived', () => {
  const timeline = mountTimeline();

  timeline.emit({
    kind: 'tool_use',
    id: 'rt-tool-lost',
    sessionId: SESSION_ID,
    toolId: 'tool-lost',
    toolName: 'Skill',
    input: { skill: 'frontend-module-standards' },
  } as unknown as ServerEvent);
  timeline.emit({ kind: 'complete', sessionId: SESSION_ID, success: true } as unknown as ServerEvent);

  const rows = timeline.sessionStore.getMessages(SESSION_ID);
  const synthetic = rows.find((row) => row.id === '__finalized_tool-lost');
  assert.ok(synthetic, 'the unpaired card must get a synthetic result row');
  assert.equal(synthetic!.kind, 'tool_result');
  assert.equal(synthetic!.toolId, 'tool-lost');
  assert.equal(synthetic!.toolResult?.isError, false);

  // The card itself must now render as completed: the synthetic row attaches
  // to the tool_use row exactly like a real result would.
  const attached = normalizedToChatMessages(rows).find((row) => row.id === 'rt-tool-lost');
  assert.equal(attached!.toolResult?.isError, false, 'the card must no longer derive "running"');

  timeline.cleanup();
});

test('a genuine result frame arriving after the settle wins over the synthetic row', () => {
  const timeline = mountTimeline();

  timeline.emit({
    kind: 'tool_use',
    id: 'rt-tool-late',
    sessionId: SESSION_ID,
    toolId: 'tool-late',
    toolName: 'Bash',
    input: { command: 'ls' },
  } as unknown as ServerEvent);
  timeline.emit({ kind: 'complete', sessionId: SESSION_ID, success: true } as unknown as ServerEvent);
  timeline.emit({
    kind: 'tool_result',
    id: 'rt-result-late',
    sessionId: SESSION_ID,
    toolId: 'tool-late',
    content: 'real output',
    toolResult: { content: 'real output', isError: false },
  } as unknown as ServerEvent);

  const rows = timeline.sessionStore.getMessages(SESSION_ID);
  const attached = normalizedToChatMessages(rows).find((row) => row.id === 'rt-tool-late');
  assert.equal(attached!.toolResult?.content, 'real output', 'the real result must win last-write-wins');

  timeline.cleanup();
});

test('complete is idempotent for cards that already have their result', () => {
  const timeline = mountTimeline();

  timeline.emit({
    kind: 'tool_use',
    id: 'rt-tool-paired',
    sessionId: SESSION_ID,
    toolId: 'tool-paired',
    toolName: 'Bash',
    input: { command: 'ls' },
  } as unknown as ServerEvent);
  timeline.emit({
    kind: 'tool_result',
    id: 'rt-result-paired',
    sessionId: SESSION_ID,
    toolId: 'tool-paired',
    content: 'out',
    toolResult: { content: 'out', isError: false },
  } as unknown as ServerEvent);

  const before = timeline.sessionStore.getMessages(SESSION_ID).length;
  timeline.emit({ kind: 'complete', sessionId: SESSION_ID, success: true } as unknown as ServerEvent);
  const after = timeline.sessionStore.getMessages(SESSION_ID).length;

  assert.equal(after, before, 'a paired card must not gain a synthetic row');

  timeline.cleanup();
});

test('an aborted complete still settles unmatched tool cards', () => {
  const timeline = mountTimeline();

  timeline.emit({
    kind: 'tool_use',
    id: 'rt-tool-aborted',
    sessionId: SESSION_ID,
    toolId: 'tool-aborted',
    toolName: 'Bash',
    input: { command: 'sleep 999' },
  } as unknown as ServerEvent);
  timeline.emit({ kind: 'complete', sessionId: SESSION_ID, success: false, aborted: true } as unknown as ServerEvent);

  const synthetic = timeline.sessionStore.getMessages(SESSION_ID).find((row) => row.id === '__finalized_tool-aborted');
  assert.ok(synthetic, 'an aborted run must still settle its in-flight cards');

  timeline.cleanup();
});

// ─── tool identity: live id ≠ persisted id ───────────────────────────────────

test('a refresh whose persisted card carries a different toolId replaces the shadow card', async () => {
  // zcode-style split: the live card holds the engine payload's toolCallId,
  // the persisted transcript keys the same call by its part id. Before the
  // identity matcher this refresh produced two Write cards, one of them
  // "running" forever.
  stubHistoryFetch([
    {
      params: { limit: '20', offset: '0' },
      page: {
        messages: [
          msg(1),
          msg(2, {
            kind: 'tool_use',
            role: 'assistant',
            toolId: 'msg_1_part_2',
            toolName: 'Write',
            toolInput: { file_path: '/a.ts', content: 'hello' },
          }),
          msg(3, {
            kind: 'tool_result',
            role: 'assistant',
            content: 'real output',
            toolId: 'msg_1_part_2',
            toolResult: { content: 'real output', isError: false },
          }),
        ],
        total: 3,
        hasMore: false,
      },
    },
  ]);
  const timeline = mountTimeline();

  timeline.emit({
    kind: 'tool_use',
    id: 'rt-tool-shadow',
    sessionId: SESSION_ID,
    toolId: 'live_zcode_1',
    toolName: 'Write',
    toolInput: { file_path: '/a.ts', content: 'hello' },
  } as unknown as ServerEvent);

  await act(async () => {
    await timeline.sessionStore.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  });

  const rows = timeline.sessionStore.getMessages(SESSION_ID);
  const toolCards = rows.filter((row) => row.kind === 'tool_use');
  assert.equal(toolCards.length, 1, 'the same logical call must render exactly one card');
  assert.equal(toolCards[0]?.toolId, 'msg_1_part_2', 'the persisted card is the survivor');
  assert.ok(!rows.some((row) => row.id === 'rt-tool-shadow'));
  assert.ok(!rows.some((row) => row.id.startsWith('__finalized_')), 'no synthetic may linger');
  const attached = normalizedToChatMessages(rows).find((row) => row.toolId === 'msg_1_part_2');
  assert.equal(attached!.toolResult?.content, 'real output', 'the real result attaches to the survivor');

  timeline.cleanup();
});

test('complete + finalize before the refresh still converges to one card', async () => {
  stubHistoryFetch([
    {
      params: { limit: '20', offset: '0' },
      page: {
        messages: [
          msg(2, {
            kind: 'tool_use',
            role: 'assistant',
            toolId: 'msg_1_part_2',
            toolName: 'Write',
            toolInput: { file_path: '/a.ts', content: 'hello' },
          }),
          msg(3, {
            kind: 'tool_result',
            role: 'assistant',
            toolId: 'msg_1_part_2',
            toolResult: { content: 'real output', isError: false },
          }),
        ],
        total: 2,
        hasMore: false,
      },
    },
  ]);
  const timeline = mountTimeline();

  timeline.emit({
    kind: 'tool_use',
    id: 'rt-tool-shadow',
    sessionId: SESSION_ID,
    toolId: 'live_zcode_1',
    toolName: 'Write',
    toolInput: { file_path: '/a.ts', content: 'hello' },
  } as unknown as ServerEvent);
  timeline.emit({ kind: 'complete', sessionId: SESSION_ID, success: true } as unknown as ServerEvent);
  assert.ok(
    timeline.sessionStore.getMessages(SESSION_ID).some((row) => row.id === '__finalized_live_zcode_1'),
    'the synthetic settles the card before the transcript catches up',
  );

  await act(async () => {
    await timeline.sessionStore.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  });

  const rows = timeline.sessionStore.getMessages(SESSION_ID);
  assert.equal(rows.filter((row) => row.kind === 'tool_use').length, 1);
  assert.ok(!rows.some((row) => row.id.startsWith('__finalized_')));

  timeline.cleanup();
});

test('control frames surface as side effects without touching the timeline', () => {
  const timeline = mountTimeline();

  timeline.emit({ kind: 'status', sessionId: SESSION_ID, text: 'Reading files', canInterrupt: true } as unknown as ServerEvent);
  timeline.emit({
    kind: 'permission_request',
    sessionId: SESSION_ID,
    requestId: 'req-1',
    toolName: 'Bash',
    input: { command: 'ls' },
  } as unknown as ServerEvent);
  timeline.emit({ kind: 'permission_cancelled', sessionId: SESSION_ID, requestId: 'req-1' } as unknown as ServerEvent);
  timeline.emit({ kind: 'protocol_error', sessionId: SESSION_ID, code: -32000, error: 'rejected' } as unknown as ServerEvent);

  // Only the protocol error enters the timeline (as an error row); status and
  // permission frames are pure side effects.
  const rows = timeline.sessionStore.getMessages(SESSION_ID);
  assert.deepEqual(rows.map((row) => row.kind), ['error']);
  assert.deepEqual(
    timeline.onSessionProcessing.mock.calls.map((call) => call[0]),
    [SESSION_ID, SESSION_ID],
    'status and the permission request both mark the session processing',
  );
  assert.deepEqual(timeline.onSessionIdle.mock.calls.map((call) => call[0]), [SESSION_ID]);

  // The subscribe ack merges the authoritative watermark and, when the replay
  // cursor predates the buffer, owes the app a REST refresh.
  timeline.emit({
    kind: 'chat_subscribed',
    sessionId: SESSION_ID,
    isProcessing: false,
    stale: true,
    lastSeq: 9,
    pendingPermissions: [],
  } as unknown as ServerEvent);
  assert.equal(timeline.sessionStore.getResumeSeq(SESSION_ID), 9, 'the ack watermark merges');
  assert.equal(timeline.requestLatestMessages.mock.calls.at(-1)?.[0], SESSION_ID, 'stale owes a refresh');

  timeline.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});
