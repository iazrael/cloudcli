#!/usr/bin/env node
/**
 * Probe: how does `opencode serve` (v2) represent a subagent launch and the
 * child session it runs?
 *
 * Starts a private server, has one real agent call the `subagent` tool, and
 * reports, from both the live event feed and the persisted transcript:
 *
 *   1. the parent tool block — where the child session id and agent name sit
 *      (`state.metadata.sessionID`, `state.input.agent`), and how the tool's
 *      own status differs from the child's;
 *   2. the child session row (`session_v2.parent_id`, `agent`,
 *      `idle_outcome`) and that its messages are ordinary session rows;
 *   3. the live child events — their `data.sessionID`, message/tool/terminal
 *      types, and whether `session.created` names the parent.
 *
 *   node scripts/probe/opencode-subagent-probe.mjs [providerID/modelID]
 *
 * The launch is foreground (background: false) so the parent tool block settles
 * before the transcript is read; the child still emits its own live stream.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import crossSpawn from 'cross-spawn';

const [providerID, ...rest] = (process.argv.filter((a) => !a.startsWith('--'))[2] || 'opencode-go/deepseek-v4.1-flash').split('/');
const model = { providerID, id: rest.join('/') };
const port = 40000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const password = `probe-${port}-secret`;
const authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-subagent-'));
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const failures = [];
const check = (ok, label, detail) => {
  console.log(ts(), ok ? `OK  ${label}` : `FAIL ${label}`, detail === undefined ? '' : detail);
  if (!ok) failures.push(label);
};

const child = crossSpawn('opencode', ['serve', '--port', String(port)], {
  cwd: dir,
  stdio: 'ignore',
  env: { ...process.env, OPENCODE_PASSWORD: password },
});
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
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${base}/global/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server never became healthy');
}

async function api(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      authorization,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: parsed };
}

const payloadSessionId = (event) => {
  const data = event?.data ?? {};
  return data.sessionID
    ?? data.info?.sessionID
    ?? data.info?.id
    ?? data.part?.sessionID
    ?? data.form?.sessionID
    ?? null;
};

const summarizePart = (part) => ({
  type: part?.type,
  name: part?.name ?? part?.tool,
  id: part?.id ?? part?.callID,
  status: part?.state?.status,
  metadata: part?.state?.metadata,
});

async function main() {
  await waitHealthy();
  console.log(ts(), 'server up on', port, 'dir', dir);

  const created = await api('POST', '/api/session', { location: { directory: dir }, title: 'subagent probe' });
  const parentId = created.body?.data?.id;
  if (!parentId) throw new Error(`session create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const switched = await api('POST', `/api/session/${parentId}/model`, { model });
  if (switched.status !== 204 && switched.status !== 200) {
    throw new Error(`model switch failed: ${switched.status} ${JSON.stringify(switched.body).slice(0, 300)}`);
  }
  console.log(ts(), 'parent session', parentId);

  const events = [];
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/event`, {
    headers: { authorization, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  (async () => {
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          if (event && typeof event.type === 'string') events.push(event);
        } catch {}
      }
    }
  })().catch(() => {});

  const prompt = [
    'Call the `subagent` tool exactly once, with agent "general", background false,',
    'and this prompt for the child: "Run the bash tool with the command `echo SUBAGENT_OK`',
    'and reply with exactly SUBAGENT_OK."',
    'After the subagent returns, reply with exactly PARENT_DONE.',
  ].join(' ');
  const prompted = await api('POST', `/api/session/${parentId}/prompt`, { text: prompt });
  check(prompted.status === 200, 'prompt is accepted', `status=${prompted.status}`);

  const until = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = events.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  };

  const terminal = await until(
    (event) => event.type === 'session.execution.succeeded' || event.type === 'session.execution.failed',
    180_000,
  );
  check(Boolean(terminal), 'parent execution reached a terminal event', terminal?.type ?? 'timeout');
  // Let the last message rows land before reading the persisted transcript.
  await new Promise((r) => setTimeout(r, 1000));

  const transcript = await api('GET', `/api/session/${parentId}/message`);
  check(transcript.status === 200, 'parent transcript is readable', `status=${transcript.status}`);
  const messages = Array.isArray(transcript.body?.data)
    ? transcript.body.data
    : Array.isArray(transcript.body) ? transcript.body : [];
  const subagentPart = messages
    .flatMap((message) => message.parts ?? message.content ?? [])
    .find((part) => (part?.name ?? part?.tool) === 'subagent' || (part?.name ?? part?.tool) === 'task');
  check(Boolean(subagentPart), 'parent transcript carries the subagent tool block', subagentPart?.name);
  if (subagentPart) {
    console.log(ts(), 'parent subagent block:');
    console.log(JSON.stringify({
      id: subagentPart.id,
      name: subagentPart.name,
      status: subagentPart.state?.status,
      input: {
        agent: subagentPart.state?.input?.agent,
        description: subagentPart.state?.input?.description,
        background: subagentPart.state?.input?.background,
      },
      metadata: subagentPart.state?.metadata,
      content: subagentPart.state?.content,
    }, null, 2));
  }

  const childSessionId = subagentPart?.state?.metadata?.sessionID ?? null;
  check(Boolean(childSessionId), 'child session id sits in state.metadata.sessionID', childSessionId ?? 'missing');

  if (subagentPart?.id) {
    for (const event of events) {
      if (event.data?.id === subagentPart.id && event.type.startsWith('session.tool.')) {
        console.log(ts(), `launch ${event.type}:`, JSON.stringify(event.data).slice(0, 2000));
      }
    }
  }

  // The persisted child row is where status and identity are authoritative.
  let childRow = null;
  try {
    const db = new Database(path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      childRow = db.prepare(
        'SELECT id, parent_id, title, agent, model, time_idle, idle_outcome FROM session_v2 WHERE id = ?',
      ).get(childSessionId) ?? null;
    } finally {
      db.close();
    }
  } catch (error) {
    console.log(ts(), 'could not read opencode.db:', error.message);
  }
  check(childRow?.parent_id === parentId, 'child row names the parent session', childRow?.parent_id ?? 'missing');
  check(typeof childRow?.agent === 'string' && childRow.agent.length > 0, 'child row records the agent name', childRow?.agent);
  console.log(ts(), 'child row:', JSON.stringify(childRow));

  const childEvents = childSessionId
    ? events.filter((event) => payloadSessionId(event) === childSessionId)
    : [];
  const childTypes = [...new Set(childEvents.map((event) => event.type))];
  check(childEvents.length > 0, 'child session has its own live event stream', `${childEvents.length} events`);
  check(
    childTypes.includes('session.tool.called') || childTypes.includes('session.tool.success'),
    'child tool events are visible on the global feed',
    childTypes.filter((type) => type.startsWith('session.tool')).join(', ') || 'none',
  );
  check(
    childTypes.includes('session.execution.succeeded') || childTypes.includes('session.execution.failed'),
    'child execution has a terminal event of its own',
    childTypes.filter((type) => type.startsWith('session.execution')).join(', ') || 'none',
  );
  console.log(ts(), 'child event types:', childTypes.join(', '));

  const createdEvent = events.find((event) =>
    (event.type === 'session.created' || event.type === 'session.updated')
    && (event.data?.info?.id === childSessionId || event.data?.info?.parentID === parentId));
  const childCreated = childSessionId
    ? events.find((event) => event.type === 'session.created' && payloadSessionId(event) === childSessionId)
    : null;
  console.log(ts(), 'session lifecycle event for child:', childCreated
    ? JSON.stringify({ type: childCreated.type, data: childCreated.data })
    : createdEvent
      ? JSON.stringify({ type: createdEvent.type, data: createdEvent.data })
      : 'none observed');

  const parentSubagentEvents = events.filter((event) => {
    if (event.type.startsWith('session.tool.')) {
      return event.data?.name === 'subagent' || event.data?.tool === 'subagent'
        || event.data?.input?.agent !== undefined;
    }
    return false;
  });
  for (const event of parentSubagentEvents) {
    console.log(ts(), `parent ${event.type}:`, JSON.stringify(event.data).slice(0, 2000));
  }

  const childToolEvent = childEvents.find((event) => event.type === 'session.tool.called');
  if (childToolEvent) {
    console.log(ts(), 'first child tool event:', JSON.stringify({
      type: childToolEvent.type,
      sessionID: payloadSessionId(childToolEvent),
      data: childToolEvent.data,
    }, null, 2).slice(0, 1500));
  }
  const childTextEvent = childEvents.find((event) => event.type === 'session.text.delta');
  if (childTextEvent) {
    console.log(ts(), 'first child text event:', JSON.stringify({
      type: childTextEvent.type,
      sessionID: payloadSessionId(childTextEvent),
      data: childTextEvent.data,
    }, null, 2).slice(0, 800));
  }
  const parentPermission = events.find((event) => event.type === 'permission.asked' && payloadSessionId(event) === parentId);
  console.log(ts(), 'permission.asked on parent (expected none for this prompt):', Boolean(parentPermission));

  controller.abort();
  console.log(ts(), failures.length === 0 ? 'PROBE OK' : `PROBE FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(ts(), 'probe crashed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
