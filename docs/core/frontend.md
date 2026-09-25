# 前端架构（Frontend）

> 基准：2.5.10 / 2026-09-22
> **核心文档**：改动 `src/shared/**` 或聊天渲染/性能相关代码时**必须同步更新本文**。
> 普通 bug 修复不动架构的不需要更新（提交时走 `--no-verify`，见 `AGENTS.md`）。

模块规范（目录职责、命名、API 访问层）见 `.agents/skills/frontend-module-standards/SKILL.md`；聊天链路的服务端侧见 [chat.md](./chat.md)。

## 技术栈与入口

React 18 + TypeScript + Vite 7（`vite.config.js`，别名 `@` → `src/`，`@shared` → 仓库根 `shared/`），测试 vitest，i18n 用 react-i18next。入口 `src/main.tsx` → `src/App.tsx`：两个工作区路由 `/` 与 `/session/:sessionId`，Context 挂载顺序也在 `App.tsx`。

## 全局状态分层

| Context | 文件 | 管什么 |
| --- | --- | --- |
| `WebSocketContext` | `src/shared/context/WebSocketContext.tsx` | WS 单例；帧同步分发给订阅者，**帧不进 React state**；帧类型 `ServerEvent` 定义在 `src/shared/types.ts`，此处只 re-export |
| `AuthContext` | `src/modules/auth/context/AuthContext.tsx` | token、登录态 |
| `ThemeContext` / `UiPreferencesContext` | `src/shared/context/` | 主题与 UI 偏好（`userSettings.ts` 统一读写：服务端 `auth.db` 是 source of truth，localStorage 只做首屏镜像；主题、语言、六家引擎权限、代码编辑器设置、`uiPreferences` 开关包都归它） |
| `SessionProtectionContext` | `src/shared/context/SessionProtectionContext.tsx` | 会话保护 / PWA 冷启动恢复 |
| `ProjectsStateContext` | `src/modules/project-workspace/context/ProjectsStateContext.tsx` | 项目/会话列表（消费 `session_upserted` 等侧边栏 WS 帧） |
| `PermissionContext` | `src/modules/chat/context/PermissionContext.tsx` | 聊天权限批准 |
| `PluginsContext` | `src/modules/plugins/context/PluginsContext.tsx` | 插件 |

聊天消息**不走 Context**：走 `SessionTimelineStore`（框架无关）+ `useSessionStore` 适配器，见 [chat.md](./chat.md) 的四层结构。

composer 的定时卡片同样不走 Context，也不是实时状态：`useScheduledJobs` / `useScheduledMessages` 都是普通拉取，只在创建、删除、切换会话，以及**所在会话的 run 结束时**（`isProcessing` 落沿）重新拉取——仅一次任务跑完已自停用、定时消息已发出，都要靠这次刷新才会从输入框上方消失。

前后端共用的 `NormalizedMessage` 是聊天时间线的 wire contract；provider 给出的跨路行身份和历史正文完整度必须由 WebSocket 与历史接口原样传入 `SessionTimelineStore`，不能在视图模型层重新生成。身份的分段与对账规则见 [chat.md](./chat.md)。本地 Markdown 图片经授权端点转换为 Blob URL 后，组件换图或卸载必须中止请求并恰好释放一次 URL。

## Provider 相关前端（零分支原则）

