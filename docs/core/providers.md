# Provider 架构与接入指南

> 基准：2.5.1 / 2026-09-22
> **核心文档**：改动 `server/modules/providers/**` 或 `server/shared/{types,interfaces}.ts` 时**必须同步更新本文**。
> 普通 bug 修复不动架构的不需要更新（提交时走 `--no-verify`，见 `AGENTS.md`）。
> 引用一律给"文件路径 + 符号名"，不用行号。

相关文档：[overview.md](./overview.md)（全景）· [chat.md](./chat.md)（运行时事件怎么流向前端）

## 现状：六家引擎

`claude | codex | cursor | opencode | zcode | antigravity`，联合类型定义在 `shared/protocol/chatEvents.ts` 的 `LLMProvider`（前后端共用同一份，见下文「线上契约」）。注册表 `server/modules/providers/provider.registry.ts` 用 `Record<LLMProvider, IProvider>` 硬编码六家实例——漏一家直接编译报错。

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

**模型目录特例（zcode）**：新版本 ZCode 把用户自建 provider/模型从 `~/.zcode/v2/config.json` 迁到了 `~/.zcode/v2/provider_config.json` + 引擎自带目录（`zcode-provider-config.ts` 定位 runtime 刷新副本或安装目录 `resources/config/provider/zcode-builtin.json`），因此 `getSupportedModels()` 以引擎为准：调一次 `session/create` 取响应里的 `settings.model.available`（即引擎已合并用户 provider 后的完整目录，用完即 `session/close`），失败才回退磁盘解析。会话模型值同样是 `<providerID>/<modelID>`，并把每个模型的 `reasoning.defaultLevel` 记进 `zcode-models.provider.ts` 的 `engineReasoningDefaults`；`setModel` 的 schema 是严格校验，reasoning 档位必须放 `model.options.reasoningLevel`（旧的 `model.variant` 会被拒），缺省取上面记下的 defaultLevel，否则引擎报 “Reasoning level is required”。

## 能力矩阵：推导而非手写

`server/modules/providers/services/provider-capabilities.service.ts`：

- `deriveCapabilities` 从注册表里的切面**推导**能力——`runtime.permissions` 存在 ⇒ `supportsPermissionRequests`；`sessions.resolveEditAnchor` 存在 ⇒ `supportsMessageEditing`；`fork` 存在 ⇒ `supportsSessionForking`；`sessions.getTokenUsage` 存在 ⇒ `supportsTokenUsage`；`runtime.compact` 存在 ⇒ `supportsCompaction`。
- 静态部分（权限模式列表、图片/文件/中止/effort、编辑是否回滚文件 `editRevertsFiles`、引擎是否自带会话内调度 `supportsNativeScheduling`）来自 `provider-capabilities.catalog.ts` 的 `PROVIDER_CATALOG`。
- `provider-capabilities.test.ts` 把推导结果钉在显式基线上：切面增删会以"评审过的测试差异"呈现，而不是静默改能力。
- **`supportsNativeScheduling` 只是提示位，不参与启停**：CloudCLI 的循环定时任务（`scheduled-jobs`）对所有引擎可用；该位为 true（目前仅 claude 的 CronCreate/ScheduleWakeup）时，任务表单与 composer 重复入口提示"引擎自身也有会话内定时、冲突回合会被跳过"，行为不变。
- **前端零 provider 分支**：composer/设置页完全按 `GET /api/providers/capabilities` 渲染。首屏与请求失败时的回退镜像在 `src/shared/providerCatalogFallback.ts`（`PROVIDER_FALLBACK_CATALOG`），由跨树 parity 测试（`server/modules/providers/tests/provider-catalog-parity.test.ts`）钉住与后端目录一致；**其 key 顺序就是全应用的引擎规范顺序**。
- **账号配额（`auth.getQuota`）现状**：antigravity（`agy` CLI）、codex（app-server JSON-RPC）、zcode（BigModel / Z.AI HTTP）、opencode（OpenCode Go 官方 `GET /zen/go/v1/usage`，`list/opencode/opencode-quota.provider.ts`；Zen 按量账号无公开端点，返回 null 即不渲染卡片）。前端按 `supportsQuota` 能力位渲染配额卡片，不再维护同名名单。

## 上下文占用与按需压缩

`ProviderTokenUsageResult`（`server/shared/types.ts`）的语义是"**当前上下文占用**"而不是"会话累计花费"：`used` 是这一刻窗口里承载的量，`total` 是窗口大小；需要累计的引擎（codex/opencode）把会话累计放在 `cumulative`，claude 自报的百分比放在 `percentage`。前端 composer 徽章显示 `used`（有 `total` 时追加 `xx%`），`/cost` 弹窗画占用条并单列累计行。

引擎只在回合结束时才报用量的引擎（zcode、opencode），runtime 会在**回合进行中**补发 `token_budget`：监听器每次收到一个 step 收尾的信号（zcode 是 `tool_result`；opencode 是 assistant 的 `message.updated` 或 `step-finish` part）就去引擎库读一次最新占用，距上次发送不足 1.5s 或读数没变则不发；帧的 payload 与 `/token-usage` 端点同形，长工具轮的徽章因此不必等到 `complete` 才动。

