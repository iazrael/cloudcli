# zcode 思考行身份对账

- 状态：已实施，真机探针未完成（凭据链阻塞），部署后以洪水消失为最终验证
- 基准：main @ 2.23.0 bump（46717b10）/ 2026-11-15

## 目标

消除 zcode thinking 行的行身份契约违规（PM2 错误日志 `zcode broke the row-identity contract` 每天刷 1~2 万条），并让直播与历史的思考块按 id 精确对账。

## 问题

- 引擎的 `reasoning_start/delta/end` 事件不带任何稳定 id（信封 `id`/`messageID`、payload `messageId` 全空，bundle 证据：发射点只带 `assistantMessageId`/`delta`/`done`/`kind`）。
- 信封层兜底铸造 `vol_zcode_<uuid>`（`generateMessageId`，`server/shared/utils.ts:951`），normalizer 拼成 thinking 行 id `${vol}_reasoning` 并按会话缓存（`zcode-live-event-normalizer.ts` `openReasoningBlock`）。
- 契约检查器（`server/shared/normalized-message-contract.ts`）放行消息但点名违规：落库行禁止 `vol_` 前缀。
- 真实缺陷：历史 thinking 行 id 是 `${message_id}_${part_id}`（`zcode-sessions.provider.ts` selectHistoryRows），两路对不上 → 直播/历史思考块无法按 id 合并（前端靠 `isThinkingRowEchoOnServer` 内容比对兜底）。

## 事实依据

- 引擎落库（`~/.zcode/cli/db/db.sqlite`）：part 行 `id` 为引擎铸造的 `part_<token>_<uuid>`，直播侧永远推不出来 → 两路不可能共享 part id。
- reasoning part 几乎恒为单块：39,820 消息单块，仅 25 条 2~5 块。
- 引擎 bundle：reasoning 事件与 text 事件同一发射点 `{assistantMessageId, delta, done, kind}`，`assistantMessageId` 即落库 `message.id`（`msg_<token>_<uuid>`，与 conformance 夹具同形）。
- 客户端对账主机制：**id 相同即同一行**（sessionTimelineStore `serverIds.has`）；`providerRowKey` 仅用于文本行两路粒度不一致的补救，且只认 `kind==='text'`。
- 先例：opencode 思考行 id = `${message}_reasoning_${index}`；zcode 文本行直播 id = `assistantMessageId`。

## 方案

两路都按消息折叠（一消息一思考行），id 直接相等：

- **直播**（`zcode-live-event-normalizer.ts`）：新增 `resolveReasoningRowId(stateKey, payload, baseId)`——优先 `payload.assistantMessageId` → id `${assistantMessageId}_reasoning`；缺失时缓存兜底沿用现状（volatile + `_reasoning`，契约继续点名，作为降级路径保留）。同一消息的多个 reasoning 块自然共享同 id（折叠），续块由 `reasoning_start` 发一帧内容为 `\n` 的 thinking 帧（同 id）保持块形。
- **历史**（`zcode-sessions.provider.ts`）：reasoning parts 按消息折叠为一行（首部件建行、后续部件以 `\n` 续接，与直播分隔帧一致），id = `${message_id}_reasoning`。
- **前端**：零改动。同 id 行由 `serverIds.has` 直接去重；thinking 合并（按 id upsert）对新 id 无感。
- **契约/conformance**：增加 zcode thinking 夹具钉住确定性、无违规、跨路径同 id。

## 验证

1. 先红后绿单测：直播 id 派生与确定性、多块折叠（含续块 `\n` 分隔帧）、无 `assistantMessageId` 兜底保持违规、历史折叠与跨路径同 id——63/63 绿。
2. providers 全套件 1566/1566 绿（含 row-identity-conformance 新增 zcode reasoning 夹具）；前端 chat 时间线三套件 90/90 绿（前端零改动）。
3. 真机探针**未完成**：探针能起会话、能发 turn，但引擎打 bigmodel 端点 401——静态套餐 key 已作废（11-15 应验），linked OAuth 令牌按现行读取口取到的是 Z.AI OAuth 行、打 bigmodel 端点同样不认；`requestAuth`/凭据选择属另一子系统（见 zcode 凭据换代记忆），不为本任务深挖。假设由静态证据钉死：bundle 发射点 reasoning 与 text 同帧带 `assistantMessageId`（`De({assistantMessageId:e.assistantMessageId,…})`）、text 行的该字段在生产已实证可用、旧代码从不读该字段（只读信封）故洪水与字段有无无关。兜底路径保证：即使个别事件缺字段，行为退回现状（违规继续被点名），无回归。**部署后验证：pm2 错误日志的 `row-identity contract` 洪水是否停止。**

## 探针残留清理

探针在真实引擎库留下 2 个带 prompt 的会话（workspace `/tmp/zcode-reasoning-probe/ws`），已按 workspace 定向删除 session/message/part 行；探针脚本与事件样本在 `/tmp/zcode-reasoning-probe/`。

## 风险

- 多块消息折叠为单块（25/39845，≈0.06%）：粒度从"每块一行"变"每消息一行"，与文本行架构一致，接受。
- 引擎极早期事件缺 `assistantMessageId`：维持旧行为（volatile + 违规点名），探针验证主路径字段覆盖。
- 多块消息两路都以 `\n` 续接（直播续块分隔帧 / 历史部件续接），块形保留且两路内容一致；部件文本经 `extractText` 去首尾空白，与直播原始 delta 可有空白级差异。
