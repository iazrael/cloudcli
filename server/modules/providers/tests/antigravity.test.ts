/**
 * Antigravity Provider Unit Tests
 *
 * Covers auth, models, mcp, skills, sessions normalization, and synchronizer facets.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import type { ProviderModelOption } from '@/shared/types.js';

import { AntigravityProviderAuth } from '../list/antigravity/antigravity-auth.provider.js';
import { getAntigravitySummariesDbPath } from '../list/antigravity/antigravity-data-root.js';
import { clearEnginePathCache } from '../list/antigravity/antigravity-engine-path.js';
import {
  ANTIGRAVITY_BUILTIN_MODELS,
  AntigravityProviderModels,
} from '../list/antigravity/antigravity-models.provider.js';
import {
  ANTIGRAVITY_EFFORT_TIERS,
  dedupeAntigravityVariantModels,
  findCatalogOptionForModelString,
  resolveAntigravityModelArgs,
  stripEffortTierFromLabel,
} from '../list/antigravity/antigravity-model-effort.js';
import { AntigravityMcpProvider } from '../list/antigravity/antigravity-mcp.provider.js';
import { AntigravitySessionSynchronizer } from '../list/antigravity/antigravity-session-synchronizer.provider.js';
import { AntigravitySkillsProvider } from '../list/antigravity/antigravity-skills.provider.js';
import { readCanonicalAntigravityTranscript } from '../list/antigravity/antigravity-transcript.provider.js';
import { antigravityBackgroundWork } from '../list/antigravity/antigravity-subagent.js';
import { AntigravitySessionsProvider } from '../list/antigravity/antigravity-sessions.provider.js';
import { providerRegistry } from '../provider.registry.js';
import { providerCapabilitiesService } from '../services/provider-capabilities.service.js';

import { createWorkspaceFixture } from './workspace-fixture.js';

/**
 * Sets environment variable `name` to `value` and returns a restore function
 * that puts back the previous value, so test overrides cannot leak into each
 * other.
 */
function withEnvValue(name: string, value: string): () => void {
  const previousValue = process.env[name];
  process.env[name] = value;
  return () => {
    if (previousValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previousValue;
    }
  };
}

test('AntigravityProvider is registered in providerRegistry', () => {
  const provider = providerRegistry.resolveProvider('antigravity');
  assert.equal(provider.id, 'antigravity');
  assert.ok(provider.runtime);
  assert.ok(provider.models);
  assert.ok(provider.auth);
  assert.ok(provider.mcp);
  assert.ok(provider.skills);
  assert.ok(provider.sessions);
  assert.ok(provider.sessionSynchronizer);
});

test('providerCapabilitiesService reports correct antigravity capabilities', () => {
  const caps = providerCapabilitiesService.getProviderCapabilities('antigravity');
  assert.equal(caps.provider, 'antigravity');
  assert.equal(caps.supportsImages, true);
  assert.equal(caps.supportsFiles, true);
  assert.equal(caps.supportsAbort, true);
  assert.equal(caps.supportsTokenUsage, true);
  assert.equal(caps.supportsEffort, true);
  assert.deepEqual(caps.permissionModes, ['default', 'acceptEdits', 'bypassPermissions', 'plan']);
});

test('AntigravityProviderAuth reports valid status object without throwing', async () => {
  const auth = new AntigravityProviderAuth();
  const status = await auth.getStatus();
  assert.equal(status.provider, 'antigravity');
  assert.equal(typeof status.installed, 'boolean');
  assert.equal(typeof status.authenticated, 'boolean');
  assert.equal(status.loginCommand, 'agy');
});

