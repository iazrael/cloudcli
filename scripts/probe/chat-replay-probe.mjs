#!/usr/bin/env node
// Live-server probe for the chat.subscribe replay contract (seq watermark).
//
// Phase 1 needs no engine: subscribes to an unknown session and asserts the
// chat_subscribed ack carries the wire fields (numeric lastSeq, boolean stale).
//
// Phase 2 drives one real provider run, disconnects mid-run, reconnects, and
// asserts the replayed frames continue the pre-disconnect seq exactly — the
// regression this guards is a client silently losing the events fired while
// it was disconnected (they used to be dropped whenever any earlier run had
// advanced the client's lastSeq). Skips gracefully when no engine is
// available; run against a deployed server (it exercises the real process).
//
// Usage: node scripts/probe/chat-replay-probe.mjs [--base-url http://localhost:3001] [--provider claude] [--skip-engine]

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const baseUrl = argValue('--base-url', 'http://localhost:3001').replace(/\/$/, '');
const provider = argValue('--provider', 'claude');
const skipEngine = args.includes('--skip-engine');

function fail(message) {
  console.error(`[probe] RED: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth: sign a JWT from the runtime database's jwt_secret (never logged).
// ---------------------------------------------------------------------------

function signToken() {
  const script = `
    const Database = require('${repoRoot}/node_modules/better-sqlite3');
    const jwt = require('${repoRoot}/node_modules/jsonwebtoken');
    const db = new Database(process.env.HOME + '/.cloudcli/auth.db', { readonly: true });
    const row = db.prepare("SELECT value FROM app_config WHERE key='jwt_secret'").get();
    if (!row) { console.error('no jwt_secret'); process.exit(2); }
    const user = db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get();
    if (!user) { console.error('no user'); process.exit(2); }
    process.stdout.write(jwt.sign({ userId: user.id, username: user.username }, row.value, { expiresIn: '1h' }));
  `;
  return execFileSync('node', ['-e', script], { encoding: 'utf8' });
}

const token = signToken();

// ---------------------------------------------------------------------------
// Minimal ws + REST helpers.
// ---------------------------------------------------------------------------

async function rest(method, urlPath, body) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${urlPath} -> ${response.status}: ${await response.text()}`);
  }
  return response.json().catch(() => ({}));
}

/**
 * Opens a websocket and collects frames until `stop` returns true (or idleMs
 * of silence passes). Resolves { frames, close } — call close() when done.
 */
