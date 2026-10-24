/**
 * The chat wire contract: every type that crosses the server ↔ client boundary.
 *
 * This file is the single definition of those shapes. Both sides re-export from
 * here rather than declaring their own copy, because two copies is exactly what
 * this replaces. Seven wire fields had ended up declared on one side only —
 * `actualSessionId`, `exitCode` and `parentToolUseId` on the client, and
 * `isCancelledError`, `memoryCitations`, `reason` and `toolUseResult` on the
 * server — with an index signature covering the gap so nothing ever failed to
 * compile. A field that is not declared here is not on the wire.
 *
 * Kept free of both `node:*` and DOM/React imports so either build can include
 * it; both tsconfigs already have the repository root `shared/` on their include
 * path. Each side adds its own local extensions on top (see the re-export sites
 * in `server/shared/types.ts` and `src/shared/types.ts`) — those additions are
 * deliberately visible rather than blended into the wire shape.
 */

/**
 * Providers supported by the unified server runtime.
 *
 * Use this as the source of truth whenever a function or payload needs to identify
 * a specific LLM integration.
 */
export type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode' | 'zcode' | 'antigravity';

/**
 * Message/event variants emitted by provider adapters and normalized transports.
 *
 * Keep this union in sync with event kinds produced by provider session adapters.
 */
export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_resolved'
  | 'permission_cancelled'
  | 'session_created'
  | 'history_truncated'
  | 'task_notification'
  | 'task_status';

/**
 * Event kinds added by the chat gateway layer on top of provider message kinds.
 *
 * These are app-level realtime events (subscription acks, sidebar deltas,
 * project loading progress, queued messages the server started, protocol
 * failures) that are not produced by any
 * provider adapter. Together with `MessageKind` they form the complete set of
 * `kind` values a websocket client can receive, so the frontend only ever
 * needs one kind-based switch.
 */
export type GatewayEventKind =
  | 'chat_subscribed'
  | 'session_upserted'
  | 'session_removed'
  | 'loading_progress'
  | 'queued_message_dispatched'
  | 'protocol_error';

/**
 * Complete set of `kind` values emitted to websocket clients.
 *
 * Every server-to-client websocket frame carries a `kind` from this union.
 * Provider runtimes emit `MessageKind` values; gateway services emit
 * `GatewayEventKind` values.
 */
export type ServerEventKind = MessageKind | GatewayEventKind;

/**
 * One stored memory an assistant reply drew on.
 *
 * Codex appends these to a reply that used its memory files, naming the file
 * and line range it read plus a short note on what it took from there. The
 * transcript shows them as a footnote so a memory-derived claim is traceable
 * rather than arriving as an unattributed assertion.
 */
export type MemoryCitation = {
  /** File and line range that was read, e.g. `MEMORY.md:137-142`. */
  source: string;
  /** What the reply took from that range, when the provider states it. */
  note?: string;
};

/**
 * A compaction, as the transcript records it.
 *
 * `running` is the status the CLI sends when it starts compacting, `done` the
 * boundary it sends when it has, `failed` a compaction that did not finish.
 * The token counts and duration only come with a boundary.
 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * The latest live word on a background task, folded from the session's
 * `task_status` events onto the tool call that launched it. It is what a card
 * reads while the run is in flight; on a history reload the backend's
 * `subagent` or `workflow` carries the settled outcome instead.
 */
export type LiveTaskStatus = {
  status: BackgroundTaskStatus;
  /** The id the events name the task by, which is what stopping it addresses. */
  taskId?: string;
  taskType?: string;
  workflowName?: string;
  description?: string;
  summary?: string;
  usage?: TaskUsage;
  /** A workflow's only: where each agent the run spawned stands, from its latest progress event. */
  agents?: WorkflowAgentProgress[];
};

export type CompactionInfo = {
  phase: 'running' | 'done' | 'failed';
  /** Whether the user asked for it or the context window did. */
  trigger?: 'manual' | 'auto';
  /** Tokens the conversation held before and after, when the boundary reports them. */
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: string | null;
};

/**
 * What a background task has spent so far, as the engine reports it. Claude's
 * `task_progress` and `task_notification` carry all three; an engine that
 * leaves a figure out (ZCode's failure stop has no token or tool-call totals)
 * leaves it undefined, which means "not reported", not zero.
 */
export type TaskUsage = {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
};

/**
 * One background task a live session still has outstanding — a spawned
 * agent, a workflow run or a backgrounded command — as the runtime tracks it
 * from the stream's `task_started` until the event that settles it.
 *
 * `taskId` is the handle a stop request names; `toolUseId` is the call that
 * launched it, which is how the client pairs the task with its card.
 * `startedAt` is the server clock at `task_started`, so a session whose turn
 * has ended can still report how long its work has been going.
 */
