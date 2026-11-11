import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
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
  SubagentActivity,
  SubagentInfo,
  SessionPurgeResult,
} from '@/shared/types.js';
import {
  measurePathBytes,
  ProviderDisplayAssetError,
  compactProviderPayload,
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
  SUBAGENT_TOOL_NAME,
  MAX_TRANSMITTED_SUBAGENT_ACTIVITIES,
  truncateSubagentActivity,
} from '@/shared/utils.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';
import { prepareTranscriptMessages } from '@/shared/message-unification.js';
import { resolveAttachmentAssetFile } from '@/modules/assets/index.js';

import { zcodeBackgroundWork } from './zcode-background-work.js';
import { getZCodeAgentSidecarDir, getZCodeDatabasePath, getZCodeStorageDir } from './zcode-data-root.js';
import { ZCodeProtocolClient } from './zcode-protocol.client.js';
import {
  buildZCodeTextRowKey,
  createZCodeCompactionMessage,
  createZCodeCompactSummaryMessage,
  isZCodeCancelledEngineError,
  readZCodeTokenUsedCount,
  ZCodeLiveEventNormalizer,
  ZCODE_CANCELLED_NOTICE,
  ZCODE_CANCELLED_NOTICE_KEY,
} from './zcode-live-event-normalizer.js';

const PROVIDER = 'zcode';

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
      if (error instanceof ProviderDisplayAssetError) throw error;
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
 * Strips the upload-store prefix (`<timestamp>-<random>-`, per the assets
 * route's multer naming) from a stored attachment filename, recovering the
 * name the composer originally showed. Older rows and names that never had
 * the prefix pass through unchanged.
 */
function stripStoredAttachmentPrefix(storedName: string): string {
  return storedName.replace(/^\d{13}-\d+-/, '');
}

/**
 * Resolves one persisted non-image zcode file part into a downloadable file
 * card. Unlike images (whose parts carry a `zcode-artifact://` URI into the
 * engine's artifact store), non-image uploads stay in cloudcli's own asset
 * store, so the part's `filename`/`url` are plain references back into
 * `~/.cloudcli/assets`. Only the basename is ever used, and the resolved file
 * must exist — metadata-only rows (engine could not read the upload) and
 * vanished files surface nothing rather than a dead card. Returns the
 * attachment descriptor for the normalized message, or null.
 */
function resolveZcodeStoredFilePart(
  partData: AnyRecord,
): { name: string; path: string; mimeType?: string; size?: number } | null {
  const storedName = path.basename(
    readOptionalString(partData.filename) ?? readOptionalString(partData.url) ?? '',
  );
  if (!storedName || storedName === '/' || storedName === '.') {
    return null;
  }
  const resolved = resolveAttachmentAssetFile(storedName);
  if (!resolved || !fsSync.existsSync(resolved)) {
    return null;
  }

  let size: number | undefined;
  try {
    size = fsSync.statSync(resolved).size;
  } catch {
    size = undefined;
  }

  return {
    name: stripStoredAttachmentPrefix(storedName),
    path: storedName,
    mimeType: readOptionalString(partData.mime) ?? undefined,
    size,
  };
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
  const rows = db.prepare('SELECT data FROM message WHERE session_id = ?').iterate(sessionId) as Iterable<{ data: string }>;

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
 * What the engine's per-agent sidecar (`metadata.json`) says about one
 * spawned agent, reduced to the fields an Agent card reads.
 */
type ZCodeAgentSidecar = {
  agentId: string;
  childSessionId?: string;
  /**
   * The call that last started it: the `Agent` call at spawn, rewritten to
   * the `SendMessage` call when the engine resumes a stopped agent. Only a
   * fallback for pairing, for a launch whose result does not name its agent.
   */
  parentToolUseId: string;
  profileId?: string;
  description?: string;
  /** `running` at spawn, rewritten to `completed`/`failed` when the agent stops. */
  status?: string;
};

/**
 * Reads every agent sidecar one session wrote, keyed by agent id.
 * A session that spawned nothing has no directory; an unreadable or
 * malformed sidecar is skipped rather than failing the whole history, since
 * the card still renders from its own input and result.
 */
async function readZCodeAgentSidecars(parentSessionId: string): Promise<Map<string, ZCodeAgentSidecar>> {
  const byAgentId = new Map<string, ZCodeAgentSidecar>();
  const dir = getZCodeAgentSidecarDir(parentSessionId);

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (error) {
    // No directory simply means the session spawned no agent. Anything else
    // (permissions, a file in the way) hides every agent's outcome, so say so.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[ZCodeSessions] Could not read the agent sidecar directory ${dir}:`, error);
    }
    return byAgentId;
  }

  for (const entry of entries) {
    try {
      const parsed = readJsonRecord(await fsp.readFile(path.join(dir, entry, 'metadata.json'), 'utf8'));
      const agentId = readOptionalString(parsed?.agentId);
      const parentToolUseId = readOptionalString(parsed?.parentToolUseId);
      if (!parsed || !agentId || !parentToolUseId) {
        continue;
      }
      byAgentId.set(agentId, {
        agentId,
        parentToolUseId,
        childSessionId: readOptionalString(parsed.childSessionId),
        profileId: readOptionalString(parsed.profileId),
        description: readOptionalString(parsed.description),
        status: readOptionalString(parsed.status),
      });
    } catch (error) {
      // Not every entry is an agent directory with a finished sidecar; a
      // missing metadata.json is that ordinary case, anything else is not.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        console.error(`[ZCodeSessions] Could not read the agent sidecar ${path.join(dir, entry)}:`, error);
      }
    }
  }

  return byAgentId;
}

