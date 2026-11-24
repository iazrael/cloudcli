import assert from 'node:assert/strict';

import { afterEach, test } from 'vitest';

import { SessionTimelineStore } from '@/modules/chat/utils/sessionTimelineStore';
import type { NormalizedMessage, ServerEvent } from '@/shared/types';

const stores: SessionTimelineStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.resetStreamingState(); });

function createStore() {
  const store = new SessionTimelineStore();
  store.setActiveSession('session');
  stores.push(store);
  return store;
}

function event(seq: number, kind: string, extra: Record<string, unknown> = {}): ServerEvent {
  return { id: `event-${seq}`, sessionId: 'session', timestamp: '2026-10-20T00:00:00Z',
    provider: 'codex', kind, seq, streamEpoch: 'gateway-a', ...extra } as ServerEvent;
}

function ack(lastSeq: number, extra: Record<string, unknown> = {}): ServerEvent {
  return { kind: 'chat_subscribed', sessionId: 'session', streamEpoch: 'gateway-a',
    lastSeq, replayFromSeq: 1, stale: false, isProcessing: true, pendingPermissions: [],
    timestamp: '2026-10-20T00:00:00Z', ...extra } as ServerEvent;
}

test('replaying an already displayed reply cannot leave a second tail placeholder', () => {
  const store = createStore();
  store.applyServerEvent(ack(0));
  const frames = [event(1, 'stream_delta', { content: 'First part. ' }),
    event(2, 'stream_delta', { content: 'Last part.' }),
    event(3, 'text', { id: 'engine-reply', role: 'assistant', content: 'First part. Last part.' })];
  for (const frame of frames) store.applyServerEvent(frame);
  store.applyServerEvent(ack(3));
  for (const frame of frames) store.applyServerEvent(frame);
  store.applyServerEvent(event(4, 'complete', { success: true }));
  const rows = store.getSessionSlot('session')!.merged;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'engine-reply');
  assert.equal(rows[0].content, 'First part. Last part.');
});

test('ack watermark cannot swallow unapplied replay and complete has one effect', () => {
  const store = createStore();
  store.applyServerEvent(ack(3));
  assert.equal(store.getResumeSeq('session'), 0);
  store.applyServerEvent(event(1, 'text', { role: 'assistant', content: 'reply' }));
  const complete = event(2, 'complete', { success: true });
  assert.equal(store.applyServerEvent(complete)?.effect, 'complete');
  assert.equal(store.applyServerEvent(complete), null);
  assert.equal(store.getResumeSeq('session'), 2);
});

test('a gap buffers later state and drains state and effects one event at a time', () => {
  const store = createStore();
  const effects: string[] = [];
  const options = { onDirective: (directive: { effect: string }) => {
    if (directive.effect === 'complete') effects.push(store.hasPendingBackgroundWork('session') ? 'busy' : 'idle');
  } };
  store.applyServerEvent(ack(0), options);
  store.applyServerEvent(event(3, 'status', { text: 'background_tasks', backgroundTasks: [{ taskId: 'task', label: 'worker' }], backgroundWorkPending: true }), options);
  store.applyServerEvent(event(2, 'complete', { success: true }), options);
  assert.equal(store.getResumeSeq('session'), 0);
  store.applyServerEvent(event(1, 'text', { role: 'assistant', content: 'first' }), options);
  assert.deepEqual(effects, ['idle']);
  assert.equal(store.hasPendingBackgroundWork('session'), true);
  assert.equal(store.getResumeSeq('session'), 3);
});

test('pre-ack frames wait for identity, and a restarted gateway accepts low sequence numbers', () => {
  const store = createStore();
  store.applyServerEvent(event(1, 'text', { role: 'assistant', content: 'old reply' }));
  assert.equal(store.getSessionSlot('session')?.merged.length ?? 0, 0);
  store.applyServerEvent(ack(1));
  assert.equal(store.getResumeSeq('session'), 1);
  store.beginConnection();
  store.applyServerEvent(event(1, 'text', { streamEpoch: 'gateway-b', role: 'assistant', content: 'new reply' }));
  const directive = store.applyServerEvent(ack(0, { streamEpoch: 'gateway-b' }));
  assert.equal(directive?.effect, 'chat_subscribed');
  assert.equal(store.getResumeSeq('session'), 0);
  assert.equal(store.getStreamEpoch('session'), 'gateway-b');
});

