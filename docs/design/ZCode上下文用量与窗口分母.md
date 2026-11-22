# ZCode 上下文用量与窗口分母

状态:实施中(2026-11-22)

## 目标

ZCode 会话的 token 用量在 WebUI 无分母:＋ 面板用量行不显示数字/进度条,≥85% 徽标永不出现(桌面芯片只有裸数字)。且 used 把 cache.read 重复计入——真库 12/12 样本证明引擎 `input` 已含 cache.read——数字虚大一倍。

## 方案(server/modules/providers/list/zcode/)

- 引擎 `message.data.tokens` 自带 `total` = input+output+reasoning+cache.write(本轮上下文占用);`readTokenTotals` 透传它,`used`/累计改按此式,不再加第二遍 cache.read。老消息无 `total` 时回退同式自行求和。
- 分母:新增 `readZCodeModelContextLimit(modelId)`(zcode-models.provider)读引擎 `~/.zcode/cli/config.json` 的 `provider.*.models[key].limit.context`(真机 GLM-5.3 = 1,000,000);会话模型取自既有 `readZCodeSessionModelInfoFromDb`(消息 `modelID`)。读不到兜底 200_000(2026-11-22 用户拍板)。
- `getTokenUsage` 与 `fetchHistory` 的 tokenUsage 都带分母,前端(面板数字/进度条/徽标阈值/桌面芯片)零改动自动生效。

## 验证

- zcode-sessions.test.ts 追加:total 透传、无 total 兜底式、分母来自 config、缺省 200K。
- zcode-models.test.ts 追加 readZCodeModelContextLimit(config 命中/缺文件/禁用 provider)。
- `npm test`(providers 套件)、typecheck、lint、build。

## 风险

- cumulative 口径纠偏(去掉重复 cache.read),/cost 详情累计下降——向引擎口径对齐,属修正。
- 引擎未写 config.json 的私有模型走 200K 兜底,数字可能有偏差,有配置即准。
