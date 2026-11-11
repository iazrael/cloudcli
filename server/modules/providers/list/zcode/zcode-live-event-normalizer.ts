import {
  LOCAL_AGENT_TASK_TYPE,
  createTaskStatusMessage,
} from '@/modules/providers/shared/background-work/task-status.js';
import type { AnyRecord, NormalizedMessage, TaskUsage } from '@/shared/types.js';
import {
  compactProviderPayload,
  createCompactionMessage,
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
 * The cross-transport identity of one ZCode assistant text row.
 *
 * ZCode names a persisted row `(message_id, part_id)` but its live stream
 * only ever mentions the message: text arrives as `text_delta` events whose
 * `payload.assistantMessageId` is the reply's message id, while the event
 * envelope's own `id` is a fresh `crypto.randomUUID()` per event and joins
 * nothing. The message id is the one thing both sides carry, so it becomes
 * the row key and the client reconciles the streamed body against the
 * persisted one through it.
 *
 * Consumers: this normalizer (live deltas) and `zcode-sessions.provider.ts`
 * (persisted rows). Both must derive the key the same way or the streamed
 * reply renders beside its persisted copy.
 */
export function buildZCodeTextRowKey(messageId: string): string {
  return `zcode-message:${messageId}`;
}

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
 * One engine session event with its envelope peeled: the typed record the
 * engine built (`{ id, sessionId, type, timestamp, payload }`), found under
 * up to three layers of transport wrapping (`session/event` notification
 * params, `{ event }`, `{ data }`).
 */
type ZCodeSessionEvent = {
  type: string;
  payload: AnyRecord;
  sessionId: string | null;
  timestamp: string;
  /** The engine's own id for the event, or a fresh one when it sent none. */
  id: string;
  /** The engine turn the event belongs to; absent on session-level events. */
  turnId?: string;
};

/**
 * Unwraps a raw engine notification into its typed session event, or null
 * when nothing typed is inside. `fallbackSessionId` stands in when the event
 * names no session.
 *
 * Consumers: this normalizer's `normalize`; the runtime's run listener,
 * which reads the turn id and `inputId` to tell its own turn's terminal events
 * from those of turns the engine started itself; and the runtime's subagent
 * lifecycle watcher, which reads the same envelope outside a run.
 */
export function readZCodeSessionEvent(rawMessage: unknown, fallbackSessionId: string | null): ZCodeSessionEvent | null {
  const raw = readObjectRecord(compactProviderPayload(rawMessage));
  if (!raw) {
    return null;
  }

  let event: AnyRecord = raw;
  for (let depth = 0; depth < 3 && !readOptionalString(event.type); depth += 1) {
    const next = readObjectRecord(event.event)
      ?? readObjectRecord(compactProviderPayload(event.data))
      ?? readObjectRecord(event.params);
    if (!next) {
      break;
    }
    event = next;
  }

  const type = readOptionalString(event.type) ?? readOptionalString(event.event);
  if (!type) {
    return null;
  }

  const payload = readObjectRecord(event.payload) ?? {};
  return {
    type: EVENT_TYPE_ALIASES[type] ?? type,
    payload,
    sessionId: readOptionalString(event.sessionId) ?? readOptionalString(raw.sessionId) ?? fallbackSessionId,
    timestamp: normalizeProviderTimestamp(event.time ?? event.timestamp),
    id: readOptionalString(event.id)
      ?? readOptionalString(event.messageID)
      ?? readOptionalString(payload.messageId)
      ?? generateMessageId('zcode'),
    turnId: readOptionalString(event.turnId),
  };
}

/**
 * Whether an event type is one of the two subagent lifecycle events this
 * module translates.
 *
 * Consumers: `normalize` (dispatch) and the runtime's subagent lifecycle
 * watcher, which must forward exactly these and ignore the rest of the stream.
 */
export function isZCodeSubagentLifecycleEvent(type: string): boolean {
  return type === 'subagent_spawned' || type === 'subagent_stopped';
}

/** An engine-reported total, or undefined when the engine did not report one (or reported nonsense). */
const readReportedTotal = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return value !== undefined && value !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/**
 * Translates the engine's subagent lifecycle events — emitted on the PARENT
 * session when an `Agent` call's child session is ready and when it stops —
 * into the `task_status` events the client folds onto the launching Agent
 * card. Both events name the call that started the run (`parentToolCallId`);
 * one that does not is dropped, because an unattached status has no card to
 * land on. `cardToolUseId` is that call as the caller resolved it: for a
 * resumed agent, the original `Agent` call rather than the SendMessage.
 *
 * `subagent_spawned` marks the card running. `subagent_stopped` settles it:
 * the engine reports `completed` or `failed` and, on failure, the error as the
 * summary. Its totals become the card's usage line, but only the ones the
 * engine sent: a failure stop carries no token or tool-call totals, and a
 * missing figure stays missing instead of reading as a measured zero.
 */
function normalizeZCodeSubagentLifecycleEvent(
  event: ZCodeSessionEvent,
  cardToolUseId: string | undefined,
): NormalizedMessage | null {
  const { payload } = event;
  const taskId = readOptionalString(payload.agentId);
  const toolUseId = cardToolUseId;
  if (!taskId || !toolUseId) {
    return null;
  }

  const subject = {
    provider: PROVIDER,
    sessionId: event.sessionId,
    taskId,
    toolUseId,
    taskType: LOCAL_AGENT_TASK_TYPE,
  } as const;
  const timing = { id: event.id, timestamp: event.timestamp };

  if (event.type === 'subagent_spawned') {
    return createTaskStatusMessage(subject, {
      ...timing,
      event: 'started',
      description: readOptionalString(payload.description) ?? readOptionalString(payload.prompt),
      ...(payload.resumed === true ? { resumed: true } : {}),
    });
  }

  const reported = readOptionalString(payload.status);
  const status = reported === 'completed' || reported === 'failed' ? reported : 'stopped';
  const reportedUsage: Record<keyof TaskUsage, number | undefined> = {
    totalTokens: readReportedTotal(payload.totalTokens),
    toolUses: readReportedTotal(payload.totalToolUseCount),
    durationMs: readReportedTotal(payload.totalDurationMs),
  };
  // Keep only the figures the engine sent.
  const usage = Object.fromEntries(
    Object.entries(reportedUsage).filter(([, value]) => value !== undefined),
  ) as TaskUsage;
  const hasUsage = Object.keys(usage).length > 0;
  return createTaskStatusMessage(subject, {
    ...timing,
    event: 'notification',
    status,
    summary: readOptionalString(payload.error),
    usage: hasUsage ? usage : undefined,
    outputFile: readOptionalString(payload.outputFile),
  });
}

/**
 * Turns ZCode real-time session events into normalized chat records.
 *
 * Consumer: ZCodeSessionsProvider delegates its public live-event interface
 * here. The module owns all per-session reasoning and tool-input state, while
 * callers only submit an event or reset a terminal session.
 */
const readPositiveNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
);

