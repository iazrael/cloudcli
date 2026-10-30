import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { ImageMediaSource } from '../../shared/protocol/imageMedia.js';
import type { PathExistenceRequest, PathExistenceResult } from '../../shared/protocol/pathExistence.js';

//----------------- HTTP RESPONSE SHAPES ------------
/**
 * Canonical success envelope used by backend APIs that return a structured payload.
 *
 * Use this for route handlers that need a stable `success/data` shape so frontend
 * consumers can parse responses consistently across endpoints.
 */
export type ApiSuccessShape<TData = unknown> = {
  success: true;
  data: TData;
};

/**
 * Generic plain-object record used when parsing loosely typed JSON payloads.
 *
 * Use this only after runtime shape checks, not as a replacement for validated
 * domain models.
 */
export type AnyRecord = Record<string, any>;

// ---------------------------
//----------------- WEBSOCKET TRANSPORT TYPES ------------
/**
 * Minimal websocket client contract used by backend broadcaster services.
 *
 * Any transport object added to `connectedClients` must implement these two
 * members so shared services can safely send JSON strings and check whether the
 * socket is still open before broadcasting.
 */
export type RealtimeClientConnection = {
  readyState: number;
  send(data: string): void;
};

/**
 * Authenticated user payload attached to websocket upgrade requests.
 *
 * Platform and OSS auth flows currently use either `id` or `userId`; both are
 * represented here so websocket handlers can resolve a stable writer user id.
 */
export type AuthenticatedWebSocketUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

/**
 * HTTP upgrade request shape after websocket authentication succeeds.
 *
 * `verifyClient` populates `request.user` with the authenticated payload, and
 * downstream websocket handlers rely on this extended request type.
 */
export type AuthenticatedWebSocketRequest = IncomingMessage & {
  user?: AuthenticatedWebSocketUser;
};

// ---------------------------
//----------------- PROVIDER MESSAGE MODEL ------------
/**
 * The wire contract lives in `shared/protocol/chatEvents.ts` so the client
 * cannot declare a second, drifting copy of it. Imported as well as re-exported
 * because the declarations below refer to these types by name.
 */
import type { McpScope, McpTransport } from '../../shared/protocol/capabilities.js';
import type {
  ProviderQuotaBucket as QuotaBucketShape,
  ProviderQuotaData as QuotaDataShape,
  ProviderQuotaGroup as QuotaGroupShape,
} from '../../shared/protocol/quota.js';
import type {
  ActiveBackgroundTask,
  BackgroundTaskSummary,
  CompactionInfo,
  GatewayEventKind,
  LLMProvider,
  MemoryCitation,
  MessageKind,
  NormalizedMessage,
  ServerEventKind,
  SessionRemovedEvent,
  SessionUpsertedEvent,
  SessionUpsertedProject,
  SubagentActivity,
  SubagentInfo,
  TaskUsage,
  WorkflowAgentActivity,
  WorkflowAgentInfo,
  WorkflowAgentProgress,
  WorkflowInfo,
} from '../../shared/protocol/chatEvents.js';

export type {
  ActiveBackgroundTask,
  BackgroundTaskSummary,
  CompactionInfo,
  GatewayEventKind,
  LLMProvider,
  MemoryCitation,
  MessageKind,
  NormalizedMessage,
  ServerEventKind,
  SessionRemovedEvent,
  SessionUpsertedEvent,
  SessionUpsertedProject,
  SubagentActivity,
  SubagentInfo,
  TaskUsage,
  WorkflowAgentActivity,
  WorkflowAgentInfo,
  WorkflowAgentProgress,
  WorkflowInfo,
};


/**
 * One session's outstanding background work, the unit a runtime's
 * `listBackgroundWork()` returns and the background-work registry lists:
 * `sessionId` is the app session id, `tasks` what it still waits on.
 */
export type SessionBackgroundWork = {
  sessionId: string;
  tasks: BackgroundTaskSummary[];
  /**
   * When the work the entry stands for began, for an entry with no task to
   * date it: a report turn the engine runs on its own. The running-sessions
   * poll otherwise dates the entry by its earliest task.
   */
  startedAt?: number;
};

export type {
  McpScope,
  McpTransport,
  ProviderCapabilities,
  ProviderMcpCapabilities,
} from '../../shared/protocol/capabilities.js';

export type {
  ProviderQuotaBucket,
  ProviderQuotaData,
  ProviderQuotaGroup,
  ProviderQuotaGroupPartitioning,
  ProviderQuotaResetConsumeInput,
  ProviderQuotaResetConsumeResult,
  ProviderQuotaResetCredit,
  ProviderQuotaResetCredits,
} from '../../shared/protocol/quota.js';

/** Backwards-compatible aliases for Antigravity-specific callers */
export type AntigravityQuotaBucket = QuotaBucketShape;
export type AntigravityQuotaGroup = QuotaGroupShape;
export type AntigravityQuotaData = QuotaDataShape;

// ---------------------------
//----------------- PROVIDER SESSION TOKEN USAGE TYPES ------------
/**
 * Latest token-usage snapshot for one provider session, as served by
 * `GET /providers/sessions/:sessionId/token-usage`.
 *
 * Each provider sessions facet produces this shape from its own native
 * storage. `unsupported: true` marks providers that cannot report usage at
 * all (callers surface `message` instead of the counters); `total` carries
 * the context window when the provider knows it.
 */
export type ProviderTokenUsageResult = {
  used: number;
  total?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: {
    input: number;
    output: number;
  };
  unsupported?: boolean;
  message?: string;
};

/**
 * Session identity handed to `IProviderSessions.getTokenUsage`.
 *
 * Carries exactly what the app session row knows about a provider-native
 * session; every provider-specific storage detail stays inside the provider
 * adapter.
 */
export type ProviderSessionUsageInput = {
  /** App-facing session id; error messages address this id. */
  appSessionId: string;
  /** Provider-native session id (the app row's `provider_session_id`). */
  nativeSessionId: string;
  /** Indexed transcript path recorded on the app session row, when present. */
  jsonlPath: string | null;
  /** Workspace path recorded on the app session row, when present. */
  projectPath: string | null;
};

/**
 * Declares where one provider's session artifacts live on disk and which of
 * them should trigger synchronization.
 *
 * Consumed by the sessions watcher (which roots to watch, which file events
 * route to `IProviderSessionSynchronizer.synchronizeFile`) and reused by the
 * synchronizers themselves, so each provider states its artifact layout in
 * exactly one place. `rootPath` is watched recursively.
 */
export type ProviderSessionWatchTarget = {
  /** Directory holding this provider's session artifacts. */
  rootPath: string;
  /** Returns true when a file event under `rootPath` should trigger a sync. */
  isTargetFile(filePath: string): boolean;
};

