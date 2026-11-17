import assert from 'node:assert/strict';
import test from 'node:test';

import type { OpenCodeEventEnvelope } from '@/modules/providers/list/opencode/opencode-event-stream.js';
import { OpenCodeInteractionBridge } from '@/modules/providers/list/opencode/opencode-interaction-bridge.js';
import type { NormalizedMessage } from '@/shared/types.js';

const APP_SESSION = 'app-1';
const PROVIDER_SESSION = 'ses_eb855d7a8ffeqG0omi8QjZw8LM';
const CALL = 'call-c219b19d-21fb-4d30-8fdb-2d2be10d50d0';

type Call = { method: string; args: unknown[] };

const makeHarness = (options: { now?: () => number; pendingTtlMs?: number; clientMissing?: boolean; fail?: boolean } = {}) => {
  const calls: Call[] = [];
  const frames: NormalizedMessage[] = [];
  const client = {
    replyPermission: async (...args: unknown[]) => { calls.push({ method: 'replyPermission', args }); if (options.fail) throw new Error('session gone'); },
    replyForm: async (...args: unknown[]) => { calls.push({ method: 'replyForm', args }); if (options.fail) throw new Error('session gone'); },
    cancelForm: async (...args: unknown[]) => { calls.push({ method: 'cancelForm', args }); if (options.fail) throw new Error('session gone'); },
  };
  const bridge = new OpenCodeInteractionBridge({
    getClient: () => (options.clientMissing ? null : client),
    now: options.now,
    pendingTtlMs: options.pendingTtlMs,
  });
  const toolCalls = new Map([[CALL, { name: 'shell', input: { command: 'echo probe-A' } }]]);
  bridge.attach({
    appSessionId: APP_SESSION,
    providerSessionId: PROVIDER_SESSION,
    writer: { send: (frame) => frames.push(frame as NormalizedMessage) },
    resolveToolCall: (id) => toolCalls.get(id) ?? null,
  });
  return { bridge, calls, frames };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Captured from v2.0.31 (`temp/opencode-probe4-events.json`). */
const permissionAsked = (overrides: Record<string, unknown> = {}): OpenCodeEventEnvelope => ({
  id: 'evt_147aa337d002hbS0PfotipEo7w',
  created: 1792203699069,
  type: 'permission.asked',
  location: { directory: '/tmp/project' },
  data: {
    id: 'per_147aa337d001nws7O9PlU5SKCg',
    sessionID: PROVIDER_SESSION,
    action: 'shell',
    resources: ['echo probe-A'],
    save: ['echo *'],
    source: { type: 'tool', messageID: 'msg_147aa2e2a001d44GbDDM8j6FZx', id: CALL },
    ...overrides,
  },
});

/** Captured from v2.0.31 (`temp/opencode-probe3-events.json`), plus a multiselect field. */
const formCreated = (): OpenCodeEventEnvelope => ({
  id: 'evt_147a8690a002Ifjlwu73k0tly7',
  created: 1792203581706,
  type: 'form.created',
  location: { directory: '/tmp/project' },
  data: {
    form: {
      id: 'frm_147a8690a001Bf0LdLSgutFhNT',
      sessionID: PROVIDER_SESSION,
      title: 'Questions',
      metadata: { kind: 'question', tool: { messageID: 'msg_147a86597001Re0ueZd5c1BGej', id: 'call-de1c71ba' } },
      fields: [
        {
          key: 'q0', title: 'Color', description: 'Which color?', type: 'string', custom: true,
          options: [{ value: 'Red', label: 'Red', description: 'Red color' }, { value: 'Blue', label: 'Blue', description: 'Blue color' }],
        },
        {
          key: 'q1', title: 'Scope', description: 'Which areas?', type: 'multiselect', custom: true,
          options: [{ value: 'server/', label: 'server/' }, { value: 'src/', label: 'src/' }, { value: 'docs', label: 'docs' }],
        },
      ],
    },
  },
});

/**
 * The engine's web-search setup gate: a `form.created` whose metadata kind is
 * `websearch.provider`, captured from v2.0.32. The bridge answers `allow` so
 * the engine never hits its one-minute cancellation.
 */
const webSearchGate = (form: Record<string, unknown> = {}): OpenCodeEventEnvelope => ({
  id: 'evt_gate_1',
  created: 1792203581706,
  type: 'form.created',
  location: { directory: '/tmp/project' },
  data: {
    form: {
      id: 'frm_gate_1',
      sessionID: PROVIDER_SESSION,
      title: 'Web Search',
      metadata: { kind: 'websearch.provider' },
      fields: [{
        key: 'choice',
        description: 'Allow OpenCode to search the web for up-to-date information?',
        type: 'string',
        required: true,
        custom: false,
        options: [
          { value: 'allow', label: 'Allow search via OpenCode Web Search' },
          { value: 'choose', label: 'Choose another provider' },
          { value: 'disable', label: 'Disable web search' },
        ],
      }],
      ...form,
    },
  },
});

test('permission.asked becomes a permission_request card labelled with the guarded tool call', () => {
  const { bridge, frames } = makeHarness();
  bridge.handleEvent(permissionAsked());

  assert.equal(frames.length, 1);
  const frame = frames[0];
  assert.equal(frame.kind, 'permission_request');
  assert.equal(frame.provider, 'opencode');
  assert.equal(frame.sessionId, APP_SESSION);
  assert.equal(frame.requestId, 'per_147aa337d001nws7O9PlU5SKCg');
  assert.equal(frame.toolName, 'shell');
  assert.equal(frame.toolId, CALL);
  assert.deepEqual(frame.input, { command: 'echo probe-A' });
  assert.deepEqual(frame.context, { action: 'shell', resources: ['echo probe-A'], save: ['echo *'], reason: 'shell: echo probe-A' });
  assert.equal(frame.canInterrupt, true);

  const pending = bridge.listPending(APP_SESSION);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requestId, 'per_147aa337d001nws7O9PlU5SKCg');
  assert.equal(pending[0].toolName, 'shell');
  assert.equal(pending[0].sessionId, APP_SESSION);
  assert.ok(pending[0].receivedAt instanceof Date);
  assert.equal(bridge.listPending(PROVIDER_SESSION).length, 1, 'either id finds the card');

  bridge.handleEvent(permissionAsked());
  assert.equal(frames.length, 1, 're-announcements do not duplicate the card');
});

