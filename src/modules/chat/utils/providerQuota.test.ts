import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildProviderQuotaUrl,
  resolveIsActiveQuotaGroup,
  resolveQuotaProvider,
} from '@/modules/chat/utils/providerQuota';

test('resolveQuotaProvider enables only providers with account quota adapters', () => {
  assert.equal(resolveQuotaProvider('antigravity'), 'antigravity');
  assert.equal(resolveQuotaProvider('codex'), 'codex');
  assert.equal(resolveQuotaProvider('zcode'), 'zcode');
  assert.equal(resolveQuotaProvider('claude'), null);
  assert.equal(resolveQuotaProvider(undefined), null);
});

test('buildProviderQuotaUrl addresses the active provider and optional refresh', () => {
  assert.equal(buildProviderQuotaUrl('codex'), '/api/providers/quota?provider=codex');
  assert.equal(
    buildProviderQuotaUrl('antigravity', true),
    '/api/providers/quota?provider=antigravity&refresh=true',
  );
});

test('resolveIsActiveQuotaGroup identifies active session group accurately', () => {
  // 1. 单个组必然为当前组（Codex, ZCode）
  const zcodeGroup = { name: 'ZCode (TIER_1)', description: 'BigModel Coding Plan account quota' };
  assert.equal(resolveIsActiveQuotaGroup('glm-5.3', zcodeGroup, 1), true);
  assert.equal(resolveIsActiveQuotaGroup('glm-4.5', zcodeGroup, 1), true);

  const codexGroup = { name: 'Codex (PLUS)', description: 'Codex account-level rate limits' };
  assert.equal(resolveIsActiveQuotaGroup('gpt-5.4', codexGroup, 1), true);

  // 2. 多个组按模型体系进行匹配（Antigravity）
  const geminiGroup = { name: 'Gemini Models', description: 'Gemini Flash, Gemini Pro' };
  const claudeGptGroup = { name: 'Claude and GPT models', description: 'Claude Opus, GPT-OSS' };

  assert.equal(resolveIsActiveQuotaGroup('gemini-3.7-flash', geminiGroup, 2), true);
  assert.equal(resolveIsActiveQuotaGroup('gemini-3.7-flash', claudeGptGroup, 2), false);

  assert.equal(resolveIsActiveQuotaGroup('claude-3-7-sonnet', claudeGptGroup, 2), true);
  assert.equal(resolveIsActiveQuotaGroup('claude-3-7-sonnet', geminiGroup, 2), false);

  assert.equal(resolveIsActiveQuotaGroup('gpt-5.3-codex', claudeGptGroup, 2), true);
  assert.equal(resolveIsActiveQuotaGroup('gpt-5.3-codex', geminiGroup, 2), false);
});
