/**
 * OpenCode Session Event Translator
 *
 * Turns the service's session-scoped SSE events into the NormalizedMessage
 * frames the chat timeline already understands. Event names and payloads
 * are pinned to what v2.0.31 emits (captured live; see the tests' fixtures):
 *
 * - `session.text.delta` → `stream_delta`; `session.text.ended` → `stream_end`
 * - `session.reasoning.delta` → `thinking` deltas under one stable block id
 *   (the timeline appends same-id thinking frames, so deltas, not totals)
 * - `session.tool.input.started` / `tool.called` → `tool_use` snapshots that
 *   the timeline upserts by toolId; `tool.success` / `tool.failed` → `tool_result`
 * - `session.step.ended` → no frames, but its per-step `tokens` ride on the
 *   result so the runtime can publish the live context-occupancy frame
 *   (session-lifetime totals live on the API snapshot and are a different
 *   number — see `opencode-context-usage.ts`)
 * - `session.compaction.*` → no frames; a `.failed` carries the reason on the
 *   result, which the runtime's own `/compact` run turns into a failure (an
 *   automatic compaction inside a normal turn changes nothing)
 * - `session.execution.{succeeded,failed,interrupted}` → run terminal
 *
 * Ids on transcript rows (thinking / tool_use / tool_result) derive from the
 * engine's own identifiers (assistant message id + ordinal, tool call id) so
 * the same record never arrives under two ids. Assistant *text* has no row id
 * on the live path — the service streams fragments of a row it never
 * announces — so each text part also publishes the cross-transport
 * `providerRowKey` its persisted row carries; see `buildOpenCodeTextRowKey`.
 * Unknown event types are ignored on purpose: the service is young and adds
 * events between patch releases.
 *
 * @module opencode-event-translator
 */

import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import type { OpenCodeStepTokens } from './opencode-context-usage.js';
import { readOpenCodeStepTokens } from './opencode-context-usage.js';
import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';
import { formatOpenCodeToolBlock } from './opencode-tool-output.js';

const PROVIDER = 'opencode' as const;

/** Spawn tool spellings: v2 `subagent`, v1 `task`. */
const SUBAGENT_TOOL_NAMES = new Set(['subagent', 'task']);

//----------------- TRANSLATION RESULTS ------------

/** How a run ended, as reported by `session.execution.*`. */
export type OpenCodeRunOutcome =
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'interrupted'; reason: string };

/**
 * Frames to forward plus, on execution-terminal events, how the run ended;
 * `stepTokens` rides on `session.step.ended`, whose `tokens` describe that
 * step's context occupancy (the runtime turns it into the live
 * `token_budget` frame), and `compactionError` on `session.compaction.failed`,
 * which only a run that asked for the compaction treats as its own failure.
 *
 * Consumer: opencode runtime.
 */
