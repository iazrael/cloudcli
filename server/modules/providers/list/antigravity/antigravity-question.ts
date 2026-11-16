/**
 * Antigravity Question Adapter
 *
 * Antigravity asks the user through a tool named `ask_question` whose input
 * carries `questions` as a JSON-encoded string; each question is
 * `{question, options: string[], is_multi_select}`. The client draws one
 * question card for calls named `AskUserQuestion` whose input holds a parsed
 * `questions` array in Claude's shape, so this module translates both once,
 * for the live step translator and the history reader alike.
 *
 * In CLI stream-json mode the engine has no interactive channel, so it
 * completes the ask immediately with empty answers ("A1: / A2: ..." lines);
 * there is nothing to fold back into the input and the card renders the
 * questions as asked, which is what the user needs in order to answer in
 * text.
 *
 * @module antigravity-question
 */

import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

/** agy's native ask-the-user tool name. */
export const ANTIGRAVITY_QUESTION_TOOL = 'ask_question';

/**
 * The client's name for the ask-the-user card. Kept local like the opencode
 * adapter's, so no provider imports another's module.
 */
export const QUESTION_CARD_TOOL_NAME = 'AskUserQuestion';

/** Whether an engine tool name is agy's ask-the-user tool. */
export function isAntigravityQuestionTool(engineToolName: string): boolean {
  return engineToolName === ANTIGRAVITY_QUESTION_TOOL;
}

function toCardQuestion(entry: unknown): unknown {
  const question = readObjectRecord(entry);
  if (!question || typeof question.question !== 'string') {
    return entry;
  }
  const { is_multi_select, options, ...rest } = question;
  const labels = Array.isArray(options)
    ? options.filter((label): label is string => typeof label === 'string').map((label) => ({ label }))
    : options;
  const card: AnyRecord = { ...rest, options: labels };
  // Only multi-select carries the flag, matching the opencode adapter's card
  // shape: absent reads as single-select in the renderer.
  if (is_multi_select === true) {
    card.multiSelect = true;
  }
  return card;
}

/**
 * The card input for an `ask_question` call: the JSON-encoded `questions`
 * string is parsed and each entry is remapped onto Claude's shape. Input
 * without a parsable `questions` value passes through unchanged; the name
 * translation is the caller's decision (see {@link toAskUserQuestionCard}).
 */
export function toAntigravityQuestionCardInput(input: unknown): unknown {
  const record = readObjectRecord(input);
  if (!record) {
    return input;
  }

  let questions: unknown = record.questions;
  if (typeof questions === 'string') {
    try {
      questions = JSON.parse(questions);
    } catch {
      return input;
    }
  }
  if (!Array.isArray(questions)) {
    return input;
  }

  return { ...record, questions: questions.map(toCardQuestion) };
}

/**
 * One-step translation for a tool call row: agy's `ask_question` becomes the
 * shared `AskUserQuestion` card with converted input; any other tool passes
 * through verbatim. Consumed by the live step translator and the history
 * reader, so a call renders as the same card while streaming and after a
 * refresh.
 */
export function toAskUserQuestionCard(
  engineToolName: string,
  args: unknown,
): { toolName: string; toolInput: unknown } {
  if (!isAntigravityQuestionTool(engineToolName)) {
    return { toolName: engineToolName, toolInput: args };
  }
  return { toolName: QUESTION_CARD_TOOL_NAME, toolInput: toAntigravityQuestionCardInput(args) };
}
