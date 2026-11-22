/**
 * Antigravity ACP Runtime Tests
 *
 * Drives `AntigravityRuntimeProvider.run()` through the resident-ACP path
 * (`CLOUDCLI_ANTIGRAVITY_ACP=1`) against a stub `agy acp` engine, covering the
 * turn lifecycle end to end: session identity rows, streamed updates, the
 * complete frame, abort-via-cancel, a mid-turn engine crash, and both user
 * interrupts — the permission card and the parked question card. HOME is
 * pointed at a fixture so the managed data directory stays inside the test.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

import { AntigravityRuntimeProvider, closeAntigravityAcpSessions } from '../list/antigravity/antigravity-runtime.provider.js';

process.env.CLOUDCLI_ANTIGRAVITY_ACP = '1';
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-rt-home-'));

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-rt-'));
const stubPath = path.join(stubDir, 'agy');
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-rt-ws-'));
const promptsLog = path.join(stubDir, 'prompts.log');
process.env.CLOUDCLI_ANTIGRAVITY_PATH = stubPath;

const STUB_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const promptsLog = process.env.AGY_ACP_PROMPTS_LOG || '/dev/null';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdout.setEncoding('utf8');
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
let promptId = null;
let promptCount = 0;
let permissionRequestId = null;
let permissionAnswer = null;
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(frame) {
  const mode = process.env.AGY_ACP_STUB_MODE;
  if (frame.method === 'initialize') {
    if (mode === 'acp-silent-init') {
      fs.appendFileSync(promptsLog, 'startup waiting\\n');
      return;
    }
    send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } });
    return;
  }
  if (frame.method === 'session/set_mode') {
    if (mode === 'acp-mode-error') {
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'mode refused' } });
    } else {
      send({ jsonrpc: '2.0', id: frame.id, result: {} });
    }
    return;
  }
  if (frame.method === 'session/new' || frame.method === 'session/load') {
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'acp-conv-1', modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'accept-edits' }] }, models: { currentModelId: 'gemini-4-neon-high' } } });
    return;
  }
  if (frame.method === 'session/prompt') {
    promptCount += 1;
    const text = frame.params.prompt?.[0]?.text ?? '';
    fs.appendFileSync(promptsLog, JSON.stringify({ prompt: promptCount, text }) + '\\n');
    promptId = frame.id;
    if (mode === 'acp-exit') {
      setTimeout(() => process.exit(1), 150);
      return;
    }
    if (mode === 'acp-capture-flags') {
      const text = process.argv.includes('--dangerously-skip-permissions') ? 'bypass process' : 'approval process';
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      finish(frame.id);
      return;
    }
    if (mode === 'acp-cancel') return; // wait for session/cancel
    if (mode === 'acp-drain') {
      // The model yields end_turn while its spawned subagent is still out:
      // the run must drain instead of settling, and complete only after the
      // spawn call settles.
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call', toolCallId: 'call_spawn', name: 'invoke_subagent', args: { Prompt: 'review', Role: 'Reviewer' }, status: 'in_progress' } } });
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { totalTokens: 3 } } });
      promptId = null;
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_spawn', name: 'invoke_subagent', status: 'completed' } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '评审已汇总。' } } } });
      }, 1500);
      return;
    }
    if (mode === 'acp-prompt-error') {
      send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'conversation not found' } });
      promptId = null;
      return;
    }
    if (mode === 'acp-park-exit') {
      // Park on a question, then die while the client holds the run.
      const args = { questions: JSON.stringify([{ question: 'q?', options: ['a', 'b'], is_multi_select: false }]) };
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call', toolCallId: 'call_ask', name: 'ask_question', args, status: 'in_progress' } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_ask', name: 'ask_question', args, status: 'pending' } } });
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { totalTokens: 1 } } });
      promptId = null;
      setTimeout(() => process.exit(2), 300);
      return;
    }
    if (mode === 'acp-question-deny' || mode === 'acp-early-answer') {
      if (promptCount === 1) {
        const args = { questions: JSON.stringify([{ question: 'q?', options: ['a', 'b'], is_multi_select: false }]) };
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call', toolCallId: 'call_ask', name: 'ask_question', args, status: 'in_progress' } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_ask', name: 'ask_question', args, status: 'pending' } } });
        const finishAsk = () => {
          send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn', usage: { totalTokens: 1 } } });
          promptId = null;
        };
        if (mode === 'acp-early-answer') setTimeout(finishAsk, 400);
        else finishAsk();
      } else {
        // The synthetic no-answer prompt: the engine resumes on its own.
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的，我自行判断继续。' } } } });
        send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { totalTokens: 2 } } });
      }
      return;
    }
    if (mode === 'acp-bg') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call', toolCallId: 'call_bg', name: 'run_command', status: 'in_progress', args: { IsDaemon: true } } } });
      // Turn ends, then the engine announces a finished daemon command on its
      // own — the frames arrive with no run pump subscribed.
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } } });
      promptId = null;
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_bg', name: 'run_command', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'BG-DONE-42' } }] } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '后台任务已完成（退出码 0），输出为：BG-DONE-42' } } } });
      }, 500);
      return;
    }
    if (mode === 'acp-permission') {
      if (promptCount === 1) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call', toolCallId: 'call_write', name: 'write_file', args: { Path: 'x.txt' }, status: 'in_progress', kind: 'edit' } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_write', name: 'write_file', status: 'pending' } } });
        permissionRequestId = 8001;
        permissionAnswer = null;
        send({ jsonrpc: '2.0', id: 8001, method: 'session/request_permission', params: { toolCall: { sessionUpdate: 'tool_call', toolCallId: 'call_write', name: 'write_file', args: { Path: 'x.txt' }, status: 'pending', kind: 'edit', title: 'File x.txt' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
        waitPermission(frame.id);
      } else {
        finish(frame.id);
      }
      return;
    }
    if (mode === 'acp-question') {
      if (promptCount === 1) {
        const args = { questions: JSON.stringify([{ question: '你希望使用哪种数据库？', options: ['PostgreSQL', 'SQLite'], is_multi_select: false }]) };
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call', toolCallId: 'call_ask', name: 'ask_question', args, status: 'in_progress', kind: 'other' } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_ask', name: 'ask_question', args, status: 'pending' } } });
        // The engine parks: the turn ends with the ask pending.
        send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
        promptId = null;
      } else {
        // The answer prompt: the engine folds it into the parked ask.
        const args = { questions: JSON.stringify([{ question: '你希望使用哪种数据库？', options: ['PostgreSQL', 'SQLite'], is_multi_select: false }]) };
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_ask', name: 'ask_question', args, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'PostgreSQL' } }] } } });
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '收到，用 PostgreSQL。' } } } });
        send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } } });
      }
      return;
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'usage_update', used: 900, size: 1048576 } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working...' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call', toolCallId: 'call_9', name: 'run_command', args: { CommandLine: 'echo hi' }, status: 'in_progress' } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_9', name: 'run_command', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hi' } }] } } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } } });
    promptId = null;
    return;
  }
  if (frame.method === 'session/cancel' && promptId !== null) {
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
    promptId = null;
  }
}
function waitPermission(promptFrameId) {
  // The permission reply arrives as a plain response frame to id 8001.
  const original = handle;
  // handle() is not re-entrant per frame; poll the pending answer via a hook:
  // the simplest deterministic wiring is to answer the prompt once the
  // response for 8001 lands, which the dispatcher below records.
  global.__resolvePermission = (answer) => {
    permissionAnswer = answer;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-conv-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_write', name: 'write_file', status: 'completed', content: [{ type: 'diff', path: 'x.txt', newText: 'written' }] } } });
    original({ id: promptFrameId, method: '__finish__', params: {} });
  };
}
function finish(frameId) {
  send({ jsonrpc: '2.0', id: frameId, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } } });
  promptId = null;
}
process.on('SIGTERM', () => process.exit(0));
`;

// The stub script's dispatch: server->client responses (id without method)
// route into the permission answer hook.
const stubFinal = STUB_SCRIPT.replace(`function handle(frame) {
  const mode = process.env.AGY_ACP_STUB_MODE;`, `function handle(frame) {
  if (frame.id !== undefined && frame.method === undefined && frame.result !== undefined) {
    if (frame.id === 8001 && typeof global.__resolvePermission === 'function') {
      const hook = global.__resolvePermission;
      global.__resolvePermission = null;
      hook(frame.result);
    }
    return;
  }
  if (frame.method === '__finish__') {
    finish(frame.id);
    return;
  }
  const mode = process.env.AGY_ACP_STUB_MODE;`);
fs.writeFileSync(stubPath, stubFinal, { mode: 0o755 });

const published: Array<{ appSessionId: string; message: NormalizedMessage }> = [];
const context = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'gemini-4-neon-high' }),
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
  publishSessionEvent: (appSessionId: string, message: NormalizedMessage) => {
    published.push({ appSessionId, message });
  },
} as unknown as ProviderRuntimeContext;

const createWriter = (): { messages: NormalizedMessage[]; writer: ProviderRuntimeWriter } => {
  const messages: NormalizedMessage[] = [];
  const writer: ProviderRuntimeWriter = {
    userId: null,
    send: (data: unknown) => messages.push(data as NormalizedMessage),
    setSessionId: () => undefined,
  };
  return { messages, writer };
};

const runtime = new AntigravityRuntimeProvider();

// The resident engines hold the event loop open; reclaim them when the file's
// tests are done so the runner can exit.
test.after(closeAntigravityAcpSessions);

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test('an ACP turn streams updates and settles with a complete frame', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-turn';
  const { messages, writer } = createWriter();
  const result = await runtime.run('hello', { sessionId: 'sess-acp-1', cwd: workspaceDir }, writer, context);
  assert.deepEqual(result, { sessionId: 'acp-conv-1', success: true });

  const kinds = messages.map((message) => message.kind);
  assert.ok(kinds.includes('session_created'), 'session identity row is emitted');
  const created = messages.find((message) => message.kind === 'session_created');
  assert.equal(created?.newSessionId, 'acp-conv-1');
  assert.ok(kinds.includes('stream_delta'), 'text chunk streamed');
  assert.equal(kinds.filter((kind) => kind === 'stream_end').length, 1, 'text segment closed exactly once');
  assert.ok(kinds.includes('tool_use'), 'tool row rendered');
  assert.ok(kinds.includes('tool_result'), 'tool result rendered');
  assert.ok(kinds.includes('complete'), 'terminal frame present');

  const budget = messages.find((message) => message.kind === 'status' && message.text === 'token_budget');
  assert.ok(budget, 'context occupancy frame present');
  const complete = messages.find((message) => message.kind === 'complete');
  assert.equal(complete?.sessionId, 'acp-conv-1');
  assert.equal(complete?.tokens, 105, 'turn usage rides the complete frame');

  // A second turn on the same app session reuses the resident conversation
  // (no second session_created row).
  const second = await runtime.run('again', { sessionId: 'sess-acp-1', cwd: workspaceDir }, writer, context);
  assert.deepEqual(second, { sessionId: 'acp-conv-1', success: true });
  const createdRows = messages.filter((message) => message.kind === 'session_created');
  assert.equal(createdRows.length, 1, 'resident session is reused without re-announcing');
});

test('abort cancels the in-flight turn over session/cancel', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-cancel';
  const { messages, writer } = createWriter();
  const runPromise = runtime.run('long task', { sessionId: 'sess-acp-cancel', cwd: workspaceDir }, writer, context);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const aborted = await runtime.abort('sess-acp-cancel');
  assert.equal(aborted, true, 'the resident session accepted the cancel');
  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'acp-conv-1', success: true, aborted: true });
  const stopped = messages.filter((message) => message.kind === 'complete');
  assert.equal(stopped.length, 1, 'cancelled run still emits exactly one complete');
});

test('a mid-turn engine crash fails the run', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-exit';
  const { messages, writer } = createWriter();
  await assert.rejects(
    runtime.run('long task', { sessionId: 'sess-acp-exit', cwd: workspaceDir }, writer, context),
    /exited|failed|Error/,
  );
  assert.ok(messages.some((message) => message.kind === 'error'), 'failure surfaced as an error row');
  assert.ok(messages.some((message) => message.kind === 'complete'), 'run still settles with complete');
});

test('background-task completions published between turns reach the session channel', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-bg';
  const { messages, writer } = createWriter();
  const result = await runtime.run('start a daemon', { sessionId: 'sess-acp-bg', cwd: workspaceDir }, writer, context);
  assert.deepEqual(result, { sessionId: 'acp-conv-1', success: true });

  // The completion frames land after the run settled; whichever leg owns them
  // (the tail of the run's pump or the between-turns router), they must reach
  // the session channel.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const channelFrames = published.filter((entry) => entry.appSessionId === 'sess-acp-bg').map((entry) => entry.message);
  const allFrames = [...messages, ...channelFrames];
  assert.ok(
    allFrames.some((message) => message.kind === 'tool_result' && message.toolId === 'call_bg'),
    'daemon command completion rendered as its tool result',
  );
  assert.ok(
    allFrames.some((message) => message.kind === 'stream_delta' && String(message.content).includes('BG-DONE-42')),
    'the engine completion notice reached the timeline',
  );
  if (channelFrames.length > 0) {
    assert.ok(
      channelFrames.every((message) => message.sessionId === 'acp-conv-1'),
      'between-turns frames carry the engine conversation id',
    );
  }
});

test('end_turn with an outstanding spawn drains instead of settling early', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-drain';
  const { messages, writer } = createWriter();
  const startedAt = Date.now();
  const runPromise = runtime.run('review it', { sessionId: 'sess-acp-drain', cwd: workspaceDir }, writer, context);

  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(!messages.some((message) => message.kind === 'complete'), 'early end_turn must not settle while a spawn is outstanding');

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'acp-conv-1', success: true });
  const drainedFor = Date.now() - startedAt;
  assert.ok(drainedFor >= 1500, `run drained until the spawn settled (drained ${drainedFor}ms)`);
  assert.ok(messages.some((message) => message.kind === 'complete'), 'drained run still settles with complete');
  assert.ok(messages.some((message) => message.kind === 'stream_delta' && String(message.content).includes('评审已汇总')), 'post-end_turn frames streamed through the pump');
});

test('a prompt rejected by the engine fails the run instead of settling as success', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-prompt-error';
  const { messages, writer } = createWriter();
  await assert.rejects(
    runtime.run('hello', { sessionId: 'sess-acp-perr', cwd: workspaceDir }, writer, context),
    /conversation not found/,
  );
  assert.ok(messages.some((message) => message.kind === 'error'), 'failure surfaced as an error row');
  assert.ok(messages.some((message) => message.kind === 'complete'), 'run still settles');
  const complete = messages.find((message) => message.kind === 'complete');
  assert.equal(complete?.exitCode, 1);
});

test('an engine death while parked on a question fails the run instead of hanging', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-park-exit';
  const { messages, writer } = createWriter();
  const runPromise = runtime.run('start', { sessionId: 'sess-acp-parkexit', cwd: workspaceDir }, writer, context);
  await waitFor(() => (runtime.permissions?.listPending('sess-acp-parkexit') ?? []).length > 0);
  await assert.rejects(runPromise, /exited|Antigravity/, 'the parked run wakes on engine death');
  assert.ok(messages.some((message) => message.kind === 'complete'), 'run settles');
});

test('a pending permission card holds the watchdog past the idle timeout', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-permission';
  process.env.CLOUDCLI_ANTIGRAVITY_IDLE_TIMEOUT = '2s';
  try {
    const { messages, writer } = createWriter();
    const runPromise = runtime.run('write the file', { sessionId: 'sess-acp-wd', cwd: workspaceDir }, writer, context);
    await waitFor(() => (runtime.permissions?.listPending('sess-acp-wd') ?? []).length > 0);
    // Longer than the 2s idle timeout: a watchdog that ignored the pending
    // card would have killed the engine here.
    await new Promise((resolve) => setTimeout(resolve, 3500));
    assert.equal(runtime.permissions?.listPending('sess-acp-wd').length, 1, 'card still answerable');
    runtime.permissions?.resolve((runtime.permissions?.listPending('sess-acp-wd')[0])?.requestId as string, { allow: true });
    const result = await runPromise;
    assert.deepEqual(result, { sessionId: 'acp-conv-1', success: true });
    assert.ok(!messages.some((message) => message.kind === 'error' && String(message.content).includes('produced no output')), 'watchdog never fired');
  } finally {
    delete process.env.CLOUDCLI_ANTIGRAVITY_IDLE_TIMEOUT;
  }
});

test('a denied question lets the engine resume on its own judgment', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-question-deny';
  process.env.AGY_ACP_PROMPTS_LOG = promptsLog;
  const { messages, writer } = createWriter();
  const runPromise = runtime.run('start', { sessionId: 'sess-acp-deny', cwd: workspaceDir }, writer, context);
  await waitFor(() => (runtime.permissions?.listPending('sess-acp-deny') ?? []).length > 0);
  runtime.permissions?.resolve((runtime.permissions?.listPending('sess-acp-deny')[0])?.requestId as string, { allow: false });
  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'acp-conv-1', success: true });
  const prompts = (await fs.promises.readFile(promptsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).slice(-2);
  assert.match(String(prompts[1].text), /did not provide answers/, 'the synthetic no-answer prompt reached the engine');
  assert.ok(messages.some((message) => message.kind === 'permission_cancelled'), 'denied card retracted');
});

test('a permission request parks on the card and the gateway answer continues the turn', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-permission';
  process.env.AGY_ACP_PROMPTS_LOG = promptsLog;
  const { messages, writer } = createWriter();
  const runPromise = runtime.run('write the file', { sessionId: 'sess-acp-perm', cwd: workspaceDir }, writer, context);

  await waitFor(() => messages.some((message) => message.kind === 'permission_request'));
  const card = messages.find((message) => message.kind === 'permission_request');
  assert.equal(card?.toolName, 'write_file');
  assert.ok(messages.some((message) => message.kind === 'tool_use' && message.toolId === 'call_write'), 'tool row anchors the card');

  const pending = runtime.permissions?.listPending('sess-acp-perm') ?? [];
  assert.equal(pending.length, 1, 'the card replays through the gateway');
  assert.equal(pending[0].requestId, card?.requestId);

  runtime.permissions?.resolve(card?.requestId as string, { allow: true });

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'acp-conv-1', success: true });
  assert.ok(messages.some((message) => message.kind === 'permission_cancelled'), 'card retracted on settle');
  assert.ok(messages.some((message) => message.kind === 'tool_result' && message.toolId === 'call_write'), 'approved tool completed');
  assert.equal(runtime.permissions?.listPending('sess-acp-perm').length, 0);
});

test('a parked question answers through the card and continues on the same run', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-question';
  process.env.AGY_ACP_PROMPTS_LOG = promptsLog;
  const { messages, writer } = createWriter();
  const runPromise = runtime.run('start', { sessionId: 'sess-acp-ask', cwd: workspaceDir }, writer, context);

  // The engine parks: the card appears while the run holds.
  await waitFor(() => (runtime.permissions?.listPending('sess-acp-ask') ?? []).length > 0);
  const pending = runtime.permissions?.listPending('sess-acp-ask')[0];
  assert.equal(pending?.toolName, 'AskUserQuestion');
  assert.ok(messages.some((message) => message.kind === 'permission_request' && message.toolName === 'AskUserQuestion'));

  // The run is parked: no complete yet.
  assert.ok(!messages.some((message) => message.kind === 'complete'), 'parked run has not settled');

  runtime.permissions?.resolve(pending?.requestId as string, {
    allow: true,
    updatedInput: { answers: { '你希望使用哪种数据库？': 'PostgreSQL' } },
  });

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'acp-conv-1', success: true });
  assert.ok(messages.some((message) => message.kind === 'permission_cancelled'), 'question card retracted');
  assert.ok(messages.some((message) => message.kind === 'stream_delta'), 'answer turn streamed on the same run (chunk frames arrive as stream deltas)');
  assert.ok(messages.some((message) => message.kind === 'tool_result' && message.toolId === 'call_ask'), 'ask completed after the answer');

  // The log is shared across this file's tests; the question run's own turns
  // are its last two entries.
  const prompts = (await fs.promises.readFile(promptsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).slice(-2);
  assert.equal(prompts.length, 2, 'the answer travelled as the second prompt');
  assert.equal(prompts[0].text, 'start');
  assert.match(String(prompts[1].text), /PostgreSQL/);
  assert.match(String(prompts[1].text), /User has answered your questions:/);
  assert.equal(runtime.permissions?.listPending('sess-acp-ask').length, 0);
});

test('a permission-mode rejection fails the turn before sending a prompt', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-mode-error';
  process.env.AGY_ACP_PROMPTS_LOG = promptsLog;
  const { writer } = createWriter();
  await assert.rejects(runtime.run('must not be sent', {
    sessionId: 'sess-acp-mode-refused', cwd: workspaceDir, permissionMode: 'acceptEdits',
  }, writer, context), /mode refused/);
  assert.doesNotMatch(fs.readFileSync(promptsLog, 'utf8'), /must not be sent/);
});

test('an answer sent before end_turn still becomes the next prompt', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-early-answer';
  process.env.AGY_ACP_PROMPTS_LOG = promptsLog;
  const { writer } = createWriter();
  const sessionId = 'sess-acp-early-answer';
  const run = runtime.run('ask early', { sessionId, cwd: workspaceDir }, writer, context);
  await waitFor(() => runtime.permissions.listPending(sessionId).length === 1);
  const [card] = runtime.permissions.listPending(sessionId);
  runtime.permissions.resolve(card.requestId, { allow: true, message: 'early-answer-42' });
  await run;
  assert.match(fs.readFileSync(promptsLog, 'utf8'), /early-answer-42/);
});

test('a background command keeps its process and blocks a permissions change until completion', async () => {
  await closeAntigravityAcpSessions();
  process.env.CLOUDCLI_ANTIGRAVITY_ACP_IDLE_MINUTES = '0.002';
  process.env.AGY_ACP_STUB_MODE = 'acp-bg';
  const sessionId = 'sess-acp-bg-recycle';
  const { writer } = createWriter();
  try {
    await runtime.run('start a long daemon', { sessionId, cwd: workspaceDir }, writer, context);
    await assert.rejects(runtime.run('switch now', {
      sessionId, cwd: workspaceDir, permissionMode: 'bypassPermissions',
    }, writer, context), /background commands are running/);
    await waitFor(() => published.some((entry) => entry.appSessionId === sessionId && entry.message.kind === 'tool_result'));
  } finally {
    delete process.env.CLOUDCLI_ANTIGRAVITY_ACP_IDLE_MINUTES;
    await closeAntigravityAcpSessions();
  }
});

test('an explicit review mode takes precedence over stale skip-permissions settings', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-capture-flags';
  const { messages, writer } = createWriter();
  await runtime.run('review this turn', {
    sessionId: 'sess-acp-explicit-review',
    cwd: workspaceDir,
    permissionMode: 'default',
    skipPermissions: true,
    toolsSettings: { skipPermissions: true },
  }, writer, context);
  assert.ok(messages.some((message) => message.kind === 'stream_delta' && message.content === 'approval process'));
});

test('aborting during initialize settles as an aborted turn', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-silent-init';
  process.env.AGY_ACP_PROMPTS_LOG = promptsLog;
  const sessionId = 'sess-acp-abort-during-init';
  const { messages, writer } = createWriter();
  const run = runtime.run('abort before prompt', { sessionId, cwd: workspaceDir }, writer, context);
  await waitFor(() => fs.existsSync(promptsLog) && fs.readFileSync(promptsLog, 'utf8').includes('startup waiting'));
  assert.equal(await runtime.abort(sessionId), true);
  assert.deepEqual(await run, { sessionId, success: true, aborted: true });
  assert.equal(messages.filter((message) => message.kind === 'complete' && message.aborted).length, 1);
});

test('the prompt watchdog reports the silence that caused termination', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-cancel';
  const { writer } = createWriter();
  await assert.rejects(runtime.run('engine stays silent', {
    sessionId: 'sess-acp-silent-prompt', cwd: workspaceDir, idleTimeout: '150ms',
  }, writer, context), /produced no output for 150ms/);
});

test('a turn can be aborted while its model catalog is loading', async () => {
  process.env.AGY_ACP_STUB_MODE = 'acp-turn';
  const { messages, writer } = createWriter();
  const sessionId = 'sess-acp-abort-catalog';
  let loading = false;
  let unblock = () => {};
  const run = runtime.run('must wait for catalog', { sessionId, cwd: workspaceDir, model: 'test-model' }, writer, {
    ...context,
    getProviderModels: () => new Promise((resolve) => {
      unblock = () => resolve({ OPTIONS: [], DEFAULT: 'test-model' });
      loading = true;
    }),
  });
  try {
    await waitFor(() => loading);
    assert.equal(await runtime.abort(sessionId), true);
    assert.deepEqual(await run, { sessionId: 'acp-conv-1', success: true, aborted: true });
    assert.ok(!messages.some((message) => message.kind === 'stream_delta'));
  } finally {
    unblock();
  }
});