export type BackgroundTaskSummary = {
  taskId: string;
  toolUseId: string;
  taskType: string;
  description: string;
  workflowName?: string;
  startedAt: number;
  /**
   * The task was launched by a subagent or workflow agent, not by the
   * session's own turn: its `toolUseId` names a call in that agent's
   * transcript, so no card in this session's transcript matches it. Listed so
   * it can still be stopped; not counted as the session's own work.
   */
  nested?: boolean;
};

/**
 * Where one agent of a running workflow stands, as the SDK reports it on the
 * run's `task_progress` events.
 *
 * An entry the script has queued but not yet started has no `agentId` and is
 * identified by `index` alone; once the agent runs, `agentId` names the
 * transcript it writes. `lastToolName` and `lastToolSummary` are the agent's
 * own latest tool call — unlike the event's task-level `last_tool_name`, which
 * for a workflow is the current agent's label.
 */
export type WorkflowAgentProgress = {
  index: number;
  label?: string;
  /** The title of the script phase the agent runs under, when it has one. */
  phase?: string;
  agentId?: string;
  model?: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  startedAt?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  resultPreview?: string;
};

/**
 * One workflow agent's recorded timeline, read from its transcript on demand
 * when the card is opened — the SDK never streams an agent's own rows to the
 * parent session, so this is the only way to see what it did.
 *
 * `activityCount` is the full length of the timeline; `activity` is capped
 * for transport like a subagent's `subagentTools`.
 */
export type WorkflowAgentActivity = {
  agent: {
    id: string;
    label?: string;
    model?: string;
    status: 'running' | 'completed' | 'failed' | 'stopped';
  };
  activity: SubagentActivity[];
  activityCount: number;
};

/**
 * One agent a workflow run spawned, as its journal records it.
 *
 * `label` and `phase` are whatever the script passed when it spawned the
 * agent; older scripts passed neither. An agent with a `started` record and no
 * `result` or `failed` one is still running as far as the journal knows.
 */
export type WorkflowAgentInfo = {
  id: string;
  label?: string;
  phase?: string;
  /** `stopped` is an agent the journal never settled although the run itself has — abandoned by a stop or a resume that re-ran the step. */
  status: 'running' | 'completed' | 'failed' | 'stopped';
};

/**
 * A `Workflow` tool call's run, attached to the `tool_use` that launched it.
 *
 * `status` follows the same rule as a background agent's: the task
 * notification's word when one exists, else `running` only while the process
 * that launched it is still up, else `stopped`. The agent list and counts come
 * from `<transcriptDir>/journal.jsonl`; both are empty when the run left no
 * journal behind (a fork copies only the parent's transcript).
 */
export type WorkflowInfo = {
  runId: string;
  name: string;
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  agents: WorkflowAgentInfo[];
  agentCounts: { total: number; completed: number; failed: number; running: number; stopped: number };
  scriptPath?: string;
};

/**
 * One entry in a subagent's recorded timeline.
 *
 * Providers store a subagent's work in a separate transcript (Claude:
 * `<session>/subagents/agent-<id>.jsonl`; Codex: a sibling rollout keyed by
 * `agent_thread_id`). Both are flattened into this shape so the transcript can
 * replay a subagent's run with the same renderers the main thread uses.
 *
 * `kind` decides which fields matter: `tool` uses the tool fields, `text` and
 * `thinking` use `content`. Consumers must not assume tool fields exist on the
 * text kinds.
 */
export type SubagentActivity = {
  kind: 'tool' | 'text' | 'thinking';
  timestamp?: string;
  /** Tool-call identity; only set when `kind` is `tool`. */
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: { content?: string; isError?: boolean } | null;
  /** Message body; only set when `kind` is `text` or `thinking`. */
  content?: string;
};

/**
 * Identity and lifecycle of one spawned subagent, normalized across providers.
 *
 * `status` is `running` until the call that spawned the agent resolves. After
 * that it is whatever the provider reported — Claude's task notification
 * carries one — and `completed` when the provider reported nothing. A failed
 * tool call *inside* the agent is not a failed agent, so it is never inferred
 * from the transcript.
 */
export type SubagentInfo = {
  /** Provider-native agent id — Claude `agentId`, Codex `agent_thread_id`. */
  id: string;
  /** Human-facing label: Claude's agent type, or Codex's assigned nickname. */
  name?: string;
  /** Agent type/preset when the provider records one (Claude `agentType`). */
  type?: string;
  /** One-line task summary shown in the collapsed header. */
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  /** Model the subagent ran on, when the provider records it. */
  model?: string;
  /**
   * How many activities the agent actually recorded. It exceeds
   * `subagentTools.length` when a long run was truncated for transport, which
   * lets the UI say so instead of silently showing a partial timeline.
   */
  activityCount?: number;
};