/**
 * Lifecycle facts produced while synchronizing one provider artifact file.
 *
 * `updatedSessionId` is the CloudCLI app session id upserted from the watched
 * file; it is null when that file has no indexable top-level session.
 * `removedSessionIds` contains CloudCLI app session ids that transitioned to
 * archived during the same operation. Consumers must treat both collections as
 * idempotent deltas: a watcher can receive duplicate filesystem events, and
 * only the synchronizer can authoritatively determine an active-to-archived
 * transition.
 */
export type ProviderSessionFileSynchronizationDelta = {
  updatedSessionId: string | null;
  removedSessionIds: string[];
};

/**
 * One selectable model row in a provider model catalog.
 */
export type ProviderModelOption = {
  value: string;
  label: string;
  group?: string;
  description?: string;
  /** Stable SQLite row id used only by model-management actions. */
  recordId?: number;
  /** True for user-created rows; false for immutable CloudCLI defaults. */
  isCustom?: boolean;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
    /**
     * Marks effort tiers the provider CLI encodes as model-id suffixes
     * (antigravity's `gemini-3.7-flash-medium`) instead of a separate effort
     * flag. The antigravity models facet sets this on variant-family base
     * models; the antigravity runtime reads it to append the chosen tier to
     * the model id rather than passing `--effort`. Omitted for models that
     * take the CLI's own effort flag.
     */
    encoding?: 'model-suffix';
  };
};

/**
 * Provider model catalog returned by `GET /api/providers/:provider/models`.
 */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
  /**
   * Reasoning-effort levels a custom entry of this catalog may declare, weakest
   * first; empty for providers without effort support. The Providers service
   * sets it on merged catalogs from the capability matrix, so the model
   * library offers the same levels on every machine. Adapter catalogs omit it.
   */
  EFFORT_LEVELS?: string[];
  /**
   * The user's "use only my models" flag for this provider, set by the
   * Providers service on merged catalogs. While it is true and at least one
   * custom model exists, `OPTIONS` holds only custom models and `DEFAULT` is
   * the first of them; with no custom models the built-ins are listed anyway.
   * Adapter catalogs omit it.
   */
  CUSTOM_MODELS_ONLY?: boolean;
};

/**
 * One persisted custom-model row in the provider model library.
 *
 * Provider modules use this shape at the database boundary. Predefined models
 * never use this type because they remain source-controlled in provider
 * adapters. `modelId` is sent to the provider runtime, while `model` is the
 * user-supplied display name shown in pickers.
 */
export type CustomProviderModelRecord = {
  recordId: number;
  provider: LLMProvider;
  modelId: string;
  model: string;
  sortOrder: number;
  /** NULL for rows that never declared effort levels, including pre-existing rows. */
  effort: CustomProviderModelEffort | null;
};

/**
 * Reasoning-effort levels a user declared for one custom model.
 *
 * `values` holds unique, non-empty level ids drawn from the levels the
 * provider's predefined models declare, and is never empty (an empty
 * declaration is stored as NULL). `default`, when present, is one of `values`
 * and documents the level the provider applies when the composer sends
 * `Default`, mirroring `ProviderModelOption['effort'].default`.
 */
export type CustomProviderModelEffort = {
  values: string[];
  default?: string;
};

/**
 * User-editable values accepted when creating or changing a custom model.
 *
 * `id` must be the exact provider-facing model identifier and cannot contain
 * whitespace. `model` is a concise display name. The provider is supplied by
 * the route path so a row can never be moved across providers accidentally.
 */
export type CustomProviderModelInput = {
  id: string;
  model: string;
  /**
   * Optional reasoning-effort declaration. `undefined` leaves stored metadata
   * untouched on update (and stores none on create) so clients that predate
   * effort metadata keep working; `null` clears it.
   */
  effort?: CustomProviderModelEffort | null;
};

// ---------------------------
//----------------- PROVIDER ACTIVE MODEL TYPES ------------
/**
 * Provider-neutral result for the model that is actively driving a session or
 * provider runtime at the time of lookup.
 *
 * `model` must always be populated. Provider adapters should use the
 * provider-specific lookup method requested by the caller, and only fall back
 * to the provider catalog `DEFAULT` value when the active model cannot be read.
 */
export type ProviderCurrentActiveModel = {
  model: string;
};

/**
 * Where a resolved session model came from.
 *
 * `session` means the app has recorded a model for this session (the user
 * picked one, or the session has been sent on at least once) and that value is
 * authoritative. `provider` means the session predates any app-recorded model
 * and the value was read back from the provider's own session state — the case
 * for sessions started directly in a provider CLI. `default` means neither was
 * available and the catalog default is standing in.
 *
 * Routes surface this so the frontend can tell a real selection apart from a
 * placeholder without re-deriving the precedence chain.
 */
export type ProviderSessionModelSource = 'session' | 'provider' | 'default';

/**
 * The model one session runs with, its persisted reasoning effort when one has
 * been recorded, and where the model answer came from.
 *
 * Returned by `providerModelsService.resolveSessionModel` and used by the
 * `/models`, `/cost` and `/status` commands, the active-model route, and the
 * composer's model picker so every surface agrees on one answer.
 */
export type ProviderSessionModel = {
  provider: LLMProvider;
  sessionId: string | null;
  model: string;
  /** NULL means this session has not recorded an effort choice yet. */
  effort: string | null;
  source: ProviderSessionModelSource;
};











/**
 * Output gateway shared by WebSocket and SSE provider runs.
 *
 * Runtime adapters only depend on this structural surface, which keeps them
 * independent from the transport that ultimately delivers normalized events.
 */
export type ProviderRuntimeWriter = {
  send(data: unknown): void;
  setSessionId?(sessionId: string): void;
  userId?: string | number | null;
  isWebSocketWriter?: boolean;
};

export type ProviderPermissionDecision = {
  allow: boolean;
  updatedInput?: unknown;
  message?: string;
  rememberEntry?: unknown;
};

export type ProviderRuntimePermissionGateway = {
  resolve(requestId: string, decision: ProviderPermissionDecision): void;
  listPending(sessionId: string): unknown[];
};

//----------------- CODEX AUTOMATIC SESSION TITLES ------------
/**
 * Immutable identity captured after a successful normal user turn. Providers'
 * runtime, title scheduler and title client use it to reject late work after
 * thread replacement. `models` is the runtime's discovered catalog snapshot;
 * `initialPrompt` is supplied only when this turn created the native thread.
 */
export type CodexSessionTitleTarget = {
  appSessionId: string;
  nativeThreadId: string;
  /** Zero requests a manager-owned transient worker after a short chat connection. */
  generation: number;
  /** Manager record key when a transient worker serves a different app-session key. */
  residentKey?: string;
  workingDirectory: string;
  model: string;
  models: ProviderModelsDefinition;
  initialPrompt?: string;
};

