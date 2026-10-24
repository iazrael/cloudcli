/**
 * OpenCode Session Event Translator
 *
 * Turns the service's session-scoped SSE events into the NormalizedMessage
 * frames the chat timeline already understands. Event names and payloads
 * are pinned to what v2.0.31 emits (captured live; see the tests' fixtures):
 *
 * - `session.text.delta` → `stream_delta`; `session.text.ended` → the finished
 *   `text` row (engine-named, so the streamed placeholder is adopted) + `stream_end`
 * - `session.reasoning.delta` → `thinking` deltas under one stable block id
 *   (the timeline appends same-id thinking frames, so deltas, not totals)
 * - `session.tool.input.started` / `tool.called` → `tool_use` snapshots that
 *   the timeline upserts by toolId; `tool.success` / `tool.failed` → `tool_result`
 * - `session.execution.{succeeded,failed,interrupted}` → run terminal
 *   (`session.step.ended` carries token totals, but the runtime reads the
 *   authoritative session totals from the API snapshot instead)
 * - a `tool.success` whose metadata still says `running` is a background
 *   launch, not a finished call; a synthetic `session.inbox.enqueued` item is
 *   the engine's notice that such work ended; `session.execution.started`
 *   marks a turn beginning, which the run registry needs to tell a turn the
 *   engine started on its own (see `opencode-background-work.ts`)
 *
 * Ids on transcript rows (text / thinking / tool_use / tool_result) derive
 * from the engine's own identifiers (assistant message id + per-type part
 * ordinal, tool call id) so the same record never arrives under two ids —
 * the history reader renumbers its content blocks the same way. Unknown
 * event types are ignored on purpose: the service is young and adds events
 * between patch releases.
 *
 * @module opencode-event-translator
 */

import { LOCAL_AGENT_TASK_TYPE, createTaskStatusMessage } from '@/modules/providers/shared/background-work/task-status.js';
import type { NormalizedMessage } from '@/shared/types.js';
import {
  compactProviderPayload,
  createCompactionMessage,
  createNormalizedMessage,
  generateMessageId,
  hasVisibleText,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

import {
  readBackgroundLaunch,
  readBackgroundNotice,
  type OpenCodeBackgroundLaunch,
  type OpenCodeBackgroundNotice,
} from './opencode-background-work.js';
import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';
import {
  isOpenCodeSubagentTool,
  readSubagentChildSessionId,
  toAgentCardInput,
  toClientToolName,
} from './opencode-subagent.js';
import { isOpenCodeQuestionTool, toQuestionCardInput } from './opencode-question.js';

const PROVIDER = 'opencode' as const;

//----------------- TRANSLATION RESULTS ------------

/** How a run ended, as reported by `session.execution.*`. */
export type OpenCodeRunOutcome =
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'interrupted'; reason: string };

/**
 * Frames to forward plus, on execution-terminal events, how the run ended.
 *
 * Consumer: opencode runtime.
 */
export type OpenCodeTranslatedEvent = {
  frames: NormalizedMessage[];
  terminal?: OpenCodeRunOutcome;
  /** `session.execution.started`: the session began a turn. */
  executionStarted?: boolean;
  /** A call the engine moved to the background; its card stays running. */
  launch?: OpenCodeBackgroundLaunch;
  /** The engine's notice that background work ended. */
  notice?: OpenCodeBackgroundNotice;
};

/** A tool call the translator has seen; the interaction bridge labels permission cards with it. */
export type OpenCodeToolCall = {
  name: string;
  input: unknown;
};

// ---------------------------

const toNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Streamed text must keep its whitespace: a delta of `" world"` glued to
 * `"Hello"` without the space corrupts the prose, so the shared trimming
 * reader is wrong here.
 */
const readVerbatimString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.length > 0 ? value : undefined
);

const toTimestamp = (event: OpenCodeEventEnvelope): string => {
  const created = typeof event.created === 'number' && Number.isFinite(event.created) ? event.created : Date.now();
  return new Date(created).toISOString();
};

/**
 * Joins the `content` blocks of a tool result (`[{type:'text', text}]`) into one string.
 *
 * Consumers: this translator (live results) and the OpenCode history reader
 * (persisted v2 tool states carry the same blocks under `content`).
 */
