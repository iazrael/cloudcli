# 前端架构（Frontend）

> **核心文档**：改动 `src/shared/**` 或聊天渲染/性能相关代码时**必须同步更新本文**。
> 普通 bug 修复不动架构的不需要更新（提交时走 `--no-verify`，见 `AGENTS.md`）。

模块规范（目录职责、命名、API 访问层）见 `.agents/skills/frontend-module-standards/SKILL.md`；聊天链路的服务端侧见 [chat.md](./chat.md)。

## 技术栈与入口

React 18 + TypeScript + Vite 7（`vite.config.js`，别名 `@` → `src/`），测试 vitest，i18n 用 react-i18next。入口 `src/main.tsx` → `src/App.tsx`：两个工作区路由 `/` 与 `/session/:sessionId`，Context 挂载顺序也在 `App.tsx`。

## 全局状态分层

| Context | 文件 | 管什么 |
| --- | --- | --- |
| `WebSocketContext` | `src/shared/context/WebSocketContext.tsx` | WS 单例；帧同步分发给订阅者，**帧不进 React state** |
| `AuthContext` | `src/modules/auth/context/AuthContext.tsx` | token、登录态 |
| `ThemeContext` / `UiPreferencesContext` | `src/shared/context/` | 主题与 UI 偏好（`userSettings.ts` 持久化到 localStorage） |
| `SessionProtectionContext` | `src/shared/context/SessionProtectionContext.tsx` | 会话保护 / PWA 冷启动恢复 |
| `ProjectsStateContext` | `src/modules/project-workspace/context/ProjectsStateContext.tsx` | 项目/会话列表（消费 `session_upserted` 等侧边栏 WS 帧） |
| `PermissionContext` | `src/modules/chat/context/PermissionContext.tsx` | 聊天权限批准 |
| `PluginsContext` | `src/modules/plugins/context/PluginsContext.tsx` | 插件 |

聊天消息**不走 Context**：走 `SessionTimelineStore`（框架无关）+ `useSessionStore` 适配器，见 [chat.md](./chat.md) 的四层结构。

## Provider 相关前端（零分支原则）

- **能力/目录的唯一来源是后端**：`useProviderCapabilities`（`GET /api/providers/capabilities`）+ `useChatProviderState`（`GET /api/providers/<p>/models` 拉统一模型目录，合成 `providerModelCatalog`）。
- **回退镜像**：`src/shared/providerCatalogFallback.ts` 只用于首屏与请求失败兜底，由 parity 测试钉住与后端一致；**其 key 顺序是全应用引擎规范顺序**（一处改动不要在别处另排顺序）。
- 本地选择持久化为 `<provider>-model` / `<provider>-effort`（localStorage，经 `userSettings.ts`）。
- 引擎外观：`src/shared/providerDisplay.ts`（显示名）、`src/shared/ui/LLMProviderLogo.tsx`（Logo）。
- 新增引擎的前端步骤见 [providers.md](./providers.md) 第六步——composer 不写 provider 分支，一切按能力矩阵渲染。

## 性能守则（硬约束，都是踩过坑的）

1. **行身份稳定**：时间线 store 的两条不变量（字节等价行复用实例；更新只有原地 upsert / 保身份全量替换两种）。`React.memo`、WeakMap 转换缓存（`useChatMessages.ts`）、DOM 锚定全部依赖它。
2. **滚动**：`useContinuousScrollAnchor.ts` 用 ResizeObserver 钉底；顶部链式加载旧页。**禁止给消息行加 `content-visibility: auto`**（估高↔真高翻转 + 锚定补偿会自持振荡，已实锤移除）；行为契约测试在 `src/modules/chat/utils/chatScrollStability.test.ts`。
3. **懒挂载**：`transcript/LazyMessageRow.tsx` + 共享 IntersectionObserver（`useLazyRowObserver.ts`，1200px 边距）——视口附近才挂真实内容，占位行与实测高度常驻。
4. **高亮**：`src/shared/syntaxHighlighter.ts` 用 PrismLight + 显式语言注册表（`codeHighlightLanguages.ts`），不要换回全量 Prism。
5. **流式**：流式行必须经 `StreamingMarkdown`（前缀/尾块两段 `MarkdownBody`，前缀 memo 命中）+ store 的 100ms tick，别在每 delta 上重解析全文。
6. **WS 帧**：任何新功能不得在帧回调里直接 setState；进 store，靠 notify 批量提交。

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
| 新增聊天 UI 块 | 遵守行身份/两种更新形态；数据进 `SessionTimelineStore`，不建平行 state；`MessageComponent` / `ToolRenderer` 已 memo，别破坏输入身份 |
| 新增全局 Context | 挂到 `App.tsx` 并更新本文表格；能进 store 的别开新 Context |
| 新增设置分区 | `src/modules/settings/`（各分区独立组件），文案走 i18n 三语言 |
| 新增面板/标签页 | `src/modules/project-workspace/`（Shell 布局 + 标签页） |
| 引入新依赖 | 先确认不破坏性能守则（全量 Prism、per-frame setState、CV:auto 都是禁区） |
