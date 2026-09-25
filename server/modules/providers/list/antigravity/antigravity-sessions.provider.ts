/**
 * Antigravity Sessions Provider
 *
 * Implements IProviderSessions for the Antigravity CLI (agy).
 * Handles message normalization from live stream-json events and loads history
 * from transcript JSONL log files.
 *
 * @module antigravity-sessions.provider
 */

import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
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
  parseAntigravityWorkspacePath,
  readObjectRecord,
  readOptionalString,
  readUsageNumber,
  removePathIfExists,
  sanitizeLeafDirectoryName,
  sliceTailPage,
} from '@/shared/utils.js';

import {
  getAntigravityBrainRoots,
  getAntigravityDataRoot,
  getAntigravitySummariesDbPath,
  getAntigravityTranscriptCandidates,
} from './antigravity-data-root.js';
import { readCanonicalAntigravityTranscript } from './antigravity-transcript.provider.js';

const PROVIDER = 'antigravity';

/**
 * Builds the identity shared by Antigravity's live assistant delta and its
 * eventual PLANNER_RESPONSE transcript row. Missing native step indexes stay
 * unidentified so clients can fall back to their legacy reconciliation rules.
 */
/**
 * The id both transports must give one tool call.
 *
 * Live reports a tool at its own step index; the transcript declares it on the
 * planner entry one step earlier, with its position in that entry's
 * `tool_calls`. `declaringStepIndex` is that planner step and is offset here,
 * while the live side passes the execution step it already has. An index the
 * engine did not supply falls back to a per-process value, which cannot pair —
 * that is the honest outcome, better than two rows sharing a made-up id.
 */
function buildAntigravityToolId(stepIndex: number | undefined, positionInEntry: number | null): string {
  if (stepIndex === undefined) {
    return `tool_unindexed_${Date.now()}`;
  }
  return positionInEntry === null
    ? `tool_${stepIndex}`
    : `tool_${stepIndex + 1 + positionInEntry}`;
}

/**
 * The row id both transports must produce for one tool call.
 *
 * Antigravity reports a call twice — live at its own step, and in history on
 * the planner entry one step earlier — so the step number alone names two
 * different rows. `buildAntigravityToolId` already reconciles that into one
 * call identity; deriving the row id from it is what lets the client see the
 * live card and the persisted card as the same row instead of rendering both.
 */
function buildAntigravityToolRowId(sessionId: string | null, toolId: string): string {
  return `msg_${sessionId ?? ''}_${toolId}`;
}

function buildAntigravityAssistantRowKey(stepIndex: number | undefined): string | undefined {
  return stepIndex === undefined ? undefined : `assistant-step:${stepIndex}`;
}

/**
 * Finds the transcript.jsonl file for a session across possible brain directories.
 */
function findTranscriptPath(sessionId: string): string | null {
  const safeId = sanitizeLeafDirectoryName(sessionId, 'antigravity session id');

  for (const candidate of getAntigravityTranscriptCandidates(safeId)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Reads a usage snapshot from one Antigravity transcript.jsonl.
 *
 * Transcripts carry the usage either on a `result` event or on bare
 * total/input/output lines. When no explicit usage was recorded the transcript
 * is re-scanned and characters are estimated at ~3 chars/token so long
 * conversations still show a ballpark figure instead of zeros.
 */
function readAntigravityTokenUsage(fileContent: string): ProviderTokenUsageResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  const lines = fileContent.trim().split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;
      const usage = entry.usage
        ?? entry.result?.usage
        ?? (entry.event === 'result' ? entry.result?.usage : null)
        ?? (entry.payload?.usage)
        ?? null;

      if (usage) {
        inputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens);
        outputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens);
        totalTokens = readUsageNumber(usage.total_tokens ?? usage.totalTokens)
          || (inputTokens + outputTokens);
        break;
      }

      if (typeof entry.total_tokens === 'number' || typeof entry.tokens === 'number') {
        totalTokens = readUsageNumber(entry.total_tokens ?? entry.tokens);
        inputTokens = readUsageNumber(entry.input_tokens ?? entry.prompt_tokens);
        outputTokens = readUsageNumber(entry.output_tokens ?? entry.completion_tokens);
        break;
      }
    } catch {
      // Skip unparseable lines.
    }
  }

  if (totalTokens === 0 && inputTokens === 0 && outputTokens === 0) {
    let estimatedInputChars = 0;
    let estimatedOutputChars = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as AnyRecord;
        const contentLength = typeof entry.content === 'string' ? entry.content.length : 0;
        const thinkingLength = typeof entry.thinking === 'string' ? entry.thinking.length : 0;
        if (entry.source === 'MODEL' || entry.type === 'PLANNER_RESPONSE') {
          estimatedOutputChars += contentLength + thinkingLength;
        } else {
          estimatedInputChars += contentLength;
        }
      } catch {
        // Skip unparseable lines
      }
    }
    if (estimatedInputChars > 0 || estimatedOutputChars > 0) {
      inputTokens = Math.ceil(estimatedInputChars / 3);
      outputTokens = Math.ceil(estimatedOutputChars / 3);
      totalTokens = inputTokens + outputTokens;
    }
  }

  return {
    used: totalTokens || (inputTokens + outputTokens),
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

function cleanToolArgValue(val: unknown): unknown {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return val;
}

/**
 * Extracts a human-readable message from a tool step's `error` field. agy
 * sends either a plain string or a structured object such as
 * `{ type: 'TOOL_ERROR', message: 'search path ... does not exist' }`; only
 * the object's `message` carries the actionable text, so reading the field as
 * a plain string loses it and the transcript degenerates to a generic
 * 'Tool execution error' fallback.
 */
function readToolErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return readOptionalString(value);
  }
  if (value && typeof value === 'object') {
    return readOptionalString((value as { message?: unknown }).message);
  }
  return undefined;
}