export const formatToolOutput = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return content === undefined || content === null ? '' : JSON.stringify(content);
  }
  return content
    .map((block) => {
      const record = readObjectRecord(block);
      if (!record) {
        return typeof block === 'string' ? block : '';
      }
      return readVerbatimString(record.text) ?? (record.type === 'text' ? '' : JSON.stringify(record));
    })
    .filter((text) => text.length > 0)
    .join('\n');
};

const readErrorMessage = (error: unknown): string => {
  const record = readObjectRecord(error);
  return readOptionalString(record?.message)
    ?? readOptionalString(error)
    ?? readOptionalString(record?.type)
    ?? 'Unknown OpenCode error';
};

/**
 * The timeline row of a compaction (running, done or failed), as every
 * provider draws one (`createCompactionMessage`).
 *
 * The engine persists a compaction as a `compaction` session message whose id
 * is the `inputID` its live events carry, so naming the row after it gives
 * the live stream and the history read the same row. `reason` is the engine's
 * `manual` / `auto`. Consumers: this translator (live) and the OpenCode
 * sessions provider (history).
 */
export function createOpenCodeCompactionFrame(input: {
  inputId: string | null | undefined;
  sessionId: string | null;
  timestamp: string;
  phase: 'running' | 'done' | 'failed';
  reason?: unknown;
  error?: unknown;
}): NormalizedMessage {
  const reason = readOptionalString(input.reason);
  return createCompactionMessage({
    id: `${input.inputId ?? generateMessageId(PROVIDER)}_compaction`,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    provider: PROVIDER,
    phase: input.phase,
    ...(reason === 'manual' || reason === 'auto' ? { trigger: reason } : {}),
    ...(input.phase === 'failed' ? { error: readErrorMessage(input.error) } : {}),
  });
}

/**
 * Per-session translator. One instance lives for the life of a run (or a
 * session's attachment) because tool names and reasoning block ids are
 * remembered across events.
 *
 * Consumers: opencode runtime (owns one per active session), opencode
 * interaction bridge (reads `getToolCall`).
 */
export class OpenCodeSessionEventTranslator {
  private readonly toolCalls = new Map<string, OpenCodeToolCall>();
  /** Reasoning blocks that already streamed deltas; `reasoning.ended` must not repeat them. */
  private readonly streamedReasoningBlocks = new Set<string>();
  /** Spawn calls announced but not yet resolved; each owns a card that must be settled. */
  private readonly openSubagentCalls = new Set<string>();

  constructor(
    /** The app session id stamped on every frame (the writer owns provider↔app mapping). */
    private readonly sessionId: string,
  ) {}

  getToolCall(callId: string): OpenCodeToolCall | null {
    return this.toolCalls.get(callId) ?? null;
  }

  /**
   * Settles the card of every spawn call the run never resolved, as `stopped`.
   *
   * The runtime calls this once the run has ended for any reason (success,
   * failure, interruption, a lost service), because a call whose result never
   * arrived has nothing else to end its card: nobody is left to report on it.
   */
  settleOpenSubagents(): NormalizedMessage[] {
    const frames = [...this.openSubagentCalls].map((callId) => this.subagentStatusFrame(callId, callId, 'stopped', new Date().toISOString()));
    this.openSubagentCalls.clear();
    return frames;
  }

