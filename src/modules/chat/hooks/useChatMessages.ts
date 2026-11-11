/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '@/modules/chat/hooks/useSessionStore';
import type { ChatMessage, LiveTaskStatus, SubagentActivity } from '@/shared/types';
import { formatUsageLimitText } from '@/modules/chat/utils/chatFormatting';
import { isSubagentToolName } from '@shared/protocol/subagent';

function formatToolResultContent(content: unknown): string {
  // JSON.stringify(undefined) returns undefined (not a string), so guard the
  // non-string branch too — a toolResult row without content must render as
  // empty text instead of crashing the whole chat interface.
  if (content === undefined || content === null) {
    return '';
  }
  const text = typeof content === 'string' ? content : JSON.stringify(content) ?? '';
  const toolUseErrorMatch = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  return toolUseErrorMatch ? toolUseErrorMatch[1] : text;
}

type ParsedTaskNotification = {
  status: string;
  summary: string;
  result: string;
};

/**
 * Parses a background-agent `<task-notification>` block.
 *
 * The harness injects these as user-role messages when a background task stops.
 * Newer notifications carry extra fields (`<tool-use-id>`, `<note>`, `<usage>`,
 * and a `<result>` markdown payload) that the previous single-shot regex could
 * not match, so the whole raw XML block leaked through as plain user text.
 * Fields are extracted independently so the block renders as an assistant
 * notification plus, when present, the agent's markdown result.
 */
function parseTaskNotification(content: string): ParsedTaskNotification | null {
  if (!content.trimStart().startsWith('<task-notification>')) {
    return null;
  }

  const statusMatch = /<status>([\s\S]*?)<\/status>/.exec(content);
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(content);

  let result = '';
  const resultOpen = content.indexOf('<result>');
  if (resultOpen !== -1) {
    const afterOpen = content.slice(resultOpen + '<result>'.length);
    const closeIndex = afterOpen.indexOf('</result>');
    result =
      closeIndex === -1
        ? afterOpen.replace(/<\/task-notification>\s*$/, '').trim()
        : afterOpen.slice(0, closeIndex).trim();
  }

  return {
    status: statusMatch?.[1]?.trim() || 'completed',
    summary: summaryMatch?.[1]?.trim() || 'Background task finished',
    result,
  };
}

/** Kinds of live row that can belong to a subagent's card. */
const CHILD_ROW_KINDS: ReadonlySet<string> = new Set(['tool_use', 'tool_result', 'text', 'thinking', 'stream_delta', 'stream_end']);

const NO_CHILD_ROWS: NormalizedMessage[] = [];

/**
 * The top-level subagent card a row's `parentToolUseId` leads to: the
 * outermost `Agent` call on its parent chain, whatever non-agent calls sit above
 * it. `null` when the chain reaches no agent call and ends at a call this
 * transcript does not hold (the card has not arrived); `undefined` when it
 * reaches a known call that is not an agent (Bash, a workflow). A cycle is cut
 * where it closes, so its members stay cards.
 */
function resolveParentCard(
  parentId: string,
  toolCallById: Map<string, NormalizedMessage>,
): string | null | undefined {
  let current: string | undefined = parentId;
  let outermost: string | undefined;
  let reachedKnownCall = false;
  const visited = new Set<string>();
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const call = toolCallById.get(current);
    if (!call) break;
    reachedKnownCall = true;
    if (isSubagentToolName(call.toolName)) outermost = current;
    current = call.parentToolUseId;
  }
  if (outermost !== undefined) return outermost;
  return reachedKnownCall ? undefined : null;
}

function sameRows(a: NormalizedMessage[], b: NormalizedMessage[]): boolean {
  return a.length === b.length && a.every((row, index) => Object.is(row, b[index]));
}

/**
 * The timeline of a running agent, from the rows its stream delivered: the
 * same shape the history reader gives a finished one, so a card reads the same
 * live and after a refresh.
 */
function buildLiveActivity(rows: NormalizedMessage[], toolResultMap: Map<string, NormalizedMessage>): SubagentActivity[] {
  const activity: SubagentActivity[] = [];
  for (const row of rows) {
    if (row.kind === 'tool_use') {
      const result = row.toolResult ?? (row.toolId ? toolResultMap.get(row.toolId) : undefined);
      activity.push({
        kind: 'tool',
        timestamp: row.timestamp,
        toolId: row.toolId,
        toolName: row.toolName,
        toolInput: row.toolInput,
        toolResult: result ? { content: formatToolResultContent(result.content), isError: Boolean(result.isError) } : null,
      });
    } else if (row.kind === 'text' && row.role !== 'user' && row.content?.trim()) {
      activity.push({ kind: 'text', timestamp: row.timestamp, content: row.content });
    } else if (row.kind === 'thinking' && row.content?.trim()) {
      activity.push({ kind: 'thinking', timestamp: row.timestamp, content: row.content });
    }
  }
  return activity;
}

