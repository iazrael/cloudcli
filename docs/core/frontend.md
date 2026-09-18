# 前端架构（Frontend）

> 基准：2.3.3 / 2026-09-18
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

前后端共用的 `NormalizedMessage` 是聊天时间线的 wire contract；provider 给出的跨路行身份和历史正文完整度必须由 WebSocket 与历史接口原样传入 `SessionTimelineStore`，不能在视图模型层重新生成。身份的分段与对账规则见 [chat.md](./chat.md)。本地 Markdown 图片经授权端点转换为 Blob URL 后，组件换图或卸载必须中止请求并恰好释放一次 URL。

## Provider 相关前端（零分支原则）

- **能力/目录的唯一来源是后端**：`useProviderCapabilities`（`GET /api/providers/capabilities`）+ `useChatProviderState`（`GET /api/providers/<p>/models` 拉统一模型目录，合成 `providerModelCatalog`）。
- **回退镜像**：`src/shared/providerCatalogFallback.ts` 只用于首屏与请求失败兜底，由 parity 测试钉住与后端一致；**其 key 顺序是全应用引擎规范顺序**（一处改动不要在别处另排顺序）。
- 本地选择持久化为 `<provider>-model` / `<provider>-effort`（`useChatProviderState` 直接读写 localStorage，设备本地，不经 preference store）。
- 引擎外观：`src/shared/providerDisplay.ts`（显示名）、`src/shared/ui/LLMProviderLogo.tsx`（Logo）。

### 会话标签只有一个字段

会话的显示名一律取 `ProjectSession.summary`，`getSessionTitle()` 是唯一入口。
类型里**没有** `name` 备选字段：曾经有过，后端从未下发，而优先读它的代码因此显示占位名。
新增读取点不要再加 `|| session.name` 之类的兜底。

### 消息类型的归属

服务端↔客户端的消息形状**不在前端定义**，而在仓库根 `shared/protocol/chatEvents.ts`，`src/shared/types.ts` 从那里 re-export
（细节见 [providers.md](./providers.md) 的「线上契约」）。前端曾另有一份自己的副本，与服务端悄悄漂移了七个字段。

前端在协议之上的本地扩展写在 `src/shared/types.ts`，必须显式列出：

- `TimelineMessageKind` = 协议的 `MessageKind` + `interactive_prompt`。后者由 composer 本地合成，引擎永不产出；把它挡在 `MessageKind` 之外，就不会有人误以为某家引擎该发这个 kind。
- `NormalizedMessage` = 协议消息换上 `TimelineMessageKind`，再加乐观回显的簿记字段 `replacesAnchorId` / `replacesAfterRowCount`。这两个字段从不上线，只活在「发出去」与「持久化回合顶替掉它」之间。

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
- 新增引擎的前端步骤见 [providers.md](./providers.md) 第六步——composer 不写 provider 分支，一切按能力矩阵渲染。

## 性能守则（硬约束，都是踩过坑的）

1. **行身份稳定**：时间线 store 的两条不变量（字节等价行复用实例；更新只有原地 upsert / 保身份全量替换两种）。`React.memo`、WeakMap 转换缓存（`useChatMessages.ts`）、DOM 锚定全部依赖它。
2. **滚动**：滚动机制归 `useChatScrollController`（组合 `useContinuousScrollAnchor` 的钉底 ResizeObserver、顶部链式加载、初始贴底、发送/刷新后的确定性回底、搜索跳转 reveal）——别在组件里另起 `setTimeout` 贴底或直接摸 scrollTop。**禁止给消息行加 `content-visibility: auto`**（估高↔真高翻转 + 锚定补偿会自持振荡，已实锤移除）；滚动窗口/补偿公式收在 `src/modules/chat/utils/chatScrollMath.ts`，行为契约测试绑定真身（`src/modules/chat/tests/chatScrollStability.test.ts`），两个 perf harness（`scripts/perf/chat-scroll-*.mjs`）是行为闸门。
3. **懒挂载**：`transcript/LazyMessageRow.tsx` + 共享 IntersectionObserver（`useLazyRowObserver.ts`，1200px 边距）——视口附近才挂真实内容，占位行与实测高度常驻。
4. **高亮**：`src/shared/syntaxHighlighter.ts` 用 PrismLight + 显式语言注册表（`codeHighlightLanguages.ts`），不要换回全量 Prism。
5. **流式**：流式行必须经 `StreamingMarkdown`（前缀/尾块两段 `MarkdownBody`，前缀 memo 命中）+ store 的 100ms tick，别在每 delta 上重解析全文。
6. **WS 帧**：任何新功能不得在帧回调里直接 setState；进 store，靠 notify 批量提交。
7. **Git 变更面板按需取 diff**：`useGitPanelController` 只负责 `fetch` 单个文件的 diff，status 刷新时只清掉已不在变更列表里的缓存；`ChangesView` 在某行展开时才请求，`FileChangeItem` 折叠时**不挂载** `GitDiffViewer`。几百个变更文件若一次性预取并常驻 DOM（每行 diff 一个节点），移动端浏览器会被内存打死。

## i18n

- 目录 `src/modules/i18n/`：11 种语言 × 7 个命名空间（auth/chat/codeEditor/common/settings/sidebar/tasks）= 77 个 JSON。
- 新增用户可见文案必须走 i18n key；**en / zh-CN / zh-TW 三份必须给全**，其余语言可暂缺（回退英文）——这是当前维护约定，翻译覆盖面以 `src/modules/i18n/locales/` 现状为准。

## PWA 与版本

- `public/manifest.json` + `public/sw.js`（注册在 `src/main.tsx` / `index.html`）；SW 不缓存 HTML 与 hash 资源名文件，**刷新即得新版本**；唯一旧窗口场景靠"设置 → 关于"的版本提示（`__APP_VERSION__` 由 vite define 注入，`__BUILD_INFO__` 含 git describe）。
- 冷启动会话恢复：`src/shared/sessionProtection*` / `useSessionProtection`——仅 standalone 模式记忆并预验证回跳；恢复 effect 必须声明在记录 effect 之前（顺序敏感）。
- Web Push 复用 SW：`src/modules/settings/hooks/useWebPush.ts`，服务端 VAPID 在 `server/modules/notifications/`。

## 扩展检查单

| 要做什么 | 注意 |
| --- | --- |
| 新增聊天 UI 块 | 遵守行身份/两种更新形态；数据进 `SessionTimelineStore`，不建平行 state；`MessageComponent` / `ToolRenderer` 已 memo，别破坏输入身份。`ChatMessage.type` 是 `user\|assistant\|error` 三值联合（无索引签名），新 assistant 子形态走 `is*` 旗标 + convertRow + MessageComponent 分支 |
| 新增全局 Context | 挂到 `App.tsx` 并更新本文表格；能进 store 的别开新 Context |
| 新增设置分区 | `src/modules/settings/`（各分区独立组件），文案走 i18n 三语言 |
| 新增面板/标签页 | `src/modules/project-workspace/`（Shell 布局 + 标签页） |
| 引入新依赖 | 先确认不破坏性能守则（全量 Prism、per-frame setState、CV:auto 都是禁区） |
