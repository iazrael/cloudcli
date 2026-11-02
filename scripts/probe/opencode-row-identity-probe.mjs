#!/usr/bin/env node
/**
 * Probe: what identity does one OpenCode assistant text part carry on both
 * transports?
 *
 * The chat client retires a streamed reply by `providerRowKey`; both the live
 * events and the history reader must derive that key the same way or the
 * reply renders beside its persisted copy until the session is reloaded (the
 * duplicate this probe was written for). Its facts, pinned against the
 * installed CLI (v2.0.32, client mode):
 *
 *   1. live — `session.text.*` / `session.reasoning.*` events carry
 *             `assistantMessageID` plus an `ordinal` that counts parts of
 *             THEIR OWN KIND: a message holding [reasoning, text] opens both
 *             at ordinal 0. There is no part id anywhere in the payload.
 *   2. stored — v2 keeps one `session_message` row per assistant message;
 *             its `content` array holds the blocks in engine order, and the
 *             blocks carry no ids either. The text part's ordinal is its
 *             position among the message's text blocks.
 *   3. agreement — the app's derivation (`buildOpenCodeTextRowKey`: message
 *             id + text-part ordinal) therefore names the same row on both
 *             paths. This probe prints the live ordinals, the persisted block
 *             layout, and the resulting keys side by side, then says MATCH or
 *             MISMATCH.
 *
 * The prompt runs one real turn (a shell call plus a closing text, and a
 * reasoning block when the model produces one) on the given model, so it
 * spends a little quota; the throwaway session lives in a temp directory.
 *
 * Usage:
 *   node scripts/probe/opencode-row-identity-probe.mjs [provider/model]
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import crossSpawn from 'cross-spawn';

const modelArg = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'opencode-go/deepseek-v4.1-flash';
const [modelProvider, ...modelRest] = modelArg.split('/');
const model = { providerID: modelProvider, id: modelRest.join('/') };

const password = randomBytes(32).toString('base64url');
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

const server = crossSpawn('opencode', ['serve', '--stdio', '--port', '0'], {
  cwd: os.homedir(),
  env: { ...process.env, OPENCODE_PASSWORD: password },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const cleanup = () => {
  try { server.stdin.end(); } catch {}
  if (process.platform === 'win32' && server.pid) {
    spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
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

/** Live coordinates, in arrival order: `{messageId}:{kind}:{ordinal}` → delta text. */
const liveParts = new Map();
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
      let event;
      try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
      events.push(event);
      if (event.type === 'session.text.delta' || event.type === 'session.reasoning.delta') {
        const { assistantMessageID, ordinal, delta } = event.data ?? {};
        const kind = event.type.includes('reasoning') ? 'reasoning' : 'text';
        const key = `${assistantMessageID}:${kind}:${ordinal}`;
        liveParts.set(key, (liveParts.get(key) ?? '') + (delta ?? ''));
      }
    }
  }
}).catch(() => {});

const waitFor = (type, sessionId, timeoutMs) => new Promise((resolve, reject) => {
  const deadline = Date.now() + timeoutMs;
  const timer = setInterval(() => {
    const hit = events.find((event) => event.type === type && event.data?.sessionID === sessionId);
    if (hit) { clearInterval(timer); resolve(hit); return; }
    if (Date.now() > deadline) { clearInterval(timer); reject(new Error(`timed out waiting for ${type}`)); }
  }, 200);
});

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-row-identity-'));
const session = await api('POST', '/api/session', { location: { directory }, title: 'row identity probe' });
const sessionId = session.data.id;
console.log('session:', sessionId);

await api('POST', `/api/session/${sessionId}/model`, { model });
await api('POST', `/api/session/${sessionId}/prompt`, {
  text: 'Use the shell tool to run exactly `echo probe`. Then reply with exactly: PROBE-DONE',
});
try {
  await waitFor('session.execution.succeeded', sessionId, 240_000);
} catch (error) {
  console.log('no execution terminal:', error.message);
}

console.log('\nlive parts (message : kind : ordinal -> text):');
for (const [key, text] of liveParts) {
  console.log(' ', key, '->', JSON.stringify(text.slice(0, 60)));
}

/** The app-side derivation under test: message id + text-part ordinal. */
const keyOf = (messageId, ordinal) => `opencode-part:${messageId}_text_${ordinal}`;

console.log('\npersisted assistant rows and the keys the app derives from them:');
const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare(`
  SELECT id, data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq
`).all(sessionId);
db.close();

const historyKeys = new Set();
for (const row of rows) {
  const content = JSON.parse(row.data)?.content ?? [];
  let textOrdinal = 0;
  const blocks = content.map((block, index) => {
    if (block.type !== 'text') return `[${index}]${block.type}`;
    historyKeys.add(keyOf(row.id, textOrdinal));
    const label = `[${index}]text(ordinal ${textOrdinal}) key ${keyOf(row.id, textOrdinal)}`;
    textOrdinal += 1;
    return label;
  });
  console.log(' ', row.id, '::', blocks.join('  '));
}

const liveKeys = new Set(
  [...liveParts.keys()]
    .filter((key) => key.includes(':text:'))
    .map((key) => {
      const [messageId, , ordinal] = key.split(':');
      return keyOf(messageId, ordinal);
    }),
);

console.log('\nlive keys:   ', [...liveKeys].join(', ') || '(none)');
console.log('history keys:', [...historyKeys].join(', ') || '(none)');
const matched = [...liveKeys].every((key) => historyKeys.has(key));
console.log(matched && liveKeys.size > 0
  ? 'MATCH: every live text part is claimed by a persisted row'
  : 'MISMATCH: a streamed reply would render beside its persisted copy');

abort.abort();
cleanup();
process.exit(0);