- **能力/目录的唯一来源是后端**：`useProviderCapabilities`（`GET /api/providers/capabilities`，模块级缓存 + 失败按 2s/8s 退避重试后仍失败才回退，因为 `/compact` 这类能力项只靠这一次请求）+ `useChatProviderState`（`GET /api/providers/<p>/models` 拉统一模型目录，合成 `providerModelCatalog`）。
- **回退镜像**：`src/shared/providerCatalogFallback.ts` 只用于首屏与请求失败兜底，由 parity 测试钉住与后端一致；**其 key 顺序是全应用引擎规范顺序**（一处改动不要在别处另排顺序）。
- 本地选择持久化为 `<provider>-model` / `<provider>-effort`（`useChatProviderState` 直接读写 localStorage，设备本地，不经 preference store）。
- 引擎外观：`src/shared/providerDisplay.ts`（显示名）、`src/shared/ui/LLMProviderLogo.tsx`（Logo）。
- 新增引擎的前端步骤见 [providers.md](./providers.md) 第六步——composer 不写 provider 分支，一切按能力矩阵渲染（slash 菜单同理：`/compact` 仅在 `supportsCompaction` 为真时出现，能力为真时前端发 `chat.compact` 帧并**不**落乐观用户气泡；编辑横幅的「文件会不会一并还原」也按 `editRevertsFiles` 切换文案，见 [providers.md](./providers.md) 的编辑段）。
- **上下文占用展示**：`tokenBudget`（WS `token_budget` 指令 / 历史页 `tokenUsage`）喂 composer 的两个控件与 `/cost` 弹窗，二者读同一份 `readContextUsage`（`src/modules/chat/utils/contextUsage.ts`；引擎自报 `percentage` 优先，否则 `used/total`）：顶沿细进度条 `ContextUsageBar`（`<60%` 绿 / `60–84%` 黄 / `≥85%` 红）表示窗口占用，工具行里的 `TokenUsageSummary` 显示当前 K 数——手机上只留 K 数（隐藏图标与 `xx%`）以免工具行（附件/语音/命令 + 定时/模型/权限/发送）在 ~320px 溢出、和定时图标重叠，`sm` 以上再加图标和百分比。两者点击都开 `/cost`。没有窗口时细条不画；徽章在整份读数缺失时才不画（快照全 0，或刚压缩且没有摘要大小），因为只显示 K 数、百分比是 `sm` 以上的附加项。刚压缩时引擎还没有 token 数，徽章改用 `summaryBytes`（压缩摘要的 UTF-8 字节数）显示 "9.4KB"，占用条不画。字段语义与来源见 [providers.md](./providers.md)，前端不按引擎分支；`cumulative` 只在 `/cost` 里单列。

### 会话标签只有一个字段

会话的显示名一律取 `ProjectSession.summary`，`getSessionTitle()` 是唯一入口。
类型里**没有** `name` 备选字段：曾经有过，后端从未下发，而优先读它的代码因此显示占位名。
新增读取点不要再加 `|| session.name` 之类的兜底。

### 消息类型的归属

服务端↔客户端的消息形状**不在前端定义**，而在仓库根 `shared/protocol/chatEvents.ts`，`src/shared/types.ts` 从那里 re-export
（细节见 [providers.md](./providers.md) 的「线上契约」）。前端曾另有一份自己的副本，与服务端悄悄漂移了七个字段。

前端在协议之上的本地扩展写在 `src/shared/types.ts`，必须显式列出：

- `TimelineMessageKind` = 协议的 `MessageKind` + `interactive_prompt`。后者由 composer 本地合成，引擎永不产出；把它挡在 `MessageKind` 之外，就不会有人误以为某家引擎该发这个 kind。
- `NormalizedMessage` = 协议消息换上 `TimelineMessageKind`，再加乐观回显的簿记字段 `replacesAnchorId`。它从不上线，只活在「发出去」与「持久化回合顶替掉它」之间；发送时刻的转录位置记在 store slot 的 `pendingPrompts` 里，不挂在消息上。

新增一个跨端字段时改协议文件，**不要**在前端这边补声明——那正是漂移的来路。
账号配额的形状（`ProviderQuotaData` 等）同样出自协议（`shared/protocol/quota.ts`），
此前它在前后端共有三份、命名还不一致。

### 帧是联合类型，不是字典

WebSocket 进来的帧类型 `ServerEvent` 定义在 `shared/protocol/frames.ts`，是按 `kind` 判别的联合，
**没有索引签名**。读任何字段之前必须先确定是哪种帧，用 `shared/protocol/frameNarrowing.ts` 的谓词；
`sessionId` 与 `seq` 并非每种帧都有（重连通知、加载进度就没有），用 `readFrameSessionId()` /
`readFrameSeq()` 读。

此前它是 `{ kind?, type?, sessionId?, seq?, [key: string]: unknown }`，
时间线 store 从中读 22 个字段，全部未经检查。三种网关帧
（`chat_subscribed`、`protocol_error`、`loading_progress`）的载荷当时根本没有定义。

### 能力一律读矩阵，不看引擎名

判断"这家引擎能不能做某事"只有一个来源：`useProviderCapabilitiesMap()`。
组件里不要出现 `provider === 'xxx'` 形式的能力判断——
配额卡曾因为把显示名和引擎 id 相比而静默失效。矩阵未加载完成前不提供该功能，
避免先给出再收回。

引擎专属的**文案**（如某家为何查不到配额）走语言包按引擎 key 查找，缺 key 就不渲染，
不要为它写分支；Logo 与登录说明这类天生因引擎而异的展示数据同理，不进能力矩阵。