export type ActiveBackgroundTask = {
  /** Stable identity of the tool call that launched the card. */
  id: string;
  /** Engine stop handle, when available; tool-call ids cannot be used to stop tasks. */
  taskId?: string;
  toolName: string;
  command?: string;
  description?: string;
  startedAt: number;
};

/** The owning project as it appears inside a `session_upserted` delta. */
export type SessionUpsertedProject = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
};

/**
 * The `session_upserted` sidebar delta, built only by
 * `modules/websocket/services/session-upsert-broadcast.service.ts`.
 *
 * Typed rather than assembled as an untyped object literal because the payload
 * used to be built in two places and silently drifted apart: one copy set
 * `providerSessionId` and the other did not, and nothing could detect it.
 *
 * `providerSessionId` is how a client recognises that a row it is currently
 * showing has been merged into its canonical app-session row, so it is always
 * present — `null` only while the provider has not reported an id yet.
 */
export type SessionUpsertedEvent = {
  kind: 'session_upserted';
  sessionId: string;
  providerSessionId: string | null;
  provider: LLMProvider;
  /**
   * True when the delta carries a new session name and nothing else.
   *
   * A name-only delta updates the title in the sidebar and in the open
   * session's header; it must not make the client re-read the transcript,
   * mark the session as needing attention, or re-order the list. Absent means
   * the session changed in a way the client has to look at (new messages, new
   * activity), which is the historical meaning of this event.
   */
  metadataOnly?: boolean;
  session: {
    id: string;
    summary: string;
    messageCount: number;
    lastActivity: string;
    /** Git worktree the session runs in; null for main-checkout sessions. */
    worktreePath?: string | null;
    /** Branch checked out in that worktree; null when detached or main-checkout. */
    worktreeBranch?: string | null;
  };
  project: SessionUpsertedProject | null;
  timestamp: string;
};

/**
 * Announces that sessions left the active sidebar list because they were
 * archived (batch auto-archive, manual run, or single-session archive) or
 * permanently deleted.
 *
 * There is deliberately no singular `sessionId` field: clients must key the
 * removal off `sessionIds`, which also keeps generic per-session event
 * handling (attention marks, unread badges) from firing for rows that are
 * gone. Removal is idempotent — a client that already removed the row locally
 * (the delete initiator) just drops the frame.
 *
 * Built only by `modules/websocket/services/session-upsert-broadcast.service.ts`.
 */
export type SessionRemovedEvent = {
  kind: 'session_removed';
  sessionIds: string[];
  timestamp: string;
};

/**
 * Provider-neutral message envelope used in REST responses and realtime channels.
 *
 * Every provider-specific message must be converted into this shape before being
 * emitted outside provider-specific modules.
 */