/**
 * A card's timeline: the history record when the row carries one, else the
 * live rows. A resumed agent ran again after that record was written, so its
 * live rows follow the record instead of being hidden behind it.
 */
function buildSubagentActivity(
  msg: NormalizedMessage,
  taskStatus: LiveTaskStatus | undefined,
  foldedChildRows: NormalizedMessage[],
  toolResultMap: Map<string, NormalizedMessage>,
): SubagentActivity[] | undefined {
  const live = foldedChildRows.length > 0 ? buildLiveActivity(foldedChildRows, toolResultMap) : undefined;
  if (!msg.subagentTools?.length) {
    return live;
  }
  return taskStatus?.resumed && live ? [...msg.subagentTools, ...live] : msg.subagentTools;
}

/**
 * Per-row conversion cache. Conversion output for one NormalizedMessage is a
 * pure function of the row itself plus, for tool_use rows, the attached
 * tool_result row object. Caching by row identity means a store update that
 * only replaced some rows (a streaming delta, one changed tool result) leaves
 * every other ChatMessage reference intact, so MessageComponent's React.memo
 * and the markdown parse below it survive.
 */
type ConversionCacheEntry = {
  /** Identity of whatever tool-result source fed this row's conversion. */
  attachedToolResult: unknown;
  /** The live child rows folded into a subagent card, compared element by element. */
  foldedChildRows: NormalizedMessage[];
  /** The result each folded child tool call had when this entry was built. */
  foldedResults?: Map<NormalizedMessage, NormalizedMessage | undefined>;
  /** Newest live task-status row folded into this row's projection, when any. */
  taskStatusSource: NormalizedMessage | null;
  outputs: ChatMessage[];
};

const conversionCache = new WeakMap<NormalizedMessage, ConversionCacheEntry>();

/**
 * Folds one live `task_status` event into the per-tool-call background-task
 * state. Events arrive in order, so each one overwrites what it knows and
 * keeps the rest: a `progress` event carries usage but not the workflow name
 * the `started` event announced. `updated` names only the task id, so the id
 * is remembered from the first event that paired it with its tool call; an
 * event that cannot be tied to a call — an ambient task — has no card and is
 * dropped.
 */
function foldTaskStatus(
  msg: NormalizedMessage,
  liveTasksByToolUseId: Map<string, LiveTaskStatus>,
  toolUseIdByTaskId: Map<string, string>,
  lastTaskSourceByToolUseId: Map<string, NormalizedMessage>,
): void {
  if (msg.taskId && msg.toolUseId) {
    toolUseIdByTaskId.set(msg.taskId, msg.toolUseId);
  }
  const toolUseId = msg.toolUseId ?? (msg.taskId ? toolUseIdByTaskId.get(msg.taskId) : undefined);
  if (!toolUseId) {
    return;
  }

  const previous = liveTasksByToolUseId.get(toolUseId);
  const settled = msg.status === 'completed' || msg.status === 'failed' || msg.status === 'stopped'
    ? msg.status
    : null;
  // A workflow's first progress events report on no agents yet; an empty list
  // must not wipe the last one that named them.
  const agents = msg.agents?.length ? msg.agents : previous?.agents;
  liveTasksByToolUseId.set(toolUseId, {
    // A settled status holds against `progress` and `updated`, but a later
    // `started` revives the task: ZCode re-announces a resumed agent with
    // `resumed: true`, and that card must run again. Short of a settled
    // status, `started` and `progress` mean the task is running, while an `updated` patch that does not change the
    // status (an end time, say) leaves it where it was.
    status: settled ?? (msg.event === 'started' || msg.event === 'progress' ? 'running' : previous?.status ?? 'running'),
    taskId: msg.taskId ?? previous?.taskId,
    taskType: msg.taskType ?? previous?.taskType,
    workflowName: msg.workflowName ?? previous?.workflowName,
    description: msg.description ?? previous?.description,
    summary: msg.summary ?? previous?.summary,
    usage: msg.usage ?? previous?.usage,
    ...(agents ? { agents } : {}),
    // A resume's `started` marks the run as newer than any settled history
    // record; a fresh `started` clears that, the run's later events keep it.
    ...((msg.event === 'started' ? msg.resumed : previous?.resumed) ? { resumed: true } : {}),
  });
  lastTaskSourceByToolUseId.set(toolUseId, msg);
}


