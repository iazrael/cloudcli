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
  SubagentActivity,
  SubagentInfo,
} from '@/shared/types.js';
import {
  ProviderDisplayAssetError,
  readJsonlRecords,
  compactProviderPayload,
  AppError,
  createCompactionMessage,
  createNormalizedMessage,
  generateMessageId,
  normalizeProjectPath,
  parseAntigravityWorkspacePath,
  readObjectRecord,
  readOptionalString,
  readUsageNumber,
  removePathIfExists,
  sanitizeLeafDirectoryName,
  SUBAGENT_TOOL_NAME,
  sliceTailPage,
  truncateSubagentActivity,
} from '@/shared/utils.js';

import {
  getAntigravityBrainRoots,
  getAntigravityDataRoot,
  getAntigravitySummariesDbPath,
  getAntigravityTranscriptCandidates,
} from './antigravity-data-root.js';
import {
  ANTIGRAVITY_SPAWN_TOOL,
  antigravityBackgroundWork,
  buildAntigravityAgentToolId,
  buildAntigravityToolId,
  buildAntigravityToolRowId,
  createAntigravityAgentRow,
  extractAntigravitySubagents,
  judgeAntigravityAgent,
  parseCreatedSubagentIds,
  readTrackedAgentIds,
  readAgentReports,
  readInvokedAgentSpecs,
  SPAWN_RECEIPT_PATTERN,
} from './antigravity-subagent.js';
import { readCanonicalAntigravityTranscript } from './antigravity-transcript.provider.js';

const PROVIDER = 'antigravity';