test('different events sharing a tool row update it and real repeated text is retained', () => {
  const store = createStore();
  store.applyServerEvent(ack(0));
  store.applyServerEvent(event(1, 'tool_use', { id: 'tool', toolId: 'tool', toolName: 'Bash', toolInput: { command: 'p' } }));
  store.applyServerEvent(event(2, 'tool_use', { id: 'tool', toolId: 'tool', toolName: 'Bash', toolInput: { command: 'pwd' } }));
  store.applyServerEvent(event(3, 'text', { role: 'assistant', content: 'same' }));
  store.applyServerEvent(event(4, 'text', { role: 'assistant', content: 'same' }));
  const rows = store.getSessionSlot('session')!.merged;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].toolInput, { command: 'pwd' });
});

test('observer failure after a text commit does not replay the committed state', () => {
  let fail = true;
  const store = new SessionTimelineStore({ notify: () => { if (fail) { fail = false; throw new Error('notification failed'); } } });
  stores.push(store);
  store.setActiveSession('session');
  store.applyServerEvent(ack(0));
  const frame = event(1, 'text', { role: 'assistant', content: 'reply' });
  assert.throws(() => store.applyServerEvent(frame), /notification failed/);
  assert.equal(store.getResumeSeq('session'), 1);
  store.applyServerEvent(frame);
  assert.equal(store.getResumeSeq('session'), 1);
  assert.equal(store.getSessionSlot('session')!.merged.length, 1);
});

test('an unreplayable gap keeps visible output and only advances after a successful history recovery', async () => {
  let fail = true;
  const store = new SessionTimelineStore({ fetchPage: async () => {
    if (fail) throw new Error('history offline');
    return { messages: [], total: 0, hasMore: false };
  } });
  stores.push(store);
  store.applyServerEvent(ack(0));
  store.applyServerEvent(event(1, 'stream_delta', { content: 'output not persisted by the engine' }));
  const directives: Array<{ effect: string; recoveryId?: number }> = [];
  const options = { onDirective: (directive: { effect: string; recoveryId?: number }) => directives.push(directive) };
  store.applyServerEvent(ack(5, { replayFromSeq: 6, stale: true }), options);
  const recoveryId = directives.find(d => d.effect === 'recover_stream')!.recoveryId!;
  store.applyServerEvent(event(6, 'text', { role: 'assistant', content: 'later reply' }), options);
  await assert.rejects(store.recoverEventStream('session', recoveryId, options), /History recovery failed/);
  assert.equal(store.getResumeSeq('session'), 1);
  fail = false;
  await store.recoverEventStream('session', recoveryId, options);
  assert.equal(store.getResumeSeq('session'), 6);
  assert.deepEqual(store.getSessionSlot('session')!.merged.map(row => row.content), ['output not persisted by the engine', 'later reply']);
  store.applyServerEvent(event(2, 'stream_delta', { content: 'old replay' }), options);
  assert.equal(store.getSessionSlot('session')!.merged.length, 2);
});

test('oversized pending events require a new recovery baseline rather than bypassing the buffer budget', () => {
  const store = createStore();
  store.applyServerEvent(ack(0));
  const directive = store.applyServerEvent(event(2, 'stream_delta', { content: 'x'.repeat(1024 * 1024 + 1) }));
  assert.equal(directive?.effect, 'replay_request');
  assert.equal(store.getResumeSeq('session'), 0);
  const effects: string[] = [];
  store.applyServerEvent(ack(2), { onDirective: directive => effects.push(directive.effect) });
  assert.deepEqual(effects, ['chat_subscribed', 'recover_stream']);
});

for (const invalid of [
  { seq: 0 }, { seq: -1 }, { seq: 1.5 }, { seq: Number.NaN }, { seq: '1' },
  { seq: undefined }, { streamEpoch: '' }, { streamEpoch: 7 },
]) {
  test(`invalid replay identity is reported: ${JSON.stringify(invalid)}`, () => {
    const store = createStore();
    store.applyServerEvent(ack(0));
    assert.throws(() => store.applyServerEvent(event(1, 'text', invalid)), /invalid event replay identity/);
    assert.equal(store.getResumeSeq('session'), 0);
  });
}

