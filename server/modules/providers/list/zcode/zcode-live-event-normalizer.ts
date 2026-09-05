import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  normalizeProviderTimestamp,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

const PROVIDER = 'zcode';

/**
 * Engine 0.16.5 renamed these event types. Both engine generations therefore
 * enter the same ZCode real-time event module.
 */
const EVENT_TYPE_ALIASES: Record<string, string> = {
  'model.streaming': 'model_streaming',
  'turn.completed': 'turn_complete',
  'tool.updated': 'tool_call_scheduled',
  'permission.requested': 'permission_request',
};

type ToolInputStream = {
  toolCallId: string;
  toolName: string;
  buffer: string;
};

/**
 * Reads ZCode's streaming or persisted token shapes into one used-token count.
 * ZCode history normalization also consumes this helper for identical tokens.
 */
export function readZCodeTokenUsedCount(value: unknown): number | undefined {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const cacheRecord = readObjectRecord(record.cache);
  const input = Number(record.inputTokens ?? record.input ?? 0);
  const output = Number(record.outputTokens ?? record.output ?? 0);
  const reasoning = Number(record.reasoningTokens ?? record.reasoning ?? 0);
  const cache = cacheRecord
    ? Number(cacheRecord.read ?? 0) + Number(cacheRecord.write ?? 0)
    : Number(record.cacheReadTokens ?? 0) + Number(record.cacheWriteTokens ?? 0);
  const used = input + output + reasoning + cache;

  return used > 0 ? used : undefined;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  const record = readObjectRecord(value);
  return readOptionalString(record?.text)
    ?? readOptionalString(record?.content)
    ?? readOptionalString(record?.delta)
    ?? '';
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Turns ZCode real-time session events into normalized chat records.
 *
 * Consumer: ZCodeSessionsProvider delegates its public live-event interface
 * here. The module owns all per-session reasoning and tool-input state, while
 * callers only submit an event or reset a terminal session.
 */
export class ZCodeLiveEventNormalizer {
  private readonly reasoningBlockIds = new Map<string, string>();
  private readonly toolInputStreams = new Map<string, ToolInputStream>();

  normalize(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    let event: AnyRecord = raw;
    for (let depth = 0; depth < 3 && !readOptionalString(event.type); depth += 1) {
      const next = readObjectRecord(event.event)
        ?? readObjectRecord(event.data)
        ?? readObjectRecord(event.params);
      if (!next) {
        break;
      }
      event = next;
    }

    const type = readOptionalString(event.type) ?? readOptionalString(event.event);
    if (!type) {
      return [];
    }

    const payload = readObjectRecord(event.payload) ?? {};
    const eventSessionId = readOptionalString(event.sessionId)
      ?? readOptionalString(raw.sessionId)
      ?? sessionId;
    const timestamp = normalizeProviderTimestamp(event.time ?? event.timestamp);
    const baseId = readOptionalString(event.id)
      ?? readOptionalString(event.messageID)
      ?? readOptionalString(payload.messageId)
      ?? generateMessageId('zcode');
    const normalizedType = EVENT_TYPE_ALIASES[type] ?? type;

    if (normalizedType === 'model_streaming') {
      return this.normalizeStreamingKind(payload, eventSessionId, timestamp, baseId);
    }

    if (normalizedType === 'tool_call_scheduled') {
      return this.normalizeScheduledTool(payload, eventSessionId, timestamp, baseId);
    }

    if (normalizedType === 'model_complete' || normalizedType === 'turn_complete') {
      this.resetSession(eventSessionId);
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'complete',
        tokens: readZCodeTokenUsedCount(payload.usage),
      })];
    }

    if (normalizedType === 'permission_request' || normalizedType === 'approval') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'permission_request',
        toolName: readOptionalString(payload.tool) ?? readOptionalString(payload.toolName) ?? readOptionalString(payload.action),
        requestId: readOptionalString(payload.requestId) ?? baseId,
        toolId: readOptionalString(payload.toolCallId),
        input: payload.input,
        context: {
          riskLevel: readOptionalString(payload.riskLevel),
          reason: readOptionalString(payload.reason),
          options: payload.options,
          suggestedPermissionUpdates: payload.suggestedPermissionUpdates,
        },
        canInterrupt: true,
      })];
    }

    if (normalizedType === 'error' || normalizedType === 'fatal' || normalizedType === 'turn.failed') {
      const errorRecord = readObjectRecord(payload.error);
      const errorText = readOptionalString(errorRecord?.message)
        ?? readOptionalString(payload.error)
        ?? readOptionalString(payload.message)
        ?? 'Unknown ZCode error';
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'error',
        isError: true,
        content: errorText,
        text: errorText,
      })];
    }

    return [];
  }

  /**
   * Drops incomplete state for one terminal ZCode session. It is safe to call
   * after a normal completion because both maps are already empty then.
   */
  resetSession(sessionId: string | null): void {
    const stateKey = sessionId ?? '';
    this.reasoningBlockIds.delete(stateKey);
    this.toolInputStreams.delete(stateKey);
  }

  private normalizeScheduledTool(
    payload: AnyRecord,
    sessionId: string | null,
    timestamp: string,
    baseId: string,
  ): NormalizedMessage[] {
    const stage = readOptionalString(payload.kind);
    if (stage === 'started' || stage === 'progress' || stage === 'batch') {
      return [];
    }
    if (stage === 'result' || stage === 'error') {
      const resultPartId = readOptionalString(payload.resultPartId);
      const content = resultPartId ? `Result stored in part ${resultPartId}` : '';
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: readOptionalString(payload.toolCallId) ?? baseId,
        content,
        toolResult: { content, isError: stage === 'error' },
      })];
    }

    const toolName = readOptionalString(payload.toolName) ?? 'Tool';
    const toolId = readOptionalString(payload.toolCallId) ?? baseId;
    this.toolInputStreams.set(sessionId ?? '', { toolCallId: toolId, toolName, buffer: '' });
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName,
      toolInput: payload.input ?? {},
      toolId,
    })];
  }

  private normalizeStreamingKind(
    payload: AnyRecord,
    sessionId: string | null,
    timestamp: string,
    baseId: string,
  ): NormalizedMessage[] {
    const kind = readOptionalString(payload.kind);
    const stateKey = sessionId ?? '';

    if (kind === 'reasoning_start') {
      this.openReasoningBlock(stateKey);
      return [];
    }

    if (kind === 'reasoning_delta') {
      const content = extractText(payload.delta);
      if (!content) {
        return [];
      }
      return [createNormalizedMessage({
        id: this.openReasoningBlock(stateKey),
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'thinking',
        content,
      })];
    }

    if (kind === 'reasoning_end') {
      this.reasoningBlockIds.delete(stateKey);
      return [];
    }

    if (kind === 'tool_input_start' || kind === 'tool_input_delta' || kind === 'tool_input_end') {
      return this.normalizeToolInputEvent(payload, sessionId, timestamp, kind);
    }

    if (kind) {
      this.reasoningBlockIds.delete(stateKey);
    }

    if (kind === 'text_start' || kind === 'text_end') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_end',
      })];
    }

    if (kind === 'text_delta') {
      const content = extractText(payload.delta);
      if (!content) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_delta',
        role: 'assistant',
        content,
      })];
    }

    if (kind === 'tool_call') {
      const toolCallId = readOptionalString(payload.toolCallId) ?? baseId;
      const toolName = readOptionalString(payload.toolName) ?? 'Tool';
      this.toolInputStreams.set(stateKey, { toolCallId, toolName, buffer: '' });
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName,
        toolInput: payload.input ?? {},
        toolId: toolCallId,
      })];
    }

    if (kind === 'tool_result') {
      const resultPartId = readOptionalString(payload.resultPartId);
      const content = resultPartId ? `Result stored in part ${resultPartId}` : '';
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: readOptionalString(payload.toolCallId) ?? baseId,
        content,
        toolResult: { content, isError: false },
      })];
    }

    return [];
  }

  private openReasoningBlock(stateKey: string): string {
    const existing = this.reasoningBlockIds.get(stateKey);
    if (existing) {
      return existing;
    }
    const id = generateMessageId('zcode_reasoning');
    this.reasoningBlockIds.set(stateKey, id);
    return id;
  }

  private normalizeToolInputEvent(
    payload: AnyRecord,
    sessionId: string | null,
    timestamp: string,
    kind: string,
  ): NormalizedMessage[] {
    const stateKey = sessionId ?? '';
    const stream = this.toolInputStreams.get(stateKey);
    if (!stream) {
      return [];
    }

    const deltaText = typeof payload.delta === 'string' ? payload.delta : undefined;
    if (deltaText) {
      stream.buffer += deltaText;
    }
    if (kind === 'tool_input_start') {
      stream.buffer = '';
      return [];
    }

    const engineInput = readObjectRecord(payload.input);
    const parsedInput = engineInput ?? tryParseJsonObject(stream.buffer);
    if (!parsedInput) {
      if (kind === 'tool_input_end') {
        this.toolInputStreams.delete(stateKey);
      }
      return [];
    }
    if (kind === 'tool_input_end') {
      this.toolInputStreams.delete(stateKey);
    }

    return [createNormalizedMessage({
      id: stream.toolCallId,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName: stream.toolName,
      toolInput: parsedInput,
      toolId: stream.toolCallId,
    })];
  }
}
