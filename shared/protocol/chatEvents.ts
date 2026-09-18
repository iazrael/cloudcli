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
  | 'task_notification';

/**
 * Event kinds added by the chat gateway layer on top of provider message kinds.
 *
 * These are app-level realtime events (subscription acks, sidebar deltas,
 * project loading progress, protocol failures) that are not produced by any
 * provider adapter. Together with `MessageKind` they form the complete set of
 * `kind` values a websocket client can receive, so the frontend only ever
 * needs one kind-based switch.
 */
export type GatewayEventKind =
  | 'chat_subscribed'
  | 'session_upserted'
  | 'session_removed'
  | 'loading_progress'
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
  status: 'running' | 'completed' | 'failed';
  /** Model the subagent ran on, when the provider records it. */
  model?: string;
  /**
   * How many activities the agent actually recorded. It exceeds
   * `subagentTools.length` when a long run was truncated for transport, which
   * lets the UI say so instead of silently showing a partial timeline.
   */
  activityCount?: number;
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
  session: {
    id: string;
    summary: string;
    messageCount: number;
    lastActivity: string;
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
   * Timeline of everything a subagent did, attached to the `tool_use` that
   * spawned it. Present for Claude `Agent`/`Task` calls and Codex
   * `spawn_agent` calls; absent for every other tool.
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
