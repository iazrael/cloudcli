# ZCode 会话标题

状态：已实现
基准：ZCode 3.18.2 / 2026-11-22

## 目标与范围

修复 cloudcli 发起的 ZCode 会话侧栏标题一直是原始提问、不变成引擎 AI 标题的问题。仅修改 zcode runtime 新建会话时下发给引擎的参数（`session/create` 携带本次解析的模型选择）；不改引擎、不改同步器、不改用户 `~/.zcode/cli/config.json`。

## 根因

cloudcli 的 zcode 标题来自引擎 SQLite（`title_source='generated'` 时同步器才采信）。引擎在 turn 0 发起一次独立的标题生成模型调用，模型取 `titleGeneration.modelSelection ?? 会话级模型选择`。

- cloudcli `session/create` 只传 workspace，新会话的会话级模型落到引擎默认值，即 cloudcli 物化进 `cloudcli-provider-config.json` 的 `defaultModelSelection` —— 来自用户 config.json 旧配置的 `bigmodel-coding-plan/GLM-5.3-Flash`（静态 API Key）。
- 套餐升级后（11-15 认证改造），该静态 Key 引擎侧认证失败：日志 `model.client_signing.handshake_failed` → `unsigned_sent` → `session_title_generation.failed`（"Provider authentication failed."），11-16 起每日多次。
- 对话主回合不受影响，因为每回合带 per-turn 选择 `account:bigmodel-individual-coding-plan`（OAuth/项目令牌，走 runtime headers 桥接）。
- 最近的会话连失败日志都没有：标题调用对坏 provider 触发 runtime headers 延迟门，被无限推迟。
- 反证：11-21 唯一成功生成标题的 cloudcli 会话（sess_17e1fde6），恰好在创建后被 resume 修复路径 `session/setModel` 切到 account provider，随后标题落地。App 内创建的会话（会话级模型本就是 account provider）标题全部正常。

## 方案

`resolveOrCreateSession` 新建（含替代重建）会话时，解析与发送路径一致的模型参数（`resolveSendModelParams`），把 `modelSelection` 作为 `model` 字段随 `session/create` 下发；引擎建会话时即 `setModel`，会话级选择从创建起就是可用的账号 provider，turn 0 的标题调用用对 provider。

- 解析失败（无法得到完整选择）降级为不带 `model` 字段，与现状一致；解析异常只告警，不阻塞建会话（建会话此前不依赖模型解析，不能因它失败）。
- 不通过协议传 `titleGeneration.modelSelection`：app-server `session/create` 的 schema 只暴露 `titleGenerationEnabled` 布尔，不暴露选择。
- resume 路径的 `repairSessionModelSelection` 保持不变，两者收敛到同一会话级选择。

## 验证

先写失败回归：新建会话的 `session/create` 请求携带解析出的 `model` 选择（与 resume 修复同形状），解析不出时省略该字段且建会话不失败。运行 zcode runtime 相关测试、typecheck、lint、构建；真机验证下一条新会话的标题在引擎库变为 `generated`。

## 风险

- 引擎对 create 时 `setModel` 校验失败会拒会话：选择来自发送路径已验证的解析逻辑，与 resume 修复同形状（已实测可用），风险低；仍保留降级路径。
- 会话级选择被显式设置后，引擎默认选择不再兜底：与发送时模型一致性更强，属预期行为。
- 历史已卡在 `first_input` 的旧会话不回填：引擎 turn 0 只尝试一次，不追改存量数据。