| 引擎 | `used` 来源 | `total` 来源 | 备注 |
| --- | --- | --- | --- |
| claude | 最新一条主线程 assistant 的 `input + cache_read + cache_creation + output`；每回合结束再用 SDK `Query.getContextUsage({detail:'summary'})` 覆盖（带 `percentage`） | **会话维度持久化的 SDK 真值**（见下）＞`CONTEXT_WINDOW` ＞ 模型启发式（先看会话行的 `model`（用户选的变体，带 `[1m]`），再看转录里的模型 id；命中 `[1m]` 定 1M，否则 200k），单一 resolver `resolveClaudeContextWindow`（`services/claude-usage.ts`） | SDK 会执行输入流里的 `/compact`，无需额外协议 |
| codex | rollout `token_count.info.last_token_usage`（live 用 `turn.completed.usage`） | `model_context_window` | 旧的 `total_token_usage` 只作 `cumulative` |
| opencode | 最新 assistant 消息的 `tokens.total` | `~/.cache/opencode/models.json` 的 `limit.context`（`list/opencode/opencode-context-usage.ts`，按 path+mtime+size 记忆化） | 会话列（`tokens_*`）是累计值，只作 `cumulative`；压缩摘要消息（`summary: true`）跳过 |
| antigravity | live usageRecord 的 total | 1M（硬编码） | 同值持久化到 brain `token_usage.json` |
| zcode | 最新 step 的 `tokens.total`；旧行没有该字段时取 `input + output + reasoning`（持久化 prompt 已含 cache read，不能再加） | 引擎目录的 `contextWindow`（`resolveZCodeModelContextWindow`；用户自加 provider 只有引擎目录里有），缺失时回退 `v2/config.json` 的 `limit.context` | 全转录求和只作 `cumulative`（`list/zcode/zcode-context-usage.ts`）；压缩摘要行（`summary` 对象）跳过 → `compacted` + `summaryBytes` |
| cursor | 无 `getTokenUsage` 切面 | — | `supportsTokenUsage: false` |

**claude 的上下文窗口为什么必须持久化**：转录里每条 assistant 记的是*解析后*的模型 id（`claude-opus-5`），永远不会出现 `claude-opus-5[1m]` 这种窗口变体标记，所以任何"读转录猜窗口"的启发式都分不出 1M 会话和 200k 会话。真值只有 SDK 在 query 存活期间知道（`getContextUsage()` 的 `rawMaxTokens`，其 `maxTokens` 与之同值，`percentage` 就是 `round(used/total*100)`）。因此 runtime 一读到该值就写进 `sessions.context_window`（`services/claude-context-window.ts`，键是 app session id，找不到行就静默跳过，下一回合再写）。探测点有两个：流的开头（已恢复会话此刻上下文已经装配好，不必等首个 token）和首条 assistant 回复（全新会话最早有东西可测的时刻），每轮最多两次 control request（`createContextWindowCapture` 负责计次与去重），回合结束时再读一次，顺手把 badge 刷成 SDK 的精确读数。不只在回合结束写，是因为跑到一半就断的 run 根本没有 `result`——用户中断、CLI 崩溃、服务端在回合中间重启都算——那一行会永远留白，而 `model` 是 `default` 的会话没有 `[1m]` 标签可回退，此后一直显示 200k。三条发布 token budget 的路径——`/token-usage`、每一页历史、回合中的每个 assistant 帧——都先读它再落到 `CONTEXT_WINDOW` 和启发式。这条优先级里 SDK 真值排在 `CONTEXT_WINDOW` **之前**，否则实时帧（从不读 env）和重开会话后的读数又会互相矛盾。历史页不额外带 `percentage`：它等价于前端已有的 `used/total`，存下来只会在转录继续前进后变成陈旧值。还没在本应用跑过的会话退而看 `sessions.model`：那是用户在模型选择器里选的变体（`opus[1m]`），比转录里被解析掉的 id 多一个 `[1m]` 标签，所以配置成 1M 的会话重开即显 1M、不必先跑一轮。

历史页走 `sessionHistoryCache`，而缓存项的有效性原本只看转录文件的 path+mtime+size——因为结果曾经完全由文件推导。窗口持久化打破了这个前提（`tokenUsage.total` 多依赖了一个 DB 列，而该列是回合进行中和回合结束时异步写的），所以 `session.context_window` 也进了缓存判据：否则回合后的首次历史读取可能赶在写入之前，把一个回退默认值的 `total` 凝固在缓存里，往后每次翻页都把 badge 打回旧窗口，和实时帧来回跳。

`/token-usage` 与历史页共用 `summarizeClaudeTokenUsage` 这一个读取器（同样跳过 sidechain 与全零的 `<synthetic>` 行），两者只在取行范围上不同：历史页按 `sessionId` 过滤转录行，端点读整份文件。

## 交互式权限与提问（opencode）

`opencode run` 非交互模式对任何 `ask` 规则**直接拒绝**，没有把审批交给用户的通道。因此 opencode runtime 不再解析 `run --format json`，而是驱动一个**共享的 `opencode serve`**（`list/opencode/opencode-server.client.ts`）：单进程 + `/global/event` 事件流（按 `properties.sessionID` 路由到各 run）+ `POST /session[/:id/message]`，请求都带 `?directory=` 定位工程。live 事件翻译回既有 `sessions.normalizeMessage` 认识的信封（`text/reasoning/tool_use/step_finish/error`），历史与实时仍共用同一归一化器。共享 server 按引用计数常驻、空闲 60s 回收；**复用前先探 `/global/health`，探测失败且无 run 持有时重启**（Windows 下 `cmd.exe` shim 可能比真正的 `opencode.exe` 活得久，child 的 `exit` 不再触发）。`/global/event` 断线按 1s 自动重连（opencode 不重放历史事件，只会断档不会重复）；阻塞式 `POST /session/:id/message` 掉线时先查 `/session/status`，只要该会话仍在 `busy`/`retry` 就转为轮询等它 `idle`，让这一轮照常跑完而不是抛出传输错误，只有 server 真的连不上才判失败。请求失败时把 undici 的 `fetch failed` 还原成带 `cause`（如 `UND_ERR_SOCKET`/`ECONNREFUSED`）的可读错误，并保留 server stderr 尾部供崩溃诊断。

**传输层（`list/opencode/opencode-http.client.ts`）**：所有对 `opencode serve` 的请求（含 compact 的 summarize、事件流、健康探测）必须走 `openCodeFetch`——共享一个 undici `Agent`，`headersTimeout`/`bodyTimeout` 抬到 2.5h，高于 2h 的请求期限（`OPENCODE_SERVER_RESPONSE_TIMEOUT_MS`），per-request `AbortSignal` 才是唯一截止时间。Node 全局 `fetch` 的默认 5 分钟 headers/body 超时独立于 `AbortSignal`：阻塞式 prompt 要等整轮结束才回响应头，超过 5 分钟的正常长回合会被误杀成 `UND_ERR_HEADERS_TIMEOUT`（此前被恢复逻辑等满 1h 后原样抛给 UI），静默 5 分钟的事件流也会被掐断丢事件。

