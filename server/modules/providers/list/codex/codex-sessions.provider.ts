import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import {
  codexThreadItemToRows,
  humanizeCodexToolName,
  readCodexItemText,
  readCodexProposedPlan,
  readCodexRolloutItem,
} from '@/modules/providers/list/codex/codex-thread-items.js';
import { parseFilesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import { prepareTranscriptMessages } from '@/shared/message-unification.js';
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
  AppError,
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
    readUsageNumber,
    removePathIfExists,
    sliceTailPage,
    truncateSubagentActivity,
} from '@/shared/utils.js';

const PROVIDER = 'codex';

/**
 * How far up the `~/.codex/sessions/<year>/<month>/<day>` tree a subagent
 * rollout is searched for when it is not next to its parent. Spawned agents
 * are written seconds after the parent, so one directory level up (the month)
 * already covers a run that crosses midnight.
 */
const SUBAGENT_LOOKUP_PARENT_LEVELS = 2;

/**
 * Upper bound on how much of a subagent's timeline is sent to the client. A
 * long-running agent can record hundreds of tool calls, and the transcript only
 * ever shows them behind a collapsed header, so shipping the whole history on
 * every load costs far more than it shows.
 */
const MAX_TRANSMITTED_SUBAGENT_ACTIVITIES = 200;

type CodexHistoryResult = {
  messages: AnyRecord[];
  total?: number;
  hasMore?: boolean;
  offset?: number;
  limit?: number | null;
  tokenUsage?: unknown;
};

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Follows which turn a Codex rollout is inside as its rows stream past.
 *
 * A turn id is the address an edit cuts at: `thread/fork` takes a
 * `lastTurnId`, and that is what makes "edit this message" and "fork from
 * here" possible for Codex at all. Turns are bracketed by rows that carry
 * `turn_id` — `task_started` opens one, `turn_context` restates it,
 * `task_complete` closes it — and the prompt is written between them.
 *
 * `thread_rolled_back` retires the last N turns in place: the rows stay in
 * the file, but the turns are no longer part of the thread and the fork
 * endpoint refuses to cut at one. They are tracked here so a retired turn is
 * never offered as an anchor, rather than discovered when the fork fails.
 */
function createCodexTurnTracker() {
  /** Turn ids still part of the conversation, oldest first. */
  const liveTurnIds: string[] = [];
  const seenTurnIds = new Set<string>();
  const rolledBackTurnIds = new Set<string>();
  let currentTurnId: string | undefined;

  return {
    /** Feeds one rollout row in. */
    observe(entryType: unknown, payload: AnyRecord): void {
      if (entryType === 'event_msg' && payload.type === 'thread_rolled_back') {
        const retiredTurns = Number(payload.num_turns);
        for (let retired = 0; retired < retiredTurns && liveTurnIds.length > 0; retired++) {
          rolledBackTurnIds.add(liveTurnIds.pop() as string);
        }
        currentTurnId = undefined;
        return;
      }

      const turnId = readNonEmptyString(payload.turn_id);
      if (!turnId) {
        return;
      }
      currentTurnId = turnId;
      if (!seenTurnIds.has(turnId)) {
        seenTurnIds.add(turnId);
        liveTurnIds.push(turnId);
      }
    },
    /** The turn the rows being read belong to, or undefined outside one. */
    getCurrentTurnId(): string | undefined {
      return currentTurnId;
    },
    getLiveTurnIds(): string[] {
      return liveTurnIds;
    },
    isRolledBack(turnId: string): boolean {
      return rolledBackTurnIds.has(turnId);
    },
  };
}

/**
 * Reads the turns a Codex rollout still contains, oldest first.
 *
 * A separate pass rather than a by-product of the transcript reader: this runs
 * once when a message is edited, while the reader runs on every history fetch,
 * and both share the one rule for what a live turn is.
 */
async function readCodexLiveTurnIds(filePath: string): Promise<string[]> {
  const turns = createCodexTurnTracker();
  const stream = fsSync.createReadStream(filePath);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let entry: AnyRecord;
    try {
      entry = JSON.parse(line) as AnyRecord;
    } catch {
      continue;
    }
    const payload = readObjectRecord(entry.payload);
    if (payload) {
      turns.observe(entry.type, payload);
    }
  }

  return turns.getLiveTurnIds();
}

// ─── Subagents ──────────────────────────────────────────────────────────────

