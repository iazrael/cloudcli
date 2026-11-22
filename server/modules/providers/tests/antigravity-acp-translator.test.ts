/**
 * Antigravity ACP Step Translator Unit Tests
 *
 * Frames mirror live agy 1.5.14 captures (docs/design/agyACP运行时.md 现场与
 * 证据): one text chunk, a tool call with its pending/completed updates, the
 * ask_question card, an invoke_subagent spawn, usage and thought frames.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AntigravityAcpTranslator } from '../list/antigravity/antigravity-acp-translator.js';

const update = (payload: Record<string, unknown>) => ({
  method: 'session/update' as const,
  params: { sessionId: 'conv-1', update: payload },
});

test('text chunks stream as deltas and close on the next non-text update', () => {
  const translator = new AntigravityAcpTranslator();
  translator.setSessionId('conv-1');

  const chunk = translator.translate(update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '你希望使用哪种数据库？' },
  }));
  assert.equal(chunk.messages.length, 1);
  assert.equal(chunk.messages[0].kind, 'stream_delta');
  assert.equal(chunk.messages[0].content, '你希望使用哪种数据库？');

  const toolCall = translator.translate(update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_1',
    name: 'run_command',
    status: 'in_progress',
  }));
  // The tool frame itself plus the stream_end that closes the text segment.
  assert.equal(toolCall.messages.length, 2);
  assert.equal(toolCall.messages[0].kind, 'stream_end');
  assert.equal(toolCall.messages[1].kind, 'tool_use');
  assert.equal(toolCall.messages[1].toolId, 'call_1');
});

test('closeOpenSegment emits the final stream_end at a turn boundary', () => {
  const translator = new AntigravityAcpTranslator();
  translator.setSessionId('conv-1');
  translator.translate(update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'partial' },
  }));
  const closed = translator.closeOpenSegment();
  assert.equal(closed?.kind, 'stream_end');
  assert.equal(translator.closeOpenSegment(), null, 'second close is a no-op');
});

test('thought chunks are dropped for print parity', () => {
  const translator = new AntigravityAcpTranslator();
  const thought = translator.translate(update({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking' },
  }));
  assert.equal(thought.messages.length, 0);
});

test('tool_call_update completed flattens text and diff content blocks', () => {
  const translator = new AntigravityAcpTranslator();
  translator.setSessionId('conv-1');
  translator.translate(update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_2',
    name: 'run_command',
    status: 'in_progress',
  }));

  const done = translator.translate(update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_2',
    name: 'run_command',
    status: 'completed',
    content: [{
      type: 'content',
      content: { type: 'text', text: 'Command exited with code 0.\n\nCommand output:\nprobe-ok' },
    }],
  }));
  assert.equal(done.messages.length, 1);
  assert.equal(done.messages[0].kind, 'tool_result');
  assert.match(String(done.messages[0].content), /probe-ok/);

  const failed = translator.translate(update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_3',
    name: 'run_command',
    status: 'failed',
    content: [],
  }));
  assert.equal(failed.messages[0].kind, 'tool_result');
  assert.equal(failed.messages[0].isError, true);

  const diff = translator.translate(update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_4',
    name: 'write_file',
    status: 'completed',
    content: [{ type: 'diff', path: '/tmp/approved.txt', newText: 'hello' }],
  }));
  assert.equal(diff.messages[0].kind, 'tool_result');
  assert.match(String(diff.messages[0].content), /approved\.txt/);
  assert.match(String(diff.messages[0].content), /hello/);
});

test('ask_question renders as the shared AskUserQuestion card', () => {
  const translator = new AntigravityAcpTranslator();
  translator.setSessionId('conv-1');
  const ask = translator.translate(update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_ask',
    name: 'ask_question',
    status: 'in_progress',
    args: {
      questions: JSON.stringify([{
        question: '你希望使用哪种数据库？',
        options: ['(Recommended) PostgreSQL', 'SQLite', 'MySQL'],
        is_multi_select: false,
      }]),
    },
  }));
  assert.equal(ask.messages.length, 1);
  assert.equal(ask.messages[0].toolName, 'AskUserQuestion');
  const questions = (ask.messages[0].toolInput as { questions: Array<{ question: string; options: Array<{ label: string }> }> }).questions;
  assert.equal(questions[0].options[0].label, '(Recommended) PostgreSQL');
  assert.equal('multiSelect' in questions[0], false, 'single-select carries no flag');
});

test('a pending update signals the runtime and emits its row if missing', () => {
  const translator = new AntigravityAcpTranslator();
  translator.setSessionId('conv-1');

  translator.translate(update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_1',
    name: 'run_command',
    status: 'in_progress',
  }));
  const pendingAfterCall = translator.translate(update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    name: 'run_command',
    status: 'pending',
  }));
  assert.deepEqual(pendingAfterCall.messages, [], 'row already emitted by tool_call');
  assert.deepEqual(pendingAfterCall.toolPending, { toolCallId: 'call_1', toolName: 'run_command' });

  const pendingAlone = translator.translate(update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_lonely',
    name: 'write_file',
    status: 'pending',
  }));
  assert.equal(pendingAlone.messages.length, 1, 'stray pending still renders its row');
  assert.deepEqual(pendingAlone.toolPending, { toolCallId: 'call_lonely', toolName: 'write_file' });
});

test('invoke_subagent suppresses tool rows and reports spawn lifecycle', () => {
  const translator = new AntigravityAcpTranslator();
  translator.setSessionId('conv-1');

  const spawn = translator.translate(update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_spawn',
    name: 'invoke_subagent',
    status: 'in_progress',
    args: { Prompt: 'Reply with pong', Role: 'Ping Pong Responder', TypeName: 'research' },
  }));
  assert.equal(spawn.messages.length, 0, 'spawn call draws no tool row');
  assert.deepEqual(spawn.spawnStarted?.toolCallId, 'call_spawn');
  assert.equal(spawn.spawnStarted?.specs[0].role, 'Ping Pong Responder');

  const settled = translator.translate(update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_spawn',
    name: 'invoke_subagent',
    status: 'completed',
  }));
  assert.deepEqual(settled.spawnSettled, { toolCallId: 'call_spawn' });
  assert.equal(settled.messages.length, 0);
});

test('usage_update becomes a token_budget status frame', () => {
  const translator = new AntigravityAcpTranslator();
  translator.setSessionId('conv-1');
  const usage = translator.translate(update({ sessionUpdate: 'usage_update', used: 16061, size: 1048576 }));
  assert.equal(usage.messages.length, 1);
  assert.equal(usage.messages[0].kind, 'status');
  const budget = usage.messages[0].tokenBudget as { used: number; total: number };
  assert.equal(budget.used, 16061);
  assert.equal(budget.total, 1048576);
});

test('unknown update kinds produce no messages', () => {
  const translator = new AntigravityAcpTranslator();
  const unknown = translator.translate(update({ sessionUpdate: 'a_future_update_kind', data: 1 }));
  assert.equal(unknown.messages.length, 0);
});

test('streaming preserves spaces, newlines and indentation at chunk boundaries', () => {
  const translator = new AntigravityAcpTranslator();
  const chunks = ['The ', ' next\n', '\n  indent', '\n'];
  const received = chunks.flatMap((text) => translator.translate(update({
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
  })).messages);
  assert.equal(received.map((message) => message.content).join(''), 'The  next\n\n  indent\n');
});

test('message chunks are held while a question card is parked and resume on release', () => {
  const translator = new AntigravityAcpTranslator();
  translator.setSessionId('conv-1');
  translator.translate(update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call_ask',
    name: 'ask_question',
    status: 'in_progress',
    args: { questions: JSON.stringify([{ question: 'q?', options: ['a'], is_multi_select: false }]) },
  }));
  translator.holdQuestionEcho();

  const echo = translator.translate(update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'q?\n- [1] a' },
  }));
  assert.deepEqual(echo.messages, [], 'the question echo is dropped while parked');

  translator.releaseQuestionEcho();
  const real = translator.translate(update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '收到，用 PostgreSQL。' },
  }));
  assert.equal(real.messages.length, 1, 'answer-turn prose streams again');
});