审批桥 `list/opencode/opencode-permissions.provider.ts` 就是 runtime 的 `permissions` 切面（`supportsPermissionRequests` 因此为 `true`）：`permission.asked` → `permission_request` 卡片 → `POST /permission/:id/reply`（`once/always/reject`）；`question.asked` → `AskUserQuestion` 卡片（`multiple → multiSelect`、`options` 原样映射）→ `POST /question/:id/reply`（跳过/拒绝走 `/reject`）。权限模式映射：`plan` → `plan` agent、`bypassPermissions` → 静默回 `once`（等价 `--auto`）、`default` → 由用户 opencode 配置决定（`ask` 才出卡片）。`/compact` 仍走独立的短生命周期 server（`POST /session/:id/summarize`）。

**编辑历史消息**：归一化消息把 provider 的 `msg_…` 暴露为 `transcriptAnchorId`；`sessions.resolveEditAnchor` 返回被编辑消息的前一条，`sessions.rewindSession` 对 server 调 `POST /session/:id/revert`（命名要丢弃的首条消息，即被编辑消息），所以 `supportsMessageEditing` 为 `true`。opencode 的 revert 是「丢弃该消息及其之后、下一条 prompt 时生效」，因此编辑是替换而非保留旧分支。该 revert 会按 snapshot **连同文件一起还原**（与 claude 的部分 resume、codex 的 fork 都不同——那两者不碰文件），所以能力矩阵给 opencode 标 `editRevertsFiles: true`，composer 据此把编辑横幅的「已修改的文件不会被还原」换成「会一并还原」。

**fork**：`list/opencode/opencode-fork.provider.ts` 实现 `fork` 切面（`supportsSessionForking` 为 `true`），调 server `POST /session/:id/fork`。该接口是**排除式**切点（拷贝切点之前的消息，不带则全拷），所以把 anchor 之后的**第一条 user 消息**作为切点，得到「含 anchor 整轮」的结果；anchor 是最后一轮时省略切点、全量拷贝。opencode 转录在共享 DB 里没有文件，故 `requiresTranscriptFile=false`，`IProviderFork` 的 `jsonlPath` 允许为 `null`。fork 暂未接。

**`/compact` 的引擎实现**（能力开关是 runtime 可选切面 `compact`）：claude 把 `/compact` 当输入流的一条用户消息（SDK 按 local slash command 执行，实测可通过 `Query.getContextUsage()` 复核）；opencode 临时拉起 `opencode serve`（回环随机端口），调用 CLI 自己的压缩原语 `POST /session/:id/summarize`（TUI `/compact` 用的同一条路；`run --command` 只认用户配置命令，实测内置 `/compact` 会 500），payload 取 opencode.db 里会话行 `model` 列的 providerID/modelID；codex 走 app-server JSON-RPC `thread/resume`（必须带出 turns，摘要器要读被替换的对话）+ `thread/compact/start`，并且**要等压缩回合完成通知**（`item/completed` 的 `contextCompaction` 或 `turn/completed`）才能杀掉子进程，否则摘要只存在于内存里（`list/codex/codex-app-server.client.ts`）。zcode 走 app-server 的 `session/compact`：引擎把它当一轮后台 `/compact` 提示跑（`turn.started` → `session.updated` 的压缩时间线 → `turn.completed`），所以 runtime 复用 run 的同一套流程（订阅 → 监听 → settle → 一个 `complete`），只是不设模型/权限模式（引擎用会话当前模型）；请求参数只发 `sessionId`（`expectedRevision` 可选，仅当传入且过期时才报 -32009，而应用不跟踪 revision），引擎回 `state: already_running` 时按错误上报而不是悄悄挂靠到别人的压缩上。antigravity 实测**不支持**：agy print 模式把 `/compact` 当普通 prompt 透传（"not a built-in slash command"），且 CLI 无压缩子命令。cursor 不实现，菜单按能力矩阵隐藏。

压缩**刚结束的那一刻占用不可知**（opencode 的摘要消息带的是刚被压缩掉的旧对话用量，实测 319k；真实占用要等下一个回合；zcode 引擎自己压缩时把摘要写成带 `summary` 对象的 user 行，同样跳过），所以 `ProviderTokenUsageResult` 用 `compacted: true` + `used: 0` 表达"已重置、token 数未知"（前端 `readTokenBudgetFromUsage` 与实时 `token_budget` 帧都判这个标记，不会继续挂着旧数字）。唯一当下可测的量是**摘要本身的大小**：摘要的正文存在 `part` 表（`message.data` 里没有 `content`），`readOpenCodeMessageTextBytes` 累计其 `text` 分片的 UTF-8 字节数，作为 `summaryBytes` 随 `compacted` 一起给出（摘要消息自己的 `tokens` 是这次总结调用读进去的旧对话，不能用）。前端用它显示"压缩摘要 · 9.4KB"直到下一个回合拿到真实占用；`/cost` 经 `commands.routes.ts` 透传同样的标记与字节数，把误导性的 0 行换成摘要大小行。

## Claude 会话进程：保活与复用（`claude-live-session.ts`）

claude 每个回合默认起一个 CLI 进程，回合结束即退出。但**启动了后台工作的回合必须把进程保活**：SDK 的输入流一旦结束就关 stdin，CLI 按 print wind-down 杀掉所有后台 shell/agent（`Bash(run_in_background)`、子代理、Monitor/Cron 等）。因此 runtime 用可推送的输入流（`createClaudeHeldPromptStream`）让 stdin 一直开着，回合结束后进程进入 idle 保活态，等待后台任务回报（CLI 会推一轮 follow-up 回合）；静默上限 `BG_WAIT_CEILING_MS`（30 分钟，同时作为 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 传给 CLI 约束后台 agent）只是兜底，任何流消息都会把倒计时往后推。

