# Claude 压缩后的上下文占用读数

## 状态

已实施，待验证。

## 目标

`/compact` 完成后，composer 的上下文占用百分比必须立刻按压缩后的真实占用下降，而不是继续挂着压缩前的数字。

## 现象与根因

会话 `47736aa8-211d-4efc-aa22-dec124c5f10f`（Claude，1M 窗口）在 2026-11-11 16:21 手动压缩：

- 转录最后一条 assistant 的读数是 `388065`，压缩边界 `compactMetadata.preTokens` 也正好是 `388065`；
- 边界同时记录了 `postTokens: 14247`，即压缩后下一次请求真正携带的上下文；
- 前端仍显示约 39%，而不是约 1.4%。

原因有三处，都属于 Claude 读取路径没有消费压缩边界：

1. `summarizeClaudeTokenUsage` 只倒序找最新一条有 usage 的 assistant 行。压缩摘要行是 `user` 行、没有 usage，边界是 `system` 行，于是最新读数仍来自压缩前的 assistant。
2. 实时路径 `extractTokenBudget` 只处理 `assistant`，`system/compact_boundary` 不产生 `token_budget` 帧。
3. 压缩回合通常没有 assistant usage（转录里只有边界和摘要行），实时回退 `extractCumulativeTokenBudget` 会把 `result.usage`（摘要请求的账单，仍是压缩前上下文）当成占用发出去，进一步固定旧数字。

## 方案

Claude 的 `compact_boundary` 自带权威读数，直接使用，不需要像 ZCode/OpenCode 那样退化成"未知"：

- 历史路径（`services/claude-usage.ts`）：倒序扫描时先遇到压缩边界（且其后没有 assistant 回合），就读 `compactMetadata.postTokens`（兼容实时字段 `compact_metadata.post_tokens`），返回 `used = postTokens`、`inputTokens = postTokens`、`outputTokens = 0`；同时继续向更早的行取模型名，用于解析窗口。边界之后出现新的 assistant 回合时仍以该回合为准。边界没有 `postTokens` 时返回 `compacted: true`，由前端隐藏占用条。
- 实时路径（`list/claude/claude-runtime.provider.ts`）：新增 `extractCompactionTokenBudget`，在流里看到 `system/compact_boundary` 即以同样的数字发一帧 `token_budget`；并把该帧视为本回合的有效读数，阻止 `result` 账单回退覆盖它。
- 前端不改：`toTokenBudget` / `readContextUsage` 已按 `used/total` 计算，历史页和实时帧走同一份读数。

## 验证

- 单元测试：边界在末尾时取 `postTokens`；`camelCase` 与 `snake_case` 两种字段；边界后已有新 assistant 回合时取新回合；边界没有 post 数字时返回 `compacted`。
- 实时集成测试：无 assistant 的压缩回合（init → boundary → result）最后一帧 `token_budget` 是 `postTokens`，不是 `result.usage`。
- 用真实转录复核：`postTokens 14247 / 1000000` 应为 1.4%，而不是 `388065 / 1000000` 的 39%。
- `npm run typecheck`、相关测试与 `npm run build`。

## 风险

- `postTokens` 是引擎自报的压缩后占用；若旧 SDK 只写 `preTokens`，行为退化为"刚压缩、占用未知"，与其它引擎一致，不会显示旧数字。
- 实时帧与历史页共用 `resolveClaudeContextWindow`，窗口不会因压缩而改变。
