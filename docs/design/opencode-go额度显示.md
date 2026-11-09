# OpenCode Go 套餐额度显示

状态：实施中

## 目标

在 cloudcli 的账号配额面板（CommandResultModal）中显示 opencode 工作区的 Go 套餐额度：滚动 5 小时、每周、每月三个窗口的已用百分比与重置时间。能力矩阵自动识别（`getQuota` 在即 `supportsQuota` 真），前端展示层零改动。

## 范围

- 新增 `server/modules/providers/list/opencode/opencode-quota.provider.ts`（拉取 + 归一化 + 缓存）。
- `OpenCodeProviderAuth.getQuota()` 接线。
- i18n 补 `cost.emptyQuotaHint.opencode`（10 个语言文件，与 claude/codex 提示键对齐）。
- 同步 `docs/core/providers.md` 配额数据源段（三家 → 四家）。
- 前端组件不改。

## 方案

数据源为 opencode 未公开文档的内部接口，依据 opencode CLI 源码 `packages/core/src/usage-limits.ts`（仓库 anomalyco/opencode，2026-11 已本机实测可用）：

1. **凭证**：读 opencode 共享库 `~/.local/share/opencode/opencode.db` 的 `credential` 表，取 `integration_id='opencode'` 且 `active=1` 的最新行，`value` JSON 为 `{type, access?, key?, metadata:{orgID?, orgName?, server?}}`。只读连接；orgID 缺失视为不可查，返回 null。
2. **请求**：`GET {console origin}/zen/go/v1/usage`，头部 `Authorization: Bearer <token>` + `x-opencode-org-id: <orgID>`。console origin 默认 `https://opencode.ai`（server 字段默认 `https://opencode.ai/console`，取 origin）。
3. **归一化**：单组 "OpenCode Go"，三个桶 rolling→`5h`、weekly→`weekly`、monthly→`monthly`；`remainingFraction = (100 - percent)/100`，`status === 'rate-limited'` 时强制 0；`resetsAt` 转 ISO。`partitioning: 'bucket'`（单组，前端按唯一组处理）。
4. **降级**：403（工作区未订阅 Go）、401（OAuth token 过期）、超时（10s）、网络错误、载荷不可读 → 全部返回 null，前端显示"没有可显示的配额数据"并带提示文案。token 过期不自动续期（续期归 opencode CLI 管）；用户在 CLI 里用过一次后凭证刷新即自愈。
5. **缓存**：`createProviderQuotaCache`，TTL 120s 对齐 claude/codex/antigravity，`?refresh=true` 穿透。

fetch 与凭证读取都做成可注入依赖，供单测替换。

## 验证

- 定向单测 `server/modules/providers/tests/opencode-quota.test.ts`（node:test，红 → 绿）：凭证缺失/无 orgID、403、401、超时、正常载荷三桶归一化、rate-limited 置零、缓存与 refresh 穿透。
- 本机实跑：起 dev 服务后 `curl /api/providers/quota?provider=opencode` 返回真实额度。

## 风险

- 内部接口无稳定性承诺，路径或载荷变动时额度显示退化为空，不影响其他功能。
- budgets（按量付费预算）接口本工作区返回空数组，本次不接，留作后续扩展点。
