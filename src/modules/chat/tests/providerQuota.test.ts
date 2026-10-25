import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildProviderQuotaUrl,
  resolveIsActiveQuotaGroup,
  sortQuotaGroupsForModel,
} from '@/modules/chat/utils/providerQuota';

test('buildProviderQuotaUrl addresses the active provider and optional refresh', () => {
  assert.equal(buildProviderQuotaUrl('codex'), '/api/providers/quota?provider=codex');
  assert.equal(
    buildProviderQuotaUrl('opencode'),
    '/api/providers/quota?provider=opencode',
  );
  assert.equal(
    buildProviderQuotaUrl('antigravity', true),
    '/api/providers/quota?provider=antigravity&refresh=true',
  );
});

test('sortQuotaGroupsForModel shows the active Codex quota before reserve without changing API data', () => {
  const reserve = { name: 'gpt-reserve', description: 'Codex Plus plan' };
  const codex = { name: 'Codex', description: 'Codex Plus plan' };
  const groups = [reserve, codex];

  assert.deepEqual(sortQuotaGroupsForModel(groups, 'gpt-5.6-terra', 'bucket'), [codex, reserve]);
  assert.deepEqual(groups, [reserve, codex]);
  assert.deepEqual(sortQuotaGroupsForModel(groups, undefined, 'bucket'), groups);
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

  // 3. Codex 的专属储备池（如 gpt-reserve）与主池同属 GPT 家族，
  //    仅当模型名被储备池自身文本明确提及时才判定为当前组，
  //    避免任意 GPT 模型都被误标记为正在使用储备池。
  const codexMainGroup = { name: 'Codex', description: 'Codex Plus plan' };
  const codexReserveGroup = { name: 'gpt-reserve', description: 'Codex Plus plan' };

  assert.equal(resolveIsActiveQuotaGroup('gpt-5.6-terra', codexMainGroup, 2, 'bucket'), true);
  assert.equal(resolveIsActiveQuotaGroup('gpt-5.6-terra', codexReserveGroup, 2, 'bucket'), false);

  const codexLunaReserveGroup = { name: 'gpt-reserve', description: 'gpt-5.6-luna only' };
  assert.equal(resolveIsActiveQuotaGroup('gpt-5.6-luna', codexLunaReserveGroup, 2, 'bucket'), true);
});