// ---------------------------
//----------------- RESIDENT TASK BRIDGE ------------
/** Trusted process identity issued by providers and verified by task-continuations. */
export type TaskBridgeCredentialContext = {
  userId: string | number;
  appSessionId: string;
  generation: number;
};

/**
 * A tool invocation observed on the owning resident connection, never supplied
 * by the HTTP caller. Providers attach the current run capability only after
 * binding its native turn; task-continuations compares arguments and generation.
 */
export type TaskBridgeEngineCall = {
  appSessionId: string;
  generation: number;
  threadId: string;
  turnId: string | null;
  callId: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  runToken: string;
};

// ---------------------------
/**
 * Provider-scoped application capabilities supplied to a runtime for one run.
 *
 * Keeping these lookups outside concrete SDK/CLI adapters prevents the
 * adapters from importing services that resolve back through providerRegistry.
 */
export type ProviderRuntimeContext = {
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels(): Promise<ProviderModelsDefinition>;
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  /**
   * Publishes one event to a session outside any run.
   *
   * A provider that stays resident keeps working after its round ended — the
   * engine starts a turn of its own to report a background result. The
   * gateway owns the session's sequence numbers, audience and replay buffer,
   * so the runtime only supplies the event; the gateway decides where it goes.
   */
  publishSessionEvent?(appSessionId: string, message: NormalizedMessage): void;
  /**
   * Issues the narrow credential a resident process carries.
   *
   * A resident process outlives the round that started it, so it cannot
   * carry the round's capability; it carries a bridge credential instead,
   * and the host matches every call against the engine call it observed.
   */
  createBridgeCredential?(input: {
    userId: string;
    appSessionId: string;
    generation: number;
  }): { token: string } | null;
  /**
   * Revokes a bridge credential, for example when the process that carried
   * it is gone.
   */
  revokeBridgeCredential?(token: string): void;
  /**
   * Registers one MCP tool call the engine made.
   *
   * A resident process outlives the round that started it, so the host
   * cannot take the round's authority from the process. It takes it from the
   * engine call it observed, and this is how that call reaches the host.
   */
  registerEngineToolCall?(call: TaskBridgeEngineCall): void;
  /**
   * The engine's transcript file for an app session, or null when it is not
   * known yet. A runtime whose process outlives a turn reads it to notice
   * another process continuing the conversation in the meantime.
   */
  resolveTranscriptPath?(appSessionId: string): string | null;
  /** Optional provider hook for clearing incomplete real-time state at a terminal run outcome. */
  resetLiveMessageState?(sessionId: string): void;
  isProviderInstalled(): Promise<boolean>;
  /**
   * Builds the SDK query for a run. Production leaves this unset and the
   * runtime uses the SDK's own; tests supply a scripted stream so the hold
   * and background-work paths can be driven without a CLI process.
   */
  createQuery?: (input: { prompt: AsyncIterable<unknown>; options: AnyRecord }) => AsyncIterable<unknown> & {
    interrupt(): Promise<void>;
    stopTask?(taskId: string): Promise<void>;
  };
};

export type ProviderRunFunction = (
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
) => Promise<unknown>;

/**
 * Shared options used to fetch historical provider messages.
 *
 * Consumers should pass provider-specific lookup hints (`projectPath`) only
 * when the selected provider requires them.
 *
 * `providerSessionId` is the provider-native session id from the sessions
 * index (transcript file name / provider database key). Provider adapters
 * must use it — never the app-facing session id they were called with — when
 * matching transcript rows on disk, because app-created sessions use an
 * app-allocated id that the provider has never seen.
 */
export type FetchHistoryOptions = {
  projectPath?: string;
  limit?: number | null;
  offset?: number;
  providerSessionId?: string;
};

/**
 * Standardized response payload returned from provider history readers.
 *
 * Use this as the contract for APIs that return paginated conversation history.
 */
export type FetchHistoryResult = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
  tokenUsage?: unknown;
};

// ---------------------------
//----------------- PROVIDER SKILL TYPES ------------
/**
 * Scope where a provider skill definition was discovered.
 *
 * Provider skill adapters should use this to describe the origin of each
 * skill markdown file without leaking provider-specific folder names into route
 * contracts. `repo` is used for Codex repository lookup locations, while
 * `project` is used for providers that treat workspace-local skills as project
 * scoped.
 */
export type ProviderSkillScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

/**
 * Shared input accepted by provider skill listing operations.
 *
 * Routes pass `workspacePath` when a caller wants project/repository skills for
 * a specific folder. Providers should fall back to the backend process cwd when
 * this option is omitted.
 */
export type ProviderSkillListOptions = {
  workspacePath?: string;
};

/**
 * One supporting file bundled with an uploaded provider skill.
 *
 * `relativePath` is resolved below the installed skill directory and must never
 * be absolute or contain traversal segments. Text files may use `utf8`; binary
 * scripts and assets should use `base64` so JSON transport does not corrupt
 * their bytes.
 */
export type ProviderSkillCreateFile = {
  relativePath: string;
  content: string;
  encoding: 'utf8' | 'base64';
};

/**
 * One skill markdown payload submitted for provider-managed installation.
 *
 * `content` is the raw markdown body that will be written to `SKILL.md`.
 * `directoryName` lets callers control the target folder name explicitly when
 * they want stable filesystem paths that differ from the markdown front matter
 * `name` field. `fileName` is optional upload metadata used only as a final
 * fallback when no directory name or front matter name is present. `files`
 * carries scripts, references, and other files from a complete skill folder.
 */
export type ProviderSkillCreateEntry = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: ProviderSkillCreateFile[];
};

/**
 * Shared input accepted by provider skill creation operations.
 *
 * The service layer batches multiple skill definitions in one request. Each
 * entry can contain only markdown or a complete skill folder.
 */
export type ProviderSkillCreateInput = {
  entries: ProviderSkillCreateEntry[];
};

export type ProviderSkillRemoveInput = {
  directoryName: string;
};

/**
 * Normalized skill record returned by provider skill adapters.
 *
 * The `command` value is the exact invocation text the selected provider expects
 * for this skill. Claude plugin skills use a namespaced command such as
 * `/plugin-name:skill-name`, while Codex skills use the `$skill-name` form.
 * `sourcePath` points to the skill markdown file that produced the record so
 * callers can distinguish duplicate skill names across scopes.
 */
export type ProviderSkill = {
  provider: LLMProvider;
  name: string;
  description: string;
  command: string;
  scope: ProviderSkillScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
};

/**
 * Internal source descriptor consumed by shared provider skill discovery logic.
 *
 * Concrete provider adapters build these records from their native lookup rules.
 * The shared skills provider then scans `rootDir` for child skill markdown files
 * and uses `commandForSkill` or `commandPrefix` to produce the provider-specific
 * invocation command. Set `recursive` only when a provider stores skills under
 * arbitrary nested folders below the source root.
 */
