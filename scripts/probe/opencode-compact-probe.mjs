#!/usr/bin/env node
/**
 * Probe: what does the v2 `POST /api/session/:id/compact` actually do?
 *
 * The runtime's `/compact` facet leans on the service's own compaction
 * primitive, whose semantics are not what a slash-command reading suggests.
 * This probe pins them against the installed CLI (verified on v2.0.32):
 *
 *   1. admission — the endpoint returns as soon as the request is durably
 *                  queued, reporting the synthetic `compaction` message it
 *                  created (an empty body is enough; `delivery` defaults to
 *                  `steer`);
 *   2. execution — the engine runs that message as a turn of its own: the
 *                  summary streams over `session.compaction.*` events and the
 *                  turn ends with the usual `session.execution.*` terminal;
 *   3. failure   — a compaction that cannot run (unknown model) reports
 *                  `session.compaction.failed` and STILL ends the execution
 *                  with `succeeded`, which is why the run registry — not the
 *                  execution terminal — decides a `/compact` run's outcome;
 *   4. storage   — what the session keeps afterwards: v2.0.32 writes a
 *                  `type='compaction'` message row beside the conversation
 *                  (status/reason/summary), not an assistant message.
 *
 * Usage:
 *   node scripts/probe/opencode-compact-probe.mjs [provider/model]
 *   node scripts/probe/opencode-compact-probe.mjs --fail
 *
 * `--fail` compacts with an unknown model to capture the failure shape; the
 * default model is only used for the one throwaway prompt and the summary.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const failMode = args.includes('--fail');
const modelArg = args.filter((arg) => !arg.startsWith('--'))[0] ?? 'opencode-go/beam-free';
const [modelProvider, ...modelRest] = modelArg.split('/');
const model = { providerID: modelProvider, id: modelRest.join('/') };
const failModel = { providerID: 'no-such-provider', id: 'no-such-model' };

const password = randomBytes(32).toString('base64url');
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

const server = spawn('opencode', ['serve', '--stdio', '--port', '0'], {
  cwd: os.homedir(),
  env: { ...process.env, OPENCODE_PASSWORD: password },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const cleanup = () => {
  try { server.stdin.end(); } catch {}
  setTimeout(() => { try { server.kill('SIGKILL'); } catch {} }, 2_000).unref();
};
process.on('exit', cleanup);

const url = await new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error('server never reported readiness')), 20_000);
  server.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.url === 'string') {
          clearTimeout(timer);
          resolve(parsed.url);
          return;
        }
      } catch {}
    }
  });
});
console.log('service:', url, 'model:', `${model.providerID}/${model.id}`, failMode ? '(failure mode)' : '');

const api = async (method, endpoint, body) => {
  const response = await fetch(`${url}${endpoint}`, {
    method,
    headers: { authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : undefined; } catch {}
  return { status: response.status, data: parsed?.data ?? parsed };
};

const events = [];
const abort = new AbortController();
fetch(`${url}/api/event`, { headers: { authorization }, signal: abort.signal }).then(async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      try { events.push(JSON.parse(line.slice(5).trim())); } catch {}
    }
  }
}).catch(() => {});

const waitFor = (type, sessionId, timeoutMs) => new Promise((resolve, reject) => {
  const deadline = Date.now() + timeoutMs;
  const timer = setInterval(() => {
    const hit = events.find((event) => event.type === type && (event.data?.sessionID === sessionId || !sessionId));
    if (hit) { clearInterval(timer); resolve(hit); return; }
    if (Date.now() > deadline) { clearInterval(timer); reject(new Error(`timed out waiting for ${type}`)); }
  }, 200);
});

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-compact-'));
const session = await api('POST', '/api/session', { location: { directory }, title: 'compact probe' });
const sessionId = session.data.id;
console.log('session:', sessionId);

if (!failMode) {
  await api('POST', `/api/session/${sessionId}/model`, { model });
  await api('POST', `/api/session/${sessionId}/prompt`, { text: 'Reply with exactly: ok' });
  await waitFor('session.execution.succeeded', sessionId, 180_000);
  console.log('one turn done; compacting');
} else {
  await api('POST', `/api/session/${sessionId}/model`, { model: failModel });
}

events.length = 0;
const admitted = await api('POST', `/api/session/${sessionId}/compact`, {});
console.log('compact ->', admitted.status, JSON.stringify(admitted.data));

try {
  await waitFor('session.execution.succeeded', sessionId, 180_000);
} catch (error) {
  console.log('no execution terminal:', error.message);
}
for (const event of events) {
  if (event.type.startsWith('session.compaction') || event.type.startsWith('session.execution')) {
    console.log(' ', event.type, JSON.stringify(event.data).slice(0, 200));
  }
}

const messages = await api('GET', `/api/session/${sessionId}/message`);
console.log('message rows:');
for (const message of messages.data ?? []) {
  const detail = message.status ? `${message.status}${message.reason ? `/${message.reason}` : ''}` : '';
  console.log(' ', [message.type, detail].filter(Boolean).join(':'), (message.summary ?? message.text ?? '').slice(0, 60).replace(/\n/g, ' '));
}

abort.abort();
cleanup();
process.exit(0);
