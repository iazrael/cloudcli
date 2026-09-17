# Provider 架构与接入指南

> **核心文档**：改动 `server/modules/providers/**` 或 `server/shared/{types,interfaces}.ts` 时**必须同步更新本文**。
> 普通 bug 修复不动架构的不需要更新（提交时走 `--no-verify`，见 `AGENTS.md`）。
> 引用一律给"文件路径 + 符号名"，不用行号。

相关文档：[overview.md](./overview.md)（全景）· [chat.md](./chat.md)（运行时事件怎么流向前端）

## 现状：六家引擎

`claude | codex | cursor | opencode | zcode | antigravity`，联合类型定义在 `server/shared/types.ts` 的 `LLMProvider`。注册表 `server/modules/providers/provider.registry.ts` 用 `Record<LLMProvider, IProvider>` 硬编码六家实例——漏一家直接编译报错。

每家一个目录：`server/modules/providers/list/<name>/`，由 `<name>.provider.ts` 组装各切面。claude / cursor / opencode 的 runtime 是遗留 `.js` 适配器（`claude-runtime.provider.js` 等），codex、zcode / antigravity 是 TS（含协议客户端、配额、运行生命周期等更多切面文件）。

## IProvider 七切面

契约在 `server/shared/interfaces.ts`，基类在 `server/modules/providers/shared/base/abstract.provider.ts`：

| 切面 | 职责 | 关键成员 / 消费服务 |
| --- | --- | --- |
| `runtime` | 拉起/中止引擎执行 | `run(command, options, writer, context)`、`abort(sessionId)`；可选 `compact(options, writer, context)`（按需压缩，前端 `/compact` 的唯一开关）；可选 `permissions`（权限批准网关）→ `providerRuntimeService` |
| `models` | 模型目录 | `getSupportedModels()`（预置目录）、`getCurrentActiveModel()`（只读兜底）→ `providerModelsService` |
| `auth` | 安装/登录状态 | `getStatus()`（"未安装/未登录"是数据不是异常）；可选 `getQuota()`（配额）→ `providerAuthService` |
| `mcp` | 引擎原生 MCP 配置读写 | `McpProvider` 基类（scope/transport 校验）→ `providerMcpService` |
| `skills` | 技能发现/写入 | `SkillsProvider` 基类（SKILL.md 扫描）→ `providerSkillsService` |
| `sessions` | 事件归一化 + 历史 | `normalizeMessage`、`fetchHistory`；可选 `getTokenUsage` / `resolveEditAnchor`（编辑锚点）/ `rewindSession`（codex 分支式回退）/ `cleanupSession` → `sessionsService` |
| `sessionSynchronizer` | 落盘索引 | `getSessionWatchTarget()`（声明 watch 根）、`synchronize()`、`synchronizeFile()` → `sessionSynchronizerService` + `sessions-watcher.service.ts` |
| `fork?`（可选） | 会话分支复制 | `forkSession()`；**缺省即"该引擎无 fork 能力"** |

**可选成员就是能力开关**，这是整个框架的核心设计。

**模型目录特例（opencode）**：`models` 切面一般是 source-controlled 预置表；opencode 在上面叠加引擎自己的 live 目录——`list/opencode/opencode-models.provider.ts` 的 `OPENCODE_PREDEFINED_MODELS` 只作离线兜底与精选标签来源，`getSupportedModels()` 还会读 opencode 的模型缓存 `~/.cache/opencode/models.json`（按 path+mtime+size 记忆化）：对 `opencode` / `opencode-go` 两个网关以 live 为准（active 新模型自动补进并带 live 名称与 effort、deprecated/已移除的剔除、DEFAULT 失效时顺延），其余 provider 段落以及缓存缺失/损坏时保持 curated；两条路径最后都按本机已连接 provider 过滤。会话模型值统一是目录里的 `<providerID>/<modelID>`：`getCurrentActiveModel()` 读 opencode 自己的 `session.model`（`{id, providerID}`）时补回前缀，`providerModelsService` 的 `resolveSessionModel` / `resolveResumeModel` 再把会话行上丢失前缀的裸 model id 按目录后缀唯一匹配还原——否则它会以 `--model <modelID>` 传给 CLI，被当成 providerID 而报 `Model not found: <id>/.`。