/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 * Truly internal/system content is already filtered server-side. Some Claude
 * transcript artifacts such as local slash commands and compact summaries are
 * intentionally preserved and annotated so they render like normal chat.
 */
export function normalizedToChatMessages(
  messages: NormalizedMessage[],
  options: {
    /**
     * Keep a live row out of the main thread while its parent card has not
     * arrived. Pass it only while the session is still running: a settled
     * session's orphan will never get a card, and a history row's card may sit
     * on a page that is not loaded, so those render where they are.
     */
    holdOrphanedLiveRows?: boolean;
  } = {},
): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results for attachment, and fold the live word
  // on each background task into the tool call that launched it. Both answer
  // the same question — what has this call's work done since it launched —
  // from different sides of a turn's end.
  const toolResultMap = new Map<string, NormalizedMessage>();
  const liveTasksByToolUseId = new Map<string, LiveTaskStatus>();
  const toolUseIdByTaskId = new Map<string, string>();
  const lastTaskSourceByToolUseId = new Map<string, NormalizedMessage>();
  // Subagent cards in this transcript, and the live rows their agents produced.
  // A row naming a card as its parent belongs to that card's timeline, not to
  // the main thread. Cards can nest (an agent spawning an agent): the inner
  // call is a step inside the outer card, and everything under it folds into
  // that same outer card, the only one the user sees.
  const toolCallById = new Map<string, NormalizedMessage>();
  for (const msg of messages) {
    if (msg.kind === 'tool_use' && msg.toolId) {
      toolCallById.set(msg.toolId, msg);
    }
  }
  const childRowsByAgentCall = new Map<string, NormalizedMessage[]>();
  const foldedRows = new Set<NormalizedMessage>();
  for (const msg of messages) {
    if (!msg.parentToolUseId || !CHILD_ROW_KINDS.has(msg.kind)) continue;
    const card = resolveParentCard(msg.parentToolUseId, toolCallById);
    // `undefined`: a call that is not an agent; its rows stay in the main thread.
    if (card === undefined) continue;
    foldedRows.add(msg);
    // `null`: the parent card has not arrived. A live row of a running session
    // waits for it out of the main thread; any other row renders in place.
    if (card === null) {
      if (!(options.holdOrphanedLiveRows && typeof msg.seq === 'number')) foldedRows.delete(msg);
      continue;
    }
    // A card caught in a parent cycle is its own card: it renders itself.
    if (msg.kind === 'tool_use' && msg.toolId === card) {
      foldedRows.delete(msg);
      continue;
    }
    const rows = childRowsByAgentCall.get(card);
    if (rows) rows.push(msg); else childRowsByAgentCall.set(card, [msg]);
  }
  for (const msg of messages) {
    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
      // A launch acknowledgement names its task, so an `updated` event for a
      // task launched before this page loaded — which carries no tool-use id
      // and follows no `started` event here — still finds its call.
      const launchedTaskId = (msg.toolUseResult as { taskId?: unknown } | undefined)?.taskId;
      if (typeof launchedTaskId === 'string' && launchedTaskId) {
        toolUseIdByTaskId.set(launchedTaskId, msg.toolId);
      }
    } else if (msg.kind === 'task_status') {
      foldTaskStatus(msg, liveTasksByToolUseId, toolUseIdByTaskId, lastTaskSourceByToolUseId);
    }
  }

  for (const msg of messages) {
    if (foldedRows.has(msg)) {
      continue;
    }
    const foldedChildRows = msg.kind === 'tool_use' && msg.toolId
      ? childRowsByAgentCall.get(msg.toolId) ?? NO_CHILD_ROWS
      : NO_CHILD_ROWS;
    const attachedToolResult: unknown = msg.kind === 'tool_use'
      ? (msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) ?? null : null))
      : null;
    const taskStatusSource = msg.kind === 'tool_use' && msg.toolId
      ? lastTaskSourceByToolUseId.get(msg.toolId) ?? null
      : null;

    const cached = conversionCache.get(msg);
    if (
      cached
      && Object.is(cached.attachedToolResult, attachedToolResult)
      && Object.is(cached.taskStatusSource, taskStatusSource)
      && sameRows(cached.foldedChildRows, foldedChildRows)
      && foldedChildRows.every((child) => Object.is(cached.foldedResults?.get(child), child.toolId ? toolResultMap.get(child.toolId) : undefined))
    ) {
      converted.push(...cached.outputs);
      continue;
    }

    const outputs = convertRow(msg, toolResultMap, liveTasksByToolUseId, foldedChildRows);
    const foldedResults = new Map(foldedChildRows.map((child) => [child, child.toolId ? toolResultMap.get(child.toolId) : undefined]));
    conversionCache.set(msg, { attachedToolResult, taskStatusSource, foldedChildRows, foldedResults, outputs });
    converted.push(...outputs);
  }

  return foldCompactionRows(converted);
}

