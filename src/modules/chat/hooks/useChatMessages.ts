/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '@/modules/chat/hooks/useSessionStore';
import type { ChatMessage, LiveTaskStatus, SubagentActivity } from '@/shared/types';
import { formatUsageLimitText } from '@/modules/chat/utils/chatFormatting';
import { isSubagentSpawnTool } from '@/modules/chat/tools/toolTaxonomy';

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
  /** Newest live subagent row folded into a container's timeline, when any. */
  subagentActivitySource: NormalizedMessage | null;
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
    // A settled status is final. Short of one, `started` and `progress` mean
    // the task is running, while an `updated` patch that does not change the
    // status (an end time, say) leaves it where it was.
    status: settled ?? (msg.event === 'started' || msg.event === 'progress' ? 'running' : previous?.status ?? 'running'),
    taskId: msg.taskId ?? previous?.taskId,
    taskType: msg.taskType ?? previous?.taskType,
    workflowName: msg.workflowName ?? previous?.workflowName,
    description: msg.description ?? previous?.description,
    summary: msg.summary ?? previous?.summary,
    usage: msg.usage ?? previous?.usage,
    ...(agents ? { agents } : {}),
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
/**
 * Folds one live subagent row into the timeline of the call that spawned it.
 *
 * A running subagent's rows stream in stamped with `parentToolUseId`. Rendered
 * top-level they read as the session's own tool calls, only to jump inside the
 * container on the next history load, which ships the same timeline as
 * `subagentTools`. Streaming text and thinking frames reuse one row id, so
 * their deltas append to the same activity instead of becoming one entry per
 * fragment.
 */
function foldLiveSubagentRow(
  msg: NormalizedMessage,
  activityByParent: Map<string, SubagentActivity[]>,
  toolById: Map<string, SubagentActivity>,
  textById: Map<string, SubagentActivity>,
): void {
  const parentId = msg.parentToolUseId;
  if (!parentId) {
    return;
  }

  let activity = activityByParent.get(parentId);
  if (!activity) {
    activity = [];
    activityByParent.set(parentId, activity);
  }

  switch (msg.kind) {
    case 'tool_use': {
      const tool: SubagentActivity = {
        kind: 'tool',
        toolId: msg.toolId,
        toolName: msg.toolName || 'Tool',
        toolInput: msg.toolInput,
        timestamp: msg.timestamp,
      };
      activity.push(tool);
      if (msg.toolId) {
        toolById.set(msg.toolId, tool);
      }
      break;
    }
    case 'tool_result': {
      const tool = msg.toolId ? toolById.get(msg.toolId) : undefined;
      if (tool) {
        tool.toolResult = {
          content: formatToolResultContent(msg.content ?? ''),
          isError: Boolean(msg.isError),
        };
      }
      break;
    }
    case 'text':
    case 'thinking':
    case 'stream_delta': {
      // Assistant prose and reasoning only, matching the timeline the server
      // builds from the subagent's transcript — user-role rows there are tool
      // results and the echoed task prompt.
      if ((msg.kind === 'text' && msg.role !== 'assistant') || !msg.content?.trim()) {
        break;
      }
      const kind = msg.kind === 'thinking' ? 'thinking' : 'text';
      const key = `${parentId}\u0000${msg.id}`;
      const existing = textById.get(key);
      if (existing && (msg.kind === 'thinking' || msg.kind === 'stream_delta')) {
        // Deltas of one streamed block share the block id.
        existing.content = `${existing.content ?? ''}${msg.content}`;
      } else if (!existing || existing.content !== msg.content) {
        const entry: SubagentActivity = {
          kind,
          content: msg.content,
          timestamp: msg.timestamp,
        };
        activity.push(entry);
        textById.set(key, entry);
      }
      break;
    }
    default:
      break;
  }
}

