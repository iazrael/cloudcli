# opencode 旁问（side questions）接入

状态：实现中（2026-11-15）

## 目标

旁问目前有 claude（SDK 只读 fork 流）与 codex（一次性 off-disk fork）两家。opencode 此前缺 fork 能力没有接入；上一任务把 `POST /api/session/:id/fork` 接上后，旁问的接入前提已齐。本任务给 opencode 的 runtime 加 `askSideQuestion`，前端零改动（`supportsSideQuestions` 由 `runtime.askSideQuestion` 推导）。

## 引擎事实（2026-11-15 真机探针，opencode 2.2.7）

全链路一次通：fork 整份复制 → `PATCH /api/session/:id` 写 deny 规则（shell/edit/write/patch）→ `POST /prompt` → `GET /api/event` SSE 收帧 → `session.execution.succeeded` 终态 → `DELETE /api/session/:id` 清场。

- **deny 规则即只读**：deny 之后的 fork 副本里 shell 工具直接从工具集消失（模型自述"不是被拦，是工具不在环境里"），只读工具（glob 等）照常可用——与 claude 只读工具集、codex read-only 沙箱同效。
- **SSE 词汇**（`GET /api/event`，全局流按 `data.sessionID` 过滤）：`session.text.delta`（`data.delta` 增量）、`session.text.ended`（`data.text` 该段全文，权威）、`session.reasoning.*`（忽略）、工具事件（忽略）、`session.execution.{started,succeeded,failed,interrupted}`——terminal 只认后三个。
- fork 是真复制，子会话在 `opencode.db` 落盘：旁问期间同步器可能把临时会话扫进侧栏（标题 "(fork #1)"），答完即删、下轮同步自动回收，属已知取舍（codex 用 `ephemeral: true` 落不了盘，opencode 无此开关）。

## 方案

- 新增 `opencode-side-question.ts`：`askOpenCodeSideQuestion(request, sink, deps)`。
  1. 无 `providerSessionId` → error outcome（旁问契约要求永不 reject）。
  2. `ensureOpenCodeClient()`（复用在跑 serve，绝不另起）。
  3. fork 整份复制 → 子会话 id；PATCH deny 四个变更动作——PATCH 失败按失败处理（继承父规则可能可写，不可放行），删子会话回 error。
  4. **先开私有 SSE 连接再 prompt**（防丢首帧），按 `data.sessionID === 子会话` 过滤；text.delta 进增量缓冲并推 `sink.delta`，text.ended 记权威段，多段之间用既有 `SIDE_QUESTION_ANSWER_SEPARATOR` 分隔；`session.execution.succeeded` 收尾，`failed`/`interrupted` 带已收文本按 error/部分文本结算。
  5. 结算后关 SSE，尽力 `interrupt` + `DELETE` 子会话（清场失败不影响 outcome）。
  6. `request.signal` 中止：断 SSE、尽力 interrupt + 删子会话，回 error outcome（部分文本随行）。
- 接线：`opencode-runtime.provider.ts` 的 runtime 对象挂 `askSideQuestion`（对齐 codex 的接法）；client 补 `deleteSession`。
- 模型不转发：fork 整份复制天然继承会话自身模型，对"问这个会话"比客户端传的模型更正确（claude 传 model 是为了命中 prompt cache，opencode 无此诉求）。
- 不带 claude 式 live tasks 注记：opencode fork 不复活进程，无"任务被报停"的伪事件。

## 验证

- 单测（TDD）：stub client + 假 SSE 流（手搓 ReadableStream 帧）覆盖：无会话拒绝、deny PATCH 失败即失败并清场、delta 流式聚合、text.ended 权威段优先、多段分隔、execution.failed/interrupted 结算、abort 清场、删除失败不影响 outcome。
- 真机探针已先行跑通全链（见上），实现后侧栏/旁问 UI 由既有能力推导自动出现。
- 定向套件 + build + typecheck + lint；`docs/core/providers.md` 的 fork 段落补一句旁问。

## 风险

- 旁问期间临时子会话可能闪现在侧栏（同步器扫到），删除后自愈；不改同步器（加白名单的复杂度不值一次闪现）。
- 模型长跑（读很多文件）没有显式回合上限，靠用户中止兜底（与 codex 同策略）。