/**
 * Strips outer quoted strings that Antigravity CLI occasionally emits in transcript tool arguments.
 */
export function normalizeAntigravityToolArgs(args: unknown): AnyRecord {
  const record = readObjectRecord(args);
  if (!record) return {};
  const cleaned: AnyRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      cleaned[key] = cleanToolArgValue(value);
    } else if (Array.isArray(value)) {
      cleaned[key] = value.map(cleanToolArgValue);
    } else if (value && typeof value === 'object') {
      cleaned[key] = normalizeAntigravityToolArgs(value);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * Cleans Antigravity engine internal wrapper blocks and system notifications.
 */
export function cleanAntigravityMessageContent(
  text: string,
  mode: 'user' | 'assistant' | 'tool_result',
): string {
  if (!text || typeof text !== 'string') return '';

  const hasDisclaimer = /The following is a <SYSTEM_MESSAGE>/i.test(text);
  const hasSystemTag = /<SYSTEM_MESSAGE>/i.test(text);

  if (!hasDisclaimer && !hasSystemTag) {
    return text.trim();
  }

  // 1. User messages: pure system notifications or wakeups must be completely stripped.
  if (mode === 'user') {
    let cleaned = text
      .replace(/The following is a <SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
      .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '');

    // Handle unclosed system message blocks or trailing disclaimers
    cleaned = cleaned.replace(/The following is a <SYSTEM_MESSAGE>[\s\S]*$/i, '');
    cleaned = cleaned.replace(/<SYSTEM_MESSAGE>[\s\S]*$/i, '');
    return cleaned.trim();
  }

  // 2. Assistant messages: drop task-finish notifications and server notices entirely.
  if (mode === 'assistant') {
    if (
      /content=Task id "[^"]+" finished with result:/i.test(text) ||
      /content=Task finished with result:/i.test(text) ||
      /content=\[Notice\]/i.test(text)
    ) {
      return '';
    }
  }

  // 3. Unwrap inner payload for tool results or valid assistant responses (e.g. subagents)
  let cleaned = text
    .replace(/The following is a <SYSTEM_MESSAGE>[\s\S]*?<SYSTEM_MESSAGE>/gi, '')
    .replace(/<\/SYSTEM_MESSAGE>/gi, '')
    .replace(/<SYSTEM_MESSAGE>/gi, '')
    .trim();

  cleaned = cleaned.replace(/^\[Message\][^\n]*?content=(?:Task id "[^"]+" finished with result:\s*)?/i, '');

  if (/^\[Notice\]/i.test(cleaned)) {
    return '';
  }

  return cleaned.trim();
}

/**
 * Recognizes the header Antigravity's tool runner prepends to every tool
 * result (`Created At:` / `Completed At:`, optionally followed by a file or
 * command banner). Results that never find their call must not reach the UI as
 * assistant prose, so this guards the last-resort text fallback.
 */
function looksLikeToolResultPayload(text: string): boolean {
  return /^Created At:\s*\S+[\s\S]*?^Completed At:\s*\S+/m.test(text);
}

/**
 * Strips Antigravity engine internal wrapper blocks completely (used for user messages).
 */
export function stripSystemMessageBlocks(text: string): string {
  return cleanAntigravityMessageContent(text, 'user');
}

/**
 * Unwraps Antigravity engine internal wrapper blocks while preserving inner payload (used for tool results).
 */
export function unwrapSystemMessageContent(text: string): string {
  return cleanAntigravityMessageContent(text, 'tool_result');
}

/**
 * Normalizes one step or event from Antigravity CLI stream-json or transcript logs.
 */
//----------------- ANTIGRAVITY DURABLE SUMMARY STORE ------------

/** One top-level protobuf field, kept as its raw bytes plus its tag. */
type AntigravityProtobufField = {
  fieldNumber: number;
  wireType: number;
  bytes: Buffer;
};

/** Reads one protobuf varint and returns the value plus the next offset. */
function readProtobufVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    value |= (byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) {
      return { value, next: cursor };
    }
    shift += 7;
    if (shift > 28) {
      throw new Error('protobuf varint is too long');
    }
  }

  throw new Error('truncated protobuf varint');
}