export type ProviderSkillSource = {
  scope: ProviderSkillScope;
  rootDir: string;
  recursive?: boolean;
  commandPrefix?: '/' | '$';
  commandForSkill?: (skillName: string) => string;
  pluginName?: string;
  pluginId?: string;
};

// ---------------------------
//----------------- SHARED ERROR TYPES ------------
/**
 * Optional metadata used when constructing application-level errors.
 *
 * `statusCode` should reflect the HTTP response status, while `code` identifies
 * the stable machine-readable error category.
 */
export type AppErrorOptions = {
  code?: string;
  statusCode?: number;
  details?: unknown;
};

// ---------------------------
//----------------- MCP TYPES ------------


/**
 * Normalized MCP server model exposed to frontend and route handlers.
 *
 * Provider adapters should map provider-native config to this structure before
 * returning results.
 */
export type ProviderMcpServer = {
  provider: LLMProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

/**
 * Payload for create/update MCP server operations.
 *
 * Routes and services should accept this type, validate it, and then persist it
 * through provider-specific MCP repositories.
 */
export type UpsertProviderMcpServerInput = {
  name: string;
  scope?: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

// ---------------------------
//----------------- PROVIDER AUTH TYPES ------------
/**
 * Records that an API-key style credential is taking precedence over a
 * still-valid subscription login in `~/.claude/.credentials.json`.
 *
 * Claude Code always prefers `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` over
 * the OAuth login written by `claude /login`, so when both exist every request
 * is billed to the key (pay-as-you-go) rather than the subscription — usually
 * without the user realising it. The Claude auth provider fills this in so the
 * settings UI can say which variable won and where it was found; the fix
 * differs per source (unset the variable and restart the server for
 * `process_env`, edit the `env` block of `~/.claude/settings.json` for
 * `settings_file`). It is never set when the login in the credentials file is
 * missing or expired, because then nothing is being bypassed.
 */
export type ProviderAuthSubscriptionOverride = {
  /** The environment variable Claude Code is using instead of the login. */
  variable: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';
  /** Where that variable was found: the server process env or the settings.json env block. */
  source: 'process_env' | 'settings_file';
  /** Email recorded in the credentials file for the bypassed login, when known. */
  subscriptionEmail: string | null;
};

/**
 * Authentication status result returned by provider health checks.
 *
 * This shape is consumed by settings/status endpoints to report installation and
 * credential state for each provider.
 */
export type ProviderAuthStatus = {
  installed: boolean;
  provider: LLMProvider;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
  /**
   * Provider-suggested login command for the terminal-based login modal.
   *
   * Only providers whose login requires a resolved absolute engine path
   * (zcode: `node <engine-path> login`) populate it; the frontend falls back
   * to its own static per-provider command when absent.
   */
  loginCommand?: string | null;
  /**
   * Present only when `method` is `api_key` and a valid subscription login is
   * being bypassed; see ProviderAuthSubscriptionOverride. Omitted otherwise so
   * existing consumers that never look for it are unaffected.
   */
  subscriptionOverride?: ProviderAuthSubscriptionOverride;
};

// ---------------------------
//----------------- SHARED DATABASE CREDENTIAL TYPES ------------
/**
 * Safe credential view returned by credential listing APIs.
 *
 * This intentionally excludes the raw credential secret while still exposing
 * metadata needed for UI rendering and management operations.
 */
export type CredentialPublicRow = {
  id: number;
  credential_name: string;
  credential_type: string;
  description: string | null;
  created_at: string;
  is_active: number;
};

/**
 * Result returned after creating a credential record.
 *
 * Use this return shape when callers need the created id and display metadata,
 * but must never receive the stored secret value.
 */
export type CreateCredentialResult = {
  id: number | bigint;
  credentialName: string;
  credentialType: string;
};

// ---------------------------
//----------------- PROJECT PERSISTENCE TYPES ------------
/**
 * Canonical project row shape returned by the projects repository.
 *
 * Use this type whenever backend services need to pass around one database
 * project record without leaking raw SQL row typing across modules.
 */
export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
};

/**
 * Result category returned by `projectsDb.createProjectPath`.
 *
 * `created` means a fresh row was inserted, `reactivated_archived` means an
 * existing archived path was accepted and updated, and `active_conflict` means
 * an already-active path blocked project creation.
 */
export type CreateProjectPathOutcome =
  | 'created'
  | 'reactivated_archived'
  | 'active_conflict';

/**
 * Structured result returned by project-path upsert operations.
 *
 * Services should use this result to decide whether a request succeeded,
 * should return a conflict, or needs follow-up retrieval of row metadata.
 */
export type CreateProjectPathResult = {
  outcome: CreateProjectPathOutcome;
  project: ProjectRepositoryRow | null;
};

/**
 * Validation result for user-supplied workspace/project paths.
 *
 * `resolvedPath` is present only when validation succeeds. `error` is present
 * only when validation fails and is suitable for user-facing diagnostics.
 */
export type WorkspacePathValidationResult = {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
};

// ---------------------------
//----------------- GIT COMMAND EXECUTION AND WORKTREE MANAGEMENT ------------
/**
 * Captured output of one completed `git` invocation.
 *
 * Returned by `GitCommandRunner` and `GitProcessRunner` implementations so the
 * git and worktree services can read both streams without caring about
 * process plumbing.
 */
export type GitCommandResult = {
  stdout: string;
  stderr: string;
};

/**
 * Executes `git <args>` inside `cwd` and resolves with the captured output.
 *
 * All worktree services receive their git access through this contract so
 * tests can inject a fake runner instead of spawning real processes. The
 * promise must reject (with `stderr` attached when available) on a non-zero
 * exit code.
 */
export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

/**
 * Executes `command args...` inside `options.cwd` and resolves with the captured output.
 *
 * This is the `spawnAsync` shape the Git routes module injects into its typed
 * services (branch deletion, branch compare) so their tests can substitute a
 * fake runner. Like `GitCommandRunner`, the promise must reject on a non-zero
 * exit code, with `stderr` attached to the error when available.
 */
export type GitProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<GitCommandResult>;

/**
 * One entry parsed from `git worktree list --porcelain`.
 *
 * This is the raw repository-level view (path/HEAD/branch/flags) before any
 * enrichment with project links or ahead/behind counts. `branch` is null for
 * detached-HEAD worktrees.
 */
export type WorktreePorcelainEntry = {
  path: string;
  headSha: string | null;
  branch: string | null;
  isDetached: boolean;
  isLocked: boolean;
  isPrunable: boolean;
};

/**
 * Fully enriched worktree row served to the UI.
 *
 * Extends the porcelain entry with everything the Worktrees panel renders:
 * dirty-file count, ahead/behind relative to the base branch (the branch
 * checked out in the main worktree), last-commit metadata, and the CloudCLI
 * project row linked to the worktree directory (if one was registered).
 */
export type WorktreeDescriptor = {
  path: string;
  branch: string | null;
  headSha: string | null;
  isMain: boolean;
  isCurrent: boolean;
  isLocked: boolean;
  isDetached: boolean;
  changedFileCount: number;
  ahead: number;
  behind: number;
  lastCommitSubject: string | null;
  lastCommitDate: string | null;
  linkedProjectId: string | null;
  linkedProjectArchived: boolean;
};

/**
 * Response payload of `GET /api/worktrees`.
 *
 * `baseBranch` is the branch checked out in the main worktree — the merge
 * target offered by the UI. `worktrees` always lists the main worktree first.
 */
export type WorktreeListResult = {
  repositoryRoot: string;
  baseBranch: string | null;
  worktrees: WorktreeDescriptor[];
};

// ---------------------------
//----------------- WORKTREE SERVICE INPUTS AND RESULTS ------------
/**
 * Input accepted by the worktree-listing workflow.
 *
 * `projectPath` may point at the main checkout or any linked worktree. The
 * service uses Git to resolve the complete repository-level worktree list.
 */
export type ListWorktreesInput = {
  projectPath: string;
};

/**
 * Input accepted when creating a linked Git worktree.
 *
 * `branch` is checked out when it already exists, otherwise it is created from
 * `baseBranch`. When `baseBranch` is omitted, the main worktree branch is used.
 */
export type CreateWorktreeInput = {
  projectPath: string;
  branch: string;
  baseBranch?: string | null;
};

/**
 * Result of successfully creating a linked Git worktree.
 *
 * `createdBranch` distinguishes a new branch from an existing branch checkout,
 * allowing API clients to accurately describe what Git changed.
 */
export type CreateWorktreeResult = {
  worktreePath: string;
  branch: string;
  createdBranch: boolean;
};

/**
 * Result of atomically creating and registering a worktree for project use.
 *
 * The Worktrees application service compensates the Git creation if project
 * registration fails, so routes only receive this shape after both steps pass.
 */
export type CreateAndOpenWorktreeResult = CreateWorktreeResult & {
  project: WorktreeProjectView;
};

/**
 * Input accepted when registering an existing worktree as a CloudCLI project.
 *
 * The service verifies that `worktreePath` belongs to the repository containing
 * `projectPath` before it creates or restores any project record.
 */
export type OpenWorktreeInput = {
  projectPath: string;
  worktreePath: string;
};

/**
 * Project view returned after a worktree is opened in CloudCLI.
 *
 * This deliberately mirrors the project-selection payload used by the Projects
 * module so the frontend can switch to the worktree without another lookup.
 */
export type WorktreeProjectView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
  sessions: [];
  sessionMeta: { hasMore: false; total: 0 };
};