test('an epoch mismatch on the current connection cannot switch the session back', () => {
  const store = createStore();
  store.applyServerEvent(ack(0));
  assert.throws(() => store.applyServerEvent(event(1, 'text', { streamEpoch: 'obsolete' })), /epoch does not match/);
  assert.throws(() => store.applyServerEvent(ack(0, { streamEpoch: 'obsolete' })), /epoch changed/);
  assert.equal(store.getStreamEpoch('session'), 'gateway-a');
});

test('legacy connections retain their old behavior and do not seed new-protocol progress', () => {
  const store = createStore();
  const legacyAck = { ...ack(8) } as unknown as Record<string, unknown>;
  delete legacyAck.streamEpoch;
  delete legacyAck.replayFromSeq;
  store.applyServerEvent(legacyAck as ServerEvent);
  assert.equal(store.getResumeSeq('session'), 8);
  store.beginConnection();
  store.applyServerEvent(ack(3));
  assert.equal(store.getResumeSeq('session'), 0);
  store.applyServerEvent(event(1, 'thinking', { content: 'thought' }));
  store.applyServerEvent(event(1, 'thinking', { content: 'thought' }));
  assert.equal(store.getSessionSlot('session')!.merged[0].content, 'thought');
});

for (const interruption of ['reconnect', 'overflow']) {
test(`${interruption} invalidates an in-flight recovery and its fresh ack starts a new recovery`, async () => {
  let resolveHistory!: (page: { messages: []; total: number; hasMore: boolean }) => void;
  const store = new SessionTimelineStore({ fetchPage: () => new Promise(resolve => { resolveHistory = resolve; }) });
  stores.push(store);
  const effects: Array<{ effect: string; recoveryId?: number }> = [];
  const options = { onDirective: (directive: { effect: string; recoveryId?: number }) => effects.push(directive) };
  store.applyServerEvent(ack(0), options);
  store.applyServerEvent(ack(5, { stale: true, replayFromSeq: 6 }), options);
  const firstId = effects.find(d => d.effect === 'recover_stream')!.recoveryId!;
  const firstRecovery = store.recoverEventStream('session', firstId, options);
  await Promise.resolve();
  if (interruption === 'reconnect') store.beginConnection();
  else store.applyServerEvent(event(6, 'stream_delta', { content: 'x'.repeat(1024 * 1024 + 1) }), options);
  resolveHistory({ messages: [], total: 0, hasMore: false });
  await firstRecovery;
  store.applyServerEvent(ack(5), options);
  const recoveries = effects.filter(d => d.effect === 'recover_stream');
  assert.equal(recoveries.length, 2);
  assert.notEqual(recoveries[1].recoveryId, firstId);
});
}

test('a notification failure after committing thinking cannot apply that increment twice', () => {
  let fail = true;
  const store = new SessionTimelineStore({ notify: () => { if (fail) { fail = false; throw new Error('observer failed'); } } });
  stores.push(store);
  store.setActiveSession('session');
  store.applyServerEvent(ack(0));
  const frame = event(1, 'thinking', { content: 'reason' });
  assert.throws(() => store.applyServerEvent(frame), /observer failed/);
  assert.equal(store.getResumeSeq('session'), 1);
  store.applyServerEvent(frame);
  assert.equal(store.getMessages('session')[0].content, 'reason');
});

test('an in-order event larger than the replay budget is still displayed immediately', () => {
  const store = createStore();
  store.applyServerEvent(ack(0));
  const content = 'x'.repeat(1024 * 1024 + 1);
  store.applyServerEvent(event(1, 'text', { role: 'assistant', content }));
  assert.equal(store.getResumeSeq('session'), 1);
  assert.equal(store.getMessages('session')[0]?.content, content);
});

