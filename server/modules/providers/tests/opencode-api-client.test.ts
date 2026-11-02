import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import {
  OpenCodeApiClient,
  OpenCodeApiError,
  parseOpenCodeModelRef,
} from '@/modules/providers/list/opencode/opencode-api.client.js';

type RecordedRequest = { method: string; path: string; authorization: string | undefined; body: unknown };

/**
 * A minimal stand-in for `opencode serve` answering the endpoints the client
 * drives, recording every request so the tests can pin the wire shapes
 * verified against v2.0.31.
 */
const withFakeService = async (
  run: (input: { client: OpenCodeApiClient; requests: RecordedRequest[] }) => Promise<void>,
): Promise<void> => {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const path = request.url ?? '';
      requests.push({ method: request.method ?? '', path, authorization: request.headers.authorization, body });
      const reply = (status: number, payload?: unknown) => {
        response.writeHead(status, payload === undefined ? {} : { 'content-type': 'application/json' });
        response.end(payload === undefined ? undefined : JSON.stringify(payload));
      };
      if (path.includes('/api/session/ses_missing') || path.startsWith('/api/shell/sh_missing')) {
        reply(404, { _tag: 'NotFoundError', message: 'Session ses_missing not found' });
        return;
      }
      if (request.method === 'POST' && path === '/api/session') {
        reply(200, { data: { id: 'ses_fake', location: body.location } });
        return;
      }
      if (request.method === 'POST' && path.endsWith('/prompt')) {
        reply(200, { data: { id: 'msg_fake', sessionID: 'ses_fake', type: 'user' } });
        return;
      }
      if (request.method === 'POST' && path.endsWith('/compact')) {
        reply(200, { data: { id: 'msg_compaction', sessionID: 'ses_fake', type: 'compaction', payload: {}, delivery: 'steer' } });
        return;
      }
      if (request.method === 'POST' && path.endsWith('/fork')) {
        reply(200, { data: { id: 'ses_forked', fork: { sessionID: 'ses_fake' } } });
        return;
      }
      if (request.method === 'POST' && path === '/api/session/ses_stuck/revert/commit') {
        reply(500, { message: 'commit failed' });
        return;
      }
      if (request.method === 'POST' && path.endsWith('/interrupt')) {
        reply(200, { interrupted: true });
        return;
      }
      if (request.method === 'GET' && path === '/api/session/ses_fake') {
        reply(200, {
          data: {
            id: 'ses_fake', outcome: 'succeeded', time: { created: 1, updated: 2, idle: 1792208248938 },
            tokens: { input: 19154, output: 10, reasoning: 435, cache: { read: 2048, write: 0 } },
          },
        });
        return;
      }
      if (request.method === 'GET' && path === '/api/session/ses_running') {
        reply(200, { data: { id: 'ses_running', time: { created: 1, updated: 2 } } });
        return;
      }
      if (request.method === 'GET' && path.startsWith('/api/shell/')) {
        reply(200, { data: { id: 'sh_1', status: 'running', command: 'sleep 600' } });
        return;
      }
      if (request.method === 'DELETE' && path.startsWith('/api/shell/')) {
        reply(204);
        return;
      }
      reply(204);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const client = new OpenCodeApiClient({ url: `http://127.0.0.1:${port}`, authorization: 'Basic dGVzdA==' });
  try {
    await run({ client, requests });
  } finally {
    server.close();
  }
};

test('parseOpenCodeModelRef splits provider, model and inline or explicit variant', () => {
  assert.deepEqual(parseOpenCodeModelRef('opencode/beam-free'), { providerID: 'opencode', id: 'beam-free' });
  assert.deepEqual(parseOpenCodeModelRef('opencode-go/glm-5.3#high'), { providerID: 'opencode-go', id: 'glm-5.3', variant: 'high' });
  assert.deepEqual(parseOpenCodeModelRef('opencode-go/glm-5.3#high', 'low'), { providerID: 'opencode-go', id: 'glm-5.3', variant: 'low' });
  assert.deepEqual(parseOpenCodeModelRef('anthropic/claude-sonnet-4-5', ''), { providerID: 'anthropic', id: 'claude-sonnet-4-5' });
  assert.equal(parseOpenCodeModelRef('no-slash'), null);
  assert.equal(parseOpenCodeModelRef('trailing/'), null);
  assert.equal(parseOpenCodeModelRef('   '), null);
});

