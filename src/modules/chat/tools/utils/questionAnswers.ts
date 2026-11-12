//----------------- ASK-THE-USER ANSWERS (render-time fold) -----------------

// The engine states the user's AskUserQuestion picks in the tool result as an
// acknowledgement sentence ("User has answered your questions: ..." from ZCode,
// "Your questions have been answered: ..." from Claude); the structured record
// only lands when the transcript is persisted. The server folds the answers
// into the call input when it loads history (server/shared/message-unification.ts),
// but a live turn's card has only the prose — without a fold here the card
// shows Skipped for the whole run even though the answer went through. This
// module mirrors that unification for rendering; keep the shapes and the gate
// phrases in sync with the server side.

/**
 * Reads a result payload stored either as an object (Claude) or as the raw
 * JSON string it arrived as (Codex); anything else is not a payload record.
 */
function readPayloadRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Flattens one answer value into the comma-joined label list the card renders. */
function readAnswerLabels(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string').join(', ');
  }

  const record = readPayloadRecord(value);
  return record ? readAnswerLabels(record.answers) : '';
}

/**
 * Recovers the answers from the acknowledgement sentence the engine writes
 * into the result when a question is answered. The "user did not answer"
 * prose (e.g. ZCode's "The user did not provide answers to these questions.
 * Continue using your best judgment...") contains neither gate phrase and
 * must not parse as answers.
 */
function readAnswersFromAcknowledgement(content: string): Record<string, string> {
  if (!content.includes('questions have been answered') && !content.includes('answered your questions')) {
    return {};
  }

  const answers: Record<string, string> = {};
  const pattern = /"([^"]+)"\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(content);
  while (match) {
    answers[match[1]] = match[2];
    match = pattern.exec(content);
  }

  return answers;
}

/** Reads the answer map out of whichever result shape the provider produced. */
function readResultAnswers(toolResult: unknown): Record<string, unknown> | null {
  const result = readPayloadRecord(toolResult);
  if (!result) {
    return null;
  }

  const structured = readPayloadRecord(readPayloadRecord(result.toolUseResult)?.answers);
  if (structured) {
    return structured;
  }

  const content = typeof result.content === 'string' ? result.content.trim() : '';
  if (!content) {
    return null;
  }

  const fromPayload = readPayloadRecord(readPayloadRecord(content)?.answers);
  if (fromPayload) {
    return fromPayload;
  }

  const fromSentence = readAnswersFromAcknowledgement(content);
  return Object.keys(fromSentence).length > 0 ? fromSentence : null;
}

/**
 * Rewrites answers onto the question text they belong to: Codex keys its
 * answers by the question's `id`, Claude by the question text, and the card
 * always reads by text.
 */
function keyAnswersByQuestion(questions: unknown, rawAnswers: Record<string, unknown>): Record<string, string> {
  const questionById = new Map<string, string>();
  if (Array.isArray(questions)) {
    for (const entry of questions) {
      const question = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
      const id = typeof question?.id === 'string' && question.id.trim() ? question.id : '';
      const text = typeof question?.question === 'string' && question.question.trim() ? question.question : '';
      if (id && text) {
        questionById.set(id, text);
      }
    }
  }

  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    const labels = readAnswerLabels(value);
    if (labels) {
      answers[questionById.get(key) ?? key] = labels;
    }
  }

  return answers;
}

/**
 * Folds the user's answers out of the result onto the question call's input so
 * the live question card renders the picked option instead of Skipped. A no-op
 * pass-through when the input is not a question payload, already carries
 * answers (history rows arrive pre-folded), or the result states no answer.
 */
export function foldAnswersIntoQuestionInput(input: unknown, toolResult: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const record = input as { questions?: unknown; answers?: unknown };
  if (!Array.isArray(record.questions)) {
    return input;
  }
  if (record.answers && typeof record.answers === 'object' && Object.keys(record.answers).length > 0) {
    return input;
  }

  const rawAnswers = readResultAnswers(toolResult);
  if (!rawAnswers) {
    return input;
  }

  const answers = keyAnswersByQuestion(record.questions, rawAnswers);
  if (Object.keys(answers).length === 0) {
    return input;
  }

  return { ...(record as Record<string, unknown>), answers };
}