/** The CLI acknowledges a compaction in the stream with the bare word. */
const COMPACTION_NOTICE = /^Compacted\.?$/;

/**
 * Draws each compaction as one row, whichever order its parts arrive in.
 *
 * Every provider reports a compaction as a row carrying `compact` (running,
 * done or failed) plus, when the engine keeps one, its summary as a separate
 * `isCompactSummary` row. History puts the summary after the row and the live
 * stream may put it before; either way the reader wants one row with the
 * summary folded into it. Also dropped: an unflagged second copy of a summary
 * (assistant rows only) and the CLI's bare `Compacted` acknowledgement, the
 * latter only beside a real row, since against a server that reports none it
 * is the only trace there is.
 *
 * Runs after the per-row conversion so the projection cache stays per row;
 * every row it changes is a copy, because cached rows are shared across
 * renders and a memoized row that keeps its identity does not redraw.
 */
function foldCompactionRows(rows: ChatMessage[]): ChatMessage[] {
  const hasCompactionRow = rows.some((row) => row.compact);
  const summaryTexts = new Set(
    rows.filter((row) => row.isCompactSummary).map((row) => (row.content || '').trim()).filter(Boolean),
  );
  if (!hasCompactionRow && summaryTexts.size === 0) {
    return rows;
  }

  const folded: ChatMessage[] = [];
  for (const row of rows) {
    const text = (row.content || '').trim();
    const isPlainAssistant = row.type === 'assistant' && !row.compact && !row.isCompactSummary;
    if (isPlainAssistant && (summaryTexts.has(text) || (hasCompactionRow && COMPACTION_NOTICE.test(text)))) {
      continue;
    }

    const previous = folded[folded.length - 1];
    if (row.isCompactSummary) {
      if (previous?.compact && !previous.compactSummary) {
        folded[folded.length - 1] = { ...previous, compactSummary: row.content };
      } else {
        // A summary with no row of its own yet (the live order, or a session
        // compacted before its engine reported compactions) still gets one.
        folded.push({ ...row, content: '', isCompactSummary: false, compact: { phase: 'done' }, compactSummary: row.content });
      }
      continue;
    }

    if (row.compact) {
      // Only the row directly above is superseded: a running row, now that
      // the compaction ended, or the summary-only row a summary made when it
      // arrived first. Its summary comes along.
      const supersedes = Boolean(previous?.compact) && (previous.compact?.phase === 'running' || !previous.content);
      if (supersedes) {
        folded.pop();
      }
      folded.push({ ...row, compactSummary: (supersedes ? previous.compactSummary : undefined) ?? row.compactSummary });
      continue;
    }

    folded.push(row);
  }
  return folded;
}

