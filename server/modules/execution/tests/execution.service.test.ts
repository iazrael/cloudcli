import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createExecutionService } from '../execution.service.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloudcli-execution-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  let settle!: (result: { success: boolean; stopped: boolean; error?: string }) => void;
  let emit!: (message: unknown) => void;
  let launches = 0;
  let cancels = 0;
  let cancelWorks = true;
  const options = {
    directory: join(root, 'records'), roots: [workspace],
    capabilities: async () => [{ provider: 'zcode', models: ['test-model'] }],
    launch(input: { sessionId: string }, send: (message: unknown) => void) {
      launches++;
      emit = send;
      return {
        done: new Promise<{ success: boolean; stopped: boolean; error?: string }>((resolve) => { settle = resolve; }),
        cancel: async () => {
          cancels++;
          if (cancelWorks) settle({ success: false, stopped: true });
          return cancelWorks;
        },
      };
    },
    createSession: () => 'app-session-1',
    sessionExists: () => true,
  };
  const service = createExecutionService(options);
  const request = { requestId: 'request-1', provider: 'zcode', model: 'test-model', cwd: workspace, prompt: 'do task', permissionMode: 'default' };
  return { root, workspace, options, service, request, emit: (m: unknown) => emit(m), settle: (r: { success: boolean; stopped: boolean }) => settle(r), counts: () => ({ launches, cancels }), failCancel: () => { cancelWorks = false; }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('start is idempotent; streams output; keeps session identity for continuation', async () => {
  const f = fixture();
  try {
    const first = await f.service.start(f.request);
    const again = await f.service.start(f.request);
    assert.equal(first.runId, again.runId);
    assert.equal(first.sessionId, 'app-session-1');
    assert.equal(f.counts().launches, 1);
    await assert.rejects(f.service.start({ ...f.request, prompt: 'changed' }), /requestId/);
    await assert.rejects(f.service.continue({ ...f.request, requestId: 'next', sessionId: first.sessionId }), /运行/);
    f.emit({ kind: 'text', role: 'assistant', content: 'done' });
    f.settle({ success: true, stopped: true });
    await new Promise((resolve) => setImmediate(resolve));
    const result = f.service.get({ runId: first.runId, cursor: 0 });
    assert.equal(result.state, 'succeeded');
    assert.equal(result.stopConfirmed, true);
    assert.equal(result.response, 'done');
    assert.equal(result.events.length, 1);
    assert.equal(f.service.get({ runId: first.runId, cursor: result.cursor }).events.length, 0);
    const next = await f.service.continue({ ...f.request, requestId: 'next', sessionId: first.sessionId });
    assert.notEqual(next.runId, first.runId);
    assert.equal(next.sessionId, first.sessionId);
    f.settle({ success: true, stopped: true });
    await new Promise((resolve) => setImmediate(resolve));
  } finally { f.cleanup(); }
});

test('rejects unknown engines, invalid cursors, symlink escapes and foreign sessions', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.start({ ...f.request, provider: 'missing' }), /provider/);
    await assert.rejects(f.service.start({ ...f.request, cwd: f.root }), /允许目录/);
    symlinkSync(f.root, join(f.workspace, 'escape'));
    await assert.rejects(f.service.start({ ...f.request, cwd: join(f.workspace, 'escape') }), /允许目录/);
    await assert.rejects(f.service.continue({ ...f.request, sessionId: 'foreign' }), /会话/);
    assert.throws(() => f.service.get({ runId: '../escape' }), /runId/);
    const run = await f.service.start(f.request);
    assert.throws(() => f.service.get({ runId: run.runId, cursor: -1 }), /cursor/);
    assert.throws(() => f.service.get({ runId: run.runId, cursor: 1 }), /cursor/);
    f.settle({ success: true, stopped: true });
    await new Promise((resolve) => setImmediate(resolve));
  } finally { f.cleanup(); }
});