/**
 * Splits a protobuf buffer into its top-level fields.
 *
 * Antigravity's `jetbox_summaries_proto.pb` is a flat sequence of
 * length-delimited records, so callers can drop whole conversations and
 * re-concatenate the rest without knowing the message schema.
 */
function splitTopLevelProtobufFields(buffer: Buffer): AntigravityProtobufField[] {
  const fields: AntigravityProtobufField[] = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const start = cursor;
    const key = readProtobufVarint(buffer, cursor);
    const fieldNumber = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    let end: number;

    if (wireType === 0) {
      end = readProtobufVarint(buffer, key.next).next;
    } else if (wireType === 2) {
      const length = readProtobufVarint(buffer, key.next);
      end = length.next + length.value;
    } else if (wireType === 5) {
      end = key.next + 4;
    } else if (wireType === 1) {
      end = key.next + 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }

    if (fieldNumber <= 0 || end > buffer.length) {
      throw new Error('malformed protobuf field');
    }

    fields.push({ fieldNumber, wireType, bytes: buffer.subarray(start, end) });
    cursor = end;
  }

  return fields;
}

/**
 * Removes the given conversations from Antigravity's durable summary store
 * (`jetbox_summaries_proto.pb`).
 *
 * `conversation_summaries.db` is only a cache: on every `agy` startup the
 * engine rebuilds it from this protobuf, so deleting a row from the database
 * alone lets a hard-deleted session reappear on the next run. Each top-level
 * `field 1` record is one conversation; a schema-agnostic walk drops the
 * records that carry the ids and rewrites the rest. Any parse failure leaves
 * the file untouched.
 *
 * Exported for tests only.
 */
export function pruneAntigravitySummaryRecords(filePath: string, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0 || !fs.existsSync(filePath)) {
    return false;
  }

  let fields: AntigravityProtobufField[];
  try {
    fields = splitTopLevelProtobufFields(fs.readFileSync(filePath));
  } catch {
    return false;
  }

  const kept = fields.filter((field) => {
    if (field.fieldNumber !== 1 || field.wireType !== 2) {
      return true;
    }
    const text = field.bytes.toString('latin1');
    for (const id of ids) {
      if (text.includes(id)) {
        return false;
      }
    }
    return true;
  });

  if (kept.length === fields.length) {
    return false;
  }

  const temporaryPath = `${filePath}.cloudcli-tmp`;
  fs.writeFileSync(temporaryPath, Buffer.concat(kept.map((field) => field.bytes)));
  fs.renameSync(temporaryPath, filePath);
  return true;
}

/**
 * Drops `cache/last_conversations.json` pointers that name a deleted
 * conversation, so the engine stops treating it as a workspace's last session.
 *
 * Exported for tests only.
 */