function convertRow(
  msg: NormalizedMessage,
  toolResultMap: Map<string, NormalizedMessage>,
  liveTasksByToolUseId: Map<string, LiveTaskStatus>,
  foldedChildRows: NormalizedMessage[],
): ChatMessage[] {
  const outputs: ChatMessage[] = [];

  const sharedMetadata = {
      id: msg.id,
      displayText: msg.displayText,
      commandName: msg.commandName,
      commandMessage: msg.commandMessage,
      commandArgs: msg.commandArgs,
      isLocalCommand: msg.isLocalCommand,
      isLocalCommandStdout: msg.isLocalCommandStdout,
      isCompactSummary: msg.isCompactSummary,
      transcriptAnchorId: msg.transcriptAnchorId,
      compact: msg.compact,
    };

    switch (msg.kind) {
      case 'text': {
        const content = msg.content || '';
        const images = Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined;
        const files = Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined;
        if (!content.trim() && !images && !files) return outputs;

        if (msg.role === 'user') {
          // Parse task notifications
          const taskNotif = parseTaskNotification(content);
          if (taskNotif) {
            outputs.push({
              type: 'assistant',
              content: taskNotif.summary,
              timestamp: msg.timestamp,
              isTaskNotification: true,
              taskNotificationStatus: taskNotif.status,
              ...sharedMetadata,
            });
            // Render the agent's result as a normal assistant message so its
            // markdown displays correctly instead of leaking raw XML.
            if (taskNotif.result) {
              outputs.push({
                type: 'assistant',
                content: formatUsageLimitText(taskNotif.result),
                timestamp: msg.timestamp,
                ...sharedMetadata,
              });
            }
          } else {
            outputs.push({
              type: 'user',
              content,
              timestamp: msg.timestamp,
              images,
              files,
              ...sharedMetadata,
            });
          }
        } else {
          const text = formatUsageLimitText(content);
          outputs.push({
            type: 'assistant',
            content: text,
            timestamp: msg.timestamp,
            images,
            memoryCitations: msg.memoryCitations,
            model: msg.model,
            ...sharedMetadata,
          });
        }
        break;
      }

      case 'tool_use': {
        const tr = msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null);
        const taskStatus = msg.toolId ? liveTasksByToolUseId.get(msg.toolId) : undefined;
        const isSubagentContainer = isSubagentToolName(msg.toolName);

        const toolResult = tr
          ? {
              content: formatToolResultContent(tr.content),
              isError: Boolean(tr.isError),
              toolUseResult: (tr as any).toolUseResult,
            }
          : null;

        outputs.push({
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          isSubagentContainer,
          // The agent's outcome and work: the history reader's record when the
          // row carries one, else the child rows the live stream delivered. A
          // resumed agent's live rows are a run newer than that record, so
          // they follow it.
          subagent: msg.subagent,
          subagentActivity: buildSubagentActivity(msg, taskStatus, foldedChildRows, toolResultMap),
          // The latest live word on this call's background work, folded from
          // the session's task_status events. Undefined once the transcript's
          // own settled record (subagent / workflow) takes over.
          taskStatus,
          ...sharedMetadata,
        });
        break;
      }

      case 'thinking':
        if (msg.content?.trim()) {
          outputs.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isThinking: true,
            ...sharedMetadata,
          });
        }
        break;

      case 'error':
        outputs.push({
          type: 'error',
          // zcode error messages carry the text in `text` (older rows) or
          // `content`; accept either so history rows keep rendering.
          content: msg.content || msg.text || 'Unknown error',
          timestamp: msg.timestamp,
          ...sharedMetadata,
        });
        break;

      case 'interactive_prompt':
        outputs.push({
          type: 'assistant',
          content: msg.content || '',
          timestamp: msg.timestamp,
          isInteractivePrompt: true,
          ...sharedMetadata,
        });
        break;

      case 'task_notification':
        outputs.push({
          type: 'assistant',
          content: msg.summary || 'Background task update',
          summaryKey: msg.summaryKey,
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskNotificationStatus: msg.status || 'completed',
          ...sharedMetadata,
        });
        break;

      case 'stream_delta':
        if (msg.content) {
          outputs.push({
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: true,
            ...sharedMetadata,
          });
        }
        break;

      // stream_end, complete, status, permission_*, session_created
      // are control events — not rendered as messages
      case 'stream_end':
      case 'complete':
      case 'status':
      case 'permission_request':
      case 'permission_resolved':
      case 'permission_cancelled':
      case 'session_created':
        // Skip — these are handled by useChatRealtimeHandlers
        break;

      // tool_result is handled via attachment to tool_use above
      case 'tool_result': {
        // A result with a toolId is either attached to its tool_use row above
        // or split across a pagination boundary (older page not loaded yet) —
        // rendering its raw content here would produce an unstyled dump that
        // "fixes itself" once the older page loads, so skip it and let it
        // attach to its tool_use when that arrives.
        if (msg.toolId) {
          break;
        }

        const content = formatToolResultContent(msg.content || '');
        if (!content.trim()) {
          break;
        }

        outputs.push({
          type: msg.isError ? 'error' : 'assistant',
          content,
          timestamp: msg.timestamp,
          toolId: msg.toolId,
          ...sharedMetadata,
        });
        break;
      }

      default:
        break;
    }

  return outputs;
}
