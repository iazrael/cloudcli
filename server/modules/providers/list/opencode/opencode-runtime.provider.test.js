import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';

import {
  resolveOpenCodeAgent,
  shouldAutoApproveOpenCodePermission,
} from './opencode-server.client.js';
import {
  announceOpenCodePermission,
  announceOpenCodeQuestion,
  openCodePermissions,
  registerOpenCodeRun,
  settleOpenCodeEvent,
  unregisterOpenCodeRun,
} from './opencode-permissions.provider.js';

/** Captured engine replies keyed by the path the bridge called. */
const replies = [];
let server;
let baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      replies.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('true');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

function createWriter() {
  const messages = [];
  return {
    messages,
    send(message) {
      messages.push(message);
    },
  };
}

function createRun(overrides = {}) {
  const writer = createWriter();
  return {
    writer,
    run: {
      runId: 'app-session-1',
      appSessionId: 'app-session-1',
      providerSessionId: 'ses_test',
      directory: '/tmp/project',
      handle: { baseUrl, headers: {} },
      writer,
      permissionMode: 'default',
      ...overrides,
    },
  };
}

function permissionEvent(overrides = {}) {
  return {
    type: 'permission.asked',
    directory: '/tmp/project',
    properties: {
      id: 'per_test_1',
      sessionID: 'ses_test',
      permission: 'external_directory',
      patterns: ['C:\\Windows\\*'],
      metadata: { filepath: 'C:\\Windows\\win.ini' },
      always: ['C:\\Windows\\*'],
      tool: { messageID: 'msg_1', callID: 'call_1' },
      ...overrides,
    },
  };
}

test('permission modes map onto the OpenCode agent and auto-approval lever', () => {
  assert.equal(resolveOpenCodeAgent('plan'), 'plan');
  assert.equal(resolveOpenCodeAgent('default'), undefined);
  assert.equal(resolveOpenCodeAgent(undefined), undefined);
  assert.equal(shouldAutoApproveOpenCodePermission('bypassPermissions'), true);
  assert.equal(shouldAutoApproveOpenCodePermission('default'), false);
  assert.equal(shouldAutoApproveOpenCodePermission('acceptEdits'), false);
  assert.equal(shouldAutoApproveOpenCodePermission('acceptEdits', 'edit'), true);
  assert.equal(shouldAutoApproveOpenCodePermission('acceptEdits', 'external_directory'), false);
});

test('a permission request becomes an answerable card and resolves with once', async () => {
  const { run, writer } = createRun();
  registerOpenCodeRun(run);
  replies.length = 0;

  announceOpenCodePermission(run, permissionEvent());

  const card = writer.messages.find((message) => message.kind === 'permission_request');
  assert.ok(card, 'a permission card must be sent');
  assert.equal(card.requestId, 'per_test_1');
  assert.equal(card.toolName, 'external_directory');
  assert.deepEqual(card.input.patterns, ['C:\\Windows\\*']);

  assert.equal(openCodePermissions.listPending('app-session-1').length, 1);

  openCodePermissions.resolve('per_test_1', { allow: true });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(replies.length, 1);
  assert.match(replies[0].url, /\/permission\/per_test_1\/reply\?directory=/);
  assert.deepEqual(replies[0].body, { reply: 'once' });

  assert.equal(openCodePermissions.listPending('app-session-1').length, 0);
  assert.ok(writer.messages.some((message) => message.kind === 'permission_cancelled'));

  unregisterOpenCodeRun(run.runId);
});

test('denying a permission replies reject with the user message', async () => {
  const { run } = createRun({ runId: 'app-session-2', appSessionId: 'app-session-2' });
  registerOpenCodeRun(run);
  replies.length = 0;

  announceOpenCodePermission(run, permissionEvent({ id: 'per_test_2' }));
  openCodePermissions.resolve('per_test_2', { allow: false, message: 'not allowed' });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(replies[0].body, { reply: 'reject', message: 'not allowed' });

  unregisterOpenCodeRun(run.runId);
});