## 能力矩阵：推导而非手写

`server/modules/providers/services/provider-capabilities.service.ts`：

- `deriveCapabilities` 从注册表里的切面**推导**能力——`runtime.permissions` 存在 ⇒ `supportsPermissionRequests`；`sessions.resolveEditAnchor` 存在 ⇒ `supportsMessageEditing`；`fork` 存在 ⇒ `supportsSessionForking`；`sessions.getTokenUsage` 存在 ⇒ `supportsTokenUsage`；`runtime.compact` 存在 ⇒ `supportsCompaction`。
- 静态部分（权限模式列表、图片/文件/中止/effort）来自 `provider-capabilities.catalog.ts` 的 `PROVIDER_CATALOG`。
- `provider-capabilities.test.ts` 把推导结果钉在显式基线上：切面增删会以"评审过的测试差异"呈现，而不是静默改能力。
- **前端零 provider 分支**：composer/设置页完全按 `GET /api/providers/capabilities` 渲染。首屏与请求失败时的回退镜像在 `src/shared/providerCatalogFallback.ts`（`PROVIDER_FALLBACK_CATALOG`），由跨树 parity 测试（`server/modules/providers/tests/provider-catalog-parity.test.ts`）钉住与后端目录一致；**其 key 顺序就是全应用的引擎规范顺序**。
- **账号配额（`auth.getQuota`）现状**：antigravity（`agy` CLI）、codex（app-server JSON-RPC）、zcode（BigModel / Z.AI HTTP）、opencode（OpenCode Go 官方 `GET /zen/go/v1/usage`，`list/opencode/opencode-quota.provider.ts`；Zen 按量账号无公开端点，返回 null 即不渲染卡片）。前端消费方 `src/modules/chat/utils/providerQuota.ts` 维护同名单，后端新增配额适配器时两边同步。

## 上下文占用与按需压缩

`ProviderTokenUsageResult`（`server/shared/types.ts`）的语义是"**当前上下文占用**"而不是"会话累计花费"：`used` 是这一刻窗口里承载的量，`total` 是窗口大小；需要累计的引擎（codex/opencode）把会话累计放在 `cumulative`，claude 自报的百分比放在 `percentage`。前端 composer 徽章显示 `used`（有 `total` 时追加 `xx%`），`/cost` 弹窗画占用条并单列累计行。

| 引擎 | `used` 来源 | `total` 来源 | 备注 |
| --- | --- | --- | --- |
| claude | 最新一条主线程 assistant 的 `input + cache_read + cache_creation + output`；每回合结束再用 SDK `Query.getContextUsage({detail:'summary'})` 覆盖（带 `percentage`） | 同一次 SDK 调用的真实 autocompact 窗口；历史页按模型 id 含 `[1m]` 定 1M，否则 200k（`services/claude-usage.ts`） | SDK 会执行输入流里的 `/compact`，无需额外协议 |
| codex | rollout `token_count.info.last_token_usage`（live 用 `turn.completed.usage`） | `model_context_window` | 旧的 `total_token_usage` 只作 `cumulative` |
| opencode | 最新 assistant 消息的 `tokens.total` | `~/.cache/opencode/models.json` 的 `limit.context`（`list/opencode/opencode-context-usage.ts`，按 path+mtime+size 记忆化） | 会话列（`tokens_*`）是累计值，只作 `cumulative`；压缩摘要消息（`summary: true`）跳过 |
| antigravity | live usageRecord 的 total | 1M（硬编码） | 同值持久化到 brain `token_usage.json` |
| zcode | 消息级累计 | 无 | 无窗口，不显示百分比 |
| cursor | 无 `getTokenUsage` 切面 | — | `supportsTokenUsage: false` |