test('falls back to the action name when the tool call is unknown and ignores foreign sessions', () => {
  const { bridge, frames } = makeHarness();
  bridge.handleEvent(permissionAsked({ id: 'per_other', source: { type: 'tool', messageID: 'm', id: 'call-unknown' }, action: 'edit', resources: ['/tmp/a.ts'] }));
  assert.equal(frames[0].toolName, 'edit');
  assert.deepEqual(frames[0].input, { resources: ['/tmp/a.ts'] });

  bridge.handleEvent(permissionAsked({ id: 'per_foreign', sessionID: 'ses_someone_else' }));
  assert.equal(frames.length, 1);
  assert.equal(bridge.listPending(APP_SESSION).length, 1);
});

test('maps Allow / Remember / Deny onto once / always / reject and retracts the card', async () => {
  const { bridge, calls, frames } = makeHarness();
  bridge.handleEvent(permissionAsked({ id: 'per_once' }));
  bridge.handleEvent(permissionAsked({ id: 'per_always' }));
  bridge.handleEvent(permissionAsked({ id: 'per_reject' }));
  bridge.handleEvent(permissionAsked({ id: 'per_reject_default' }));
  frames.length = 0;

  bridge.resolve('per_once', { allow: true });
  bridge.resolve('per_always', { allow: true, rememberEntry: { toolName: 'shell' } });
  bridge.resolve('per_reject', { allow: false, message: 'not now' });
  bridge.resolve('per_reject_default', { allow: false });
  bridge.resolve('per_never_issued', { allow: true });
  await flush();

  assert.deepEqual(calls.map((call) => call.args), [
    [PROVIDER_SESSION, 'per_once', { decision: 'once' }],
    [PROVIDER_SESSION, 'per_always', { decision: 'always' }],
    [PROVIDER_SESSION, 'per_reject', { decision: 'reject', message: 'not now' }],
    [PROVIDER_SESSION, 'per_reject_default', { decision: 'reject', message: 'The user declined this action.' }],
  ]);
  assert.deepEqual(frames.map((frame) => [frame.kind, frame.requestId]), [
    ['permission_resolved', 'per_once'],
    ['permission_resolved', 'per_always'],
    ['permission_resolved', 'per_reject'],
    ['permission_resolved', 'per_reject_default'],
  ]);
  assert.equal(bridge.listPending(APP_SESSION).length, 0);
});

