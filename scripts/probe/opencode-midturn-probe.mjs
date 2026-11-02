#!/usr/bin/env node
/**
 * Probe: what does `opencode serve` do with a second prompt posted while the
 * session is still busy with the first one?
 *
 * Starts a private server, sends a turn that runs a slow bash command, posts
 * a second message mid-tool, then reports whether the tool finished, whether
 * the second message was answered, and when each blocking request returned.
 *
 *   node scripts/probe/opencode-midturn-probe.mjs [providerID/modelID] [--task]
 *
 * `--task` runs the slow command inside a task-tool subagent instead.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

const useTask = process.argv.includes('--task');
const [providerID, ...rest] = (process.argv.filter((a) => !a.startsWith('--'))[2] || 'opencode-go/deepseek-v4.1-flash').split('/');
const model = { providerID, modelID: rest.join('/') };
const port = 40000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-midturn-'));
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const child = crossSpawn('opencode', ['serve', '--port', String(port)], { stdio: 'ignore' });
// On Windows the handle is the cmd.exe shim; only a tree kill reaches opencode.exe.
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

async function json(method, url, body) {
  const res = await fetch(`${base}${url}${url.includes('?') ? '&' : '?'}directory=${encodeURIComponent(dir)}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

await waitHealthy();
console.log(ts(), 'server up on', port, 'dir', dir);
const session = await json('POST', '/session', {});
const sid = session.id;
console.log(ts(), 'session', sid);

// Event stream: log tool state transitions and message lifecycle for our session.
let toolRunningSeen = false;
const toolStates = new Map();
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
        const st = props.part.state?.status;
        const key = props.part.id;
        if (toolStates.get(key) !== st) {
          toolStates.set(key, st);
          console.log(ts(), 'tool', props.part.tool, st, st === 'completed' || st === 'error'
            ? JSON.stringify(props.part.state.output ?? props.part.state.error ?? '').slice(0, 120) : '');
          if (st === 'running') toolRunningSeen = true;
        }
      } else if (p.type === 'message.updated') {
        const info = props.info;
        if (info.role === 'user') console.log(ts(), 'user message', info.id);
        else if (info.time?.completed) console.log(ts(), 'assistant done', info.id, 'finish=', info.finish, 'parent=', info.parentID);
      } else if (p.type === 'session.status') {
        console.log(ts(), 'status', JSON.stringify(props.status));
      } else if (p.type === 'session.idle') {
        console.log(ts(), 'session.idle');
      }
    }
  }
})().catch((e) => console.log('event stream ended', e.message));

const first = json('POST', `/session/${sid}/message`, {
  model,
  parts: [{ type: 'text', text: useTask
    ? 'Use the task tool to launch the general subagent with this instruction: "Use the bash tool to run exactly `sleep 20 && echo SUB_DONE` and report its output." After the subagent returns, reply with exactly: A-DONE'
    : 'Use the bash tool to run exactly this command: `sleep 20 && echo FIRST_DONE`. After it finishes, reply with exactly: A-DONE' }],
}).then((r) => { console.log(ts(), 'FIRST request resolved; returned message', r?.info?.id); return r; });

for (let i = 0; i < 120 && !toolRunningSeen; i += 1) await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, 3000));
console.log(ts(), 'posting SECOND message mid-tool');
const second = json('POST', `/session/${sid}/message`, {
  model,
  parts: [{ type: 'text', text: 'Additional note from the user: in your final reply also include the word B-SEEN.' }],
}).then((r) => { console.log(ts(), 'SECOND request resolved; returned message', r?.info?.id); return r; });

await Promise.allSettled([first, second]);
const msgs = await json('GET', `/session/${sid}/message`);
console.log('\n--- transcript ---');
for (const m of msgs) {
  const text = m.parts.map((p) => p.type === 'text' ? p.text : p.type === 'tool' ? `[tool ${p.tool}:${p.state?.status}]` : '').filter(Boolean).join(' ');
  console.log(m.info.role, m.info.id, m.info.parentID ? `parent=${m.info.parentID}` : '', '|', text.slice(0, 200));
}
cleanup();
process.exit(0);