export type OpenCodeTranslatedEvent = {
  frames: NormalizedMessage[];
  terminal?: OpenCodeRunOutcome;
  stepTokens?: OpenCodeStepTokens;
  compactionError?: string;
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

/** Joins the `content` blocks of a tool result (`[{type:'text', text}]`) into one string. */
const formatToolOutput = (content: unknown): string => {
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
      return readVerbatimString(record.text) ?? (record.type === 'text' ? '' : formatOpenCodeToolBlock(record));
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
 * A foreground subagent's result is wrapped in `<subagent …>…</subagent>`.
 * The card's result section wants the answer, not the transport envelope.
 */
const unwrapSubagentResult = (content: string): string => {
  const match = /^<subagent\b[^>]*>([\s\S]*?)<\/subagent>$/.exec(content.trim());
  return match ? match[1].trim() : content;
};

/**
 * The cross-transport identity of one assistant text part.
 *
 * The service streams a reply as fragments of a row it never announces, and
 * the persisted copy lives in the message's `content` array — two row ids
 * that cannot match. What both transports do carry is the engine's own text
 * part coordinates: the message id plus the part's ordinal within that
 * message's text parts (`session.text.*` events publish exactly that
 * ordinal; the database stores the blocks in that order). Publishing them as
 * the row key is what lets a persisted reply retire the streamed bubble
 * instead of rendering beside it — see `reconcileProviderRowText` in the
 * client timeline store.
 *
 * The ordinal counts text parts only, not content blocks: a message holding
 * `[reasoning, text]` has text ordinal 0, so reasoning parts must never be
 * folded into this counter. Reasoning keeps the client's content-equality
 * path (`sessionThinkingRows.ts`); it has no key.
 *
 * Consumers: this module (live `session.text.delta` frames) and
 * `opencode-sessions.provider.ts` (the persisted row for the same part).
 * Both must derive the key the same way, or the streamed reply renders beside
 * its persisted copy until the session is reloaded.
 */
export function buildOpenCodeTextRowKey(messageId: string, textPartOrdinal: number): string {
  return `opencode-part:${messageId}_text_${textPartOrdinal}`;
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

  constructor(
    /** The app session id stamped on every frame (the writer owns provider↔app mapping). */
    private readonly sessionId: string,
  ) {}

  getToolCall(callId: string): OpenCodeToolCall | null {
    return this.toolCalls.get(callId) ?? null;
  }

  translate(event: OpenCodeEventEnvelope): OpenCodeTranslatedEvent {
    const data = readObjectRecord(event.data) ?? {};
    const timestamp = toTimestamp(event);
    const messageId = readOptionalString(data.assistantMessageID) ?? 'message';
    const ordinal = toNumber(data.ordinal);

    switch (event.type) {
      case 'session.text.delta': {
        const delta = readVerbatimString(data.delta);
        if (!delta) {
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
            providerRowKey: buildOpenCodeTextRowKey(messageId, ordinal),
          })],
        };
      }

      case 'session.text.ended':
        return {
          frames: [createNormalizedMessage({
            id: `${messageId}_text_${ordinal}_end`,
            sessionId: this.sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'stream_end',
          })],
        };

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
        if (!text?.trim()) {
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
        const toolName = this.toolCalls.get(callId)?.name;
        const isSubagent = toolName ? SUBAGENT_TOOL_NAMES.has(toolName) : false;
        const content = formatToolOutput(data.content);
        if (isSubagent) {
          // A background launch's success is only its acknowledgement: the
          // agent is still running, and its answer arrives with the child's
          // terminal. Marking it async keeps the card's spinner on.
          const metadataStatus = readOptionalString(readObjectRecord(data.metadata)?.status);
          const launchedInBackground = metadataStatus === 'running'
            || metadataStatus === 'pending'
            || (!metadataStatus && content.includes('working in the background'));
          if (launchedInBackground) {
            return { frames: [this.toolResultFrame(callId, '', false, timestamp, { isAsync: true })] };
          }
          return { frames: [this.toolResultFrame(callId, unwrapSubagentResult(content), false, timestamp)] };
        }
        return { frames: [this.toolResultFrame(callId, content, false, timestamp)] };
      }

      case 'session.tool.failed': {
        const callId = readOptionalString(data.id);
        if (!callId) {
          return { frames: [] };
        }
        return { frames: [this.toolResultFrame(callId, readErrorMessage(data.error), true, timestamp)] };
      }

      case 'session.step.ended': {
        // Step occupancy, not the session's lifetime totals: the runtime
        // forwards it as the live token-budget frame so the composer badge
        // tracks the same number a reload reads from the database.
        const stepTokens = readOpenCodeStepTokens(data.tokens);
        return { frames: [], ...(stepTokens ? { stepTokens } : {}) };
      }

      case 'session.compaction.failed':
        // The engine still ends the execution normally after this (the probe
        // shows `execution.succeeded` right behind it), so the run's own
        // terminal stays with the execution; the reason rides along for the
        // compaction run that must report it — see the run registry.
        return { frames: [], compactionError: readErrorMessage(data.error) };

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
        // inbox.*, model/agent.selected, permissions, instructions.updated,
        // the compaction lifecycle itself (started/delta/ended — its summary
        // reaches the transcript through history, not through live frames)
        // and anything newer carry nothing the timeline renders on its own.
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

  private toolUseFrame(callId: string, toolName: string, toolInput: unknown, timestamp: string): NormalizedMessage {
    return createNormalizedMessage({
      id: callId,
      sessionId: this.sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName,
      toolInput,
      toolId: callId,
    });
  }

  private toolResultFrame(
    callId: string,
    content: string,
    isError: boolean,
    timestamp: string,
    toolUseResult?: unknown,
  ): NormalizedMessage {
    return createNormalizedMessage({
      id: `${callId}_result`,
      sessionId: this.sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_result',
      toolId: callId,
      content,
      isError,
      toolResult: { content, isError, ...(toolUseResult === undefined ? {} : { toolUseResult }) },
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