**`/compact` 的引擎实现**（能力开关是 runtime 可选切面 `compact`）：claude 把 `/compact` 当输入流的一条用户消息（SDK 按 local slash command 执行，实测可通过 `Query.getContextUsage()` 复核）；opencode 临时拉起 `opencode serve`（回环随机端口），调用 CLI 自己的压缩原语 `POST /session/:id/summarize`（TUI `/compact` 用的同一条路；`run --command` 只认用户配置命令，实测内置 `/compact` 会 500），payload 取 opencode.db 里会话行 `model` 列的 providerID/modelID；codex 走 app-server JSON-RPC `thread/resume`（必须带出 turns，摘要器要读被替换的对话）+ `thread/compact/start`，并且**要等压缩回合完成通知**（`item/completed` 的 `contextCompaction` 或 `turn/completed`）才能杀掉子进程，否则摘要只存在于内存里（`list/codex/codex-app-server.client.ts`）。antigravity 实测**不支持**：agy print 模式把 `/compact` 当普通 prompt 透传（"not a built-in slash command"），且 CLI 无压缩子命令。zcode / cursor 同样不实现，菜单按能力矩阵隐藏。

压缩**刚结束的那一刻占用不可知**（opencode 的摘要消息带的是刚被压缩掉的旧对话用量，实测 319k；真实占用要等下一个回合），所以 `ProviderTokenUsageResult` 用 `compacted: true` + `used: 0` 表达"已重置、token 数未知"（前端 `readTokenBudgetFromUsage` 与实时 `token_budget` 帧都判这个标记，不会继续挂着旧数字）。唯一当下可测的量是**摘要本身的大小**：摘要的正文存在 `part` 表（`message.data` 里没有 `content`），`readOpenCodeMessageTextBytes` 累计其 `text` 分片的 UTF-8 字节数，作为 `summaryBytes` 随 `compacted` 一起给出（摘要消息自己的 `tokens` 是这次总结调用读进去的旧对话，不能用）。前端用它显示"压缩摘要 · 9.4KB"直到下一个回合拿到真实占用；`/cost` 经 `commands.routes.ts` 透传同样的标记与字节数，把误导性的 0 行换成摘要大小行。

## 共享基础设施（写新引擎前先看）


都在 `server/modules/providers/shared/`：

- `engine-path/cli-engine-path.ts`：引擎二进制定位工厂——env 覆盖 → PATH → 平台安装路径，带 TTL 正/负缓存。配套 `installation/cli-installation-probe.ts` 探测原语。zcode / antigravity 有各自薄封装（`list/zcode/zcode-engine-path.ts` 等）。
- `sessions/sqlite-session-synchronizer.provider.ts`：`SqliteSessionSynchronizer<Row>` 模板方法基类——watch 过滤、高水位增量、只读短连接、pending-app-session 绑定。zcode / antigravity / opencode 共用；claude / codex 解析 JSONL，cursor 读 store.db，各自实现。
- `mcp/mcp.provider.ts`、`skills/skills.provider.ts`：MCP 与技能的校验/扫描基类；受管技能写入目标由各引擎覆盖 `getGlobalSkillSource()` 决定（claude → `~/.claude/skills`；codex / cursor / zcode / antigravity → `~/.agents/skills`；opencode → `~/.config/opencode/skills`），不覆盖即拒绝写入。
- 引擎专属协议设施（在各自目录内）：zcode 的协议客户端三件套 `zcode-protocol.client.ts`（单例 facade）= `zcode-codec.ts`（编解码）+ `zcode-engine-supervisor.ts`（子进程守护/崩溃熔断）+ `zcode-request-router.ts`（请求关联）；codex 的 `codex-app-server.client.ts`（JSON-RPC，专用于 `thread/fork` 这类 SDK 表达不了的操作）。
- zcode 附件通道：上传描述符在 runtime 内映射为 `session/send` 的原生 `attachments` 项（`{kind, filename, mimeType, sizeBytes, localPath}`，localPath 必须绝对；引擎静默丢弃无法映射的形状），不走其余五家的 `<files_input>`/`<images_input>` 文本标签。
- 运行期统一分发：`services/provider-runtime.service.ts`（`providerRuntimeService`：`run` / `abort` / `getRunner` / `resolveToolApproval` / `getPendingApprovalsForSession`）。

## 引擎自有数据根

