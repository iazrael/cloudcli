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
 * The quiet transcript line a cancelled model request degrades to (live and
 * in replayed history). A user-initiated stop never reaches the stream at
 * all; this notice only covers cancellations the user did not ask for.
 */
export const ZCODE_CANCELLED_NOTICE = '回复已中断';

/**
 * i18n key paired with {@link ZCODE_CANCELLED_NOTICE}: the client renders the
 * notice through `taskNotices.replyInterrupted` in its own locale (chat
 * namespace); the Chinese literal above is only the fallback for consumers
 * that do not resolve keys (transcript export, older clients).
 */
export const ZCODE_CANCELLED_NOTICE_KEY = 'taskNotices.replyInterrupted';

/**
 * Whether an engine error record denotes a cancelled model request rather
 * than a real failure. Matches the engine's own cancellation predicates —
 * `turn_cancelled`/`model_request_cancelled`/`ABORT_ERR` codes, a
 * `cancelled` turn result, or an `AbortError` name — along the `cause`
 * chain, accepting both the serialized `{ name, data: { code, turnResult } }`
 * shape and flat fields. Rate limits and provider faults do not match, so
 * they keep surfacing as errors.
 *
 * Consumed by the live-event error mapping and by history normalization, so
 * a reload renders the same quiet line the live stream did.
 */
export function isZCodeCancelledEngineError(value: unknown): boolean {
  let current: unknown = value;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const record = readObjectRecord(current);
    if (!record) {
      return false;
    }
    const nested = readObjectRecord(record.data);
    const code = readOptionalString(record.code) ?? readOptionalString(nested?.code);
    const turnResult = readOptionalString(record.turnResult) ?? readOptionalString(nested?.turnResult);
    if (
      readOptionalString(record.type) === 'turn_cancelled'
      || code === 'turn_cancelled'
      || code === 'model_request_cancelled'
      || code === 'ABORT_ERR'
      || turnResult === 'cancelled'
      || readOptionalString(record.name) === 'AbortError'
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

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
 * Stream key for engine generations whose `tool_input_*` events carry no
 * `toolCallId`. Those generations announce exactly one call at a time, so a
 * single fallback slot reproduces the old single-stream behavior; keyed
 * engines never collide with it because real ids are longer identifiers.
 */
const LEGACY_SINGLE_STREAM_KEY = '_';

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
  /**
   * Per-toolCallId parameter streams, keyed by session first. The engine
   * streams several parallel calls' arguments interleaved (each
   * `tool_input_*` event names its own `toolCallId`), so a session-wide
   * single stream would misattribute every fragment after the second
   * announce and leave all but one tool card permanently blank.
   */
  private readonly toolInputStreams = new Map<string, Map<string, ToolInputStream>>();

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
      // Serialized adapter errors carry their message nested in `data`
      // (`{ name, data: { message, code, ... } }`); flat records keep the
      // top-level fields.
      const errorText = readOptionalString(errorRecord?.message)
        ?? readOptionalString(readObjectRecord(errorRecord?.data)?.message)
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
        // The runtime decides per run whether a cancellation is the user's
        // own stop (drop the frame) or an engine-side one (degrade to a
        // quiet line); the flag only carries the engine's verdict here.
        isCancelledError: isZCodeCancelledEngineError(payload.error),
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
    this.registerToolInputStream(sessionId ?? '', toolId, toolName);
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
      this.registerToolInputStream(stateKey, toolCallId, toolName);
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

  private registerToolInputStream(stateKey: string, toolCallId: string, toolName: string): ToolInputStream {
    let perSession = this.toolInputStreams.get(stateKey);
    if (!perSession) {
      perSession = new Map<string, ToolInputStream>();
      this.toolInputStreams.set(stateKey, perSession);
    }
    const stream: ToolInputStream = { toolCallId, toolName, buffer: '' };
    perSession.set(toolCallId, stream);
    return stream;
  }

  private deleteToolInputStream(stateKey: string, toolCallId: string): void {
    const perSession = this.toolInputStreams.get(stateKey);
    if (!perSession) {
      return;
    }
    perSession.delete(toolCallId);
    if (perSession.size === 0) {
      this.toolInputStreams.delete(stateKey);
    }
  }

  private normalizeToolInputEvent(
    payload: AnyRecord,
    sessionId: string | null,
    timestamp: string,
    kind: string,
  ): NormalizedMessage[] {
    const stateKey = sessionId ?? '';
    const toolCallId = readOptionalString(payload.toolCallId) ?? LEGACY_SINGLE_STREAM_KEY;
    let stream = this.toolInputStreams.get(stateKey)?.get(toolCallId);

    if (!stream && toolCallId === LEGACY_SINGLE_STREAM_KEY) {
      // Un-keyed fragments belong to the session's only open call (legacy
      // engines announce one call at a time), so borrow that stream instead
      // of opening an unattributable one.
      const solo = this.toolInputStreams.get(stateKey);
      if (solo?.size === 1) {
        stream = [...solo.values()][0];
      }
    }

    if (!stream) {
      // An announce can be absent when the engine skips the scheduled stage;
      // `tool_input_start` carries the call's name and id, so it may open the
      // stream itself. Unannounced delta/end fragments stay ignored.
      if (kind !== 'tool_input_start') {
        return [];
      }
      stream = this.registerToolInputStream(
        stateKey,
        toolCallId,
        readOptionalString(payload.toolName) ?? 'Tool',
      );
    }

    const deltaText = typeof payload.delta === 'string' ? payload.delta : undefined;
    if (deltaText) {
      stream.buffer += deltaText;
    }
    if (kind === 'tool_input_start') {
      stream.buffer = '';
      const named = readOptionalString(payload.toolName);
      if (named) {
        stream.toolName = named;
      }
      return [];
    }

    const engineInput = readObjectRecord(payload.input);
    const parsedInput = engineInput ?? tryParseJsonObject(stream.buffer);
    if (!parsedInput) {
      if (kind === 'tool_input_end') {
        this.deleteToolInputStream(stateKey, stream.toolCallId);
      }
      return [];
    }
    if (kind === 'tool_input_end') {
      this.deleteToolInputStream(stateKey, stream.toolCallId);
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