export type NormalizedMessage = {
  id: string;
  /**
   * The provider's own identifier for the transcript row this message came
   * from, when the provider has stable per-row identity (today: Claude's
   * `uuid`). It is what "edit this message" and "fork from here" address, so it
   * has to survive a reload — never a value this app synthesized.
   */
  transcriptAnchorId?: string;
  /**
   * Provider-defined identity for matching one live-rendered row with the same
   * row later loaded from history. It is scoped to a provider session, must be
   * reproducible on both transport paths, and is used only for timeline
   * reconciliation — never for transcript editing, websocket replay ordering,
   * or display order. Providers must omit it when no stable native identity is
   * available rather than substituting a line number or app-generated id.
   */
  providerRowKey?: string;
  /**
   * Whether a provider transcript explicitly marked this row's visible body as
   * complete. Timeline reconciliation may replace a truncated history body
   * with the corresponding complete realtime body, but never infers this from
   * text similarity.
   */
  contentCompleteness?: 'complete' | 'truncated';
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Monotonic per-session sequence number assigned by the chat run registry
   * when a live event is forwarded to the websocket. The counter continues
   * across runs (the registry keeps one watermark per session), so a client's
   * `lastSeq` stays comparable for `chat.subscribe` replay across websocket
   * reconnects. History messages loaded over REST do not carry it.
   */
  seq?: number;
  /** Gateway process identity; event identity is (streamEpoch, sessionId, seq). Absent on REST history and legacy servers. */
  streamEpoch?: string;
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Optional display-oriented metadata used by providers that need to expose
   * richer transcript artifacts without introducing a brand-new message kind.
   *
   * Current Claude usage:
   * - local slash commands expose parsed command fields
   * - compact summaries are flagged so the UI can treat them differently later
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /**
   * The model that produced this assistant message, as the provider reported
   * it on the transcript row. Absent on user turns and when the provider
   * named a placeholder such as `<synthetic>`.
   */
  model?: string;
  /** A compaction row, when the message is a compaction summary. */
  compact?: CompactionInfo;
  /** A live workflow, when the message reports workflow/agent progress. */
  workflow?: WorkflowInfo;
  /** Image attachments on a user turn after provider history normalization. */
  images?: Array<{ path?: string; data?: string; name?: string }>;
  /** Non-image files attached to a user turn after provider history normalization. */
  files?: Array<{ path?: string; name?: string; mimeType?: string; size?: number }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: {
    content?: string;
    isError?: boolean;
    toolUseResult?: unknown;
  } | null;
  isError?: boolean;
  /**
   * ZCode only: the engine reported this error as a cancelled model request,
   * not a failure. The runtime drops it when the user's own stop is on
   * record and otherwise degrades it to a quiet `task_notification`; history
   * normalization degrades it the same way, so a reload matches the live
   * stream. Never set by other providers.
   */
  isCancelledError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  reason?: string;
  newSessionId?: string;
  /**
   * The transcript row a `history_truncated` frame cuts from. Editing a sent
   * message replaces its turn and everything after it, and this names where
   * the client's timeline has to be trimmed back to.
   */
  anchorId?: string;
  status?: string;
  summary?: string;
  /**
   * i18n key for the summary, resolved by the client against its own locale
   * (chat namespace). Providers set it on task notifications whose wording is
   * ours, not the engine's; `summary` stays as the verbatim fallback so older
   * clients and transcript exports still show sensible text. Keys live under
   * `taskNotices` in each locale's chat.json.
   */
  summaryKey?: string;
  tokenBudget?: unknown;
  /**
   * What the engine is doing with the round: `queued` means the engine holds
   * it and has not started its turn, `reporting` means the engine runs a
   * turn of its own, which is why it waits.
   */
  activityState?: { queued?: boolean; reporting?: boolean };
  backgroundTasks?: ActiveBackgroundTask[];
  /** True while background execution or its follow-up reply still blocks queued messages. */
  backgroundWorkPending?: boolean;
  /**
   * False when a message sent during the background work does not disturb it
   * (Claude takes it as a turn of the held process), so the page sends it at
   * once. Omitted means the message waits for the work.
   */
  backgroundWorkQueuesInput?: boolean;
  /**
   * Live background-work events (`task_status` rows): what a launched agent,
   * workflow or backgrounded command is doing while its turn has ended. The
   * run is tracking. `taskId` is the provider's task handle; `toolUseId` names
   * the call that launched it and is absent on `updated`, which the SDK keys by
   * task id alone. `status` and `summary` above carry the event's own.
   */
  event?: 'started' | 'progress' | 'updated' | 'notification';
  taskId?: string;
  toolUseId?: string;
  taskType?: string;
  workflowName?: string;
  description?: string;
  usage?: TaskUsage;
  outputFile?: string;
  /** A workflow's `progress` only: where each agent the run spawned stands. */
  agents?: WorkflowAgentProgress[];
  /**
   * Timeline of everything a subagent did, attached to the `tool_use` that
   * spawned it. Present for `Agent` calls (every engine's subagent spawn);
   * absent for every other tool.
   */
  subagentTools?: SubagentActivity[];
  /** Identity and lifecycle of the subagent this `tool_use` spawned. */
  subagent?: SubagentInfo;
  /** Stored memory the reply drew on, when the provider reports it. */
  memoryCitations?: MemoryCitation[];
  toolUseResult?: unknown;
  /**
   * The app session id a `complete` frame settles on. Provider-native ids never
   * leave the backend, so the chat run registry overwrites whatever the engine
   * reported with the app id before the frame goes out.
   */
  actualSessionId?: string;
  /**
   * Whether a terminal `complete` reports a clean finish. Derived from the
   * exit code and whether the user stopped the run, so a caller reads this
   * rather than re-deriving it.
   */
  success?: boolean;
  /** Whether a terminal `complete` is the result of the user stopping the run. */
  aborted?: boolean;
  /**
   * Process exit code carried by a terminal frame from CLI-backed engines.
   * Absent for SDK-backed runs, which have no process to exit.
   */
  exitCode?: number;
  /**
   * The tool call whose subagent produced this row, when the provider reports
   * one (Claude's `parent_tool_use_id`). Its absence is what marks a row as
   * main-thread traffic rather than subagent traffic.
   */
  parentToolUseId?: string;
  sequence?: number;
  rowid?: number;
};