test('form.created becomes an AskUserQuestion card with the panel question shape', () => {
  const { bridge, frames } = makeHarness();
  bridge.handleEvent(formCreated());

  assert.equal(frames.length, 1);
  const frame = frames[0];
  assert.equal(frame.kind, 'permission_request');
  assert.equal(frame.requestId, 'frm_147a8690a001Bf0LdLSgutFhNT');
  assert.equal(frame.toolName, 'AskUserQuestion');
  assert.equal(frame.toolId, 'call-de1c71ba');
  assert.deepEqual(frame.input, {
    questions: [
      {
        question: 'Which color?',
        header: 'Color',
        options: [{ label: 'Red', description: 'Red color' }, { label: 'Blue', description: 'Blue color' }],
        multiSelect: false,
      },
      {
        question: 'Which areas?',
        header: 'Scope',
        options: [{ label: 'server/' }, { label: 'src/' }, { label: 'docs' }],
        multiSelect: true,
      },
    ],
  });
  assert.deepEqual(frame.context, { reason: 'Questions', kind: 'question' });
});

test('maps the panel answers (keyed by question text) back onto the form field keys', async () => {
  const { bridge, calls, frames } = makeHarness();
  bridge.handleEvent(formCreated());
  frames.length = 0;

  bridge.resolve('frm_147a8690a001Bf0LdLSgutFhNT', {
    allow: true,
    updatedInput: { questions: [], answers: { 'Which color?': 'Blue', 'Which areas?': 'server/, docs' } },
  });
  await flush();

  assert.deepEqual(calls, [{
    method: 'replyForm',
    args: [PROVIDER_SESSION, 'frm_147a8690a001Bf0LdLSgutFhNT', { q0: 'Blue', q1: ['server/', 'docs'] }],
  }]);
  assert.deepEqual(frames.map((frame) => frame.kind), ['permission_resolved']);
});

test('a skipped or declined question form is dismissed with a message so the model continues', async () => {
  const { bridge, calls } = makeHarness();
  bridge.handleEvent(formCreated());
  bridge.resolve('frm_147a8690a001Bf0LdLSgutFhNT', { allow: true, updatedInput: { answers: {} } });
  await flush();
  assert.equal(calls[0].method, 'cancelForm');
  assert.equal(calls[0].args[1], 'frm_147a8690a001Bf0LdLSgutFhNT');
  assert.match(String(calls[0].args[2]), /skipped these questions/);

  bridge.handleEvent(formCreated());
  bridge.resolve('frm_147a8690a001Bf0LdLSgutFhNT', { allow: false, message: 'ask later' });
  await flush();
  assert.deepEqual(calls[1], { method: 'cancelForm', args: [PROVIDER_SESSION, 'frm_147a8690a001Bf0LdLSgutFhNT', 'ask later'] });
});

test('retracts cards settled by another client and ignores ids it never issued', () => {
  const { bridge, frames } = makeHarness();
  bridge.handleEvent(permissionAsked({ id: 'per_tui' }));
  bridge.handleEvent(formCreated());
  frames.length = 0;

  bridge.handleEvent({ type: 'permission.replied', data: { sessionID: PROVIDER_SESSION, requestID: 'per_tui', reply: 'once' } });
  bridge.handleEvent({ type: 'form.cancelled', data: { id: 'frm_147a8690a001Bf0LdLSgutFhNT', sessionID: PROVIDER_SESSION } });
  bridge.handleEvent({ type: 'permission.replied', data: { sessionID: PROVIDER_SESSION, requestID: 'per_unknown', reply: 'once' } });

  assert.deepEqual(frames.map((frame) => [frame.kind, frame.requestId]), [
    ['permission_resolved', 'per_tui'],
    ['permission_cancelled', 'frm_147a8690a001Bf0LdLSgutFhNT'],
  ]);
  assert.equal(bridge.listPending(APP_SESSION).length, 0);
});