//--------------------------- SESSION WORKTREE PLACEMENT ------------
/**
 * The main checkout a linked git worktree belongs to, resolved from the
 * worktree directory itself.
 *
 * Produced by the Worktrees module's `resolveWorktreeHome` and consumed by the
 * session worktree placement policy, which reunifies engine sessions that an
 * engine (currently OpenCode) rebound from a project's main checkout into one
 * of its worktrees.
 */
export type WorktreeHome = {
  /** Absolute path of the repository's main worktree. */
  rootPath: string;
  /** Branch checked out in the linked worktree; null when detached. */
  branch: string | null;
};

/**
 * Async lookup from a session directory to the main checkout of the git
 * worktree it belongs to.
 *
 * Implementations must resolve to null (never throw) when the directory is not
 * a linked worktree — plain checkouts, missing directories, and non-repository
 * paths are all ordinary answers here, because every indexed session passes
 * through the lookup once per cache TTL.
 */
export type WorktreeHomeResolver = (directory: string) => Promise<WorktreeHome | null>;

/**
 * The worktree a session actually runs in, recorded alongside its owning
 * (main-checkout) project.
 *
 * Written by the session synchronizers after placement resolution and surfaced
 * to the frontend so the workspace header can label a reunified session with
 * its branch. Both fields are null for sessions running in their project's
 * main checkout.
 */
export type SessionWorktreeInfo = {
  path: string;
  branch: string | null;
};

// ---------------------------

/**
 * Input accepted when removing a linked Git worktree.
 *
 * `force` permits removal with local changes. `deleteBranch` requests
 * best-effort branch cleanup after the worktree directory is removed.
 */
export type RemoveWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  force?: boolean;
  deleteBranch?: boolean;
};

/**
 * Result of removing a linked Git worktree.
 *
 * `archivalError` reports best-effort project archival failure after Git has
 * already removed the worktree, allowing callers to represent partial success.
 */
export type RemoveWorktreeResult = {
  removedPath: string;
  branch: string | null;
  branchDeleted: boolean;
  archivedProjectId: string | null;
  archivalError: string | null;
};

/**
 * Input accepted when merging a linked worktree into the main worktree branch.
 *
 * The service verifies both worktrees are clean, supports squash and regular
 * merges, and may remove the source worktree after a successful merge.
 */
export type MergeWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  squash?: boolean;
  message?: string | null;
  removeAfterMerge?: boolean;
};

/**
 * Result of a completed worktree merge.
 *
 * `removedWorktree` is populated only when post-merge removal succeeds.
 * `cleanupError` reports failed optional removal without misrepresenting the
 * already-completed merge as a failure.
 */
export type MergeWorktreeResult = {
  mergedBranch: string;
  targetBranch: string;
  squash: boolean;
  removedWorktree: RemoveWorktreeResult | null;
  cleanupError: string | null;
};

// ---------------------------
//----------------- WORKTREE MODULE DEPENDENCY CONTRACTS ------------
/**
 * Filesystem capability required by the Worktrees module.
 *
 * Production wiring checks the real filesystem; unit tests provide a small
 * deterministic fake so worktree creation never touches developer directories.
 */
export type WorktreeFileSystem = {
  pathExists(candidatePath: string): Promise<boolean>;
};

/**
 * Project-management boundary consumed by Worktrees workflows.
 *
 * The Worktrees module uses this contract instead of importing Database or
 * Projects internals. Production adapters delegate through those modules'
 * `index.ts` barrels, while unit tests supply in-memory functions.
 */
export type WorktreeProjectGateway = {
  getProjectPathById(projectId: string): string | null;
  getProjectByPath(projectPath: string): ProjectRepositoryRow | null;
  createProject(input: {
    projectPath: string;
    customName: string;
  }): Promise<{
    outcome: 'created' | 'reactivated_archived';
    project: { projectId: string };
  }>;
  restoreProject(projectId: string): void | Promise<void>;
  archiveProject(projectId: string): void | Promise<void>;
};

/**
 * Complete application-service surface used by the Worktrees HTTP router.
 *
 * Routes parse transport values and call these functions; they do not import
 * repositories, filesystem adapters, Git runners, or individual service files.
 */
