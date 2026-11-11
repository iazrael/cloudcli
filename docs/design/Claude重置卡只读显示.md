# Claude 重置卡只读显示

状态：已实现

## 目标

在账号配额面板里显示 Claude 账号当前持有的 limit reset（如“完整重置”“Fable 重置”）、剩余次数和到期时间，与 Codex / ZCode 的重置卡一样可见；但**不提供在这里花卡的能力**，也不调用任何重置接口。

## 背景

Codex / ZCode 的重置卡已经随配额载荷返回并显示。Claude 的重置卡不在 Agent SDK 的 `get_usage` 响应里：该响应只带 5 小时 / 周窗口，`cedar_ember` 恒为 null。官方网页的“免费重置”来自只读载荷：

`GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1`

其 `cedar_ember.grants[]` 给出 grant id、名称、`resets_left`、`ends_at`、`clears`、`usable_now` 等字段。2026-11-11 本机 Pro 账号实测返回两条：Fable 重置（11-17 到期）和完整重置（12-11 到期）。官方明确“Reset for free”按钮不在 Claude Code 终端/IDE 里，因此 cloudcli 只做展示。

同一个载荷也带齐 5 小时 / 周窗口，且端点对同一 token 的连续读取会限流（SDK 读完后立即再读会 429）。因此直连读作为主路径，一次拿窗口 + 卡；Agent SDK 的 `get_usage` 只在直连失败时兜底，并顺带刷新 OAuth token。直连的 `model_scoped` 有时为 null，但同一窗口出现在 `limits[]` 的 `weekly_scoped` 行里，归一化时两处都要认。

## 范围

- `server/modules/providers/list/claude/claude-quota.provider.ts`：直连读取 `/api/oauth/usage?cedar_ember=1`（本地 OAuth token + CLI User-Agent + 代理），一次归一化窗口和 `resetCredits`；SDK 作为回退。
- `shared/protocol/quota.ts`：`ProviderQuotaResetCredit` 增加可选 `remaining`（一个 grant 可能含多次重置）；`resetType` 增加 `fable` 语义说明。
- `src/modules/chat/modals/CommandResultModal.tsx`：有 `resetCredits` 就渲染重置卡；只有 `supportsQuotaReset` 为真时才显示“使用”按钮。Claude 没有 `consumeQuotaReset` 切面，因此天然只读。
- 11 个已有 `cost` 段的语言文件补 `resetCardTypeFable` / `resetCardHintReadOnly`。
- 同步 `docs/core/providers.md` 的重置卡段。

## 方案

1. **读取**：从 `~/.claude/.credentials.json` 读 `claudeAiOauth.accessToken` 和 `subscriptionType`，用安装的 `claude --version` 拼出 CLI User-Agent（端点用它在 `surface` / `cli_version` 上做门槛），经 `HTTPS_PROXY` 走 `https-proxy-agent` GET 上述端点。令牌只在请求头里使用，不写日志、不进错误信息。
2. **归一化**：直连载荷整体当作 `rate_limits` 复用现有窗口归一化；`cedar_ember.grants[]` → `ProviderQuotaResetCredit[]`。`label` 含 Fable 的归为 `fable`；同时清 `seven_day` + `five_hour` 的归为 `all`；其余按 `clears` 归为 `5h` / `weekly`。`available` 取 `resets_left > 0 && !paused && usable_now && 未过期`，`expireTime` 取 `ends_at`，`remaining` 取 `resets_left`。`model_scoped` 为空时从 `limits[]` 的 `weekly_scoped` 行补 Fable 窗口。
3. **回退**：直连失败（含 429 / 代理不可用 / token 过期）就退回 SDK `get_usage`，窗口照常返回，重置卡暂缺；SDK 刷新后的 token 供下一次直连使用。
4. **只读**：不新增 `consumeQuotaReset`，`supportsQuotaReset` 保持 false；前端只在能力为真时渲染“使用”按钮。绝不调用 `/api/organizations/*/reset_rate_limits`。
5. **展示**：重置卡按 `all → fable → 5h → weekly` 排序；“完整重置”沿用现有的 `all` 文案，“Fable 重置”新增文案；只读模式提示去官方网页端使用。

## 验证

- 后端单测：Fable + 完整重置两条 grant 的映射；已用/暂停/过期 grant 标记为不可用；直连失败时回退 SDK 且窗口仍返回；`model_scoped` 为空时从 `limits[]` 补窗口；不发起真实网络请求。
- 前端组件测试：`supportsQuotaReset` 为 false 时显示 Fable / 完整重置卡和只读提示，且没有“使用”按钮；能力为 true 时按钮仍在。
- `npm run typecheck`、`npm run lint`、全量 client / provider 测试与构建。
- 只读实测：本机直连返回两张卡（Fable + 完整重置）和 Fable 周窗口；SDK 回退路径不重复打端点，避免 429；不触发重置。

## 风险

- macOS 上 Claude Code 可能只把 OAuth token 放在钥匙串，`~/.claude/.credentials.json` 没有 `claudeAiOauth`；此时重置卡不显示，配额窗口不受影响。读钥匙串会弹授权框，故不自动尝试。
- `cedar_ember` 是内部字段，Anthropic 可能改名或改形状；读取失败时静默降级为无卡。
- 不提供花卡入口，用户仍需去官方网页或 App 使用；这是本次有意保留的边界。
