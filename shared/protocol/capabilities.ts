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
  supportsEffort: boolean;
  /**
   * Whether an already-sent message can be replaced, which requires the
   * provider to re-run a conversation truncated at a chosen point.
   */
  supportsMessageEditing: boolean;
  /** Whether a session's transcript can be branched into an independent one. */
  supportsSessionForking: boolean;
  /**
   * Whether the engine has its own session-scoped scheduling layer (Claude's
   * CronCreate/ScheduleWakeup, which CloudCLI keeps alive by holding the CLI
   * process open). CloudCLI's scheduled jobs work for every provider; this
   * flag only drives the hint shown when a job is bound to a session whose
   * engine already schedules inside itself.
   */
  supportsNativeScheduling: boolean;
  mcp: ProviderMcpCapabilities;
};