/**
 * The compaction row of one compaction operation, as the shared row every
 * provider draws (`createCompactionMessage`).
 *
 * The operation is the `compaction` part of the visible timeline message the
 * engine writes when a compaction starts; its live updates name the same part
 * (`partId`), so both transports derive the row id from that part and the
 * persisted row replaces the live one. `fields` is either the persisted part
 * (`timelineStatus`, `time.start/end`) or a live update's payload (`status`,
 * `startedAt/endedAt`). Consumers: this normalizer (live) and the ZCode
 * sessions provider (history).
 */
export function createZCodeCompactionMessage(
  fields: AnyRecord,
  partId: string,
  sessionId: string | null,
  timestamp: string,
): NormalizedMessage {
  const status = readOptionalString(fields.timelineStatus) ?? readOptionalString(fields.status);
  const phase = status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'running';
  const trigger = readOptionalString(fields.trigger);
  const time = readObjectRecord(fields.time);
  const startedAt = readPositiveNumber(time?.start) ?? readPositiveNumber(fields.startedAt);
  const endedAt = readPositiveNumber(time?.end) ?? readPositiveNumber(fields.endedAt);
  const errorRecord = readObjectRecord(fields.error);
  return createCompactionMessage({
    id: `${partId}_compact`,
    sessionId,
    timestamp,
    provider: PROVIDER,
    phase,
    ...(trigger === 'manual' || trigger === 'auto' ? { trigger } : {}),
    preTokens: readPositiveNumber(fields.preCompactTokenCount),
    // `postCompactTokenCount` counts more than the context the model sees
    // next; the engine's own "true" count is the one that shrank.
    postTokens: readPositiveNumber(fields.truePostCompactTokenCount) ?? readPositiveNumber(fields.postCompactTokenCount),
    durationMs: startedAt && endedAt && endedAt > startedAt ? endedAt - startedAt : undefined,
    ...(phase === 'failed'
      ? { error: readOptionalString(errorRecord?.message) ?? readOptionalString(fields.error) ?? null }
      : {}),
  });
}