test('remembering a permission replies always', async () => {
  const { run } = createRun({ runId: 'app-session-3', appSessionId: 'app-session-3' });
  registerOpenCodeRun(run);
  replies.length = 0;

  announceOpenCodePermission(run, permissionEvent({ id: 'per_test_3' }));
  openCodePermissions.resolve('per_test_3', { allow: true, rememberEntry: '{"edit":"allow"}' });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(replies[0].body, { reply: 'always' });

  unregisterOpenCodeRun(run.runId);
});

test('bypassPermissions auto-approves without rendering a card', async () => {
  const { run, writer } = createRun({
    runId: 'app-session-4',
    appSessionId: 'app-session-4',
    permissionMode: 'bypassPermissions',
  });
  registerOpenCodeRun(run);
  replies.length = 0;

  announceOpenCodePermission(run, permissionEvent({ id: 'per_test_4' }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(writer.messages.some((message) => message.kind === 'permission_request'), false);
  assert.deepEqual(replies[0].body, { reply: 'once' });
  assert.equal(openCodePermissions.listPending('app-session-4').length, 0);

  unregisterOpenCodeRun(run.runId);
});

test('an AskUserQuestion bridges to a card and answers in question order', async () => {
  const { run, writer } = createRun({ runId: 'app-session-5', appSessionId: 'app-session-5' });
  registerOpenCodeRun(run);
  replies.length = 0;

  announceOpenCodeQuestion(run, {
    type: 'question.asked',
    directory: '/tmp/project',
    properties: {
      id: 'que_test_1',
      sessionID: 'ses_test',
      questions: [
        {
          question: 'Which database?',
          header: 'Database',
          options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'embedded' }],
        },
        {
          question: 'Which extras?',
          header: 'Extras',
          multiple: true,
          options: [{ label: 'Auth', description: '' }, { label: 'Logging', description: '' }],
        },
      ],
      tool: { messageID: 'msg_2', callID: 'call_2' },
    },
  });

  const card = writer.messages.find((message) => message.kind === 'permission_request');
  assert.equal(card.toolName, 'AskUserQuestion');
  assert.equal(card.input.questions[0].multiSelect, false);
  assert.equal(card.input.questions[1].multiSelect, true);
  assert.equal(card.input.questions[0].options[0].label, 'Postgres');

  openCodePermissions.resolve('que_test_1', {
    allow: true,
    updatedInput: {
      questions: card.input.questions,
      answers: { 'Which database?': 'Postgres', 'Which extras?': 'Auth, Logging' },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.match(replies[0].url, /\/question\/que_test_1\/reply/);
  assert.deepEqual(replies[0].body, { answers: [['Postgres'], ['Auth', 'Logging']] });

  unregisterOpenCodeRun(run.runId);
});

test('settling an engine event retracts the card without re-replying', () => {
  const { run, writer } = createRun({ runId: 'app-session-6', appSessionId: 'app-session-6' });
  registerOpenCodeRun(run);

  announceOpenCodeQuestion(run, {
    type: 'question.asked',
    directory: '/tmp/project',
    properties: {
      id: 'que_test_2',
      sessionID: 'ses_test',
      questions: [{ question: 'Continue?', header: 'Next', options: [{ label: 'Yes', description: '' }] }],
    },
  });

  settleOpenCodeEvent({
    type: 'question.replied',
    directory: '/tmp/project',
    properties: { sessionID: 'ses_test', requestID: 'que_test_2', answers: [['Yes']] },
  });

  assert.equal(openCodePermissions.listPending('app-session-6').length, 0);
  assert.ok(writer.messages.some((message) => message.kind === 'permission_cancelled'));

  unregisterOpenCodeRun(run.runId);
});

test('unregistering a run retracts cards it left pending', () => {
  const { run, writer } = createRun({ runId: 'app-session-7', appSessionId: 'app-session-7' });
  registerOpenCodeRun(run);

  announceOpenCodePermission(run, permissionEvent({ id: 'per_test_7' }));
  unregisterOpenCodeRun(run.runId);

  assert.equal(openCodePermissions.listPending('app-session-7').length, 0);
  assert.ok(writer.messages.some((message) => message.kind === 'permission_cancelled'));
});
