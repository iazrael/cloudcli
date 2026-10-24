/**
 * OpenCode Subagent Adapter
 *
 * OpenCode spawns an agent through a tool named `subagent` whose input is
 * `{ agent, description, prompt, sessionID? }` and whose result metadata names
 * the child session (`metadata.sessionID`). The client draws a subagent card
 * for tool calls named `Agent` only, so this module translates the engine's
 * name and input once, for the live translator and the history reader alike.
 *
 * The `agent` message part is not a spawn: it is the user's @-mention of an
 * agent in the prompt box (`AgentPartInput`, with the mention's text span in
 * `source`), and the prompt text already carries the mention. Nothing here
 * handles it.
 *
 * @module opencode-subagent
 */

import type { AnyRecord } from '@/shared/types.js';
import { SUBAGENT_TOOL_NAME, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { QUESTION_CARD_TOOL_NAME, isOpenCodeQuestionTool } from './opencode-question.js';

const OPENCODE_SUBAGENT_TOOL = 'subagent';

/** Whether an engine tool name is OpenCode's agent-spawning tool. */
export function isOpenCodeSubagentTool(engineToolName: string): boolean {
  return engineToolName === OPENCODE_SUBAGENT_TOOL;
}

/**
 * The name the client knows an engine tool by: the spawn tool becomes
 * `Agent` and the question tool `AskUserQuestion`, the two cards the client
 * draws by name; every other tool keeps its engine name.
 */
export function toClientToolName(engineToolName: string): string {
  if (isOpenCodeSubagentTool(engineToolName)) {
    return SUBAGENT_TOOL_NAME;
  }
  return isOpenCodeQuestionTool(engineToolName) ? QUESTION_CARD_TOOL_NAME : engineToolName;
}

/**
 * The card input for a spawn call: the engine's `agent` becomes the card's
 * `subagent_type`, and `sessionID` (the earlier child session a call resumes)
 * becomes `resume`. Unknown shapes pass through untouched.
 */
export function toAgentCardInput(input: unknown): unknown {
  const record = readObjectRecord(input);
  if (!record) {
    return input;
  }
  const { agent, sessionID, ...rest } = record;
  const mapped: AnyRecord = { ...rest };
  const subagentType = readOptionalString(agent);
  if (subagentType) {
    mapped.subagent_type = subagentType;
  }
  const resume = readOptionalString(sessionID);
  if (resume) {
    mapped.resume = resume;
  }
  return mapped;
}

/** The child session a finished or running spawn call reports in its metadata. */
export function readSubagentChildSessionId(metadata: unknown): string | undefined {
  return readOptionalString(readObjectRecord(metadata)?.sessionID);
}