test('AntigravityProviderAuth only reports authenticated with an OAuth token file', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-auth-'));
  // Keep the engine check deterministic on machines without `agy` installed;
  // tryResolveEnginePath honors this override whenever its cache is empty.
  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  const restoreAgyPath = withEnvValue('CLOUDCLI_AGY_PATH', path.join(tempRoot, 'agy'));
  // Keep the macOS keychain probe out so this fixture tree is the only
  // credential source under test, even on a machine whose real keychain holds
  // live agy credentials.
  const restoreSkipKeychain = withEnvValue('CLOUDCLI_ANTIGRAVITY_SKIP_KEYCHAIN', '1');
  await fs.writeFile(path.join(tempRoot, 'agy'), '#!/bin/sh\n', { mode: 0o755 });
  try {
    const auth = new AntigravityProviderAuth();

    // installation_id and settings.json exist from first launch, before any login
    await fs.writeFile(path.join(tempRoot, 'installation_id'), 'fixture');
    await fs.writeFile(path.join(tempRoot, 'settings.json'), '{}');
    const signedOut = await auth.getStatus();
    assert.equal(signedOut.installed, true);
    assert.equal(signedOut.authenticated, false);
    assert.match(signedOut.error ?? '', /not logged in/);

    // The OAuth token file only appears after a completed `agy` login
    await fs.writeFile(path.join(tempRoot, 'antigravity-oauth-token'), '{"token":{}}');
    const signedIn = await auth.getStatus();
    assert.equal(signedIn.authenticated, true);
    assert.equal(signedIn.error, undefined);
  } finally {
    restoreAgyPath();
    restoreDataDir();
    restoreSkipKeychain();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravityProviderModels returns builtin models fallback', async () => {
  // Isolate from the machine's real Antigravity install: the engine stub is
  // an empty script, so `agy models` reports no entries and the provider must
  // fall back to the builtin catalog even where the CLI is installed and
  // logged in. The engine-path cache is process-wide, so it is cleared around
  // the fixture or a previous test's resolution would win over the stub.
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-models-'));
  const restoreAgyPath = withEnvValue('CLOUDCLI_AGY_PATH', path.join(tempRoot, 'agy'));
  await fs.writeFile(path.join(tempRoot, 'agy'), '#!/bin/sh\n', { mode: 0o755 });
  clearEnginePathCache();
  try {
    const models = new AntigravityProviderModels();
    const definition = await models.getSupportedModels();
    assert.ok(definition.OPTIONS.length > 0);
    assert.ok(definition.DEFAULT);
    assert.ok(definition.OPTIONS.some((m) => m.value === 'gemini-4-argon'));
  } finally {
    restoreAgyPath();
    clearEnginePathCache();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravityProviderModels retries the CLI once the fallback cache expires', async () => {
  // The builtin catalog is only a stopgap while `agy models` is failing
  // (cold start, slow fetch). It must not pin the picker to a stale list
  // for five minutes, so the fallback TTL expires fast; 0 makes the
  // retry immediate in this test.
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-models-ttl-'));
  const stubPath = path.join(tempRoot, 'agy');
  const restoreAgyPath = withEnvValue('CLOUDCLI_AGY_PATH', stubPath);
  await fs.writeFile(stubPath, '#!/bin/sh\n', { mode: 0o755 });
  clearEnginePathCache();
  try {
    const models = new AntigravityProviderModels(0);
    const fallback = await models.getSupportedModels();
    assert.ok(fallback.OPTIONS.some((m) => m.value === 'gemini-4-argon'));

    // A healthy CLI output replaces the dead stub; with the (zero) TTL
    // elapsed the next call must re-query instead of serving the fallback.
    await fs.writeFile(
      stubPath,
      `#!/bin/sh\nprintf 'gemini-4-argon-medium\\tGemini 4 Argon (Medium)\\n'\n`,
      { mode: 0o755 },
    );
    clearEnginePathCache();
    // The expired fallback is served at once while the CLI is re-queried
    // behind it; the call after that refresh gets the real catalog.
    const stale = await models.getSupportedModels();
    assert.ok(stale.OPTIONS.some((m) => m.value === 'gemini-4-argon'));
    let refreshed = stale;
    for (let i = 0; i < 100 && !refreshed.OPTIONS.some((m) => m.value === 'gemini-4-argon-medium'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      refreshed = await models.getSupportedModels();
    }
    assert.ok(
      refreshed.OPTIONS.some((m) => m.value === 'gemini-4-argon-medium'),
      `expected CLI catalog, got: ${JSON.stringify(refreshed.OPTIONS.map((m) => m.value))}`,
    );
  } finally {
    restoreAgyPath();
    clearEnginePathCache();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravityProviderModels never holds a caller behind a hung CLI once it has a catalog', async () => {
  // Every turn reads the catalog before spawning agy. A CLI whose `models`
  // query hangs (offline token refresh) must not delay each turn by the
  // query's timeout: the expired catalog is served while the refresh runs.
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-models-swr-'));
  const stubPath = path.join(tempRoot, 'agy');
  const countPath = path.join(tempRoot, 'count');
  const restoreAgyPath = withEnvValue('CLOUDCLI_AGY_PATH', stubPath);
  await fs.writeFile(stubPath, '#!/bin/sh\n', { mode: 0o755 });
  clearEnginePathCache();
  try {
    const models = new AntigravityProviderModels(0);
    await models.getSupportedModels();

    // `models` hangs for longer than the assertion below allows, and counts
    // its runs; other invocations (the `--version` probe) return at once.
    await fs.writeFile(
      stubPath,
      `#!/bin/sh\n[ "$1" = models ] || exit 0\necho run >> '${countPath}'\nsleep 2\n`,
      { mode: 0o755 },
    );
    clearEnginePathCache();

    const startedAt = Date.now();
    const [first, second] = await Promise.all([models.getSupportedModels(), models.getSupportedModels()]);
    assert.ok(Date.now() - startedAt < 1_000, 'an expired catalog must be served without waiting on the CLI');
    assert.ok(first.OPTIONS.some((m) => m.value === 'gemini-4-argon'));
    assert.equal(second, first);

    // Concurrent callers share one refresh.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const runs = (await fs.readFile(countPath, 'utf8')).trim().split('\n');
    assert.equal(runs.length, 1);
  } finally {
    restoreAgyPath();
    clearEnginePathCache();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravityProviderModels keeps caching a healthy CLI catalog', async () => {
  // A successful `agy models` result keeps its five-minute cache so the
  // picker never re-runs the ~5s CLI on every open; only the fallback
  // path uses the short TTL.
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-models-cache-'));
  const stubPath = path.join(tempRoot, 'agy');
  const restoreAgyPath = withEnvValue('CLOUDCLI_AGY_PATH', stubPath);
  await fs.writeFile(
    stubPath,
    `#!/bin/sh\nprintf 'gemini-4-argon-medium\\tGemini 4 Argon (Medium)\\n'\n`,
    { mode: 0o755 },
  );
  clearEnginePathCache();
  try {
    const models = new AntigravityProviderModels();
    const first = await models.getSupportedModels();
    assert.ok(first.OPTIONS.some((m) => m.value === 'gemini-4-argon-medium'));

    // The stub now reports a different catalog; inside the cache window
    // the provider must keep serving the first result.
    await fs.writeFile(
      stubPath,
      `#!/bin/sh\nprintf 'claude-opus-5-5-high\\tClaude Opus 5.5 (High)\\n'\n`,
      { mode: 0o755 },
    );
    clearEnginePathCache();
    const cached = await models.getSupportedModels();
    assert.ok(cached.OPTIONS.some((m) => m.value === 'gemini-4-argon-medium'));
    assert.ok(!cached.OPTIONS.some((m) => m.value.startsWith('claude-')));
  } finally {
    restoreAgyPath();
    clearEnginePathCache();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('ANTIGRAVITY_BUILTIN_MODELS collapses multi-tier families and keeps fixed models', () => {
  assert.equal(ANTIGRAVITY_BUILTIN_MODELS.DEFAULT, 'gemini-4-argon');

  const values = ANTIGRAVITY_BUILTIN_MODELS.OPTIONS.map((option) => option.value);
  for (const expected of [
    'gemini-4-argon',
    'gemini-3.8-flash',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'gpt-oss-120b-medium',
  ]) {
    assert.ok(values.includes(expected), `${expected} must be listed`);
  }
  // Multi-tier families collapse to base ids; the single-variant gpt-oss
  // row keeps its real agy id.
  assert.equal(
    values.filter((value) => value !== 'gpt-oss-120b-medium' && /-(low|medium|high)$/?.test(value)).length,
    0,
    `no suffixed ids may survive: ${JSON.stringify(values)}`,
  );

  const argon = ANTIGRAVITY_BUILTIN_MODELS.OPTIONS.find((o) => o.value === 'gemini-4-argon');
  assert.equal(argon?.label, 'Gemini 4 Argon');
  assert.equal(argon?.description, 'Google Gemini 4 Argon');
  assert.equal(argon?.effort?.encoding, 'model-suffix');
  assert.deepEqual(argon?.effort?.values.map((v) => v.value), ['low', 'medium', 'high']);
  assert.equal(argon?.effort?.default, 'high');

  // Claude tiers became adjustable in the current agy catalog, unlike
  // older releases where sonnet was a passthrough.
  const opus = ANTIGRAVITY_BUILTIN_MODELS.OPTIONS.find((o) => o.value === 'claude-opus-5-5');
  assert.deepEqual(opus?.effort?.values.map((v) => v.value), ['low', 'medium', 'high']);

  // Models without adjustable tiers carry no effort config at all, so the
  // WebUI hides the Reasoning menu for them.
  const gptOss = ANTIGRAVITY_BUILTIN_MODELS.OPTIONS.find((o) => o.value === 'gpt-oss-120b-medium');
  assert.equal(gptOss?.label, 'GPT-OSS 120B (Medium)');
  assert.equal(gptOss?.effort, undefined);
});

test('dedupeAntigravityVariantModels merges CLI variant rows into base models', () => {
  const options = dedupeAntigravityVariantModels([
    { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ]);

  // Multi-tier family collapses; passthrough and single-variant rows keep
  // their original ids, interleaved in first-appearance order.
  assert.deepEqual(
    options.map((option) => option.value),
    ['gemini-3.8-flash', 'claude-sonnet-4-6', 'gpt-oss-120b-medium'],
  );

  const flash = options[0];
  assert.equal(flash?.label, 'Gemini 3.8 Flash');
  assert.equal(flash?.effort?.encoding, 'model-suffix');
  assert.deepEqual(flash?.effort?.values.map((v) => v.value), [...ANTIGRAVITY_EFFORT_TIERS]);
  assert.equal(flash?.effort?.default, 'high');

  // Fixed-tier and passthrough models keep their original row with no
  // effort config, so the WebUI hides their Reasoning menu.
  const claude = options[1];
  assert.equal(claude?.label, 'Claude Sonnet 4.6 (Thinking)');
  assert.equal(claude?.effort, undefined);
  const gptOss = options[2];
  assert.equal(gptOss?.label, 'GPT-OSS 120B (Medium)');
  assert.equal(gptOss?.effort, undefined);
});

test('stripEffortTierFromLabel only removes tier qualifiers', () => {
  assert.equal(stripEffortTierFromLabel('Gemini 3.8 Flash (High)'), 'Gemini 3.8 Flash');
  assert.equal(stripEffortTierFromLabel('Claude Sonnet 4.6 (Thinking)'), 'Claude Sonnet 4.6 (Thinking)');
  assert.equal(stripEffortTierFromLabel('GPT-OSS 120B'), 'GPT-OSS 120B');
});

test('resolveAntigravityModelArgs maps catalog selections onto agy arguments', () => {
  const flashOption: ProviderModelOption = {
    value: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    effort: {
      default: 'high',
      values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      encoding: 'model-suffix',
    },
  };
  const proOption: ProviderModelOption = {
    value: 'gemini-3.1-pro',
    label: 'Gemini 3.1 Pro',
    effort: {
      default: 'high',
      values: [{ value: 'low' }, { value: 'high' }],
      encoding: 'model-suffix',
    },
  };
  const fixedOption: ProviderModelOption = { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' };
  const claudeOption: ProviderModelOption = { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' };

  // Base model + chosen tier -> suffixed id, no flag.
  assert.deepEqual(
    resolveAntigravityModelArgs('gemini-3.7-flash', 'medium', flashOption),
    { model: 'gemini-3.7-flash-medium' },
  );
  // 'default' (or absent) resolves through the family default tier.
  assert.deepEqual(
    resolveAntigravityModelArgs('gemini-3.7-flash', 'default', flashOption),
    { model: 'gemini-3.7-flash-high' },
  );
  assert.deepEqual(
    resolveAntigravityModelArgs('gemini-3.7-flash', undefined, flashOption),
    { model: 'gemini-3.7-flash-high' },
  );
  // A tier the family lacks snaps to the default instead of an invalid id.
  assert.deepEqual(
    resolveAntigravityModelArgs('gemini-3.1-pro', 'medium', proOption),
    { model: 'gemini-3.1-pro-high' },
  );
  // Legacy suffixed ids rewrite within their family.
  assert.deepEqual(
    resolveAntigravityModelArgs('gemini-3.7-flash-high', 'low', flashOption),
    { model: 'gemini-3.7-flash-low' },
  );
  // Cataloged models without effort support run with their id verbatim; a
  // stale effort choice is dropped and no id is ever invented.
  assert.deepEqual(
    resolveAntigravityModelArgs('gpt-oss-120b-medium', 'high', fixedOption),
    { model: 'gpt-oss-120b-medium' },
  );
  assert.deepEqual(
    resolveAntigravityModelArgs('claude-sonnet-4-6', 'high', claudeOption),
    { model: 'claude-sonnet-4-6' },
  );
  assert.deepEqual(
    resolveAntigravityModelArgs('claude-sonnet-4-6', 'default', claudeOption),
    { model: 'claude-sonnet-4-6' },
  );
  // Models missing from the catalog (user-defined custom ones) keep the
  // --effort flag channel.
  assert.deepEqual(
    resolveAntigravityModelArgs('my-custom-model', 'low', undefined),
    { model: 'my-custom-model', effort: 'low' },
  );
  // An unknown suffixed id is never rewritten into an id agy may not have.
  assert.deepEqual(
    resolveAntigravityModelArgs('gemini-3.7-flash-high', 'low', undefined),
    { model: 'gemini-3.7-flash-high' },
  );
  // No model at all still forwards a valid effort flag.
  assert.deepEqual(resolveAntigravityModelArgs(undefined, 'low', undefined), { effort: 'low' });
  assert.deepEqual(resolveAntigravityModelArgs(undefined, undefined, undefined), {});
});

test('findCatalogOptionForModelString resolves ids, suffixed ids, and display labels', () => {
  const options = dedupeAntigravityVariantModels([
    { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ]);
  const flash = options.find((option) => option.value === 'gemini-3.8-flash');

  // Exact catalog id.
  assert.deepEqual(findCatalogOptionForModelString('gemini-3.8-flash', options), { option: flash, labelTier: null });
  // Legacy suffixed id reduces to its base family.
  assert.deepEqual(findCatalogOptionForModelString('gemini-3.8-flash-low', options), { option: flash, labelTier: null });
  // Display label with a tier qualifier — the form agy's own picker writes
  // into settings.json and the form that poisons session rows. The label's
  // tier rides along as recorded user intent.
  assert.deepEqual(findCatalogOptionForModelString('Gemini 3.8 Flash (Medium)', options), { option: flash, labelTier: 'medium' });
  // Bare display label.
  assert.deepEqual(findCatalogOptionForModelString('Gemini 3.8 Flash', options), { option: flash, labelTier: null });
  // Fixed-tier and passthrough rows match on their verbatim label.
  assert.deepEqual(
    findCatalogOptionForModelString('GPT-OSS 120B (Medium)', options),
    {
      option: options.find((option) => option.value === 'gpt-oss-120b-medium'),
      labelTier: 'medium',
    },
  );
  assert.deepEqual(
    findCatalogOptionForModelString('Claude Sonnet 4.6 (Thinking)', options),
    {
      option: options.find((option) => option.value === 'claude-sonnet-4-6'),
      labelTier: null,
    },
  );
  // Surrounding whitespace must not leak into the match or the spawn id.
  assert.deepEqual(
    findCatalogOptionForModelString('  claude-sonnet-4-6  ', options),
    { option: options.find((option) => option.value === 'claude-sonnet-4-6'), labelTier: null },
  );
  // Unknown ids and labels stay unknown so custom models keep their channel.
  assert.equal(findCatalogOptionForModelString('my-custom-gpt', options), null);
  assert.equal(findCatalogOptionForModelString('', options), null);
});

test('a display label plus effort resolves to the family id without the --effort flag', () => {
  // Regression pin for the poisoned-row spawn: the label must ride the
  // model-suffix channel, never the flag channel agy rejects.
  const options = dedupeAntigravityVariantModels([
    { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  ]);
  const resolved = findCatalogOptionForModelString('Gemini 3.8 Flash (Medium)', options);

  assert.deepEqual(
    resolveAntigravityModelArgs('Gemini 3.8 Flash (Medium)', 'medium', resolved?.option),
    { model: 'gemini-3.8-flash-medium' },
  );
  // Without any tier the family default applies; applying the label's own
  // tier is the runtime wiring's job (it passes labelTier as the effort).
  assert.deepEqual(
    resolveAntigravityModelArgs('Gemini 3.8 Flash (Medium)', undefined, resolved?.option),
    { model: 'gemini-3.8-flash-high' },
  );
});

test('non-family label rows resolve onto their catalog id, not the label', () => {
  // The claude passthrough and the fixed-tier gpt-oss row carry no effort
  // family, but a label-form row must still spawn the real id — agy knows
  // no model by its display label.
  const options = dedupeAntigravityVariantModels([
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ]);

  for (const [raw, expected] of [
    ['Claude Sonnet 4.6 (Thinking)', 'claude-sonnet-4-6'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['GPT-OSS 120B (Medium)', 'gpt-oss-120b-medium'],
  ] as const) {
    const resolved = findCatalogOptionForModelString(raw, [...options]);
    assert.deepEqual(
      resolveAntigravityModelArgs(raw, 'high', resolved?.option),
      { model: expected },
      raw,
    );
  }
});

test('AntigravitySkillsProvider returns correct skill roots', async () => {
  const skills = new AntigravitySkillsProvider();
  const list = await skills.listSkills({ workspacePath: '/mock/workspace' });
  assert.ok(Array.isArray(list));
});

test('AntigravitySkillsProvider discovers user skills from ~/.gemini/config/skills', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-skills-test-'));
  const restoreHomedir = mock.method(os, 'homedir', () => tempDir);

  try {
    const skillDir = path.join(tempDir, '.gemini', 'config', 'skills', 'demo-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo\n---\n\nBody\n', 'utf8');

    const skills = new AntigravitySkillsProvider();
    const list = await skills.listSkills({ workspacePath: '/mock/workspace' });
    const demo = list.find((skill) => skill.name === 'demo-skill');
    assert.ok(demo);
    assert.equal(demo.scope, 'user');
    assert.ok(demo.sourcePath.includes(path.join('.gemini', 'config', 'skills')));
  } finally {
    restoreHomedir.mock.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('AntigravityMcpProvider handles project-level mcp_config.json', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-mcp-test-'));
  const mcp = new AntigravityMcpProvider();

  try {
    // 1. Add server
    await mcp.upsertServer({
      scope: 'project',
      workspacePath: tempDir,
      name: 'test-mcp',
      transport: 'stdio',
      command: 'node',
      args: ['test.js'],
      env: { KEY: 'VALUE' },
    });

    // 2. Read back
    const servers = await mcp.listServersForScope('project', { workspacePath: tempDir });
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, 'test-mcp');
    assert.equal(servers[0]?.transport, 'stdio');
    assert.equal(servers[0]?.command, 'node');

    // 3. Remove server
    await mcp.removeServer({ scope: 'project', workspacePath: tempDir, name: 'test-mcp' });
    const remaining = await mcp.listServersForScope('project', { workspacePath: tempDir });
    assert.equal(remaining.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('AntigravityMcpProvider reads and writes user scope in ~/.gemini/config', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-mcp-user-test-'));
  const restoreHomedir = mock.method(os, 'homedir', () => tempDir);
  const mcp = new AntigravityMcpProvider();

  try {
    await mcp.upsertServer({
      scope: 'user',
      workspacePath: '/mock/workspace',
      name: 'user-mcp',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    });

    const configPath = path.join(tempDir, '.gemini', 'config', 'mcp_config.json');
    const written = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    assert.ok(written.mcpServers?.['user-mcp']);

    const servers = await mcp.listServersForScope('user', { workspacePath: '/mock/workspace' });
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, 'user-mcp');
  } finally {
    restoreHomedir.mock.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('AntigravityMcpProvider falls back to legacy user config when current one is missing', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-mcp-legacy-test-'));
  const restoreHomedir = mock.method(os, 'homedir', () => tempDir);

  try {
    const legacyPath = path.join(tempDir, '.gemini', 'antigravity', 'mcp_config.json');
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify({
      mcpServers: { 'legacy-mcp': { command: 'node', args: ['legacy.js'] } },
    }), 'utf8');

    const mcp = new AntigravityMcpProvider();
    const servers = await mcp.listServersForScope('user', { workspacePath: '/mock/workspace' });
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, 'legacy-mcp');
  } finally {
    restoreHomedir.mock.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('AntigravitySessionsProvider normalizes stream-json events', () => {
  const sessions = new AntigravitySessionsProvider();

  // Test init event
  const initMsg = sessions.normalizeMessage({
    event: 'init',
    conversation_id: 'test-conv-123',
    init: { cwd: '/test', tools: ['view_file'], permission_mode: 'always-proceed' },
  }, 'test-conv-123');
  assert.equal(initMsg.length, 1);
  assert.equal(initMsg[0]?.kind, 'session_created');

  // Test agent response delta
  const deltaMsg = sessions.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'Hello World',
    },
  }, 'test-conv-123');
  assert.equal(deltaMsg.length, 1);
  assert.equal(deltaMsg[0]?.kind, 'stream_delta');
  assert.equal(deltaMsg[0]?.content, 'Hello World');
  assert.equal(deltaMsg[0]?.providerRowKey, 'assistant-step:2');

  const nextDeltaMsg = sessions.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 8,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'Next answer',
    },
  }, 'test-conv-123');
  assert.equal(nextDeltaMsg[0]?.providerRowKey, 'assistant-step:8');

  const deltaWithoutStepIndex = sessions.normalizeMessage({
    event: 'step_update',
    step_update: {
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'Unidentified answer',
    },
  }, 'test-conv-123');
  assert.equal(deltaWithoutStepIndex[0]?.providerRowKey, undefined);

  // Test tool call
  const toolUseMsg = sessions.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 3,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'view_file',
      tool_info: {
        parameters: { AbsolutePath: '/test/file.ts' },
      },
    },
  }, 'test-conv-123');
  assert.equal(toolUseMsg.length, 1);
  assert.equal(toolUseMsg[0]?.kind, 'tool_use');
  assert.equal(toolUseMsg[0]?.toolName, 'view_file');

  // Test quoted arguments cleanup
  const quotedToolMsg = sessions.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 4,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'view_file',
      tool_info: {
        parameters: { AbsolutePath: '"/test/file.ts"', toolAction: '"Viewing file"' },
      },
    },
  }, 'test-conv-123');
  assert.equal(quotedToolMsg.length, 1);
  assert.deepEqual(quotedToolMsg[0]?.toolInput, {
    AbsolutePath: '/test/file.ts',
    toolAction: 'Viewing file',
  });

  // Test tool result
  const toolResultMsg = sessions.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 3,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'view_file',
      tool_info: {
        output: 'file content here',
      },
    },
  }, 'test-conv-123');
  assert.equal(toolResultMsg.length, 1);
  assert.equal(toolResultMsg[0]?.kind, 'tool_result');
  assert.equal(toolResultMsg[0]?.content, 'file content here');
  assert.equal(toolResultMsg[0]?.isError, false);

  // agy reports tool failures with a structured error object; its `message`
  // must reach the transcript instead of the generic fallback.
  const toolErrorMsg = sessions.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 5,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: 'grep_search',
      tool_info: {
        parameters: { Query: 'currentGroup', SearchPath: '/test/missing' },
        error: { type: 'TOOL_ERROR', message: 'search path file:///test/missing does not exist' },
      },
    },
  }, 'test-conv-123');
  assert.equal(toolErrorMsg.length, 1);
  assert.equal(toolErrorMsg[0]?.kind, 'tool_result');
  assert.equal(toolErrorMsg[0]?.content, 'search path file:///test/missing does not exist');
  assert.equal(toolErrorMsg[0]?.isError, true);

  // Plain-string errors keep working.
  const toolErrorStringMsg = sessions.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 6,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { error: 'command failed' },
    },
  }, 'test-conv-123');
  assert.equal(toolErrorStringMsg[0]?.content, 'command failed');
  assert.equal(toolErrorStringMsg[0]?.isError, true);

  // A malformed error payload still falls back to the generic copy.
  const toolErrorEmptyMsg = sessions.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 7,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: 'view_file',
      tool_info: { error: { type: 'TOOL_ERROR' } },
    },
  }, 'test-conv-123');
  assert.equal(toolErrorEmptyMsg[0]?.content, 'Tool execution error');

  // Test result completion
  const completeMsg = sessions.normalizeMessage({
    event: 'result',
    result: {
      status: 'SUCCESS',
      usage: { total_tokens: 12345 },
    },
  }, 'test-conv-123');
  assert.equal(completeMsg.length, 1);
  assert.equal(completeMsg[0]?.kind, 'complete');
  assert.equal(completeMsg[0]?.tokens, 12345);
});