type CodexSubagentRecord = {
  toolCallId: string;
  message: AnyRecord;
  agentPath?: string;
  agentThreadId?: string;
  isComplete: boolean;
};

function parseCodexSubagentMessage(payload: AnyRecord): {
  author: string;
  messageType: string;
  result: string;
} | null {
  const text = readCodexItemText(payload.content);
  const header = /Message Type:\s*([^\r\n]+)[\s\S]*?Sender:\s*([^\r\n]+)[\s\S]*?Payload:\s*\r?\n([\s\S]*)/i.exec(text);
  const author = readNonEmptyString(payload.author) || header?.[2]?.trim();
  if (!author) {
    return null;
  }

  return {
    author,
    messageType: header?.[1]?.trim().toUpperCase() || 'MESSAGE',
    result: header?.[3]?.trim() || '',
  };
}

/**
 * Codex names a spawned agent's rollout file `rollout-<timestamp>-<threadId>`
 * and writes it next to the parent's. Look there first, then widen to the
 * enclosing day/month directories so a run that crosses midnight still
 * resolves, and give up rather than walking the whole archive.
 */
async function findCodexSubagentRollout(
  parentFilePath: string,
  agentThreadId: string,
): Promise<string | null> {
  const suffix = `-${agentThreadId}.jsonl`;
  let directory = path.dirname(parentFilePath);

  for (let level = 0; level <= SUBAGENT_LOOKUP_PARENT_LEVELS; level += 1) {
    const match = await findFileWithSuffix(directory, suffix, level === 0 ? 0 : level);
    if (match) {
      return match;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return null;
}

/** Depth-limited search for a file whose name ends with `suffix`. */
async function findFileWithSuffix(directory: string, suffix: string, depth: number): Promise<string | null> {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  const subdirectories: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      subdirectories.push(path.join(directory, entry.name));
      continue;
    }
    if (entry.name.endsWith(suffix)) {
      return path.join(directory, entry.name);
    }
  }

  if (depth <= 0) {
    return null;
  }

  for (const subdirectory of subdirectories) {
    const match = await findFileWithSuffix(subdirectory, suffix, depth - 1);
    if (match) {
      return match;
    }
  }

  return null;
}

type CodexSubagentTranscript = {
  activity: SubagentActivity[];
  nickname?: string;
  agentPath?: string;
  model?: string;
};

/**
 * Flattens a spawned agent's own rollout into the shared activity timeline.
 *
 * A subagent's rollout is the same format as the parent's, so it is read the
 * same way: through the assembled `item_completed` stream and the one row
 * renderer. The rows are then folded into the panel's activity shape, which
 * pairs each tool call with its result.
 */
async function readCodexSubagentTranscript(filePath: string): Promise<CodexSubagentTranscript> {
  const activity: SubagentActivity[] = [];
  const transcript: CodexSubagentTranscript = { activity };
  /** Tool activities still waiting for the result row that settles them. */
  const pendingResults = new Map<string, SubagentActivity>();

  let fileStream;
  try {
    fileStream = fsSync.createReadStream(filePath);
  } catch {
    return transcript;
  }

  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    let entry: AnyRecord;
    try {
      entry = JSON.parse(line) as AnyRecord;
    } catch {
      continue;
    }

    const payload = readObjectRecord(entry.payload);
    if (!payload) {
      continue;
    }

    if (entry.type === 'session_meta') {
      // A resumed rollout writes a second, sparser session_meta; assigning
      // unconditionally would erase the identity the first one carried.
      transcript.nickname = readNonEmptyString(payload.agent_nickname) ?? transcript.nickname;
      transcript.agentPath = readNonEmptyString(payload.agent_path) ?? transcript.agentPath;
      continue;
    }

    if (entry.type === 'turn_context') {
      transcript.model = readNonEmptyString(payload.model) ?? transcript.model;
      continue;
    }

    if (entry.type !== 'event_msg' || payload.type !== 'item_completed') {
      continue;
    }

    const item = readCodexRolloutItem(payload.item);
    // The agent's own prompt is the task it was given, which the parent's
    // `Task` card already states; its lifecycle events belong to the parent.
    if (!item || item.kind === 'user_message' || item.kind === 'subagent_activity') {
      continue;
    }

    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
    for (const row of codexThreadItemToRows(item, timestamp ?? '')) {
      if (row.type === 'assistant' || row.type === 'thinking') {
        const content = String(row.message?.content ?? '').trim();
        if (content) {
          activity.push({ kind: row.type === 'thinking' ? 'thinking' : 'text', content, timestamp });
        }
        continue;
      }

      if (row.type === 'tool_use') {
        const record: SubagentActivity = {
          kind: 'tool',
          timestamp,
          toolId: String(row.toolCallId ?? ''),
          toolName: String(row.toolName ?? 'tool'),
          toolInput: row.toolInput,
        };
        activity.push(record);
        pendingResults.set(record.toolId as string, record);
        continue;
      }

      if (row.type === 'tool_result') {
        const target = pendingResults.get(String(row.toolCallId ?? ''));
        if (target) {
          target.toolResult = { content: String(row.output ?? ''), isError: Boolean(row.isError) };
        }
      }
    }
  }

  return transcript;
}

