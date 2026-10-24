/**
 * What one provider integration can actually do, as served by
 * `GET /api/providers/capabilities`.
 *
 * The frontend renders its affordances from this shape and must never decide a
 * capability by comparing provider ids: a quota card once compared a display
 * label against a provider id and silently disabled itself for good.
 *
 * Defined once for both sides. `ProviderCapabilities` previously existed in
 * `provider-capabilities.service.ts` and `useProviderCapabilities.ts` with the
 * two lists already disagreeing, and `McpScope` / `McpTransport` existed three
 * times over.
 */

import type { LLMProvider } from './chatEvents.js';

/**
 * How far into a busy session a new message can reach the engine without
 * killing the work in flight. Anything the engine cannot take is held in the
 * composer's queue until the session settles.
 *
 * - `queue`: neither a running turn nor background work takes input; sending
 *   would restart the engine process.
 * - `background`: once the turn has ended, a message goes straight into the
 *   live process that still holds background work (Claude). A running turn
 *   still queues.
 * - `always`: a running turn absorbs the message at its next step, so it is
 *   sent at once (OpenCode). Requires the runtime's `injectInput` primitive.
 */
export type ProviderInputWhileBusy = 'queue' | 'background' | 'always';

/** Where a provider can install an MCP server. */
export type McpScope = 'user' | 'local' | 'project';

/** How a provider can talk to an MCP server. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * What a provider's MCP configuration format supports.
 *
 * Every field answers a question the server-form UI used to answer by checking
 * the provider's name. Each provider's MCP facet declares its own values, so a
 * config format that grows a field announces it here instead of the form
 * growing another branch.
 */
export type ProviderMcpCapabilities = {
  scopes: McpScope[];
  transports: McpTransport[];
  /** Whether a server entry can carry a working directory. */
  supportsWorkingDirectory: boolean;
  /**
   * Whether values can be named as environment variables to resolve at launch
   * rather than inlined. Only Codex's format has this indirection
   * (`env_vars`, `bearer_token_env_var`, `env_http_headers`); plain `env` and
   * plain HTTP `headers` are written by every provider and need no flag.
   */
  supportsEnvVarIndirection: boolean;
};

/** Backend-owned description of one provider integration. */
export type ProviderCapabilities = {
  provider: LLMProvider;
  permissionModes: string[];
  defaultPermissionMode: string;
  supportsImages: boolean;
  supportsFiles: boolean;
  supportsAbort: boolean;
  supportsPermissionRequests: boolean;
  supportsTokenUsage: boolean;
  /**
   * Whether the provider can report the account's plan allowance (the 5-hour
   * and weekly limits), as opposed to the per-session token counts
   * `supportsTokenUsage` covers.
   */
  supportsQuota: boolean;
  /**
   * Whether the provider can also *spend* a quota-reset card ("banked reset"),
   * not just report quota. Only meaningful together with `supportsQuota` and
   * a non-empty `resetCredits` payload.
   */
  supportsQuotaReset: boolean;
  supportsEffort: boolean;
  /**
   * Reasoning-effort levels the runtime can pass on, weakest first, and so the
   * levels a custom model-library entry may declare. Empty exactly when
   * `supportsEffort` is false. Covers every level a predefined model declares
   * (a providers test enforces this) and, unlike the model catalog, does not
   * depend on which upstream providers this machine has connected.
   */
  effortLevels: string[];
  /**
   * Whether an already-sent message can be replaced, which requires the
   * provider to re-run a conversation truncated at a chosen point.
   */
  supportsMessageEditing: boolean;
  /** Whether a session's transcript can be branched into an independent one. */
  supportsSessionForking: boolean;
  /**
  /**
   * Whether the `/compact` chat command summarizes the conversation and frees
   * up the engine's context window. The composer offers the command only when
   * this is true; the runtimes that cannot parse the text themselves turn it
   * into their engine's own compaction call.
   */
  supportsCompaction: boolean;
  /**
   * Whether the engine has its own session-scoped scheduling layer (Claude's
   * CronCreate/ScheduleWakeup, which CloudCLI keeps alive by holding the CLI
   * process open). CloudCLI's scheduled jobs work for every provider; this
   * flag only drives the hint shown when a job is bound to a session whose
   * engine already schedules inside itself.
   */
  supportsNativeScheduling: boolean;
  /**
   * Whether replacing an already-sent message also reverts the files the
   * agent changed, so the composer warns about it. Static per provider: a
   * transcript either has file side effects to undo (OpenCode's revert) or
   * does not (Claude's resume, Codex's fork).
   */
  editRevertsFiles: boolean;
  /** What happens to a message sent while the session is busy; see `ProviderInputWhileBusy`. */
  inputWhileBusy: ProviderInputWhileBusy;
  mcp: ProviderMcpCapabilities;
};
