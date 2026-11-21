/**
 * Antigravity ACP Runtime Tests
 *
 * Drives `AntigravityRuntimeProvider.run()` through the resident-ACP path
 * (`CLOUDCLI_ANTIGRAVITY_ACP=1`) against a stub `agy acp` engine, covering the
 * turn lifecycle end to end: session identity rows, streamed updates, the
 * complete frame, abort-via-cancel and a mid-turn engine crash. HOME is
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
process.env.CLOUDCLI_ANTIGRAVITY_PATH = stubPath;

const STUB_SCRIPT = `#!/usr/bin/env node
let buf = '';
process.stdin.setEncoding('utf8');
process.stdout.setEncoding('utf8');
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
let promptId = null;
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
    send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: 1 } });
    return;
  }
  if (frame.method === 'session/new') {
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: 'acp-conv-1', modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'accept-edits' }] }, models: { currentModelId: 'gemini-4-neon-high' } } });
    return;
  }
  if (frame.method === 'session/prompt') {
    promptId = frame.id;
    if (mode === 'acp-exit') {
      setTimeout(() => process.exit(1), 150);
      return;
    }
    if (mode === 'acp-cancel') return; // wait for session/cancel
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
process.on('SIGTERM', () => process.exit(0));
`;
fs.writeFileSync(stubPath, STUB_SCRIPT, { mode: 0o755 });

const context = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'gemini-4-neon-high' }),
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
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
test.after(() => {
  closeAntigravityAcpSessions();
});

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