// ─── Transcript reader ──────────────────────────────────────────────────────

/**
 * Locates a Codex rollout JSONL by its session id under `~/.codex/sessions`.
 *
 * Codex partitions rollout files into date folders, so the lookup recurses;
 * the app row's indexed `jsonl_path` wins when it still exists (see
 * `getTokenUsage`). An unreadable branch is simply not a match.
 */
async function findCodexSessionFile(
  directoryPath: string,
  providerSessionId: string,
): Promise<string | null> {
  let entries;
  try {
    entries = await fsp.readdir(directoryPath, { withFileTypes: true });
  } catch {
    // Codex session folders are date-partitioned and can disappear while a
    // cleanup is running. An unreadable branch is simply not a match.
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = await findCodexSessionFile(entryPath, providerSessionId);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
      return entryPath;
    }
  }

  return null;
}

/**
 * Builds one Codex token-usage answer from a rollout `token_count.info` block.
 *
 * `last_token_usage` is the turn that just ran — the prompt the model actually
 * carried, i.e. what the context window holds. `total_token_usage` is the
 * session's cumulative spend; reporting it as `used` made the context
 * percentage climb with every turn, so it is preserved separately as
 * `cumulative` for the cost breakdown.
 */
function buildCodexTokenUsage(info: AnyRecord): ProviderTokenUsageResult {
  const last = readObjectRecord(info.last_token_usage);
  const cumulative = readObjectRecord(info.total_token_usage);

  const lastInputTokens = readUsageNumber(last?.input_tokens);
  const lastOutputTokens = readUsageNumber(last?.output_tokens);
  const cumulativeInputTokens = readUsageNumber(cumulative?.input_tokens);
  const cumulativeOutputTokens = readUsageNumber(cumulative?.output_tokens);
  const used = readUsageNumber(last?.total_tokens)
    || lastInputTokens + lastOutputTokens
    || readUsageNumber(cumulative?.total_tokens)
    || cumulativeInputTokens + cumulativeOutputTokens;

  return {
    used,
    total: readUsageNumber(info.model_context_window) || 200_000,
    inputTokens: lastInputTokens || cumulativeInputTokens,
    outputTokens: lastOutputTokens || cumulativeOutputTokens,
    breakdown: {
      input: lastInputTokens || cumulativeInputTokens,
      output: lastOutputTokens || cumulativeOutputTokens,
    },
    ...(cumulative
      ? {
          cumulative: {
            used: readUsageNumber(cumulative.total_tokens) || cumulativeInputTokens + cumulativeOutputTokens,
            inputTokens: cumulativeInputTokens,
            outputTokens: cumulativeOutputTokens,
          },
        }
      : {}),
  };
}

/**
 * Reads the latest `token_count` snapshot from a Codex rollout JSONL.
 *
 * Codex appends cumulative totals over time, so the scan walks from the end
 * and stops at the first readable token_count entry.
 */
function readCodexTokenUsage(fileContent: string): ProviderTokenUsageResult {
  const lines = fileContent.trim().split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;
      const tokenInfo = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
        ? entry.payload.info
        : null;
      if (tokenInfo) {
        return buildCodexTokenUsage(tokenInfo);
      }
    } catch {
      // A provider may be writing the last JSONL line while this read happens.
    }
  }

  return {
    used: 0,
    total: 200_000,
    inputTokens: 0,
    outputTokens: 0,
    breakdown: { input: 0, output: 0 },
  };
}