for (const provider of ['claude', 'codex', 'cursor', 'opencode', 'zcode', 'antigravity']) {
  test(`${provider}: repeated events do not repeat thinking, tool results or completion effects`, () => {
    const store = createStore();
    store.applyServerEvent(ack(0));
    const frames = [event(1, 'thinking', { provider, content: 'reason' }),
      event(2, 'tool_use', { provider, toolId: 'call', toolName: 'Bash', toolInput: { command: 'pwd' } }),
      event(3, 'tool_result', { provider, toolId: 'call', content: '/workspace' }),
      event(4, 'complete', { provider, success: true })];
    const effects: string[] = [];
    const options = { onDirective: (directive: { effect: string }) => effects.push(directive.effect) };
    for (const frame of frames) store.applyServerEvent(frame, options);
    for (const frame of frames) store.applyServerEvent(frame, options);
    assert.deepEqual(effects, ['complete']);
    assert.equal(store.getMessages('session').find(row => row.kind === 'thinking')?.content, 'reason');
    assert.equal(store.getMessages('session').filter(row => row.kind === 'tool_use').length, 1);
    assert.equal(store.getMessages('session').filter(row => row.kind === 'tool_result').length, 1);
  });
}

test('interleaved sessions keep independent gaps and replay cursors', () => {
  const store = createStore();
  store.applyServerEvent(ack(0));
  store.applyServerEvent(ack(0, { sessionId: 'other-session' }));
  store.applyServerEvent(event(2, 'text', { sessionId: 'other-session', content: 'later' }));
  store.applyServerEvent(event(1, 'text', { content: 'first session' }));
  assert.equal(store.getResumeSeq('session'), 1);
  assert.equal(store.getResumeSeq('other-session'), 0);
  store.applyServerEvent(event(1, 'text', { sessionId: 'other-session', content: 'earlier' }));
  assert.equal(store.getResumeSeq('other-session'), 2);
});

test('an observer error cannot strand a contiguous backlog or its completion effect', () => {
  let fail = true;
  const store = new SessionTimelineStore({ notify: () => { if (fail) { fail = false; throw new Error('observer failed'); } } });
  stores.push(store);
  store.setActiveSession('session');
  store.applyServerEvent(ack(3));
  const effects: string[] = [];
  const options = { onDirective: (directive: { effect: string }) => effects.push(directive.effect) };
  store.applyServerEvent(event(3, 'complete', { success: true }), options);
  store.applyServerEvent(event(2, 'thinking', { id: 'reason', content: 'second' }), options);
  const first = event(1, 'thinking', { id: 'reason', content: 'first' });
  assert.throws(() => store.applyServerEvent(first, options), /observer failed/);
  assert.equal(store.getResumeSeq('session'), 3);
  assert.equal(store.getMessages('session')[0].content, 'firstsecond');
  assert.equal(effects.filter(effect => effect === 'complete').length, 1);
  store.applyServerEvent(first, options);
  assert.equal(store.getMessages('session')[0].content, 'firstsecond');
});

test('a state application error leaves its cursor pending until that event can be applied', () => {
  const store = createStore();
  store.applyServerEvent(ack(3));
  const effects: string[] = [];
  const options = { onDirective: (directive: { effect: string }) => effects.push(directive.effect) };
  // A row the store cannot apply is the fault injection: the transport
  // identity (seq) stays valid, but the state application fails, so the
  // contiguous cursor must not move past it. The failure is transient — the
  // same seq applies once it can, which is what parks the cursor at 1 and
  // lets the backlog drain afterwards.
  const originalAppend = store.appendRealtime.bind(store);
  let failNext = true;
  store.appendRealtime = (sessionId, message) => {
    if (failNext && message.content === 'second') {
      failNext = false;
      throw new Error('row could not be applied');
    }
    originalAppend(sessionId, message);
  };
  store.applyServerEvent(event(2, 'text', { role: 'assistant', content: 'second' }), options);
  store.applyServerEvent(event(3, 'complete', { success: true }), options);
  assert.throws(() => store.applyServerEvent(event(1, 'text', { role: 'assistant', content: 'first' }), options));
  assert.equal(store.getResumeSeq('session'), 1);
  assert.equal(effects.filter(effect => effect === 'complete').length, 0);
  store.applyServerEvent(event(2, 'text', { role: 'assistant', content: 'second' }), options);
  assert.equal(store.getResumeSeq('session'), 3);
  assert.equal(effects.filter(effect => effect === 'complete').length, 1);
});

