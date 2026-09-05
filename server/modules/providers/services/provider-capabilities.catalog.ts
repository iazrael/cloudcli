import type { LLMProvider } from '@/shared/types.js';

/**
 * Static provider capability catalog: the declaration point for everything
 * about a provider that CANNOT be derived from its registered facets —
 * permission modes (runtime vocabulary), the static fallback default model,
 * and the transport-level feature booleans (attachments, abort, effort).
 *
 * Everything that CAN be derived from the registered provider instance
 * (fork / message editing / token usage / interactive permissions) is
 * deliberately NOT here: `provider-capabilities.service.ts` derives those
 * from the provider's optional facets, so a facet added or removed flips the
 * capability automatically instead of waiting for this table to be edited.
 *
 * Zero runtime imports on purpose — only the type layer refers to shared
 * types via the importing modules. The cross-tree parity test imports this
 * file's plain literal object against the frontend's fallback tables, so the
 * two can never drift apart silently again.
 *
 * The `satisfies` clause on the export makes the compiler reject a catalog
 * that stops covering the registered provider union. The type-only import is
 * erased at runtime, so this file keeps zero runtime dependencies for the
 * cross-tree parity test.
 *
 * Consumers: provider-capabilities.service.ts (derives the public matrix
 * from this catalog plus the provider registry) and
 * server/modules/providers/tests/provider-capabilities.test.ts.
 */

export type ProviderCatalogEntry = {
  /** Permission modes the provider runtime understands, in cycle order. */
  permissionModes: readonly string[];
  defaultPermissionMode: string;
  /**
   * Static fallback default model, shown before the model catalog loads.
   * Must equal the provider's predefined models definition's `DEFAULT`
   * (pinned by the capability tests); zcode/antigravity resolve dynamic
   * catalogs at runtime and fall back to this same value.
   */
  defaultModel: string;
  /** Whether image attachments can be included in a chat.send. */
  supportsImages: boolean;
  /** Whether general file attachments can be included in a chat.send. */
  supportsFiles: boolean;
  /** Whether an in-flight run can be cancelled via chat.abort. */
  supportsAbort: boolean;
  /** Whether the provider runtime can accept model-level reasoning effort. */
  supportsEffort: boolean;
};

export const PROVIDER_CATALOG = {
  claude: {
    permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    defaultModel: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsEffort: true,
  },
  cursor: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    defaultModel: 'auto',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsEffort: false,
  },
  codex: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    defaultModel: 'gpt-5.6-sol',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsEffort: true,
  },
  opencode: {
    // Mapped by the runtime onto OpenCode's controls: `--agent plan` (plan),
    // `--auto` (bypassPermissions) and the OPENCODE_PERMISSION env var
    // (acceptEdits). See resolveOpenCodePermissionOptions in the OpenCode runtime adapter.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    defaultModel: 'opencode/gpt-5.6-terra',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsEffort: true,
  },
  zcode: {
    // Mapped by the runtime onto ZCode's session/setMode modes: build
    // (default), edit, plan and yolo. See PERMISSION_MODE_MAP in the
    // zcode runtime adapter.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    defaultModel: 'GLM-5.3',
    // Attachment parameters are not confirmed by the Phase 0 spike yet.
    supportsImages: false,
    supportsFiles: false,
    supportsAbort: true,
    supportsEffort: true,
  },
  antigravity: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    defaultModel: 'gemini-3.7-flash',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsEffort: true,
  },
} as const satisfies Readonly<Record<LLMProvider, ProviderCatalogEntry>>;