test('sends the verified wire shapes with Basic auth on every call', async () => {
  await withFakeService(async ({ client, requests }) => {
    const created = await client.createSession({ directory: '/tmp/project', title: 'hello' });
    assert.equal(created.id, 'ses_fake');

    await client.switchModel('ses_fake', { providerID: 'opencode-go', id: 'glm-5.3', variant: 'high' });
    await client.switchAgent('ses_fake', 'plan');
    await client.setPermissions('ses_fake', [{ action: 'shell', resource: '*', effect: 'ask' }]);
    const prompted = await client.prompt('ses_fake', {
      text: 'hi',
      files: [{ uri: 'data:text/plain;base64,aGk=', filename: 'note.txt', mime: 'text/plain' }],
    });
    assert.equal(prompted.messageId, 'msg_fake');
    assert.equal(await client.interrupt('ses_fake'), true);
    assert.equal((await client.compactSession('ses_fake')).messageId, 'msg_compaction');
    await client.replyPermission('ses_fake', 'per_1', { decision: 'reject', message: 'nope' });
    await client.replyForm('ses_fake', 'frm_1', { q0: 'Blue', q1: ['a', 'b'] });
    await client.cancelForm('ses_fake', 'frm_2', 'skipped by user');
    await client.cancelForm('ses_fake', 'frm_3');
    assert.deepEqual(await client.getSession('ses_fake'), {
      outcome: 'succeeded',
      idleAt: 1792208248938,
      tokens: { input: 19154, output: 10, reasoning: 435, cacheRead: 2048, cacheWrite: 0 },
    });
    assert.deepEqual(await client.getSession('ses_running'), { outcome: null, idleAt: null, tokens: null });

    assert.ok(requests.every((request) => request.authorization === 'Basic dGVzdA=='));
    assert.deepEqual(requests.map((request) => [request.method, request.path]), [
      ['POST', '/api/session'],
      ['POST', '/api/session/ses_fake/model'],
      ['POST', '/api/session/ses_fake/agent'],
      ['PATCH', '/api/session/ses_fake'],
      ['POST', '/api/session/ses_fake/prompt'],
      ['POST', '/api/session/ses_fake/interrupt'],
      ['POST', '/api/session/ses_fake/compact'],
      ['POST', '/api/session/ses_fake/permission/per_1/reply'],
      ['POST', '/api/session/ses_fake/form/frm_1/reply'],
      ['DELETE', '/api/session/ses_fake/form/frm_2?message=skipped%20by%20user'],
      ['DELETE', '/api/session/ses_fake/form/frm_3'],
      ['GET', '/api/session/ses_fake'],
      ['GET', '/api/session/ses_running'],
    ]);
    assert.deepEqual(requests[0].body, {
      location: { directory: '/tmp/project' },
      title: 'hello',
    });
    assert.deepEqual(requests[1].body, { model: { providerID: 'opencode-go', id: 'glm-5.3', variant: 'high' } });
    assert.deepEqual(requests[2].body, { agent: 'plan' });
    assert.deepEqual(requests[3].body, { permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] });
    assert.deepEqual(requests[4].body, {
      text: 'hi',
      files: [{ uri: 'data:text/plain;base64,aGk=', filename: 'note.txt', mime: 'text/plain' }],
    });
    assert.equal(requests[5].body, undefined);
    assert.deepEqual(requests[6].body, {}, 'the compaction request carries no prompt of its own');
    assert.deepEqual(requests[7].body, { decision: 'reject', message: 'nope' });
    assert.deepEqual(requests[8].body, { answer: { q0: 'Blue', q1: ['a', 'b'] } });
    assert.equal(requests[9].body, undefined, 'the cancel message travels in the query string');
    assert.equal(requests[10].body, undefined);
  });
});

