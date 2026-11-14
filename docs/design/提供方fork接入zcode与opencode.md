# 提供方 fork 接入：zcode 与 opencode

状态：实现中（2026-11-15）

## 目标

WebUI 的"从这条消息 fork 会话"能力目前只有 claude 与 codex 可用（`IProviderFork` 面推导能力，前端按 `supportsSessionForking` 显隐）。本任务把 zcode 与 opencode 两家接上，前端零改动。antigravity 经实测被引擎挡死（`/fork` 在 print 与 stream-json 模式均硬拒、`-i` 需 TTY），本轮不做，等引擎出无头出口。

## 引擎事实（2026-11-15 实测）

- zcode 引擎 0.17.1（ZCode.app 内置 zcode.cjs）：
  - RPC `session/fork`，参数 `{sessionId, target, expectedRevision?}`；target 判别联合 `turn/turnIndex`、`message/messageId`、`checkpoint/checkpointId`、`latestCheckpoint`（默认）；返回 `{forkedSessionId, parentSessionId?, targetMessageId?, targetCheckpointId?, response, snapshot}`。
  - 会话必须先 active：非活跃会话直接 fork 报 "Session is not active"，需先 `session/resume {sessionId}`。运行中的 prompt 拒绝 fork。
  - **fork 不复制消息行**：fork 会话在 `session` 表带 `parent_id` 指回父会话，父链上的历史按 `targetMessageId` 截断；引擎自己的 `session/messages` RPC 对 fork 也只返回 fork 本地的几行注入（timeline 分隔、fork 通知等，均 hidden/timeline 语义）。读 fork 的完整正文必须由读取方走 `parent_id` 链解析。
- opencode 2.2.7（v2 HTTP API）：
  - `POST /api/session/:id/fork`，body `{before?: messageId}`；`before` 为**排除语义**（boundary `{type:"before"}`，子会话止于该消息之前），省略则整份复制（boundary `{type:"through", messageID: 最后一条}`）。空会话拒绝（`empty_session`）。响应 `data.id` + 自动标题 "(fork #1)"。
  - fork 是真实复制：子会话消息在自身名下，无父链。

## 方案

### 共享契约（sessions.service）

`forkSessionById` 的守卫从 `!provider_session_id || !jsonl_path` 放宽为只查 `provider_session_id`：zcode/opencode 的会话行本来就是空 `jsonl_path`（引擎 DB 存会话），文件型提供方（claude/codex）的路径校验由各自 facet 的事后 stat 覆盖。

### zcode

- 新增 `zcode-fork.provider.ts`：`session/resume`（激活）→ `session/fork`。锚点映射：`upToAnchorId` → `{kind:"message", messageId}`；无锚点 → `{kind:"latestCheckpoint"}`（引擎默认，即整段到最近检查点）。返回 `{forkedSessionId, jsonlPath: ''}`。
- `zcode-sessions.provider.ts` 两处：
  - **父链解析**：`fetchHistory`/token 聚合前，若会话行带 `parent_id`，递归拼接祖先链（每跳用本层 fork 行里 `forkContext.targetMessageId` / `forkOrigin.messageId` 元数据截断父侧，含边界消息），带深度上限与环防护。fork 本地注入行按既有 uiVisibility 语义过滤，时间线呈现正常正文。
  - **锚点发射**：user 行（`semantics.origin === 'real_user'`）补 `transcriptAnchorId` = 该回合最后一条消息的引擎 id（回合 = 真实 user 提示到下一条真实 user 提示之间）。两个 fork 入口（user 行、"回合末 assistant 行"）由此共用同一锚点，语义对齐 codex（保提示+回答）。

### opencode

- `opencode-api.client.ts` 增 `forkSession(id, {before?})` 与 `listSessionMessages(id)`（按 `time.created` 升序排序）。
- 新增 `opencode-fork.provider.ts`：有锚点时把锚点换算成 `before` = 锚点后一条消息的 id（对冲 `before` 的排除语义；锚点是末条时省略 `before` = 整份复制）；锚点不在消息列表中报 `FORK_FAILED`。客户端获取走 runtime 暴露的 `ensureOpenCodeClient()`（复用既有 supervisor，绝不另起 serve）。
- `opencode-runtime.provider.ts` 暴露 `ensureOpenCodeClient()`：返回现役 client，否则 `ensureEndpoint` + `createClient`。
- `opencode-sessions.provider.ts`（仅 v2 `session_message` 布局）：user 行补 `transcriptAnchorId` = 该回合最后一条 assistant 消息 id；v1 旧布局不发射（按钮自动不显，属可接受边界）。

### 能力矩阵

`provider-capabilities.test.ts` 的期望矩阵把 zcode/opencode 的 `supportsSessionForking` 翻 true（由 facet 注册自动推导）；`docs/core/providers.md` 能力表同步。

## 验证

- 单测（TDD）：zcode facet 映射与错误面、opencode facet 锚点换算与错误面、共享守卫放宽、两 provider 锚点发射、zcode 父链解析。
- 真机探针已先行完成：resume→fork 链路、before 排除语义、fork 行不复制均实测（探针残留已清理）。
- 定向套件：`npm run test -- zcode-fork opencode-fork session-fork provider-capabilities zcode-sessions opencode-sessions` 相关文件 + build + typecheck + lint。

## 风险与边界

- zcode fork 的模型侧上下文截断以引擎为准；cloudcli 只负责展示侧链解析（含边界消息渲染）。边界消息是否含其回答由引擎的 checkpoint 语义决定，展示侧统一按"含锚点行"呈现。
- zcode fork 会话的 token 用量统计只数 fork 之后的行（祖先链不计入），显示偏小；与 codex fork 的整份复制不同，属已知取舍。
- opencode fork 的自动标题 "(fork #1)" 与 cloudcli 行名并存，侧栏以 cloudcli 行名为准（与 codex 同策略，引擎侧标题不回写）。
- 运行中 prompt 的 fork 被引擎拒绝，错误原样上浮为 `FORK_FAILED`。
