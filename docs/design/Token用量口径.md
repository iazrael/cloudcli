# Token 用量口径统一

状态：已实施
基准：2.24.0 / 2026-11-19

## 目标

1. `/cost` 详情里的「总 token」是会话累计消耗，且对每家用同一种口径统计。
2. 详情里显示上下文窗口大小。
3. 输入框的 token 按钮只表示「当前上下文占用了多少」，并与详情里的累计量分开。
4. 各引擎的详情字段一致：同一组行，缺数据时显示占位而不是少一行。

## 现状问题

- `ProviderTokenUsageResult.used` 一字段两义：Claude / Codex 实时事件是「最近一次请求的上下文占用」，OpenCode / ZCode 的会话总量是「累计消耗」，Antigravity 看事件类型又是另一种。给用户的感觉就是"不同 agent 显示的字段不一样"。
- Codex 实时事件用 `last_token_usage`（上下文），历史与 `/token-usage` 用 `total_token_usage`（累计），同一会话刷新前后差 100 倍。
- `/cost` 路由只回传 `used` 与 `total`，累计量根本没进详情；`tokenBreakdown` 有数据才出现，导致不同引擎看到的行不一样。
- 手机端页面挂起后 token 用量只在「切会话」或「一轮结束」时刷新，WebSocket 重连只同步消息；因此按钮会长时间停在旧值（实测停在会话开始后 44 秒的 46,196）。

## 方案

### 契约（`server/shared/types.ts`）

```ts
type ProviderTokenUsageResult = {
  used: number;            // 当前上下文占用：最近一次请求的 prompt + 输出
  total?: number;          // 上下文窗口
  inputTokens, outputTokens, breakdown;   // 与 used 同口径
  cumulative?: { used, inputTokens, outputTokens };  // 会话累计消耗
  unsupported?, message?
}
```

- 全部字段由各 provider 的 sessions 切面填，来源都是原生记录，不做估算。
- `cumulative.used = inputTokens + outputTokens`，输入含缓存命中；缓存明细仍放在 `cache*Tokens`。

### 各引擎的来源

| 引擎 | `used`（上下文） | `cumulative`（累计） | `total`（窗口） |
| --- | --- | --- | --- |
| claude | 最后一条主线程 assistant 的 input+cache+output（不变） | 全部 assistant 行求和（含子代理） | SDK 报告值，回落到 `CONTEXT_WINDOW` |
| codex | `last_token_usage` | `total_token_usage` | `model_context_window` |
| opencode | 最后一条 assistant 消息的 `tokens` | `session_v2` 的 token 列，或逐条求和 | 引擎不提供 |
| zcode | 最后一条带 `tokens` 的消息 | 全部消息求和 | 引擎不提供 |
| antigravity | 最后一个 step 的 usage | `result.usage`（本身是本次运行累计），没有 result 时累加 step | 运行时已知的窗口常量 |
| cursor | 不支持 | — | — |

Codex 的实时事件与 roll-out 读取共用 `services/codex-usage.ts` 的一个解析函数，保证两条路径永远同值。

### 接口

`/cost` 回传：

```ts
{
  tokenUsage: { used, total },              // 上下文，供输入框按钮
  tokenBreakdown: { input, output },        // 上下文分解
  cumulativeUsage: { used, inputTokens, outputTokens }
}
```

路由在实时载荷缺 `cumulative` 时读一次 provider 的持久化快照补齐；已有累计量就不再读。

### 前端

- 输入框按钮：仍显示 `used`；标题改成「当前上下文 X / Y tokens」。`/cost` 回来的 `tokenUsage` 只覆盖上下文，不会再把累计量写进按钮。
- `/cost` 详情固定四行：累计总用量、累计输入、累计输出、上下文窗口；缺值显示 `—`。
- 页面回到前台（`visibilitychange`）时补拉一次 token 用量；WebSocket 重连已有的历史刷新也会带上上下文快照。

## 验证

- providers 各引擎的 `getTokenUsage` 单测：上下文与累计同时断言。
- codex runtime 的 `token_budget` 事件断言累计块。
- `/cost` 路由单测：有实时累计时不读持久化；缺累计时补齐。
- 前端 command modal 单测：四行固定、累计值正确、`used` 不再当总量。
- 手动：对一个 Codex 长会话执行 `/cost`，与 roll-out 里最后一组 `token_count` 对齐。

## 风险

- 历史统计依赖原生记录里的逐条 usage；引擎若某天不再写逐条 usage，`used` 会回落到累计量（不会变成 0）。
- 老版本服务端 + 新前端：没有 `cumulativeUsage` 时四行显示 `—`，不回退成用上下文冒充总量。
- 累计值含缓存命中，数值会明显大于直觉的「新生成 token」，这是引擎账单口径，详情里的输入/输出行与之同源。
