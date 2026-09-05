# 系统全景（Overview）

> **核心文档**：本文描述整个系统的进程拓扑、目录地图、数据分布与部署方式。
> 改动 `server/index.ts`、数据库 schema、构建产物结构或部署方式时**必须同步更新本文**。
> 普通 bug 修复不动架构的不需要更新（提交时走 `--no-verify`，见 `AGENTS.md`）。

其他核心文档：[providers.md](./providers.md)（引擎接入）· [chat.md](./chat.md)（聊天链路）· [frontend.md](./frontend.md)（前端架构）

## 进程拓扑

整个产品是**一个 Node 进程**：Express 同时提供静态资源、REST API 和 WebSocket。

```mermaid
flowchart LR
  B["浏览器 / PWA"] -->|HTTP 静态资源 dist/| S
  B -->|REST /api/*| S
  B -->|WS /ws · /shell · /desktop-notifications · /plugin-ws/:name| S
  S["Express · server/index.ts · :3001"]
  S -->|"spawn / SDK"| E1["claude SDK"]
  S -->|stdio JSONRPC| E2["codex app-server"]
  S -->|CLI| E3["cursor / opencode"]
  S -->|协议客户端| E4["zcode 引擎"]
  S -->|CLI print| E5["agy (Antigravity)"]
```

要点：

- **服务端是引擎的宿主**，不是代理。引擎子进程/SDK 由服务端拉起，会话原件落盘在各引擎自己的数据目录，服务端只做索引、归一化与转发。
- 入口 `server/index.ts`：组装 Express、挂全部 REST 路由、挂 WS（`server/modules/websocket`）、托管 `dist/`、SPA fallback、优雅停机。
- 端口：`SERVER_PORT` 默认 **3001**，`HOST` 默认 `0.0.0.0`；开发模式 Vite 跑 5173 并把 API 代理到 3001（`vite.config.js`）。
- 启动标记：`~/.cloudcli/local-server.json`（host/port/pid/appRoot），用于 CLI 与健康检查定位实例。

## 目录地图（两层）

```
server/
  index.ts                 进程入口：路由挂载、静态资源、WS、监听与停机
  load-env.ts              最早加载 .env；DATABASE_PATH 默认 ~/.cloudcli/auth.db
  modules/
    providers/             ★ 引擎接入层（registry + 6 家 provider + services），见 providers.md
    websocket/             ★ WS 网关（/ws 聊天、/shell 终端、通知、插件代理），见 chat.md
    auth/                  JWT 注册/登录/刷新 + authenticateToken 中间件
    database/              better-sqlite3 连接、schema、migrations、repositories（16 张表）
    assets/                聊天上传资产（~/.cloudcli/assets）的上传与读取
    agent/                 无头 Agent API（API key / 平台模式鉴权）
    notifications/         Web Push（VAPID）+ 桌面通知 WS
    plugins/               插件注册表、插件子进程、WS 代理
    scheduled-messages/    定时消息（调度器 → 无附着 chat turn）
    browser-use/           浏览器自动化 service + 本地 MCP 桥接
    voice/  cli/  git/  file-tree/  worktrees/  projects/  settings/  system/  user/
                           其余领域模块（每个 = routes + services 的薄模块）
  shared/                  interfaces.ts（IProvider 契约）、types.ts（NormalizedMessage、
                           ServerEventKind 等）、message-unification.ts、utils.ts
src/
  modules/
    chat/                  ★ 聊天前端（composer、transcript、tools、实时 hooks、store、导出）
    project-workspace/     工作区外壳（布局、标签页、项目/会话列表状态）
    sidebar/  settings/  auth/  provider-auth/  mcp/  skills/  git-panel/  file-tree/
    code-editor/  shell/  standalone-shell/  i18n/  plugins/  browser-use/
    voice/  task-master/  command-palette/  onboarding/  quick-settings-panel/  …
  shared/                  api.ts（fetch 封装）、types.ts、context/（全局 Context）、ui/（通用组件 + 引擎 Logo）
  App.tsx                  路由：/ 与 /session/:sessionId 两个工作区路由
docs/
  core/                    ★ 本套核心文档（中文）
  architecture/            上游自带的聊天运行时深度文档（英文，6+1 篇）
  README.upstream.md       上游原始英文 README 备份
```

