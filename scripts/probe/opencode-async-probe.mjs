#!/usr/bin/env node
/**
 * Probe: what does `POST /session/:id/prompt_async` actually do?
 *
 * The provider is moving turn delivery off the blocking `message` endpoint,
 * whose response only arrives when the whole turn ends. This probe pins the
 * async endpoint's real semantics before the runtime depends on them:
 *
 *   1. accept timing — does it return immediately, and with which status?
 *   2. start signal — how fast does the session flip to `busy` afterwards?
 *   3. completion  — is `session.idle` (and/or an empty status map) the end?
 *   4. failures    — what does an unknown model produce: HTTP error, event,
 *                    status, or only a stored error on the message row?
 *   5. mid-turn    — is a second async prompt absorbed by the running loop
 *                    like the blocking one (opencode-midturn-probe.mjs), and
 *                    what does the event sequence look like?
 *
 *   node scripts/probe/opencode-async-probe.mjs [providerID/modelID]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

const [providerID, ...rest] = (process.argv.filter((a) => !a.startsWith('--'))[2] || 'opencode-go/deepseek-v4.1-flash').split('/');
const model = { providerID, modelID: rest.join('/') };
const port = 40000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-async-'));
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const child = crossSpawn('opencode', ['serve', '--port', String(port)], { stdio: 'ignore' });
const cleanup = () => {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { child.kill(); } catch {}
};
process.on('exit', cleanup);

async function waitHealthy() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${base}/global/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server never became healthy');
}

function dirUrl(url) {
  return `${base}${url}${url.includes('?') ? '&' : '?'}directory=${encodeURIComponent(dir)}`;
}

async function json(method, url, body) {
  const res = await fetch(dirUrl(url), {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Async prompt: returns the raw status + timing instead of throwing. */
async function promptAsync(sessionId, body) {
  const started = Date.now();
  const res = await fetch(dirUrl(`/session/${sessionId}/prompt_async`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(ts(), `prompt_async -> ${res.status} in ${Date.now() - started}ms`, text.slice(0, 120));
  return res.status;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await waitHealthy();
console.log(ts(), 'server up on', port, 'dir', dir, 'model', `${providerID}/${model.modelID}`);
const session = await json('POST', '/session', {});
const sid = session.id;
console.log(ts(), 'session', sid);

// Event stream: log everything relevant for our session.
(async () => {
  const res = await fetch(`${base}/global/event`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let evt; try { evt = JSON.parse(line.slice(5)); } catch { continue; }
      const p = evt.payload ?? evt;
      const props = p.properties ?? {};
      const evSid = props.sessionID ?? props.info?.sessionID ?? props.part?.sessionID;
      if (evSid !== sid) continue;
      if (p.type === 'message.part.updated' && props.part?.type === 'tool') {
        console.log(ts(), 'tool', props.part.tool, props.part.state?.status, JSON.stringify(props.part.state?.output ?? props.part.state?.error ?? '').slice(0, 100));
      } else if (p.type === 'message.updated') {
        const info = props.info;
        console.log(ts(), 'message.updated', info.role, info.id, info.time?.completed ? 'completed' : '', info.error ? `ERROR=${JSON.stringify(info.error).slice(0, 200)}` : '');
      } else if (p.type === 'session.status') {
        console.log(ts(), 'session.status', JSON.stringify(props.status));
      } else if (p.type === 'session.idle') {
        console.log(ts(), 'session.idle');
      } else if (p.type === 'session.error') {
        console.log(ts(), 'session.error', JSON.stringify(props.error).slice(0, 300));
      } else if (p.type === 'message.part.delta') {
        // too chatty; ignore
      } else {
        console.log(ts(), 'event', p.type);
      }
    }
  }
})().catch((e) => console.log(ts(), 'event stream ended', e.message));

/** Polls the status map while active, logging transitions only. */
let pollActive = true;
(async () => {
  let last = 'unset';
  while (pollActive) {
    try {
      const map = await json('GET', '/session/status');
      const state = map?.[sid]?.type ?? 'absent';
      if (state !== last) {
        console.log(ts(), 'status poll:', state);
        last = state;
      }
    } catch (e) {
      console.log(ts(), 'status poll failed', e.message);
    }
    await sleep(500);
  }
})();

// ---- 1. basic async turn -------------------------------------------------
console.log(ts(), '--- basic async turn ---');
await promptAsync(sid, { model, parts: [{ type: 'text', text: 'Reply with exactly: PONG-ONE' }] });
await sleep(25_000);

// ---- 2. bad model --------------------------------------------------------
console.log(ts(), '--- unknown model ---');
await promptAsync(sid, { model: { providerID: 'no-such-provider', modelID: 'no-such-model' }, parts: [{ type: 'text', text: 'hello?' }] });
await sleep(10_000);

// ---- 3. mid-turn async injection ------------------------------------------
console.log(ts(), '--- slow turn starts; injecting mid-tool ---');
await promptAsync(sid, { model, parts: [{ type: 'text', text: 'Use the bash tool to run exactly this command: `sleep 20 && echo TOOL_DONE`. After it finishes, reply with exactly: SLOW-DONE' }] });
await sleep(8_000);
await promptAsync(sid, { model, parts: [{ type: 'text', text: 'Additional note from the user: in your final reply also include the word NOTE-SEEN.' }] });
await sleep(30_000);

// ---- transcript -----------------------------------------------------------
pollActive = false;
await sleep(600);
try {
  const msgs = await json('GET', `/session/${sid}/message`);
  console.log('\n--- transcript ---');
  for (const m of msgs) {
    const text = m.parts.map((p) => p.type === 'text' ? p.text : p.type === 'tool' ? `[tool ${p.tool}:${p.state?.status}]` : '').filter(Boolean).join(' ');
    console.log(m.info.role, m.info.id, m.info.parentID ? `parent=${m.info.parentID}` : '', m.info.error ? 'ERROR' : '', '|', text.slice(0, 160));
  }
} catch (e) {
  console.log('transcript read failed', e.message);
}

console.log('\nfinal status:', JSON.stringify(await json('GET', '/session/status')));
cleanup();
process.exit(0);
