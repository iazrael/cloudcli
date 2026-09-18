/**
 * Cross-tree parity test: the frontend's fallback provider catalog
 * (src/shared/providerCatalogFallback.ts) must equal the backend capability
 * catalog (services/provider-capabilities.catalog.ts) field for field.
 *
 * The backend is the source of truth and the frontend fallback only exists
 * for first paint and capabilities-request failure — but nothing else ties
 * the two files together, and three fallback default models had already
 * drifted from the backend before this test existed. Both files are
 * zero-import literals precisely so this test can compile them from the
 * server tree, where the frontend `@` alias does not resolve.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDER_CATALOG } from '../services/provider-capabilities.catalog.js';
// Relative cross-tree import on purpose: the frontend fallback file must
// compile without the frontend alias for this test to work at all. The
// boundaries plugin correctly flags it as an unknown dependency direction.
// oxlint-disable-next-line boundaries/no-unknown
import { PROVIDER_FALLBACK_CATALOG } from '../../../../src/shared/providerCatalogFallback.js';
// oxlint-disable-next-line boundaries/no-unknown
import { MCP_FALLBACK_CAPABILITIES } from '../../../../src/shared/mcpCapabilitiesFallback.js';
import { providerRegistry } from '../provider.registry.js';

test('the frontend fallback catalog mirrors the backend catalog', () => {
  const backendProviders = Object.keys(PROVIDER_CATALOG).sort();
  const frontendProviders = Object.keys(PROVIDER_FALLBACK_CATALOG).sort();
  assert.deepEqual(frontendProviders, backendProviders,
    'frontend fallback and backend catalog must cover the same provider set');

  for (const provider of backendProviders) {
    const backend = PROVIDER_CATALOG[provider as keyof typeof PROVIDER_CATALOG];
    const frontend = PROVIDER_FALLBACK_CATALOG[provider as keyof typeof PROVIDER_FALLBACK_CATALOG];

    assert.equal(
      frontend.defaultModel,
      backend.defaultModel,
      `${provider}: fallback default model drifted from the backend catalog`,
    );
    assert.deepEqual(
      frontend.permissionModes,
      [...backend.permissionModes],
      `${provider}: fallback permission modes drifted from the backend catalog (order included)`,
    );
  }
});

/**
 * The MCP half of the same guarantee.
 *
 * Each provider's MCP facet declares what its config format supports; the
 * frontend mirrors it so the server form paints before the capability matrix
 * arrives. The three tables this mirror replaced had no such test and had gone
 * stale — Cursor writes a working directory, but the table said it did not, so
 * the field was hidden from Cursor users for as long as nobody noticed.
 */
test('the frontend MCP fallback mirrors each provider MCP facet', () => {
  const backendProviders = providerRegistry.listProviders().map((provider) => provider.id).sort();
  const frontendProviders = Object.keys(MCP_FALLBACK_CAPABILITIES).sort();
  assert.deepEqual(frontendProviders, backendProviders,
    'frontend MCP fallback and provider registry must cover the same provider set');

  for (const provider of providerRegistry.listProviders()) {
    const mirrored = MCP_FALLBACK_CAPABILITIES[provider.id as keyof typeof MCP_FALLBACK_CAPABILITIES];
    assert.deepEqual(
      {
        scopes: [...mirrored.scopes],
        transports: [...mirrored.transports],
        supportsWorkingDirectory: mirrored.supportsWorkingDirectory,
        supportsEnvVarIndirection: mirrored.supportsEnvVarIndirection,
      },
      provider.mcp.capabilities,
      `${provider.id}: frontend MCP fallback must mirror the provider's declaration`,
    );
  }
});
