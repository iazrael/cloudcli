import type {
  ActiveBackgroundTask,
  AnyRecord,
  SessionBackgroundWork,
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  McpScope,
  NormalizedMessage,
  ProviderAuthStatus,
  ProviderCurrentActiveModel,
  ProviderMcpCapabilities,
  ProviderMcpServer,
  ProviderModelsDefinition,
  ProviderQuotaData,
  ProviderQuotaResetConsumeInput,
  ProviderQuotaResetConsumeResult,
  ProviderRuntimeContext,
  ProviderRuntimePermissionGateway,
  ProviderRuntimeWriter,
  ProviderSessionFileSynchronizationDelta,
  ProviderSessionUsageInput,
  ProviderSessionWatchTarget,
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  ProviderSkillRemoveInput,
  ProviderTokenUsageResult,
  UpsertProviderMcpServerInput,
  WorkflowAgentActivity,
} from '@/shared/types.js';

//----------------- PROVIDER CONTRACT INTERFACES ------------

/**
 * Live execution contract implemented by each provider SDK/CLI adapter.
 *
 * The provider registry owns this adapter as one facet of `IProvider`; runtime
 * execution context is supplied by the application service at call time.
 */
export interface IProviderRuntime {
  /**
   * execution 模块只向自动任务开放声明此契约的运行时。
   * complete 必须对应引擎实际终止或已确认的停止，不能只是界面收尾、RPC 失败或本地超时。
   * run 返回后仍存活的工作须由后台工作切面完整登记；未知异常不能伪造 complete。
   */
  supportsTaskExecution?: boolean;
  /**
   * 网关可在后台任务执行时尝试提交排队消息，但运行时必须先调用可信的
   * onBeforeInputAccepted 领取消息，再在 SDK 消费输入后调用 onInputAccepted。
   * 无法安全续轮时抛出 code 为 PROVIDER_INPUT_DEFERRED 的 AppError；
   * 确认前必须保留原进程及后台任务。
   */
  supportsInputAcceptance?: boolean;
  run(
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<unknown>;
  abort(sessionId: string): boolean | Promise<boolean>;
  /**
   * What the engine is doing with the session's round.
   *
   * A resident engine knows whether the queued input has been picked up; the
   * caller needs that to tell "waiting for the engine" from "the engine is
   * working on this round".
   */
  getSessionActivity?(sessionId: string): { queued: boolean; reporting: boolean } | null;
  /**
   * Whether the session still has work that must not be reclaimed.
   *
   * A conversation with a turn in flight, with a report the engine started on
   * its own, or with an agent that is still running cannot be archived or
   * deleted while that work is alive.
   */
  hasSessionWork?(sessionId: string): boolean;
  /**
   * Stops new work from starting in the session.
   *
   * The caller looks at the session's state afterwards and releases it, so a
   * run cannot start in between the check and the action.
   */
  closeSessionAdmission?(sessionId: string): void;
  /**
   * Releases the resources the session holds, such as a process that stays
   * alive between rounds. Called once the session's work is over; the
   * admission stays closed until the caller opens it again.
   */
  releaseSession?(sessionId: string): void;
  /**
   * Opens the session's admission again, after the action that closed it.
   */
  openSessionAdmission?(sessionId: string): void;
  permissions?: ProviderRuntimePermissionGateway;
  backgroundTasks?: {
    list(sessionId: string): ActiveBackgroundTask[];
    /** Includes pending execution and the follow-up reply after its task settles. */
    isPending?(sessionId: string): boolean;
    /**
     * False only for a session whose listed work this runtime holds and
     * `abort` can no longer stop — its turn has ended and the runtime keeps no
     * run to cancel. Left undefined, or true, the work counts as stoppable.
     */
    canInterrupt?(sessionId: string): boolean;
    /**
     * False when a message sent during this session's background work does
     * not disturb it — the runtime takes the turn alongside the work (Claude's
     * held process) — so the page sends at once instead of queueing.
     * Undefined counts as true: the message waits for the work.
     */
    queuesInput?(sessionId: string): boolean;
  };
  /**
   * Sessions with background tasks still outstanding, whether or not their
   * turn has ended. Only a runtime that keeps its process open past a turn for
   * such work has anything to report; the others leave this undefined and the
   * running-sessions list falls back to chat runs alone.
   */
  listBackgroundWork?(): SessionBackgroundWork[];
  /**
   * Stops one outstanding background task. Resolves false when the session has
   * no live process or that process is not tracking the task — it already
   * settled, or the id was never one of its own.
   */
  stopBackgroundTask?(sessionId: string, taskId: string): Promise<boolean>;
}

/**
 * Main provider contract for CLI and SDK integrations.
 *
 * Each concrete provider owns its MCP/auth handlers plus the provider-specific
 * logic for converting native events/history into the app's normalized shape.
 */
export interface IProvider {
  readonly id: LLMProvider;
  readonly runtime: IProviderRuntime;
  readonly models: IProviderModels;
  readonly mcp: IProviderMcp;
  readonly auth: IProviderAuth;
  readonly skills: IProviderSkills;
  readonly sessions: IProviderSessions;
  readonly sessionSynchronizer: IProviderSessionSynchronizer;
  /**
   * Transcript branching. Present only for providers that can materialise a
   * prefix of one conversation as an independent, resumable provider session;
   * its absence is what makes "fork session" unavailable.
   */
  readonly fork?: IProviderFork;
}

// ---------------------------
//----------------- PROVIDER FORK INTERFACE ------------
/**
 * Transcript-branching contract for one provider.
 */
export interface IProviderFork {
  /**
   * Copies a session's transcript, up to and including `upToAnchorId` (the
   * whole conversation when omitted), into a brand-new provider session.
   *
   * Returns the new provider-native id and the path of the artifact it wrote,
   * so the caller can insert the database row before the filesystem watcher
   * notices the file and indexes it as an unrelated session.
   */
  forkSession(input: {
    providerSessionId: string;
    jsonlPath: string;
    /** The session's working directory — how providers scope a session lookup. */
    projectPath: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string }>;
}

// ---------------------------
//----------------- PROVIDER MODEL INTERFACE ------------
/**
 * Model catalog contract for one provider.
 *
 * Implementations supply CloudCLI's curated predefined models and can inspect
 * provider-native session state. The Providers service merges these immutable
 * source-controlled definitions with user-created SQLite rows at read time.
 */
export interface IProviderModels {
  /**
   * Returns the curated predefined catalog owned by this provider adapter.
   */
  getSupportedModels(): Promise<ProviderModelsDefinition>;