MCP 服务器表单按 `useProviderMcpCapabilities()` 渲染。首屏与请求失败回退到
`src/shared/mcpCapabilitiesFallback.ts`——该文件**零 import**，因为跨树 parity 测试要从服务端目录读它；
改后端声明而忘了改它会直接让测试红。

## 诊断报告（统一入口）

诊断只有**一份报告、两个入口**：设置 → 诊断，和聊天导出菜单里的「Diagnostics (.json)」。
两者调用同一个 `src/shared/diagnostics/diagnosticsReport.ts`，区别只在有没有会话可描述。
报告由五段组成：

- **启动与 PWA**（`startupDiagnostics.ts`）：当前及最近五次页面启动的导航/绘制指标、
  应用生命周期标记、聚合后的资源耗时、长任务、PWA/SW/Cache Storage 状态和运行环境。
- **连接帧**（`frameRecorder.ts`）：WebSocket **双向**帧的常驻录制。
- **滚动筛查**（`scrollScreening.ts`）：在聊天消息面板上筛出「手指划了却没滚动」的触摸。
  「列表滚不动」有三种成因——虚拟列表总高塌陷到只剩一屏（无可滚区间）、透明图层盖住面板
  （手指根本没碰到滚动容器）、主线程被长任务占满（触摸事件排队）——事后长得一模一样，
  修法却相反。因此每条记录都带上判定所需的事实：本次触摸的位移与 `scrollTop` 实际变化、
  面板几何与计算后的 `overflow-y`/`touch-action`/`contain`/`transform`、面板中心点的
  `elementFromPoint` 命中者、以及触摸事件从产生到被处理的最大延迟。
  平时零开销：passive 监听，只在触摸时比两个数，判定成立才读一次样。
- **时间线**：导出时刻 `serverMessages` / `realtimeMessages` 的行 id 列表、乐观行退休映射、`runEnded`。
- **服务端运行结束记录**：`GET /api/diagnostics/runs`，即后端对每次 run 为什么结束的判定
  （见 [chat.md](./chat.md)）。拉取失败写 `{ error }`，不让一段失败毁掉整份报告。

为什么要合成一份：用户报障时说的是「又慢又断」，他不该先判断该导哪种报告；而慢和断的证据
本来就分散在这四处，分成两份文件只会每次都少一半。

三条设计约束：

- **默认开着**。环形缓冲有上限、正文只存摘要，代价是几百 KB；需要先打开才录的日志，
  等于在真正出问题的那一次没有日志。
- **跨刷新存活**。帧按节流写进 sessionStorage（`pagehide` 兜底），下次加载读回并保留原
  `load` 标记，报告里能看出刷新边界在哪。只在内存里的录制等于没有：等用户想起要导出时，
  出事的那个标签页通常已经刷新过了——这是实测栽过的坑。
- **store 是按挂载创建的，不是模块单例**，所以报告不能直接 import 它；由 `useSessionStore`
  注册一个读取器，导出控件按当前会话 id 取。

隐私是格式契约：报告不得包含聊天正文、凭证、Cookie、请求头或 URL query。帧只留决定行身份的
字段（`kind` / `id` / `toolId` / `role` / `seq` + 截断摘要）；只有构建产物的 `/assets/`
路径可保留文件名，API、其他同源资源和外站资源分别归类为 `/api`、`same_origin_other`、
`external`；服务端运行记录只有标识、计时和计数。浏览器不支持的性能条目写 `null`，不可伪造为零。
应用可用性路径若变更，须继续用 `markStartupMilestone()` 标记入口执行、React 首次提交、
认证完成与工作区首次提交，使版本间报告可比。记录只留在本地，用户手动下载；不得自动上报。

## 性能守则（硬约束，都是踩过坑的）

