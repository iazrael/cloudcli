import assert from 'node:assert/strict';

import { test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { foldAnswersIntoQuestionInput } from '@/modules/chat/tools/utils/questionAnswers';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';

// The engine states the user's AskUserQuestion picks in the tool result's
// acknowledgement prose, and the structured record only lands when the
// transcript is persisted — so during a live turn the question card's input
// carries no answers and would render as Skipped even though the answer went
// through. foldAnswersIntoQuestionInput is the render-time fold mirroring the
// server's history-time unification (server/shared/message-unification.ts).
//
// Result fixtures below are verbatim engine output: the ZCode answered prose
// and the ZCode skip prose come from session rows in ZCode's SQLite database,
// the Claude prose from server/shared/message-unification.ts's contract.
const ZCODE_ANSWERED_PROSE =
  'User has answered your questions: "撤回编辑的交互按哪种做？"="加铅笔按钮，X 保留（推荐）". You can now continue with the user\'s answers in mind.';
const ZCODE_SKIPPED_PROSE =
  'The user did not provide answers to these questions. Continue using your best judgment; do not treat this as a rejection or invent a user preference.';
const CLAUDE_ANSWERED_PROSE = 'Your questions have been answered: "Pick one?"="Option A". Continue with the answers in mind.';

const QUESTIONS = [
  {
    question: '撤回编辑的交互按哪种做？',
    header: '交互方案',
    multiSelect: false,
    options: [
      { label: '加铅笔按钮，X 保留（推荐）', description: '和排队消息卡片完全一致。' },
      { label: 'X 直接变成撤回', description: '少一个按钮。' },
    ],
  },
];

function readAnswers(input: unknown): Record<string, string> {
  const record = (input ?? {}) as { answers?: Record<string, string> };
  return record.answers ?? {};
}

test('folds answers out of the ZCode acknowledgement prose', () => {
  const input = { questions: QUESTIONS };
  const folded = foldAnswersIntoQuestionInput(input, { content: ZCODE_ANSWERED_PROSE });
  assert.deepEqual(readAnswers(folded), { '撤回编辑的交互按哪种做？': '加铅笔按钮，X 保留（推荐）' });
});

test('folds answers out of the Claude acknowledgement prose', () => {
  const input = { questions: [{ question: 'Pick one?', options: [{ label: 'Option A' }] }] };
  const folded = foldAnswersIntoQuestionInput(input, { content: CLAUDE_ANSWERED_PROSE });
  assert.deepEqual(readAnswers(folded), { 'Pick one?': 'Option A' });
});

test('leaves the input untouched when the result says the user skipped', () => {
  const input = { questions: QUESTIONS };
  const folded = foldAnswersIntoQuestionInput(input, { content: ZCODE_SKIPPED_PROSE });
  assert.deepEqual(readAnswers(folded), {});
  assert.equal(folded, input);
});

test('leaves the input untouched while the result has not arrived', () => {
  const input = { questions: QUESTIONS };
  assert.equal(foldAnswersIntoQuestionInput(input, undefined), input);
  assert.equal(foldAnswersIntoQuestionInput(input, { content: '' }), input);
});

test('keeps answers the server already folded into the history input', () => {
  const input = { questions: QUESTIONS, answers: { '撤回编辑的交互按哪种做？': '加铅笔按钮，X 保留（推荐）' } };
  const folded = foldAnswersIntoQuestionInput(input, { content: CLAUDE_ANSWERED_PROSE });
  assert.deepEqual(readAnswers(folded), { '撤回编辑的交互按哪种做？': '加铅笔按钮，X 保留（推荐）' });
});

test('folds a structured toolUseResult answer and remaps Codex id keys to question text', () => {
  const input = { questions: [{ id: 'q1', question: 'Which ones?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] };
  const toolResult = { toolUseResult: { answers: { q1: ['A', 'B'] } } };
  const folded = foldAnswersIntoQuestionInput(input, toolResult);
  assert.deepEqual(readAnswers(folded), { 'Which ones?': 'A, B' });
});

test('folds answers out of a JSON payload result (Codex)', () => {
  const input = { questions: [{ id: 'q1', question: 'Which ones?', options: [{ label: 'A' }] }] };
  const toolResult = { content: '{"answers":{"q1":"A"}}' };
  const folded = foldAnswersIntoQuestionInput(input, toolResult);
  assert.deepEqual(readAnswers(folded), { 'Which ones?': 'A' });
});

test('folds every pair of a multi-question acknowledgement', () => {
  const input = {
    questions: [
      { question: 'First?', options: [{ label: 'A' }] },
      { question: 'Second?', options: [{ label: 'B' }] },
    ],
  };
  const prose = 'User has answered your questions: "First?"="A". "Second?"="B".';
  const folded = foldAnswersIntoQuestionInput(input, { content: prose });
  assert.deepEqual(readAnswers(folded), { 'First?': 'A', 'Second?': 'B' });
});

test('keeps an answer whose question text matches no question under its own key', () => {
  const input = { questions: QUESTIONS };
  const prose = 'User has answered your questions: "Gone?"="A".';
  const folded = foldAnswersIntoQuestionInput(input, { content: prose });
  assert.deepEqual(readAnswers(folded), { 'Gone?': 'A' });
});

test('passes malformed input through without throwing', () => {
  // Neither call may throw; both are pass-through.
  assert.equal(foldAnswersIntoQuestionInput(undefined, { content: ZCODE_ANSWERED_PROSE }), undefined);
  assert.deepEqual(foldAnswersIntoQuestionInput({ questions: 'not-an-array' }, { content: ZCODE_ANSWERED_PROSE }), { questions: 'not-an-array' });
});

test('renders the folded choice instead of Skipped in the live card', () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolRenderer, {
      toolName: 'AskUserQuestion',
      toolInput: { questions: QUESTIONS },
      toolResult: { content: ZCODE_ANSWERED_PROSE },
      mode: 'input',
    }),
  );
  assert.ok(markup.includes('加铅笔按钮，X 保留（推荐）'), 'folded answer label should render');
  assert.ok(!markup.includes('Skipped'), 'answered card must not show Skipped');
});

test('still renders Skipped when the result says the user skipped', () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolRenderer, {
      toolName: 'AskUserQuestion',
      toolInput: { questions: QUESTIONS },
      toolResult: { content: ZCODE_SKIPPED_PROSE },
      mode: 'input',
    }),
  );
  assert.ok(markup.includes('Skipped'));
});

test('puts the folded choice into the card title', () => {
  const markup = renderToStaticMarkup(
    React.createElement(ToolRenderer, {
      toolName: 'AskUserQuestion',
      toolInput: { questions: QUESTIONS },
      toolResult: { content: ZCODE_ANSWERED_PROSE },
      mode: 'input',
    }),
  );
  assert.ok(markup.includes('交互方案 — 加铅笔按钮，X 保留（推荐）'));
});
