/**
 * Fallback mirror of each provider's backend-declared MCP capabilities
 * (their `McpProvider` subclass constructor).
 *
 * The backend is the source of truth and reaches the UI through the capability
 * matrix; this mirror only covers first paint and a failed capabilities
 * request. It is pinned to the backend by the cross-tree parity test
 * (`server/modules/providers/tests/provider-capabilities.test.ts`), because the
 * three separate tables this replaces had no such guard and had already gone
 * stale: Cursor writes a working directory but its table said otherwise, so the
 * field was hidden from Cursor users.
 *
 * Zero imports of app code on purpose: the parity test reads this file from the
 * server tree, where the frontend `@` alias does not resolve.
 */
export const MCP_FALLBACK_CAPABILITIES = {
  claude: {
    scopes: ['user', 'local', 'project'],
    transports: ['stdio', 'http', 'sse'],
    supportsWorkingDirectory: false,
    supportsEnvVarIndirection: false,
  },
  cursor: {
    scopes: ['user', 'project'],
    transports: ['stdio', 'http'],
    supportsWorkingDirectory: true,
    supportsEnvVarIndirection: false,
  },
  codex: {
    scopes: ['user', 'project'],
    transports: ['stdio', 'http'],
    supportsWorkingDirectory: true,
    supportsEnvVarIndirection: true,
  },
  opencode: {
    scopes: ['user', 'project'],
    transports: ['stdio', 'http'],
    supportsWorkingDirectory: false,
    supportsEnvVarIndirection: false,
  },
  zcode: {
    scopes: ['user', 'project'],
    transports: ['stdio', 'http'],
    supportsWorkingDirectory: false,
    supportsEnvVarIndirection: false,
  },
  antigravity: {
    scopes: ['user', 'project'],
    transports: ['stdio', 'http', 'sse'],
    supportsWorkingDirectory: false,
    supportsEnvVarIndirection: false,
  },
} as const;