test('omits an empty files list from the prompt body', async () => {
  await withFakeService(async ({ client, requests }) => {
    await client.prompt('ses_fake', { text: 'plain', files: [] });
    assert.deepEqual(requests[0].body, { text: 'plain' });
  });
});

test('creates a session without a title when none is given', async () => {
  await withFakeService(async ({ client, requests }) => {
    const created = await client.createSession({ directory: '/tmp/project' });
    assert.equal(created.id, 'ses_fake');
    // The engine only names a session while it carries the placeholder it
    // falls back to, so the title is left out rather than filled in.
    assert.deepEqual(requests[0].body, { location: { directory: '/tmp/project' } });
  });
});

test('turns non-2xx answers into OpenCodeApiError carrying status and message', async () => {
  await withFakeService(async ({ client }) => {
    await assert.rejects(
      client.interrupt('ses_missing'),
      (error: unknown) => error instanceof OpenCodeApiError
        && error.status === 404
        && error.message.includes('Session ses_missing not found'),
    );
  });
});

test('compact posts to the session compaction endpoint and returns the admitted message id', async () => {
  await withFakeService(async ({ client, requests }) => {
    const result = await client.compactSession('ses_fake');
    assert.deepEqual(result, { messageId: 'msg_compaction' });
    const request = requests.at(-1);
    assert.equal(request?.method, 'POST');
    assert.equal(request?.path, '/api/session/ses_fake/compact');
    assert.deepEqual(request?.body, {});
  });
});

test('forks with an exclusive `before` cut, or the whole conversation without one', async () => {
  await withFakeService(async ({ client, requests }) => {
    assert.deepEqual(await client.forkSession('ses_fake', 'msg_next'), { id: 'ses_forked' });
    assert.deepEqual(await client.forkSession('ses_fake', null), { id: 'ses_forked' });

    assert.deepEqual(requests.map((request) => [request.method, request.path, request.body]), [
      ['POST', '/api/session/ses_fake/fork', { before: 'msg_next' }],
      ['POST', '/api/session/ses_fake/fork', {}],
    ]);
  });
});

test('reverts by staging then committing, and clears a boundary whose commit failed', async () => {
  await withFakeService(async ({ client, requests }) => {
    await client.revertSession('ses_fake', 'msg_drop', { files: true });
    await assert.rejects(client.revertSession('ses_stuck', 'msg_drop', { files: false }), OpenCodeApiError);

    assert.deepEqual(requests.map((request) => [request.method, request.path, request.body]), [
      ['POST', '/api/session/ses_fake/revert/stage', { messageID: 'msg_drop', files: true }],
      ['POST', '/api/session/ses_fake/revert/commit', undefined],
      ['POST', '/api/session/ses_stuck/revert/stage', { messageID: 'msg_drop', files: false }],
      ['POST', '/api/session/ses_stuck/revert/commit', undefined],
      ['DELETE', '/api/session/ses_stuck/revert', undefined],
    ]);
  });
});

test('reads and stops a background shell by its handle, scoped to the checkout', async () => {
  await withFakeService(async ({ client, requests }) => {
    assert.deepEqual(await client.getShell('sh_1', '/tmp/project'), { status: 'running', exitCode: null });

    await client.removeShell('sh_1', '/tmp/project');
    await assert.rejects(
      () => client.getShell('sh_missing', '/tmp/project'),
      (error: unknown) => error instanceof OpenCodeApiError && error.status === 404,
    );

    const query = new URLSearchParams({ 'location[directory]': '/tmp/project' }).toString();
    assert.deepEqual(
      requests
        .filter((request) => request.path.startsWith('/api/shell/'))
        .map((request) => [request.method, request.path]),
      [
        ['GET', `/api/shell/sh_1?${query}`],
        ['DELETE', `/api/shell/sh_1?${query}`],
        ['GET', `/api/shell/sh_missing?${query}`],
      ],
    );
  });
});
