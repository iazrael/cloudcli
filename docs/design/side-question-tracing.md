# 追问（side questions，上游 #1673+#1767）

状态：方案就绪，阶段 A 进行中

基准：2.19.0 / 2026-11-12，上游 `dcc0bfbc`（#1673）+ `fe5b2e71`（#1767），共 76 文件 +1.14 万行（含 i18n 与测试）

分支：`feat/side-questions`（工作树 `.worktrees/side-questions`）

## 目标

把上游"追问"功能完整移植进 fork：会话回合运行中，用户可就当前上下文提一个旁路问题，由 provider 自己会话的只读 fork 回答，不与主回合争抢、不写主时间线。

## 上游机制（实测源码结论）

- **服务端**：`side-questions.store.ts`（进程内存 store，重启即清）+ `side-questions.service.ts`（ask/dismiss/makeRoom，按 sideQuestionId 持 AbortController，广播 `side_question` 事件：started/delta/done/error/dismissed）。会话上限 50 条、并发上限 3 条/会话、问题长度上限 10 万字符。
- **运行时契约**：`SideQuestionRuntime.askSideQuestion(provider, request, sink)`（`server/shared/types.ts`），永不 reject，失败走 error outcome。
- **claude**：`claude-side-question.provider.ts` 直接用 `@anthropic-ai/claude-agent-sdk` 的 `query()`：`resume`+`forkSession:true` 只读 fork，工具限 `Read/Grep/Glob`，系统提示追加旁路说明，prompt 前置活任务说明（防 fork 回显假停事件、防任务清单丢失两个实测坑）；`#1767` 把 reasoning 挡在答案外、消息间加分隔。
- **codex**：经 `codex-app-server.client.ts` fork 自己的会话；**opencode**：经 `opencode-side-question-forks.ts` fork serve 会话。
- **网关**：`chat.side_question` 帧处理（并发上限在帧层拒、只拒提问者；session/provider/providerSessionId 取自服务端会话行，不信任客户端）；`websocket-state`/`session-upsert-broadcast` 参与广播。
- **REST**：`provider.routes.ts` 侧问列表/删除端点。
- **客户端**：`useSideQuestions.ts`（发起/乐观 pending 对）+ `useSessionStore` 存储 + realtime 事件归账 + `MessageComponent` 渲染旁路问题卡 + composer 发送菜单"追问"入口 + `chatExport` 导出 + 编辑模式/导出/清除的边界测试。
- **能力位**：`provider-capabilities.service` 推导 `supportsSideQuestions`。

## fork 差异与适配决策

| 上游 | fork 现状 | 决策 |
| --- | --- | --- |
| claude runtime（SDK 直用） | fork claude TS runtime 同样基于 SDK | 回植 `claude-side-question.provider.ts` 基本原样，接进 `SideQuestionRuntime` |
| codex app-server client | fork 有同名 client（SDK 0.166.0） | 阶段 C 对账移植 |
| opencode side-question-forks | fork opencode 是 v2 client-mode 重写（裁决 Q1） | 阶段 D 评估 fork serve 会话是否可 fork；不可行则本批不接 opencode 追问（能力位关闭），文档记录 |
| composer 发送菜单入口 | fork 无发送菜单（steer 已用原生按钮先例） | 客户端入口改在 fork composer 加"追问"按钮（isReplyInFlight 时可见），不走 ComposerSendMenu |
| BackgroundSendDialog 侧问分支 | fork 已屏蔽该弹窗 | 相关测试不回植，入口逻辑并进 fork composer |
| LazyMessageRow/MessageComponent | fork 时间线同名文件存在 | 回植侧问卡渲染块，按 fork 组件结构适配 |

## 实施阶段（每阶段绿了再进）

- **阶段 A 服务端地基**：`SideQuestion`/`SideQuestionEvent`/store/service 类型与实现回植 → `chat.side_question` 网关帧（fork 网关模式）→ REST 端点 → 能力位 → claude side-question provider 回植（含 #1767 reasoning 防渗）→ 服务端测试（service/routes/websocket/claude provider 四组）。
- **阶段 B 客户端**：类型与 api → `useSideQuestions` + store + realtime → composer 追问按钮（fork 式）→ `MessageComponent` 侧问卡 → 导出 → 编辑模式清除边界 → i18n en/zh-CN/zh-TW → 客户端测试。
- **阶段 C codex**：fork codex runtime 接 `askSideQuestion` + 测试。
- **阶段 D opencode**：评估 client-mode 可行性，接或不接写回本文档。
- 收尾：全量回归 + worktree:merge。

## 验证标准

- 阶段相关测试绿；收尾 vitest + server 全量 + 双 typecheck + 双 build 绿。
- 真机验证（部署后）：运行中回合发起追问、另一 tab 可见、dismiss 即停、导出含侧问。

## 风险

- claude SDK `resume+forkSession` 行为版本敏感（steer 已有同类依赖），真机需验证。
- fork 时间线/ composer 结构差异大，客户端块是重做不是拷贝——按 steer 客户端移植的配方走。
- opencode 不可行会留能力差异，按"还有什么"说明。