/**
 * Reads one Codex rollout file and produces the compact per-message records
 * `normalizeHistoryEntry` turns into `NormalizedMessage`s.
 *
 * Only the rollout's assembled view is read — the `event_msg` →
 * `item_completed` entries — never the raw `response_item` records beside
 * them. Both describe the same work, but only the items carry the id Codex
 * also puts on the live `app-server` notification, and the live run reads
 * those through the same `codexThreadItemToRows`. A row therefore has one
 * identity and one shape no matter which side produced it, which is what
 * stops a reply rendering once live and once again from history.
 *
 * Two records are read outside the item stream because nothing in it carries
 * them: `token_count` (the context budget) and a spawned agent's
 * `agent_message`, whose FINAL_ANSWER never becomes an item and is folded
 * into the result of the `Task` row that started the agent.
 */
async function getCodexSessionMessages(sessionId: string): Promise<CodexHistoryResult> {
  const sessionFilePath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

  if (!sessionFilePath) {
    console.warn(`Codex session file not found for session ${sessionId}`);
    return { messages: [], total: 0, hasMore: false };
  }

  const messages: AnyRecord[] = [];
  let tokenUsage: AnyRecord | null = null;

  const turns = createCodexTurnTracker();
  /** Turns whose prompt already carries the anchor, so only the first does. */
  const anchoredTurnIds = new Set<string>();

  /**
   * Every spawned agent's `Task` row, indexed by each handle it can later be
   * addressed by: the lifecycle event's own id, the agent's path, and the
   * thread id its transcript lives under.
   */
  const subagentsByCallId = new Map<string, CodexSubagentRecord>();
  const subagentsByPath = new Map<string, CodexSubagentRecord>();
  const subagentsByThread = new Map<string, CodexSubagentRecord>();

  const indexSubagent = (record: CodexSubagentRecord): void => {
    subagentsByCallId.set(record.toolCallId, record);
    if (record.agentPath) {
      subagentsByPath.set(record.agentPath, record);
    }
    if (record.agentThreadId) {
      subagentsByThread.set(record.agentThreadId, record);
    }
  };

  /** Settles a `Task` row; without a result the card renders as running forever. */
  const closeSubagent = (
    record: CodexSubagentRecord,
    timestamp: string,
    output: string,
    isError: boolean,
  ): void => {
    if (record.isComplete) {
      return;
    }
    record.isComplete = true;
    messages.push({
      uuid: `${record.toolCallId}_result`,
      type: 'tool_result',
      timestamp,
      toolCallId: record.toolCallId,
      output,
      isError,
    });
  };

  const fileStream = fsSync.createReadStream(sessionFilePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    let entry: AnyRecord;
    try {
      entry = JSON.parse(line) as AnyRecord;
    } catch {
      continue;
    }

    const payload = readObjectRecord(entry.payload);
    if (!payload) {
      continue;
    }
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString();

    // A turn is opened and closed by rows that produce no transcript entry of
    // their own, so the tracker sees every row before the branches below.
    turns.observe(entry.type, payload);

    if (entry.type === 'response_item') {
      // A spawned agent reports back as an `agent_message` addressed from its
      // path. The FINAL_ANSWER is the only part of a sub-agent's work that
      // never becomes an item, so it is read here and nowhere else.
      if (payload.type === 'agent_message') {
        const message = parseCodexSubagentMessage(payload);
        if (message?.messageType === 'FINAL_ANSWER' && message.result) {
          const record = subagentsByPath.get(message.author);
          if (record) {
            closeSubagent(record, timestamp, message.result, false);
          }
        }
      }
      continue;
    }

    if (entry.type !== 'event_msg') {
      continue;
    }

    if (payload.type === 'token_count' && payload.info) {
      const info = payload.info as AnyRecord;
      tokenUsage = buildCodexTokenUsage(info);
      continue;
    }

    if (payload.type === 'turn_aborted') {
      // An abort ends the whole agent tree — a spawned agent that never
      // reported back will receive no FINAL_ANSWER later in the file, so it
      // is settled here or its Task card renders as running forever. The
      // result is an error row: the agent did not finish its work.
      for (const record of subagentsByCallId.values()) {
        closeSubagent(record, timestamp, 'Subagent ended when the turn was interrupted.', true);
      }
      messages.push({
        // No item is written for an abort, so the row is named after the
        // append-only position the file itself records: reproducible across
        // reads, which is all a history-only row needs.
        uuid: typeof entry.ordinal === 'number' ? `ord_${entry.ordinal}` : `line_${messages.length}`,
        type: 'status_note',
        timestamp,
        content: payload.reason === 'interrupted'
          ? 'Turn interrupted'
          : `Turn aborted (${String(payload.reason ?? 'unknown')})`,
      });
      continue;
    }

    if (payload.type !== 'item_completed') {
      continue;
    }

    const item = readCodexRolloutItem(payload.item);
    if (!item) {
      continue;
    }

    if (item.kind === 'subagent_activity') {
      const existing = (item.agentThreadId ? subagentsByThread.get(item.agentThreadId) : undefined)
        ?? (item.agentPath ? subagentsByPath.get(item.agentPath) : undefined)
        ?? subagentsByCallId.get(item.id);

      if (item.activity === 'started' && !existing) {
        // The spawn itself reaches the item stream only as this lifecycle
        // event, so the `Task` row is built from it and keeps its id.
        const label = item.agentPath?.split('/').filter(Boolean).pop() ?? 'agent';
        const taskMessage: AnyRecord = {
          uuid: item.id,
          type: 'tool_use',
          timestamp,
          toolName: 'Task',
          toolInput: JSON.stringify({ description: humanizeCodexToolName(label) }),
          toolCallId: item.id,
        };
        messages.push(taskMessage);
        indexSubagent({
          toolCallId: item.id,
          message: taskMessage,
          agentPath: item.agentPath,
          agentThreadId: item.agentThreadId,
          isComplete: false,
        });
        continue;
      }

      if (!existing) {
        continue;
      }
      // Later events fill in the handles the first one did not carry.
      existing.agentPath = existing.agentPath ?? item.agentPath;
      existing.agentThreadId = existing.agentThreadId ?? item.agentThreadId;
      indexSubagent(existing);

      if (item.activity === 'interrupted') {
        closeSubagent(existing, timestamp, 'Subagent was interrupted before returning a final answer.', false);
      }
      continue;
    }

    const rows = codexThreadItemToRows(item, timestamp);

    if (item.kind === 'user_message') {
      // Only the first prompt of a turn is anchored. A turn can hold more than
      // one — a follow-up queued while the turn was running is written into it
      // — and the edit cut is per turn, so anchoring the second would quietly
      // take the first with it.
      const turnId = turns.getCurrentTurnId();
      if (turnId && !anchoredTurnIds.has(turnId) && rows.length > 0) {
        anchoredTurnIds.add(turnId);
        rows[0].turnId = turnId;
      }
    }

    if (item.kind === 'collab_spawn' && rows.length > 0) {
      indexSubagent({
        toolCallId: item.id,
        message: rows[0],
        isComplete: rows.length > 1,
      });
    }

    messages.push(...rows);
  }

  await attachCodexSubagentTranscripts(sessionFilePath, subagentsByCallId);

  // A rollback is recorded after the turns it retires, so a prompt can be
  // anchored and then retired later in the same file. Its rows still render —
  // they are what the conversation looked like — but the turn is gone from the
  // thread, so the anchor goes with it and the message loses its pencil.
  for (const message of messages) {
    if (typeof message.turnId === 'string' && turns.isRolledBack(message.turnId)) {
      delete message.turnId;
    }
  }

  messages.sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
  return { messages, tokenUsage: tokenUsage ?? undefined };
}

