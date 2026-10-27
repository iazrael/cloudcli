/**
 * The one vocabulary both Codex transports are read into.
 * ========================================================
 *
 * Codex describes a conversation twice. The rollout JSONL on disk holds the
 * raw Responses-API records (`response_item`: `custom_tool_call`, its output,
 * `function_call`, `message`) *and* an assembled view of the same work
 * (`event_msg` → `item_completed`, whose `item` is a `ThreadItem`). The
 * `app-server` transport streams that second view live as `item/started` and
 * `item/completed` notifications.
 *
 * Only the assembled view is read here, on both sides, and that is the whole
 * point: a `ThreadItem` carries the id Codex itself gave the work, and the
 * live notification and the persisted record carry *the same* id — verified
 * against real rollouts, down to `exec-<uuid>` on shell and patch items. Read
 * the raw records instead and the two sides have no id in common, which is how
 * one reply used to render twice.
 *
 * The two serializations of that one type disagree on spelling — the rollout
 * writes `CommandExecution` with snake_case fields and a `file://` cwd, the
 * app-server writes `commandExecution` with camelCase fields — so each gets a
 * reader, and both produce `CodexThreadItem`. Everything downstream of that
 * point is shared, so the live transcript and a later history read cannot
 * drift apart by construction.
 *
 * Consumers: `codex-sessions.provider.ts` (history read) and
 * `codex-runtime.provider.ts` (live run).
 */

import { liftMemoryCitations } from '@/modules/providers/shared/memory-citations.js';
import { toImageAttachments } from '@/shared/image-attachments.js';
import type { AnyRecord } from '@/shared/types.js';
import {
  compactProviderPayload,
  readObjectRecord,
  SUBAGENT_TOOL_NAME,
} from '@/shared/utils.js';

/**
 * Lifecycle of an item that does work. Both transports report the same four
 * states; `interrupted` only ever reaches a collaboration call.
 */
export type CodexItemStatus = 'in_progress' | 'completed' | 'failed' | 'declined' | 'interrupted';

/** One file touched by a patch, already reduced to the before/after pair the diff view renders. */
export type CodexItemFileChange = {
  filePath: string;
  changeType: 'add' | 'update' | 'delete';
  oldText: string;
  newText: string;
};

/**
 * One assembled Codex thread item.
 *
 * `id` is always Codex's own item id, never synthesized: it is the join key
 * between a live frame and the row a later history read returns.
 */
export type CodexThreadItem =
  | { kind: 'user_message'; id: string; text: string; images?: Array<{ path?: string; data?: string }> }
  | { kind: 'agent_message'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string }
  | {
    kind: 'command_execution';
    id: string;
    command: string;
    output: string;
    exitCode: number | null;
    status: CodexItemStatus;
  }
  | { kind: 'file_change'; id: string; changes: CodexItemFileChange[]; status: CodexItemStatus }
  | {
    kind: 'mcp_tool_call';
    id: string;
    server: string;
    tool: string;
    toolArguments: unknown;
    output: string;
    isError: boolean;
    status: CodexItemStatus;
  }
  | { kind: 'web_search'; id: string; query: string }
  | { kind: 'collab_spawn'; id: string; label: string; prompt?: string; status: CodexItemStatus; receiverThreadIds?: string[] }
  | {
    kind: 'subagent_activity';
    id: string;
    activity: 'started' | 'completed' | 'interrupted' | 'interacted';
    agentThreadId?: string;
    agentPath?: string;
  }
  | { kind: 'context_compaction'; id: string }
  | { kind: 'task_result'; id: string; name: string; output: string };

// ---------------------------
//----------------- ITEM READING ------------

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Normalizes the status spelling the two transports use.
 *
 * The rollout writes `in_progress`, the app-server `inProgress`. Anything
 * unrecognized is reported as completed rather than leaving a row spinning
 * forever on a status nobody here has seen.
 */
function readItemStatus(value: unknown): CodexItemStatus {
  switch (value) {
    case 'in_progress':
    case 'inProgress':
      return 'in_progress';
    case 'failed':
      return 'failed';
    case 'declined':
      return 'declined';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'completed';
  }
}