/** The engine's own rule (`zcode.cjs`) for the agent id line in an `Agent` result. */
const ZCODE_LAUNCHED_AGENT_ID_PATTERN = /(?:^|\r?\n)agentId:\s*([^\s(]+)/u;

/**
 * The agent an `Agent` call launched, read off its result the way the engine
 * itself rebuilds its history: foreground and background launches alike end
 * with an `agentId: <id>` line. The sidecar's `parentToolUseId` cannot say
 * this reliably, because resuming the agent rewrites it to the SendMessage
 * call.
 */
function readZCodeLaunchedAgentId(result: unknown): string | undefined {
  return typeof result === 'string' ? ZCODE_LAUNCHED_AGENT_ID_PATTERN.exec(result)?.[1] : undefined;
}

/**
 * The `Agent` call in a session whose result names the agent, read from the
 * engine's database. The live normalizer asks for it when the engine resumes
 * a stopped agent, which is usually turns after the launch — possibly before
 * a server restart — so no in-memory record could answer.
 */
function findZCodeAgentLaunchCallId(engineSessionId: string, agentId: string): string | undefined {
  const db = openZCodeDatabase();
  if (!db) {
    return undefined;
  }
  try {
    const rows = db.prepare(
      `SELECT json_extract(data, '$.callID') AS call_id, json_extract(data, '$.state.output') AS output
         FROM part
        WHERE session_id = ?
          AND json_extract(data, '$.tool') = ?
          AND instr(json_extract(data, '$.state.output'), ?) > 0
        ORDER BY time_created, id`,
    ).all(engineSessionId, SUBAGENT_TOOL_NAME, agentId) as Array<{ call_id: unknown; output: unknown }>;
    const launch = rows.find((row) => readZCodeLaunchedAgentId(row.output) === agentId);
    return readOptionalString(launch?.call_id);
  } finally {
    db.close();
  }
}

/**
 * The model the agent's own session ran on, read off its first assistant
 * row. The sidecar does not record it, and the spawn event's `model` is not
 * persisted anywhere.
 */
function readZCodeChildSessionModel(db: Database.Database, childSessionId: string): string | undefined {
  const rows = db.prepare(
    'SELECT data FROM message WHERE session_id = ? ORDER BY COALESCE(time_created, 0), sequence, id',
  ).iterate(childSessionId) as Iterable<{ data: string }>;
  for (const row of rows) {
    const info = readJsonRecord(row.data);
    if (readOptionalString(info?.role) !== 'assistant') {
      continue;
    }
    return readOptionalString(info?.modelId) ?? readOptionalString(info?.modelID);
  }
  return undefined;
}

type ZCodeSessionsProviderOptions = {
  /**
   * Whether the runtime still tracks this agent as running. Only consulted
   * for an agent whose sidecar still says `running`: the sidecar is rewritten
   * when the agent stops, so `running` with no tracker means the process
   * that ran it is gone and nothing can still report. Injected so history
   * tests can pin both readings without driving a real engine.
   */
  isSubagentRunning?: (agentId: string) => boolean;
};

/** The engine's own session id rule; anything else is refused before it can reach a path. */
const ZCODE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The purge's reference check scans every message part, so it needs far longer than a normal request. */
const ZCODE_SESSION_DATA_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Session history provider for ZCode's SQLite-backed session store.
 *
 * Implements the IProviderSessions interface to normalize ZCode-specific
 * events and message history into the shared transport shapes consumed by
 * API routes and realtime streams.
 */
export class ZCodeSessionsProvider implements IProviderSessions {
  private readonly liveEventNormalizer = new ZCodeLiveEventNormalizer({ findAgentLaunchCallId: findZCodeAgentLaunchCallId });
  private readonly isSubagentRunning: (agentId: string) => boolean;

  constructor({ isSubagentRunning = (agentId) => zcodeBackgroundWork.has(agentId) }: ZCodeSessionsProviderOptions = {}) {
    this.isSubagentRunning = isSubagentRunning;
  }

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
   * Loads ZCode session history from SQLite database.
   *
   * Iterates joined message/part rows through a read-only connection and
   * compacts media before retaining the normalized transcript.
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
      const rows = this.selectHistoryRows(db, providerSessionId);

      const normalized = this.normalizeHistoryRows(rows, sessionId);
      await this.attachSubagents(db, normalized, providerSessionId);
      const tokenUsage = aggregateZCodeSessionTokenUsage(db, providerSessionId);

      // The same unification pass Claude and Codex run on their histories: it
      // folds the user's AskUserQuestion answer out of the result prose into
      // the call's input (the question card reads it from there — without this
      // every answered question renders as Skipped), caps oversized outputs,
      // and drops superseded checklist snapshots. ZCode histories carry every
      // result attached to its call, so the pass drops nothing else here.
      const transcript = prepareTranscriptMessages(normalized);

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = transcript.length;
      const { page, hasMore } = sliceTailPage(transcript, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      if (error instanceof ProviderDisplayAssetError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ZCodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    } finally {
      db.close();
    }
  }

  /** One session's message and part rows, in transcript order. */
  private selectHistoryRows(db: Database.Database, providerSessionId: string): Iterable<ZCodeHistoryRow> {
    return db.prepare(`
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
        p.sequence,
        p.id
    `).iterate(providerSessionId) as Iterable<ZCodeHistoryRow>;
  }

  /**
   * The agent's own work as a subagent timeline: the text, reasoning and tool
   * calls of its child session, read with the same normalizer as the parent's
   * history. A child session the database does not hold yields an empty list.
   */
  private readChildSessionActivity(db: Database.Database, childSessionId: string): SubagentActivity[] {
    const messages = this.normalizeHistoryRows(this.selectHistoryRows(db, childSessionId), childSessionId);
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
      } else if (message.kind === 'text' && message.role !== 'user') {
        activity.push({ kind: 'text', timestamp: message.timestamp, content: message.content });
      } else if (message.kind === 'thinking') {
        activity.push({ kind: 'thinking', timestamp: message.timestamp, content: message.content });
      }
    }
    return activity;
  }

  /**
   * Normalize SQLite history rows into NormalizedMessage format.
   *
   * Parses message.data JSON for role/modelID/tokens and handles the part
   * table's type discriminator (`text`/`reasoning`/`tool`/`step-finish`)
   * per the Phase 0.3 SQLite schema. Applies suffix to fragment IDs for
   * uniqueness per §5.1 of the plan.
   */
  private normalizeHistoryRows(rows: Iterable<ZCodeHistoryRow>, sessionId: string): NormalizedMessage[] {
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
      const messageInfo = compactProviderPayload(readJsonRecord(row.message_data));
      const messageRole = readOptionalString(messageInfo?.role);

      // A compaction summary is written for the model, so the engine marks it
      // hidden like any injection, but the user asked for it: its text is the
      // summary the client folds into the compaction row. Its own `compaction`
      // part repeats the boundary the visible timeline row already draws.
      const isCompactSummary = messageRole === 'user'
        && (readOptionalString(readObjectRecord(messageInfo?.semantics)?.kind) === 'compact_summary'
          || Boolean(readObjectRecord(messageInfo?.summary)));
      if (isCompactSummary) {
        const summaryPart = readJsonRecord(row.part_data);
        const content = readOptionalString(summaryPart?.type) === 'text' ? extractText(summaryPart) : '';
        if (content.trim() && !emittedSummaryMessages.has(row.message_id)) {
          emittedSummaryMessages.add(row.message_id);
          normalized.push(createZCodeCompactSummaryMessage(row.message_id, sessionId, timestamp, content));
        }
        continue;
      }

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
        if (isZCodeCancelledEngineError(messageInfo.error)) {
          // A cancelled model request is not a failure: replay it as the same
          // quiet line the live stream degrades it to, not a red error card.
          normalized.push(createNormalizedMessage({
            id: `${baseId}_cancelled`,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'task_notification',
            summary: ZCODE_CANCELLED_NOTICE,
            summaryKey: ZCODE_CANCELLED_NOTICE_KEY,
            status: 'interrupted',
          }));
        } else {
          normalized.push(createNormalizedMessage({
            id: `${baseId}_error`,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'error',
            content: formatToolContent(messageInfo.error),
          }));
        }
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

      const rawPartData = readJsonRecord(row.part_data);
      const partData = compactProviderPayload(rawPartData && messageRole === 'user' ? { ...rawPartData, role: 'user' } : rawPartData);
      if (!partData) {
        continue;
      }

      const partType = readOptionalString(partData.type);

      // The compaction operation on the visible timeline message: the row
      // the live updates of the same part drew.
      if (partType === 'compaction' && readOptionalString(partData.timelineStatus)) {
        normalized.push(createZCodeCompactionMessage(partData, row.part_id, sessionId, timestamp));
        continue;
      }

      // Handle text parts
      if (partType === 'text') {
        const content = extractText(partData);

        if (content.trim()) {
          normalized.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: messageRole === 'user' ? 'user' : 'assistant',
            content,
            // The live stream never names this row — it sends deltas under
            // the message id — so the message id is the only identity the
            // two paths share. Without it the streamed reply and this row
            // are two rows nothing but their text could relate.
            ...(messageRole === 'user' ? {} : { providerRowKey: buildZCodeTextRowKey(row.message_id) }),
          }));
          textRowIndexByMessageId.set(row.message_id, normalized.length - 1);
        }
        continue;
      }

      // Handle file parts — user uploads. Images live in the engine's
      // artifact store behind a zcode-artifact:// URI and are materialized
      // into the shared asset store; non-image uploads keep pointing at
      // cloudcli's own asset store and surface as downloadable file cards.
      // Both attach to the message's text row (or a standalone user message).
      if (partType === 'file' || partType === 'image') {
        const image = materializeZcodeArtifactImage(partData, sessionId);
        const file = image ? null : resolveZcodeStoredFilePart(partData);
        if (image || file) {
          const existingIndex = textRowIndexByMessageId.get(row.message_id);
          if (existingIndex !== undefined) {
            const target = normalized[existingIndex];
            if (image) {
              const existingImages = Array.isArray(target.images) ? target.images : [];
              target.images = [...existingImages, image];
            } else if (file) {
              const existingFiles = Array.isArray(target.files) ? target.files : [];
              target.files = [...existingFiles, file];
            }
          } else if (messageRole === 'user') {
            normalized.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: '',
              ...(image ? { images: [image] } : file ? { files: [file] } : {}),
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

      // A finished step is a run-lifecycle signal, not a transcript row.
      // `complete` is emitted once per live run and terminates it; a stored
      // transcript has no run in flight, and emitting one row per persisted
      // step filled about a third of a real session's history with rows that
      // render nothing — skewing every page of pagination and every scan that
      // walks the transcript. Token totals reach the client through the
      // session's own token usage, not through these.
      if (partType === 'step-finish' || partType === 'done') {
        continue;
      }
    }

    return normalized;
  }

  /**
   * Publishes each spawned agent's outcome on the Agent row that launched it.
   *
   * The launch row alone cannot say how the agent ended: a background
   * launch's result is only the acknowledgement ("Async agent launched
   * successfully…"), and the lifecycle events that reported the stop live
   * were never persisted. The engine's sidecar is the durable record, and
   * the card reads its status off `subagent`, so the row gets one whenever
   * its agent has a sidecar. The row finds its agent by the id its result
   * names, else by the sidecar that names this call.
   */
  private async attachSubagents(
    db: Database.Database,
    messages: NormalizedMessage[],
    providerSessionId: string,
  ): Promise<void> {
    const launches = messages.filter((message) => message.kind === 'tool_use' && message.toolName === SUBAGENT_TOOL_NAME && message.toolId);
    if (launches.length === 0) {
      return;
    }

    const sidecars = await readZCodeAgentSidecars(providerSessionId);
    for (const launch of launches) {
      const agentId = readZCodeLaunchedAgentId(launch.toolResult?.content);
      const sidecar = agentId
        ? sidecars.get(agentId)
        : [...sidecars.values()].find((candidate) => candidate.parentToolUseId === launch.toolId);
      if (!sidecar) {
        continue;
      }

      const input = readObjectRecord(launch.toolInput);
      const subagent: SubagentInfo = {
        id: sidecar.agentId,
        name: sidecar.profileId,
        type: sidecar.profileId,
        description: sidecar.description ?? readOptionalString(input?.description),
        status: this.resolveSidecarStatus(sidecar),
        model: sidecar.childSessionId ? readZCodeChildSessionModel(db, sidecar.childSessionId) : undefined,
      };
      if (sidecar.childSessionId) {
        const activity = this.readChildSessionActivity(db, sidecar.childSessionId);
        if (activity.length > 0) {
          launch.subagentTools = activity
            .slice(0, MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)
            .map(truncateSubagentActivity);
          subagent.activityCount = activity.length;
        }
      }
      launch.subagent = subagent;
    }
  }

  /**
   * `completed` and `failed` are the engine's final word. `running` is only
   * final while the runtime still tracks the agent; otherwise the process
   * that ran it is gone and the card must not spin forever. Anything else
   * the engine may write (a stop, a cancellation) reads as stopped.
   */
  private resolveSidecarStatus(sidecar: ZCodeAgentSidecar): SubagentInfo['status'] {
    switch (sidecar.status) {
      case 'completed':
      case 'failed':
        return sidecar.status;
      case 'running':
        return this.isSubagentRunning(sidecar.agentId) ? 'running' : 'stopped';
      default:
        return 'stopped';
    }
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
   * Removes the image cache and shell output of one session. The engine
   * rebuilds the cache from `artifacts` on demand and only reads shell output
   * while running. `artifacts` and `agents` are never touched here: resume,
   * rewind and subagent cards read them.
   */
  async cleanupSessionArtifacts(nativeSessionId: string, options: { dryRun?: boolean } = {}): Promise<number> {
    if (!ZCODE_SESSION_ID_PATTERN.test(nativeSessionId)) {
      return 0;
    }
    const cliRoot = path.join(getZCodeStorageDir(), 'cli');
    let bytes = 0;
    for (const target of [
      path.join(cliRoot, 'image-cache', nativeSessionId),
      path.join(cliRoot, 'exec', nativeSessionId),
      path.join(cliRoot, 'exec', 'bash-startup', nativeSessionId),
    ]) {
      bytes += await measurePathBytes(target);
      if (!options.dryRun) {
        await fsp.rm(target, { recursive: true, force: true });
      }
    }
    return bytes;
  }

  async measureSessionStorage(nativeSessionIds: string[]): Promise<Map<string, number>> {
    const result = await ZCodeProtocolClient.getInstance().sendRequest<{
      sessions: { sessionId: string; bytes: number }[];
    }>('v4/storage/sessionData/measure', { sessionIds: nativeSessionIds, directories: [] }, ZCODE_SESSION_DATA_TIMEOUT_MS);
    return new Map(result.sessions.map(({ sessionId, bytes }) => [sessionId, bytes]));
  }

  /** Delegates to the engine, which owns session trees and cross-session artifact references. */
  async purgeSessions(nativeSessionIds: string[]): Promise<SessionPurgeResult> {
    const { deleted, kept, failed } = await ZCodeProtocolClient.getInstance().sendRequest<SessionPurgeResult>(
      'v4/storage/sessionData/purge',
      { sessionIds: nativeSessionIds, directories: [] },
      ZCODE_SESSION_DATA_TIMEOUT_MS,
    );
    return { deleted, kept, failed };
  }

  listStorageRoots(): string[] {
    return [path.join(getZCodeStorageDir(), 'cli', 'db')];
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
