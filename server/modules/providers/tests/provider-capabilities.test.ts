/**
 * Provider capability matrix tests.
 *
 * The matrix is DERIVED (provider facets + static catalog), so these tests
 * pin the three things derivation cannot self-check:
 * 1. the derived matrix equals an explicit baseline — a facet added or
 *    removed must surface as a reviewed delta here, not as a silent
 *    capability flip for every frontend consumer;
 * 2. the catalog covers exactly the registered providers, with a valid
 *    default permission mode;
 * 3. the catalog's static default model equals each provider's predefined
 *    models definition's DEFAULT — the fallback default shown before the
 *    model catalog loads must never drift from the catalog's own answer.
 */

import assert from 'node:assert/strict';

import { after, before, test } from 'node:test';

import type { ProviderCapabilities } from '../services/provider-capabilities.service.js';
import { providerCapabilitiesService } from '../services/provider-capabilities.service.js';
import { PROVIDER_CATALOG } from '../services/provider-capabilities.catalog.js';
import { providerRegistry } from '../provider.registry.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

before(async () => {
  await initializeDatabase();
});

after(() => {
  closeConnection();
});

const BASELINE: Record<string, Omit<ProviderCapabilities, 'provider'>> = {
  claude: {
    permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
    supportsMessageEditing: true,
    supportsSessionForking: true,
  },
  cursor: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: false,
    supportsEffort: false,
    supportsMessageEditing: false,
    supportsSessionForking: false,
  },
  codex: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
    // Not from the Codex SDK, which only starts and resumes threads: both ride
    // the same CLI's `app-server` protocol, whose `thread/fork` copies a
    // thread up to a chosen turn. Editing is that fork plus a new prompt,
    // which is how Codex's own IDE clients do it.
    supportsMessageEditing: true,
    supportsSessionForking: true,
  },
  opencode: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
    supportsMessageEditing: false,
    supportsSessionForking: false,
  },
  zcode: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    // Native session/send attachment items, mapped by the runtime from app
    // descriptors (verified on engine 0.16.5).
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    // The zcode runtime carries the engine permission bridge (interaction/
    // requestPermission → chat cards), so its runtime.permissions facet is
    // present even though permission MODES are the primary gate.
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
    // No resolveEditAnchor/fork facets: transcripts are append-only for this
    // provider today.
    supportsMessageEditing: false,
    supportsSessionForking: false,
  },
  antigravity: {
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
    supportsMessageEditing: false,
    supportsSessionForking: false,
  },
};

test('the derived matrix matches the reviewed baseline', () => {
  for (const capabilities of providerCapabilitiesService.listAllProviderCapabilities()) {
    const expected = BASELINE[capabilities.provider];
    assert.ok(expected, `unexpected provider in the derived matrix: ${capabilities.provider}`);
    assert.deepEqual(capabilities, { provider: capabilities.provider, ...expected });
  }
});

test('the catalog covers exactly the registered providers with valid mode tables', () => {
  const registered = providerRegistry.listProviders().map((provider) => provider.id).sort();
  const catalogued = Object.keys(PROVIDER_CATALOG).sort();
  assert.deepEqual(catalogued, registered, 'catalog and registry must cover the same provider set');

  for (const [provider, entry] of Object.entries(PROVIDER_CATALOG)) {
    assert.ok(
      entry.permissionModes.includes(entry.defaultPermissionMode),
      `${provider}: defaultPermissionMode must be one of permissionModes`,
    );
    assert.ok(entry.permissionModes.length > 0, `${provider}: permissionModes must not be empty`);
    assert.ok(entry.defaultModel.length > 0, `${provider}: defaultModel must be declared`);
  }
});

test('the catalog default model equals each provider models definition DEFAULT', async () => {
  const { CLAUDE_PREDEFINED_MODELS } = await import('../list/claude/claude-models.provider.js');
  const { CODEX_PREDEFINED_MODELS } = await import('../list/codex/codex-models.provider.js');
  const { CURSOR_PREDEFINED_MODELS } = await import('../list/cursor/cursor-models.provider.js');
  const { OPENCODE_PREDEFINED_MODELS } = await import('../list/opencode/opencode-models.provider.js');
  const { ZCODE_BUILTIN_MODELS } = await import('../list/zcode/zcode-models.provider.js');
  const { ANTIGRAVITY_BUILTIN_MODELS } = await import('../list/antigravity/antigravity-models.provider.js');

  const defaults = {
    claude: CLAUDE_PREDEFINED_MODELS.DEFAULT,
    cursor: CURSOR_PREDEFINED_MODELS.DEFAULT,
    codex: CODEX_PREDEFINED_MODELS.DEFAULT,
    opencode: OPENCODE_PREDEFINED_MODELS.DEFAULT,
    zcode: ZCODE_BUILTIN_MODELS.DEFAULT,
    antigravity: ANTIGRAVITY_BUILTIN_MODELS.DEFAULT,
  };

  for (const [provider, defaultModel] of Object.entries(defaults)) {
    assert.equal(
      PROVIDER_CATALOG[provider as keyof typeof PROVIDER_CATALOG].defaultModel,
      defaultModel,
      `${provider}: catalog defaultModel drifted from the models definition`,
    );
  }
});