/**
 * Loads each spawned agent's own rollout and hangs its timeline off the
 * `Task` row that started it.
 */
async function attachCodexSubagentTranscripts(
  parentFilePath: string,
  subagentsByCallId: Map<string, CodexSubagentRecord>,
): Promise<void> {
  for (const record of subagentsByCallId.values()) {
    let parsedInput: AnyRecord = {};
    try {
      parsedInput = JSON.parse(String(record.message.toolInput || '{}')) as AnyRecord;
    } catch {
      parsedInput = {};
    }

    const agentName = record.agentPath?.split('/').filter(Boolean).pop();
    // Codex has no agent-type concept the way Claude does, so `type` is left
    // unset rather than filled with the provider's own name; the panel falls
    // back to a neutral label.
    const subagent: SubagentInfo = {
      id: record.agentThreadId ?? record.toolCallId,
      description: readNonEmptyString(parsedInput.description as string | undefined) ?? agentName,
      status: record.isComplete ? 'completed' : 'running',
    };

    if (record.agentThreadId) {
      const rolloutPath = await findCodexSubagentRollout(parentFilePath, record.agentThreadId);
      if (rolloutPath) {
        const transcript = await readCodexSubagentTranscript(rolloutPath);
        if (transcript.activity.length > 0) {
          record.message.subagentTools = transcript.activity
            .slice(0, MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)
            .map(truncateSubagentActivity);
          subagent.activityCount = transcript.activity.length;
        }
        subagent.name = transcript.nickname ?? agentName;
        subagent.model = transcript.model;
      }
    }

    subagent.name = subagent.name ?? agentName;
    record.message.subagent = subagent;
  }
}