## 数据与持久化

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| SQLite（账号/会话元数据/配置） | `~/.cloudcli/auth.db`（`DATABASE_PATH` 可改） | 16 张表：users、api_keys、user_credentials、projects、sessions、app_config、provider_models、user_preferences、session_drafts、scheduled_messages、notification 系列、vapid_keys、push_subscriptions、scan_state、superseded_provider_sessions。连接单例 `server/modules/database/connection.ts`，表定义 `schema.ts`，迁移 `migrations.ts` |
| 聊天上传资产 | `~/.cloudcli/assets` | `server/modules/assets`；聊天发送只信任该目录**直接子文件**（`chat-websocket.service.ts` 过滤） |
| 各引擎会话原件 | `~/.claude` / `~/.codex` / `~/.cursor` / `~/.local/share/opencode` / `~/.zcode` / `~/.gemini/antigravity*` | 云 CLI 不复制、不改写；同步器只读解析后把元数据 upsert 进 SQLite（`sessions` 表含 `jsonl_path`） |
| 前端构建产物 | `dist/`（vite build） | Express 静态托管 + SPA fallback |
| 服务端构建产物 | `dist-server/` | `tsc + tsc-alias` 先产出 `dist-server.next`，`scripts/promote-dist-server.mjs` 原子晋升（保留 `dist-server.old`；`preserver` 钩子启动前自愈） |

**数据库改动规则**：改 `schema.ts` 必须同时写 `migrations.ts` 增量迁移（初始化走 INIT_SCHEMA_SQL，存量库走迁移链），并更新本文。

## 认证与安全边界

- **JWT**：`server/modules/auth/auth.middleware.ts`。密钥取 env `JWT_SECRET`，否则自动生成入库（`app_config.jwt_secret`）。token 7 天有效，半衰期自动刷新（响应头 `X-Refreshed-Token`）。WS 走 query string 或 Authorization 头鉴权（`websocket-auth.service.ts`）。
- **可选 API key**：`validateApiKey` 作用于全部 `/api`；agent 模块另走 API key / 平台双模鉴权。
- **上传白名单**：`chat.send` 的附件只放行 `~/.cloudcli/assets` 直接子文件，防止任意路径读。
- **`file:` 链接白名单**：会话里引擎产出的本地文件链接走只读端点，目录白名单含各引擎数据根与系统临时目录（`server` 侧 fileLink 相关服务），防止越权读盘。

## 构建与部署

```bash
npm run build        # build:client (vite → dist/) + build:server (tsc → dist-server 原子晋升)
npm run server       # node dist-server/server/index.js —— 生产启动就这一个进程
npm run dev          # tsx 跑 server(3001) + vite HMR(5173)，开发用
npm test             # 服务端测试（tsx --test server/**/*.test.ts）
npm run test:client  # 前端测试（vitest）
npm run lint         # oxlint src/ server/
npm run typecheck    # 前后端双 tsconfig --noEmit
```

- 本仓库生产实例用 **PM2** 托管：应用名 `cloudcli-ui`，`pm2 restart cloudcli-ui`。PM2 配置在宿主机不在仓库内；注意重启会切断在线 WebSocket（详见根目录 `AGENTS.md`）。
- 提交钩子：husky + lint-staged（oxlint）+ commitlint（Conventional Commits）+ 核心文档同步守卫（`scripts/hooks/check-doc-sync.mjs`）。

## 扩展检查单

| 要做什么 | 看哪里 |
| --- | --- |
| 新增 REST 领域模块 | 按 `.agents/skills/backend-module-standards` 的模块规范：`server/modules/<域>/`（routes + services），在 `server/index.ts` 挂路由 |
| 新增/改数据库表 | `database/schema.ts` + `migrations.ts` + `database/repositories/`，并更新本文 |
| 新增引擎 | [providers.md](./providers.md) 的六步清单 |
| 新增 WS 消息类型 | [chat.md](./chat.md) 的扩展检查单 |
| 新增前端大块 UI | [frontend.md](./frontend.md) + `.agents/skills/frontend-module-standards` |