/**
 * The text of a Codex content array, whichever of the three part spellings it
 * uses (`Text` in the rollout's items, `input_text`/`output_text` in the raw
 * records, `text` in the app-server's user input).
 */
export function readCodexItemText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      const record = readObjectRecord(part);
      return record && typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * The command a shell item ran, without the shell that wrapped it.
 *
 * Codex reports the invocation — `["/bin/zsh", "-lc", "<cmd>"]` on the rollout,
 * `"/bin/zsh -lc '<cmd>'"` on the app-server — while the card shows the command
 * itself. Both wrappers come off here so the two sides spell one call the same
 * way.
 */
export function readCodexCommandLine(value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string');
    const shellFlagIndex = parts.findIndex((part) => part === '-lc' || part === '-c');
    return shellFlagIndex >= 0 && shellFlagIndex + 1 < parts.length
      ? parts.slice(shellFlagIndex + 1).join(' ')
      : parts.join(' ');
  }

  if (typeof value !== 'string') {
    return '';
  }

  const wrapped = value.match(/^\S*(?:sh|bash|zsh)\s+-l?c\s+([\s\S]+)$/);
  if (!wrapped) {
    return value;
  }
  const command = wrapped[1].trim();
  // The shell payload is usually quoted as one argument; unwrap a balanced
  // pair rather than stripping quotes that belong to the command itself.
  const quoted = command.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2] : command;
}

/**
 * Rebuilds the before/after text of one unified diff.
 *
 * Only the hunks are available — never the whole file — so the reconstruction
 * keeps context lines on both sides and drops hunk headers. Feeding that pair
 * to the frontend's line differ reproduces exactly the additions, removals and
 * surrounding context the patch described, which is what an `Edit` row shows.
 *
 * Consumer: this module's file-change readers, and `codex-sessions.test.ts`.
 */
export function unifiedDiffToTexts(unifiedDiff: string): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\ No newline')) {
      continue;
    }
    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
      continue;
    }
    const contextLine = line.startsWith(' ') ? line.slice(1) : line;
    oldLines.push(contextLine);
    newLines.push(contextLine);
  }

  // A unified diff ends with a newline, which would otherwise reconstruct as a
  // phantom trailing blank line on both sides.
  if (oldLines[oldLines.length - 1] === '' && newLines[newLines.length - 1] === '') {
    oldLines.pop();
    newLines.pop();
  }

  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

/** Builds the before/after pair for one file from whichever body the transport supplied. */
function toFileChange(filePath: string, changeType: string | undefined, body: string): CodexItemFileChange {
  const kind = changeType === 'add' || changeType === 'delete' ? changeType : 'update';
  if (kind === 'add') {
    return { filePath, changeType: 'add', oldText: '', newText: body };
  }
  if (kind === 'delete') {
    return { filePath, changeType: 'delete', oldText: body, newText: '' };
  }
  const { oldText, newText } = unifiedDiffToTexts(body);
  return { filePath, changeType: 'update', oldText, newText };
}

/** Strips the `file://` wrapper the rollout puts on paths; other spellings pass through. */
function readItemPath(value: unknown): string {
  const raw = readNonEmptyString(value);
  if (!raw) {
    return '';
  }
  if (!raw.startsWith('file://')) {
    return raw;
  }
  try {
    return decodeURIComponent(new URL(raw).pathname);
  } catch {
    return raw.slice('file://'.length);
  }
}

/** The display name for a spawned agent, from whichever receiver list the transport carries. */
function readCollabAgentLabel(item: AnyRecord): string {
  const lastSegment = (value: string): string => value.split('/').filter(Boolean).pop() ?? value;
  const candidates = [
    ...(Array.isArray(item.receiver_agents) ? item.receiver_agents : []),
    ...(Array.isArray(item.receiverAgents) ? item.receiverAgents : []),
    ...Object.keys(readObjectRecord(item.agents_states) ?? readObjectRecord(item.agentsStates) ?? {}),
  ];

  for (const entry of candidates) {
    if (typeof entry === 'string' && entry.trim()) {
      return lastSegment(entry.trim());
    }
    const record = readObjectRecord(entry);
    const nickname = record
      ? readNonEmptyString(record.agent_nickname) ?? readNonEmptyString(record.nickname)
      : undefined;
    if (nickname) {
      return lastSegment(nickname);
    }
    const agentPath = record ? readNonEmptyString(record.agent_path) ?? readNonEmptyString(record.agentPath) : undefined;
    if (agentPath) {
      return lastSegment(agentPath);
    }
  }
  return 'agent';
}

