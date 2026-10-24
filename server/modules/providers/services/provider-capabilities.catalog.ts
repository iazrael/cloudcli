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
   * Static providers keep this equal to their models definition's `DEFAULT`.
   * Codex uses the bundled CLI's discovered default once its catalog loads;
   * zcode/antigravity resolve their own dynamic catalogs at runtime.
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
  /**
   * Reasoning-effort levels the runtime can pass on, weakest first, and so the
   * levels a custom model-library entry may declare. Empty exactly when
   * `supportsEffort` is false.
   */
  effortLevels: readonly string[];
  /**
   * Whether a `/compact` prompt compacts the conversation. Claude, ZCode and
   * Antigravity parse the command from the prompt text themselves; the Codex
   * and OpenCode runtimes turn it into their engines' compaction calls.
   */
  supportsCompaction: boolean;
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
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    supportsCompaction: true,
  },
  cursor: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    defaultModel: 'auto',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsEffort: false,
    effortLevels: [],
    supportsCompaction: false,
  },
  codex: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    defaultModel: 'gpt-6.1-sol',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsEffort: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    supportsCompaction: true,
  },
  opencode: {
    // Mapped by the runtime onto the service: the read-only `plan` agent
    // (plan), session permission ask-rules (default), shell-ask only
    // (acceptEdits) and no rules (bypassPermissions, the engine default).
    // See resolveOpenCodeSessionSettings in the OpenCode session settings.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    defaultModel: 'opencode/gpt-5.6-terra',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsEffort: true,
    // Passed on as OpenCode's `--variant`. `thinking` (MiniMax's on/off
    // variant, paired with `none`) is not a strength, so it sorts last.
    effortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'thinking'],
    supportsCompaction: true,
  },
  zcode: {
    // Mapped by the runtime onto ZCode's session/setMode modes: build
    // (default), edit, plan and yolo. See PERMISSION_MODE_MAP in the
    // zcode runtime adapter.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    defaultModel: 'GLM-5.3',
    // Confirmed on engine 0.16.5: session/send takes native attachment items
    // ({kind, filename, mimeType, sizeBytes, localPath}); the runtime maps
    // app descriptors onto them. Whether an image reaches the model inline
    // still depends on the model's input modality.
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsEffort: true,
    effortLevels: ['low', 'high', 'max'],
    supportsCompaction: true,
  },
  antigravity: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    defaultModel: 'gemini-4-argon',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsEffort: true,
    effortLevels: ['low', 'medium', 'high'],
    supportsCompaction: true,
  },
} as const satisfies Readonly<Record<LLMProvider, ProviderCatalogEntry>>;