/**
 * Builds the identity shared by Antigravity's live assistant delta and its
 * eventual PLANNER_RESPONSE transcript row. Missing native step indexes stay
 * unidentified so clients can fall back to their legacy reconciliation rules.
 */
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
async function readAntigravityTokenUsage(filename: string): Promise<ProviderTokenUsageResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let estimatedInputChars = 0;
  let estimatedOutputChars = 0;
  for await (const entry of readJsonlRecords(filename)) {
    const contentLength = typeof entry.content === 'string' ? entry.content.length : 0;
    const thinkingLength = typeof entry.thinking === 'string' ? entry.thinking.length : 0;
    if (entry.source === 'MODEL' || entry.type === 'PLANNER_RESPONSE') estimatedOutputChars += contentLength + thinkingLength;
    else estimatedInputChars += contentLength;
    const usage = entry.usage ?? entry.result?.usage
      ?? (entry.event === 'result' ? entry.result?.usage : null) ?? entry.payload?.usage ?? null;
    if (usage) {
      inputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens);
      outputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens);
      totalTokens = readUsageNumber(usage.total_tokens ?? usage.totalTokens) || inputTokens + outputTokens;
    } else if (typeof entry.total_tokens === 'number' || typeof entry.tokens === 'number') {
      totalTokens = readUsageNumber(entry.total_tokens ?? entry.tokens);
      inputTokens = readUsageNumber(entry.input_tokens ?? entry.prompt_tokens);
      outputTokens = readUsageNumber(entry.output_tokens ?? entry.completion_tokens);
    }
  }
  if (totalTokens === 0 && inputTokens === 0 && outputTokens === 0) {
    inputTokens = Math.ceil(estimatedInputChars / 3);
    outputTokens = Math.ceil(estimatedOutputChars / 3);
    totalTokens = inputTokens + outputTokens;
  }
  return { used: totalTokens || inputTokens + outputTokens, inputTokens, outputTokens, breakdown: { input: inputTokens, output: outputTokens } };
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
    const raw = readObjectRecord(compactProviderPayload(rawMessage));
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

      // A checkpoint is Antigravity's compaction: running while it summarizes,
      // done once the summary is in. The summary itself only reaches the
      // transcript, so history adds it.
      if (stepType === 'checkpoint' && stepIndex !== undefined && (state === 'ACTIVE' || state === 'DONE' || state === 'ERROR')) {
        messages.push(createCompactionMessage({
          id: `msg_${sessionId}_${stepIndex}_compact`,
          sessionId,
          provider: PROVIDER,
          phase: state === 'ACTIVE' ? 'running' : state === 'ERROR' ? 'failed' : 'done',
        }));
      }

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

      // An invocation that created agents: one `Agent` card per agent.
      for (const agent of extractAntigravitySubagents(step)) {
        messages.push(createAntigravityAgentRow({
          sessionId,
          toolId: agent.toolUseId,
          spec: agent,
          sequence: stepIndex,
        }));
      }

      // The spawn call is drawn by its Agent cards, one per created agent
      // (above); a raw tool row beside them would be a duplicate that history,
      // which drops the call, never shows.
      const isSpawnCall = stepType === 'tool' && readOptionalString(step.tool_name) === ANTIGRAVITY_SPAWN_TOOL;

      // Tool use initiation
      if (stepType === 'tool' && state === 'ACTIVE' && !isSpawnCall) {
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
      if (stepType === 'tool' && (state === 'DONE' || state === 'ERROR') && !isSpawnCall) {
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
      // Agents each `invoke_subagent` call created, by the call's id. The
      // call declares roles and prompts; the conversation ids (which name
      // the cards) only arrive with the receipt on the following step.
      const spawnCalls = new Map<string, { rows: NormalizedMessage[]; receipt?: string }>();

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

          // A checkpoint is a compaction; its content is the summary the
          // conversation continues from, folded into the row by the client.
          if (type === 'CHECKPOINT') {
            normalizedMessages.push(createCompactionMessage({
              id: `${baseId}_compact`,
              sessionId,
              timestamp: createdAt,
              provider: PROVIDER,
              phase: readOptionalString(entry.status) === 'ERROR' ? 'failed' : 'done',
            }));
            if (rawContent.trim()) {
              normalizedMessages.push(createNormalizedMessage({
                id: `${baseId}_summary`,
                sessionId,
                timestamp: createdAt,
                provider: PROVIDER,
                kind: 'text',
                role: 'assistant',
                content: rawContent,
                isCompactSummary: true,
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
                // the planner entry that declared it, plus this call's
                // position when a planner entry batches several tools. This
                // also binds an agent receipt after neighboring tool results.
                const toolId = buildAntigravityToolId(nativeStepIndex, t);

                if (toolName === ANTIGRAVITY_SPAWN_TOOL) {
                  // Provisional ids by position; `settleSpawnCalls` swaps in
                  // the conversation ids once the receipt names them.
                  const rows = readInvokedAgentSpecs(tc?.args).map((spec, position) => createAntigravityAgentRow({
                    sessionId,
                    toolId: buildAntigravityAgentToolId(toolId, String(position)),
                    spec,
                    timestamp: createdAt,
                    sequence: stepIndex,
                  }));
                  normalizedMessages.push(...rows);
                  spawnCalls.set(toolId, { rows });
                  continue;
                }

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
            // The receipt of an `invoke_subagent` call belongs to its agents'
            // cards, never to another call as its result.
            const spawnCall = nativeStepIndex === undefined
              ? undefined
              : spawnCalls.get(buildAntigravityToolId(nativeStepIndex, null));
            if (spawnCall && !spawnCall.receipt && SPAWN_RECEIPT_PATTERN.test(rawContent)) {
              spawnCall.receipt = rawContent;
              continue;
            }

            const pendingToolUse = normalizedMessages.find(
              (msg) => msg.kind === 'tool_use' && !msg.toolResult && msg.toolName !== SUBAGENT_TOOL_NAME,
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

      await this.settleSpawnCalls(sessionId, providerSessionId, spawnCalls, canonicalRows.map((row) => readOptionalString(row.entry.content) ?? ''));

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
      if (error instanceof ProviderDisplayAssetError) throw error;
      console.warn(`[AntigravitySessions] Failed to load history for ${sessionId}:`, error);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  }

  /**
   * Names each agent card after its conversation and publishes the agent's
   * outcome and work on it.
   *
   * The engine records an agent finishing only as the report the agent sends
   * its parent, so a report means `completed` and carries the agent's answer.
   * An agent with no report is `running` only while this server's `agy`
   * process still tracks it; otherwise the process that ran it is gone and the
   * card must not spin forever, so it reads `stopped`.
   */
  private async settleSpawnCalls(
    sessionId: string,
    providerSessionId: string,
    spawnCalls: Map<string, { rows: NormalizedMessage[]; receipt?: string }>,
    rawContents: string[],
  ): Promise<void> {
    if (spawnCalls.size === 0) {
      return;
    }
    const reports = readAgentReports(rawContents);
    for (const [callToolId, call] of spawnCalls) {
      // No receipt yet means the run that created these agents is still in
      // flight: the live stream already named the cards by conversation id, so
      // adopt those ids (and their running status) or a refresh would draw a
      // second, differently named set.
      const conversationIds = call.receipt === undefined
        ? readTrackedAgentIds(callToolId, [sessionId, providerSessionId])
        : parseCreatedSubagentIds(call.receipt);
      for (const [position, row] of call.rows.entries()) {
        const conversationId = conversationIds[position];
        if (conversationId) {
          row.toolId = buildAntigravityAgentToolId(callToolId, conversationId);
          row.id = buildAntigravityToolRowId(sessionId, row.toolId);
        }
        const input = readObjectRecord(row.toolInput);
        const report = conversationId ? reports.get(conversationId.toLowerCase()) : undefined;
        // One judgement for live and history: a report or the agent's own
        // transcript says how it ended; an agent this server's `agy` still
        // tracks is running until its report or the turn result settles it.
        const status: SubagentInfo['status'] = !conversationId
          ? 'stopped'
          : report !== undefined
            ? 'completed'
            : antigravityBackgroundWork.has(conversationId)
              ? 'running'
              : judgeAntigravityAgent(conversationId);
        const subagent: SubagentInfo = {
          id: conversationId ?? String(row.toolId),
          name: readOptionalString(input?.subagent_type),
          type: readOptionalString(input?.subagent_type),
          description: readOptionalString(input?.description),
          status,
        };
        if (report !== undefined) {
          row.toolResult = { content: report, isError: false };
        }
        if (conversationId) {
          const activity = await this.readAgentActivity(conversationId);
          if (activity.length > 0) {
            row.subagentTools = activity.map(truncateSubagentActivity);
            subagent.activityCount = activity.length;
          }
        }
        row.subagent = subagent;
      }
    }
  }

  /** The agent's own transcript as a subagent timeline: its text and tool calls. */
  private async readAgentActivity(conversationId: string): Promise<SubagentActivity[]> {
    const { messages } = await this.fetchHistory(conversationId, {});
    const activity: SubagentActivity[] = [];
    for (const message of messages) {
      if (message.kind === 'tool_use') {
        activity.push({
          kind: 'tool',
          timestamp: message.timestamp,
          toolId: message.toolId,
          toolName: message.toolName,
          toolInput: message.toolInput,
          toolResult: message.toolResult ?? null,
        });
      } else if (message.kind === 'text' && message.role === 'assistant') {
        activity.push({ kind: 'text', timestamp: message.timestamp, content: message.content });
      }
    }
    return activity;
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

    return readAntigravityTokenUsage(sessionFilePath);
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