  /**
   * Reads the model the provider itself believes one session is running with.
   *
   * Only consulted for sessions the app has never recorded a model for — a
   * session started directly in the provider CLI, for example. Selecting a
   * model in the app is persisted on the session row instead, so adapters here
   * are read-only and must fall back to the catalog default when the
   * provider-specific lookup finds nothing.
   */
  getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel>;
}

// ---------------------------
//----------------- PROVIDER AUTH INTERFACE ------------
/**
 * Auth contract for one provider.
 *
 * Implementations should return a complete installation/authentication status
 * without throwing for normal "not installed" or "not authenticated" states.
 */
export interface IProviderAuth {
  /**
   * Checks whether the provider is installed and has usable credentials.
   */
  getStatus(): Promise<ProviderAuthStatus>;

  /**
   * Reads account-level quota and rate-limit status for this provider.
   *
   * Optional: providers without quota reporting simply omit it. Consumed by
   * the provider token-usage service (GET /providers/quota).
   */
  getQuota?(options?: { forceRefresh?: boolean }): Promise<ProviderQuotaData | null>;

  /**
   * Spends one of the account's quota-reset cards ("banked reset").
   *
   * Optional: only providers whose backend can both read and spend the cards
   * implement it. The implementation picks the soonest-expiring available
   * card covering `resetType` itself — callers never handle card ids — and
   * reports the provider's own outcome wording through the result.
   */
  consumeQuotaReset?(
    input: ProviderQuotaResetConsumeInput,
  ): Promise<ProviderQuotaResetConsumeResult>;
}

// ---------------------------
//----------------- PROVIDER SKILLS INTERFACE ------------
/**
 * Skills contract for one provider.
 *
 * Implementations discover provider-native skill markdown locations and return
 * normalized skill records with the exact command syntax expected by that
 * provider. Each skill is read from a `SKILL.md` file under its skill directory.
 */
export interface IProviderSkills {
  /**
   * Lists all skills visible to this provider for the optional workspace.
   */
  listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]>;

  /**
   * Writes one or more global user-scoped skills for this provider.
   *
   * Implementations should install the supplied markdown entries into the
   * provider's writable user skill folder and return the normalized skill
   * records that were written.
   */
  addSkills(input: ProviderSkillCreateInput): Promise<ProviderSkill[]>;