function openSocket({ onFrame, idleMs = 15000 } = {}) {
  const { WebSocket } = require(`${repoRoot}/node_modules/ws`);
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws?token=${token}`);
  const frames = [];
  let idleTimer = null;
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ws.close(), idleMs);
    idleTimer.unref?.();
  };
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      bumpIdle();
      resolve({
        frames,
        send: (payload) => { ws.send(JSON.stringify(payload)); bumpIdle(); },
        close: () => { if (idleTimer) clearTimeout(idleTimer); ws.close(); },
      });
    });
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      onFrame?.(frame);
      bumpIdle();
    });
    ws.on('error', reject);
  });
}

function waitFor(frames, predicate, description) {
  return waitForCount(frames, predicate, description, 1).then((found) => found[0]);
}

/** Resolves with the matching frames once `count` of them exist. */
function waitForCount(frames, predicate, description, count) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      const found = frames.filter(predicate);
      if (found.length >= count) return resolve(found);
      if (Date.now() - startedAt > 30000) return reject(new Error(`timeout waiting for ${description}`));
      setTimeout(poll, 100);
    };
    poll();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Phase 1 — ack wire shape (no engine needed).
// ---------------------------------------------------------------------------

{
  const socket = await openSocket();
  socket.send({ type: 'chat.subscribe', sessions: [{ sessionId: 'probe-unknown-session', lastSeq: 7 }] });
  const ack = await waitFor(socket.frames, (frame) => frame.kind === 'chat_subscribed', 'chat_subscribed ack');
  if (typeof ack.lastSeq !== 'number') fail(`ack.lastSeq should be a number, got ${JSON.stringify(ack.lastSeq)}`);
  if (typeof ack.stale !== 'boolean') fail(`ack.stale should be a boolean, got ${JSON.stringify(ack.stale)}`);
  if (ack.lastSeq !== 0) fail(`unknown session should ack lastSeq 0, got ${ack.lastSeq}`);
  if (ack.stale !== false) fail(`unknown session should not be stale`);
  socket.close();
  console.log('[probe] phase 1 GREEN: ack carries numeric lastSeq + boolean stale');
}

// ---------------------------------------------------------------------------
// Phase 2 — real run: disconnect mid-run, assert replay continues the seq.
// ---------------------------------------------------------------------------

if (skipEngine) {
  console.log('[probe] --skip-engine: phase 2 skipped');
  process.exit(0);
}

const scratch = await mkdtemp(path.join(tmpdir(), 'chat-replay-probe-'));
try {
  await writeFile(path.join(scratch, 'README.md'), '# replay probe scratch\n');
  const created = await rest('POST', '/api/providers/sessions', { provider, projectPath: scratch });
  const sessionId = created.data?.sessionId || created.session?.sessionId || created.sessionId;
  if (!sessionId) fail(`could not create app session: ${JSON.stringify(created).slice(0, 200)}`);

  const prompt = 'Count from 1 to 60, one number per line, no other text. Take your time.';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const first = await openSocket({ idleMs: 45000 });
    first.send({ type: 'chat.send', sessionId, content: attempt === 1 ? prompt : `${prompt} Try ${attempt}.`, options: {} });

    // Drop the socket as soon as a few sequenced events have flowed so the
    // run is guaranteed to still be live (a completed run cannot exercise
    // the replay path).
    await waitFor(first.frames, (frame) => typeof frame.seq === 'number' && frame.kind !== 'chat_subscribed', 'first live event');
    await waitForCount(
      first.frames,
      (frame) => typeof frame.seq === 'number' && frame.kind !== 'chat_subscribed',
      'a few live events',
      3,
    ).catch(() => { /* the run may be ending; the completeness check below decides */ });
    const seenBefore = first.frames.filter((frame) => typeof frame.seq === 'number');
    if (seenBefore.length < 2 || first.frames.some((frame) => frame.kind === 'complete')) {
      first.close();
      if (attempt < 2) continue;
      console.log('[probe] phase 2 YELLOW: run finished before the disconnect on every attempt');
      process.exit(0);
    }
    const lastSeqBeforeDisconnect = seenBefore.at(-1).seq;
    first.close();

    // Reconnect and ask for exactly what we missed.
    const second = await openSocket({ idleMs: 45000 });
    second.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: lastSeqBeforeDisconnect }] });
    await waitFor(second.frames, (frame) => frame.kind === 'chat_subscribed', 'reconnect ack');
    await waitFor(second.frames, (frame) => frame.kind === 'complete', 'run complete');

    const replayed = second.frames.filter((frame) => typeof frame.seq === 'number' && frame.seq > lastSeqBeforeDisconnect);
    if (replayed.length === 0) {
      fail(`no replay after reconnect: lastSeqBeforeDisconnect=${lastSeqBeforeDisconnect}, frames=${second.frames.length}`);
    }
    const seqs = replayed.map((frame) => frame.seq);
    const firstReplayed = seqs[0];
    if (firstReplayed !== lastSeqBeforeDisconnect + 1) {
      fail(`replay must continue the seq exactly: expected ${lastSeqBeforeDisconnect + 1}, got ${firstReplayed}`);
    }
    for (let i = 1; i < seqs.length; i++) {
      if (seqs[i] !== seqs[i - 1] + 1) fail(`seq gap in replay: ${seqs[i - 1]} -> ${seqs[i]}`);
    }
    const ack = second.frames.find((frame) => frame.kind === 'chat_subscribed');
    if (ack.lastSeq < lastSeqBeforeDisconnect) fail(`ack watermark ${ack.lastSeq} predates the disconnect seq ${lastSeqBeforeDisconnect}`);

    // Steady state: once the run is complete, a fresh subscribe must report
    // the watermark exactly at the last replayed seq.
    const third = await openSocket({ idleMs: 45000 });
    third.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
    const finalAck = await waitFor(third.frames, (frame) => frame.kind === 'chat_subscribed', 'final ack');
    third.close();
    if (finalAck.lastSeq !== seqs.at(-1)) fail(`final watermark ${finalAck.lastSeq} != last seq ${seqs.at(-1)}`);

    second.close();

    console.log(`[probe] phase 2 GREEN: disconnected at seq ${lastSeqBeforeDisconnect}, replayed ${replayed.length} frames continuing at seq ${firstReplayed}, no gaps, final watermark ${finalAck.lastSeq}`);
    process.exit(0);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