test('cancelSession retracts only that session\'s cards without calling the service', () => {
  const { bridge, calls, frames } = makeHarness();
  bridge.attach({
    appSessionId: 'app-2',
    providerSessionId: 'ses_two',
    writer: { send: (frame) => frames.push(frame as NormalizedMessage) },
    resolveToolCall: () => null,
  });
  bridge.handleEvent(permissionAsked({ id: 'per_a' }));
  bridge.handleEvent(permissionAsked({ id: 'per_b', sessionID: 'ses_two' }));
  frames.length = 0;

  bridge.cancelSession(APP_SESSION, 'run aborted');

  assert.deepEqual(frames.map((frame) => [frame.kind, frame.requestId, frame.reason]), [['permission_cancelled', 'per_a', 'run aborted']]);
  assert.equal(calls.length, 0);
  assert.equal(bridge.listPending(APP_SESSION).length, 0);
  assert.equal(bridge.listPending('app-2').length, 1);
});

test('expires forgotten cards: rejects/cancels on the service and retracts them', async () => {
  let clock = 1_000_000;
  const { bridge, calls, frames } = makeHarness({ now: () => clock, pendingTtlMs: 1_000 });
  bridge.handleEvent(permissionAsked({ id: 'per_old' }));
  bridge.handleEvent(formCreated());
  frames.length = 0;

  clock += 500;
  assert.equal(bridge.listPending(APP_SESSION).length, 2);
  clock += 1_000;
  assert.equal(bridge.listPending(APP_SESSION).length, 0);
  await flush();

  assert.deepEqual(calls.map((call) => [call.method, call.args[1]]), [
    ['replyPermission', 'per_old'],
    ['cancelForm', 'frm_147a8690a001Bf0LdLSgutFhNT'],
  ]);
  assert.deepEqual(calls[0].args[2], { decision: 'reject', message: 'The request expired without an answer.' });
  assert.deepEqual(frames.map((frame) => frame.kind), ['permission_cancelled', 'permission_cancelled']);
});

test('a reply the service refuses retracts the card with the failure as the reason', async () => {
  const { bridge, frames } = makeHarness({ fail: true });
  bridge.handleEvent(permissionAsked({ id: 'per_fail' }));
  frames.length = 0;
  bridge.resolve('per_fail', { allow: true });
  await flush();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, 'permission_cancelled');
  assert.equal(frames[0].reason, 'session gone');
});

test('the web-search gate is answered automatically instead of expiring as "Web search cancelled"', async () => {
  const { bridge, calls, frames } = makeHarness();
  bridge.handleEvent(webSearchGate());
  await flush();

  assert.deepEqual(calls, [{
    method: 'replyForm',
    args: [PROVIDER_SESSION, 'frm_gate_1', { choice: 'allow' }],
  }]);
  assert.equal(frames.length, 0, 'the gate is a setup wizard, not a card');
  assert.equal(bridge.listPending(APP_SESSION).length, 0);
});

test('a gate the bridge cannot answer is left alone instead of answered blind', async () => {
  const { bridge, calls, frames } = makeHarness();
  bridge.handleEvent(webSearchGate({
    id: 'frm_gate_reshaped',
    fields: [{ key: 'provider', options: [{ value: 'tavily', label: 'Tavily' }] }],
  }));
  await flush();

  assert.deepEqual(calls, [], 'no allow choice, no guess');
  assert.equal(frames.length, 0);
});

test('without a live service the card is retracted instead of hanging', async () => {
  const { bridge, frames } = makeHarness({ clientMissing: true });
  bridge.handleEvent(permissionAsked({ id: 'per_noservice' }));
  frames.length = 0;
  bridge.resolve('per_noservice', { allow: true });
  await flush();
  assert.deepEqual(frames.map((frame) => [frame.kind, frame.reason]), [['permission_cancelled', 'OpenCode service is not running']]);
});