  removeSkill(
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: LLMProvider; directoryName: string }>;
}

// ---------------------------
//----------------- PROVIDER MCP INTERFACE ------------
/**
 * MCP contract for one provider.
 *
 * Implementations must map provider-native MCP config formats to shared
 * `ProviderMcpServer` records used by routes and frontend state.
 */
export interface IProviderMcp {
  /**
   * What this provider's MCP config format supports. Declared rather than
   * inferred: the server form used to decide it by comparing provider ids,
   * which is how Cursor lost its working-directory field despite writing one.
   */
  readonly capabilities: ProviderMcpCapabilities;
  listServers(options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>>;
  listServersForScope(scope: McpScope, options?: { workspacePath?: string }): Promise<ProviderMcpServer[]>;
  upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer>;
  removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }>;
}

// ---------------------------
//----------------- PROVIDER SESSION INTERFACE ------------
/**
 * Session/history contract for one provider.
 *
 * Implementations normalize provider-specific events and message history into
 * shared transport shapes consumed by API routes and realtime streams.
 */
export interface IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  /**
   * Clears incomplete real-time state after a provider runtime reaches a final
   * outcome without emitting its normal completion event.
   */
  resetLiveMessageState?(sessionId: string): void;
  fetchHistory(sessionId: string, options?: FetchHistoryOptions): Promise<FetchHistoryResult>;
  cleanupSession?(nativeSessionId: string, jsonlPath?: string | null): Promise<boolean>;
  cleanupProjectStorage?(projectPath: string): Promise<void>;

  /**
   * Reads the latest token-usage snapshot for one provider-native session.
   *
   * Optional: providers that cannot report usage omit it; the provider
   * token-usage service then answers with an explicit unsupported result.
   * Implementations own their native storage layout end to end and throw a
   * provider-prefixed 404 AppError when the session cannot be found.
   */
  getTokenUsage?(input: ProviderSessionUsageInput): Promise<ProviderTokenUsageResult>;


  /**
   * Resolves where a conversation must resume from so that the turn identified
   * by `anchorId`, and everything after it, is replaced.
   *
   * `resumeThroughId` is the last transcript row to KEEP — resuming is
   * inclusive of it — or `null` when the edited turn is the first prompt and
   * the conversation should start over. `found` is false when `anchorId` is not
   * in the transcript, which the caller must report rather than guess at.
   *
   * Implemented only by providers whose transcripts have stable per-row
   * identity; its absence is what makes "edit this message" unavailable.
   */
  resolveEditAnchor?(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null }>;

  /**
   * Rewinds the session so `keepThroughId` is the last row of its
   * conversation, and points the session at whatever provider session now
   * holds it. `null` keeps nothing: the conversation starts over.
   *
   * Implemented only by providers whose runtime cannot resume a transcript
   * partway and have to branch instead. Codex is one — it has no
   * resume-at-a-row, so the rewind is a `thread/fork` that leaves the pre-edit
   * thread on disk and moves the session onto the copy. Providers that can
   * resume partway leave this undefined, and the anchor is handed to their
   * runtime as a resume option instead; that is the difference the edit
   * gateway branches on.
   */
  rewindSession?(sessionId: string, keepThroughId: string | null): Promise<void>;

  /**
   * Reads what one agent of a workflow run did, from the transcript the run
   * wrote for it, with the status its journal gives it. Returns `null` when the
   * run left no transcript for that agent.
   *
   * Implemented only by providers whose runtime spawns workflow agents; its
   * absence is what makes an agent's timeline unavailable in the card.
   */
  readWorkflowAgentActivity?(
    sessionId: string,
    runId: string,
    agentId: string,
  ): Promise<WorkflowAgentActivity | null>;
}

// ---------------------------
//----------------- PROVIDER SESSION SYNCHRONIZER INTERFACE ------------
/**
 * Session indexing contract for one provider.
 *
 * Implementations scan provider-specific session artifacts on disk and upsert
 * normalized session metadata into the database. The service layer uses this
 * interface for both full rescans and single-file incremental sync triggered
 * by filesystem watcher events.
 */
export interface IProviderSessionSynchronizer {
  /**
   * Declares the filesystem location of this provider's session artifacts and
   * which files there should trigger synchronization.
   *
   * The sessions watcher derives its watch roots and event routing from this
   * declaration; implementations reuse the same predicate inside
   * `synchronizeFile` so the artifact layout is stated exactly once.
   */
  getSessionWatchTarget(): ProviderSessionWatchTarget;

  /**
   * Scans provider session artifacts and upserts discovered sessions into DB.
   */
  synchronize(since?: Date): Promise<number>;

  /**
   * Parses and upserts one provider artifact file without running a full scan.
   */
  synchronizeFile(filePath: string): Promise<string | null>;

  /**
   * Optionally returns every lifecycle fact from one file-level synchronization.
   * Providers that only upsert sessions omit this; the orchestration layer then
   * derives the equivalent single updated id from `synchronizeFile`.
   */
  synchronizeFileWithLifecycle?(filePath: string): Promise<ProviderSessionFileSynchronizationDelta>;
}
