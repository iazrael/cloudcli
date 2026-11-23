# ZCode 会话标题

状态：已实现（第二轮：create 需同时携带 `thoughtLevel`）
基准：ZCode 3.18.2 / 2026-11-23

## 目标与范围

修复 cloudcli 发起的 ZCode 会话侧栏标题一直是原始提问、不变成引擎 AI 标题的问题。仅修改 zcode runtime 新建会话时下发给引擎的参数（`session/create` 携带本次解析的模型选择与推理档位）；不改引擎、不改同步器、不改用户 `~/.zcode/cli/config.json`。

## 根因

cloudcli 的 zcode 标题来自引擎 SQLite（`title_source='generated'` 时同步器才采信）。引擎在 turn 0 发起一次独立的标题生成模型调用，模型取 `titleGeneration.modelSelection ?? 会话级模型选择`（`getSessionModelSelection()`），调用前校验该选择的 `options.reasoningLevel`，缺失即报 "Reasoning level is required for <provider>/<model>"（引擎内部 `reasoning-level-missing`）。

第一层（11-22 前后，57448cd4 已修）：

- cloudcli `session/create` 只传 workspace，新会话的会话级模型落到引擎默认值，即 cloudcli 物化进 `cloudcli-provider-config.json` 的 `defaultModelSelection` —— 来自用户 config.json 旧配置的 `bigmodel-coding-plan/GLM-5.3-Flash`（静态 API Key）。
- 套餐升级后（11-15 认证改造），该静态 Key 引擎侧认证失败：日志 `model.client_signing.handshake_failed` → `unsigned_sent` → `session_title_generation.failed`（"Provider authentication failed."），11-16 起每日多次。
- 对话主回合不受影响，因为每回合带 per-turn 选择 `account:bigmodel-individual-coding-plan`（OAuth/项目令牌，走 runtime headers 桥接）。
- 最近的会话连失败日志都没有：标题调用对坏 provider 触发 runtime headers 延迟门，被无限推迟。
- 反证：11-21 唯一成功生成标题的 cloudcli 会话（sess_17e1fde6），恰好在创建后被 resume 修复路径 `session/setModel` 切到 account provider，随后标题落地。

第二层（11-23 起实锤，本节为准）：57448cd4 让 create 携带 `model` 后标题仍失败，错误变为 "Reasoning level is required"——

- 引擎 create 处理把 `model` 参数经 `formatProtocolModelSelection` 字符串化为 `"providerId/modelId"` 再 `setModel`，**`model.options.reasoningLevel` 被丢弃**；推理档位在 create schema 里是独立的顶层字段 `thoughtLevel`（引擎侧 `listThoughtLevels()` 校验，非法值记 `session_create.thought_level_skipped` 告警后跳过）。
- `setThoughtLevel(level)` 会把档位合并进会话级选择的 `options.reasoningLevel` 并写回（`setSessionModelSelection`），这是档位进入会话级选择的唯一通路；`session/setModel` RPC（resume 修复路径）走对象形状、保留 options，与 create 的字符串化不同。
- 实证（stdio 探针，隔离 storage + 假 provider，零模型调用）：create 带 `thoughtLevel:'max'` → `settings.model.current = {providerId, modelId, options:{reasoningLevel:'max'}}`；不带 → `model.current` 无 options、`thoughtLevel` 无 current，与生产失败会话的落库形状一致。
- 引擎 turn-0 标题生成只尝试一次、失败不重试（引擎库 6 个历史失败会话全部停在 `first_input` 实锤），故修复只对新建会话生效。

## 方案

`resolveOrCreateSession` 新建（含替代重建）会话时，解析与发送路径一致的模型参数（`resolveSendModelParams`），随 `session/create` 下发：

- `modelSelection` 作为 `model` 字段（第一轮已实现）；
- `modelSelection.options.reasoningLevel` 同时作为独立的 `thoughtLevel` 字段下发（本轮）——档位由此进入会话级选择，turn 0 的标题调用通过引擎的档位校验。

- 解析失败（无法得到完整选择）降级为不带 `model`/`thoughtLevel` 字段，与现状一致；解析异常只告警，不阻塞建会话（建会话此前不依赖模型解析，不能因它失败）。
- 引擎对 `thoughtLevel` 值自行校验（不在模型档位列表内则告警跳过），天然降级，不会拒绝会话。
- 不通过协议传 `titleGeneration.modelSelection`：app-server `session/create` 的 schema 只暴露 `titleGenerationEnabled` 布尔，不暴露选择。
- resume 路径的 `repairSessionModelSelection` 保持不变（setModel 保留 options），两者收敛到同一会话级选择。

## 验证

先写失败回归：新建会话的 `session/create` 请求携带解析出的 `model` 选择（与 resume 修复同形状）与 `thoughtLevel` 档位；解析不出时省略两者且建会话不失败。运行 zcode runtime 相关测试、typecheck、lint、构建；真机验证下一条新会话的标题在引擎库变为 `generated`。

引擎侧行为已用 stdio 探针 A/B 实测（隔离 storage、零额度消耗）：带 `thoughtLevel` 的 create 落出带 `options.reasoningLevel` 的会话级选择，对照组复刻缺档位病灶。

## 风险

- 引擎对 create 时 `setModel` 校验失败会拒会话：选择来自发送路径已验证的解析逻辑，与 resume 修复同形状（已实测可用），风险低；仍保留降级路径。
- `thoughtLevel` 为引擎 create schema 原生字段（已探针实测接受），档位值非法时引擎静默跳过，无拒绝风险。
- 会话级选择被显式设置后，引擎默认选择不再兜底：与发送时模型一致性更强，属预期行为。
- 历史已卡在 `first_input` 的旧会话不回填：引擎 turn 0 只尝试一次，不追改存量数据。
