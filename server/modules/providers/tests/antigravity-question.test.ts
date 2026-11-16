import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ANTIGRAVITY_QUESTION_TOOL,
  toAskUserQuestionCard,
} from '@/modules/providers/list/antigravity/antigravity-question.js';
import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';

// Reduced from the reported conversation: agy persists `ask_question` args
// with `questions` as a JSON-encoded string, and each question spells
// multi-select `is_multi_select` with plain-string options.
const QUESTIONS = [
  { question: '整体音乐风格偏哪种？', options: ['氛围为主', '几乎没有旋律', '有记忆点的旋律'], is_multi_select: false },
  { question: '这次范围要不要把音效也一起换？', options: ['只做音乐和环境音', '一起重做'], is_multi_select: true },
];

test('a string-encoded ask_question call maps onto the shared AskUserQuestion card shape', () => {
  const card = toAskUserQuestionCard(ANTIGRAVITY_QUESTION_TOOL, { questions: JSON.stringify(QUESTIONS) });

  assert.equal(card.toolName, 'AskUserQuestion');
  const input = card.toolInput as any;
  assert.deepEqual(input.questions[0], {
    question: '整体音乐风格偏哪种？',
    options: [{ label: '氛围为主' }, { label: '几乎没有旋律' }, { label: '有记忆点的旋律' }],
  });
  assert.equal('is_multi_select' in input.questions[0], false);
  assert.equal(input.questions[1].multiSelect, true);
  assert.equal('is_multi_select' in input.questions[1], false);
});

test('an array-valued questions field converts the same way', () => {
  const card = toAskUserQuestionCard(ANTIGRAVITY_QUESTION_TOOL, { questions: QUESTIONS });
  const input = card.toolInput as any;
  assert.equal(card.toolName, 'AskUserQuestion');
  assert.equal(input.questions[1].multiSelect, true);
  assert.deepEqual(input.questions[0].options[0], { label: '氛围为主' });
});

test('other tools and unparsable input pass through untouched', () => {
  const passthrough = { TargetFile: '/tmp/x' };
  assert.deepEqual(toAskUserQuestionCard('write_file', passthrough), { toolName: 'write_file', toolInput: passthrough });

  const broken = toAskUserQuestionCard(ANTIGRAVITY_QUESTION_TOOL, { questions: '[not json' });
  assert.equal(broken.toolName, 'AskUserQuestion');
  assert.deepEqual(broken.toolInput, { questions: '[not json' });

  assert.deepEqual(toAskUserQuestionCard(ANTIGRAVITY_QUESTION_TOOL, {}), { toolName: 'AskUserQuestion', toolInput: {} });
});

test('a live step_update ask_question reaches the client as the AskUserQuestion card', () => {
  const live = new AntigravitySessionsProvider().normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 5,
      step_type: 'tool',
      state: 'ACTIVE',
      tool_name: ANTIGRAVITY_QUESTION_TOOL,
      tool_info: { parameters: { questions: JSON.stringify(QUESTIONS) } },
    },
  }, 'conv');

  const row = live.find((message) => message.kind === 'tool_use');
  assert.equal(row?.toolName, 'AskUserQuestion');
  assert.equal((row?.toolInput as any)?.questions?.[1].multiSelect, true);
});

test('history draws an ask_question call as an AskUserQuestion card', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-question-'));
  const oldRoot = process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR;
  const rows = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '开始吧' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [
      { name: ANTIGRAVITY_QUESTION_TOOL, args: { questions: JSON.stringify(QUESTIONS) } },
    ] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Created At: x\nCompleted At: y\nA1: \nA2: ' },
  ];
  try {
    const logs = path.join(root, 'brain', 'conv', '.system_generated', 'logs');
    await fs.mkdir(logs, { recursive: true });
    await fs.writeFile(path.join(logs, 'transcript.jsonl'), rows.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR = root;

    const { messages } = await new AntigravitySessionsProvider().fetchHistory('conv');
    const row = messages.find((message) => message.kind === 'tool_use');
    assert.equal(row?.toolName, 'AskUserQuestion');
    assert.equal((row?.toolInput as any)?.questions?.[0].question, '整体音乐风格偏哪种？');
    // The engine's empty receipt folds in as the call's result, which the
    // shared card suppresses on success — the questions render, the empty
    // "A1: A2:" blob does not.
    const result = (row as any)?.toolResult;
    assert.ok(result && String(result.content).includes('A1:'));
  } finally {
    if (oldRoot === undefined) delete process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR;
    else process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR = oldRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});
