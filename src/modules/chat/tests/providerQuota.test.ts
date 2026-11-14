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

  // 4. ZCode 把一个账号拆成多个限额组:编码套餐池、app 级 MCP 额度、体验套餐。
  //    模型 id 的套餐段决定归属;裸模型名默认落在编码套餐池,
  //    MCP 与体验套餐是平台赠予,永远不会是"当前会话模型组"。
  const zcodeLite = { name: 'ZCode (LITE)', description: 'BigModel Coding Plan account quota' };
  const zcodeMcp = { name: 'ZCode MCP', description: 'ZCode app MCP call allowance' };
  const zcodeStartPlan = { name: 'ZCode Start Plan', description: 'ZCode start plan balance' };

  assert.equal(resolveIsActiveQuotaGroup('account:bigmodel-individual-coding-plan/glm-5.3-flash', zcodeLite, 3, 'bucket'), true);
  assert.equal(resolveIsActiveQuotaGroup('account:bigmodel-individual-coding-plan/glm-5.3-flash', zcodeMcp, 3, 'bucket'), false);
  assert.equal(resolveIsActiveQuotaGroup('account:bigmodel-individual-coding-plan/glm-5.3-flash', zcodeStartPlan, 3, 'bucket'), false);

  assert.equal(resolveIsActiveQuotaGroup('glm-5.3-flash', zcodeLite, 3, 'bucket'), true);
  assert.equal(resolveIsActiveQuotaGroup('glm-5.3-flash', zcodeMcp, 3, 'bucket'), false);
  assert.equal(resolveIsActiveQuotaGroup('glm-5.3-flash', zcodeStartPlan, 3, 'bucket'), false);

  assert.equal(resolveIsActiveQuotaGroup('account:bigmodel-start-plan/glm-5.3-flash', zcodeLite, 3, 'bucket'), false);
  assert.equal(resolveIsActiveQuotaGroup('account:bigmodel-start-plan/glm-5.3-flash', zcodeMcp, 3, 'bucket'), false);
  assert.equal(resolveIsActiveQuotaGroup('account:bigmodel-start-plan/glm-5.3-flash', zcodeStartPlan, 3, 'bucket'), true);
});
