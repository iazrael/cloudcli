import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { OpenCodeApiClient } from '@/modules/providers/list/opencode/opencode-api.client.js';
import { askOpenCodeSideQuestion } from '@/modules/providers/list/opencode/opencode-side-question.js';
import type { SideQuestionOutcome, SideQuestionRequest } from '@/shared/types.js';

/**
 * The whole production path is real here: the module talks HTTP against a
 * fake `opencode serve` that speaks exactly the v2 endpoints a side question
 * uses — fork, permission patch, prompt, delete and the `/api/event` SSE
 * stream — with the shapes captured live on 2.2.7 (see the design doc). Only
 * the answer itself is scripted.
 */

const CHILD = 'ses_child';
const PARENT = 'ses_parent';

type FakeState = {
  requests: Array<{ method: string; path: string; body?: unknown }>;
  denyShouldFail?: boolean;
  deleteShouldFail?: boolean;
  forkShouldFail?: boolean;
  /** Frames written to the SSE connection when the prompt lands. */
  script: Array<Record<string, unknown>>;
  /** When set, the prompt never writes frames — for the abort path. */
  hangPrompt?: boolean;
};

function startFakeServe(): Promise<{
  url: string;
  state: FakeState;
  close: () => Promise<void>;
}> {
  const state: FakeState = { requests: [], script: [] };
  let sseResponse: http.ServerResponse | null = null;
  const server = http.createServer((req, res) => {
    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(bodyChunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      const path = req.url ?? '';
      state.requests.push({ method: req.method ?? '', path, body });

      if (req.method === 'GET' && path === '/api/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': connected\n\n');
        sseResponse = res;
        return;
      }
      if (req.method === 'POST' && path === `/api/session/${PARENT}/fork`) {
        if (state.forkShouldFail) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'fork exploded' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { id: CHILD, title: 'parent (fork #1)' } }));
        return;
      }
      if (req.method === 'PATCH' && path === `/api/session/${CHILD}`) {
        if (state.denyShouldFail) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'patch exploded' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (req.method === 'POST' && path === `/api/session/${CHILD}/prompt`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'msg_queued', sessionID: CHILD } }));
        if (!state.hangPrompt && sseResponse) {
          for (const frame of state.script) {
            sseResponse.write(`data: ${JSON.stringify(frame)}\n\n`);
          }
          sseResponse.write(`data: ${JSON.stringify({ type: 'server.heartbeat', data: {} })}\n\n`);
        }
        return;
      }
      if (req.method === 'POST' && path === `/api/session/${CHILD}/interrupt`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { interrupted: true } }));
        return;
      }
      if (req.method === 'DELETE' && path === `/api/session/${CHILD}`) {
        if (state.deleteShouldFail) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'delete exploded' }));
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unrouted ${req.method} ${path}` }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise<void>((resolveClose) => {
          sseResponse?.end();
          server.close(() => resolveClose());
        }),
      });
    });
  });
}

function makeRequest(overrides: Partial<SideQuestionRequest> = {}): SideQuestionRequest {
  return {
    appSessionId: 'app-1',
    providerSessionId: PARENT,
    projectPath: '/tmp/workspace',
    question: '这个会话做了什么？',
    model: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const textDeltas: string[] = [];

async function askAgainst(
  serve: { url: string },
  request: SideQuestionRequest,
): Promise<SideQuestionOutcome> {
  const client = new OpenCodeApiClient({ url: serve.url, authorization: 'Basic abc' });
  return askOpenCodeSideQuestion(request, {
    delta: (text) => textDeltas.push(text),
  }, { client });
}

const frame = (type: string, data: Record<string, unknown>) => ({ type, data: { sessionID: CHILD, ...data } });

test('a side question forks a read-only copy, streams the answer and deletes it', async () => {
  textDeltas.length = 0;
  const serve = await startFakeServe();
  serve.state.script = [
    frame('session.text.started', { messageID: 'msg_a' }),
    frame('session.text.delta', { messageID: 'msg_a', delta: '总结：' }),
    frame('session.text.delta', { messageID: 'msg_a', delta: '审查了四个 PR。' }),
    frame('session.text.ended', { messageID: 'msg_a', text: '总结：审查了四个 PR。' }),
    frame('session.execution.succeeded', {}),
  ];

  try {
    const outcome = await askAgainst(serve, makeRequest());
    assert.deepEqual(outcome, { status: 'done', answer: '总结：审查了四个 PR。' });
    assert.deepEqual(textDeltas, ['总结：', '审查了四个 PR。']);
  } finally {
    await serve.close();
  }

  const calls = serve.state.requests.map(({ method, path, body }) => ({ method, path, body }));
  assert.deepEqual(calls[0], { method: 'POST', path: `/api/session/${PARENT}/fork`, body: {} });
  assert.deepEqual(calls[1], {
    method: 'PATCH',
    path: `/api/session/${CHILD}`,
    // Read-only: every mutating action denied, so the copy cannot touch
    // anything while nobody is there to approve a request.
    body: { permissions: ['shell', 'edit', 'write', 'patch'].map((action) => ({ action, resource: '*', effect: 'deny' })) },
  });
  // The private SSE stream opens before the prompt so no frame is missed.
  assert.equal(calls[2].method, 'GET');
  assert.equal(calls[2].path, '/api/event');
  const prompt = calls.find((call) => call.method === 'POST' && call.path === `/api/session/${CHILD}/prompt`);
  assert.ok(prompt, 'the forked copy was prompted');
  assert.match(String((prompt!.body as { text: string }).text), /这个会话做了什么？/);
  assert.equal(calls[calls.length - 1].method, 'DELETE');
});

test('text segments of one turn join with the answer separator', async () => {
  textDeltas.length = 0;
  const serve = await startFakeServe();
  serve.state.script = [
    frame('session.text.ended', { messageID: 'msg_a', text: '第一段。' }),
    frame('session.text.ended', { messageID: 'msg_b', text: '第二段。' }),
    frame('session.execution.succeeded', {}),
  ];

  try {
    const outcome = await askAgainst(serve, makeRequest());
    assert.equal(outcome.status, 'done');
    // The shared side-question seam ('\n\n') separates segments.
    assert.equal((outcome as { answer: string }).answer, '第一段。\n\n第二段。');
  } finally {
    await serve.close();
  }
});

test('deltas without an ended event are still the answer', async () => {
  textDeltas.length = 0;
  const serve = await startFakeServe();
  serve.state.script = [
    frame('session.text.delta', { messageID: 'msg_a', delta: '只有增量。' }),
    frame('session.execution.succeeded', {}),
  ];

  try {
    const outcome = await askAgainst(serve, makeRequest());
    assert.deepEqual(outcome, { status: 'done', answer: '只有增量。' });
  } finally {
    await serve.close();
  }
});

test('a failed execution resolves as an error outcome with the partial answer', async () => {
  textDeltas.length = 0;
  const serve = await startFakeServe();
  serve.state.script = [
    frame('session.text.delta', { messageID: 'msg_a', delta: '说了一半' }),
    frame('session.execution.failed', {}),
  ];

  try {
    const outcome = await askAgainst(serve, makeRequest());
    assert.equal(outcome.status, 'error');
    assert.match(outcome.error, /failed/);
    assert.equal(outcome.answer, '说了一半');
  } finally {
    await serve.close();
  }
});

test('a deny-rules failure refuses the question and cleans up the fork', async () => {
  textDeltas.length = 0;
  const serve = await startFakeServe();
  serve.state.denyShouldFail = true;

  try {
    const outcome = await askAgainst(serve, makeRequest());
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.answer, '');
  } finally {
    await serve.close();
  }

  // The fork is deleted (never left writable), and the question was never
  // sent to a copy whose permissions could not be pinned.
  assert.equal(serve.state.requests.some((call) => call.method === 'POST' && call.path.endsWith('/prompt')), false);
  assert.equal(serve.state.requests.some((call) => call.method === 'DELETE'), true);
});

test('a fork failure resolves as an error outcome and touches nothing else', async () => {
  textDeltas.length = 0;
  const serve = await startFakeServe();
  serve.state.forkShouldFail = true;

  try {
    const outcome = await askAgainst(serve, makeRequest());
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.answer, '');
  } finally {
    await serve.close();
  }

  // There is no fork to pin or clean up: only the fork call itself happened.
  assert.equal(serve.state.requests.length, 1);
});

test('aborting the question interrupts and deletes the fork', async () => {
  textDeltas.length = 0;
  const serve = await startFakeServe();
  serve.state.hangPrompt = true;
  const controller = new AbortController();
  const pending = askAgainst(serve, makeRequest({ signal: controller.signal }));

  // Give the module time to reach its wait loop, then dismiss the question.
  await new Promise((resolve) => setTimeout(resolve, 120));
  controller.abort();

  const outcome = await pending;
  assert.equal(outcome.status, 'error');
  assert.match(outcome.error, /abort/i);

  await serve.close();
  assert.equal(serve.state.requests.some((call) => call.method === 'POST' && call.path.endsWith('/interrupt')), true);
  assert.equal(serve.state.requests.some((call) => call.method === 'DELETE'), true);
});

test('a failed delete does not spoil a finished answer', async () => {
  textDeltas.length = 0;
  const serve = await startFakeServe();
  serve.state.deleteShouldFail = true;
  serve.state.script = [
    frame('session.text.ended', { messageID: 'msg_a', text: '答案在此。' }),
    frame('session.execution.succeeded', {}),
  ];

  try {
    const outcome = await askAgainst(serve, makeRequest());
    assert.deepEqual(outcome, { status: 'done', answer: '答案在此。' });
  } finally {
    await serve.close();
  }
});

test('a session that never ran cannot host a side question', async () => {
  textDeltas.length = 0;
  const serve = await startFakeServe();
  try {
    const outcome = await askAgainst(serve, makeRequest({ providerSessionId: null }));
    assert.equal(outcome.status, 'error');
    assert.equal(outcome.answer, '');
  } finally {
    await serve.close();
  }
  assert.equal(serve.state.requests.length, 0);
});
