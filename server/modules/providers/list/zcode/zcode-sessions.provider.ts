import fsSync from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
  ProviderSessionUsageInput,
  ProviderTokenUsageResult,
} from '@/shared/types.js';
import {
  AppError,
  createNormalizedMessage,
  generateMessageId,
  normalizeProjectPath,
  normalizeProviderTimestamp,
  readJsonRecord,
  readObjectRecord,
  readOptionalString,
  removePathIfExists,
  sliceTailPage,
} from '@/shared/utils.js';

import { getZCodeDatabasePath, getZCodeStorageDir } from './zcode-data-root.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';
import { ZCodeLiveEventNormalizer } from './zcode-live-event-normalizer.js';

const PROVIDER = 'zcode';

/**
 * Engine 0.16.5 renamed the session/event type strings from snake_case to
 * dotted names. Map the new names back onto the ones this facet normalizes
 * against (validated on engine 0.16.3) so both engine generations share one
 * code path. `turn.failed` kept its dotted name across both versions.
 */
const EVENT_TYPE_ALIASES: Record<string, string> = {
  'model.streaming': 'model_streaming',
  'turn.completed': 'turn_complete',
  'tool.updated': 'tool_call_scheduled',
  'permission.requested': 'permission_request',
};

/**
 * Open a read-only connection to ZCode's SQLite database.
 * Returns null if the database doesn't exist.
 */
function openZCodeDatabase(): Database.Database | null {
  const dbPath = getZCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[ZCodeProvider] Failed to open database:', message);
    return null;
  }
}

type ZCodeHistoryRow = {
  message_id: string;
  message_time_created: number | null;
  message_sequence: number | null;
  message_data: string | null;
  part_id: string | null;
  part_time_created: number | null;
  part_data: string | null;
};

/**
 * Token usage totals in ZCode's internal vocabulary.
 */
type ZCodeTokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cache: number;
};

/**
 * Reads token usage from either the streaming shape
 * (`{inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens}`)
 * or the SQLite `message.data.tokens` shape
 * (`{input, output, reasoning, cache: {read, write}}`).
 * Returns null when no positive count is present in either shape.
 */
function readTokenTotals(value: unknown): ZCodeTokenTotals | null {
  const record = readObjectRecord(value);
  if (!record) {
    return null;
  }

  const cacheRecord = readObjectRecord(record.cache);
  const totals: ZCodeTokenTotals = {
    input: Number(record.inputTokens ?? record.input ?? 0),
    output: Number(record.outputTokens ?? record.output ?? 0),
    reasoning: Number(record.reasoningTokens ?? record.reasoning ?? 0),
    cache: cacheRecord
      ? Number(cacheRecord.read ?? 0) + Number(cacheRecord.write ?? 0)
      : Number(record.cacheReadTokens ?? 0) + Number(record.cacheWriteTokens ?? 0),
  };

  const used = totals.input + totals.output + totals.reasoning + totals.cache;
  return used > 0 ? totals : null;
}

/**
 * Reads the total used-token count from either the streaming usage shape
 * (`{inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens}`)
 * or the SQLite `message.data.tokens` shape
 * (`{input, output, reasoning, cache: {read, write}}`).
 * Returns undefined when no positive count is present.
 */
function readTokenUsedCount(value: unknown): number | undefined {
  const totals = readTokenTotals(value);
  if (!totals) {
    return undefined;
  }
  return totals.input + totals.output + totals.reasoning + totals.cache;
}

/**
 * Builds the shared token usage summary from ZCode token totals.
 * Shape matches the `token_budget` summaries other providers report
 * (`used` plus input/output breakdown).
 */
function buildTokenUsage(totals: ZCodeTokenTotals | null): ProviderTokenUsageResult | undefined {
  if (!totals) {
    return undefined;
  }

  return {
    used: totals.input + totals.output + totals.reasoning + totals.cache,
    inputTokens: totals.input,
    outputTokens: totals.output,
    breakdown: {
      input: totals.input,
      output: totals.output,
    },
  };
}

/**
 * Extract and format tool call content for display.
 */