/**
 * The summary a compaction wrote, as the row the client folds into the
 * compaction row. Named after the summary message, which the live update that
 * ends the compaction names too. Consumers: this normalizer and the ZCode
 * sessions provider.
 */
export function createZCodeCompactSummaryMessage(
  summaryMessageId: string,
  sessionId: string | null,
  timestamp: string,
  content: string,
): NormalizedMessage {
  return createNormalizedMessage({
    id: `${summaryMessageId}_summary`,
    sessionId,
    timestamp,
    provider: PROVIDER,
    kind: 'text',
    role: 'assistant',
    content,
    isCompactSummary: true,
  });
}

type ZCodeLiveEventNormalizerOptions = {
  /**
   * The `Agent` call in an engine session whose result names this agent, or
   * undefined when none does. Asked once per resume of a stopped agent.
   */
  findAgentLaunchCallId?: (engineSessionId: string, agentId: string) => string | undefined;
};

export class ZCodeLiveEventNormalizer {
  private readonly findAgentLaunchCallId: (engineSessionId: string, agentId: string) => string | undefined;

  /**
   * Per session: the SendMessage call that resumed a stopped agent → the
   * `Agent` call that launched it. The engine reports the resumed run — its
   * lifecycle and its mirrored tool calls — on the SendMessage call, while
   * the card is the original launch's, as in the engine's own UI. Learned
   * from the resumed spawn, dropped at the run's stop, and deliberately not
   * cleared at turn end: the agent outlives the turn that resumed it.
   */
  private readonly agentCardByResumeCall = new Map<string, Map<string, string>>();

  constructor({ findAgentLaunchCallId = () => undefined }: ZCodeLiveEventNormalizerOptions = {}) {
    this.findAgentLaunchCallId = findAgentLaunchCallId;
  }

  /**
   * The summary text of the compaction running in each session. The engine
   * streams it before the update that ends the compaction, and only that
   * update names the summary message the row is called after.
   */
  private readonly compactionSummaries = new Map<string, string>();
  private readonly reasoningBlockIds = new Map<string, string>();
  /**
   * Per-toolCallId parameter streams, keyed by session first. The engine
   * streams several parallel calls' arguments interleaved (each
   * `tool_input_*` event names its own `toolCallId`), so a session-wide
   * single stream would misattribute every fragment after the second
   * announce and leave all but one tool card permanently blank.
   */
  private readonly toolInputStreams = new Map<string, Map<string, ToolInputStream>>();
  /**
   * Per-session message id of the assistant text segment currently
   * streaming. Engine generations that omit `assistantMessageId` still open
   * and close each segment with `text_start`/`text_end`, so the first delta's
   * identity is cached and reused for the rest of that segment.
   */
  private readonly textRowMessageIds = new Map<string, string>();