function readCollabReceiverThreadIds(item: AnyRecord): string[] {
  const ids = item.receiver_thread_ids ?? item.receiverThreadIds;
  const agents = item.receiver_agents ?? item.receiverAgents;
  const candidates = [
    ...(Array.isArray(ids) ? ids : []),
    ...(Array.isArray(agents) ? agents.map((agent: unknown) => {
      const record = readObjectRecord(agent);
      return record?.thread_id ?? record?.threadId;
    }) : []),
    ...Object.keys(readObjectRecord(item.agents_states) ?? readObjectRecord(item.agentsStates) ?? {}),
  ];
  return [...new Set(candidates.map(readNonEmptyString).filter((id): id is string => Boolean(id)))];
}

/**
 * Whether a collaboration call is a spawn — `spawn_agent` in the rollout,
 * `spawnAgent` on the app-server.
 *
 * Everything else the collaboration tool emits (`wait`, `send_message`,
 * `list_agents`, …) is how the agent orchestrates itself, not work the user
 * asked for, so it never becomes a row.
 */
function isCollabSpawn(tool: string): boolean {
  return tool === 'spawn_agent' || tool === 'spawnAgent';
}

/** Reads the image attachments a user message carries, in either transport's spelling. */
function readUserImages(item: AnyRecord): Array<{ path?: string; data?: string }> | undefined {
  const attachments: Array<{ path?: string; data?: string }> = [];

  // The rollout's own `user_message` event lists them separately; an item's
  // `content` carries them as typed input parts.
  const flat = [
    ...(Array.isArray(item.local_images) ? item.local_images : []),
    ...(Array.isArray(item.images) ? item.images : []),
  ];
  for (const entry of flat) {
    if (typeof entry !== 'string' || !entry.trim()) {
      continue;
    }
    if (entry.startsWith('data:')) {
      attachments.push({ data: entry });
    } else {
      attachments.push(...toImageAttachments([entry]));
    }
  }

  for (const part of Array.isArray(item.content) ? item.content : []) {
    const record = readObjectRecord(part);
    if (!record) {
      continue;
    }
    const localPath = record.type === 'localImage' || record.type === 'local_image'
      ? readNonEmptyString(record.path)
      : undefined;
    if (localPath) {
      attachments.push(...toImageAttachments([localPath]));
      continue;
    }
    const url = record.type === 'image' ? readNonEmptyString(record.url) : undefined;
    if (url) {
      attachments.push(url.startsWith('data:') ? { data: url } : { path: url });
    }
  }

  return attachments.length > 0 ? attachments : undefined;
}

/**
 * Reads one `item_completed` item out of a Codex rollout.
 *
 * Consumer: the history reader in `codex-sessions.provider.ts`.
 */
