import assert from 'node:assert/strict';
import test from 'node:test';

import { getSessionReplyPreview } from '@/modules/notifications/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

type Notified = { userId: string | number | null; provider: string; sessionId: string | null; toolName?: string; requestId: string; sessionName?: string | null };

const makeWriter = (provider: 'claude' | 'zcode' | 'opencode' = 'zcode') => {
  const notified: Notified[] = [];
  const sent: string[] = [];
  const writer = new ChatSessionWriter({
    connection: { readyState: 1, send: (payload: string) => { sent.push(payload); } } as never,
    userId: 7,
    provider,
    providerSessionId: 'native-1',
    onProviderSessionId: () => {},
    // Stands in for the run registry, which stamps the app session id.
    decorateOutboundEvent: (message: NormalizedMessage) => ({ ...message, sessionId: 'app-1', seq: 1 }),
    sessionName: 'Fix the checkout',
    notifyPermissionRequest: (info) => { notified.push(info as Notified); },
  });
  return { writer, notified, sent };
};

test('any engine\'s approval card raises one push notification for the app session', () => {
  for (const provider of ['claude', 'zcode', 'opencode'] as const) {
    const { writer, notified } = makeWriter(provider);
    writer.send({ id: 'm1', kind: 'permission_request', requestId: 'per_1', toolName: 'Bash', input: {}, sessionId: 'native-1', provider, timestamp: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(notified, [{ userId: 7, provider, sessionId: 'app-1', toolName: 'Bash', requestId: 'per_1', sessionName: 'Fix the checkout' }]);
  }
});

test('other frames raise nothing', () => {
  const { writer, notified } = makeWriter();
  writer.send({ id: 'm1', kind: 'text', role: 'assistant', content: 'hi', sessionId: 'native-1', provider: 'zcode', timestamp: '2026-01-01T00:00:00.000Z' });
  writer.send({ id: 'm2', kind: 'permission_resolved', requestId: 'per_1', sessionId: 'native-1', provider: 'zcode', timestamp: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(notified, []);
});

test('a card the registry drops is not notified', () => {
  const notified: unknown[] = [];
  const writer = new ChatSessionWriter({
    connection: null, userId: 7, provider: 'zcode', providerSessionId: null, onProviderSessionId: () => {},
    decorateOutboundEvent: () => null,
    notifyPermissionRequest: (info) => { notified.push(info); },
  });
  writer.send({ id: 'm1', kind: 'permission_request', requestId: 'per_1', toolName: 'Bash', input: {}, sessionId: 's', provider: 'zcode', timestamp: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(notified, []);
});

test('a run writer remembers the last assistant text as the notification reply preview', () => {
  const notified: unknown[] = [];
  const writer = new ChatSessionWriter({
    connection: null, userId: 7, provider: 'codex', providerSessionId: null, onProviderSessionId: () => {},
    appSessionId: 'app-preview-run',
    decorateOutboundEvent: (message: NormalizedMessage) => ({ ...message, sessionId: 'app-preview-run', seq: 1 }),
    notifyPermissionRequest: (info) => { notified.push(info); },
  });

  writer.send({ id: 'm1', kind: 'text', role: 'user', content: 'user text must not become the preview', sessionId: 'n', provider: 'codex', timestamp: '2026-01-01T00:00:00.000Z' });
  writer.send({ id: 'm2', kind: 'error', content: 'an error row is not a reply either', sessionId: 'n', provider: 'codex', timestamp: '2026-01-01T00:00:00.000Z', isError: true });
  assert.equal(getSessionReplyPreview('app-preview-run'), null);

  writer.send({ id: 'm3', kind: 'text', role: 'assistant', content: '第一段回复', sessionId: 'n', provider: 'codex', timestamp: '2026-01-01T00:00:00.000Z' });
  writer.send({ id: 'm3', kind: 'text', role: 'assistant', content: '第一段回复，随后补全成完整回复。', sessionId: 'n', provider: 'codex', timestamp: '2026-01-01T00:00:00.000Z' });
  assert.equal(getSessionReplyPreview('app-preview-run'), '第一段回复，随后补全成完整回复。');
});

test('subagent text rows and compact summaries never become the reply preview', () => {
  const notified: unknown[] = [];
  const writer = new ChatSessionWriter({
    connection: null, userId: 7, provider: 'codex', providerSessionId: null, onProviderSessionId: () => {},
    appSessionId: 'app-preview-foreign',
    decorateOutboundEvent: (message: NormalizedMessage) => ({ ...message, sessionId: 'app-preview-foreign', seq: 1 }),
    notifyPermissionRequest: (info) => { notified.push(info); },
  });

  // Codex/opencode/antigravity/claude subagent traffic reaches this writer as
  // text rows tied to their card; a background agent finishing last must not
  // make the stop push carry its answer.
  writer.send({ id: 'm1', kind: 'text', role: 'assistant', content: '子代理的回答', parentToolUseId: 'call_agent_1', sessionId: 'n', provider: 'codex', timestamp: '2026-01-01T00:00:00.000Z' });
  // A compaction summary is an assistant-authored text row too, but it is a
  // summary of old context, not this run's reply.
  writer.send({ id: 'm2', kind: 'text', role: 'assistant', content: '历史上下文压缩摘要', isCompactSummary: true, sessionId: 'n', provider: 'claude', timestamp: '2026-01-01T00:00:00.000Z' });

  assert.equal(getSessionReplyPreview('app-preview-foreign'), null);
});

test('a new run on the same session resets the reply preview instead of inheriting the previous turn', () => {
  const first = new ChatSessionWriter({
    connection: null, userId: 7, provider: 'codex', providerSessionId: null, onProviderSessionId: () => {},
    appSessionId: 'app-preview-reset',
    decorateOutboundEvent: (message: NormalizedMessage) => ({ ...message, sessionId: 'app-preview-reset', seq: 1 }),
  });
  first.send({ id: 'm1', kind: 'text', role: 'assistant', content: '上一回合的回复', sessionId: 'n', provider: 'codex', timestamp: '2026-01-01T00:00:00.000Z' });
  assert.equal(getSessionReplyPreview('app-preview-reset'), '上一回合的回复');

  // Constructing the next run's writer clears the stale snippet: a text-less
  // follow-up turn must not push the previous turn's reply again.
  new ChatSessionWriter({
    connection: null, userId: 7, provider: 'codex', providerSessionId: null, onProviderSessionId: () => {},
    appSessionId: 'app-preview-reset',
    decorateOutboundEvent: (message: NormalizedMessage) => ({ ...message, sessionId: 'app-preview-reset', seq: 1 }),
  });
  assert.equal(getSessionReplyPreview('app-preview-reset'), null);
});

test('a writer without an app session id (session-channel writer) records no preview', () => {
  const { writer } = (() => {
    const writer = new ChatSessionWriter({
      connection: null, userId: 7, provider: 'codex', providerSessionId: null, onProviderSessionId: () => {},
      decorateOutboundEvent: (message: NormalizedMessage) => ({ ...message, sessionId: 'app-preview-channel', seq: 1 }),
    });
    return { writer };
  })();
  writer.send({ id: 'm1', kind: 'text', role: 'assistant', content: 'leak candidate', sessionId: 'n', provider: 'codex', timestamp: '2026-01-01T00:00:00.000Z' });
  assert.equal(getSessionReplyPreview('app-preview-channel'), null);
});