test('approval pauses execution; rejected cancellation never confirms stop or changes a later failure', async () => {
  const f = fixture();
  try {
    const run = await f.service.start(f.request);
    f.emit({ kind: 'permission_request', requestId: 'approval-1' });
    assert.equal(f.service.get({ runId: run.runId }).state, 'waiting_approval');
    f.failCancel();
    const rejected = await f.service.cancel({ runId: run.runId });
    assert.equal(rejected.stopConfirmed, false);
    assert.equal(rejected.state, 'waiting_approval');
    f.emit({ kind: 'permission_resolved', requestId: 'approval-1' });
    assert.equal(f.service.get({ runId: run.runId }).state, 'running');
    f.settle({ success: false, stopped: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.service.get({ runId: run.runId }).state, 'failed');
  } finally { f.cleanup(); }
});

test('restarts preserve finished results and idempotency; active runs become uncertain interruptions', async () => {
  const f = fixture();
  try {
    const run = await f.service.start(f.request);
    const restarted = createExecutionService(f.options);
    const interrupted = restarted.get({ runId: run.runId });
    assert.equal(interrupted.state, 'interrupted');
    assert.equal(interrupted.stopConfirmed, false);
    assert.equal((await restarted.start(f.request)).runId, run.runId);
    await assert.rejects(restarted.continue({ ...f.request, requestId: 'next', sessionId: run.sessionId }), /停止/);
  } finally { f.cleanup(); }
});

test('provider returning before its work stops must not produce a successful terminal result', async () => {
  const f = fixture();
  try {
    const run = await f.service.start(f.request);
    f.settle({ success: false, stopped: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.service.get({ runId: run.runId }).stopConfirmed, false);
    assert.equal(f.service.get({ runId: run.runId }).state, 'running');
    const result = await f.service.cancel({ runId: run.runId });
    assert.equal(result.stopConfirmed, false);
  } finally { f.cleanup(); }
});

test('reconstructs streamed assistant replies and pages oversized events without splitting UTF-8', async () => {
  const f = fixture();
  try {
    const run = await f.service.start(f.request);
    f.emit({ kind: 'stream_delta', role: 'assistant', content: '调查中' });
    f.emit({ kind: 'stream_end' });
    f.emit({ kind: 'stream_delta', role: 'assistant', content: '交付' });
    f.emit({ kind: 'stream_delta', role: 'assistant', content: '完成' });
    for (let index = 0; index < 5; index++) f.emit({ kind: 'tool_result', content: '汉'.repeat(30_000) });
    f.settle({ success: true, stopped: true });
    await new Promise((resolve) => setImmediate(resolve));
    const result = f.service.get({ runId: run.runId });
    assert.equal(result.response, '交付完成');
    assert.equal(result.events.length, 9);
    assert.ok(JSON.stringify(result.events).includes('truncated'));
    assert.equal(JSON.stringify(result.events).includes('\ufffd'), false);
  } finally { f.cleanup(); }
});

test('concurrent duplicate starts launch once; finished results survive a service restart', async () => {
  const f = fixture();
  try {
    const [one, two] = await Promise.all([f.service.start(f.request), f.service.start(f.request)]);
    assert.equal(one.runId, two.runId);
    assert.equal(f.counts().launches, 1);
    f.settle({ success: true, stopped: true });
    await new Promise((resolve) => setImmediate(resolve));
    const restarted = createExecutionService(f.options);
    assert.equal(restarted.get({ runId: one.runId }).state, 'succeeded');
    assert.equal((await restarted.start(f.request)).runId, one.runId);
  } finally { f.cleanup(); }
});


test('accepted cancellation waits for runtime settlement before confirming stop', async () => {
  const f = fixture();
  try {
    const run = await f.service.start(f.request);
    const cancelled = await f.service.cancel({ runId: run.runId });
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.stopConfirmed, true);
    assert.equal(f.counts().cancels, 1);
  } finally { f.cleanup(); }
});

test('cancel by requestId never launches work and prevents a delayed start, including after restart', async () => {
  const f = fixture();
  try {
    const cancelled = await f.service.cancel({ requestId: f.request.requestId });
    assert.equal(cancelled.stopConfirmed, true);
    assert.equal(f.counts().launches, 0);
    await assert.rejects(f.service.start(f.request), /已取消/);
    const restarted = createExecutionService(f.options);
    await assert.rejects(restarted.start(f.request), /已取消/);
    assert.equal(f.counts().launches, 0);
  } finally { f.cleanup(); }
});

test('cancel during capability lookup blocks the pending launch', async () => {
  const f = fixture();
  try {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const service = createExecutionService({ ...f.options, capabilities: async () => { await waiting; return [{ provider: 'zcode', models: ['test-model'] }]; } });
    const pending = service.start(f.request);
    await service.cancel({ requestId: f.request.requestId });
    release();
    await assert.rejects(pending, /已取消/);
    assert.equal(f.counts().launches, 0);
  } finally { f.cleanup(); }
});

test('a damaged record blocks new work but does not hide intact finished history', async () => {
  const f = fixture();
  try {
    const run = await f.service.start(f.request);
    f.settle({ success: true, stopped: true });
    await new Promise((resolve) => setImmediate(resolve));
    mkdirSync(join(f.options.directory, 'half-created-run'));
    const restarted = createExecutionService(f.options);
    assert.equal(restarted.get({ runId: run.runId }).state, 'succeeded');
    await assert.rejects(restarted.start({ ...f.request, requestId: 'other' }), /恢复/);
  } finally { f.cleanup(); }
});

test('damaged history cannot turn an unknown request cancellation into stop confirmation', async () => {
  const f = fixture();
  try {
    const run = await f.service.start(f.request);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(f.options.directory, run.runId, 'state.json'), 'damaged');
    const restarted = createExecutionService(f.options);
    const cancelled = await restarted.cancel({ requestId: f.request.requestId });
    assert.equal(cancelled.stopConfirmed, false);
    assert.equal(f.counts().cancels, 0);
  } finally { f.cleanup(); }
});

test('a damaged cancellation tombstone blocks new work but keeps history queryable', async () => {
  const f = fixture();
  try {
    const run = await f.service.start(f.request);
    f.settle({ success: true, stopped: true });
    await new Promise((resolve) => setImmediate(resolve));
    writeFileSync(join(f.options.directory, '.cancellations', 'broken.json'), '{ not json');
    // 与损坏的运行记录同策略：历史照常可查，新派发阻断，而不是整个服务瘫痪。
    const restarted = createExecutionService(f.options);
    assert.equal(restarted.get({ runId: run.runId }).state, 'succeeded');
    await assert.rejects(restarted.start({ ...f.request, requestId: 'other' }), /恢复/);
  } finally { f.cleanup(); }
});