export class CodexSessionsProvider implements IProviderSessions {
  /**
   * Resolves the last turn to keep when the turn `anchorId` names is replaced.
   *
   * `thread/fork`'s `lastTurnId` is inclusive of the turn it names, which is
   * the same thing this contract's `resumeThroughId` means, so the answer is
   * simply the turn before the edited one. Editing the first prompt leaves
   * nothing to keep, and `null` is how that is reported.
   */
  async resolveEditAnchor(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null }> {
    const session = sessionsDb.getSessionById(sessionId);
    const jsonlPath = session?.jsonl_path;
    if (!jsonlPath || !session?.provider_session_id) {
      return { found: false, resumeThroughId: null };
    }

    const liveTurnIds = await readCodexLiveTurnIds(jsonlPath);
    const anchorIndex = liveTurnIds.indexOf(anchorId);
    if (anchorIndex < 0) {
      return { found: false, resumeThroughId: null };
    }

    return {
      found: true,
      resumeThroughId: anchorIndex === 0 ? null : liveTurnIds[anchorIndex - 1],
    };
  }

  /**
   * Branches the conversation at `keepThroughId` and moves the session onto
   * the branch.
   *
   * Codex threads are append-only — the SDK resumes one at its tip and nothing
   * shortens it — so rewinding means copying the part being kept into a new
   * thread. The pre-edit thread stays on disk in full and is recorded as
   * superseded so the session indexer does not hand it back later.
   */
  async rewindSession(sessionId: string, keepThroughId: string | null): Promise<void> {
    const session = sessionsDb.getSessionById(sessionId);
    const supersededThreadId = session?.provider_session_id;
    if (!session || !supersededThreadId) {
      throw new AppError('This session has not produced a transcript yet.', {
        code: 'EDIT_SOURCE_NOT_READY',
        statusCode: 409,
      });
    }

    // Nothing of the conversation survives an edit to its first prompt, and
    // there is no such thing as a fork of no turns, so the session is simply
    // detached and the next run opens a new thread.
    if (keepThroughId === null) {
      sessionsDb.markProviderSessionSuperseded({
        providerSessionId: supersededThreadId,
        provider: PROVIDER,
        sessionId,
        jsonlPath: session.jsonl_path ?? null,
      });
      sessionsDb.detachProviderSession(sessionId);
      return;
    }

    const fork = await codexAppServer.forkThread({
      threadId: supersededThreadId,
      lastTurnId: keepThroughId,
      cwd: session.project_path ?? '',
    });

    sessionsDb.markProviderSessionSuperseded({
      providerSessionId: supersededThreadId,
      provider: PROVIDER,
      sessionId,
      jsonlPath: session.jsonl_path ?? null,
    });
    sessionsDb.repointSessionToProviderSession(sessionId, {
      providerSessionId: fork.threadId,
      jsonlPath: fork.path,
    });
  }

