import assert from 'node:assert/strict';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { CURSOR_PREDEFINED_MODELS } from '@/modules/providers/list/cursor/cursor-models.provider.js';
import { OPENCODE_PREDEFINED_MODELS } from '@/modules/providers/list/opencode/opencode-models.provider.js';
import { ZCODE_BUILTIN_MODELS } from '@/modules/providers/list/zcode/zcode-models.provider.js';
import { ANTIGRAVITY_BUILTIN_MODELS } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types.js';

/**
 * The full curated catalogs, before OpenCode narrows its list to the upstream
 * providers a machine has connected.
 */
// Codex discovers its catalog from the CLI at runtime (no static curated
// list in this fork), so its effort levels are validated by the runtime's own
// effort assertion instead of this static cross-check.
const CURATED_CATALOGS: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: CLAUDE_PREDEFINED_MODELS,
  cursor: CURSOR_PREDEFINED_MODELS,
  opencode: OPENCODE_PREDEFINED_MODELS,
  zcode: ZCODE_BUILTIN_MODELS,
  antigravity: ANTIGRAVITY_BUILTIN_MODELS,
};

test('capability effort levels cover every level a curated model declares', () => {
  // Custom models may declare only these levels, so a level added to a curated
  // model has to be added here too, or users could not give it to their own.
  for (const [provider, catalog] of Object.entries(CURATED_CATALOGS) as Array<[LLMProvider, ProviderModelsDefinition]>) {
    const { effortLevels, supportsEffort } = providerCapabilitiesService.getProviderCapabilities(provider);

    assert.equal(supportsEffort, effortLevels.length > 0, `${provider}: supportsEffort disagrees with effortLevels`);
    assert.equal(new Set(effortLevels).size, effortLevels.length, `${provider}: effortLevels lists a level twice`);

    const declaredLevels = new Set(
      catalog.OPTIONS.flatMap((option) => option.effort?.values.map((level) => level.value) ?? []),
    );
    const missingLevels = [...declaredLevels].filter((level) => !effortLevels.includes(level));
    assert.deepEqual(missingLevels, [], `${provider}: effortLevels misses curated levels`);
  }
});
