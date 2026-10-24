/**
 * OpenCode Question Adapter
 *
 * OpenCode asks the user through a tool named `question` whose input is
 * Claude's AskUserQuestion shape except that multi-select is spelled
 * `multiple`; the picks are not in the input but in the finished call's
 * `state.metadata.answers`, one label array per question in order. The client
 * draws one question card for calls named `AskUserQuestion` whose input
 * carries `answers` keyed by question text, so this module translates both
 * once, for the live translator and the history reader alike.
 *
 * @module opencode-question
 */

import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

const OPENCODE_QUESTION_TOOL = 'question';

/**
 * The client's name for the ask-the-user tool. Consumed by the subagent
 * adapter's name translation and the interaction bridge's question panel.
 */
export const QUESTION_CARD_TOOL_NAME = 'AskUserQuestion';

/** How the shared question card and panel join multi-select picks. */
export const MULTI_SELECT_JOINER = ', ';

/** Whether an engine tool name is OpenCode's ask-the-user tool. */
export function isOpenCodeQuestionTool(engineToolName: string): boolean {
  return engineToolName === OPENCODE_QUESTION_TOOL;
}

function toCardQuestion(entry: unknown): unknown {
  const question = readObjectRecord(entry);
  if (!question || typeof question.multiple !== 'boolean' || question.multiSelect !== undefined) {
    return entry;
  }
  const { multiple, ...rest } = question;
  return { ...rest, multiSelect: multiple };
}

/**
 * The card input for a question call: `multiple` becomes `multiSelect`, and
 * when the call's metadata holds the picks they are folded in as `answers`,
 * keyed by question text with multi-select labels joined. Unanswered
 * questions are left out; input without a `questions` array passes through.
 * Consumed by the OpenCode event translator and sessions provider.
 */
export function toQuestionCardInput(input: unknown, metadata?: unknown): unknown {
  const record = readObjectRecord(input);
  if (!record || !Array.isArray(record.questions)) {
    return input;
  }

  const card: AnyRecord = { ...record, questions: record.questions.map(toCardQuestion) };
  const picks = readObjectRecord(metadata)?.answers;
  if (!Array.isArray(picks)) {
    return card;
  }

  const answers: Record<string, string> = {};
  record.questions.forEach((entry, index) => {
    const text = readObjectRecord(entry)?.question;
    const labels = Array.isArray(picks[index])
      ? picks[index].filter((label: unknown): label is string => typeof label === 'string' && label.length > 0)
      : [];
    if (typeof text === 'string' && labels.length > 0) {
      answers[text] = labels.join(MULTI_SELECT_JOINER);
    }
  });
  return Object.keys(answers).length > 0 ? { ...card, answers } : card;
}
