<div align="center">

<img src="public/logo.svg" width="110" alt="CloudCLI logo" />

# CloudCLI

**多引擎 AI 编码代理的 Web 控制台**

在浏览器（或手机 PWA）里统一驱动 Claude Code、Codex、Cursor CLI、OpenCode、ZCode、Antigravity 六家编码引擎：
实时流式会话、工具调用可视化、权限审批、终端 / 文件 / Git / 浏览器面板，一个都不缺。

本仓库 fork 自 [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)（Claude Code UI），在其基础上做了大量引擎接入、架构与性能增强（见下文）。

</div>

---

| 主界面（实时会话） | 引擎与统一模型库 |
| --- | --- |
| ![主界面](docs/screenshots/main-chat.png) | ![模型库](docs/screenshots/providers.png) |

| 引擎权限模式 | 移动端 / PWA |
| --- | --- |
| ![权限模式](docs/screenshots/settings-permissions.png) | ![移动端](docs/screenshots/mobile-chat.png) |

## 核心体验

- **多引擎同框**：一套 UI 管理所有引擎的会话，按项目聚合，随时切换；会话原件保留在各引擎自己的目录里，CloudCLI 只做索引与同步。
- **实时流式**：WebSocket 直播文本、思考块、工具调用卡片；断线自动重连并从 `lastSeq` 精确补发，不丢一条消息。
- **工作台面板**：内置终端（node-pty）、文件树与代码编辑器、Git 状态/提交、浏览器自动化面板。
- **随时随地**：PWA 可安装、移动端自适应、Web Push 通知；服务端绑 `0.0.0.0`，局域网 / Tailscale 直连。

## 相对上游的增强

> 上游 claudecodeui 提供 Claude / Codex / Cursor 三家接入和聊天基座。本 fork 在此之上的主要工作：

### 1. 新增两家原生引擎

- **ZCode（智谱 GLM）**：完整的协议层接入——协议编解码（codec）、引擎子进程守护（崩溃熔断、自动重启）、请求路由，流式工具参数、思考块归组、四档权限模式、会话落盘同步、token 用量统计。
- **Antigravity（Google Gemini / `agy` CLI）**：print 模式集成、`--add-dir` 沙箱目录授权、断流自动续跑、brain 文档只读暴露、token 过期检测与账号状态识别、5 小时 / 周配额查询。

### 2. Provider 框架重构（六家引擎同一套契约）

- `IProvider` 七切面（runtime / models / auth / mcp / skills / sessions / sessionSynchronizer）+ 抽象基类，新引擎按切面拼装，不写整块胶水。
- **能力矩阵**：每家引擎声明自己的能力（权限、fork、编辑、token 用量……），前端完全按矩阵渲染，**零 provider 条件分支**。
- **统一模型目录 API**：内置 + 自定义模型合并为一个列表（见截图），前端一个下拉选择所有引擎的模型与推理力度。
- 引擎二进制定位工厂（env 覆盖 → PATH → 平台默认路径，带 TTL 缓存）、SQLite 会话同步器基类（watch → 高水位增量 → upsert 广播）。

### 3. 聊天链路的稳定性与性能

- 框架无关的会话时间线 store：WS 帧零 React 更新、消息行身份稳定（滚动不跳动）、历史分页 + 实时流两路合并。
- 流式渲染优化：思考块 / 工具卡片按稳定 id 归组 upsert、增量 Markdown 解析、视口懒挂载。
- 权限批准链路加固：请求 / 应答双通道、断线后挂起请求恢复、权限僵尸卡根治。
- 排队消息自动补发、会话侧边栏增量广播（`session_upserted`）。

### 4. 其他

- Token 用量与配额面板（ZCode / Antigravity / Codex 配额同框展示）。
- PWA 冷启动会话恢复、前端版本自检与更新提示。
- 安全加固：上传资产白名单、`file:` 链接白名单只读访问、JWT 认证密钥自动生成入库。
- 简繁中文界面文案补全（i18n 11 种语言）。

## 快速开始

```bash
npm install

# 构建前端 + 后端
npm run build

# 启动（单进程：Express 同时提供 API、WebSocket 与前端静态资源）
npm run server
# → http://localhost:3001（默认绑 0.0.0.0，局域网可直连）
```

首次打开进入账号初始化，之后登录使用。开发模式用 `npm run dev`（Vite HMR 跑 5173，API 代理到 3001）。

### 引擎依赖

Web UI 是壳，各引擎需要对应 CLI 就位（按需安装，不用的可以不管）：

| 引擎 | 依赖 |
| --- | --- |
| Claude | `claude` CLI 并登录 |
| Codex | `codex` CLI 并登录 |
| Cursor | Cursor CLI |
| OpenCode | `opencode` CLI |
| ZCode | ZCode 桌面 App（引擎随 App 分发） |
| Antigravity | Google Antigravity（`agy` CLI）并登录 |

### 常用环境变量（均可省略）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SERVER_PORT` | `3001` | API + WebSocket + 静态资源端口 |
| `HOST` | `0.0.0.0` | 绑定地址；仅本机使用可改 `127.0.0.1` |
| `DATABASE_PATH` | `~/.cloudcli/auth.db` | 账号 / 会话元数据 / 应用配置（SQLite） |
| `CLAUDE_CLI_PATH` | `claude` | Claude CLI 自定义路径 |

运行时数据在 `~/.cloudcli/`（数据库、上传资产、运行标记）。上传的图片 / 文件落 `~/.cloudcli/assets`；会话对话原件始终在各引擎自己的数据目录，不重复占用空间。

## 架构文档（开发必读）

本 fork 的核心模块架构说明在 **`docs/core/`**（中文）。**改动对应模块时必须同步更新文档**（见根目录 `AGENTS.md` 的约定）：

| 文档 | 内容 |
| --- | --- |
| [`docs/core/overview.md`](docs/core/overview.md) | 系统全景：进程拓扑、目录地图、数据与持久化、认证、构建部署 |
| [`docs/core/providers.md`](docs/core/providers.md) | Provider 架构与“新增一个引擎”的完整步骤 |
| [`docs/core/chat.md`](docs/core/chat.md) | 聊天链路：消息生命周期、帧协议、权限批准、前端时间线 store |
| [`docs/core/frontend.md`](docs/core/frontend.md) | 前端架构：状态分层、性能守则、i18n、PWA |

上游自带的聊天运行时深度文档在 [`docs/architecture/`](docs/architecture/README.md)（英文，六篇），原始英文 README 备份在 [`docs/README.upstream.md`](docs/README.upstream.md)。

## 部署提示

生产环境推荐用 PM2 托管单进程 `node dist-server/server/index.js`（本仓库的运维约定见 `AGENTS.md`）。改代码后 `npm run build` 会原子晋升 `dist-server` 产物，重启即生效。

## License

AGPL-3.0-or-later（继承上游）。
