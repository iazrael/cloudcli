import type { LLMProvider, ProviderCapabilities, ProviderMcpCapabilities } from '@/shared/types.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';

import { PROVIDER_CATALOG } from './provider-capabilities.catalog.js';

/**
 * Static, backend-owned description of what one provider integration supports.
 *
 * The frontend renders its composer UI (permission mode picker, image upload,
 * abort button, ...) purely from this shape, which is what keeps the frontend
 * free of per-provider conditionals. New provider features should be exposed
 * here instead of branching on the provider id in React components.
 */
export type { ProviderCapabilities } from '@/shared/types.js';

/**
 * Derives the capability matrix from the provider's registered facets instead
 * of restating it by hand: an optional facet's presence IS the capability.
 * `provider-capabilities.test.ts` pins the derived matrix to an explicit
 * baseline, so a facet added or removed surfaces as a reviewed test delta
 * rather than a silent capability change.
 *
 * - forking rides the optional `fork` facet (transcript branching).
 * - message editing rides `sessions.resolveEditAnchor` (the anchor lookup the
 *   edit flow needs; both integrations that have it also provide the rest).
 * - the token-usage endpoint rides `sessions.getTokenUsage`.
 * - account quota rides `auth.getQuota`, which is already how
 *   `provider-token-usage.service.ts` dispatches the request.
 * - the MCP block is the provider's own declaration, passed through verbatim.
 * - interactive permission prompts ride the runtime's optional `permissions`
 *   gateway (claude's SDK bridge; zcode's engine permission bridge).
 */
function deriveCapabilities(providerId: LLMProvider, provider: {
  fork?: unknown;
  runtime?: { permissions?: unknown };
  auth?: { getQuota?: unknown };
  sessions?: { resolveEditAnchor?: unknown; getTokenUsage?: unknown };
  mcp: { capabilities: ProviderMcpCapabilities };
}): ProviderCapabilities {
  const catalog = PROVIDER_CATALOG[providerId];
  return {
    provider: providerId,
    permissionModes: [...catalog.permissionModes],
    defaultPermissionMode: catalog.defaultPermissionMode,
    supportsImages: catalog.supportsImages,
    supportsFiles: catalog.supportsFiles,
    supportsAbort: catalog.supportsAbort,
    supportsPermissionRequests: Boolean(provider.runtime?.permissions),
    supportsTokenUsage: typeof provider.sessions?.getTokenUsage === 'function',
    supportsQuota: typeof provider.auth?.getQuota === 'function',
    supportsEffort: catalog.supportsEffort,
    supportsMessageEditing: typeof provider.sessions?.resolveEditAnchor === 'function',
    supportsSessionForking: provider.fork !== undefined,
    supportsNativeScheduling: catalog.supportsNativeScheduling,
    mcp: provider.mcp.capabilities,
  };
}

/**
 * Application service exposing the provider capability matrix, derived once
 * at module load from the provider registry and the static catalog.
 */
export const providerCapabilitiesService = {
  getProviderCapabilities(provider: LLMProvider): ProviderCapabilities {
    return DERIVED_CAPABILITIES[provider];
  },

  listAllProviderCapabilities(): ProviderCapabilities[] {
    return Object.values(DERIVED_CAPABILITIES);
  },
};

const DERIVED_CAPABILITIES: Record<LLMProvider, ProviderCapabilities> = Object.fromEntries(
  providerRegistry.listProviders().map((provider) => [
    provider.id,
    deriveCapabilities(provider.id, provider),
  ]),
) as Record<LLMProvider, ProviderCapabilities>;