  normalize(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const event = readZCodeSessionEvent(rawMessage, sessionId);
    if (!event) {
      return [];
    }

    const { payload, sessionId: eventSessionId, timestamp, id: baseId, type: normalizedType } = event;

    // The engine forwards its internal compaction events under the generic
    // `session.updated` type, so they are told apart by their payload.
    if (normalizedType === 'session.updated') {
      return this.normalizeCompactionUpdate(payload, eventSessionId, timestamp);
    }

    if (normalizedType === 'model_streaming') {
      return this.normalizeStreamingKind(payload, eventSessionId, timestamp, baseId);
    }

    if (normalizedType === 'tool_call_scheduled') {
      return this.normalizeScheduledTool(payload, eventSessionId, timestamp, baseId);
    }

    if (isZCodeSubagentLifecycleEvent(normalizedType)) {
      const status = normalizeZCodeSubagentLifecycleEvent(event, this.resolveAgentCard(event));
      return status ? [status] : [];
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
   * One `session.updated` payload of a compaction: the operation's progress
   * (`operationId` `cmp_…` with `status` and `partId`) or the summary text the
   * compaction model returned (`querySource: 'compact'` with `content`).
   * Everything else under that type (model-request telemetry, message
   * counts) draws nothing.
   */
  private normalizeCompactionUpdate(payload: AnyRecord, sessionId: string | null, timestamp: string): NormalizedMessage[] {
    const stateKey = sessionId ?? '';
    if (readOptionalString(payload.querySource) === 'compact' && typeof payload.content === 'string' && !payload.baseURL) {
      this.compactionSummaries.set(stateKey, payload.content);
      return [];
    }

    const operationId = readOptionalString(payload.operationId);
    const partId = readOptionalString(payload.partId);
    if (!operationId?.startsWith('cmp_') || !partId || !readOptionalString(payload.status)) {
      return [];
    }

    const rows = [createZCodeCompactionMessage(payload, partId, sessionId, timestamp)];
    const status = readOptionalString(payload.status);
    if (status === 'completed' || status === 'failed') {
      const summary = this.compactionSummaries.get(stateKey);
      this.compactionSummaries.delete(stateKey);
      const summaryMessageId = readOptionalString(payload.summaryMessageId);
      if (status === 'completed' && summary?.trim() && summaryMessageId) {
        rows.push(createZCodeCompactSummaryMessage(summaryMessageId, sessionId, timestamp, summary));
      }
    }
    return rows;
  }

  /**
   * The card a lifecycle event belongs to. A resumed spawn names the
   * SendMessage call; it is mapped to the agent's `Agent` call when the
   * engine's history has one, and the mapping holds until the run stops.
   */
  private resolveAgentCard(event: ZCodeSessionEvent): string | undefined {
    const { payload } = event;
    const callId = readOptionalString(payload.parentToolCallId);
    const agentId = readOptionalString(payload.agentId);
    if (!callId || !agentId) {
      return callId;
    }
    const stateKey = event.sessionId ?? '';
    if (event.type === 'subagent_spawned' && payload.resumed === true && event.sessionId) {
      const launchCallId = this.findAgentLaunchCallId(event.sessionId, agentId);
      if (launchCallId && launchCallId !== callId) {
        const cards = this.agentCardByResumeCall.get(stateKey) ?? new Map<string, string>();
        cards.set(callId, launchCallId);
        this.agentCardByResumeCall.set(stateKey, cards);
      }
    }
    const cards = this.agentCardByResumeCall.get(stateKey);
    const card = cards?.get(callId) ?? callId;
    if (event.type === 'subagent_stopped' && cards?.delete(callId) && cards.size === 0) {
      this.agentCardByResumeCall.delete(stateKey);
    }
    return card;
  }

  /** The card a mirrored tool event belongs to, or undefined for a main-thread event. */
  private readSubagentCard(payload: AnyRecord, sessionId: string | null): string | undefined {
    if (readOptionalString(payload.source) !== 'subagent') {
      return undefined;
    }
    const callId = readOptionalString(payload.parentToolCallId);
    return callId && (this.agentCardByResumeCall.get(sessionId ?? '')?.get(callId) ?? callId);
  }

  /**
   * Drops incomplete state for one terminal ZCode session. It is safe to call
   * after a normal completion because both maps are already empty then.
   */
  resetSession(sessionId: string | null): void {
    const stateKey = sessionId ?? '';
    this.reasoningBlockIds.delete(stateKey);
    this.toolInputStreams.delete(stateKey);
    this.textRowMessageIds.delete(stateKey);
    this.compactionSummaries.delete(stateKey);
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
      return this.normalizeToolResult(payload, sessionId, timestamp, baseId, stage === 'error');
    }

    // Announce (`tool.updated` kind=scheduled) arrives AFTER the call's
    // parameter stream and `tool_call` snapshot have already been streamed,
    // and carries no `input` (only inputByteLength/inputRef). Emitting a
    // frame here would upsert-blank the already-populated card, so the
    // announce only frames when it actually carries the input (older engine
    // generations schedule non-streamed calls this way); the parameter
    // stream itself re-opens the per-call stream when needed.
    if (!readObjectRecord(payload.input)) {
      return [];
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
      toolInput: payload.input,
      toolId,
      // While an agent runs the engine mirrors its tool calls onto the parent
      // session's stream, marked `source: "subagent"` with the agent's `Agent`
      // call as `parentToolCallId`; they belong in that card's timeline.
      parentToolUseId: this.readSubagentCard(payload, sessionId),
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
      this.openReasoningBlock(stateKey, baseId);
      return [];
    }

    if (kind === 'reasoning_delta') {
      const content = extractText(payload.delta);
      if (!content) {
        return [];
      }
      return [createNormalizedMessage({
        id: this.openReasoningBlock(stateKey, baseId),
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
      // A segment boundary drops the cached identity: the next segment is a
      // different row and must not inherit this one's key.
      this.textRowMessageIds.delete(stateKey);
      const openingMessageId = kind === 'text_start' ? readOptionalString(payload.assistantMessageId) : undefined;
      if (openingMessageId) {
        this.textRowMessageIds.set(stateKey, openingMessageId);
      }
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
      const messageId = this.resolveTextRowMessageId(stateKey, payload, baseId);
      return [createNormalizedMessage({
        id: messageId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_delta',
        role: 'assistant',
        content,
        providerRowKey: buildZCodeTextRowKey(messageId),
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

    if (kind === 'tool_result' || kind === 'tool_error') {
      return this.normalizeToolResult(payload, sessionId, timestamp, baseId, kind === 'tool_error');
    }

    return [];
  }

  /** Both event families carry the output on the event, not in resultPartId. */
  private normalizeToolResult(
    payload: AnyRecord,
    sessionId: string | null,
    timestamp: string,
    baseId: string,
    reportedError: boolean,
  ): NormalizedMessage[] {
    const result = readObjectRecord(payload.result);
    const isError = reportedError || result?.success === false;
    const value = result?.content ?? (isError ? payload.error ?? result?.error : undefined);
    // A result reference alone is not output. Do not mark a malformed event
    // completed with fabricated text; a later full result/history can fill it.
    if (value === undefined) {
      console.warn('[ZCodeProvider] Tool result event has no content', {
        sessionId, toolCallId: readOptionalString(payload.toolCallId),
        resultPartId: readOptionalString(payload.resultPartId),
      });
      if (!isError) return [];
    }
    // Even an error without a body must reach the card as failed, so the
    // client's end-of-turn cleanup cannot settle it as a successful call.
    const content = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_result',
      toolId: readOptionalString(payload.toolCallId) ?? baseId,
      content,
      // The frontend pairs a standalone result by its top-level fields;
      // persisted tool cards instead read the nested result directly.
      isError,
      toolResult: { content, isError },
    })];
  }

  /**
   * The id every delta of one reasoning segment is emitted under.
   *
   * Derived from the engine's own id for the event that opened the segment,
   * so a history read of the same segment lands on the same id and the client
   * does not render the streamed block beside the persisted one. The cache
   * keeps the later deltas on the opening event's id even when the engine
   * numbers each delta separately.
   */
  private openReasoningBlock(stateKey: string, baseId: string): string {
    const existing = this.reasoningBlockIds.get(stateKey);
    if (existing) {
      return existing;
    }
    const id = `${baseId}_reasoning`;
    this.reasoningBlockIds.set(stateKey, id);
    return id;
  }

  /**
   * The message id every delta of one assistant text segment is emitted
   * under, and therefore the identity of its row.
   *
   * The engine stamps each session event with its own random UUID, so the
   * envelope id changes between two deltas of the same reply; only
   * `payload.assistantMessageId` names the reply. Because the client closes a
   * streamed segment whenever the row key changes, an envelope-derived key
   * would cut every reply into one bubble per delta. Engine generations that
   * send no `assistantMessageId` fall back to the first delta's envelope id,
   * cached until `text_end` closes the segment: the row stays whole live even
   * though it cannot reconcile with the persisted copy by identity.
   */
  private resolveTextRowMessageId(stateKey: string, payload: AnyRecord, baseId: string): string {
    const named = readOptionalString(payload.assistantMessageId);
    if (named) {
      this.textRowMessageIds.set(stateKey, named);
      return named;
    }
    const cached = this.textRowMessageIds.get(stateKey);
    if (cached) {
      return cached;
    }
    this.textRowMessageIds.set(stateKey, baseId);
    return baseId;
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