1. **行身份稳定**：时间线 store 的两条不变量（字节等价行复用实例；更新只有原地 upsert / 保身份全量替换两种）。`React.memo`、WeakMap 转换缓存（`useChatMessages.ts`）、DOM 锚定全部依赖它。
2. **滚动与虚拟化**：转录由 virtua 的 `Virtualizer` 虚拟化，视口逻辑归 `useTranscriptViewport`（贴底、距顶两屏预取旧页、按下标跳转）。**滚动位置的正确性来自布局，不来自补偿**：virtua 测量每一行并据此改写滚动偏移，所以业务代码不得自行做高度差补偿、rAF 稳定循环或 `setTimeout` 贴底，也不要直接摸 `scrollTop`——要移动视口就用 `scrollToIndex`。前插旧页的那一次提交必须带 `shift`，否则会被当成追加。**禁止给消息行加 `content-visibility: auto`**：行自己改高度会把虚拟化没造成的高度变化喂给浏览器的启发式，与测量打架（已实锤移除，`transcriptRowCss.test.ts` 守着）。
3. **行下标是唯一寻址方式**：虚拟列表按下标定位，所以「哪些行会被渲染」只能有一个来源。分组（`groupConsecutiveTools`）在状态层完成，行数、搜索命中下标、贴底目标全部取自同一个 `transcriptItems`；不要再引入第二层可见窗口切片。
4. **高亮**：`src/shared/syntaxHighlighter.ts` 用 PrismLight + 显式语言注册表（`codeHighlightLanguages.ts`），不要换回全量 Prism。
5. **流式**：流式行必须经 `StreamingMarkdown`（前缀/尾块两段 `MarkdownBody`，前缀 memo 命中）+ store 的 100ms tick，别在每 delta 上重解析全文。
6. **WS 帧**：任何新功能不得在帧回调里直接 setState；进 store，靠 notify 批量提交。
7. **滚动的验收只看行，不看 `scrollTop`**：`scripts/perf/chat-scroll-up-stability.mjs` 断言屏幕上的行走了多远（`visualProgress`）、有没有逆向漂移（`visualBacktrack`）。虚拟化会主动改写 `scrollTop` 来让行不动，因此基于 `scrollTop` 的断言两头不准——既放过了旧实现的卡顿，又会把新实现的正常补偿报成故障。
8. **Git 变更面板按需取 diff**：`useGitPanelController` 只负责 `fetch` 单个文件的 diff，status 刷新时只清掉已不在变更列表里的缓存；`ChangesView` 在某行展开时才请求，`FileChangeItem` 折叠时**不挂载** `GitDiffViewer`。几百个变更文件若一次性预取并常驻 DOM（每行 diff 一个节点），移动端浏览器会被内存打死。

## i18n

- 目录 `src/modules/i18n/`：11 种语言 × 8 个命名空间（auth/chat/codeEditor/common/scheduled/settings/sidebar/tasks）；`scheduled` 目前只有 en / zh-CN / zh-TW 三份，其余语言整包回退英文（i18next fallback 按命名空间生效）。
- 新增用户可见文案必须走 i18n key；**en / zh-CN / zh-TW 三份必须给全**，其余语言可暂缺（回退英文）——这是当前维护约定，翻译覆盖面以 `src/modules/i18n/locales/` 现状为准。

## PWA 与版本

- `public/manifest.json` + `public/sw.js`（当前由 `src/main.tsx` 与 `index.html` 注册）；HTML 始终走网络，hash 静态资源走 cache-first，API 与 WebSocket 永不经 SW；因此刷新可拿到新版本，已缓存资源可复用。设置 → 关于的版本提示用 `__APP_VERSION__`（vite define）与含 git describe 的 `__BUILD_INFO__` 判断长驻窗口是否过期。
- 冷启动会话恢复：`src/shared/sessionProtection*` / `useSessionProtection`——仅 standalone 模式记忆并预验证回跳；恢复 effect 必须声明在记录 effect 之前（顺序敏感）。
- Web Push 复用 SW：`src/modules/settings/hooks/useWebPush.ts`，服务端 VAPID 在 `server/modules/notifications/`。

## 扩展检查单

| 要做什么 | 注意 |
| --- | --- |
| 新增聊天 UI 块 | 遵守行身份/两种更新形态；数据进 `SessionTimelineStore`，不建平行 state；`MessageComponent` / `ToolRenderer` 已 memo，别破坏输入身份。`ChatMessage.type` 是 `user\|assistant\|error` 三值联合（无索引签名），新 assistant 子形态走 `is*` 旗标 + convertRow + MessageComponent 分支 |
| 新增全局 Context | 挂到 `App.tsx` 并更新本文表格；能进 store 的别开新 Context |
| 新增设置分区 | `src/modules/settings/`（各分区独立组件），文案走 i18n 三语言。全局功能开关（Browser、定时任务）都在这里：保存后广播一个 `*SettingsChanged` window 事件，工作区 Tab 与 composer 入口用对应 hook 监听，不轮询 |
| 新增面板/标签页 | `src/modules/project-workspace/`（Shell 布局 + 标签页） |
| 引入新依赖 | 先确认不破坏性能守则（全量 Prism、per-frame setState、CV:auto 都是禁区） |