| 引擎 | 数据根 | 会话产物 |
| --- | --- | --- |
| claude | `~/.claude` | `projects/**/*.jsonl` |
| codex | `~/.codex` | `sessions/**/*.jsonl` |
| cursor | `~/.cursor` | `projects/**/*.jsonl` + `store.db` |
| opencode | `~/.local/share/opencode` | `opencode.db`（共享 SQLite，`jsonl_path` 存 null） |
| zcode | `~/.zcode`（`zcode-data-root.ts`） | 引擎自有会话存储 |
| antigravity | `~/.gemini/antigravity-cli`（`antigravity-data-root.ts`） | brain 文档在 `~/.gemini/antigravity/brain`（只读暴露给 file-tree） |

## 新增一个引擎：六步清单

1. **类型**：`server/shared/types.ts` 扩展 `LLMProvider` 联合类型（全仓类型联动会指出所有必改点）；前端 `src/shared/types.ts` 同步。
2. **目录**：新建 `server/modules/providers/list/<name>/`，尽量复用基类（`AbstractProvider` / `McpProvider` / `SkillsProvider` / `SqliteSessionSynchronizer` / `cli-engine-path`），写 `<name>.provider.ts` 组装七切面。
3. **注册**：`provider.registry.ts` 的 `providers` 记录加一行（漏了编译报错）。同步器声明 `getSessionWatchTarget()` 后，`sessions-watcher.service.ts` 自动纳管，**不需要改 watcher**。
4. **能力**：`services/provider-capabilities.catalog.ts` 的 `PROVIDER_CATALOG` 补静态目录（权限模式、默认模型、images/files/abort/effort）；可选能力靠切面自动推导。同步更新前端镜像 `src/shared/providerCatalogFallback.ts`（parity 测试会强制）。
5. **接线**：需要被 agent/git 等模块直接拿 runner 时，在 `server/index.ts` 用 `providerRuntimeService.getRunner(...)` 注入；需要登录流则更新 `src/modules/provider-auth/ProviderLoginModal.tsx`。
6. **前端外观**：`src/shared/ui/LLMProviderLogo.tsx` 加 Logo、`src/shared/providerDisplay.ts` 加显示名。composer 无需改动——它按能力矩阵渲染。

改完跑：`npm run typecheck && npm run lint && npm test`（provider 相关测试在 `server/modules/providers/tests/`）。

**会话层级要求**：会话列表只索引顶层、可由用户继续对话的 provider 会话。Antigravity 使用其摘要库的 `parent_conversation_id` 与 `nesting_depth` 识别子 agent；子 agent 不写入活动列表，已被旧版本索引的行会软归档，原始 transcript 与本地元数据保留。缺少这两个字段的旧版 Antigravity 摘要库按顶层兼容读取。

**工具 id 同源要求**：live 与历史两路对同一工具调用必须产出**同一个 toolId**（理想：都读引擎原生 call id，如 zcode 的 `callID` 恰等于 live `toolCallId`）。做不到的引擎（codex/antigravity 现状——三命名空间无桥、锚点不同），影子卡去重只能靠前端指纹层 `src/modules/chat/utils/toolIdentity.ts` 兜底，新引擎接入时先回答这个问题。

### ⚠ 已知坑

- **常驻引擎的 stderr**：app-server 形态的引擎（zcode/codex）stderr 常驻嘈杂，别逐行转发日志——supervisor/客户端保留尾部环形缓冲（zcode 4000 字符），崩溃/crash-loop/session-lost 的错误全部附带尾部；engine 崩溃的真实死因只在 stderr 里。

- **全仓散落的引擎清单**：除上述契约点外，历史上有过 6 处硬编码 6 家列表/能力表的地方（MCP scopes、公开 API 文档 `public/api-docs.html` 的 `PROVIDER_ORDER` 等）。新增引擎后 `grep -rn "antigravity" src server public --include='*.ts' --include='*.tsx' --include='*.html' -l` 扫一遍清单类常量，防止新引擎被隐藏。
- `sessions`（运行时事件归一化/历史分页）与 `sessionSynchronizer`（落盘索引）是两个关注点，别混在一个类里。
- 归一化消息 id 必须唯一：一个原生事件拆多个 part 时要加判别后缀；分页契约 `limit: null` = 全量、`limit: 0` = 空页。