function formatToolContent(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Extract text content from a part or message structure.
 */
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

/**
 * Parses a buffered tool-argument fragment as a JSON object, or returns null
 * while the fragment is still mid-stream and therefore not valid JSON.
 */
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

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Materializes one zcode file part into the shared image assets store.
 *
 * ZCode persists user-uploaded images as `{type:"file", mime, url}` parts
 * whose `zcode-artifact://<sessionId>/<name>` URI references a data-URL file
 * under the engine's artifact store (`<storage>/cli/artifacts/<sessionId>/`,
 * where the filename ends with `<name>`). The image is decoded once and
 * copied into `~/.cloudcli/assets` under a session-scoped name so the chat UI
 * loads it through the shared assets route. Returns the asset descriptor, or
 * null for non-images, missing sources, or malformed references.
 */
function materializeZcodeArtifactImage(
  partData: AnyRecord,
  sessionId: string,
): { path: string; mimeType: string } | null {
  const mimeType = (readOptionalString(partData.mime) ?? 'image/png').toLowerCase();
  if (!mimeType.startsWith('image/')) {
    return null;
  }

  const uri = readOptionalString(partData.url)
    ?? readOptionalString(partData.artifactUri)
    ?? '';
  const artifactMatch = /^zcode-artifact:\/\/([^/\s]+)\/([^\s]+)$/.exec(uri);
  if (!artifactMatch) {
    return null;
  }
  const [, artifactSessionId, artifactName] = artifactMatch;
  // Both segments become path parts below; refuse traversal outright.
  if (artifactSessionId.includes('..') || artifactName.includes('..') || artifactName.includes('/')) {
    return null;
  }

  const artifactsDir = path.join(getZCodeStorageDir(), 'cli', 'artifacts', artifactSessionId);
  let artifactFile: string | null = null;
  try {
    // Artifact filenames carry engine-internal prefixes and a .txt extension
    // (e.g. `prompt-attachment-upload-…-<name>.txt`), so match on containment
    // — the uuid in the name is unique enough.
    for (const entry of fsSync.readdirSync(artifactsDir)) {
      if (entry.includes(artifactName)) {
        artifactFile = path.join(artifactsDir, entry);
        break;
      }
    }
  } catch {
    return null;
  }
  if (!artifactFile) {
    return null;
  }

  let content: string;
  try {
    content = fsSync.readFileSync(artifactFile, 'utf8').trim();
  } catch {
    return null;
  }
  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/s.exec(content);
  const resolvedMime = dataUrlMatch?.[1] ?? mimeType;
  const base64Payload = dataUrlMatch?.[2];
  if (!base64Payload) {
    return null;
  }

  const assetsDir = getGlobalImageAssetsDir();
  const extension = IMAGE_MIME_EXTENSIONS[resolvedMime] ?? '.png';
  const assetFilename = `zcode-${sessionId.slice(0, 8)}-${artifactName}${extension}`;
  const assetPath = path.join(assetsDir, assetFilename);
  try {
    if (!fsSync.existsSync(assetPath)) {
      fsSync.mkdirSync(assetsDir, { recursive: true });
      fsSync.writeFileSync(assetPath, Buffer.from(base64Payload, 'base64'));
    }
  } catch {
    return null;
  }

  return { path: assetFilename, mimeType: resolvedMime };
}

/**
 * Whether the engine marked this persisted user message as invisible to the
 * UI. ZCode writes model-only injections (todo reminders, system reminders,
 * subagent notifications) as user rows but declares their visibility
 * semantics structurally; the flags are redundant across fields, so any hit
 * is enough. Without this check every todo reminder renders as a user bubble.
 */
function isEngineHiddenUserMessage(messageInfo: Record<string, unknown> | null): boolean {
  if (!messageInfo) {
    return false;
  }
  const semantics = readObjectRecord(messageInfo.semantics);
  const metadata = readObjectRecord(messageInfo.metadata);
  return readOptionalString(semantics?.uiVisibility) === 'hidden'
    || readOptionalString(semantics?.transcriptVisibility) === 'hidden'
    || readOptionalString(metadata?.visibility) === 'model-only';
}

/**
 * Aggregate token usage from all messages in a session.
 */