test('canonical Antigravity transcript reader merges full rows with compact-only tail rows', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-canonical-transcript-'));
  const sessionId = 'canonical-session';
  const transcriptDir = path.join(tempRoot, 'brain', sessionId, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: '截断正文', truncated_fields: ['content'] }),
    JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', content: 'compact 新尾部' }),
    '{bad tail',
  ].join('\n'));
  await fs.writeFile(path.join(transcriptDir, 'transcript_full.jsonl'), [
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: '完整正文' }),
  ].join('\n'));

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const rows = await readCanonicalAntigravityTranscript(sessionId);
    assert.deepEqual(rows.map((row) => [row.entry.step_index, row.entry.content, row.contentCompleteness]), [
      [1, '完整正文', 'complete'],
      [2, 'compact 新尾部', 'complete'],
    ]);
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('canonical Antigravity transcript reader does not duplicate unindexed rows present in both files', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-canonical-unindexed-'));
  const sessionId = 'canonical-unindexed-session';
  const transcriptDir = path.join(tempRoot, 'brain', sessionId, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, 'transcript.jsonl'), [
    JSON.stringify({ type: 'CHECKPOINT', content: 'checkpoint-0' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'compact reply' }),
  ].join('\n'));
  await fs.writeFile(path.join(transcriptDir, 'transcript_full.jsonl'), [
    JSON.stringify({ type: 'CHECKPOINT', content: 'checkpoint-0' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'full reply' }),
    JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', content: 'full extra' }),
  ].join('\n'));

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const rows = await readCanonicalAntigravityTranscript(sessionId);
    assert.deepEqual(rows.map((row) => [row.entry.step_index, row.entry.content]), [
      [undefined, 'checkpoint-0'],
      [1, 'full reply'],
      [2, 'full extra'],
    ]);
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('canonical Antigravity transcript reader restores causal order when a result row is flushed before its call', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-canonical-order-'));
  const sessionId = 'canonical-order-session';
  const transcriptDir = path.join(tempRoot, 'brain', sessionId, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'call' }),
    JSON.stringify({ type: 'CHECKPOINT', content: 'unindexed-after-1' }),
    // Antigravity's writer flushes step 3 ahead of step 2.
    JSON.stringify({ step_index: 3, type: 'GENERIC', content: 'result-3' }),
    JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', content: 'call-2' }),
  ].join('\n'));

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const rows = await readCanonicalAntigravityTranscript(sessionId);
    assert.deepEqual(rows.map((row) => [row.entry.step_index, row.entry.content]), [
      [1, 'call'],
      [undefined, 'unindexed-after-1'],
      [2, 'call-2'],
      [3, 'result-3'],
    ]);
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravitySessionsProvider fetchHistory pairs an out-of-order tool result with its own call', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-out-of-order-'));
  const sessionId = 'hist-out-of-order';
  const transcriptDir = path.join(tempRoot, 'brain', sessionId, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-09-18T05:17:20Z', content: '<USER_REQUEST>\nread it\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-18T05:17:21Z', tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/tmp/world.ts' } }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: '2026-09-18T05:17:22Z', content: 'Created At: 2026-09-18T13:17:20+08:00\nCompleted At: 2026-09-18T13:17:20+08:00\nFile Path: `/tmp/world.ts`\n1: world body' }),
    // The result of step 3's call lands in the log before the call itself.
    JSON.stringify({ step_index: 4, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: '2026-09-18T05:17:24Z', content: 'Created At: 2026-09-18T13:17:24+08:00\nCompleted At: 2026-09-18T13:17:24+08:00\nFile Path: `/tmp/lighting.ts`\n70: lighting body' }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-18T05:17:23Z', tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/tmp/lighting.ts' } }] }),
    JSON.stringify({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-18T05:17:25Z', tool_calls: [{ name: 'find_by_name', args: { Pattern: '*Equip*' } }] }),
    JSON.stringify({ step_index: 6, source: 'MODEL', type: 'FIND_BY_NAME', status: 'DONE', created_at: '2026-09-18T05:17:26Z', content: 'Created At: 2026-09-18T13:17:28+08:00\nCompleted At: 2026-09-18T13:17:32+08:00\nFound 2 matches' }),
  ].join('\n') + '\n');

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const sessions = new AntigravitySessionsProvider();
    const { messages } = await sessions.fetchHistory(sessionId, {});

    // No result may surface as assistant prose: that is the symptom of a miss.
    assert.equal(messages.some((msg) => msg.role === 'assistant' && /Created At:/.test(msg.content ?? '')), false);

    const toolUses = messages.filter((msg) => msg.kind === 'tool_use');
    assert.deepEqual(
      toolUses.map((msg) => {
        const input = msg.toolInput as { AbsolutePath?: string; Pattern?: string } | undefined;
        return [msg.toolName, input?.AbsolutePath ?? input?.Pattern];
      }),
      [['view_file', '/tmp/world.ts'], ['view_file', '/tmp/lighting.ts'], ['find_by_name', '*Equip*']],
    );
    assert.match(toolUses[0]?.toolResult?.content ?? '', /world body/);
    assert.match(toolUses[1]?.toolResult?.content ?? '', /lighting body/);
    assert.match(toolUses[2]?.toolResult?.content ?? '', /Found 2 matches/);
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravitySessionsProvider fetchHistory drops raw tool output that has no call to pair with', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-orphan-result-'));
  const sessionId = 'hist-orphan-result';
  const transcriptDir = path.join(tempRoot, 'brain', sessionId, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-09-18T05:17:20Z', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: '2026-09-18T05:17:21Z', content: 'Created At: 2026-09-18T13:17:24+08:00\nCompleted At: 2026-09-18T13:17:24+08:00\nFile Path: `/tmp/lighting.ts`\n70: orphan body' }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-09-18T05:17:22Z', content: 'Background task finished.' }),
  ].join('\n') + '\n');

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const sessions = new AntigravitySessionsProvider();
    const { messages } = await sessions.fetchHistory(sessionId, {});

    assert.equal(messages.some((msg) => /orphan body/.test(msg.content ?? '')), false);
    // Plain background-task status stays visible.
    assert.equal(
      messages.filter((msg) => msg.role === 'assistant').map((msg) => msg.content).join(''),
      'Background task finished.',
    );
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravitySessionsProvider fetchHistory renders replies and tool results from transcript fixtures', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-data-'));
  const sessionId = 'hist-sess-1';
  const transcriptDir = path.join(tempRoot, 'brain', sessionId, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });

  // Entry shapes mirror real transcripts: assistant replies arrive as
  // PLANNER_RESPONSE content, tool results as standalone MODEL entries typed
  // by the tool name.
  const entries = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-08-18T03:55:18Z', content: '<USER_REQUEST>\nlist files\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nmeta\n</ADDITIONAL_METADATA>' },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-18T03:55:20Z', tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] },
    { step_index: 3, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', exit_code: 0, created_at: '2026-08-18T03:55:21Z', content: 'file-a\nfile-b' },
    { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-18T03:55:22Z', content: 'Done listing.' },
    { step_index: 5, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: '2026-08-18T03:55:23Z', content: '{{ CHECKPOINT 0 }}' },
    { step_index: 6, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-18T03:55:24Z', tool_calls: [{ name: 'grep_search', args: { Query: 'foo' } }, { name: 'view_file', args: { AbsolutePath: '/tmp/x' } }] },
    { step_index: 7, source: 'MODEL', type: 'GREP_SEARCH', status: 'ERROR', created_at: '2026-08-18T03:55:25Z', content: 'not found' },
    { step_index: 8, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', exit_code: 0, created_at: '2026-08-18T03:55:26Z', content: 'file body' },
    { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-18T03:55:27Z', content: 'Reply without native step.' },
    { step_index: 9, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-08-18T03:55:28Z', content: 'Another reply.' },
  ];
  await fs.writeFile(
    path.join(transcriptDir, 'transcript.jsonl'),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const sessions = new AntigravitySessionsProvider();
    const result = await sessions.fetchHistory(sessionId, {});

    assert.equal(result.total, 9);

    const [
      userMsg,
      toolMsg,
      assistantMsg,
      compactionMsg,
      compactSummaryMsg,
      failedToolMsg,
      okToolMsg,
      assistantWithoutStep,
      nextAssistantMsg,
    ] = result.messages;
    assert.equal(userMsg?.kind, 'text');
    assert.equal(userMsg?.role, 'user');
    assert.equal(userMsg?.content, 'list files');

    assert.equal(toolMsg?.kind, 'tool_use');
    assert.equal(toolMsg?.toolName, 'run_command');
    assert.equal(toolMsg?.toolResult?.content, 'file-a\nfile-b');
    assert.equal(toolMsg?.toolResult?.isError, false);

    assert.equal(assistantMsg?.kind, 'text');
    assert.equal(assistantMsg?.role, 'assistant');
    assert.equal(assistantMsg?.content, 'Done listing.');
    assert.equal(assistantMsg?.providerRowKey, 'assistant-step:4');
    const matchingLiveReply = sessions.normalizeMessage({
      event: 'step_update',
      step_update: {
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'Done listing.',
      },
    }, sessionId)[0];
    assert.equal(matchingLiveReply?.providerRowKey, assistantMsg?.providerRowKey);

    // The checkpoint is a compaction: the shared row and its summary.
    assert.equal(compactionMsg?.compact?.phase, 'done');
    assert.equal(compactSummaryMsg?.isCompactSummary, true);
    assert.equal(compactSummaryMsg?.content, '{{ CHECKPOINT 0 }}');

    // Result entries pair with pending tool_uses in call order.
    assert.equal(failedToolMsg?.toolName, 'grep_search');
    assert.equal(failedToolMsg?.toolResult?.content, 'not found');
    assert.equal(failedToolMsg?.toolResult?.isError, true);
    assert.equal(okToolMsg?.toolName, 'view_file');
    assert.equal(okToolMsg?.toolResult?.content, 'file body');
    assert.equal(okToolMsg?.toolResult?.isError, false);
    assert.equal(assistantWithoutStep?.content, 'Reply without native step.');
    assert.equal(assistantWithoutStep?.providerRowKey, undefined);
    assert.equal(nextAssistantMsg?.providerRowKey, 'assistant-step:9');
    assert.notEqual(nextAssistantMsg?.providerRowKey, assistantMsg?.providerRowKey);
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravitySessionsProvider fetchHistory resolves the transcript via options.providerSessionId', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-data-ids-'));
  // App-created sessions are addressed by the stable app id but agy writes
  // its transcript under the provider-native conversation id, so the reader
  // must look the file up through options.providerSessionId.
  const appSessionId = 'app-sess-1';
  const providerSessionId = 'agy-conv-1';
  const transcriptDir = path.join(tempRoot, 'brain', providerSessionId, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });
  const entries = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-09-02T14:47:19Z', content: '<USER_REQUEST>\n你运行一下pwd\n</USER_REQUEST>' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-02T14:47:25Z', content: 'pwd output here.' },
  ];
  await fs.writeFile(
    path.join(transcriptDir, 'transcript.jsonl'),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const sessions = new AntigravitySessionsProvider();
    const byProviderHint = await sessions.fetchHistory(appSessionId, { providerSessionId });
    assert.equal(byProviderHint.total, 2, 'history must be found through the provider-native id hint');
    assert.equal(byProviderHint.messages[0]?.role, 'user');

    // Discovered sessions keep working with the positional-id fallback
    // (their app id equals the provider id).
    const byPositionalId = await sessions.fetchHistory(providerSessionId, {});
    assert.equal(byPositionalId.total, 2);
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravitySessionsProvider fetchHistory filters pure SYSTEM_MESSAGE entries and cleans mixed prompts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-data-sys-msg-'));
  const sessionId = 'agy-sys-msg-test';
  const transcriptDir = path.join(tempRoot, 'brain', sessionId, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });
  const entries = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-09-02T14:47:19Z',
      content: '<USER_REQUEST>\nhello world\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-09-02T14:47:20Z',
      content: 'hi there!',
    },
    {
      step_index: 2,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-09-02T14:47:21Z',
      content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-03T13:15:37Z sender=task-152 priority=MESSAGE_PRIORITY_HIGH content=Task finished with result: ok\n</SYSTEM_MESSAGE>',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-09-02T14:47:22Z',
      content: 'Task output noted.',
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-09-02T14:47:23Z',
      content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-03T13:15:37Z sender=task-152 priority=MESSAGE_PRIORITY_HIGH content=Task id "task-152" finished with result:\n\nThe command exited with code 0.\nOutput:\nDatabase schema applied\n</SYSTEM_MESSAGE>',
    },
    {
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-09-02T14:47:24Z',
      content: 'All tests passed successfully.',
    },
    {
      step_index: 6,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-09-02T14:47:25Z',
      content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-03T13:16:04Z sender=c37b34c9-47db-44eb-9724-bc3b3cd8ef95 priority=MESSAGE_PRIORITY_HIGH content=### 代码审查报告\n\n审核通过',
    },
    {
      step_index: 7,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-09-02T14:47:26Z',
      content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-03T13:42:37Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>',
    },
  ];
  await fs.writeFile(
    path.join(transcriptDir, 'transcript.jsonl'),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const sessions = new AntigravitySessionsProvider();
    const result = await sessions.fetchHistory(sessionId, {});
    // Pure SYSTEM_MESSAGE entries (step 2, 4, 7) must be stripped, while step 6 unclosed subagent report has its wrapper unwrapped
    assert.equal(result.total, 5);
    assert.equal(result.messages[0]?.role, 'user');
    assert.equal(result.messages[0]?.content, 'hello world');
    assert.equal(result.messages[1]?.role, 'assistant');
    assert.equal(result.messages[1]?.content, 'hi there!');
    assert.equal(result.messages[2]?.role, 'assistant');
    assert.equal(result.messages[2]?.content, 'Task output noted.');
    assert.equal(result.messages[3]?.role, 'assistant');
    assert.equal(result.messages[3]?.content, 'All tests passed successfully.');
    assert.equal(result.messages[4]?.role, 'assistant');
    assert.equal(result.messages[4]?.content, '### 代码审查报告\n\n审核通过');
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravitySessionsProvider fetchHistory returns empty for unknown sessions', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-data-empty-'));
  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const sessions = new AntigravitySessionsProvider();
    const result = await sessions.fetchHistory('missing-session', {});
    assert.equal(result.total, 0);
    assert.deepEqual(result.messages, []);
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravitySessionsProvider fetchHistory omits history-only thinking alongside companion text and tool calls', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-data-planner-'));
  const sessionId = 'session-planner-combo';
  const transcriptDir = path.join(tempRoot, 'brain', sessionId, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });

  const entries = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-09-15T12:00:00Z',
      content: 'Run a check and explain first',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-09-15T12:00:01Z',
      thinking: 'I need to check the directory status first.',
      content: 'I will list the directory contents to see the structure.',
      tool_calls: [
        {
          name: 'run_command',
          args: { CommandLine: 'ls -la' },
        },
      ],
    },
  ];
  await fs.writeFile(
    path.join(transcriptDir, 'transcript.jsonl'),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const sessions = new AntigravitySessionsProvider();
    const result = await sessions.fetchHistory(sessionId, {});
    assert.equal(result.total, 3); // user prompt + text message + tool_use
    assert.equal(result.messages[0]?.role, 'user');
    assert.equal(result.messages[1]?.kind, 'text');
    assert.equal(result.messages[1]?.role, 'assistant');
    assert.equal(result.messages[1]?.content, 'I will list the directory contents to see the structure.');
    assert.equal(result.messages[2]?.kind, 'tool_use');
    assert.equal(result.messages[2]?.toolName, 'run_command');
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravitySessionSynchronizer indexes only top-level summaries and archives indexed child agents', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-sync-'));
  // A mocked, empty home proves the synchronizer resolves the db through the
  // shared data root instead of the historical ~/.gemini hardcode.
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-sync-home-'));
  // The workspace the fixture conversations claim must exist outside the
  // system temporary directories or the admission gate refuses to index it.
  const workspaceDir = await createWorkspaceFixture();
  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  const restoreHomedir = mock.method(os, 'homedir', () => emptyHome);
  const previousDatabasePath = process.env.DATABASE_PATH;

  const summariesDb = new Database(getAntigravitySummariesDbPath());
  summariesDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      workspace_uris TEXT,
      last_modified_time TEXT,
      status TEXT,
      parent_conversation_id TEXT,
      nesting_depth INTEGER
    );
  `);
  summariesDb.prepare(`
    INSERT INTO conversation_summaries
      (conversation_id, title, workspace_uris, last_modified_time, status, parent_conversation_id, nesting_depth)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'fixture-conv-1',
    'Fixture Conversation',
    JSON.stringify([`file://${workspaceDir}`]),
    new Date().toISOString(),
    'ACTIVE',
    '',
    0,
  );
  summariesDb.prepare(`
    INSERT INTO conversation_summaries
      (conversation_id, title, workspace_uris, last_modified_time, status, parent_conversation_id, nesting_depth)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'fixture-child-agent-1',
    'Child Agent Conversation',
    JSON.stringify([`file://${workspaceDir}`]),
    new Date().toISOString(),
    'ACTIVE',
    'fixture-conv-1',
    1,
  );
  summariesDb.prepare(`
    INSERT INTO conversation_summaries
      (conversation_id, title, workspace_uris, last_modified_time, status, parent_conversation_id, nesting_depth)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'fixture-child-agent-negative-depth',
    'Malformed Child Agent Conversation',
    JSON.stringify([`file://${workspaceDir}`]),
    new Date().toISOString(),
    'ACTIVE',
    '',
    -1,
  );

  const transcriptDir = path.join(tempRoot, 'brain', 'fixture-conv-1', '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });
  const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
  await fs.writeFile(transcriptPath, '{"type":"USER_INPUT"}\n');

  closeConnection();
  process.env.DATABASE_PATH = path.join(emptyHome, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession(
      'fixture-other-provider-session',
      'zcode',
      workspaceDir,
      'Unrelated Provider Session',
    );
    sessionsDb.assignProviderSessionId('fixture-other-provider-session', 'fixture-child-agent-1');
    sessionsDb.createSession(
      'fixture-child-agent-1',
      'antigravity',
      workspaceDir,
      'Previously Indexed Child Agent',
    );
    sessionsDb.createSession(
      'fixture-child-agent-negative-depth',
      'antigravity',
      workspaceDir,
      'Malformed Previously Indexed Child Agent',
    );
    const synchronizer = new AntigravitySessionSynchronizer();
    const lifecycle = await synchronizer.synchronizeFileWithLifecycle(getAntigravitySummariesDbPath());

    assert.equal(lifecycle.updatedSessionId, 'fixture-conv-1');
    assert.deepEqual(lifecycle.removedSessionIds, [
      'fixture-child-agent-1',
      'fixture-child-agent-negative-depth',
    ]);
    const synced = sessionsDb.getSessionByProviderSessionId('fixture-conv-1');
    assert.ok(synced, 'fixture conversation must be indexed into the sessions db');
    assert.equal(synced?.jsonl_path, transcriptPath, 'jsonl_path should record the transcript location');
    assert.equal(
      sessionsDb.getArchivedSessions().some((session) => (
        session.provider === 'antigravity'
        && session.provider_session_id === 'fixture-child-agent-1'
      )),
      true,
      'previously indexed child agents must leave the active session list',
    );
    assert.equal(
      sessionsDb.getSessionByProviderSessionId('fixture-child-agent-negative-depth')?.isArchived,
      1,
      'non-zero nesting depth must also archive a previously indexed child agent',
    );
    assert.equal(
      sessionsDb.getSessionById('fixture-other-provider-session')?.isArchived,
      0,
      'an unrelated provider session with the same provider-native id must stay active',
    );
  } finally {
    summariesDb.close();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    restoreHomedir.mock.restore();
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.rm(emptyHome, { recursive: true, force: true });
  }
});

