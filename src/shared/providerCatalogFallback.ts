/**
 * Frontend fallback mirror of the backend provider capability catalog
 * (server/modules/providers/services/provider-capabilities.catalog.ts).
 *
 * The backend catalog is the source of truth; this mirror exists so the
 * composer renders sensible defaults on first paint and when the
 * capabilities request fails. Its values are pinned to the backend catalog
 * by the cross-tree parity test
 * (server/modules/providers/tests/provider-catalog-parity.test.ts), so a
 * backend capability or default-model change that forgets this file fails
 * CI instead of shipping stale first-paint values — three default models
 * had already drifted exactly that way before the test existed.
 *
 * Zero imports on purpose: the parity test compiles this file from the
 * server tree, where the frontend `@` alias does not resolve.
 *
 * Consumers: useChatProviderState (fallback defaults + the provider order
 * used for catalog fetches and localStorage validation). The provider
 * order declared by this object's key order is the app-wide canonical one.
 */

export const PROVIDER_FALLBACK_CATALOG = {
  claude: {
    defaultModel: 'default',
    permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  },
  cursor: {
    defaultModel: 'auto',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  },
  codex: {
    defaultModel: 'gpt-5.6-sol',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
  },
  opencode: {
    defaultModel: 'opencode/gpt-5.6-terra',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  },
  zcode: {
    defaultModel: 'GLM-5.3',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  },
  antigravity: {
    defaultModel: 'gemini-3.7-flash',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  },
};

export type ProviderCatalogId = keyof typeof PROVIDER_FALLBACK_CATALOG;

/** Canonical provider order (the catalog's key order). */
export const PROVIDER_FALLBACK_ORDER = Object.keys(PROVIDER_FALLBACK_CATALOG) as ProviderCatalogId[];