保活带来的核心约束：**用户在新回合发消息时绝不能重启进程**——那正是把后台任务杀掉的旧行为（`releaseInput()` → stdin EOF → wind-down）。`queryClaudeSDK` 因此在起新进程前先尝试**复用**：把新 prompt 推进活进程的输入流（同一进程内开启新回合，后台任务不受影响），并把这个新 run 的 writer 接上——事件循环的每回合状态（writer、complete、token 预算、idle 判定）都挂在 turn 对象上，adopted 回合的 `complete` 由新 run 的 writer 发出，原进程所属 run 的 promise 到进程退出才结算。复用条件（`canReuseClaudeLiveProcess` + 进程指纹 `buildClaudeProcessFingerprint`）全部满足才复用：模型/effort/permissionMode/cwd/工具白黑名单/MCP 配置逐项一致（改任一设置就重启，绝不悄悄用旧设置跑）、进程未进入 wind-down（`released`）、当前没有回合在跑、且不是编辑消息（`resumeAnchorId`/`resumeFromScratch` 必须新进程 resume 到锚点）。不满足时回退旧路径：释放保活进程 + 起新进程。

**回合归属**：每条 prompt 都带客户端 `uuid`，CLI 在回合首帧与 `result` 上回显（`user_message_uuid(_uuids)`）。runtime 用它把 `result` 绑到正确的 turn，从而区分"用户回合的 result"（发 `complete`、结算提交者）与"CLI 自己推的后台 follow-up 回合的 result"（只做 `notifyBackgroundWorkCompleted`，不得结束用户正在跑的 run）。CLI 是否回显由 `system/init` 的 `claude_code_version` 判定（≥ 2.1.259，`readClaudeInitUuidStampingSupport`），**不能**靠"进程第一个 result 没 uuid"去猜：resume 时 CLI 常先推一轮"后台任务已停止"的 task-notification 回合，它的 result 本就不带 uuid，误判会把它当成用户回合的结束 → 关 stdin → 真正的回合跑完时 wind-down 杀掉它启动的后台任务。只有版本读不出/更老时才退回"首个 result 定性 + 按到达顺序归属"的旧读法。

**后台工作判定**：以 CLI 的任务生命周期帧为准——`background_tasks_changed`（全量替换语义）与 `task_started`（`is_backgrounded`）维护存活任务集合、`task_notification` 移除，`ambient` 任务（内部看护进程）不计；集合跨回合存活，所以"上一回合启动的任务"在新回合结束时仍然撑住保活。保活条件是"集合非空 **或** 本回合工具检测命中"：集合管跨回合的旧任务，每回合的 `Bash(run_in_background)`/延迟工具检测（`startsBackgroundWork`）兜住 CLI 还没来得及报帧的新任务，也兼容不报任务帧的旧 CLI。完成通知只在集合确实清空时发（旧 CLI 保持"follow-up result 即完成"的旧读法）。

契约的实测探针：`scripts/probe/claude-bg-reuse-probe.mjs`（真实 CLI 验证三件事：第二条消息不杀后台任务、result 回显客户端 uuid、任务帧存在）。

## 共享基础设施（写新引擎前先看）


都在 `server/modules/providers/shared/`：