export type WorktreeServices = {
  resolveProjectPath(projectId: string): string;
  list(input: ListWorktreesInput): Promise<WorktreeListResult>;
  create(input: CreateWorktreeInput): Promise<CreateWorktreeResult>;
  createAndOpen(input: CreateWorktreeInput): Promise<CreateAndOpenWorktreeResult>;
  open(input: OpenWorktreeInput): Promise<WorktreeProjectView>;
  merge(input: MergeWorktreeInput): Promise<MergeWorktreeResult>;
  remove(input: RemoveWorktreeInput): Promise<RemoveWorktreeResult>;
};

// ---------------------------
//----------------- FILE TREE MODULE CONTRACTS ------------
/**
 * One filesystem item returned by the File Tree API.
 *
 * The service populates metadata without following symlinks and recursively
 * attaches `children` only while the requested depth permits traversal. The
 * frontend uses the absolute `path` as the stable identifier for editor and
 * file-operation requests.
 */
export type FileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  permissions: string;
  permissionsRwx: string;
  isSymlink?: boolean;
  children?: FileTreeNode[];
};

/**
 * Minimal directory-entry shape required during File Tree traversal.
 *
 * Production adapts Node `Dirent` objects to this structural contract. Tests
 * provide small handwritten entries and therefore never read real directories.
 */
export type FileTreeDirectoryEntry = {
  name: string;
  isDirectory(): boolean;
};

/**
 * Minimal file-stat shape used for tree metadata and delete decisions.
 *
 * The numeric mode is converted to octal and rwx strings for the UI. `lstat`
 * supplies symlink state while `stat` is used when deciding file versus folder
 * deletion behavior.
 */