function aggregateZCodeSessionTokenUsage(
  db: Database.Database,
  sessionId: string,
): ProviderTokenUsageResult | undefined {
  const rows = db.prepare('SELECT data FROM message WHERE session_id = ?').all(sessionId) as { data: string }[];

  const totals: ZCodeTokenTotals = { input: 0, output: 0, reasoning: 0, cache: 0 };
  let hasAnyUsage = false;

  for (const row of rows) {
    const info = readJsonRecord(row.data);
    const messageTotals = readTokenTotals(info?.tokens);
    if (!messageTotals) {
      continue;
    }

    hasAnyUsage = true;
    totals.input += messageTotals.input;
    totals.output += messageTotals.output;
    totals.reasoning += messageTotals.reasoning;
    totals.cache += messageTotals.cache;
  }

  return hasAnyUsage ? buildTokenUsage(totals) : undefined;
}

/**
 * Session history provider for ZCode's SQLite-backed session store.
 *
 * Implements the IProviderSessions interface to normalize ZCode-specific
 * events and message history into the shared transport shapes consumed by
 * API routes and realtime streams.
 */
export class ZCodeSessionsProvider implements IProviderSessions {
  private readonly liveEventNormalizer = new ZCodeLiveEventNormalizer();
  // Legacy helpers remain temporarily below while history normalization keeps
  // sharing their text and token readers; live events delegate above.
  private reasoningBlockIds = new Map<string, string>();
  private toolInputStreams = new Map<string, { toolCallId: string; toolName: string; buffer: string }>();