- `engine-path/cli-engine-path.ts`：引擎二进制定位工厂——env 覆盖 → PATH → 平台安装路径，带 TTL 正/负缓存。配套 `installation/cli-installation-probe.ts` 探测原语。zcode / antigravity 有各自薄封装（`list/zcode/zcode-engine-path.ts` 等）。
- `sessions/sqlite-session-synchronizer.provider.ts`：`SqliteSessionSynchronizer<Row>` 模板方法基类——watch 过滤、高水位增量、只读短连接、pending-app-session 绑定。zcode / antigravity / opencode 共用；claude / codex 解析 JSONL，cursor 读 store.db，各自实现。
- `sessions/workspace-admission.ts`：会话入库前的工作区准入闸门，见下节。
- `mcp/mcp.provider.ts`、`skills/skills.provider.ts`：MCP 与技能的校验/扫描基类；受管技能写入目标由各引擎覆盖 `getGlobalSkillSource()` 决定（claude → `~/.claude/skills`；codex / cursor / zcode / antigravity → `~/.agents/skills`；opencode → `~/.config/opencode/skills`），不覆盖即拒绝写入。
- 引擎专属协议设施（在各自目录内）：zcode 的协议客户端三件套 `zcode-protocol.client.ts`（单例 facade）= `zcode-codec.ts`（编解码）+ `zcode-engine-supervisor.ts`（子进程守护/崩溃熔断）+ `zcode-request-router.ts`（请求关联）；codex 的 `codex-app-server.client.ts`（JSON-RPC，**codex 的唯一对话传输**：`thread/start` / `thread/resume` / `turn/start` / `turn/interrupt` / `thread/fork`，这些请求产生的 item 通知流，以及反向的审批请求）。zcode supervisor 拉起 `app-server` 时先剥离环境继承的 `ZCODE_*_PROVIDER_CONFIG_FILE`（ZCode App 会话残留指向 App 自己的运行期文件），再注入 `zcode-provider-config.ts` 解析出的 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` / `ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`——桌面端本来会传这三个变量，裸 spawn 缺了它引擎定位不到 provider 目录，`session/create` 会一直挂到超时（模型一个都用不了）。
- zcode 附件通道：上传描述符在 runtime 内映射为 `session/send` 的原生 `attachments` 项（`{kind, filename, mimeType, sizeBytes, localPath}`，localPath 必须绝对；引擎静默丢弃无法映射的形状），不走其余五家的 `<files_input>`/`<images_input>` 文本标签。
- zcode 发送链路（引擎 0.16.9）：引擎对 `session/create` / `session/resume` / `session/send` 做严格 schema 校验，多一个键就报 -32602（`runtimeModel` 正是被拒的那个），所以请求只带 schema 声明的字段——resume 只发 `sessionId`，create 只发 workspace 描述符；模型选择经 `session/setModel` 设在会话上（reasoning 档位必须放 `model.options.reasoningLevel`，缺省取引擎目录里的 `defaultLevel`，恢复会话时强制重选以清掉 "model unavailable"（-32031）警告）。会话工作区必须由 `workspacePath` / `cwd` 显式给出：runtime 不再回退 `process.cwd()`，否则部署目录会被同步器登记成项目。
- 运行期统一分发：`services/provider-runtime.service.ts`（`providerRuntimeService`：`run` / `abort` / `getRunner` / `resolveToolApproval` / `getPendingApprovalsForSession`）。

## 会话索引准入：哪些工作区能变成项目

引擎各自记录会话的工作目录，同步器据此建项目行。判定统一走 `shared/sessions/workspace-admission.ts` 的 `admitsWorkspacePath`——六家引擎的同步器（SQLite 骨架一处 + claude / codex / cursor 各一处）都必须调用它，**新引擎接入时这是第 2 步的一部分**。两条拒绝规则：

1. **包管理器与运行时内部**：路径含 `node_modules` 或 pnpm 的 `.pnpm` 段（`server/shared/utils.ts` 的 `isInfrastructureWorkspacePath`）。
2. **已消失且从未登记过的目录**：`mktemp -d` 沙箱里跑过一次的引擎会长期把该目录记为工作区，目录被系统回收后，这类行每次重扫都会复活成同一批空项目。

系统临时目录本身**不是**拒绝理由——`/tmp` 下的临时克隆、复现仓是正常工作现场，一刀切会让这些会话从项目列表里无声消失。区分真项目与一次性沙箱的是"目录是否还在"，不是"在不在 /tmp"。

"已登记过"这一半同样不能省：外置盘或网络卷没挂载时目录暂时不存在，但项目行已在，会话照常更新。准入失败只阻止**新建**项目，永不删除既有数据。

引擎解析不出工作区时同步器返回 `null` 跳过该行，不拿服务端自己的 cwd 顶替——那只会把会话记到服务恰好启动的目录名下。

## 引擎自有数据根

| 引擎 | 数据根 | 会话产物 |
| --- | --- | --- |
| claude | `~/.claude` | `projects/**/*.jsonl`；`projects/` 作为聊天引用文件的只读根暴露给 file-tree，凭据与设置所在的上层目录不暴露 |
| codex | `~/.codex` | `sessions/**/*.jsonl` |
| cursor | `~/.cursor` | `projects/**/*.jsonl` + `store.db` |
| opencode | `~/.local/share/opencode` | `opencode.db`（共享 SQLite，`jsonl_path` 存 null） |
| zcode | `~/.zcode`（`zcode-data-root.ts`） | 引擎自有会话存储 |
| antigravity | `~/.gemini/antigravity-cli`（`antigravity-data-root.ts`） | brain 文档在 `~/.gemini/antigravity/brain`（只读暴露给 file-tree） |

## 新增一个引擎：六步清单

1. **类型**：`shared/protocol/chatEvents.ts` 扩展 `LLMProvider` 联合类型（全仓类型联动会指出所有必改点）。**只需改这一处**——前后端都从这里 re-export。
2. **目录**：新建 `server/modules/providers/list/<name>/`，尽量复用基类（`AbstractProvider` / `McpProvider` / `SkillsProvider` / `SqliteSessionSynchronizer` / `cli-engine-path`），写 `<name>.provider.ts` 组装七切面。
3. **注册**：`provider.registry.ts` 的 `providers` 记录加一行（漏了编译报错）。同步器声明 `getSessionWatchTarget()` 后，`sessions-watcher.service.ts` 自动纳管，**不需要改 watcher**。
4. **能力**：`services/provider-capabilities.catalog.ts` 的 `PROVIDER_CATALOG` 补静态目录（权限模式、默认模型、images/files/abort/effort）；可选能力靠切面自动推导（要报账号配额就给 auth 切面加 `getQuota`，并在载荷里声明 `partitioning`）。同步更新前端镜像 `src/shared/providerCatalogFallback.ts`（parity 测试会强制）。
5. **接线**：需要被 agent/git 等模块直接拿 runner 时，在 `server/index.ts` 用 `providerRuntimeService.getRunner(...)` 注入；需要登录流则更新 `src/modules/provider-auth/ProviderLoginModal.tsx`。
6. **前端外观**：`src/shared/ui/LLMProviderLogo.tsx` 加 Logo、`src/shared/providerDisplay.ts` 加显示名。composer 无需改动——它按能力矩阵渲染。

改完跑：`npm run typecheck && npm run lint && npm test`（provider 相关测试在 `server/modules/providers/tests/`）。

## 能力矩阵：声明优于分支

`provider-capabilities.catalog.ts` 放**推导不出来的静态事实**（权限模式、默认模型、附件/中止/effort）；
`provider-capabilities.service.ts` 从**已注册切面推导**其余能力——切面在即能力在，加减切面自动翻转，不必改表。
`supportsQuota` 就是这样推导的：`auth.getQuota` 存在即为真，而 `provider-token-usage.service.ts`
本来就按这个方法分发配额请求；`supportsQuotaReset`（能否花掉重置卡）同理，看 `auth.consumeQuotaReset`。

前端**不得**用引擎名判断某家能不能做某事，一律读矩阵。这不是洁癖：
配额分组判定曾把 `getProviderLabel()` 的显示名（`'Codex'`）拿去和引擎 id（`'codex'`）比较，
永远为假，于是 reserve 桶的甄别逻辑在线上从未生效，而单测因为直接传 id 一直是绿的。

同理，**配额载荷自述分组形态**（`partitioning: 'model-family' | 'bucket'`），
由各家配额适配器声明，前端不再记忆哪家是哪样。新增一家配额引擎只需给它的 auth 切面加 `getQuota`
并声明 `partitioning`，前端一行都不用改。

**配额的数据源各家不同，但都收在 auth 切面背后**：codex 起一次 `app-server` 走
`account/rateLimits/read`，zcode 直接打 BigModel / Z.AI 的 HTTP 端点，
claude 则借 Agent SDK 的 control request（`/usage` 背后那个实验接口）——
因为 OAuth 令牌与静默续期都归 SDK 管，绕过它就得自己碰凭据。
三家都要拉起进程或走网络，因此统一用 `createProviderQuotaCache`（TTL 两分钟）挡在前面，
`?refresh=true` 才穿透。claude 那条路额外有一点要守住：喂给 SDK 的输入流一条消息都不产出，
CLI 只是挂着等输入，既不会落 transcript，也不会消耗它正在汇报的额度。

**重置卡（banked reset）随配额载荷搭车**：`ProviderQuotaData.resetCredits` 由各配额适配器
在读取时顺带解析（`POST /providers/quota/reset` 花卡）。挑卡规则收在共享的
`pickAvailableResetCredit`——`all` 卡覆盖一切请求，窄卡只精确匹配，多张可用时花最早到期的；
卡 id 不出适配器边界。调用方传的只是 `resetType`，花卡前各家都重读一次卡列表（缓存可能是旧的），
成功后作废配额缓存让下次读反映新窗口。codex 走 `account/rateLimitResetCredit/consume`
（与 read 同一条 app-server 连接，`creditId` + `idempotencyKey`）；zcode 打 BigModel
`/biz/customer-package-reset/list|use`（第一版只接个人号，团队号要组织/项目 ID；
claude 的 `/limit-reset` 端点存在但无可验证的卡，暂未接入）。

**MCP 配置格式的能力同样由切面声明**：`IProviderMcp.capabilities` 给出可用 scope、transport、
是否支持工作目录、是否支持环境变量间接（`env_vars` / `bearer_token_env_var` / `env_http_headers`，
目前只有 codex 有；普通 `env` 与 HTTP `headers` 六家都写，不需要开关）。
矩阵原样透出，服务器表单据此渲染。

前端为首屏与请求失败保留一份镜像 `src/shared/mcpCapabilitiesFallback.ts`，
由 `provider-catalog-parity.test.ts` 跨树钉住——这正是它此前缺的：
旧的三张散表没有守卫，Cursor 明明会写 `cwd`，表里却写着不支持，工作目录字段因此对 Cursor 用户一直不可见。

**受管 MCP（CloudCLI 自带的桥）**：`providerMcpService.addMcpServerToAllProviders` 遍历 live registry 向六家写入同一条 stdio/HTTP 条目，逐 provider 收集结果、单家失败不阻塞；`envFor(provider)` 可按引擎追加 env。两个使用者：`cloudcli-browser`（浏览器自动化，见 browser-use 模块）与 `cloudcli-scheduled-tasks`（定时任务，`envFor` 注入 `CLOUDCLI_SCHEDULED_JOBS_PROVIDER`，让桥知道自己来自哪个引擎）。两者都由 Settings 的全局开关驱动注册/注销，并在启动时 `syncAgentMcpIfNeeded()` 幂等对账，桥的 stdio 框架共用 `server/shared/mcp-stdio.ts`。

## 差异吃在适配器里，不漏给前端

引擎的私有包装与字段命名**必须在各自适配器里归一化掉**，共用的渲染与展示代码不得认识任何一家。
两个已收回的例子，都曾以「前端按引擎名分支」的形式存在并腐坏：

- **会话标题**：各家同步器把自己推导出的名字写进 `custom_name`，会话行一律以 `summary` 下发。
  前端一度为 Cursor 单独读一个 `name` 字段——后端从未下发过它，于是 Cursor 会话长期显示占位名。
- **Codex 的 `<proposed_plan>` 信封**：由 `readCodexProposedPlan` 拆成与 Claude 相同的
  `ExitPlanMode` 计划卡。实时、会话读取、持久化三条归一化路径**都要做**；
  此前持久化那条漏了，共用的消息渲染组件便长出一段只给 codex 用的剥标签逻辑。

- **正文里的记忆标记**：引擎会给「用到了存储记忆」的回复打上机器可读标记——codex 在末尾追加
  `<oai-mem-citation>` 块，claude 用 `<cc-memory filenames="…">` 把引用到的那句话包起来。
  形态不同但性质一样：它们是溯源标记不是正文，留在里面就是一堆裸标签。
  `providers/shared/memory-citations.ts` 是唯一的剥离点，`liftMemoryCitations(provider, text)`
  归一化成 `memoryCitations`，前端统一渲染成回复下方的折叠脚注。新引擎在这个模块里加一条模式，
  不要在自己的适配器里另写一份。注意两种形态的处理方式相反：codex 是整块切掉，claude 是脱壳保留内容。

判断标准很简单：如果一段共用代码需要知道「这是哪家引擎」才能正确工作，那它就放错了地方。

## 线上契约：一份定义

服务端↔客户端的消息形状定义在仓库根的 **`shared/protocol/chatEvents.ts`**，两端各自 re-export，谁都不再另写一份：
`LLMProvider`、`MessageKind`、`GatewayEventKind`、`ServerEventKind`、`NormalizedMessage`、
`SubagentActivity`、`SubagentInfo`、`MemoryCitation`、`SessionUpserted*` / `SessionRemovedEvent`。

两个 tsconfig 都已把根 `shared/` 纳入编译范围；前端另有 `@shared/*` 别名。该文件不引 `node:*` 也不引 DOM/React，
所以两边都能编译它。

**`NormalizedMessage` 没有索引签名**，`createNormalizedMessage` 的入参也没有。
引擎适配器写入一个未在协议里声明的字段会直接编译失败——需要新字段就先在协议里声明，并说明哪个 kind 会带它。

类型只管得到编译器看得见的地方，而 claude / cursor 的 runtime 是 `checkJs: false` 的 `.js`。
因此出站还有一道**运行时闸门** `server/shared/normalized-message-contract.ts`，
由 `ChatSessionWriter.send` 调用：

- 信封坏了（不是对象、缺 `kind` 或 `provider`）→ 整条丢弃并记录原因
- 带了协议未声明的字段 → **剥掉该字段后放行**，并在日志里点名

剥离而非抛异常，是为了让违规既无法抵达前端、又不会因为一个字段杀掉用户正在跑的 run。
闸门的字段清单由类型层的完整性断言钉住：往协议加字段却忘了登记会**编译失败并报出字段名**，
所以它不会变成又一面陈旧的镜子。

### 字段按 kind 归属

哪个 kind 能带哪些字段，定义在 `shared/protocol/messageKinds.ts` 的 `MessageFieldsByKind`，
并由 `createNormalizedMessage` 按 kind 泛型强制执行：拿 `toolName` 去构造一条 `text`、
拿 `newSessionId` 去构造一条 `tool_use`，**构造那一行直接编译失败**。
每个 `MessageKind` 都必须有条目，漏了同样编译失败并报出 kind 名。

**读取侧仍是扁平的**——`NormalizedMessage` 有四百多处消费点，把它硬改成联合等于一次性重写全部。
纪律装在构造处，因为漂移正是从那里产生的。消费点按需用
`shared/protocol/messageNarrowing.ts` 的收窄谓词逐个迁移：`isToolUseMessage(m)` 之后，
编译器知道 `toolName` 可用，也知道 `newSessionId` 不可用。
谓词逐个 kind 写死而非泛型生成——泛型 `K` 会让 TypeScript 无法证明可赋值，
收窄会静默退化成什么都不保证。

各端在协议之上的本地扩展必须显式写出、不得混入协议本身。今天只有前端有：
`kind` 放宽为 `TimelineMessageKind`（多一个前端自造、引擎永不产出的 `interactive_prompt`），
外加乐观回显的簿记字段 `replacesAnchorId`。

**工具卡同样要两路描述一致。** 描述一致的正解是两路读同一份记录，而不是把两份不同的记录
对齐到同一个指纹上——codex 现在两路都读 ThreadItem，`toolId` 与入参因此天然相同
（命令文本仍统一成 shell 包装里的那条命令，因为两种序列化一个给数组、一个给字符串）。

**一条 item 在实时流里只发一次，除非它真的在推进。** 引擎宣布一条 item 的开始和完成时，只有"用户在等"的那几类（命令执行、补丁、MCP 调用、协作 spawn）值得把开始态也发出去——客户端按工具 id 合并两帧。正文和推理开始时是空的，内容靠 delta 到达；正文 delta 走 `stream_delta` 帧，推理只在完成时发一条（客户端的 thinking 合并是**追加**语义，重发累积文本会把内容叠成前缀串）。

**历史只能包含转录行。** `complete`、`stream_delta`、`stream_end`、`session_created`
描述的是"一次运行正在进行"，历史里没有运行，也就不该出现这些 kind。
zcode 曾为每个持久化 step 产出一条 `complete`——真实会话里占全部行数的 35%，
一行都渲染不出来，却照样计入分页、计入每一次遍历转录的扫描、计入客户端发送时记录的行数。
`history-kind-standard.test.ts` 对四家逐一把关。

**子代理的线程 id 也是适配器的责任。** Codex 用 `agent_thread_id` 指向子代理自己的同级 rollout，
该 id 来自 `SubAgentActivity` 项；spawn 本身也只以这个项出现在 item 流里，
所以 `Task` 行就以它的 item id 命名，`completed` / `interrupted` 再用同一个 id 收尾。
子代理自己的 rollout 用与主线程完全相同的读法（item 流 + 同一个行渲染器）铺进折叠面板。

**跨路行身份是适配器的责任，不是前端的猜测活。** 一条持久化的行存在两份——
运行中的实时帧，和之后历史读回的那一行。前端把两份显示成一行的唯一诚实依据是**同一个 `id`**；
对认不上时它只能退回按文本相似度和数组下标猜，重复消息就是这么来的。

因此协议规定：**`kind` 属于转录行的消息（`text` / `thinking` / `tool_use` / `tool_result` /
`task_notification`），其 `id` 必须由引擎自己的记录推导——同一条记录，无论走哪一路、读多少遍，
id 必须字节相同。** 这条有两道闸门守着：

- 编译期：`shared/protocol/messageKinds.ts` 里 `generateMessageId()` 返回带品牌的
  `VolatileMessageId`，无法赋给转录行的 `id`（类型为 `DeterministicRowId`），写错的那一行直接编译不过。
- 运行期：两个 `.js` 运行时和若干从 `any` 读出的历史路径编译器看不到，由
  `enforceNormalizedMessageContract` 兜底——转录行带 `vol_` 前缀的 id 会被点名记录（消息照发，
  丢一条真回复比重复一条更糟）。

各引擎的推导依据：

| 引擎 | 行身份 | 依据 |
| --- | --- | --- |
| claude | 落盘 `uuid` | 实时 SDK 消息与落盘行的 `uuid` 同值，两路归一化出的 id 逐行相同 |
| codex | ThreadItem 的 `id`（`msg_…`/`rs_…`/`exec-<uuid>`/`call_…`），一项多行时后缀 `_<n>` / `_result` | 两路读的是同一个 ThreadItem：app-server 实时推 `item/started`+`item/completed`，rollout 把同一项写进 `event_msg`→`item_completed`，id 逐字相同 |
| antigravity | `msg_<sessionId>_<toolId>`（工具行）、`msg_<sessionId>_<step_index>`（正文行） | 工具调用在两路的 step 号相差一步，由 `buildAntigravityToolId` 归一后再派生行 id |
| zcode | `(message_id, part_id)`；推理段取开启该段事件的 `${id}_reasoning` | 引擎事件自带 id，段内后续 delta 沿用开段 id。实时流不发正文行 id（只有 delta），故 assistant 正文改由 `providerRowKey: zcode-message:<message_id>` 对账，两路同源 |
| opencode | `(message_id, part_id)`；其余切面未盘点 | 实时流不发行 id（只有 `message.part.delta` 片段），故 assistant 正文由 `providerRowKey: opencode-part:<part_id>` 对账。**按 part 而非 message 取 key**：一个回合"正文→工具→正文"会落两条正文行，共用一个 key 就成了二义匹配，两边都对不上 |
| cursor | 未盘点 | 本 fork 不投入，只保证可编译、测试通过 |

**引擎同时提供「原始记录」和「组装好的记录」时，两路都读组装的那一份。** codex 的 rollout 里
既有 Responses API 的原始条目（`response_item`：`custom_tool_call` 及其输出、`function_call`、
`message`），也有引擎自己组装好的 ThreadItem（`event_msg` → `item_completed`）；app-server
实时推送的正是后者。读原始条目意味着自己重建一遍引擎已经做过的事——把 exec 脚本反解成命令、
把补丁反解成逐文件 diff、把输出回填到调用上——而重建出来的东西带的是原始条目的 id，
和实时那份对不上，于是每条回复渲染两遍。读组装记录则两路同源：一个词汇表
（`codex-thread-items.ts`）、一个行渲染器、一套 id。

引擎确实什么都没给时**不要伪造**：随机值会让对账从"知道自己不知道"变成"自信地答错"。
正确做法是让推导落在引擎记录的确定性属性上（文件内序号、step 号、数据库主键都算），
或者接受这一行无法跨路对认并在上表里写明。

跨引擎一致性由 `server/modules/providers/tests/row-identity-conformance.test.ts` 守：
同一条记录读两遍 id 必须相同，且任何转录行都不得带 `vol_` id。

`providerRowKey` 只在行 id 本身无法跨路相等、但 provider 能从两路原生数据复建出同一身份时使用；
它不承担展示 id、WebSocket `seq`、排序 `sequence` 或编辑锚点的职责。

**`providerRowKey` 的边界**：前端只在 `(provider, sessionId, providerRowKey)` 唯一对应时认定两路属于同一行，再按 provider 明确给出的正文完整度选择展示来源；正文不参与身份猜测。同 key 多候选时保留双方。Antigravity 只为实时 `agent_response` 与历史纯正文 `PLANNER_RESPONSE` 设置 `assistant-step:<step_index>`，不推广到用户、工具或 `GENERIC` 行。

**工具 id 同源要求**：live 与历史两路对同一工具调用必须产出**同一个 toolId**（理想：都读引擎原生 call id，如 zcode 的 `callID` 恰等于 live `toolCallId`）。做不到的引擎（antigravity 现状——锚点不同），影子卡去重只能靠前端指纹层 `src/modules/chat/utils/toolIdentity.ts` 兜底，新引擎接入时先回答这个问题。

**Antigravity 转录读取**：`antigravity-transcript.provider.ts` 是 compact `transcript.jsonl` 与 `transcript_full.jsonl` 的唯一读取入口。它按原生 `step_index` 以 full 覆盖同一步、保留 compact 尚未被 full 追上的尾部，并跳过损坏 JSONL 尾行；历史正文同时带明确的完整度事实。历史专属 thinking 不进入可见时间线，因为它没有可与实时流对应的稳定身份。

**会话层级要求**：会话列表只索引顶层、可由用户继续对话的 provider 会话。Antigravity 使用其摘要库的 `parent_conversation_id` 与 `nesting_depth` 识别子 agent；子 agent 不写入活动列表，已被旧版本索引的行会软归档，原始 transcript 与本地元数据保留。缺少这两个字段的旧版 Antigravity 摘要库按顶层兼容读取。

### ⚠ 已知坑

- **一次性 CLI 的异步任务会被静默掐死**：`agy` 的一次性 print 模式（`agy -p "<prompt>"`）在 root agent 转入 idle 后只等几秒就关停整个 CLI，日志为 `root agent idle; waiting up to 5s for N background task(s)` → `terminating N background task(s) on exit`。子代理和被放到后台执行的 `run_command` 都在这里死掉，而 CLI 仍然吐出 `status: SUCCESS`，于是前端收到 complete、任务看着「做完了」，真正的结果永远不会回来。antigravity runtime 因此把这一轮的 prompt 作为一行 NDJSON（`{"event":"user","message":{"content":"…"}}`）写进 stdin 并用 `--input-format stream-json` 启动：stdin 保持打开 → CLI 不自行关停 → 异步任务跑完，结果照常从 stream 回流；收到 `result` 事件后再关闭 stdin 让进程退出。**prompt 一旦退回 argv，这个保护就没了。**

  代价是超时责任转移到了服务端：`--print-timeout` 在该模式下不生效（实测一轮带 `20s` 上限的 run 在 result 之后依然存活，直到 stdin 关闭才退出），而 stdin 又由我们持有，所以 result 事件一旦走不到（CLI 崩溃、stdout 被截断、result 行被 agy 穿插的纯文本搞坏导致 JSON 解析失败），进程和这次 run 会无限期挂住。runtime 因此自带一个**以 stdout 活动续期的看门狗**，取值就是 `printTimeout`，到期 SIGTERM 并按失败收尾。另有一个例外：agy 的 interrupted-stream result 不是终态（它会自行注入续跑提示），在它上面关 stdin 等于又一次把异步工作掐死，所以只有真正的 result 才关。

  接新的 CLI 引擎时先问两句：它的非交互模式在主循环 idle 之后如何处置未完成的后台任务；以及谁为「进程永远不退」兜底。

- **会话内的权限模式归引擎所有**：app-server 形态的引擎把权限模式持久化在会话上（zcode 写 `session.permission`），而模型会在一轮里自行切进计划模式。因此设置里的权限模式是**变更时下发**，不是每轮重申：`zcode-runtime.provider.ts` 记住每个引擎会话最后下发的模式，值没变就不发 `session/setMode`。每轮重申会在两轮之间把计划模式抹掉，模型下一次调 `ExitPlanMode` 直接拿到「can only be used while plan mode is active」，审批卡片根本不会出现，而模型可以把这句报错读成「已获批准」继续动手。进程内缓存意味着服务重启后的第一条消息仍会下发一次——这是为了让重启期间改过的设置必定生效而留的取舍。

- **常驻引擎的 stderr**：app-server 形态的引擎（zcode/codex）stderr 常驻嘈杂，别逐行转发日志——supervisor/客户端保留尾部环形缓冲（zcode 4000 字符），崩溃/crash-loop/session-lost 的错误全部附带尾部；engine 崩溃的真实死因只在 stderr 里。

- **全仓散落的引擎清单**：除上述契约点外，历史上有过 6 处硬编码 6 家列表/能力表的地方（MCP scopes、公开 API 文档 `public/api-docs.html` 的 `PROVIDER_ORDER` 等）。新增引擎后 `grep -rn "antigravity" src server public --include='*.ts' --include='*.tsx' --include='*.html' -l` 扫一遍清单类常量，防止新引擎被隐藏。
- `sessions`（运行时事件归一化/历史分页）与 `sessionSynchronizer`（落盘索引）是两个关注点，别混在一个类里。
- 归一化消息 id 必须唯一：一个原生事件拆多个 part 时要加判别后缀；分页契约 `limit: null` = 全量、`limit: 0` = 空页。