  translate(event: OpenCodeEventEnvelope): OpenCodeTranslatedEvent {
    const data = readObjectRecord(compactProviderPayload(event.data)) ?? {};
    const timestamp = toTimestamp(event);
    const messageId = readOptionalString(data.assistantMessageID) ?? 'message';
    const ordinal = toNumber(data.ordinal);

    switch (event.type) {
      case 'session.text.delta': {
        const delta = readVerbatimString(data.delta);
        // A delta carrying only invisible characters would otherwise sit in
        // the client's streaming buffer and flush as a copy-control-only row.
        if (!delta || !hasVisibleText(delta)) {
          return { frames: [] };
        }
        return {
          frames: [createNormalizedMessage({
            id: `${messageId}_text_${ordinal}`,
            sessionId: this.sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'stream_delta',
            content: delta,
          })],
        };
      }

      case 'session.text.ended': {
        // The finished segment must land as a real transcript row: the streamed
        // deltas live in a client-side placeholder that only an engine-named
        // row can retire, and the history reader derives the very same id
        // (per-type ordinal within the message — see the v2 history flattener).
        const text = readVerbatimString(data.text);
        const frames: NormalizedMessage[] = [];
        // Whitespace- or invisible-only bodies are skipped by the history
        // reader too; a row for one would survive every refresh as an orphan
        // with no persisted copy to retire it.
        if (text && hasVisibleText(text)) {
          frames.push(createNormalizedMessage({
            id: `${messageId}_text_${ordinal}`,
            sessionId: this.sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
          }));
        }
        frames.push(createNormalizedMessage({
          id: `${messageId}_text_${ordinal}_end`,
          sessionId: this.sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'stream_end',
        }));
        return { frames };
      }

      case 'session.reasoning.delta': {
        const delta = readVerbatimString(data.delta);
        if (!delta) {
          return { frames: [] };
        }
        const blockId = `${messageId}_reasoning_${ordinal}`;
        this.streamedReasoningBlocks.add(blockId);
        return { frames: [this.thinkingFrame(blockId, delta, timestamp)] };
      }

      case 'session.reasoning.ended': {
        // Providers that never stream reasoning deliver the whole block here.
        const blockId = `${messageId}_reasoning_${ordinal}`;
        if (this.streamedReasoningBlocks.has(blockId)) {
          return { frames: [] };
        }
        const text = readVerbatimString(data.text);
        if (!text || !hasVisibleText(text)) {
          return { frames: [] };
        }
        return { frames: [this.thinkingFrame(blockId, text, timestamp)] };
      }

      case 'session.tool.input.started': {
        const callId = readOptionalString(data.id);
        const name = readOptionalString(data.name) ?? 'Tool';
        if (!callId) {
          return { frames: [] };
        }
        this.toolCalls.set(callId, { name, input: {} });
        return { frames: [this.toolUseFrame(callId, name, {}, timestamp)] };
      }

      case 'session.tool.input.ended': {
        const callId = readOptionalString(data.id);
        if (!callId) {
          return { frames: [] };
        }
        const parsedInput = parseToolInputText(data.text);
        if (parsedInput === undefined) {
          return { frames: [] };
        }
        const known = this.toolCalls.get(callId);
        const name = known?.name ?? 'Tool';
        this.toolCalls.set(callId, { name, input: parsedInput });
        return { frames: [this.toolUseFrame(callId, name, parsedInput, timestamp)] };
      }

      case 'session.tool.called': {
        const callId = readOptionalString(data.id);
        if (!callId) {
          return { frames: [] };
        }
        const known = this.toolCalls.get(callId);
        const name = known?.name ?? readOptionalString(data.name) ?? 'Tool';
        const input = data.input ?? known?.input ?? {};
        this.toolCalls.set(callId, { name, input });
        return { frames: [this.toolUseFrame(callId, name, input, timestamp)] };
      }

      case 'session.tool.success': {
        const callId = readOptionalString(data.id);
        if (!callId) {
          return { frames: [] };
        }
        const known = this.toolCalls.get(callId);
        const launch = known ? readBackgroundLaunch(callId, known.name, known.input, data.metadata) : null;
        if (launch) {
          // The call only says the work started; its card runs until the
          // engine's notice, and it is no longer this run's to settle.
          this.openSubagentCalls.delete(callId);
          const result = this.toolResultFrame(callId, formatToolOutput(data.content), false, timestamp);
          result.toolUseResult = { isAsync: true, taskId: launch.taskId };
          return {
            frames: [result, createTaskStatusMessage(
              { provider: PROVIDER, sessionId: this.sessionId, taskId: launch.taskId, toolUseId: callId, taskType: launch.taskType },
              { id: `${callId}_started`, timestamp, event: 'started', status: 'running', description: launch.description },
            )],
            launch,
          };
        }
        const frames = [this.toolResultFrame(callId, formatToolOutput(data.content), false, timestamp)];
        if (this.openSubagentCalls.delete(callId)) {
          frames.push(this.subagentStatusFrame(callId, readSubagentChildSessionId(data.metadata) ?? callId, 'completed', timestamp));
        }
        return { frames };
      }

      case 'session.tool.failed': {
        const callId = readOptionalString(data.id);
        if (!callId) {
          return { frames: [] };
        }
        const frames = [this.toolResultFrame(callId, readErrorMessage(data.error), true, timestamp)];
        if (this.openSubagentCalls.delete(callId)) {
          frames.push(this.subagentStatusFrame(callId, callId, 'failed', timestamp));
        }
        return { frames };
      }

      case 'session.step.ended':
        // Token totals ride on the session snapshot the runtime already
        // fetches for the budget frame; nothing to accumulate here.
        return { frames: [] };

      case 'session.inbox.enqueued': {
        const item = readObjectRecord(data.item);
        if (readOptionalString(item?.type) !== 'synthetic') {
          return { frames: [] };
        }
        const notice = readBackgroundNotice(readObjectRecord(item?.payload)?.metadata);
        return notice ? { frames: [], notice } : { frames: [] };
      }

      case 'session.compaction.started':
      case 'session.compaction.ended':
      case 'session.compaction.failed':
        // Manual (`/compact`) and automatic compactions alike. A failed one
        // still ends its execution as succeeded, so the failure is shown here
        // or nowhere.
        return {
          frames: [createOpenCodeCompactionFrame({
            inputId: readOptionalString(data.inputID),
            sessionId: this.sessionId,
            timestamp,
            phase: event.type === 'session.compaction.started'
              ? 'running'
              : event.type === 'session.compaction.failed' ? 'failed' : 'done',
            reason: data.reason,
            error: data.error,
          })],
        };

      case 'session.execution.started':
        return { frames: [], executionStarted: true };

      case 'session.execution.succeeded':
        return { frames: [], terminal: { outcome: 'succeeded' } };

      case 'session.execution.failed':
        // The runtime renders the failure (one place for failures seen live
        // and failures reconciled after a stream drop), so no frame here.
        return { frames: [], terminal: { outcome: 'failed', error: readErrorMessage(data.error) } };

      case 'session.execution.interrupted':
        return {
          frames: [],
          terminal: { outcome: 'interrupted', reason: readOptionalString(data.reason) ?? 'unknown' },
        };

      default:
        // step.started/streamed/failed, text/reasoning.started, usage.updated,
        // inbox.delivered, model/agent.selected, permissions, instructions.updated and
        // anything newer carry nothing the timeline renders on its own.
        return { frames: [] };
    }
  }