export function readCodexRolloutItem(raw: unknown): CodexThreadItem | null {
  const item = readObjectRecord(compactProviderPayload(raw));
  const id = item ? readNonEmptyString(item.id) : undefined;
  if (!item || !id) {
    return null;
  }

  switch (item.type) {
    case 'UserMessage':
      return { kind: 'user_message', id, text: readCodexItemText(item.content), images: readUserImages(item) };

    case 'AgentMessage':
      return { kind: 'agent_message', id, text: readCodexItemText(item.content) };

    case 'Reasoning': {
      const summary = Array.isArray(item.summary_text) ? item.summary_text : [];
      const content = Array.isArray(item.raw_content) ? item.raw_content : [];
      const text = (summary.length > 0 ? summary : content)
        .map((part: unknown) => (typeof part === 'string' ? part : readCodexItemText(part)))
        .filter(Boolean)
        .join('\n');
      return { kind: 'reasoning', id, text };
    }

    case 'CommandExecution':
      return {
        kind: 'command_execution',
        id,
        command: readCodexCommandLine(item.command),
        output: typeof item.aggregated_output === 'string' ? item.aggregated_output : '',
        exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        status: readItemStatus(item.status),
      };

    case 'FileChange': {
      // The rollout keys the changes by path; the app-server sends a list.
      const record = readObjectRecord(item.changes) ?? {};
      const changes: CodexItemFileChange[] = [];
      for (const [filePath, rawChange] of Object.entries(record)) {
        const change = readObjectRecord(rawChange);
        if (!change) {
          continue;
        }
        const body = readNonEmptyString(change.unified_diff) ?? readNonEmptyString(change.content) ?? '';
        changes.push(toFileChange(filePath, readNonEmptyString(change.type), body));
      }
      return { kind: 'file_change', id, changes, status: readItemStatus(item.status) };
    }

    case 'McpToolCall': {
      const error = readObjectRecord(item.error);
      const status = readItemStatus(item.status);
      return {
        kind: 'mcp_tool_call',
        id,
        server: readNonEmptyString(item.server) ?? '',
        tool: readNonEmptyString(item.tool) ?? 'tool',
        toolArguments: item.arguments,
        // A tool that returned nothing has no output, not the two characters
        // `JSON.stringify('')` would put on the card.
        output: error ? String(error.message ?? '') : item.result == null ? '' : JSON.stringify(item.result),
        isError: Boolean(error) || status === 'failed',
        status,
      };
    }

    case 'WebSearch':
      return { kind: 'web_search', id, query: readNonEmptyString(item.query) ?? '' };

    case 'Extension':
      // Web search reaches recent rollouts as a generic extension item.
      return item.kind === 'web.search'
        ? { kind: 'web_search', id, query: readNonEmptyString(item.query) ?? '' }
        : null;

    case 'CollabAgentToolCall': {
      const tool = readNonEmptyString(item.tool) ?? '';
      if (!isCollabSpawn(tool)) {
        return null;
      }
      const prompt = readNonEmptyString(item.prompt);
      return {
        kind: 'collab_spawn',
        id,
        label: readCollabAgentLabel(item),
        prompt,
        status: readItemStatus(item.status),
        receiverThreadIds: readCollabReceiverThreadIds(item),
      };
    }

    case 'SubAgentActivity':
      return {
        kind: 'subagent_activity',
        id,
        activity: readSubagentActivityKind(item.kind),
        agentThreadId: readNonEmptyString(item.agent_thread_id),
        agentPath: readNonEmptyString(item.agent_path),
      };

    case 'ContextCompaction':
      return { kind: 'context_compaction', id };

    case 'FunctionCallOutput': {
      const name = readNonEmptyString(item.name) ?? '';
      if (name !== 'cloudcli_task_result') return null;
      const rawOutput = item.output;
      const output = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput ?? '');
      return { kind: 'task_result', id, name, output };
    }

    default:
      return null;
  }
}

function readSubagentActivityKind(value: unknown): 'started' | 'completed' | 'interrupted' | 'interacted' {
  return value === 'started' || value === 'interrupted' || value === 'interacted' ? value : 'completed';
}

/**
 * Reads one `item/started` or `item/completed` item off the app-server stream.
 *
 * Consumer: the live run loop in `codex-runtime.provider.ts`.
 */
