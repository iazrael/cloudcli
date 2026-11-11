# Claude 重置卡显示与使用

状态：已实现

## 目标

在账号配额面板里显示 Claude 账号当前持有的 limit reset（如“完整重置”“Fable 重置”）、剩余次数和到期时间，并允许用户在确认后从面板里使用。使用是一次不可撤销的显式操作：读取配额、渲染卡片、测试都不会花卡。

## 背景

Codex / ZCode 的重置卡已经随配额载荷返回并显示。Claude 的卡来自只读端点：

`GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1`

其 `cedar_ember.grants[]` 给出 grant id、名称、`resets_left`、`ends_at`、`clears`、`usable_now` 等字段。同一个载荷也带齐 5 小时 / 周窗口，且端点对同一 token 的连续读取会限流（SDK 读完后立即再读会 429）。因此直连读作为主路径，一次拿窗口 + 卡；Agent SDK 的 `get_usage` 只在直连失败时兜底，并顺带刷新 OAuth token。直连的 `model_scoped` 有时为 null，但同一窗口出现在 `limits[]` 的 `weekly_scoped` 行里，归一化时两处都要认。

花卡接口从 Claude Code 的客户端实现中确认：

`POST https://api.anthropic.com/api/organizations/{organizationUuid}/reset_rate_limits`

body 为 `{ program: 'cedar_ember', grant_id, request_id }`，`request_id` 是每次请求新生成的 UUID；响应形如
`{ result: 'reset' | 'already_used' | 'not_limited' | 'cooldown' | 'ineligible' | 'unavailable', reason?, resets_left?, ... }`。
organizationUuid 取 `~/.claude.json` 的 `oauthAccount.organizationUuid`。

## 范围

- `server/modules/providers/list/claude/claude-quota.provider.ts`：新增 `consumeClaudeQuotaReset`，重新读取新鲜 grant 列表后按 `resetType` 选卡并 POST；成功作废配额缓存。
- `server/modules/providers/list/claude/claude-auth.provider.ts`：接上 `consumeQuotaReset` 切面，能力矩阵据此把 `supportsQuotaReset` 翻为 true。
- `server/modules/providers/provider.routes.ts`：`QUOTA_RESET_TYPES` 增加 `fable`。
- `src/modules/chat/modals/CommandResultModal.tsx`：能力为真时保留现有“使用”按钮与二次确认；Claude 不再走只读提示。
- `docs/core/providers.md`：重置卡段改为“可读可花，但只在用户确认后调用”。

## 方案

1. **选卡**：花卡前重新 GET 一次最新的 `cedar_ember`，不信任缓存。过滤 `available && remaining > 0 && resetType` 精确匹配用户点击的分组，多个同类型 grant 取最早 `expireTime`；没有匹配返回 `noCard`。不跨类型借用（点 Fable 不会花掉完整重置）。
2. **组织与请求**：从 `~/.claude.json` 读 organizationUuid；缺失返回 `notAuthenticated`。POST body 固定 `{ program: 'cedar_ember', grant_id, request_id }`，`request_id` 用 `randomUUID()`；沿用直连的 token、CLI User-Agent 和 `HTTPS_PROXY`。
3. **结果映射**：`result === 'reset'` 成功并作废配额缓存；`already_used` / `not_limited` / `cooldown` / `ineligible` / `unavailable` 返回带原因的失败；HTTP 401/403 → `notAuthenticated`；HTTP 429 / 5xx → 可重试失败；请求已发出但网络中断或响应不可读 → `unknown`，前端提示先刷新确认、不要直接重试。
4. **安全边界**：只有用户在现有确认对话框点“确认使用”后才发 POST；读取配额、刷新面板、单测和渲染都不会发 POST。测试注入假的 `claimReset`，绝不使用默认 HTTP 实现。
5. **展示**：重置卡按 `all → fable → 5h → weekly` 排序；“完整重置”沿用现有的 `all` 文案，“Fable 重置”沿用已有文案；确认框说明操作不可撤销。

## 验证

- 后端单测：按 `fable` / `all` 选中对应 grant；同类型多张取最早到期；无匹配返回 `noCard`；新鲜读取失败返回 `readFailed`；claim 的 `grant_id` / `request_id` 形状正确；`not_limited` 等结果映射为失败；全部使用注入的 fake claim，不发起真实 POST。
- 前端组件测试：能力为 true 时点击“使用”只打开本地确认框，`authenticatedFetch` 未被调用；不点击最终“确认使用”。
- 能力矩阵基线把 Claude 的 `supportsQuotaReset` 改为 true。
- `npm run typecheck`、`npm run lint`、全量 client / provider 测试与构建均通过。
- 真实花卡接口**未调用**：验证只覆盖到本地确认框和 fake claim，没有向 `/reset_rate_limits` 发过 POST。

## 风险

- 花卡不可撤销；实现只在显式确认后调用，且没有自动重试。
- `cedar_ember` / `reset_rate_limits` 是内部接口，字段或路径可能变化；失败时回退为可读错误，不影响配额窗口。
- macOS 上 Claude Code 可能只把 OAuth token 放在钥匙串；此时直连读取和花卡都不可用，配额窗口仍可由 SDK 返回。
- 网络中断后的真实结果无法判定，按 `unknown` 处理，要求用户先刷新确认，避免重复花卡。