  /**
   * Normalizes a persisted Codex JSONL entry.
   *
   * Live Codex SDK events are transformed before they reach normalizeMessage(),
   * while history entries already use the compact message/tool shape produced
   * by getCodexSessionMessages().
   */
  private normalizeHistoryEntry(raw: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'status_note' && typeof raw.content === 'string') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'task_notification',
        summary: raw.content,
        status: 'info',
      })];
    }

    if (raw.type === 'thinking' || raw.isReasoning) {
      const thinkingContent = typeof raw.message?.content === 'string' ? raw.message.content : '';
      if (!thinkingContent.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: thinkingContent,
      })];
    }

    if (raw.message?.role === 'user') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
            .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
            .filter(Boolean)
            .join('\n')
          : String(raw.message.content || '');
      const parsedFiles = parseFilesInputTag(content);
      const rawImages = Array.isArray(raw.images) && raw.images.length > 0 ? raw.images : undefined;
      const files = parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined;
      if (!parsedFiles.text.trim() && !rawImages && !files) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content: parsedFiles.text,
        images: rawImages,
        files,
        // The enclosing turn, when the reader could name one. The row's own
        // id addresses the message; the turn is what an edit cuts at, and
        // only the reader knows which prompt opened one.
        transcriptAnchorId: readNonEmptyString(raw.turnId),
      })];
    }

    if (raw.message?.role === 'assistant') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
            .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
            .filter(Boolean)
            .join('\n')
          : '';
      if (!content.trim()) {
        return [];
      }
      // A proposed plan is a plan card, not an assistant paragraph that
      // happens to open with a tag. Leaving it to the client is what put a
      // provider-specific branch in a renderer shared by every provider.
      const proposedPlan = readCodexProposedPlan(content);
      if (proposedPlan) {
        return [createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: 'ExitPlanMode',
          toolInput: { plan: proposedPlan },
          toolId: baseId,
          memoryCitations: raw.memoryCitations,
        })];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content,
        memoryCitations: raw.memoryCitations,
      })];
    }

    if (raw.type === 'tool_use' || raw.toolName) {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName || 'Unknown',
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
        // A live row arrives while the call is still running; the client
        // renders the spinner off this and the completed row replaces it.
        status: raw.status,
        subagentTools: raw.subagentTools,
        subagent: raw.subagent,
        memoryCitations: raw.memoryCitations,
      })];
    }

    if (raw.type === 'tool_result') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: Boolean(raw.isError),
      })];
    }

    return [];
  }

  /**
   * Normalizes one Codex transcript row.
   *
   * Live frames and history rows arrive in the same vocabulary — both sides
   * build their rows with `codexThreadItemToRows` — so there is one branch
   * here, not one per transport. That is the property that keeps a row's
   * identity and shape the same whether it came off the wire or off disk.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'turn_complete') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'complete',
      })];
    }
    if (raw.type === 'turn_failed') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'error',
        content: raw.error?.message || 'Turn failed',
      })];
    }

    return this.normalizeHistoryEntry(raw, sessionId);
  }

  /**
   * Loads Codex JSONL history and keeps token usage metadata when the
   * transcript reported it.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    let result: CodexHistoryResult;
    try {
      result = await getCodexSessionMessages(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodexProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of result.messages) {
      normalized.push(...this.normalizeHistoryEntry(raw, sessionId));
    }

    const toolResultMap = new Map<string, NormalizedMessage>();
    for (const msg of normalized) {
      if (msg.kind === 'tool_result' && msg.toolId) {
        toolResultMap.set(msg.toolId, msg);
      }
    }
    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (toolResult) {
          msg.toolResult = { content: toolResult.content, isError: toolResult.isError };
        }
      }
    }

    // Everything the transcript draws, and nothing else — so a page of N rows
    // is N rows the user sees, and `total` counts the same thing.
    const transcript = prepareTranscriptMessages(normalized);
    const total = transcript.length;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(transcript, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      tokenUsage: result.tokenUsage,
    };
  }

  /**
   * Reads the token usage recorded in one Codex rollout JSONL.
   *
   * Consumer: the provider token-usage service. The app row's indexed
   * `jsonl_path` wins when it still exists; otherwise the rollout is located
   * by its provider-native session id under `~/.codex/sessions`. No readable
   * rollout is a 404.
   */
  async getTokenUsage(input: ProviderSessionUsageInput): Promise<ProviderTokenUsageResult> {
    const indexedFilePath = input.jsonlPath && fsSync.existsSync(input.jsonlPath)
      ? input.jsonlPath
      : null;
    const sessionFilePath = indexedFilePath ?? await findCodexSessionFile(
      path.join(os.homedir(), '.codex', 'sessions'),
      input.nativeSessionId,
    );

    if (!sessionFilePath) {
      throw new AppError(`Codex session file for "${input.appSessionId}" was not found.`, {
        code: 'CODEX_SESSION_FILE_NOT_FOUND',
        statusCode: 404,
      });
    }

    const fileContent = await fsp.readFile(sessionFilePath, 'utf8');
    return readCodexTokenUsage(fileContent);
  }

  /**
   * Cleans up Codex native storage (JSONL file).
   */
  async cleanupSession(_nativeSessionId: string, jsonlPath?: string | null): Promise<boolean> {
    let removed = false;
    if (jsonlPath) {
      if (await removePathIfExists(jsonlPath)) {
        removed = true;
      }
    }
    return removed;
  }
}
