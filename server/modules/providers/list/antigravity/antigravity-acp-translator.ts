/**
 * Antigravity ACP Step Translator
 *
 * Maps `agy acp` `session/update` notifications onto the same
 * NormalizedMessage stream the print/stream-json runtime produces, so the
 * frontend renders an ACP turn exactly like a print turn. Frame shapes are
 * probe-verified against agy 1.5.14 (docs/design/agyACP运行时.md).
 *
 * Parity decisions:
 * - `agent_thought_chunk` is dropped: the print stream exposes no thought
 *   events, so showing them here only would fork the two runtimes' output.
 * - `invoke_subagent` rows are suppressed like the print path's spawn rows.
 *   The engine names each agent's conversation id only in the parent
 *   transcript's spawn receipt, never on the frame, so the runtime binds
 *   cards, registry entries and transcript tails from that receipt (the same
 *   source history reads); the translator only reports the spawn calls.
 * - Tool rows are keyed by the engine's toolCallId. agy's stream-json rows
 *   key on transcript step indices, which ACP frames do not carry, so live
 *   and refreshed ids differ; a refresh rebuilds the timeline from history,
 *   which is unaffected.
 *
 * @module antigravity-acp-translator
 */

import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import type { AcpNotification } from './antigravity-acp-client.js';
import {
  ANTIGRAVITY_SPAWN_TOOL,
  readInvokedAgentSpecs,
  type AntigravityAgentSpec,
} from './antigravity-subagent.js';
import { ANTIGRAVITY_QUESTION_TOOL as QUESTION_TOOL_NAME, toAskUserQuestionCard } from './antigravity-question.js';

const PROVIDER = 'antigravity';

/** One tool content block as `tool_call_update.content` carries it. */
type AcpToolContent = { type?: string; text?: string; path?: string; newText?: string };

/** Non-text update kinds that close an open streaming text segment. */
const SEGMENT_CLOSING_UPDATES = new Set([
  'tool_call',
  'tool_call_update',
  'plan',
  'checkpoint',
]);

/**
 * Flattens the engine's tool content blocks into the plain text a print-run
 * tool_result carries: text blocks join as-is, diff blocks read as the file
 * plus its new content.
 */
function describeToolContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as AcpToolContent[]) {
    const record = readObjectRecord(block);
    if (!record) continue;
    if (record.type === 'content') {
      const nested = readObjectRecord(record.content);
      const text = readOptionalString(nested?.text);
      if (text) parts.push(text);
    } else if (record.type === 'diff') {
      const file = readOptionalString(record.path);
      const newText = readOptionalString(record.newText);
      parts.push([file ?? 'file', newText].filter((value) => value !== null).join('\n'));
    } else {
      const text = readOptionalString(record.text);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}

/** What one notification contributed to the stream beyond plain messages. */
export type AcpTranslation = {
  messages: NormalizedMessage[];
  /** An `invoke_subagent` call started; the runtime begins receipt polling for it. */
  spawnStarted?: { toolCallId: string; specs: AntigravityAgentSpec[] };
  /** An `invoke_subagent` call finished; unbound spawns settle from the transcript. */
  spawnSettled?: { toolCallId: string };
  /** A tool is parked waiting for the user (permission request or question answer). */
  toolPending?: {
    toolCallId: string;
    toolName: string;
    /** ask_question only: the card-facing name and translated input. */
    cardToolName?: string;
    cardInput?: unknown;
  };
};

export class AntigravityAcpTranslator {
  /** Mirrors the print runtime's `agentResponseSegmentOpen` flag. */
  private segmentOpen = false;
  /** Tool calls already emitted as rows, so a stray pending update can still render. */
  private readonly seenToolCalls = new Set<string>();
  private sessionId: string | null = null;

  /** Pins the session id the translator stamps onto rows. */
  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  private getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Translates one `session/update` notification. Unknown update kinds return
   * no messages (the engine adds kinds freely; frames-only awareness keeps
   * this tolerant).
   */
  translate(notification: AcpNotification): AcpTranslation {
    const params = readObjectRecord(notification.params);
    const update = readObjectRecord(params?.update);
    if (!update) return { messages: [] };
    const kind = readOptionalString(update.sessionUpdate);

    // agy interleaves plain-text steps with tool steps without an explicit
    // end-of-text marker; the first non-text update closes the segment, the
    // same boundary the print runtime derives (print parity comment there).
    const closesSegment = kind !== 'agent_message_chunk'
      && (SEGMENT_CLOSING_UPDATES.has(kind ?? '') || kind === null || kind === undefined);
    let closedByThisUpdate: NormalizedMessage | null = null;
    if (this.segmentOpen && closesSegment) {
      this.segmentOpen = false;
      closedByThisUpdate = this.streamEndMessage();
    }

    switch (kind) {
      case 'agent_message_chunk':
        return { messages: [...(closedByThisUpdate ? [closedByThisUpdate] : []), ...this.translateTextChunk(update)] };
      case 'agent_thought_chunk':
        // Dropped for print parity (module comment).
        return { messages: closedByThisUpdate ? [closedByThisUpdate] : [] };
      case 'tool_call':
      case 'tool_call_update':
        return this.translateToolUpdate(kind, update, closedByThisUpdate);
      case 'usage_update':
        return { messages: [this.translateUsage(update)] };
      default:
        // session_info_update (titles), available_commands_update, plan and
        // future kinds carry nothing the print stream would have shown.
        return { messages: closedByThisUpdate ? [closedByThisUpdate] : [] };
    }
  }

  /**
   * Closes an open text segment at a turn boundary, so the client never keeps
   * a synthetic streaming row alive across `complete`.
   */
  closeOpenSegment(): NormalizedMessage | null {
    if (!this.segmentOpen) return null;
    this.segmentOpen = false;
    return this.streamEndMessage();
  }

  private streamEndMessage(): NormalizedMessage {
    return createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      kind: 'stream_end',
      sessionId: this.getSessionId(),
      provider: PROVIDER,
    });
  }

  private translateTextChunk(update: Record<string, unknown>): NormalizedMessage[] {
    const content = readObjectRecord(update.content);
    const text = readOptionalString(content?.text);
    if (!text) return [];
    this.segmentOpen = true;
    return [createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      kind: 'stream_delta',
      content: text,
      sessionId: this.getSessionId(),
      provider: PROVIDER,
    })];
  }

  private translateUsage(update: Record<string, unknown>): NormalizedMessage {
    const used = typeof update.used === 'number' ? update.used : 0;
    const total = typeof update.size === 'number' && update.size > 0 ? update.size : 1048576;
    return createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      kind: 'status',
      text: 'token_budget',
      tokenBudget: {
        used,
        total,
        inputTokens: 0,
        outputTokens: 0,
        breakdown: { input: 0, output: 0 },
        cumulative: { used, inputTokens: 0, outputTokens: 0 },
      },
      sessionId: this.getSessionId(),
      provider: PROVIDER,
    });
  }

  private translateToolUpdate(
    kind: 'tool_call' | 'tool_call_update',
    update: Record<string, unknown>,
    closedSegment: NormalizedMessage | null,
  ): AcpTranslation {
    const toolCallId = readOptionalString(update.toolCallId);
    const toolName = readOptionalString(update.name) ?? 'tool';
    const status = readOptionalString(update.status);
    if (!toolCallId) return { messages: closedSegment ? [closedSegment] : [] };

    // The engine names agents only in the transcript receipt, so spawn calls
    // render as their Agent cards and never as tool rows (print parity).
    if (toolName === ANTIGRAVITY_SPAWN_TOOL) {
      if (kind === 'tool_call') {
        return {
          messages: closedSegment ? [closedSegment] : [],
          spawnStarted: { toolCallId, specs: readInvokedAgentSpecs(update.args ?? update.rawInput) },
        };
      }
      return {
        messages: closedSegment ? [closedSegment] : [],
        spawnSettled: { toolCallId },
      };
    }

    const rowId = `msg_${this.getSessionId() ?? ''}_acp_${toolCallId}`;
    const messages: NormalizedMessage[] = closedSegment ? [closedSegment] : [];

    if (kind === 'tool_call') {
      // ask_question shares the client's AskUserQuestion card through the
      // same translation the live print path and history both use.
      const card = toAskUserQuestionCard(toolName, update.args ?? update.rawInput);
      this.seenToolCalls.add(toolCallId);
      messages.push(createNormalizedMessage({
        id: rowId,
        kind: 'tool_use',
        toolName: card.toolName,
        toolInput: card.toolInput,
        toolId: toolCallId,
        sessionId: this.getSessionId(),
        provider: PROVIDER,
      }));
      return { messages };
    }

    // tool_call_update
    if (status === 'pending') {
      let cardToolName: string | undefined;
      let cardInput: unknown;
      if (toolName === QUESTION_TOOL_NAME) {
        const card = toAskUserQuestionCard(toolName, update.args ?? update.rawInput);
        cardToolName = card.toolName;
        cardInput = card.toolInput;
        if (!this.seenToolCalls.has(toolCallId)) {
          // Defensive: a pending update without its in_progress frame still
          // needs its row, or the card that waits on the user has no anchor.
          this.seenToolCalls.add(toolCallId);
          messages.push(createNormalizedMessage({
            id: rowId,
            kind: 'tool_use',
            toolName: card.toolName,
            toolInput: card.toolInput,
            toolId: toolCallId,
            sessionId: this.getSessionId(),
            provider: PROVIDER,
          }));
        }
      } else if (!this.seenToolCalls.has(toolCallId)) {
        this.seenToolCalls.add(toolCallId);
        messages.push(createNormalizedMessage({
          id: rowId,
          kind: 'tool_use',
          toolName,
          toolInput: update.args ?? update.rawInput ?? {},
          toolId: toolCallId,
          sessionId: this.getSessionId(),
          provider: PROVIDER,
        }));
      }
      return {
        messages,
        toolPending: {
          toolCallId,
          toolName,
          ...(cardToolName ? { cardToolName, cardInput } : {}),
        },
      };
    }

    if (status === 'completed' || status === 'failed') {
      const isError = status === 'failed';
      messages.push(createNormalizedMessage({
        id: `${rowId}_result`,
        kind: 'tool_result',
        toolId: toolCallId,
        content: isError ? (readOptionalString(update.content) ?? '') : describeToolContent(update.content),
        isError,
        sessionId: this.getSessionId(),
        provider: PROVIDER,
      }));
      return { messages };
    }

    // in_progress echoes after a permission approval: the row exists.
    return { messages };
  }
}
