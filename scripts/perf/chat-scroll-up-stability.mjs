#!/usr/bin/env node
/**
 * Scroll-UP stability harness for the "scrolling up flickers / jumps / never
 * gets anywhere" symptom class.
 *
 * Scenario (black-box, real WebUI via CDP):
 *   1. open a long session, grow history by alternating scrollTop (works
 *      around the top hysteresis lock by leaving the boundary between loads)
 *   2. park mid-history, then fire a burst of wheel-up events
 *   3. sample scrollTop/scrollHeight every animation frame + observe DOM
 *      mutations inside the scroll content (placeholder swaps)
 *
 * Assertions (red = the user's symptom):
 *   A. netProgress   — after N wheel-ups the viewport must have moved up by
 *                      at least 50% of the intended distance.
 *   B. downwardYank  — scrollTop must not move DOWN between user inputs
 *                      (each sample gap without a wheel event).
 *   C. geometryChurn — scrollHeight must not change more than a few times
 *                      while the user is parked mid-history (no input).
 *
 * Exit 0 = green, 1 = red, 2 = harness error.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const betterSqlite3 = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const BASE_URL = 'http://localhost:3001';
const ARGV = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = ARGV.indexOf(`--${name}`);
  if (i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--')) return ARGV[i + 1];
  return fallback;
};
const EXP = flagValue('exp', 'none');
const SESSION_ID = ARGV.find((a) => !a.startsWith('--') && a !== EXP)
  ?? 'sess_bb7ac328-31f6-4b4b-b89c-65d83f966b62';
const DEBUG_PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.nextId = 0; this.pending = new Map(); this.events = [];
    this.opened = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method !== undefined) this.events.push(msg);
    });
  }
  async send(method, params = {}) {
    await this.opened;
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(`${d.exception?.description ?? d.text}\n${d.stack?.callFrames?.slice(0, 5).map((f) => `  at ${f.functionName}:${f.lineNumber}`).join('\n') ?? ''}`);
    }
    return result.result.value;
  }
}

function tokenFromDb() {
  const db = new betterSqlite3(join(process.env.HOME, '.cloudcli', 'auth.db'), { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM app_config WHERE key = 'jwt_secret'").get();
    const user = db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get();
    return jwt.sign({ userId: user.id, username: user.username }, row.value, { expiresIn: '2h' });
  } finally { db.close(); }
}

const profileDir = mkdtempSync(join(tmpdir(), 'scroll-up-stab-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

const PAGE_SETUP = `
  window.__pane = () => document.querySelector('.chat-messages-pane');
  window.__rows = () => document.querySelectorAll('.chat-message').length;
  window.__sample = (label) => {
    const c = window.__pane();
    return { label, t: performance.now(), scrollTop: c.scrollTop, scrollHeight: c.scrollHeight };
  };
`;

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok) break; } catch {}
    if (i === 49) throw new Error('chrome debug endpoint never came up');
    await sleep(200);
  }
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const cdp = new Cdp(new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await sleep(1500);
  await cdp.evaluate(`localStorage.setItem('auth-token', ${JSON.stringify(tokenFromDb())})`);
  await cdp.send('Page.navigate', { url: `${BASE_URL}/session/${encodeURIComponent(SESSION_ID)}` });
  await sleep(4000);
  await cdp.evaluate(PAGE_SETUP);
  if (EXP === 'cv-off') {
    await cdp.evaluate(`(() => {
      const s = document.createElement('style');
      s.id = 'debug-cv-off';
      s.textContent = '.chat-message { content-visibility: visible !important; }';
      document.head.appendChild(s);
    })()`);
    console.error('[up-stab] EXP: content-visibility forced visible');
  }

  // ── wait for the pane to mount and settle (projects bootstrap can be slow)
  let ready = null;
  for (let i = 0; i < 60; i++) {
    ready = await cdp.evaluate(`(() => {
      const c = window.__pane();
      return c ? { rows: window.__rows(), scrollHeight: c.scrollHeight, clientHeight: c.clientHeight } : null;
    })()`);
    if (ready && ready.rows > 0 && ready.scrollHeight - ready.clientHeight > 200) break;
    await sleep(500);
  }
  if (!ready || !ready.rows) {
    const scene = await cdp.evaluate(`(() => ({
      path: location.pathname,
      bodySnippet: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 220),
      hasPaneClass: !!document.querySelector('.chat-messages-pane'),
      chatRoots: document.querySelectorAll('[class*="chat-"]').length,
    }))()`).catch((e) => ({ evalError: e.message }));
    throw new Error(`pane never became ready: ${JSON.stringify(ready)}; scene: ${JSON.stringify(scene)}`);
  }

  // ── grow history: real alternation (event-dispatched) so the hysteresis
  // lock can release between loads
  let grown = { rows: 0, scrollHeight: 0 };
  for (let round = 0; round < 22; round++) {
    grown = await cdp.evaluate(`window.__rows() > 0 ? { rows: window.__rows(), scrollHeight: window.__pane().scrollHeight } : null`);
    if (grown && grown.scrollHeight >= 6000) break;
    await cdp.evaluate(`(() => { const c = window.__pane(); c.scrollTop = 60; })()`);
    await sleep(120);
    await cdp.evaluate(`(() => { const c = window.__pane(); c.scrollTop = 0; })()`);
    await sleep(650);
  }
  grown = await cdp.evaluate(`({ rows: window.__rows(), scrollHeight: window.__pane().scrollHeight })`);
  console.error(`[up-stab] grown: ${grown.rows} rows, scrollHeight=${grown.scrollHeight}`);
  if (grown.scrollHeight < 3000) {
    console.error(`[up-stab] WARN: shallow history (${grown.scrollHeight}px); results still valid but weak`);
  }

  // ── park mid-history
  await cdp.evaluate(`(() => {
    const c = window.__pane();
    c.scrollTop = Math.floor(c.scrollHeight / 2);
  })()`);
  await sleep(1500); // let placeholders settle

  // ── C. geometry churn while parked (no input at all)
  const parked = await cdp.evaluate(`(async () => {
    const c = window.__pane();
    const samples = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) {
      samples.push(c.scrollHeight);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return samples;
  })()`);
  const distinctHeights = new Set(parked).size;
  const parkChurn = distinctHeights - 1;

  // ── wheel-up burst with per-frame sampling + jump classification
  await cdp.evaluate(`(() => {
    const c = window.__pane();
    c.scrollTop = c.scrollHeight; // start from the bottom for a long climb
    window.__burst = { samples: [], wheels: [], mutations: 0 };
    const mo = new MutationObserver((m) => {
      window.__burst.mutations += m.reduce((s, x) => s + x.addedNodes.length + x.removedNodes.length, 0);
    });
    mo.observe(c.querySelector('div[class*="max-w"]') ?? c, { childList: true, subtree: true });
    const tick = () => {
      window.__burst.samples.push({ t: performance.now(), scrollTop: c.scrollTop, scrollHeight: c.scrollHeight });
      requestAnimationFrame(tick);
    };
    window.__burst.samples.push({ t: performance.now(), scrollTop: c.scrollTop, scrollHeight: c.scrollHeight });
    requestAnimationFrame(tick);
    window.__burst.fallback = setInterval(() => {
      window.__burst.samples.push({ t: performance.now(), scrollTop: c.scrollTop, scrollHeight: c.scrollHeight });
    }, 32);
  })()`);
  await sleep(400);

  const center = await cdp.evaluate(`(() => { const r = window.__pane().getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
  const N_WHEELS = 30;
  const WHEEL_GAP_MS = 60;
  for (let i = 0; i < N_WHEELS; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: -120 });
    await cdp.evaluate(`window.__burst.wheels.push(performance.now())`);
    await sleep(WHEEL_GAP_MS);
  }
  await sleep(800); // let things settle
  const burst = await cdp.evaluate(`(() => {
    clearInterval(window.__burst.fallback);
    const c = window.__pane();
    return { ...window.__burst, maxScrollTop: c.scrollHeight - c.clientHeight, clientHeight: c.clientHeight };
  })()`);
  if (!burst.samples?.length) throw new Error('burst sampling produced no samples');
  const wsFrames = cdp.events
    .filter((e) => e.method === 'Network.webSocketFrameReceived')
    .map((e) => ({ t: e.params.timestamp, data: (e.params.response?.payloadData ?? '').slice(0, 120) }));

  // analysis: classify every significant viewport movement
  const first = burst.samples[0], last = burst.samples[burst.samples.length - 1];
  const intendedPx = N_WHEELS * 120;
  const netUp = first.scrollTop - last.scrollTop;

  const jumps = [];
  for (let i = 1; i < burst.samples.length; i++) {
    const prev = burst.samples[i - 1], cur = burst.samples[i];
    const d = cur.scrollTop - prev.scrollTop;
    if (Math.abs(d) > 30) {
      jumps.push({
        t: Math.round(cur.t - burst.samples[0].t),
        dScrollTop: Math.round(d),
        atBottom: cur.scrollTop >= burst.maxScrollTop - 2,
        dHeight: cur.scrollHeight - prev.scrollHeight,
      });
    }
  }
  const yankDown = jumps.filter((j) => j.dScrollTop > 30);
  const downwardDrift = yankDown.reduce((s, j) => s + j.dScrollTop, 0);
  const yankAtBottom = yankDown.filter((j) => j.atBottom).length;
  const yankWithHeightChange = yankDown.filter((j) => j.dHeight !== 0).length;
  const heightChanges = new Set(burst.samples.map((s) => s.scrollHeight)).size - 1;

  const verdict = {
    netProgress: {
      pass: netUp >= intendedPx * 0.5,
      detail: `net upward progress ${netUp}px after ${N_WHEELS} wheels (intended ${intendedPx}px, expect >= ${intendedPx * 0.5})`,
    },
    downwardYank: {
      pass: downwardDrift <= 50,
      detail: `viewport moved DOWN without input by ${Math.round(downwardDrift)}px across ${yankDown.length} jumps; ${yankAtBottom} landed exactly at bottom, ${yankWithHeightChange} coincided with height change (expect <= 50px)`,
    },
    geometryChurn: {
      pass: parkChurn <= 2,
      detail: `scrollHeight changed ${parkChurn}x while parked 2s no-input; ${heightChanges} distinct heights during burst; ${burst.mutations} row DOM mutations`,
    },
  };

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    session: SESSION_ID,
    rows: grown.rows,
    scrollHeight: grown.scrollHeight,
    netUp,
    intendedPx,
    downwardDrift: Math.round(downwardDrift),
    parkChurn,
    burstHeightChanges: heightChanges,
    burstMutations: burst.mutations,
    jumps: jumps.slice(0, 40),
    wsFrameCount: wsFrames.length,
    wsFrames: wsFrames.slice(-6),
    verdict,
  }, null, 2));

  const failed = Object.entries(verdict).filter(([, v]) => !v.pass);
  if (failed.length) { console.error(`[up-stab] RED: ${failed.map(([k]) => k).join(', ')}`); process.exitCode = 1; }
  else console.error('[up-stab] GREEN');
} catch (err) {
  console.error(`[up-stab] harness error: ${err.message}`);
  try {
    const errs = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => (e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text ?? '').slice(0, 400));
    const logs = cdp.events
      .filter((e) => e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning'))
      .map((e) => `[${e.params.type}] ${(e.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
    if (errs.length) console.error('[up-stab] page exceptions:\n' + errs.slice(-6).join('\n---\n'));
    if (logs.length) console.error('[up-stab] page console errors:\n' + logs.slice(-8).join('\n'));
  } catch { /* ignore */ }
  process.exitCode = 2;
} finally {
  try { chrome.kill('SIGTERM'); } catch {}
  await sleep(300);
  try { chrome.kill('SIGKILL'); } catch {}
  rmSync(profileDir, { recursive: true, force: true });
}