export type FileTreeStats = {
  size: number;
  mtime: Date;
  mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Complete filesystem capability injected into File Tree services.
 *
 * The production composition root delegates these operations to Node's fs
 * APIs. Unit tests provide deterministic path-keyed fakes so service tests
 * cannot inspect, write, rename, or delete developer files.
 */
export type FileTreeFileSystem = {
  access(candidatePath: string): Promise<void>;
  stat(candidatePath: string): Promise<FileTreeStats>;
  lstat(candidatePath: string): Promise<FileTreeStats>;
  // Streamed rather than returned as an array so a directory with millions of
  // children is abandoned at the entry limit instead of being materialized.
  openDirectory(directoryPath: string): AsyncIterable<FileTreeDirectoryEntry>;
  realpath(candidatePath: string): Promise<string>;
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  makeDirectory(directoryPath: string, recursive: boolean): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  removeDirectory(directoryPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  createReadStream(filePath: string): Readable;
};

/**
 * Project lookup boundary consumed by File Tree workflows.
 *
 * File Tree services resolve DB-assigned project ids through this contract and
 * never import the Database module or its repositories directly.
 */
export type FileTreeProjectGateway = {
  getProjectPathById(projectId: string): string | null | Promise<string | null>;
};

/**
 * Workspace validation boundary used by filesystem browsing and folder creation.
 *
 * The injected validator enforces the configured workspace root and resolves
 * symlinks before the File Tree service exposes or mutates paths.
 */
export type FileTreeWorkspaceGateway = {
  rootPath: string;
  validatePath(candidatePath: string): Promise<WorkspacePathValidationResult>;
  /**
   * Resolves a path readable outside the workspace root — the system temp
   * directory and the Claude projects directory — or `null` when it is not
   * one. Read-only: the write policy is `validatePath` and it does not consult
   * this.
   */
  resolveReadOnlyRootPath(candidatePath: string): Promise<string | null>;
};

/**
 * Uploaded-file record passed from the Multer transport adapter into the File
 * Tree service.
 *
 * Transport-specific field names are normalized so upload workflows do not
 * depend on Express or Multer types.
 */
export type FileTreeUploadedFile = {
  originalName: string;
  temporaryPath: string;
  size: number;
  mimeType: string;
};

/**
 * Logger boundary for expected File Tree diagnostics.
 *
 * Production delegates to the server console. Unit tests use no-op or captured
 * loggers and never patch the global console singleton.
 */
export type FileTreeLogger = {
  error(message: string, error?: unknown): void;
};

/**
 * Required production dependencies for the File Tree application service.
 *
 * Filesystem, project lookup, workspace policy, MIME detection, concurrency,
 * and logging are all explicit so service construction has no hidden process,
 * repository, or machine-wide defaults.
 */
export type FileTreeServiceDependencies = {
  fileSystem: FileTreeFileSystem;
  projects: FileTreeProjectGateway;
  workspace: FileTreeWorkspaceGateway;
  resolveMimeType(filePath: string): string;
  fileSystemConcurrency: number;
  logger: FileTreeLogger;
  /**
   * Absolute directory roots the service may read text files from outside any
   * project. Populated by the composition root (currently the Antigravity
   * brain directories, so chat-linked plan documents can be opened read-only);
   * every path outside these roots is rejected with `PATH_NOT_ALLOWED`.
   */
  externalReadOnlyRoots: string[];
  /**
   * Optional resolver that returns the absolute worktree root directories for
   * a given project root. Used to allow dynamic read-only access to files inside
   * linked Git worktrees without relaxing project write boundaries.
   */
  resolveWorktreeRoots?: (projectRoot: string) => Promise<string[]>;
};

/**
 * Complete File Tree application-service surface consumed by HTTP routes.
 *
 * Routes parse transport inputs and call these methods; they never resolve
 * project repositories, validate filesystem ownership, or perform filesystem
 * mutations themselves.
 */
export type FileTreeServices = {
  browseWorkspace(inputPath: string | null): Promise<{
    path: string;
    suggestions: Array<{ path: string; name: string; type: 'directory' }>;
  }>;
  createWorkspaceFolder(folderPath: string): Promise<{ success: true; path: string }>;
  readTextFile(projectId: string, filePath: string): Promise<{ content: string; path: string }>;
  /**
   * Reads a text file outside any project root. The path must resolve inside
   * one of the injected `externalReadOnlyRoots`, or within a linked worktree of
   * `projectId` when provided; there is deliberately no write counterpart, so
   * external files can never be modified through the API.
   */
  readExternalTextFile(filePath: string, projectId?: string): Promise<{ content: string; path: string }>;
  /**
   * Opens a stream for a media or binary file outside any project root. The path
   * must resolve inside one of the injected `externalReadOnlyRoots`, or within a
   * linked worktree of `projectId` when provided.
   */
  openExternalFile(filePath: string, projectId?: string): Promise<{ contentType: string; stream: Readable }>;
  /** 媒体检查重新校验项目和外部目录的规范路径，不创建传输流。 */
  resolveImagePath(input: { path: string; projectId?: string; external: boolean }): Promise<{ path: string; contentType: string }>;
  openFile(projectId: string, filePath: string): Promise<{ contentType: string; stream: Readable }>;
  /**
   * Checks whether chat Markdown path references resolve under the same rules
   * as file reads without reading file contents. Absolute paths must sit
   * inside an external read-only root or a linked worktree, with the project
   * boundary as fallback when `projectId` is supplied; relative paths resolve
   * inside the project root. Never rejects for a single path: each item gets
   * one HTTP-style status as described on `FileTreePathExistenceResult`.
   */
  checkPathsExist(items: PathExistenceRequest[]): Promise<PathExistenceResult[]>;
  saveTextFile(projectId: string, filePath: string, content: string): Promise<{
    success: true;
    path: string;
    message: string;
  }>;
  listProjectFiles(
    projectId: string,
    options?: { respectGitignore: boolean },
  ): Promise<FileTreeNode[]>;
  createEntry(input: {
    projectId: string;
    parentPath: string;
    type: 'file' | 'directory';
    name: string;
  }): Promise<{ success: true; path: string; name: string; type: 'file' | 'directory'; message: string }>;
  renameEntry(input: { projectId: string; oldPath: string; newName: string }): Promise<{
    success: true;
    oldPath: string;
    newPath: string;
    newName: string;
    message: string;
  }>;
  deleteEntry(input: { projectId: string; targetPath: string }): Promise<{
    success: true;
    path: string;
    type: 'file' | 'directory';
    message: string;
  }>;
  storeUploadedFiles(input: {
    projectId: string;
    targetPath: string;
    relativePaths: string[];
    requestedFileCount: number;
    files: FileTreeUploadedFile[];
  }): Promise<{
    success: true;
    files: Array<{ name: string; path: string; size: number; mimeType: string }>;
    uploadedCount: number;
    requestedFileCount: number;
    targetPath: string;
    message: string;
  }>;
};

// ---------------------------
//----------------- VOICE MODULE CONTRACTS ------------
/**
 * Per-request voice settings parsed from authenticated HTTP headers.
 *
 * The Voice routes create this value from the optional `x-voice-*` headers and
 * pass it to the Voice service. Empty values mean "use the server-configured
 * default"; the backend base URL is intentionally absent because clients must
 * never control the server's outbound destination.
 */
export type VoiceRequestOverrides = {
  apiKey?: string;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: string;
};

/**
 * Uploaded audio accepted by the Voice transcription service.
 *
 * Routes translate Multer's transport-specific file object into this minimal
 * shape so the service does not depend on Express or Multer types.
 */
export type VoiceAudioUpload = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

/**
 * Successful speech payload returned by the Voice service.
 *
 * The route copies `contentType` to the client response and pipes `body`
 * without buffering the complete synthesized audio in application memory.
 */
export type VoiceSpeechPayload = {
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
};

/**
 * Explicit service result used by Voice routes instead of transport-aware
 * exceptions.
 *
 * Services return `ok: false` with the exact client status/message for expected
 * backend, validation, and timeout failures. Routes only translate the result
 * into HTTP output, while unexpected programming errors still reject normally.
 */
export type VoiceServiceResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; status: number; error: string };

/**
 * Complete application-service surface consumed by the Voice HTTP router.
 *
 * The composition root supplies a concrete implementation with environment
 * configuration and an injected outbound HTTP adapter. Unit tests use the same
 * contract with handwritten fetch fakes and never patch global state.
 */
export type VoiceService = {
  getHealth(): { configured: boolean };
  transcribe(input: {
    audio: VoiceAudioUpload;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<{ text: string }>>;
  synthesizeSpeech(input: {
    text: string;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<VoiceSpeechPayload>>;
};

// ---------------------------
//----------------- CLI MODULE CONTRACTS ------------
/**
 * Output boundary used by the CLI and Sandbox services.
 *
 * Production wiring delegates to the real console. Unit tests collect these
 * calls in arrays, which keeps command assertions deterministic and avoids
 * monkey-patching the global console singleton.
 */
export type CliOutput = {
  log(message?: string): void;
  error(message?: string): void;
};

/**
 * Minimal synchronous filesystem surface shared by CLI status reporting and
 * sandbox workspace validation.
 *
 * The production composition root adapts Node's filesystem module. Tests supply
 * path-keyed fakes, so service tests never inspect or modify the real machine.
 */
export type CliFileSystem = {
  pathExists(filePath: string): boolean;
  getFileStats(filePath: string): { size: number; modifiedAt: Date };
};

/**
 * Mutable environment view owned by the CLI application.
 *
 * CLI options update this object before the server starts. Production passes
 * `process.env`; tests pass a plain record to verify option precedence without
 * changing process-wide environment state.
 */
export type CliEnvironment = Record<string, string | undefined>;

/**
 * Package metadata displayed by CLI help, status, version, and update commands.
 *
 * The composition root reads this once from the application package file and
 * injects only the fields the service needs.
 */
export type CliPackageMetadata = {
  version: string;
  homepage?: string;
  bugsUrl?: string;
};

/**
 * Executable CLI application returned by the CLI composition root.
 *
 * The thin executable entrypoint passes `process.argv` arguments to `run` and
 * copies the returned code to `process.exitCode`. Tests invoke the same method
 * directly with isolated dependencies.
 */
export type CliApplication = {
  run(argumentsList: string[]): Promise<number>;
};

/**
 * Sandbox command service consumed by the top-level CLI command dispatcher.
 *
 * Keeping this behind one required dependency lets CLI tests use a tiny fake,
 * while focused Sandbox tests exercise subprocess and filesystem behavior with
 * their own handwritten adapters.
 */
export type SandboxCommandService = {
  execute(argumentsList: string[]): Promise<number>;
};

// ---------------------------
//----------------- DIAGNOSTICS MODULE CONTRACTS ------------

/**
 * Why one chat run stopped.
 *
 * This is the field that tells a "the session just died" report apart from a
 * "the user pressed stop" report. The engine's own transcript on disk records
 * only that its turn was interrupted — it cannot say who interrupted it — so
 * without this the two are indistinguishable after the fact.
 *
 * - `engine_completed`: the runtime streamed its own terminal `complete` with
 *   exit code 0.
 * - `engine_failed`: the runtime ended with a non-zero exit code, or reported
 *   an error before it ended.
 * - `client_abort`: a browser sent `chat.abort` (the stop button, or the
 *   global Escape key).
 * - `superseded`: a new turn (a scheduled message) deliberately cancelled the
 *   run that was still in progress.
 * - `dispatch_failed`: the dispatch threw before any engine `complete`
 *   arrived, so the terminal event was synthesized on the runtime's behalf.
 */
export type RunOutcomeReason =
  | 'engine_completed'
  | 'engine_failed'
  | 'client_abort'
  | 'superseded'
  | 'dispatch_failed';

/**
 * What the diagnostics module records when a run ends, and what the
 * diagnostics route hands back.
 *
 * Deliberately free of message content: identifiers, timings and counters
 * only, so the log can be exported from the UI and attached to a bug report
 * without leaking a conversation.
 */
export type RunOutcome = {
  sessionId: string;
  provider: LLMProvider;
  reason: RunOutcomeReason;
  exitCode: number;
  startedAtIso: string;
  endedAtIso: string;
  durationMs: number;
  /** How many live events the run emitted, as a rough measure of its size. */
  eventCount: number;
  /** The session's sequence watermark when the run ended. */
  lastSeq: number;
};

// ---------------------------
//----------------- ASYNC TASK CONTINUATION TYPES ------------

/**
 * Execution status of an asynchronous local task.
 */
export type AsyncTaskExecutionStatus =
  | 'registered'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Delivery lifecycle status for a task continuation notification event.
 */
export type TaskContinuationEventStatus =
  | 'pending'
  | 'claimed'
  | 'sending'
  | 'accepted'
  | 'delivered'
  | 'reply_failed'
  | 'uncertain'
  | 'needs_review'
  | 'cancelled';

/**
 * Database record representing an asynchronous task.
 */
export type AsyncTaskRecord = {
  task_id: string;
  user_id: number;
  session_id: string;
  run_id: string | null;
  provider_thread_id: string | null;
  session_project_path: string | null;
  working_directory: string | null;
  sandbox_policy_type: 'workspaceWrite' | 'dangerFullAccess' | null;
  network_access: number | null;
  approval_policy: 'never' | 'on-request' | null;
  title: string;
  command: string | null;
  registration_key: string | null;
  auto_notify: number;
  notification_cancelled_at: string | null;
  notification_cancelled_reason: string | null;
  status: AsyncTaskExecutionStatus;
  exit_code: number | null;
  result_digest: string | null;
  result_path: string | null;
  result_summary: string | null;
  result_json: string | null;
  last_error: string | null;
  token_hash: string;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Database record representing a continuation outbox event.
 */
export type TaskContinuationEventRecord = {
  event_id: string;
  task_id: string;
  session_id: string;
  status: TaskContinuationEventStatus;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  lease_expires_at_ms: number | null;
  last_attempt_at: string | null;
  engine_turn_id: string | null;
  host_run_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

/** Trusted per-run permissions and identity used by the host task bridge. */
export type TaskRunCapabilityContext = {
  userId: number;
  sessionId: string;
  runId: string;
  providerThreadId: string | null;
  sessionProjectPath: string;
  cwd: string;
  sandboxPolicy: {
    type: 'workspaceWrite' | 'dangerFullAccess';
    networkAccess: boolean;
  };
  approvalPolicy: 'never' | 'on-request';
};

/** Authenticated ownership boundary for task management requests. */
export type TaskAccessScope = {
  userId: number;
  sessionId?: string;
};

/** Result of checking the task's original owner, workspace, provider and runtime state. */
export type TaskContinuationTargetCheck =
  | { outcome: 'ready' }
  | { outcome: 'busy'; reason: string }
  | { outcome: 'invalid'; reason: string };

/**
 * History is evidence, not a delivery guess. `found: false` means the checker
 * cannot prove a result, so callers must not blindly resend. `inProgress` keeps
 * an accepted turn under observation; `paused` means the original target is archived.
 */
export type TaskContinuationHistoryCheck = {
  found: boolean;
  engineTurnId?: string | null;
  status?: 'completed' | 'failed' | 'interrupted' | 'inProgress' | 'paused';
};

export type TaskHistoryChecker = (eventId: string) => Promise<TaskContinuationHistoryCheck>;

/**
 * Input for registering a new async task.
 */
export type RegisterAsyncTaskInput = {
  taskId: string;
  userId: number;
  sessionId: string;
  runId?: string | null;
  providerThreadId?: string | null;
  sessionProjectPath?: string | null;
  workingDirectory?: string | null;
  sandboxPolicyType?: 'workspaceWrite' | 'dangerFullAccess' | null;
  networkAccess?: boolean | null;
  approvalPolicy?: 'never' | 'on-request' | null;
  title: string;
  command?: string | null;
  registrationKey?: string | null;
  autoNotify?: boolean;
  tokenHash: string;
  tokenExpiresAt?: string | null;
};

/**
 * Input for completing an async task and writing to transactional outbox.
 */
export type RecordTaskCompletionInput = {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  exitCode?: number | null;
  resultDigest: string;
  resultPath?: string | null;
  resultSummary?: string | null;
  resultJson?: string | null;
};

/**
 * Result of completing a task.
 */
export type RecordTaskCompletionResult = {
  taskId: string;
  eventId: string | null;
  status: AsyncTaskExecutionStatus;
  isDuplicate: boolean;
};

/**
 * Parameters for claiming a pending continuation event.
 */
export type ClaimPendingEventInput = {
  leaseOwner: string;
  leaseDurationMs: number;
  /** Injected by deterministic lease tests; production callers should omit it. */
  nowMs?: number;
};

// ---------------------------
//----------------- CHAT DRAFT QUEUE TYPES ------------
/**
 * A chat message queued to be sent when its session is next idle, in the shape
 * the composer submits it and `session_drafts.queued_message` stores it.
 *
 * `content` is the message text, `attachments` the JSON-safe descriptors
 * returned by POST /api/assets/files, and `options` the composer's send options
 * (model, effort, permission mode, ...) captured when it was queued. A session
 * has at most one: a message queued while another is waiting is merged into it
 * by the drafts repository. The User module accepts it, the Database module
 * stores and merges it, and the Scheduled Messages dispatcher sends it (read
 * through `readQueuedChatMessage`).
 */
export type QueuedChatMessage = {
  content: string;
  options?: Record<string, unknown>;
  attachments: unknown[];
};

//----------------- SIGNED IMAGE MEDIA ------------
/** 媒体服务、HTTP 路由和前端共用的持久图片引用。 */
export type { ImageMediaSource, ImageMediaRequest, ImageMediaResult } from '../../shared/protocol/imageMedia.js';
export type { PathExistenceRequest, PathExistenceResult } from '../../shared/protocol/pathExistence.js';

/** 规范化图片元数据；来源经过 realpath 和文件边界校验，检查阶段不创建传输流。 */
export type ImageMediaFile = {
  source: ImageMediaSource;
  contentType: string;
  etag: string;
  size: number;
};

/** 媒体服务依赖，由生产装配或文件及账号测试适配器提供；时间单位为 Unix 秒。 */
export type ImageMediaDependencies = {
  secret: string;
  now?: () => number;
  userExists: (id: string) => boolean | Promise<boolean>;
  resolveImage: (source: ImageMediaSource) => Promise<ImageMediaFile>;
  openImage: (file: ImageMediaFile) => Promise<Readable>;
};