export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];

  // First pass: collect tool results for attachment, fold the live word on
  // each background task into the call that launched it, and fold a running
  // subagent's rows into its spawner's timeline. All three answer the same
  // question — what has this call's work done since it launched — from rows
  // the store keeps at top level.
  const toolResultMap = new Map<string, NormalizedMessage>();
  const liveTasksByToolUseId = new Map<string, LiveTaskStatus>();
  const toolUseIdByTaskId = new Map<string, string>();
  const lastTaskSourceByToolUseId = new Map<string, NormalizedMessage>();
  const liveSubagentActivity = new Map<string, SubagentActivity[]>();
  const liveSubagentToolsById = new Map<string, SubagentActivity>();
  const liveSubagentTextById = new Map<string, SubagentActivity>();
  /** Newest folded row per container, so its cached projection knows to rebuild. */
  const lastSubagentSourceByParent = new Map<string, NormalizedMessage>();
  for (const msg of messages) {
    if (msg.kind === 'task_status') {
      foldTaskStatus(msg, liveTasksByToolUseId, toolUseIdByTaskId, lastTaskSourceByToolUseId);
      continue;
    }

    if (msg.parentToolUseId) {
      foldLiveSubagentRow(msg, liveSubagentActivity, liveSubagentToolsById, liveSubagentTextById);
      lastSubagentSourceByParent.set(msg.parentToolUseId, msg);
      continue;
    }

    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
      // A launch acknowledgement names its task, so an `updated` event for a
      // task launched before this page loaded — which carries no tool-use id
      // and follows no `started` event here — still finds its call.
      const launchedTaskId = (msg.toolUseResult as { taskId?: unknown } | undefined)?.taskId;
      if (typeof launchedTaskId === 'string' && launchedTaskId) {
        toolUseIdByTaskId.set(launchedTaskId, msg.toolId);
      }
    }
  }

  for (const msg of messages) {
    // Subagent rows were folded into their container's timeline above.
    if (msg.parentToolUseId) {
      continue;
    }

    const attachedToolResult: unknown = msg.kind === 'tool_use'
      ? (msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) ?? null : null))
      : null;
    const subagentActivitySource = msg.kind === 'tool_use' && msg.toolId
      ? lastSubagentSourceByParent.get(msg.toolId) ?? null
      : null;
    const taskStatusSource = msg.kind === 'tool_use' && msg.toolId
      ? lastTaskSourceByToolUseId.get(msg.toolId) ?? null
      : null;

    const cached = conversionCache.get(msg);
    if (
      cached
      && Object.is(cached.attachedToolResult, attachedToolResult)
      && Object.is(cached.subagentActivitySource, subagentActivitySource)
      && Object.is(cached.taskStatusSource, taskStatusSource)
    ) {
      converted.push(...cached.outputs);
      continue;
    }

    const outputs = convertRow(msg, toolResultMap, liveTasksByToolUseId, liveSubagentActivity);
    conversionCache.set(msg, { attachedToolResult, subagentActivitySource, taskStatusSource, outputs });
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
  liveSubagentActivity: Map<string, SubagentActivity[]>,
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
            memoryCitations: msg.memoryCitations,
            model: msg.model,
            ...sharedMetadata,
          });
        }
        break;
      }

      case 'tool_use': {
        const tr = msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null);
        // A row is a subagent container when the backend attached agent
        // metadata to it, or when its tool is an engine's spawn call whose
        // metadata has not been indexed yet (Claude Task/Agent, OpenCode
        // subagent/task, Antigravity invoke_subagent).
        const isSubagentContainer = Boolean(msg.subagent) || isSubagentSpawnTool(msg.toolName ?? '');

        const toolResult = tr
          ? {
              content: formatToolResultContent(tr.content),
              isError: Boolean(tr.isError),
              toolUseResult: (tr as any).toolUseResult,
            }
          : null;

        // The server-indexed timeline arrives on a history load; the live fold
        // covers the run in progress. A mid-run refresh can attach a partial
        // server timeline while newer live rows keep streaming, so the longer
        // list is the fresher one.
        const serverActivity = Array.isArray(msg.subagentTools) ? msg.subagentTools : undefined;
        const liveActivity = msg.toolId ? liveSubagentActivity.get(msg.toolId) : undefined;
        const subagentActivity = liveActivity && liveActivity.length > (serverActivity?.length ?? 0)
          ? liveActivity
          : serverActivity;

        outputs.push({
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          toolStatus: typeof msg.status === 'string' ? msg.status : undefined,
          isSubagentContainer,
          subagent: msg.subagent,
          subagentActivity,
          workflow: msg.workflow,
          // The latest live word on this call's background work, folded from
          // the session's task_status events. Undefined once the transcript's
          // own settled record (subagent / workflow) takes over.
          taskStatus: msg.toolId ? liveTasksByToolUseId.get(msg.toolId) : undefined,
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