test('AntigravityProviderModels reads the default model from the overridden data root', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-models-'));
  // Empty mocked home: only the env-overridden root holds settings.json, so
  // the settings fallback must resolve through the shared data root.
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-models-home-'));
  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  const restoreHomedir = mock.method(os, 'homedir', () => emptyHome);

  try {
    await fs.writeFile(
      path.join(tempRoot, 'settings.json'),
      JSON.stringify({ model: 'fixture-model-from-settings' }),
      'utf8',
    );

    const models = new AntigravityProviderModels();
    const active = await models.getCurrentActiveModel();
    assert.equal(active.model, 'fixture-model-from-settings');

    // agy stores the full suffixed id; the reported model matches the
    // base-model catalog, so the picker can resolve a label for it.
    await fs.writeFile(
      path.join(tempRoot, 'settings.json'),
      JSON.stringify({ model: 'gemini-3.7-flash-medium' }),
      'utf-8',
    );
    const suffixed = await models.getCurrentActiveModel();
    assert.equal(suffixed.model, 'gemini-3.7-flash');
  } finally {
    restoreHomedir.mock.restore();
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.rm(emptyHome, { recursive: true, force: true });
  }
});

test('AntigravityProviderModels normalizes a display-label default model from settings', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-models-label-'));
  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);

  try {
    // agy's own picker writes the display label, not the id; reporting it
    // verbatim would poison the session model chain and make every spawn
    // combine the label with --effort, which the CLI rejects.
    await fs.writeFile(
      path.join(tempRoot, 'settings.json'),
      JSON.stringify({ model: 'Gemini 3.8 Flash (Medium)' }),
      'utf8',
    );

    const models = new AntigravityProviderModels();
    const active = await models.getCurrentActiveModel();
    assert.equal(active.model, 'gemini-3.8-flash');
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravityProviderAuth validates token expiry and extracts the account email', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-auth-expiry-'));
  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  const restoreAgyPath = withEnvValue('CLOUDCLI_AGY_PATH', path.join(tempRoot, 'agy'));
  // Isolate from the real keychain so the file fixture alone decides the verdict.
  const restoreSkipKeychain = withEnvValue('CLOUDCLI_ANTIGRAVITY_SKIP_KEYCHAIN', '1');
  await fs.writeFile(path.join(tempRoot, 'agy'), '#!/bin/sh\n', { mode: 0o755 });
  const jwtPayload = (payload: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(payload)).toString('base64url');

  try {
    const auth = new AntigravityProviderAuth();

    // A valid token whose email only lives in the id_token JWT payload.
    await fs.writeFile(path.join(tempRoot, 'antigravity-oauth-token'), JSON.stringify({
      access_token: 'at',
      refresh_token: 'rt',
      expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      id_token: `header.${jwtPayload({ email: 'user@example.com' })}.signature`,
    }));
    const signedIn = await auth.getStatus();
    assert.equal(signedIn.authenticated, true);
    assert.equal(signedIn.email, 'user@example.com');

    // An expired token without a refresh token must not count as logged in.
    await fs.writeFile(path.join(tempRoot, 'antigravity-oauth-token'), JSON.stringify({
      access_token: 'at',
      expiry: new Date(Date.now() - 60 * 1000).toISOString(),
    }));
    const expired = await auth.getStatus();
    assert.equal(expired.authenticated, false);
    assert.match(expired.error ?? '', /expired/);

    // An expired access token with a refresh token can renew silently.
    await fs.writeFile(path.join(tempRoot, 'antigravity-oauth-token'), JSON.stringify({
      access_token: 'at',
      refresh_token: 'rt',
      expiry: new Date(Date.now() - 60 * 1000).toISOString(),
    }));
    const refreshable = await auth.getStatus();
    assert.equal(refreshable.authenticated, true);

    // Unparseable token files keep the previous "exists = authenticated"
    // behavior so unknown schemas never lock existing users out.
    await fs.writeFile(path.join(tempRoot, 'antigravity-oauth-token'), 'not json at all');
    const opaque = await auth.getStatus();
    assert.equal(opaque.authenticated, true);
    assert.equal(opaque.email, null);
  } finally {
    restoreAgyPath();
    restoreDataDir();
    restoreSkipKeychain();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('AntigravitySessionsProvider reads token usage from the indexed transcript', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-token-usage-'));
  const transcriptPath = path.join(tempDirectory, 'transcript.jsonl');

  try {
    await fs.writeFile(transcriptPath, [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'hello' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'hi' }),
      JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          usage: { input_tokens: 250, output_tokens: 80, total_tokens: 330 },
        },
      }),
    ].join('\n'));

    const sessions = new AntigravitySessionsProvider();
    assert.deepEqual(
      await sessions.getTokenUsage({
        appSessionId: 'app-session',
        nativeSessionId: 'conv-1',
        jsonlPath: transcriptPath,
        projectPath: null,
      }),
      { used: 330, inputTokens: 250, outputTokens: 80, breakdown: { input: 250, output: 80 } },
    );
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test('AntigravitySessionsProvider prefers persisted token_usage.json over the transcript', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-token-usage-json-'));
  // Transcript candidates live at brain/<id>/.system_generated/logs/transcript.jsonl;
  // the session's brain directory (which holds token_usage.json) is that id's folder.
  const transcriptPath = path.join(
    tempDirectory, 'brain', 'conv-2', '.system_generated', 'logs', 'transcript.jsonl',
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.writeFile(transcriptPath, JSON.stringify({
    event: 'result',
    result: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  }));
  await fs.writeFile(
    path.join(tempDirectory, 'brain', 'conv-2', 'token_usage.json'),
    JSON.stringify({ used: 999, inputTokens: 900, outputTokens: 99, breakdown: { input: 900, output: 99 } }),
  );

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempDirectory);

  try {
    const sessions = new AntigravitySessionsProvider();
    const usage = await sessions.getTokenUsage({
      appSessionId: 'app-session',
      nativeSessionId: 'conv-2',
      jsonlPath: null,
      projectPath: null,
    });

    assert.equal(usage.used, 999);
  } finally {
    restoreDataDir();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test('AntigravitySessionsProvider cleanupSession removes summary row, conversation dbs, presence lock, and brain dirs', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-cleanup-'));
  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempDirectory);

  try {
    const summariesDbPath = path.join(tempDirectory, 'conversation_summaries.db');
    const db = new Database(summariesDbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT,
        last_modified_time TEXT
      );
      INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time)
      VALUES ('test-conv-123', 'Test Title', '["/tmp/test"]', '2026-09-01T00:00:00.000Z');
    `);
    db.close();

    const convDbPath = path.join(tempDirectory, 'conversations', 'test-conv-123.db');
    const convWalPath = path.join(tempDirectory, 'conversations', 'test-conv-123.db-wal');
    const lockPath = path.join(tempDirectory, 'presence', 'test-conv-123.lock');
    const brainDir = path.join(tempDirectory, 'brain', 'test-conv-123');

    await fs.mkdir(path.dirname(convDbPath), { recursive: true });
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.mkdir(brainDir, { recursive: true });

    await fs.writeFile(convDbPath, 'dummy db');
    await fs.writeFile(convWalPath, 'dummy wal');
    await fs.writeFile(lockPath, 'dummy lock');
    await fs.writeFile(path.join(brainDir, 'test.txt'), 'brain content');

    const sessions = new AntigravitySessionsProvider();
    const removed = await sessions.cleanupSession('test-conv-123', null);

    assert.equal(removed, true);

    const checkDb = new Database(summariesDbPath);
    const row = checkDb.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get('test-conv-123');
    checkDb.close();
    assert.equal(row, undefined);

    assert.equal(
      await fs.access(convDbPath).then(() => true).catch(() => false),
      false,
    );
    assert.equal(
      await fs.access(convWalPath).then(() => true).catch(() => false),
      false,
    );
    assert.equal(
      await fs.access(lockPath).then(() => true).catch(() => false),
      false,
    );
    assert.equal(
      await fs.access(brainDir).then(() => true).catch(() => false),
      false,
    );
  } finally {
    restoreDataDir();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

/**
 * Both transports must name one tool call the same way.
 *
 * Live reports a tool at its own step index; the transcript declares it on the
 * planner entry one step earlier. The two formulas used to disagree outright —
 * `tool_${step}` live against `tool_${step}_${position}` persisted — so every
 * card rendered twice as soon as a live run met its own history. Confirmed on
 * a real turn: the tool executes at step 2 while its planner entry sits at
 * step 1, and both sides now say `tool_2`.
 */
test('a tool call carries the same id live and from history', async () => {
  const { AntigravitySessionsProvider } = await import(
    '@/modules/providers/list/antigravity/antigravity-sessions.provider.js'
  );
  const provider = new AntigravitySessionsProvider();

  const liveRows = provider.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 2,
      step_type: 'tool',
      state: 'ACTIVE',
      tool_name: 'run_command',
      tool_info: { parameters: { command: 'ls' } },
    },
  }, 'sess-tool');

  const liveToolUse = liveRows.find((row) => row.kind === 'tool_use');
  assert.ok(liveToolUse);
  assert.equal(liveToolUse.toolId, 'tool_2');

  // The persisted side declares the same call on the planner entry at step 1.
  const declaringStepIndex = 1;
  const positionInEntry = 0;
  assert.equal(
    `tool_${declaringStepIndex + 1 + positionInEntry}`,
    liveToolUse.toolId,
    'the persisted formula must land on the live id',
  );
});

// ---------------------------------------------------------------------------
// invoke_subagent: one call that creates N agents is N Agent cards.
// ---------------------------------------------------------------------------

const SUB_ONE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SUB_TWO = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** Writes a parent transcript whose step 3 invokes two subagents, plus the first one's own transcript. */
type SubagentFixtureOptions = {
  /** Whether the first agent's report reached the parent's transcript. */
  reported: boolean;
  /** Whether the step holding the creation receipt was written yet. Default true. */
  receipt?: boolean;
  /** How the second agent's own transcript ends. Default: it has none. */
  secondEnding?: 'normal' | 'error' | 'unfinished';
};

async function writeSubagentFixture(tempRoot: string, sessionId: string, options: SubagentFixtureOptions): Promise<void> {
  const logsDir = (id: string) => path.join(tempRoot, 'brain', id, '.system_generated', 'logs');
  await fs.mkdir(logsDir(sessionId), { recursive: true });
  await fs.mkdir(logsDir(SUB_ONE), { recursive: true });

  const created = [
    'Created At: 2026-09-03T08:26:58+08:00',
    'Completed At: 2026-09-03T08:26:58+08:00',
    'Created the following subagents:',
    JSON.stringify({ conversationId: SUB_ONE, logAbsoluteUri: `file:///brain/${SUB_ONE}/.system_generated/logs/transcript.jsonl` }, null, 2),
    JSON.stringify({ conversationId: SUB_TWO, logAbsoluteUri: `file:///brain/${SUB_TWO}/.system_generated/logs/transcript.jsonl` }, null, 2),
    'The subagents will send you a message when they have completed their task.',
  ].join('\n');
  const report = [
    'The following is a <SYSTEM_MESSAGE> not actually sent by the user.',
    '',
    '<SYSTEM_MESSAGE>',
    `[Message] timestamp=2026-09-03T00:27:54Z sender=${SUB_ONE} priority=MESSAGE_PRIORITY_LOW content=Review done: two problems.`,
    '</SYSTEM_MESSAGE>',
  ].join('\n');

  const parentRows: Array<Record<string, unknown>> = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-09-03T00:26:50Z', content: '<USER_REQUEST>\nreview it\n</USER_REQUEST>' },
    {
      step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-03T00:26:54Z',
      tool_calls: [{ name: 'invoke_subagent', args: { Subagents: [
        { Role: 'Code Reviewer', TypeName: 'research', Prompt: 'Review the diff', Model: 'inherit' },
        { Role: 'Test Runner', TypeName: 'research', Prompt: 'Run the tests', Model: 'inherit' },
      ] } }],
    },
    ...(options.receipt === false ? [] : [{ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-09-03T00:26:58Z', content: created }]),
    ...(options.reported
      ? [{ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-03T00:27:54Z', content: report }]
      : []),
  ];
  await fs.writeFile(path.join(logsDir(sessionId), 'transcript.jsonl'), parentRows.map((row) => JSON.stringify(row)).join('\n') + '\n');

  const childRows = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-09-03T00:27:00Z', content: '<USER_REQUEST>\nReview the diff\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-03T00:27:10Z', tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/tmp/a.ts' } }] },
    { step_index: 2, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: '2026-09-03T00:27:11Z', content: 'Created At: 2026-09-03T08:27:11+08:00\nCompleted At: 2026-09-03T08:27:11+08:00\nFile Path: `/tmp/a.ts`\n1: body' },
  ];
  await fs.writeFile(path.join(logsDir(SUB_ONE), 'transcript.jsonl'), childRows.map((row) => JSON.stringify(row)).join('\n') + '\n');

  if (options.secondEnding) {
    await fs.mkdir(logsDir(SUB_TWO), { recursive: true });
    const head = { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-09-03T00:27:00Z', content: '<USER_REQUEST>\nRun the tests\n</USER_REQUEST>' };
    const tail = {
      normal: { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-03T00:27:30Z', content: 'All tests pass.' },
      error: { step_index: 1, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: '2026-09-03T00:27:30Z', error: 'API error: connection reset' },
      unfinished: { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', created_at: '2026-09-03T00:27:30Z', content: 'Tool is running as a background task' },
    }[options.secondEnding];
    await fs.writeFile(path.join(logsDir(SUB_TWO), 'transcript.jsonl'), [head, tail].map((row) => JSON.stringify(row)).join('\n') + '\n');
  }
}

test('history turns one invoke_subagent call into one Agent card per created subagent', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-subagents-'));
  const sessionId = 'hist-subagents';
  await writeSubagentFixture(tempRoot, sessionId, { reported: true });

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const { messages } = await new AntigravitySessionsProvider().fetchHistory(sessionId, {});
    const cards = messages.filter((msg) => msg.kind === 'tool_use');

    assert.equal(messages.some((msg) => msg.toolName === 'invoke_subagent'), false);
    assert.deepEqual(cards.map((card) => [card.toolName, card.toolId]), [
      ['Agent', `tool_3:${SUB_ONE}`],
      ['Agent', `tool_3:${SUB_TWO}`],
    ]);
    assert.deepEqual(cards[0].toolInput, { subagent_type: 'Code Reviewer', description: 'Review the diff', prompt: 'Review the diff' });

    // The agent that reported back is done and carries its report and its own work.
    assert.equal(cards[0].subagent?.id, SUB_ONE);
    assert.equal(cards[0].subagent?.status, 'completed');
    assert.equal(cards[0].toolResult?.content, 'Review done: two problems.');
    assert.equal(cards[0].subagentTools?.length, 1);
    assert.equal(cards[0].subagentTools?.[0].toolName, 'view_file');

    // The one that never reported, with no process left to run it, is stopped rather than spinning.
    assert.equal(cards[1].subagent?.id, SUB_TWO);
    assert.equal(cards[1].subagent?.status, 'stopped');

    // The creation receipt must not be paired onto some other call as its result.
    assert.equal(cards.every((card) => !/Created the following subagents/.test(card.toolResult?.content ?? '')), true);
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('the live subagent step and the persisted call name each card the same way', async () => {
  const sessions = new AntigravitySessionsProvider();
  const live = sessions.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 3, state: 'DONE', step_type: 'subagent', tool_name: 'invoke_subagent',
      subagent_info: { subagents: [
        { role: 'Code Reviewer', initial_prompt: 'Review the diff', conversation_id: SUB_ONE },
        { role: 'Test Runner', initial_prompt: 'Run the tests', conversation_id: SUB_TWO },
      ] },
    },
  }, 'hist-subagents');

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-subagents-parity-'));
  await writeSubagentFixture(tempRoot, 'hist-subagents', { reported: false });
  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const { messages } = await sessions.fetchHistory('hist-subagents', {});
    const persisted = messages.filter((msg) => msg.kind === 'tool_use');

    assert.deepEqual(live.map((msg) => [msg.id, msg.toolId, msg.toolName, msg.toolInput]),
      persisted.map((msg) => [msg.id, msg.toolId, msg.toolName, msg.toolInput]));
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('an agent with no report is judged by how its own transcript ends', async () => {
  const statusesFor = async (secondEnding: SubagentFixtureOptions['secondEnding']) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-judge-'));
    await writeSubagentFixture(tempRoot, 'hist-judge', { reported: false, secondEnding });
    const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
    try {
      const { messages } = await new AntigravitySessionsProvider().fetchHistory('hist-judge', {});
      return messages.filter((msg) => msg.kind === 'tool_use').map((msg) => msg.subagent?.status);
    } finally {
      restoreDataDir();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  };

  // The first agent's transcript stops on a tool result with no reply after
  // it, so without a report it counts as unfinished.
  assert.deepEqual(await statusesFor('normal'), ['stopped', 'completed']);
  assert.deepEqual(await statusesFor('error'), ['stopped', 'failed']);
  assert.deepEqual(await statusesFor('unfinished'), ['stopped', 'stopped']);
  assert.deepEqual(await statusesFor(undefined), ['stopped', 'stopped'], 'no transcript at all: nobody can say it finished');
});

test('before the receipt step is written, history adopts the ids and status the live run tracks', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-midsession-'));
  await writeSubagentFixture(tempRoot, 'hist-mid', { reported: false, receipt: false });
  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  antigravityBackgroundWork.start('hist-mid', { taskId: SUB_ONE, toolUseId: `tool_3:${SUB_ONE}`, taskType: 'local_agent', description: 'Code Reviewer' });
  antigravityBackgroundWork.start('hist-mid', { taskId: SUB_TWO, toolUseId: `tool_3:${SUB_TWO}`, taskType: 'local_agent', description: 'Test Runner' });
  try {
    const { messages } = await new AntigravitySessionsProvider().fetchHistory('hist-mid', {});
    const cards = messages.filter((msg) => msg.kind === 'tool_use');
    assert.deepEqual(cards.map((card) => card.toolId), [`tool_3:${SUB_ONE}`, `tool_3:${SUB_TWO}`]);
    assert.deepEqual(cards.map((card) => card.subagent?.status), ['running', 'running']);
  } finally {
    antigravityBackgroundWork.clearSession('hist-mid');
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('two spawn calls without step indexes get distinct ids, and only a receipt pairs with a spawn', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-unindexed-'));
  const sessionId = 'hist-unindexed';
  const logs = path.join(tempRoot, 'brain', sessionId, '.system_generated', 'logs');
  await fs.mkdir(logs, { recursive: true });
  const spawn = (role: string) => ({
    source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-03T00:26:54Z',
    tool_calls: [{ name: 'invoke_subagent', args: { Subagents: [{ Role: role, Prompt: `${role} task` }] } }],
  });
  const rows = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-09-03T00:26:50Z', content: '<USER_REQUEST>\ngo\n</USER_REQUEST>' },
    spawn('First'),
    spawn('Second'),
    // A tool call whose result sits at the step a receipt would; the result is
    // not a receipt, so it belongs to the tool.
    { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-09-03T00:27:00Z', tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/tmp/a' } }] },
    { step_index: 6, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: '2026-09-03T00:27:01Z', content: 'Created At: x\nCompleted At: y\nFile Path: `/tmp/a`\n1: body' },
  ];
  await fs.writeFile(path.join(logs, 'transcript.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const { messages } = await new AntigravitySessionsProvider().fetchHistory(sessionId, {});
    const agentIds = messages.filter((msg) => msg.toolName === 'Agent').map((msg) => msg.toolId);
    assert.equal(new Set(agentIds).size, 2);
    const view = messages.find((msg) => msg.toolName === 'view_file');
    assert.match(view?.toolResult?.content ?? '', /body/);
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('the live spawn call is not drawn as a tool row beside its Agent cards, so live matches history', () => {
  const sessions = new AntigravitySessionsProvider();
  const active = sessions.normalizeMessage({
    event: 'step_update',
    step_update: { step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'invoke_subagent', tool_info: { parameters: { Subagents: [{ Role: 'Reviewer', Prompt: 'Review' }] } } },
  }, 'live-spawn');
  const done = sessions.normalizeMessage({
    event: 'step_update',
    step_update: { step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'invoke_subagent', tool_info: { output: 'Created the following subagents: ...' } },
  }, 'live-spawn');
  assert.deepEqual(active, []);
  assert.deepEqual(done, []);

  // Other tools are unaffected.
  const other = sessions.normalizeMessage({
    event: 'step_update',
    step_update: { step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'ls' } } },
  }, 'live-spawn');
  assert.equal(other[0]?.toolName, 'run_command');
});

test('an Antigravity checkpoint is a compaction: the shared row and its summary, named alike live and from history', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-checkpoint-'));
  const sessionId = 'checkpoint-session';
  const transcriptDir = path.join(tempRoot, 'brain', sessionId, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-23T14:54:15Z', content: '<USER_REQUEST>\n/compact\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 3, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: '2026-10-23T14:54:21Z', content: '# Resuming from a compaction\n\n<summary>remember banana</summary>' }),
  ].join('\n'));

  const restoreDataDir = withEnvValue('CLOUDCLI_ANTIGRAVITY_DATA_DIR', tempRoot);
  try {
    const sessions = new AntigravitySessionsProvider();
    const { messages } = await sessions.fetchHistory(sessionId, {});
    const rows = messages.filter((message) => message.compact || message.isCompactSummary);
    assert.deepEqual(rows.map((row) => [row.id, row.content, row.compact?.phase ?? null, row.isCompactSummary ?? false]), [
      [`msg_${sessionId}_3_compact`, 'Compacted', 'done', false],
      [`msg_${sessionId}_3_summary`, '# Resuming from a compaction\n\n<summary>remember banana</summary>', null, true],
    ]);

    const live = (state: string) => sessions.normalizeMessage({
      event: 'step_update',
      step_update: { conversation_id: sessionId, step_index: 3, state, step_type: 'checkpoint' },
    }, sessionId);
    const [running] = live('ACTIVE');
    assert.equal(running.id, `msg_${sessionId}_3_compact`);
    assert.equal(running.compact?.phase, 'running');
    const [done] = live('DONE');
    assert.equal(done.id, rows[0].id);
    assert.equal(done.content, 'Compacted');
  } finally {
    restoreDataDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
