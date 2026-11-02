#!/usr/bin/env node
/**
 * Probe: the question tool's form lifecycle on the v2 service (v2.0.32).
 *
 * Pins the live behavior the interaction bridge and the external-run adoption
 * depend on:
 *
 *   1. shape — `form.created` carries the form under `data.form`, with
 *      `metadata.kind === 'question'` and `fields[].key` (`q0`, …) as the
 *      answer keys;
 *   2. list  — `GET /api/session/:id/form` returns pending forms (and is what
 *      a stalled form could be reconciled from); the same-shaped
 *      `GET /api/session/:id/permission` lists pending approvals.
 *   3. reply — `POST /api/session/:id/form/:formId/reply {answer: {q0: …}}`
 *      makes the tool succeed (`form.replied` → `session.tool.success`) and
 *      the execution run to its usual terminal;
 *   4. scope — a form pending on one server instance is invisible to another
 *      instance of the same data directory (forms are in-memory server state,
 *      so a stalled question dies with its instance and can only be answered
 *      by the process that owns it).
 *
 *   node scripts/probe/opencode-form-probe.mjs [providerID/modelID]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

const [providerID, ...rest] = (process.argv.filter((a) => !a.startsWith('--'))[2] || 'opencode-go/deepseek-v4.1-flash').split('/');
const model = { providerID, id: rest.join('/') };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-form-'));
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const failures = [];
const check = (ok, label, detail) => {
  console.log(ts(), ok ? `OK  ${label}` : `FAIL ${label}`, detail === undefined ? '' : detail);
  if (!ok) failures.push(label);
};

function startServer(tag, port) {
  const password = `probe-${port}-secret`;
  const child = crossSpawn('opencode', ['serve', '--port', String(port)], {
    cwd: dir,
    stdio: 'ignore',
    env: { ...process.env, OPENCODE_PASSWORD: password },
  });
  return {
    tag,
    base: `http://127.0.0.1:${port}`,
    authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'),
    child,
  };
}

const servers = [];
function killAll() {
  for (const server of servers) {
    if (server.child.pid && process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(server.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { server.child.kill(); } catch {}
    }
  }
}
process.on('exit', killAll);

async function waitHealthy(server) {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${server.base}/global/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${server.tag} never became healthy`);
}

async function api(server, method, url, body) {
  const res = await fetch(`${server.base}${url}`, {
    method,
    headers: {
      authorization: server.authorization,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: parsed };
}

async function main() {
  const a = startServer('A', 40000 + Math.floor(Math.random() * 5000));
  const b = startServer('B', 46000 + Math.floor(Math.random() * 5000));
  servers.push(a, b);
  await waitHealthy(a);
  await waitHealthy(b);

  const created = await api(a, 'POST', '/api/session', { location: { directory: dir }, title: 'form probe' });
  const sessionId = created.body?.data?.id;
  if (!sessionId) throw new Error(`session create failed: ${created.status}`);
  const switched = await api(a, 'POST', `/api/session/${sessionId}/model`, { model });
  if (switched.status !== 204 && switched.status !== 200) {
    throw new Error(`model switch failed: ${switched.status} ${JSON.stringify(switched.body).slice(0, 200)}`);
  }
  console.log(ts(), 'session', sessionId);

  const events = [];
  const controller = new AbortController();
  const stream = await fetch(`${a.base}/api/event`, {
    headers: { authorization: a.authorization },
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
          if (!JSON.stringify(event.data ?? {}).includes(sessionId)) continue;
          events.push(event);
        } catch {}
      }
    }
  })().catch(() => {});

  await api(a, 'POST', `/api/session/${sessionId}/prompt`, {
    text: '请使用 question 工具问我一个选择题：我最喜欢哪种颜色？两个选项：红色、蓝色。只问这一个问题，问完就停下等待我的回答。',
  });

  const until = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = events.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  };

  // 1. form.created shape.
  const formCreated = await until((event) => event.type === 'form.created', 120_000);
  const form = formCreated?.data?.form;
  check(Boolean(form), 'form.created carries data.form', form && form.id ? `id=${form.id}` : '');
  check(form?.metadata?.kind === 'question', 'metadata.kind is "question"', form?.metadata?.kind);
  check(
    Array.isArray(form?.fields) && typeof form.fields[0]?.key === 'string',
    'fields[].key is the answer key',
    form?.fields?.[0]?.key,
  );
  if (!form) throw new Error('no form to continue with');

  // 2. The list route can see it.
  const listed = await api(a, 'GET', `/api/session/${sessionId}/form`);
  check(
    listed.body?.data?.some((entry) => entry.id === form.id),
    'GET /api/session/:id/form lists the pending form',
    `status=${listed.status}`,
  );

  // 2b. The permission list route answers in the same envelope (this scenario
  // asks for no approval, so it must be an empty list, not a 404/500). The
  // interaction bridge reads it beside the form list when an event-feed gap
  // loses an ask, so its shape is part of the reconcile contract.
  const approvals = await api(a, 'GET', `/api/session/${sessionId}/permission`);
  check(
    approvals.status === 200 && Array.isArray(approvals.body?.data),
    'GET /api/session/:id/permission lists pending approvals',
    `status=${approvals.status} data=${Array.isArray(approvals.body?.data) ? approvals.body.data.length : 'n/a'}`,
  );

  // 3. Reply closure: answer by field key → tool succeeds → execution ends.
  const answerKey = form.fields[0].key;
  const answerValue = form.fields[0].options?.[0]?.value ?? '红色';
  const reply = await api(a, 'POST', `/api/session/${sessionId}/form/${form.id}/reply`, {
    answer: { [answerKey]: answerValue },
  });
  check(reply.status === 204, 'form reply is accepted', `status=${reply.status}`);
  const replied = await until((event) => event.type === 'form.replied', 10_000);
  check(Boolean(replied), 'form.replied follows the answer');
  const toolSuccess = await until((event) => event.type === 'session.tool.success', 10_000);
  check(Boolean(toolSuccess), 'the question tool succeeds with the answer');
  const terminal = await until(
    (event) => event.type === 'session.execution.succeeded' || event.type === 'session.execution.failed',
    30_000,
  );
  check(terminal?.type === 'session.execution.succeeded', 'the execution ends normally', terminal?.type);

  // 4. A form pending on A is invisible to B (in-memory server state).
  const created2 = await api(a, 'POST', '/api/session', { location: { directory: dir }, title: 'form probe 2' });
  const session2 = created2.body?.data?.id;
  await api(a, 'POST', `/api/session/${session2}/model`, { model });
  const prompted = await api(a, 'POST', `/api/session/${session2}/prompt`, {
    text: '请使用 question 工具问我一个选择题：猫还是狗？只问这一个问题，问完就停下等待。',
  });
  check(prompted.status === 200, 'second prompt is accepted', `status=${prompted.status}`);
  const untilSecond = await untilSecondForm();
  check(Boolean(untilSecond), 'second session has a pending form on A');
  const onB = await api(b, 'GET', `/api/session/${session2}/form`);
  check(
    Array.isArray(onB.body?.data) && onB.body.data.length === 0,
    'instance B cannot see the form pending on A',
    `status=${onB.status}`,
  );

  async function untilSecondForm() {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const listed2 = await api(a, 'GET', `/api/session/${session2}/form`);
      if (listed2.body?.data?.length > 0) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

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
    killAll();
  });