test('multiple observer failures remain diagnosable after the contiguous backlog drains', () => {
  const store = new SessionTimelineStore({ notify: () => { throw new Error('observer failed'); } });
  stores.push(store);
  store.setActiveSession('session');
  store.applyServerEvent(ack(3));
  const effects: string[] = [];
  const options = { onDirective: (directive: { effect: string }) => effects.push(directive.effect) };
  store.applyServerEvent(event(3, 'complete', { success: true }), options);
  store.applyServerEvent(event(2, 'thinking', { id: 'reason', content: 'second' }), options);
  let failure: unknown;
  try { store.applyServerEvent(event(1, 'thinking', { id: 'reason', content: 'first' }), options); }
  catch (error) { failure = error; }
  assert.equal((failure as { errors: unknown[] }).errors.length, 2);
  assert.equal(store.getResumeSeq('session'), 3);
  assert.equal(effects.filter(effect => effect === 'complete').length, 1);
});

test('a fresh page starts at the active turn baseline and retains unpersisted output after recent history', async () => {
  const history = [
    { id: 'implemented', sessionId: 'session', provider: 'antigravity', kind: 'text', role: 'assistant', content: 'already implemented', timestamp: '2026-11-16T10:00:00Z' },
    { id: 'latest-prompt', sessionId: 'session', provider: 'antigravity', kind: 'text', role: 'user', content: 'generate images', timestamp: '2026-11-16T10:01:00Z' },
  ] satisfies NormalizedMessage[];
  const store = new SessionTimelineStore({ fetchPage: async () => ({ messages: history, total: 260, hasMore: true }) });
  stores.push(store);
  await store.fetchFromServer('session', { limit: 100, offset: 0 });
  const effects: string[] = [];
  store.applyServerEvent(ack(12, { replayFromSeq: 11, replayAfterSeq: 10 }), { onDirective: (d) => effects.push(d.effect) });
  store.applyServerEvent(event(11, 'stream_delta', { provider: 'antigravity', content: 'generating images' }));
  store.applyServerEvent(event(12, 'stream_end'));
  assert.equal(store.getResumeSeq('session'), 12);
  assert.ok(!effects.includes('recover_stream'), 'an intentional fresh-page baseline is not a transport gap');
  assert.deepEqual(store.getMessages('session').map((row) => row.content), ['already implemented', 'generate images', 'generating images']);
});

for (const replayAfterSeq of [-1, 1.5, '10', 13, 11]) {
  test(`invalid fresh-page baseline is rejected: ${replayAfterSeq}`, () => {
    const store = createStore();
    assert.throws(() => store.applyServerEvent(ack(12, { replayFromSeq: 11, replayAfterSeq })), /invalid subscription replay metadata/);
    assert.equal(store.getResumeSeq('session'), 0);
  });
}

test('a repeated acknowledgement cannot move an existing cursor past missing output', () => {
  const store = createStore();
  assert.equal(store.getSubscriptionCursor('session').replayScope, 'current_run');
  store.applyServerEvent(ack(1));
  store.applyServerEvent(event(1, 'text', { role: 'assistant', content: 'first' }));
  store.beginConnection();
  assert.equal(store.getSubscriptionCursor('session').replayScope, undefined);
  const effect = store.applyServerEvent(ack(12, { replayFromSeq: 11, replayAfterSeq: 10 }));
  assert.equal(store.getResumeSeq('session'), 1);
  assert.equal(effect?.effect, 'chat_subscribed');
  assert.equal(store.getMessages('session')[0].content, 'first');
});

test('a fresh-page baseline still recovers a missing portion of the active turn', () => {
  const store = createStore();
  const effects: string[] = [];
  store.applyServerEvent(ack(20, { replayFromSeq: 15, replayAfterSeq: 10 }), { onDirective: (d) => effects.push(d.effect) });
  assert.equal(store.getResumeSeq('session'), 10);
  assert.ok(effects.includes('recover_stream'));
});