  /**
   * Normalizes live protocol events into frontend messages.
   *
   * Consumes the event shapes documented in Phase 0.3: typed envelopes such
   * as `{type: "model_streaming", payload: {kind, delta}}`,
   * `{type: "tool_call_scheduled", payload: {toolCallId, toolName, input}}`,
   * and `{type: "turn_complete", payload: {usage}}`. The `session/event`
   * notification wrapper (`{event}` or `{data}` around the typed payload) is
   * unwrapped first. Boundary marker kinds (`*_start`/`*_end` with empty
   * deltas) and unknown types produce no messages.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    return this.liveEventNormalizer.normalize(rawMessage, sessionId);
  }

  resetLiveMessageState(sessionId: string): void {
    this.liveEventNormalizer.resetSession(sessionId);
  }

  /**
   * Normalizes `model_streaming` payload kinds per the Phase 0.3 mapping
   * table: text deltas stream, reasoning deltas think, tool announcements
   * map to tool_use/tool_result. Reasoning boundary markers open and close
   * the per-session reasoning block instead of emitting messages; other
   * streaming kinds close it so each thinking segment keeps its own id.
   */
  private normalizeStreamingKind(
    payload: AnyRecord,
    eventSessionId: string | null,
    timestamp: string,
    baseId: string,
  ): NormalizedMessage[] {
    const kind = readOptionalString(payload.kind);
    const reasoningStateKey = eventSessionId ?? '';

    if (kind === 'reasoning_start') {
      this.openReasoningBlock(reasoningStateKey);
      return [];
    }

    if (kind === 'reasoning_delta') {
      const content = extractText(payload.delta);
      if (!content) {
        return [];
      }

      return [createNormalizedMessage({
        id: this.openReasoningBlock(reasoningStateKey),
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'thinking',
        content,
      })];
    }

    if (kind === 'reasoning_end') {
      this.reasoningBlockIds.delete(reasoningStateKey);
      return [];
    }

    if (kind === 'tool_input_start' || kind === 'tool_input_delta' || kind === 'tool_input_end') {
      return this.normalizeToolInputEvent(payload, eventSessionId, timestamp, kind);
    }

    // Any other streaming kind ends the reasoning window, so a later thinking
    // segment within the same model response opens a fresh block with its own
    // id — mirroring the one reasoning part the engine persists per segment.
    if (kind) {
      this.reasoningBlockIds.delete(reasoningStateKey);
    }

    // Text segment boundaries: the engine never emits a plain stream_end for
    // them, so without this the client keeps the whole turn's text in one
    // streaming row whose timestamp drifts to finalization time — pushing the
    // finalized text below the tool calls that ran before it. Forwarding the
    // boundaries as stream_end lets the client close each segment in place.
    if (kind === 'text_start' || kind === 'text_end') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
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
        sessionId: eventSessionId,
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
      // Remember the announced call so streaming argument fragments know
      // which card they belong to.
      this.toolInputStreams.set(eventSessionId ?? '', { toolCallId, toolName, buffer: '' });
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName,
        toolInput: payload.input ?? {},
        toolId: toolCallId,
      })];
    }

    if (kind === 'tool_result') {
      // Streaming tool results only reference the persisted part id; the
      // full output arrives later through the SQLite sync path.
      const resultPartId = readOptionalString(payload.resultPartId);
      const resultContent = resultPartId ? `Result stored in part ${resultPartId}` : '';
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: readOptionalString(payload.toolCallId) ?? baseId,
        content: resultContent,
        toolResult: {
          content: resultContent,
          isError: false,
        },
      })];
    }

    return [];
  }

  /**
   * Returns the id of the session's open reasoning block, opening one with a
   * fresh stable id when none exists. Every `reasoning_delta` of the same
   * thinking segment therefore carries the same message id, which the client
   * uses to merge the frames into a single transcript entry.
   */
  private openReasoningBlock(stateKey: string): string {
    const existing = this.reasoningBlockIds.get(stateKey);
    if (existing) {
      return existing;
    }
    const id = generateMessageId('zcode_reasoning');
    this.reasoningBlockIds.set(stateKey, id);
    return id;
  }

  /**
   * Merges streaming tool arguments into the session's active tool call.
   * Each fragment extends the buffered JSON; once it parses, a tool_use frame
   * carrying the announced call's toolId is emitted so the client updates the
   * existing card in place instead of appending a new one. `tool_input_end`
   * closes the stream — a buffer that never parses produces nothing usable.
   * When the engine attaches its own accumulated `input` object it wins over
   * the locally parsed buffer.
   */
  private normalizeToolInputEvent(
    payload: AnyRecord,
    eventSessionId: string | null,
    timestamp: string,
    kind: string,
  ): NormalizedMessage[] {
    const stateKey = eventSessionId ?? '';
    const stream = this.toolInputStreams.get(stateKey);
    if (!stream) {
      return [];
    }

    const rawDelta = payload.delta;
    // Raw string on purpose: a delta is a JSON fragment, so whitespace is
    // meaningful and the usual readOptionalString trim would corrupt values.
    const deltaText = typeof rawDelta === 'string' ? rawDelta : undefined;
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
      sessionId: eventSessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_use',
      toolName: stream.toolName,
      toolInput: parsedInput,
      toolId: stream.toolCallId,
    })];
  }

  /**
   * Loads ZCode session history from SQLite database.
   *
   * Uses read-only connection to query message and part tables with proper
   * pagination (LIMIT/OFFSET). Joins with part table for full message content.
   * Uses the existing sequence column and message_session_time_created_id_idx index.
   *
   * Filter out sub-agent sessions (sess_subagent_agent_*) per plan requirements.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    // Filter out sub-agent sessions
    if (sessionId.startsWith('sess_subagent_agent_')) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    // ZCode's SQLite database keys messages by the provider-native session id
    const providerSessionId = options.providerSessionId ?? sessionId;
    const db = openZCodeDatabase();

    if (!db) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const rows = db.prepare(`
        SELECT
          m.id AS message_id,
          m.time_created AS message_time_created,
          m.sequence AS message_sequence,
          m.data AS message_data,
          p.id AS part_id,
          p.time_created AS part_time_created,
          p.data AS part_data
        FROM message m
        LEFT JOIN part p
          ON p.session_id = m.session_id
         AND p.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY
          COALESCE(m.time_created, 0),
          m.sequence,
          m.id,
          COALESCE(p.time_created, 0),
          p.id
      `).all(providerSessionId) as ZCodeHistoryRow[];

      const normalized = this.normalizeHistoryRows(rows, sessionId);
      const tokenUsage = aggregateZCodeSessionTokenUsage(db, providerSessionId);

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ZCodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    } finally {
      db.close();
    }
  }

  /**
   * Normalize SQLite history rows into NormalizedMessage format.
   *
   * Parses message.data JSON for role/modelID/tokens and handles the part
   * table's type discriminator (`text`/`reasoning`/`tool`/`step-finish`)
   * per the Phase 0.3 SQLite schema. Applies suffix to fragment IDs for
   * uniqueness per §5.1 of the plan.
   */
  private normalizeHistoryRows(rows: ZCodeHistoryRow[], sessionId: string): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    const emittedMessageErrors = new Set<string>();
    const emittedUserTexts = new Set<string>();
    const emittedSummaryMessages = new Set<string>();
    // Index of each pushed text row by source message id, so a file part can
    // attach its materialized image onto the message's existing text row.
    const textRowIndexByMessageId = new Map<string, number>();

    for (const row of rows) {
      const timestamp = normalizeProviderTimestamp(row.part_time_created ?? row.message_time_created);
      // Apply suffix to fragment IDs for uniqueness per §5.1
      const baseId = `${row.message_id}_${row.part_id ?? normalized.length}`;
      const messageInfo = readJsonRecord(row.message_data);
      const messageRole = readOptionalString(messageInfo?.role);

      // Model-only injections are skipped entirely, including their parts.
      if (messageRole === 'user' && isEngineHiddenUserMessage(messageInfo)) {
        continue;
      }

      // Handle message-level errors
      if (
        messageInfo
        && messageRole === 'assistant'
        && messageInfo.error != null
        && !emittedMessageErrors.has(row.message_id)
      ) {
        emittedMessageErrors.add(row.message_id);
        normalized.push(createNormalizedMessage({
          id: `${baseId}_error`,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'error',
          content: formatToolContent(messageInfo.error),
        }));
      }

      // Skip rows without part data
      if (!row.part_id || !row.part_data) {
        // User prompts can persist their text on the message row itself
        // (Phase 0.3 §4.1) instead of in a part; emit it once per message.
        if (messageRole === 'user' && !emittedUserTexts.has(row.message_id)) {
          const content = extractText(messageInfo?.text ?? messageInfo?.input ?? messageInfo?.content);
          if (content.trim()) {
            emittedUserTexts.add(row.message_id);
            normalized.push(createNormalizedMessage({
              id: `${row.message_id}_text`,
              sessionId,
              timestamp,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content,
            }));
          }
        }
        continue;
      }

      const partData = readJsonRecord(row.part_data);
      if (!partData) {
        continue;
      }

      const partType = readOptionalString(partData.type);

      // Handle text parts
      if (partType === 'text') {
        const content = extractText(partData);

        // A compaction summary persists as a user message carrying a
        // structured `summary` field. Surfacing it as assistant-authored
        // summary text (the shape claude uses) keeps it out of a user bubble.
        if (readObjectRecord(messageInfo?.summary)) {
          if (content.trim() && !emittedSummaryMessages.has(row.message_id)) {
            emittedSummaryMessages.add(row.message_id);
            normalized.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content,
              isCompactSummary: true,
            }));
          }
          continue;
        }

        if (content.trim()) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: messageRole === 'user' ? 'user' : 'assistant',
            content,
          }));
          textRowIndexByMessageId.set(row.message_id, normalized.length - 1);
        }
        continue;
      }

      // Handle file parts — user-uploaded images. ZCode stores the binary in
      // its artifact store and references it via a zcode-artifact:// URI;
      // materialize it into the shared asset store and attach it to the
      // message's text row (or as a standalone image-only user message).
      if (partType === 'file' || partType === 'image') {
        const image = materializeZcodeArtifactImage(partData, sessionId);
        if (image) {
          const existingIndex = textRowIndexByMessageId.get(row.message_id);
          if (existingIndex !== undefined) {
            const target = normalized[existingIndex];
            const existingImages = Array.isArray(target.images) ? target.images : [];
            target.images = [...existingImages, image];
          } else if (messageRole === 'user') {
            normalized.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: '',
              images: [image],
            }));
          }
        }
        continue;
      }

      // Handle thinking/reasoning parts
      if (partType === 'reasoning' || partType === 'thinking') {
        const content = extractText(partData);
        if (content.trim()) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'thinking',
            content,
          }));
        }
        continue;
      }

      // Handle tool parts (callID/tool/state per Phase 0.3 part schema)
      if (partType === 'tool' || partType === 'function_call') {
        const toolName = readOptionalString(partData.tool) ?? readOptionalString(partData.name) ?? 'Tool';
        const state = readObjectRecord(partData.state);

        const toolMessage = createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName,
          toolInput: state?.input ?? partData.input ?? {},
          toolId: readOptionalString(partData.callID) ?? row.part_id,
        });

        if (state) {
          const status = readOptionalString(state.status);
          if (status === 'completed' || status === 'error') {
            toolMessage.toolResult = {
              content: formatToolContent(state.output ?? state.error),
              isError: status === 'error',
            };
          }
        }

        normalized.push(toolMessage);
        continue;
      }

      // Handle step completion (run end marker)
      if (partType === 'step-finish' || partType === 'done') {
        normalized.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp,
          provider: PROVIDER,
          kind: 'complete',
          tokens: readTokenUsedCount(messageInfo?.tokens),
        }));
        continue;
      }
    }

    return normalized;
  }

  /**
   * Reads the aggregated token usage for one ZCode session.
   *
   * Consumer: the provider token-usage service. Sums `message.data.tokens`
   * rows for the provider-native session id (the same aggregation fetchHistory
   * uses). A missing database or a session unknown to ZCode is a 404; a known
   * session without recorded usage reports zeros.
   */
  async getTokenUsage(input: ProviderSessionUsageInput): Promise<ProviderTokenUsageResult> {
    const db = openZCodeDatabase();
    if (!db) {
      throw new AppError('ZCode session database was not found.', {
        code: 'ZCODE_DATABASE_NOT_FOUND',
        statusCode: 404,
      });
    }

    try {
      const usage = aggregateZCodeSessionTokenUsage(db, input.nativeSessionId);
      if (usage) {
        return usage;
      }

      const messageCount = db
        .prepare('SELECT COUNT(*) AS count FROM message WHERE session_id = ?')
        .get(input.nativeSessionId) as { count: number };
      if (!messageCount.count) {
        throw new AppError(`ZCode session for "${input.appSessionId}" was not found.`, {
          code: 'ZCODE_SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      return {
        used: 0,
        inputTokens: 0,
        outputTokens: 0,
        breakdown: { input: 0, output: 0 },
      };
    } finally {
      db.close();
    }
  }

  /**
   * Cleans up ZCode native storage (SQLite session row and jsonl file if any).
   */
  async cleanupSession(nativeSessionId: string, jsonlPath?: string | null): Promise<boolean> {
    let removed = false;
    if (jsonlPath) {
      if (await removePathIfExists(jsonlPath)) {
        removed = true;
      }
    }
    const zcodeDbPath = getZCodeDatabasePath();
    if (fsSync.existsSync(zcodeDbPath)) {
      let db: Database.Database | null = null;
      try {
        db = new Database(zcodeDbPath);
        const res = db.prepare('DELETE FROM session WHERE id = ?').run(nativeSessionId);
        if (res.changes > 0) {
          removed = true;
        }
      } catch (err) {
        console.warn('[ZCodeSessions] Failed to delete ZCode session row:', err);
      } finally {
        if (db) {
          db.close();
        }
      }
    }
    return removed;
  }

  /**
   * Cleans up ZCode project storage from SQLite database.
   */
  async cleanupProjectStorage(projectPath: string): Promise<void> {
    const normalizedPath = normalizeProjectPath(projectPath);
    if (!normalizedPath || normalizedPath === path.parse(normalizedPath).root) {
      return;
    }
    const zcodeDbPath = getZCodeDatabasePath();
    if (fsSync.existsSync(zcodeDbPath)) {
      let db: Database.Database | null = null;
      try {
        db = new Database(zcodeDbPath);
        db.prepare('DELETE FROM session WHERE directory = ?').run(normalizedPath);
      } catch (err) {
        console.warn('[ZCodeSessions] Failed to clean up ZCode project sessions:', err);
      } finally {
        if (db) {
          db.close();
        }
      }
    }
  }
}
