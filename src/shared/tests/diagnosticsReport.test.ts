/**
 * The report is the only artifact that can answer what the engine transcript
 * cannot: what the client sent, what came back, what it ended up holding, and
 * how the server says the run ended. These pin the parts it is useless without.
 */

import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import {
  buildDiagnosticsReport,
  registerTimelineSnapshotSource,
} from '@/shared/diagnostics/diagnosticsReport';
import {
  recordInboundFrame,
  recordOutboundFrame,
  resetRecordedFrames,
} from '@/shared/diagnostics/frameRecorder';

beforeEach(() => {
  resetRecordedFrames();
  registerTimelineSnapshotSource(null);
});

function row(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: 'row-1',
    sessionId: 'sess-a',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'codex',
    kind: 'text',
    ...overrides,
  } as NormalizedMessage;
}

test('the report pairs the frames with the rows the timeline is holding', () => {
  recordOutboundFrame({ type: 'chat.send', sessionId: 'sess-a', content: '继续' });
  recordInboundFrame({ kind: 'text', role: 'user', id: 'item-u1', sessionId: 'sess-a', content: '继续' });

  const report = buildDiagnosticsReport({
    sessionId: 'sess-a',
    rendered: [row({ id: 'local_1', role: 'user', content: '继续' }), row({ id: 'item-u1', role: 'user', content: '继续' })],
    snapshot: {
      serverMessages: [row({ id: 'item-u1', role: 'user' })],
      realtimeMessages: [row({ id: 'local_1', role: 'user' })],
      retiredOptimisticUserAnchors: [['local_1', 'item-u1']],
      provenOptimisticUserAnchors: ['local_1'],
      pendingPrompts: [['local_1', { afterRowId: null }]],
      runEnded: false,
    },
    startup: null,
    serverRuns: [],
  });

  assert.equal(report.sessionId, 'sess-a');
  assert.equal(report.frames.length, 2);
  // Two rendered rows against one send is exactly the shape of the bug this
  // report exists to identify, and the report has to make it readable.
  assert.deepEqual(report.timeline?.rendered.map((r) => r.id), ['local_1', 'item-u1']);
  assert.deepEqual(report.timeline?.server, ['item-u1']);
  assert.deepEqual(report.timeline?.realtime, ['local_1']);
  assert.deepEqual(report.timeline?.retiredOptimisticUserAnchors, [['local_1', 'item-u1']]);
  assert.deepEqual(report.timeline?.provenOptimisticUserAnchors, ['local_1']);
});

test('a report taken with no session open still carries the frames', () => {
  recordInboundFrame({ kind: 'chat_subscribed', sessionId: 'sess-a' });

  const report = buildDiagnosticsReport({
    sessionId: null,
    rendered: null,
    snapshot: null,
    startup: null,
    serverRuns: [],
  });

  assert.equal(report.timeline, null);
  assert.equal(report.frames.length, 1);
});

test('the server run log rides along so a disconnect has both sides in one file', () => {
  const report = buildDiagnosticsReport({
    sessionId: null,
    rendered: null,
    snapshot: null,
    startup: null,
    serverRuns: [{
      sessionId: 'sess-a',
      provider: 'codex',
      reason: 'client_abort',
      exitCode: 0,
      startedAtIso: '2026-09-22T04:36:04.000Z',
      endedAtIso: '2026-09-22T04:45:06.000Z',
      durationMs: 542_000,
      eventCount: 380,
      lastSeq: 380,
    }],
  });

  assert.equal(Array.isArray(report.serverRuns), true);
  assert.equal((report.serverRuns as Array<{ reason: string }>)[0].reason, 'client_abort');
});

test('an unreachable server leaves a reason instead of losing the whole report', () => {
  recordInboundFrame({ kind: 'text', sessionId: 'sess-a', content: 'recorded anyway' });

  const report = buildDiagnosticsReport({
    sessionId: null,
    rendered: null,
    snapshot: null,
    startup: null,
    serverRuns: { error: 'Failed to fetch' },
  });

  assert.deepEqual(report.serverRuns, { error: 'Failed to fetch' });
  assert.equal(report.frames.length, 1);
});

test('the report states, and keeps, its privacy guarantees', () => {
  recordInboundFrame({ kind: 'text', role: 'assistant', sessionId: 'sess-a', content: 'y'.repeat(4000) });

  const report = buildDiagnosticsReport({
    sessionId: 'sess-a',
    rendered: [row({ id: 'item-1', role: 'assistant', content: 'z'.repeat(4000) })],
    snapshot: {
      serverMessages: [],
      realtimeMessages: [],
      retiredOptimisticUserAnchors: [],
      provenOptimisticUserAnchors: [],
      pendingPrompts: [],
      runEnded: true,
    },
    startup: null,
    serverRuns: [],
  });

  assert.deepEqual(report.privacy, {
    includesChatContent: false,
    includesCredentials: false,
    resourceUrlsAreSanitized: true,
  });
  // The guarantee has to hold in the bytes, not only in the field that claims it.
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('y'.repeat(200)), false);
  assert.equal(serialized.includes('z'.repeat(200)), false);
});
