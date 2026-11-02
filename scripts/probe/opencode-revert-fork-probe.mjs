#!/usr/bin/env node
/**
 * Probe: how do the v2 revert and fork endpoints cut a conversation?
 *
 * Message editing and "fork from here" lean on two service primitives whose
 * cut semantics decide which message id the providers must pass:
 *
 *   1. ids      — the `msg_…` ids `GET /api/session/:id/message` lists are the
 *                 `session_message.id` values the history reader anchors on;
 *   2. revert   — `POST /revert/stage {messageID}` marks the named message as
 *                 the first one dropped, and `POST /revert/commit` removes it
 *                 and everything after it; a prompt sent afterwards continues
 *                 from what is left; with `files: true` the stage also
 *                 restores the files the dropped turns changed, but only in
 *                 a git repository (the engine keeps no snapshot elsewhere);
 *   3. fork     — `POST /fork {before}` copies the messages strictly before
 *                 `before` (everything when omitted) into a child session.
 *
 * Usage:
 *   node scripts/probe/opencode-revert-fork-probe.mjs [provider/model]
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const modelArg = process.argv[2] ?? 'opencode-go/beam-free';
const [modelProvider, ...modelRest] = modelArg.split('/');
const model = { providerID: modelProvider, id: modelRest.join('/') };

const password = randomBytes(32).toString('base64url');
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

const server = spawn('opencode', ['serve', '--stdio', '--port', '0'], {
  cwd: os.homedir(),
  env: { ...process.env, OPENCODE_PASSWORD: password },
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
const cleanup = () => {
  try { server.stdin.end(); } catch {}
  try { server.kill(); } catch {}
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
console.log('service:', url, 'model:', `${model.providerID}/${model.id}`);

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

const waitIdle = async (sessionId) => {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const session = await api('GET', `/api/session/${sessionId}`);
    if (session.data?.time?.idle) return session.data;
    if (Date.now() > deadline) throw new Error('session never went idle');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

const turn = async (sessionId, text) => {
  const before = (await api('GET', `/api/session/${sessionId}`)).data?.time?.idle ?? 0;
  const sent = await api('POST', `/api/session/${sessionId}/prompt`, { text });
  for (;;) {
    const idle = (await waitIdle(sessionId)).time.idle;
    if (idle !== before) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return sent.data?.id;
};

const listConversation = async (sessionId) => {
  const messages = await api('GET', `/api/session/${sessionId}/message?order=asc&limit=200`);
  return (messages.data ?? [])
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .map((message) => {
      const text = message.text ?? (message.content ?? []).map((block) => block.text ?? '').join('');
      return `${message.type}:${message.id}:${text.slice(0, 40).replace(/\n/g, ' ')}`;
    });
};

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-revert-'));
fs.writeFileSync(path.join(directory, 'note.txt'), 'original\n');
const created = await api('POST', '/api/session', { location: { directory }, title: 'revert probe' });
const sessionId = created.data.id;
console.log('session:', sessionId);
await api('POST', `/api/session/${sessionId}/model`, { model });

const firstId = await turn(sessionId, 'Reply with exactly: one');
const secondId = await turn(sessionId, 'Reply with exactly: two');
const thirdId = await turn(sessionId, 'Reply with exactly: three');
console.log('prompt ids:', firstId, secondId, thirdId);
console.log('before:', await listConversation(sessionId));

const fork = await api('POST', `/api/session/${sessionId}/fork`, { before: thirdId });
console.log('fork before third ->', fork.status, fork.data?.id, JSON.stringify(fork.data?.fork));
if (fork.data?.id) console.log('fork rows:', await listConversation(fork.data.id));
const fullFork = await api('POST', `/api/session/${sessionId}/fork`, {});
console.log('fork (no before) ->', fullFork.status, fullFork.data?.id);
if (fullFork.data?.id) console.log('full fork rows:', await listConversation(fullFork.data.id));

const staged = await api('POST', `/api/session/${sessionId}/revert/stage`, { messageID: secondId, files: true });
console.log('stage second ->', staged.status, JSON.stringify(staged.data ?? null).slice(0, 300));
console.log('after stage:', await listConversation(sessionId));
const committed = await api('POST', `/api/session/${sessionId}/revert/commit`);
console.log('commit ->', committed.status, JSON.stringify(committed.data ?? null));
console.log('after commit:', await listConversation(sessionId));

await turn(sessionId, 'Reply with exactly: replaced');
console.log('after replacement turn:', await listConversation(sessionId));

const first = await api('POST', `/api/session/${sessionId}/revert/stage`, { messageID: firstId });
console.log('stage first ->', first.status, JSON.stringify(first.data ?? null).slice(0, 200));
const firstCommit = await api('POST', `/api/session/${sessionId}/revert/commit`);
console.log('commit first ->', firstCommit.status);
console.log('after full revert:', await listConversation(sessionId));

cleanup();
process.exit(0);