  private thinkingFrame(blockId: string, content: string, timestamp: string): NormalizedMessage {
    return createNormalizedMessage({
      id: blockId,
      sessionId: this.sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'thinking',
      content,
    });
  }

  private toolUseFrame(callId: string, engineToolName: string, engineInput: unknown, timestamp: string): NormalizedMessage {
    const isSubagent = isOpenCodeSubagentTool(engineToolName);
    if (isSubagent) {
      this.openSubagentCalls.add(callId);
    }
    return createNormalizedMessage({
      id: callId,
      sessionId: this.sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName: toClientToolName(engineToolName),
      toolInput: isSubagent
        ? toAgentCardInput(engineInput)
        : isOpenCodeQuestionTool(engineToolName) ? toQuestionCardInput(engineInput) : engineInput,
      toolId: callId,
    });
  }

  private subagentStatusFrame(
    callId: string,
    taskId: string,
    status: 'completed' | 'failed' | 'stopped',
    timestamp: string,
  ): NormalizedMessage {
    return createTaskStatusMessage(
      { provider: PROVIDER, sessionId: this.sessionId, taskId, toolUseId: callId, taskType: LOCAL_AGENT_TASK_TYPE },
      { id: `${callId}_status`, timestamp, event: 'notification', status },
    );
  }

  private toolResultFrame(callId: string, content: string, isError: boolean, timestamp: string): NormalizedMessage {
    return createNormalizedMessage({
      id: `${callId}_result`,
      sessionId: this.sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_result',
      toolId: callId,
      content,
      isError,
      toolResult: { content, isError },
    });
  }
}

/** `session.tool.input.ended` carries the raw argument JSON as text; unparseable text is skipped. */
function parseToolInputText(text: unknown): unknown {
  const raw = readOptionalString(text);
  if (raw === undefined) {
    return undefined;
  }
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