export function readCodexAppServerItem(raw: unknown): CodexThreadItem | null {
  const item = readObjectRecord(compactProviderPayload(raw));
  const id = item ? readNonEmptyString(item.id) : undefined;
  if (!item || !id) {
    return null;
  }

  switch (item.type) {
    case 'userMessage':
      return { kind: 'user_message', id, text: readCodexItemText(item.content), images: readUserImages(item) };

    case 'agentMessage':
      return { kind: 'agent_message', id, text: typeof item.text === 'string' ? item.text : '' };

    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const content = Array.isArray(item.content) ? item.content : [];
      const text = (summary.length > 0 ? summary : content)
        .map((part: unknown) => (typeof part === 'string' ? part : readCodexItemText(part)))
        .filter(Boolean)
        .join('\n');
      return { kind: 'reasoning', id, text };
    }

    case 'commandExecution':
      return {
        kind: 'command_execution',
        id,
        command: readCodexCommandLine(item.command),
        output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '',
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
        status: readItemStatus(item.status),
      };

    case 'fileChange': {
      const changes: CodexItemFileChange[] = [];
      for (const rawChange of Array.isArray(item.changes) ? item.changes : []) {
        const change = readObjectRecord(rawChange);
        if (!change) {
          continue;
        }
        // `kind` is a tagged union here (`{type: "add"}`) but a bare string on
        // older servers; both spellings are accepted.
        const changeType = readNonEmptyString(readObjectRecord(change.kind)?.type)
          ?? readNonEmptyString(change.kind);
        changes.push(toFileChange(
          readItemPath(change.path),
          changeType,
          typeof change.diff === 'string' ? change.diff : '',
        ));
      }
      return { kind: 'file_change', id, changes, status: readItemStatus(item.status) };
    }

    case 'mcpToolCall': {
      const error = readObjectRecord(item.error);
      const status = readItemStatus(item.status);
      return {
        kind: 'mcp_tool_call',
        id,
        server: readNonEmptyString(item.server) ?? '',
        tool: readNonEmptyString(item.tool) ?? 'tool',
        toolArguments: item.arguments,
        // A tool that returned nothing has no output, not the two characters
        // `JSON.stringify('')` would put on the card.
        output: error ? String(error.message ?? '') : item.result == null ? '' : JSON.stringify(item.result),
        isError: Boolean(error) || status === 'failed',
        status,
      };
    }

    case 'webSearch':
      return { kind: 'web_search', id, query: readNonEmptyString(item.query) ?? '' };

    case 'collabAgentToolCall': {
      const tool = readNonEmptyString(item.tool) ?? '';
      if (!isCollabSpawn(tool)) {
        return null;
      }
      return {
        kind: 'collab_spawn',
        id,
        label: readCollabAgentLabel(item),
        prompt: readNonEmptyString(item.prompt),
        status: readItemStatus(item.status),
        receiverThreadIds: readCollabReceiverThreadIds(item),
      };
    }

    case 'subAgentActivity':
      return {
        kind: 'subagent_activity',
        id,
        activity: readSubagentActivityKind(item.kind),
        agentThreadId: readNonEmptyString(item.agentThreadId),
        agentPath: readNonEmptyString(item.agentPath),
      };

    case 'contextCompaction':
      return { kind: 'context_compaction', id };

    case 'functionCallOutput': {
      const name = readNonEmptyString(item.name) ?? '';
      if (name !== 'cloudcli_task_result') return null;
      const rawOutput = item.output;
      const output = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput ?? '');
      return { kind: 'task_result', id, name, output };
    }

    default:
      return null;
  }
}

// ---------------------------
//----------------- ROW RENDERING ------------

/**
 * Reads the markdown out of Codex's `<proposed_plan>` envelope.
 *
 * Codex delivers a plan as a wrapped assistant message while Claude delivers
 * one as an `ExitPlanMode` call. Recognizing the envelope here lets both end
 * up on the same plan card instead of one provider showing a card and the
 * other prose with a stray tag in it. The closing tag is optional because a
 * streamed plan exposes the opening tag first.
 *
 * Consumer: this module's renderer, and `codex-sessions.test.ts`.
 */
export function readCodexProposedPlan(text: string): string | null {
  const openingTag = /^\s*<proposed_plan>[ \t]*(?:\r?\n)?/i;
  if (!openingTag.test(text)) {
    return null;
  }

  const body = text
    .replace(openingTag, '')
    .replace(/(?:\r?\n)?[ \t]*<\/proposed_plan>\s*$/i, '')
    .trim();

  return body || null;
}

/**
 * Turns a tool name into the label the transcript shows.
 *
 * Consumer: this module's renderer and `readCodexSubagentLabel`.
 */