export function pruneAntigravityConversationPointers(filePath: string, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0 || !fs.existsSync(filePath)) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }

  const record = readObjectRecord(parsed);
  if (!record) {
    return false;
  }

  let changed = false;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value === 'string' && ids.has(value)) {
      delete record[key];
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }

  const temporaryPath = `${filePath}.cloudcli-tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
  return true;
}

/**
 * Removes the given conversations from every durable Antigravity store the
 * engine rebuilds `conversation_summaries.db` from. Consumers: `cleanupSession`
 * and `cleanupProjectStorage`.
 */
function pruneAntigravityDurableStores(ids: ReadonlySet<string>): boolean {
  const dataRoot = getAntigravityDataRoot();
  const prunedPb = pruneAntigravitySummaryRecords(
    path.join(dataRoot, 'jetbox_summaries_proto.pb'),
    ids,
  );
  const prunedPointers = pruneAntigravityConversationPointers(
    path.join(dataRoot, 'cache', 'last_conversations.json'),
    ids,
  );
  return prunedPb || prunedPointers;
}

export class AntigravitySessionsProvider implements IProviderSessions {
  /**
   * Normalizes live stream-json events or objects into NormalizedMessage array.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      if (typeof rawMessage === 'string' && rawMessage.trim()) {
        return [createNormalizedMessage({
          kind: 'stream_delta',
          content: rawMessage,
          sessionId,
          provider: PROVIDER,
        })];
      }
      return [];
    }

    const messages: NormalizedMessage[] = [];

    // 1. Live stream-json event: init
    if (raw.event === 'init' && raw.init) {
      const initData = readObjectRecord(raw.init);
      const conversationId = readOptionalString(raw.conversation_id) ?? sessionId;
      messages.push(createNormalizedMessage({
        kind: 'session_created',
        sessionId: conversationId,
        newSessionId: conversationId ?? undefined,
        provider: PROVIDER,
        content: `Session initialized: ${conversationId}`,
      }));
      return messages;
    }

    // 2. Live stream-json event: step_update
    if (raw.event === 'step_update' && raw.step_update) {
      const step = readObjectRecord(raw.step_update);
      if (!step) return [];

      const stepType = readOptionalString(step.step_type);
      const state = readOptionalString(step.state);
      const textDelta = readOptionalString(step.text_delta);
      const stepIndex = typeof step.step_index === 'number' ? step.step_index : undefined;

      // Agent streaming text delta
      if (stepType === 'agent_response' && textDelta) {
        messages.push(createNormalizedMessage({
          id: generateMessageId(PROVIDER),
          kind: 'stream_delta',
          content: textDelta,
          sessionId,
          provider: PROVIDER,
          sequence: stepIndex,
          providerRowKey: buildAntigravityAssistantRowKey(stepIndex),
        }));
      }

      // Tool use initiation
      if (stepType === 'tool' && state === 'ACTIVE') {
        const toolName = readOptionalString(step.tool_name) || 'tool';
        const toolInfo = readObjectRecord(step.tool_info);
        const parameters = normalizeAntigravityToolArgs(toolInfo?.parameters ?? {});
        const toolId = buildAntigravityToolId(stepIndex, null);

        messages.push(createNormalizedMessage({
          id: buildAntigravityToolRowId(sessionId, toolId),
          kind: 'tool_use',
          toolName,
          toolInput: parameters,
          toolId,
          sessionId,
          provider: PROVIDER,
          sequence: stepIndex,
        }));
      }

      // Tool result completion or error
      if (stepType === 'tool' && (state === 'DONE' || state === 'ERROR')) {
        const toolInfo = readObjectRecord(step.tool_info);
        const toolId = buildAntigravityToolId(stepIndex, null);
        const output = readOptionalString(toolInfo?.output) ?? '';
        const isError = state === 'ERROR';

        messages.push(createNormalizedMessage({
          id: `${buildAntigravityToolRowId(sessionId, toolId)}_result`,
          kind: 'tool_result',
          toolId,
          content: isError ? (readToolErrorMessage(toolInfo?.error) ?? 'Tool execution error') : unwrapSystemMessageContent(output),
          isError,
          sessionId,
          provider: PROVIDER,
          sequence: stepIndex,
        }));
      }

      return messages;
    }

    // 3. Live stream-json event: result
    if (raw.event === 'result' && raw.result) {
      const resultData = readObjectRecord(raw.result);
      const usageData = readObjectRecord(resultData?.usage);
      const totalTokens = typeof usageData?.total_tokens === 'number' ? usageData.total_tokens : undefined;

      const completeMsg = createNormalizedMessage({
        id: generateMessageId(PROVIDER),
        kind: 'complete',
        sessionId,
        provider: PROVIDER,
        tokens: totalTokens,
      });

      messages.push(completeMsg);
      return messages;
    }

    return messages;
  }

  /**
   * Fetches and paginates history from transcript.jsonl log files.
   *
   * Transcripts live under brain/<provider-native conversation id>, while
   * this method is addressed with the stable app session id; the
   * provider-native id arrives via options and must win over the positional
   * fallback (app-created sessions have distinct ids).
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;
    const transcriptPath = findTranscriptPath(providerSessionId);

    if (!transcriptPath) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const canonicalRows = await readCanonicalAntigravityTranscript(providerSessionId);
      const normalizedMessages: NormalizedMessage[] = [];

      for (let i = 0; i < canonicalRows.length; i++) {
        try {
          const { entry, contentCompleteness } = canonicalRows[i];
          const type = readOptionalString(entry.type);
          const source = readOptionalString(entry.source);
          const rawContent = readOptionalString(entry.content) ?? '';
          const createdAt = readOptionalString(entry.created_at) ?? new Date().toISOString();
          const nativeStepIndex = typeof entry.step_index === 'number' ? entry.step_index : undefined;
          const stepIndex = nativeStepIndex ?? i;
          const baseId = `msg_${sessionId}_${stepIndex}`;

          // User prompt
          if (type === 'USER_INPUT' || source === 'USER_EXPLICIT') {
            // Clean prompt wrapper tags like <USER_REQUEST>...</USER_REQUEST> and internal <SYSTEM_MESSAGE> blocks
            let cleanText = rawContent
              .replace(/<USER_REQUEST>\s*/g, '')
              .replace(/<\/USER_REQUEST>\s*/g, '')
              .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
              .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '');

            cleanText = stripSystemMessageBlocks(cleanText).trim();

            const parsedImages = parseImagesInputTag(cleanText);
            const parsedFiles = parseFilesInputTag(parsedImages.text);

            if (parsedFiles.text.trim() || parsedImages.attachments.length > 0) {
              normalizedMessages.push(createNormalizedMessage({
                id: baseId,
                sessionId,
                timestamp: createdAt,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: parsedFiles.text,
                images: parsedImages.attachments.length > 0 ? parsedImages.attachments : undefined,
                files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
                sequence: stepIndex,
              }));
            }
            continue;
          }

          // Planner entries carry tool invocations, reasoning, and/or the assistant's
          // reply text. Real transcripts emit replies as PLANNER_RESPONSE.
          if (type === 'PLANNER_RESPONSE') {
            // Historical thinking lacks a matching live identity, so exposing
            // it makes refresh introduce rows that were absent while streaming.

            if (rawContent) {
              const cleanedContent = cleanAntigravityMessageContent(rawContent, 'assistant');
              if (cleanedContent) {
                normalizedMessages.push(createNormalizedMessage({
                  id: baseId,
                  sessionId,
                  timestamp: createdAt,
                  provider: PROVIDER,
                  kind: 'text',
                  role: 'assistant',
                  content: cleanedContent,
                  sequence: stepIndex,
                  providerRowKey: buildAntigravityAssistantRowKey(nativeStepIndex),
                  contentCompleteness,
                }));
              }
            }

            if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
              for (let t = 0; t < entry.tool_calls.length; t++) {
                const tc = entry.tool_calls[t] as AnyRecord;
                const toolName = readOptionalString(tc?.name) || 'tool';
                const args = normalizeAntigravityToolArgs(tc?.args ?? {});
                // Both transports must name this call the same way, or the
                // live card and the persisted one render side by side. Live
                // reports the tool at its own step, which is the step after
                // the planner entry that declared it (verified across two
                // real sessions: 830/830 and 798/807 calls are followed by
                // their GENERIC output one step later, and no planner entry
                // has ever carried more than one call). `t` keeps the formula
                // total should that ever change.
                const toolId = buildAntigravityToolId(nativeStepIndex, t);

                normalizedMessages.push(createNormalizedMessage({
                  id: buildAntigravityToolRowId(sessionId, toolId),
                  sessionId,
                  timestamp: createdAt,
                  provider: PROVIDER,
                  kind: 'tool_use',
                  toolName,
                  toolInput: args,
                  toolId,
                  sequence: stepIndex,
                }));
              }
            }
            continue;
          }

          // Remaining MODEL entries are tool results (RUN_COMMAND, VIEW_FILE,
          // CODE_ACTION, LIST_DIRECTORY, GREP_SEARCH, ...) or GENERIC
          // background-task output. Rows reach here in step order, so pairing
          // each with the oldest tool_use still missing its result is exact.
          if (source === 'MODEL' && rawContent) {
            const pendingToolUse = normalizedMessages.find(
              (msg) => msg.kind === 'tool_use' && !msg.toolResult,
            );
            if (pendingToolUse) {
              pendingToolUse.toolResult = {
                content: cleanAntigravityMessageContent(rawContent, 'tool_result'),
                isError: entry.status === 'ERROR'
                  || (typeof entry.exit_code === 'number' && entry.exit_code !== 0),
              };
              continue;
            }

            // Nothing to pair with. Genuine background-task status is surfaced
            // as assistant text, but raw tool output must never be: that is a
            // pairing miss, and rendering it dumps the tool's payload into the
            // conversation as if the model had written it.
            const cleanedContent = cleanAntigravityMessageContent(rawContent, 'assistant');
            if (cleanedContent && !looksLikeToolResultPayload(cleanedContent)) {
              normalizedMessages.push(createNormalizedMessage({
                id: baseId,
                sessionId,
                timestamp: createdAt,
                provider: PROVIDER,
                kind: 'text',
                role: 'assistant',
                content: cleanedContent,
                sequence: stepIndex,
              }));
            }
          }
        } catch {
          // Ignore corrupted lines
        }
      }

      const total = normalizedMessages.length;
      const { page, hasMore } = sliceTailPage(normalizedMessages, limit, offset);

      let tokenUsage: unknown = undefined;
      const brainDir = path.resolve(transcriptPath, '../../..');
      const tokenUsagePath = path.join(brainDir, 'token_usage.json');
      if (fs.existsSync(tokenUsagePath)) {
        try {
          const rawUsage = await readFile(tokenUsagePath, 'utf8');
          tokenUsage = JSON.parse(rawUsage);
        } catch {
          // Fall back gracefully
        }
      }

      return {
        messages: page,
        total,
        hasMore,
        offset,
        limit,
        tokenUsage,
      };
    } catch (error) {
      console.warn(`[AntigravitySessions] Failed to load history for ${sessionId}:`, error);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  }

  /**
   * Reads the token usage for one Antigravity session.
   *
   * Consumer: the provider token-usage service. A persisted
   * `token_usage.json` in the session's brain directory wins (written by the
   * quota feature with exact counters); otherwise usage is parsed from the
   * transcript. The transcript is located via the app row's indexed
   * `jsonl_path` when it still exists, then via the brain directory lookup.
   */
  async getTokenUsage(input: ProviderSessionUsageInput): Promise<ProviderTokenUsageResult> {
    const indexedFilePath = input.jsonlPath && fs.existsSync(input.jsonlPath)
      ? input.jsonlPath
      : null;
    const sessionFilePath = indexedFilePath ?? findTranscriptPath(input.nativeSessionId);

    if (!sessionFilePath) {
      throw new AppError(`Antigravity session file for "${input.appSessionId}" was not found.`, {
        code: 'ANTIGRAVITY_SESSION_FILE_NOT_FOUND',
        statusCode: 404,
      });
    }

    // Check for persisted token_usage.json in session's brain directory
    const brainDir = path.resolve(sessionFilePath, '../../..');
    const tokenUsagePath = path.join(brainDir, 'token_usage.json');
    if (fs.existsSync(tokenUsagePath)) {
      try {
        const usageRaw = await readFile(tokenUsagePath, 'utf8');
        const usageJson = JSON.parse(usageRaw) as ProviderTokenUsageResult | null;
        // Older builds persisted the turn-wide result sum, which can exceed
        // the window; such a snapshot is not a context reading, so skip it.
        const overflowsWindow = typeof usageJson?.total === 'number' && usageJson.used > usageJson.total;
        if (usageJson && typeof usageJson.used === 'number' && !overflowsWindow) {
          return usageJson;
        }
      } catch {
        // Fall back to reading the transcript file.
      }
    }

    const fileContent = await readFile(sessionFilePath, 'utf8');
    return readAntigravityTokenUsage(fileContent);
  }

  /**
   * Cleans up Antigravity native storage (summary DB row, brain directory, and conversations directory).
   */
  async cleanupSession(nativeSessionId: string, jsonlPath?: string | null): Promise<boolean> {
    let removed = false;

    if (jsonlPath) {
      if (await removePathIfExists(jsonlPath)) {
        removed = true;
      }
    }

    const summariesDbPath = getAntigravitySummariesDbPath();
    if (fs.existsSync(summariesDbPath)) {
      let db: Database.Database | null = null;
      try {
        db = new Database(summariesDbPath);
        const res = db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(nativeSessionId);
        if (res.changes > 0) {
          removed = true;
        }
      } catch (err) {
        console.warn('[AntigravitySessions] Failed to delete Antigravity summary row:', err);
      } finally {
        if (db) {
          db.close();
        }
      }
    }

    // The engine rebuilds `conversation_summaries.db` from its durable store on
    // every startup, so the database row alone does not keep the session gone.
    if (nativeSessionId && pruneAntigravityDurableStores(new Set([nativeSessionId]))) {
      removed = true;
    }

    if (nativeSessionId) {
      try {
        const safeId = sanitizeLeafDirectoryName(nativeSessionId, 'antigravity session id');
        const dataRoot = getAntigravityDataRoot();

        // 1. Clean up brain directories (current and legacy roots)
        for (const brainRoot of getAntigravityBrainRoots()) {
          const brainDir = path.join(brainRoot, safeId);
          if (await removePathIfExists(brainDir)) {
            removed = true;
          }
        }

        // 2. Clean up conversation DB files (.db, .db-wal, .db-shm) and directories if any
        const convDbPath = path.join(dataRoot, 'conversations', `${safeId}.db`);
        if (await removePathIfExists(convDbPath)) {
          removed = true;
        }
        await removePathIfExists(`${convDbPath}-wal`);
        await removePathIfExists(`${convDbPath}-shm`);

        const convDir = path.join(dataRoot, 'conversations', safeId);
        if (await removePathIfExists(convDir)) {
          removed = true;
        }

        // 3. Clean up lock files in presence/
        const lockPath = path.join(dataRoot, 'presence', `${safeId}.lock`);
        if (await removePathIfExists(lockPath)) {
          removed = true;
        }
      } catch {
        // Skip if safeId is invalid
      }
    }

    return removed;
  }

  /**
   * Cleans up Antigravity native storage for an entire project path.
   */
  async cleanupProjectStorage(projectPath: string): Promise<void> {
    const normalizedPath = normalizeProjectPath(projectPath);
    if (!normalizedPath || normalizedPath === path.parse(normalizedPath).root) {
      return;
    }

    const summariesDbPath = getAntigravitySummariesDbPath();
    const matchingConversationIds: string[] = [];
    if (fs.existsSync(summariesDbPath)) {
      let db: Database.Database | null = null;
      try {
        db = new Database(summariesDbPath);
        const rows = db.prepare('SELECT conversation_id, workspace_uris FROM conversation_summaries').all() as Array<{
          conversation_id: string;
          workspace_uris: string | null;
        }>;

        for (const row of rows) {
          if (!row.workspace_uris) {
            continue;
          }
          const ws = parseAntigravityWorkspacePath(row.workspace_uris);
          if (ws && normalizeProjectPath(ws) === normalizedPath) {
            matchingConversationIds.push(row.conversation_id);
            db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(row.conversation_id);
          }
        }
      } catch (err) {
        console.warn('[AntigravitySessions] Failed to clean up Antigravity workspace summaries:', err);
      } finally {
        if (db) {
          db.close();
        }
      }
    }

    const dataRoot = getAntigravityDataRoot();
    const brainRoots = getAntigravityBrainRoots();
    pruneAntigravityDurableStores(new Set(matchingConversationIds));
    for (const convId of matchingConversationIds) {
      try {
        const safeId = sanitizeLeafDirectoryName(convId, 'conversation id');
        for (const brainRoot of brainRoots) {
          await removePathIfExists(path.join(brainRoot, safeId));
        }

        const convDbPath = path.join(dataRoot, 'conversations', `${safeId}.db`);
        await removePathIfExists(convDbPath);
        await removePathIfExists(`${convDbPath}-wal`);
        await removePathIfExists(`${convDbPath}-shm`);
        await removePathIfExists(path.join(dataRoot, 'conversations', safeId));
        await removePathIfExists(path.join(dataRoot, 'presence', `${safeId}.lock`));
      } catch {
        // Ignore invalid leaf directory names
      }
    }
  }
}