export function humanizeCodexToolName(toolName: string): string {
  return toolName
    .replace(/__/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * The name a spawned agent shows under, from the last segment of its agent
 * path (`/root/standards` → "Standards"). The engine assigns no other label
 * to an agent announced only through its activity record.
 *
 * Consumers: `buildCodexSubagentAgentRow` and the codex runtime's
 * background-work entries.
 */
export function readCodexSubagentLabel(item: { agentPath?: string }): string {
  return humanizeCodexToolName(item.agentPath?.split('/').filter(Boolean).pop() ?? 'agent');
}

/**
 * The `Agent` row for an agent whose only announcement is its activity
 * record. Real engines never send a spawn tool-call item — every recorded
 * collab tool call is a `wait` — so the row is built from the `started`
 * activity and keeps that item's id as its call id; the agent's later
 * activity pairs with it through the thread id, not the item id.
 *
 * Consumers: codex history (rollout replay) and the codex runtime (live
 * stream), so a reload rebuilds exactly the card the stream drew.
 */
export function buildCodexSubagentAgentRow(item: { id: string; agentPath?: string }, timestamp: string): AnyRecord {
  return {
    uuid: item.id,
    type: 'tool_use',
    timestamp,
    toolName: SUBAGENT_TOOL_NAME,
    toolInput: JSON.stringify({ description: readCodexSubagentLabel(item) }),
    toolCallId: item.id,
  };
}

/**
 * The transcript rows one item produces, in the compact shape
 * `CodexSessionsProvider.normalizeMessage` consumes.
 *
 * Every row id is derived from the item's own id, so the same item read from
 * either transport produces the same ids — that is the property this module
 * exists to guarantee. Multi-row items (a patch touching several files, a call
 * and its result) suffix the item id rather than inventing new ones.
 *
 * `turnId` is set only on the row that anchors a turn; the caller owns that
 * decision because only it knows which prompt opened the turn.
 *
 * Consumers: the history reader and the live run loop.
 */
export function codexThreadItemToRows(item: CodexThreadItem, timestamp: string): AnyRecord[] {
  switch (item.kind) {
    case 'user_message': {
      if (!item.text.trim() && !item.images) {
        return [];
      }
      return [{
        uuid: item.id,
        type: 'user',
        timestamp,
        message: { role: 'user', content: item.text },
        ...(item.images ? { images: item.images } : {}),
      }];
    }

    case 'agent_message': {
      const cited = liftMemoryCitations('codex', item.text);
      if (!cited.text.trim()) {
        return [];
      }
      const proposedPlan = readCodexProposedPlan(cited.text);
      if (proposedPlan) {
        // A proposed plan is a plan card, not an assistant paragraph that
        // happens to open with a tag.
        return [{
          uuid: item.id,
          type: 'tool_use',
          timestamp,
          toolName: 'ExitPlanMode',
          toolInput: { plan: proposedPlan },
          toolCallId: item.id,
          memoryCitations: cited.memoryCitations,
        }];
      }
      return [{
        uuid: item.id,
        type: 'assistant',
        timestamp,
        message: { role: 'assistant', content: cited.text },
        memoryCitations: cited.memoryCitations,
      }];
    }

    case 'reasoning':
      return item.text.trim()
        ? [{ uuid: item.id, type: 'thinking', timestamp, message: { role: 'assistant', content: item.text } }]
        : [];

    case 'command_execution': {
      const rows: AnyRecord[] = [{
        uuid: item.id,
        type: 'tool_use',
        timestamp,
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: item.command }),
        toolCallId: item.id,
        status: item.status,
      }];
      // A running command with nothing captured yet has no result to pair:
      // emitting an empty one would close the card before it finished.
      if (item.status === 'in_progress' && !item.output) {
        return rows;
      }
      rows.push({
        uuid: `${item.id}_result`,
        type: 'tool_result',
        timestamp,
        toolCallId: item.id,
        output: item.output,
        isError: item.status === 'failed' || (item.exitCode !== null && item.exitCode !== 0),
      });
      return rows;
    }

    case 'file_change': {
      // One row per file so each change gets the same diff view as an Edit.
      const rows: AnyRecord[] = [];
      for (const [index, change] of item.changes.entries()) {
        const toolCallId = `${item.id}_${index}`;
        rows.push({
          uuid: toolCallId,
          type: 'tool_use',
          timestamp,
          toolName: change.changeType === 'add' ? 'Write' : 'Edit',
          toolInput: JSON.stringify({
            file_path: change.filePath,
            old_string: change.oldText,
            new_string: change.newText,
            ...(change.changeType === 'delete' ? { deleted: true } : {}),
          }),
          toolCallId,
          status: item.status,
        });
        if (item.status !== 'in_progress') {
          rows.push({
            uuid: `${toolCallId}_result`,
            type: 'tool_result',
            timestamp,
            toolCallId,
            output: item.status === 'completed' ? '' : `Patch ${item.status}`,
            isError: item.status === 'failed',
          });
        }
      }
      return rows;
    }

    case 'mcp_tool_call': {
      const toolName = item.server ? `mcp__${item.server}__${item.tool}` : item.tool;
      const rows: AnyRecord[] = [{
        uuid: item.id,
        type: 'tool_use',
        timestamp,
        toolName,
        toolInput: item.toolArguments,
        toolCallId: item.id,
        status: item.status,
      }];
      if (item.status === 'in_progress') {
        return rows;
      }
      rows.push({
        uuid: `${item.id}_result`,
        type: 'tool_result',
        timestamp,
        toolCallId: item.id,
        output: item.output,
        isError: item.isError,
      });
      return rows;
    }

    case 'web_search':
      return [{
        uuid: item.id,
        type: 'tool_use',
        timestamp,
        toolName: 'WebSearch',
        toolInput: JSON.stringify({ query: item.query }),
        toolCallId: item.id,
      }];

    case 'collab_spawn': {
      if ((item.receiverThreadIds?.length ?? 0) > 1) {
        return item.receiverThreadIds!.flatMap((threadId) => codexThreadItemToRows({
          ...item, id: `${item.id}:${threadId}`, receiverThreadIds: [threadId],
        }, timestamp));
      }
      const rows: AnyRecord[] = [{
        uuid: item.id,
        type: 'tool_use',
        timestamp,
        toolName: SUBAGENT_TOOL_NAME,
        // No `subagent_type`: Codex has no agent presets, and naming the
        // provider there would render as "Codex / Codex" in the transcript.
        toolInput: JSON.stringify({
          description: humanizeCodexToolName(item.label),
          // On collaboration spawns the prompt can be an encrypted transport
          // blob — only surface readable text.
          ...(item.prompt && !/^gAAAAA/.test(item.prompt) ? { prompt: item.prompt } : {}),
        }),
        toolCallId: item.id,
        status: item.status === 'completed' ? 'in_progress' : item.status,
      }];
      if (item.status === 'in_progress') {
        return rows;
      }
      if (item.status === 'completed') {
        rows.push({ uuid: `${item.id}_result`, type: 'tool_result', timestamp, toolCallId: item.id,
          output: '', toolUseResult: { isAsync: true, agentId: item.receiverThreadIds?.[0] } });
        return rows;
      }
      const outcome = item.status === 'failed'
        ? 'failed'
        : item.status === 'interrupted' ? 'was interrupted' : 'finished';
      rows.push({
        uuid: `${item.id}_result`,
        type: 'tool_result',
        timestamp,
        toolCallId: item.id,
        output: `Subagent ${humanizeCodexToolName(item.label)} ${outcome}`,
        isError: item.status === 'failed',
      });
      return rows;
    }

    case 'subagent_activity':
      // Lifecycle only: the caller turns a `started` into the Agent row and a
      // `completed` into its result, because only it can pair them across the
      // thread id they share.
      return [];

    case 'context_compaction':
      // The shared compaction row; the live loop adds `phase: 'running'`
      // while the item is still working.
      return [{ uuid: item.id, type: 'compaction', timestamp }];

    case 'task_result': {
      let parsedOutput: AnyRecord = {};
      try {
        parsedOutput = typeof item.output === 'string' ? JSON.parse(item.output) : (item.output ?? {});
      } catch {
        parsedOutput = { summary: item.output };
      }
      const summary = typeof parsedOutput.summary === 'string' && parsedOutput.summary.trim()
        ? parsedOutput.summary
        : '异步任务结果已投递';
      return [{
        uuid: item.id,
        type: 'status_note',
        timestamp,
        content: summary,
        taskContinuation: parsedOutput,
      }];
    }
  }
}
