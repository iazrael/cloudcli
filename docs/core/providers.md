# Provider 架构与接入指南

> 基准：2.13.0 / 2026-10-24
> **核心文档**：改动 `server/modules/providers/**` 或 `server/shared/{types,interfaces}.ts` 时**必须同步更新本文**。
> 普通 bug 修复不动架构的不需要更新（提交时走 `--no-verify`，见 `AGENTS.md`）。
> 引用一律给"文件路径 + 符号名"，不用行号。

相关文档：[overview.md](./overview.md)（全景）· [chat.md](./chat.md)（运行时事件怎么流向前端）

## 现状：六家引擎

`claude | codex | cursor | opencode | zcode | antigravity`，联合类型定义在 `shared/protocol/chatEvents.ts` 的 `LLMProvider`（前后端共用同一份，见下文「线上契约」）。注册表 `server/modules/providers/provider.registry.ts` 用 `Record<LLMProvider, IProvider>` 硬编码六家实例——漏一家直接编译报错。

每家一个目录：`server/modules/providers/list/<name>/`，由 `<name>.provider.ts` 组装各切面。claude / cursor 的 runtime 是遗留 `.js` 适配器；opencode、codex、zcode / antigravity 是 TS（含协议客户端、运行生命周期等更多切面文件）。

## Codex 异步任务结果续开（Task Continuation）

Codex app-server（0.159.2+）在协议层面支持脱离父回合的工具结果续开。当长耗时后台任务在宿主完成且原聊天处于空闲时，`codex-runtime.provider.ts` 在新连接上执行 `thread/resume`，并在 `turn/start` 中直接传入：
```json
{
  "threadId": "<thread_id>",
  "input": [],
  "toolOutput": {
    "name": "cloudcli_task_result",
    "output": "<JSON 任务完成报告>"
  }
}
```
引擎以工具结果为契机唤醒新回合汇报。`codex-thread-items.ts` 只把名称为 `cloudcli_task_result` 的孤立 `FunctionCallOutput` / `functionCallOutput` 归一化为纯说明性质的 `status_note`，不生成缺失前置调用的残缺工具卡，也不伪造用户提问。其他工具的输出不会被误认成异步任务通知。其他引擎（Claude 等）保持其原生的输入流保持机制，第一版异步任务外部接续由 Codex 首发支持。

**常驻会话（resident app-server）**：`codex-resident-*.ts` 把一个 app-server 子进程留在会话上跨回合复用，而不是每回合重新 `thread/start`/`thread/resume`。回合之间进程进入 idle 常驻，`run()` 的下一回合直接在同一个 `threadId` 上 `turn/start`；引擎自发的回合（后台 agent 结束后的汇报）经 `getSessionActivity` / `hasSessionWork` 暴露给网关，由 `adoptExternalRun` 认领成一个正常 run。进程交接（`codex-resident-session`）负责把原生 thread 在进程间传递，`turn/start` 的队列状态（`queued` / `reporting`）经 `chatEvents` 的队列帧到达页面，composer 用 `backgroundWorkQueuesInput` 决定"立即发"还是"排队"。同一份常驻设施也供会话标题使用：回合成功后开一个隔离的 ephemeral thread 生成标题，失败不影响主会话。

## IProvider 七切面

契约在 `server/shared/interfaces.ts`，基类在 `server/modules/providers/shared/base/abstract.provider.ts`：

| 切面 | 职责 | 关键成员 / 消费服务 |
| --- | --- | --- |
| `runtime` | 拉起/中止引擎执行 | `run(command, options, writer, context)`、`abort(sessionId)`；可选 `compact(options, writer, context)`（按需压缩，前端 `/compact` 的唯一开关）；可选 `permissions`（权限批准网关）、`backgroundTasks`（后台活跃任务列表）→ `providerRuntimeService` |
| `models` | 模型目录 | `getSupportedModels()`（引擎目录或预置目录）、`getCurrentActiveModel()`（只读兜底）→ `providerModelsService` |
| `auth` | 安装/登录状态 | `getStatus()`（"未安装/未登录"是数据不是异常）；可选 `getQuota()`（配额）→ `providerAuthService` |
| `mcp` | 引擎原生 MCP 配置读写 | `McpProvider` 基类（scope/transport 校验）→ `providerMcpService` |
| `skills` | 技能发现/写入 | `SkillsProvider` 基类（SKILL.md 扫描）→ `providerSkillsService` |
| `sessions` | 事件归一化 + 历史 | `normalizeMessage`、`fetchHistory`；可选 `getTokenUsage` / `resolveEditAnchor`（编辑锚点）/ `rewindSession`（codex 分支式回退）/ `cleanupSession` → `sessionsService` |
| `sessionSynchronizer` | 落盘索引 | `getSessionWatchTarget()`（声明 watch 根）、`synchronize()`、`synchronizeFile()` → `sessionSynchronizerService` + `sessions-watcher.service.ts` |
| `fork?`（可选） | 会话分支复制 | `forkSession()`；**缺省即"该引擎无 fork 能力"** |

**可选成员就是能力开关**，这是整个框架的核心设计。

**模型目录特例（opencode）**：`list/opencode/opencode-models.provider.ts` 以 `opencode models` CLI 的账号级清单为准（后台服务在时约百毫秒返回；首次调用需冷启动该服务，故超时放宽到 15s），id 为 `<providerID>/<modelID>`，再叠加 OpenCode 自己缓存于数据库 `kv` 的 models.dev 条目补全推理档位与说明；CLI 缺失/失败/空答案时回退 `OPENCODE_PREDEFINED_MODELS` 预置表并按本机已连接 provider 过滤，且打上 `FALLBACK: true`（`ProviderModelsDefinition` 通用字段，`providerModelsService` 合并时透传），告诉前端这只是替身目录、需稍后重拉。会话模型值同样以目录的 `<providerID>/<modelID>` 为准，`providerModelsService` 负责把会话行上丢失前缀的裸 model id 按目录后缀唯一匹配还原。此前的「读 `~/.cache/opencode/models.json` 实时目录」叠加层随本轮 client-mode 迁移一并移除（见「OpenCode 服务客户端」）。

**模型目录特例（zcode）**：新版本 ZCode 把用户自建 provider/模型从 `~/.zcode/v2/config.json` 迁到了 `~/.zcode/v2/provider_config.json` + 引擎自带目录（`zcode-provider-config.ts` 定位 runtime 刷新副本或安装目录 `resources/config/provider/zcode-builtin.json`），因此 `getSupportedModels()` 以引擎为准：调一次 `session/create` 取响应里的 `settings.model.available`（即引擎已合并用户 provider 后的完整目录，用完即 `session/close`），失败才回退磁盘解析。会话模型值同样是 `<providerID>/<modelID>`，并把每个模型的 `reasoning.defaultLevel` 记进 `zcode-models.provider.ts` 的 `engineReasoningDefaults`；`setModel` 的 schema 是严格校验，reasoning 档位必须放 `model.options.reasoningLevel`（旧的 `model.variant` 会被拒），缺省取上面记下的 defaultLevel，否则引擎报 “Reasoning level is required”。

## 能力矩阵：推导而非手写

`server/modules/providers/services/provider-capabilities.service.ts`：

- `deriveCapabilities` 从注册表里的切面**推导**能力——`runtime.permissions` 存在 ⇒ `supportsPermissionRequests`；`sessions.resolveEditAnchor` 存在 ⇒ `supportsMessageEditing`；`fork` 存在 ⇒ `supportsSessionForking`；`sessions.getTokenUsage` 存在 ⇒ `supportsTokenUsage`；`runtime.compact` 存在 ⇒ `supportsCompaction`。
- 静态部分（权限模式列表、图片/文件/中止/effort、编辑是否回滚文件 `editRevertsFiles`、引擎是否自带会话内调度 `supportsNativeScheduling`、会话忙时新消息能走多远 `inputWhileBusy`）来自 `provider-capabilities.catalog.ts` 的 `PROVIDER_CATALOG`。
- **`inputWhileBusy: 'queue' | 'background' | 'always'`**（类型 `ProviderInputWhileBusy`）：会话忙时新消息能否直达引擎而不杀掉在跑的工作。`background`（claude）——进程由 runtime 常驻（见下文「常驻与复用」），回合进行中或后台任务在跑时 composer 仍然排队，但排到的那个回合开在同一个进程里，不会杀掉后台任务；`queue`（其余，含本轮迁移后的 opencode）——发送会重启进程杀掉工作，composer 一律排队；`always` 目前无引擎使用。`always` 必须配 runtime 可选切面 `injectInput`，`provider-capabilities.test.ts` 钉住两者同在同缺；claude 改用常驻后不再实现 `injectInput`，网关取不到切面就退回"开一个正常 run"。
- `provider-capabilities.test.ts` 把推导结果钉在显式基线上：切面增删会以"评审过的测试差异"呈现，而不是静默改能力。
- **`supportsNativeScheduling` 只是提示位，不参与启停**：CloudCLI 的循环定时任务（`scheduled-jobs`）对所有引擎可用；该位为 true（目前仅 claude 的 CronCreate/ScheduleWakeup）时，任务表单与 composer 重复入口提示"引擎自身也有会话内定时、冲突回合会被跳过"，行为不变。
- **前端零 provider 分支**：composer/设置页完全按 `GET /api/providers/capabilities` 渲染。首屏与请求失败时的回退镜像在 `src/shared/providerCatalogFallback.ts`（`PROVIDER_FALLBACK_CATALOG`），由跨树 parity 测试（`server/modules/providers/tests/provider-catalog-parity.test.ts`）钉住与后端目录一致；**其 key 顺序就是全应用的引擎规范顺序**。
- **账号配额（`auth.getQuota`）现状**：antigravity（`agy` CLI）、codex（app-server JSON-RPC）、zcode（BigModel / Z.AI HTTP）、opencode（OpenCode Go 官方 `GET /zen/go/v1/usage`，`list/opencode/opencode-quota.provider.ts`；key 优先读 v2 `opencode.db` 的 `credential` 表，v1 `auth.json` 仅作回退，避免轮换后的旧 key 遮蔽新 key；Zen 按量账号无公开端点，返回 null 即不渲染卡片）。前端按 `supportsQuota` 能力位渲染配额卡片，不再维护同名名单。

## 上下文占用与按需压缩

`ProviderTokenUsageResult`（`server/shared/types.ts`）的语义是"**当前上下文占用**"而不是"会话累计花费"：`used` 是这一刻窗口里承载的量，`total` 是窗口大小；需要累计的引擎（codex/opencode）把会话累计放在 `cumulative`，claude 自报的百分比放在 `percentage`。前端 composer 徽章显示 `used`（有 `total` 时追加 `xx%`），`/cost` 弹窗画占用条并单列累计行。

引擎只在回合结束时才报用量的引擎（zcode），runtime 会在**回合进行中**补发 `token_budget`：监听器每次收到一个 step 收尾的信号（zcode 是 `tool_result`）就去引擎库读一次最新占用，距上次发送不足 1.5s 或读数没变则不发；帧的 payload 与 `/token-usage` 端点同形，长工具轮的徽章因此不必等到 `complete` 才动。opencode 的回合中预算来自 `session.step.ended` 事件自带的该 step `tokens`（同一 1.5s/去重节流；窗口在回合开始时按所选模型解析一次），回合结束再用与 `/token-usage` 相同的 `opencode.db` 读取器补一帧权威读数（含窗口），保证实时与重开一致。

| 引擎 | `used` 来源 | `total` 来源 | 备注 |
| --- | --- | --- | --- |
| claude | 最新一条主线程 assistant 的 `input + cache_read + cache_creation + output`；每回合结束再用 SDK `Query.getContextUsage({detail:'summary'})` 覆盖（带 `percentage`） | **会话维度持久化的 SDK 真值**（见下）＞`CONTEXT_WINDOW` ＞ 模型启发式（先看会话行的 `model`（用户选的变体，带 `[1m]`），再看转录里的模型 id；命中 `[1m]` 定 1M，否则 200k），单一 resolver `resolveClaudeContextWindow`（`services/claude-usage.ts`） | SDK 会执行输入流里的 `/compact`，无需额外协议 |
| codex | rollout `token_count.info.last_token_usage`（live 用 `turn.completed.usage`） | `model_context_window` | 旧的 `total_token_usage` 只作 `cumulative` |
| opencode | 最新一条 assistant 消息自己的 `tokens`（prompt = input + cache read/write，输出 = output + reasoning；v1/v2 双布局同读） | 模型缓存 `~/.cache/opencode/models.json` 的 `limit.context`（`resolveOpenCodeContextWindow`，按 mtime+size 记忆化） | 会话行 `tokens_*` 五列（`GET /api/session/:id` 同值）只是会话累计花费，单列为 `cumulative`；压缩摘要跳过（v2.0.32 写成 `compaction` 消息行，旧版是 `summary: true` 的 assistant 行）→ `compacted` + 摘要字节数；数据库早于 token 列时不支持（`unsupported: true`） |
| antigravity | live usageRecord 的 total | 1M（硬编码） | 同值持久化到 brain `token_usage.json` |
| zcode | 最新 step 的 `tokens.total`；旧行没有该字段时取 `input + output + reasoning`（持久化 prompt 已含 cache read，不能再加） | 引擎目录的 `contextWindow`（`resolveZCodeModelContextWindow`；用户自加 provider 只有引擎目录里有），缺失时回退 `v2/config.json` 的 `limit.context` | 全转录求和只作 `cumulative`（`list/zcode/zcode-context-usage.ts`）；压缩摘要行（`summary` 对象）跳过 → `compacted` + `summaryBytes` |
| cursor | 无 `getTokenUsage` 切面 | — | `supportsTokenUsage: false` |

**claude 的上下文窗口为什么必须持久化**：转录里每条 assistant 记的是*解析后*的模型 id（`claude-opus-5`），永远不会出现 `claude-opus-5[1m]` 这种窗口变体标记，所以任何"读转录猜窗口"的启发式都分不出 1M 会话和 200k 会话。真值只有 SDK 在 query 存活期间知道（`getContextUsage()` 的 `rawMaxTokens`，其 `maxTokens` 与之同值，`percentage` 就是 `round(used/total*100)`）。因此 runtime 一读到该值就写进 `sessions.context_window`（`services/claude-context-window.ts`，键是 app session id，找不到行就静默跳过，下一回合再写）。探测点有两个：流的开头（已恢复会话此刻上下文已经装配好，不必等首个 token）和首条 assistant 回复（全新会话最早有东西可测的时刻），每轮最多两次 control request（`createContextWindowCapture` 负责计次与去重），回合结束时再读一次，顺手把 badge 刷成 SDK 的精确读数。不只在回合结束写，是因为跑到一半就断的 run 根本没有 `result`——用户中断、CLI 崩溃、服务端在回合中间重启都算——那一行会永远留白，而 `model` 是 `default` 的会话没有 `[1m]` 标签可回退，此后一直显示 200k。三条发布 token budget 的路径——`/token-usage`、每一页历史、回合中的每个 assistant 帧——都先读它再落到 `CONTEXT_WINDOW` 和启发式。这条优先级里 SDK 真值排在 `CONTEXT_WINDOW` **之前**，否则实时帧（从不读 env）和重开会话后的读数又会互相矛盾。历史页不额外带 `percentage`：它等价于前端已有的 `used/total`，存下来只会在转录继续前进后变成陈旧值。还没在本应用跑过的会话退而看 `sessions.model`：那是用户在模型选择器里选的变体（`opus[1m]`），比转录里被解析掉的 id 多一个 `[1m]` 标签，所以配置成 1M 的会话重开即显 1M、不必先跑一轮。

历史页走 `sessionHistoryCache`，而缓存项的有效性原本只看转录文件的 path+mtime+size——因为结果曾经完全由文件推导。窗口持久化打破了这个前提（`tokenUsage.total` 多依赖了一个 DB 列，而该列是回合进行中和回合结束时异步写的），所以 `session.context_window` 也进了缓存判据：否则回合后的首次历史读取可能赶在写入之前，把一个回退默认值的 `total` 凝固在缓存里，往后每次翻页都把 badge 打回旧窗口，和实时帧来回跳。

`/token-usage` 与历史页共用 `summarizeClaudeTokenUsage` 这一个读取器（同样跳过 sidechain 与全零的 `<synthetic>` 行），两者只在取行范围上不同：历史页按 `sessionId` 过滤转录行，端点读整份文件。

**`/compact` 的引擎实现**（能力开关是 runtime 可选切面 `compact`）：claude 把 `/compact` 当输入流的一条用户消息（SDK 按 local slash command 执行，实测可通过 `Query.getContextUsage()` 复核）；codex 走 app-server JSON-RPC `thread/resume`（必须带出 turns，摘要器要读被替换的对话）+ `thread/compact/start`，并且**要等压缩回合完成通知**（`item/completed` 的 `contextCompaction` 或 `turn/completed`）才能杀掉子进程，否则摘要只存在于内存里（`list/codex/codex-app-server.client.ts`）。zcode 走 app-server 的 `session/compact`：引擎把它当一轮后台 `/compact` 提示跑（`turn.started` → `session.updated` 的压缩时间线 → `turn.completed`），所以 runtime 复用 run 的同一套流程（订阅 → 监听 → settle → 一个 `complete`），只是不设模型/权限模式（引擎用会话当前模型）；请求参数只发 `sessionId`（`expectedRevision` 可选，仅当传入且过期时才报 -32009，而应用不跟踪 revision），引擎回 `state: already_running` 时按错误上报而不是悄悄挂靠到别人的压缩上。antigravity 实测**不支持**：agy print 模式把 `/compact` 当普通 prompt 透传（"not a built-in slash command"），且 CLI 无压缩子命令。cursor 不实现，菜单按能力矩阵隐藏。opencode（v2.0.32）走服务的 `POST /api/session/:id/compact`：它只把一条合成 `compaction` 消息**持久地排进会话队列**（响应即受理，可带 `delivery`，默认 `steer`），引擎随后把它当一轮执行，摘要经 `session.compaction.delta` 流出、以 `session.compaction.ended`/`failed` 收束、再以常规 `session.execution.*` 终态结束——所以 runtime 照旧复用 run 的管线（登记 → 等终态 → 一个 `complete`），不拿 POST 的响应当结果，也不改模型/权限（引擎用会话当前模型）。**压缩失败只对"用户主动要压缩"的 run 算失败**：`session.compaction.failed` 带上原因后，registry 只把它结算成 `purpose: 'compact'` 那个 run 的失败；普通回合里引擎自己触发的自动压缩失败不打断该回合。v2 的 `compaction` 消息行由历史读取器渲染成"压缩行 + 摘要行"（`isCompactSummary`，前端折叠展示），context-usage 读取器同样按这行（或旧版写进 assistant 消息的 `summary: true` 标记）给出 `compacted` + `summaryBytes`。探针：`scripts/probe/opencode-compact-probe.mjs`（`--fail` 复现失败形态）。

压缩**刚结束的那一刻占用不可知**（zcode 引擎自己压缩时把摘要写成带 `summary` 对象的 user 行，读数直接跳过），所以 `ProviderTokenUsageResult` 用 `compacted: true` + `used: 0` 表达"已重置、token 数未知"（前端 `readTokenBudgetFromUsage` 与实时 `token_budget` 帧都判这个标记，不会继续挂着旧数字）。zcode 的摘要大小经 `zcode-context-usage.ts` 作为 `summaryBytes` 随 `compacted` 一起给出，前端用它显示"压缩摘要 · 9.4KB"直到下一个回合拿到真实占用；`/cost` 经 `commands.routes.ts` 透传同样的标记与字节数，把误导性的 0 行换成摘要大小行。

## Claude 会话进程：常驻与复用（`claude-runtime.provider.ts`）

claude 每个回合默认起一个 CLI 进程，回合结束即退出；18MB 级别的会话每回合重新 resume 要几十秒。运行期因此让进程**常驻**：`run()` 从网关收到 `residentBetweenTurns: true`（`chat-websocket.service.ts` 的 `buildRuntimeOptions` 统一附加）时，一个回合正常结束且没有未完成的工作后，进程进入 idle 常驻——默认 10 分钟、最多 4 个，最旧的先关，两者都可用环境变量覆盖。启动时读取的配置（`CLAUDE.md`、settings、下一层 skills、commands、agents、rules、MCP、plugins）变了，或 transcript 显示另一个进程续过这段会话，下一回合就换新进程：绝不用旧配置悄悄跑。空转进程不算会话工作，归档/删除/关机时一并关闭；它自己死掉不会失败任何回合。

**后台工作：进程保活，回合续在同一个 stdin 上。** SDK 的输入流一旦结束就关 stdin，CLI 按 print wind-down 杀掉所有后台 shell/agent（`Bash(run_in_background)`、子代理、Cron 等）。所以起了后台工作的进程要一直持有：静默上限 2 小时（同时作为 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 传给 CLI），任何消息和每一次续回合都会重置。下一个用户回合直接写进这条 stdin，同一个进程里开新回合，后台任务不受影响；启动期固定的东西（目录、工具权限、MCP、ultracode）、编辑消息、离开启动期的 plan 模式、打开 bypass、以及从 `--effort` 启动回到默认 effort 仍然换新进程。回合交接时模型、权限模式、effort 在 10 秒超时内切换；CLI 正跑在某个回合里时，新回合等那个回合的 `result`；尚未写入的交接回合可以被 stop 单独撤回。

**会话生命周期切面**：`getSessionActivity`（引擎是在排队还是在本回合里）、`hasSessionWork`（回合在跑 / 引擎自发上报 / agent 还在跑 → 不许归档或删除）、`closeSessionAdmission` / `releaseSession` / `openSessionAdmission`（先关准入、再看状态、再释放常驻进程，中间不会插进新 run）。

**后台任务与任务条**：`createBackgroundWorkTracker()` 记录 `task_started`（带 `tool_use_id`）到 `task_notification` / 终态 `task_updated`，供运行列表（`listBackgroundWork`）与单任务停止（`stopBackgroundTask` → SDK `stopTask`）使用；`extractBackgroundTasks` 从工具调用提取 composer 任务条所需的条目，runtime 以 `background_tasks` 帧广播（含 `chat_subscribed` 回放），每回合结束与新 run 接手时都会重发，所以清空不依赖某一条丢失的帧。spawn 时声明 `perTaskStopAffordance: true`，CLI 的 interrupt 因此只停回合、放过后台 agent/workflow；`abort` 只 `interrupt`，会话还有在跟任务时不关 stdin。

**上下文窗口（本 fork 补充）**：transcript 只记录解析后的模型 id（`claude-opus-5`），读不出 `[1m]` 变体；SDK 只在 query 活着时知道真实窗口。runtime 因此在流头部与首批 assistant 回复各探测一次 `getContextUsage()`（最多两次，共享 in-flight 读），把结果经 `recordClaudeSessionContextWindow` 写进 `sessions.context_window`，并让该 run 之后发出的 `token_budget` 帧用这个窗口而不是启动参数（`createContextWindowCapture`，`services/claude-context-window.ts`）。历史页与 `/token-usage` 走同一个解析器（`resolveClaudeContextWindow`：记录值 → `CONTEXT_WINDOW` → 带 `[1m]` 的模型 id），所以实时百分比与刷新后一致。

**编辑第一条 prompt = 换一个引擎会话（重指向）**：`chat.edit-send` 替换首条用户消息时带 `resumeFromScratch`，`mapCliOptionsToSDK` 因此不传 `resume`，SDK 开启**新的 provider session** 并写新的 `<projectDir>/<newId>.jsonl`。runtime 在流里发现 `session_id` 与行上的旧 id 不同，就用 `writer.setSessionId(newId, { transcriptPath })` 把「这是替换，不是首次映射」交给网关；`ChatRunRegistry.recordProviderSessionId` 据此调 `repointSessionToProviderSession(..., { supersedePrevious: true })`，在同一事务里把 app 行的 `provider_session_id` 与 `jsonl_path` 一起换到新转录、删掉 watcher 抢先建的同 id 行，并把旧 id 记进 `superseded_provider_sessions`（Claude 同步器据此跳过旧转录，整库重扫也不会把它带回来）。**这里不能用 `assignProviderSessionId`**：它故意保留旧 `jsonl_path`，历史会继续读旧文件。Codex 的 `rewindSession` 分支同理，只是它自己记录 superseded。

## 共享基础设施（写新引擎前先看）


都在 `server/modules/providers/shared/`：

- `engine-path/cli-engine-path.ts`：引擎二进制定位工厂——env 覆盖 → PATH → 平台安装路径，带 TTL 正/负缓存。配套 `installation/cli-installation-probe.ts` 探测原语。zcode / antigravity 有各自薄封装（`list/zcode/zcode-engine-path.ts` 等）。
- `sessions/sqlite-session-synchronizer.provider.ts`：`SqliteSessionSynchronizer<Row>` 模板方法基类——watch 过滤、高水位增量、只读短连接、pending-app-session 绑定。zcode / antigravity / opencode 共用；claude / codex 解析 JSONL，cursor 读 store.db，各自实现。
- `sessions/workspace-admission.ts`：会话入库前的工作区准入闸门，见下节。
- `mcp/mcp.provider.ts`、`skills/skills.provider.ts`：MCP 与技能的校验/扫描基类；受管技能写入目标由各引擎覆盖 `getGlobalSkillSource()` 决定（claude → `~/.claude/skills`；codex / cursor / zcode / antigravity → `~/.agents/skills`；opencode → `~/.config/opencode/skills`），不覆盖即拒绝写入。

Codex 的模型目录由 `codex-models.provider.ts` 通过 `codex-app-server.client.ts` 的连接读取（`model/list` 全分页、过滤隐藏模型、按 id 去重；查询用对话运行时同一份内置 `@openai/codex`）。成功目录缓存五分钟、并发共用一次加载；失败保留最近成功目录、十秒后允许重试；首次加载失败/空目录/格式异常会报错，前端走模型加载失败的重试入口。自定义模型由 `provider-models.service.ts` 合并：同 ID 记录只显示一项（保留用户名称并继承引擎推理强度），删除仅存在于自定义记录中的型号才切回默认型号。

- 引擎专属协议设施（在各自目录内）：zcode 的协议客户端三件套 `zcode-protocol.client.ts`（单例 facade）= `zcode-codec.ts`（编解码）+ `zcode-engine-supervisor.ts`（子进程守护/崩溃熔断）+ `zcode-request-router.ts`（请求关联）；codex 的 `codex-app-server.client.ts`（JSON-RPC，**codex 的唯一对话传输**：`thread/start` / `thread/resume` / `turn/start` / `turn/interrupt` / `thread/fork`，这些请求产生的 item 通知流，以及反向的审批请求）。zcode supervisor 拉起 `app-server` 时先剥离环境继承的 `ZCODE_*_PROVIDER_CONFIG_FILE`（ZCode App 会话残留指向 App 自己的运行期文件），再注入 `zcode-provider-config.ts` 解析出的 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` / `ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`——桌面端本来会传这三个变量，裸 spawn 缺了它引擎定位不到 provider 目录，`session/create` 会一直挂到超时（模型一个都用不了）。Codex 运行时开启 `features.defer_mailbox_preemption = true` 延缓 mailbox 抢占，避免子代理并发消息打断父会话推理；并在 `onNotification` 强制过滤非主会话 `threadId`，防止子代理事件流串线。
- zcode 工具结果：实时事件的 `tool.updated`（旧名 `tool_call_scheduled`）在 `kind=result` 时直接携带 `result.content` 与 `result.success`，`kind=error` 携带 `error`。`ZCodeLiveEventNormalizer` 将它们与 `model_streaming` 的 `tool_result/tool_error` 共用一条转换路径，按原生 `toolCallId` 把输出或错误送回已有工具卡；空字符串是有效的成功输出，只有 resultPartId 而无正文的事件不生成残缺卡。实时显示不依赖历史拉取或 SQLite 落库时序。
- zcode 附件通道：上传描述符在 runtime 内映射为 `session/send` 的原生 `attachments` 项（`{kind, filename, mimeType, sizeBytes, localPath}`，localPath 必须绝对；引擎静默丢弃无法映射的形状），不走其余五家的 `<files_input>`/`<images_input>` 文本标签。
- zcode 发送链路（引擎 0.16.9）：引擎对 `session/create` / `session/resume` / `session/send` 做严格 schema 校验，多一个键就报 -32602（`runtimeModel` 正是被拒的那个），所以请求只带 schema 声明的字段——resume 只发 `sessionId`，create 只发 workspace 描述符；模型选择经 `session/setModel` 设在会话上（reasoning 档位必须放 `model.options.reasoningLevel`，缺省取引擎目录里的 `defaultLevel`，恢复会话时强制重选以清掉 "model unavailable"（-32031）警告）。会话工作区必须由 `workspacePath` / `cwd` 显式给出：runtime 不再回退 `process.cwd()`，否则部署目录会被同步器登记成项目。引擎所需的 personal provider registry 由服务端从 `cli/config.json` 物化为 `~/.zcode/cli/cloudcli-provider-config.json` 并随 spawn env 注入。
- zcode 账号套餐：模型目录按白名单提取 `GLM-5.3` 和 `GLM-5.3-Flash`。有唯一且可解密的个人套餐 API Key 时，个人分组的模型值使用 ZCode 原生 `account:bigmodel-individual-coding-plan/模型名`，`resolveZCodeModelRef` 把旧会话保存的 `bigmodel-coding-plan` / `builtin:bigmodel-coding-plan` 引用也解析到该账号；同名自定义 provider 保持自身路由，没有该凭证时保留本地 provider 路径。有可解密的 `zcodejwttoken` 时体验套餐以 `account:bigmodel-start-plan/GLM-5.3-Flash` 列出。引擎以 app-server 启动时对账号类 provider 默认 fail-closed（`entitled: false`）；`ZCodeProtocolClient` 在每个引擎进程的首个业务请求前（崩溃重启后重做）以 `provider/updateAccountConfig`（`buildZCodeAccountSyncPayload`，可同时授权两类账号）授予 entitlement，运行期经 `interaction/requestProviderRuntimeHeaders` 回调按 provider 分别以解密后的 JWT / 个人套餐 Key 应答鉴权。多份个人套餐 Key 无法确定账号时，不自动选择其中一份。
- 运行期统一分发：`services/provider-runtime.service.ts`（`providerRuntimeService`：`run` / `abort` / `compact` / `injectInput` / `getRunner` / `resolveToolApproval` / `getPendingApprovalsForSession` / `backgroundWorkQueuesInput` / `canInterruptBackgroundWork`）。常驻引擎的会话生命周期切面（`getSessionActivity` / `hasSessionWork` / `closeSessionAdmission` / `releaseSession` / `openSessionAdmission`）由各 runtime 自行实现，网关只通过 `IProviderRuntime` 的可选成员调用。

## OpenCode 服务客户端（v2）

opencode 的对话不走一次性子进程，而是连一个 cloudcli 自养的常驻服务（官方 `run --standalone` 同款配方，针对 v2.0.31 实测钉契约）。各构件在 `list/opencode/` 下：

- `opencode-service.ts`：监管器，懒启动 `opencode serve --stdio --port 0`，随机密码经 `OPENCODE_PASSWORD` 传入、Basic 认证（账号固定 `opencode`）；就绪行是 stdout 上的 `{"url":…}`；**stdin 就是所有权租约**——cloudcli 退出服务随之退场，崩溃退避重启。v1 引擎在聊天时报错（历史读取的双格式兼容不受影响）。
- `opencode-api.client.ts`：会话创建（`location.directory` 锚定项目目录）、模型/角色/权限规则切换、prompt、压缩请求（`POST /api/session/:id/compact`，v2.0.32）、interrupt、权限与表单答复，以及两个挂起列表读取（`GET /api/session/:id/form`、`/permission`，供丢事件后的兜底重读）。模型引用是对象 `{providerID, id, variant}`（variant 即推理力度，`provider/model#effort` 解析）。
- `opencode-event-stream.ts`：一条全局 `GET /api/event` SSE，按 `data.sessionID` 分发；每次（重）连都重新解析端点，跟随重启换端口的服务；断线退避重连并广播重连事件。服务端的契约是 **volatile**（消费太慢会被踢、断流期间事件丢失），所以每次断流都按失败段记一条告警（干净断开也算，过去是静默重连），重连后 runtime 既对账 run 终态、也重读挂起询问。
- `opencode-event-translator.ts`：会话事件 → 时间线帧（text.delta→stream_delta、reasoning.delta→同 id thinking、tool.*→tool_use/tool_result、execution.*→运行终态）。assistant 正文帧另带 `providerRowKey`（`opencode-part:${消息id}_text_${序号}`，序号取事件自带的正文段序号；与历史行同一推导，见身份表），否则流式气泡没有可被持久化行认领的身份。事件词表钉在测试夹具里，未知事件类型忽略，防版本漂移。
- `opencode-interaction-bridge.ts`：`permission.asked` → 权限卡（Allow/记住/拒绝 → `once`/`always`/`reject`）；`form.created`（question 表单）→ `AskUserQuestion` 卡（服务的 `multiselect` 翻译成面板的 `multiSelect`；答复按问题文本映射回 `q0/q1` 字段键，多选按 `", "` 拆分——选项文案含该序列是已知边界）。跳过/拒绝=取消表单并附留言，模型继续而非整步作废。**兜底重读**：`adoptPending(sessionId, {forms, permissions})` 把服务仍持有、而 bridge 没有卡片的询问补发成同样的卡片——事件流断流期间丢掉的 `permission.asked`/`form.created` 只存在于服务内存，没有它模型会一直等一张看不到的卡；按 requestId 幂等，由 runtime 在事件流重连后（每个活跃 run）与 `chat.subscribe`（处理中的会话）调用。**卡片上溯**：事件来自子代理会话时经 `opencode-subagent-index.ts` 归到父会话的卡片流与 `pendingPermissions` 回放（同一条 run 的 writer），答复仍发往子会话 id（`POST /api/session/<child>/permission|form/...`），卡片的 `sessionId` 是父 app 会话。
- `opencode-session-settings.ts`：权限模式映射——`plan`→只读 plan 角色+全部变更类 ask 规则；`acceptEdits`→仅 shell ask；`bypassPermissions`→无规则（引擎默认全放行）；`default`→全部变更类 ask。**引擎默认角色本身全放行，权限卡完全靠这些 ask 规则出现**；已应用的切换按会话缓存，避免每次发消息重复下发（切 plan 会附带一条系统提醒）。
- `opencode-run-registry.ts`：活跃运行登记、事件分发、首结算生效；断线重连后按 `GET /api/session/:id` 的 `outcome`/`time.idle` 对账，补上错过的终态，避免会话卡在"处理中"。`OpenCodeTokenBudgetTracker` 消费 `session.step.ended` 的 per-step `tokens` 发回合中 `token_budget` 帧（1.5s 节流 + 值去重）；tracker 挂在各自的 run 上（`run.budgetTracker`），并发会话不共享窗口与节流状态；该接口的 `tokens` 是会话累计花费，不能当窗口占用用，权威占用读数走 `opencode.db` 的 `opencode-context-usage.ts`。登记时声明 run 的 `purpose`（`chat` / `compact`）：`session.compaction.failed` 只结算主动压缩的那个 run，普通回合里的自动压缩失败不影响该回合。**子会话事件的归属**：`opencode-subagent-index.ts` 从 `session.created`（子会话自带 `parentID`/`agent`/`title`，title 即启动时的 `description`）和父会话工具块的 `metadata.sessionID` 两条信号把子会话链回父 run 与启动调用；registry 据此把子会话帧盖 `parentToolUseId` 后写进父 run 的 writer（启动调用未定位前先入队，不裸奔到顶层），子会话自己的 step 占用与终态不结算父 run，只有属性是父 run 的 `tool_use` 行在时间线里聚成子代理卡。**后台子会话的存活提示**：registry 同时记录每个 app 会话仍在跑的子会话，发 `status(background_tasks)` 帧（`backgroundWorkPending` + `backgroundTasks`）让 composer 的紫色"后台工作"药丸在父回合 `complete` 后继续显示，子会话终态再发空列表清掉；runtime 暴露 `backgroundTasks.list/isPending`、`listBackgroundWork` 与 `stopBackgroundTask`，因此 `chat_subscribed` 回放、`/sessions/running` 轮询和完成 run 的保留判断都能看到这份清单；任务条条目的 `id` 取启动调用（`toolUseId`，未定位前退回子会话 id），与转录卡片的锚点、`chat.stop-task` 按 toolUseId 的匹配是同一身份，所以条纹一行同时能定位卡片和单独停止该任务。父回合结束后 writer 与 bridge 会一直保留到最后一个子会话结束：30 分钟到点先向子会话行复核（`GET /api/session/:id` 的 `outcome`/`time.idle`，判据同断线对账的 `idleAt >= startedAt`）——已 settle 的按该 outcome 发一条 `task_status` 让卡片立即收尾并清掉跟踪，仍在跑的续期保留（所以后台子代理里迟到的 `permission.asked`/`form.created` 仍能弹出并答复），读不到行或服务不在的按原兜底丢弃；每次清掉跟踪（包括 opencode 服务退出时的 `settleAll`）都会广播 `background_tasks` 空列表，免得页面挂着过期的"运行中"；事件流断线重连的对账也会复核后台子会话（判据同上，读不到行的留给定时复核）。总持有上限 6 小时兜住"会话行永远停在跑到一半"（引擎已死）的情况。
- **引擎自发续跑的收养**：后台子代理完成时，引擎会给已空闲的会话投一条合成消息并**自行续跑**——cloudcli 侧没有任何客户端提示词、也没有 run 登记，这段执行的帧、权限/提问卡与终态原本全部丢失（`question` 卡连实时都到不了 UI，刷新也无可回放；表单答复只能由拥有它的服务实例回答）。现在事件流上出现「只可能发生在执行中」的事件（`ADOPTABLE_EVENT_TYPES`：`session.execution.started`、`session.*.delta/called/success/failed`、`form.created`、`permission.asked`、`session.inbox.delivered` 等）且该会话没有活跃 run 时，runtime 经组合根注入的 adopter（`server/index.ts` 调 `chatRunRegistry.adoptExternalRun`，与 `setRetentionGuard` 同一接线方式）开一个 `connection: null` 的网关 run（与定时消息同一条无附着通道）：帧照常翻译转发、bridge 挂载后交互卡进入既有卡片与 `pendingPermissions` 回放、`session.execution.*` 终态照常发 `complete`（seq/5 分钟保留/RunOutcome 全链路不变），`chat.subscribe` 记下的空闲订阅者会被挂上该 run 的 writer（开着的页面无需刷新即可看到续跑与卡片）。会话映射解不出的引擎侧会话（子代理、CLI 直开）不被收养；`session.inbox.enqueued` 等执行之外也会出现的事件故意不做触发，避免给空闲会话挂上永远等不到终态的幽灵 run。表单本身是服务实例内存态（`GET /api/session/:id/form` 可列出、按 `q0…` 字段键答复；契约探针 `scripts/probe/opencode-form-probe.mjs`），实例更换后引擎把悬空工具自动置为 interrupted，会话照常继续。这份内存态也是漏事件的唯一补救：断流期间丢掉的 ask 由 bridge 的兜底重读补发（见上文 bridge 一条）。
- 附件：data-URI 文件块随 prompt 下发（模型真正看到内容），同时保留 `<images_input>`/`<files_input>` 路径标签供历史回读还原。
- 历史、会话索引、模型目录、登录检测不变：仍读 `opencode.db`（双格式）与 CLI 探测；v2 的 `compaction` 消息行（v2.0.32 把压缩写在会话旁而非 assistant 消息里）渲染成"压缩行 + 摘要行"（`isCompactSummary`）。子代理历史：父转录的 `subagent`/`task` 工具块按 `state.metadata.sessionID` 找到子会话行（`parent_id`），把子会话自身的消息翻成 `subagentTools` 时间线（assistant 正文/reasoning/工具，工具结果优先读 v2 的 `state.content`），agent 名取自子会话 `agent`、状态以子会话最近一次 settle 为准——`idle_outcome`/`time_idle` 只在会话行没有比 idle 标记更新的写入时可信（被再次唤醒、仍在中途的子会话还戴着上一轮的 idle 标记，直读会把工作中的子代理误报成已完成），后台启动的父块 `metadata.status` 永远是 running；子会话不进侧边栏索引（同步器照旧剪枝）。契约探针：`scripts/probe/opencode-subagent-probe.mjs`。
- `opencode-context-usage.ts`：上下文占用读取器（bridge 的 `step.ended` 令牌经 `OpenCodeTokenBudgetTracker` 变成实时 `token_budget` 帧；`/token-usage`、历史页与回合结束帧共用同一读数），语义与 v1/v2 布局差异见上方用量表。
- **相对旧实现的缺口（待移植）**：消息编辑（`revert` 锚点/回滚）、会话 fork、空交付自动重试、回合中途插话（`injectInput`）。子代理卡片与审批桥上溯父会话已补（历史见上，实时见 registry / bridge 两条）。配额卡片已移植（`opencode-quota.provider.ts`）；`/compact` 已随服务客户端恢复（见上方「`/compact` 的引擎实现」）。


## 会话索引准入：哪些工作区能变成项目

引擎各自记录会话的工作目录，同步器据此建项目行。判定统一走 `shared/sessions/workspace-admission.ts` 的 `admitsWorkspacePath`——六家引擎的同步器（SQLite 骨架一处 + claude / codex / cursor 各一处）都必须调用它，**新引擎接入时这是第 2 步的一部分**。三条拒绝规则：

1. **包管理器与运行时内部**：路径含 `node_modules` 或 pnpm 的 `.pnpm` 段（`server/shared/utils.ts` 的 `isInfrastructureWorkspacePath`）。
2. **已消失且从未登记过的目录**：引擎在事后被系统回收的目录里跑过一次，就会长期把该目录记为工作区，这类行每次重扫都会复活成同一批空项目。
3. **系统临时目录之内（含根本身）**：`$TMPDIR`、`/tmp` 这类是运行期暂存区，引擎驱动的沙箱跑批（任务评审、测试夹具）会把工作目录记在这里，收进侧边栏只会是噪音（`server/shared/utils.ts` 的 `isSystemTemporaryWorkspacePath`；macOS 上每个根同时按 `/var/folders/...` 与 `/private/var/folders/...` 两种写法比对，因为引擎记录的是符号链接还原后的写法）。被挡的只是 CloudCLI 自己的项目行，会话本体与引擎侧记录不受影响；聊天里打开临时目录下的文件走 `file:` 链接白名单，与本项目准入无关。

"已登记过"这一半对第 2 条同样不能省：外置盘或网络卷没挂载时目录暂时不存在，但项目行已在，会话照常更新。准入失败只阻止**新建**项目，永不删除既有数据；已经入库的临时目录项目行由项目列表的同一判断过滤隐藏（`projects-with-sessions-fetch.service.ts`），数据保留在库中。

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
| cursor | 未盘点 | 本 fork 不投入，只保证可编译、测试通过 |
| opencode | 两路 id 不同源：实时行 id=引擎工具调用 id / `${消息id}_text_${序号}`、`${消息id}_reasoning_${序号}`，历史行 id=`${消息id}_${块序号}`；**assistant 正文**由 `providerRowKey: opencode-part:${消息id}_text_${序号}` 对账；工具行靠 toolId 指纹层配对 | 服务客户端化（2026-10-17，见「OpenCode 服务客户端」）后实时与历史是同一引擎记录的两个投影：`session.text.*` 事件自带 `assistantMessageID` 与**正文段序号**（按正文块计数，reasoning 另计），落盘的 `content` 数组按同一顺序排块，故两路可各自复建同一推导。序号缺失（事件无 `assistantMessageID`）时 key 不与任何持久化行相等，正文仍留在屏幕上，不会误删 |

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

  stream-json 模式下，`agy` 自己等子代理和后台 `run_command` 全部结束才发出 `result`：后台命令的 `tool` step 一直保持 `ACTIVE` 直到命令退出，子代理回报只是一条不带正文的 `system_message` step。所以 `result` 就是整轮的终点，runtime 收到它后清空子代理卡片、关 stdin、发 `complete`。子代理卡片取自 `invoke_subagent` 的 DONE step（`step_type: "subagent"`，`subagent_info.subagents[].conversation_id`），通过 `backgroundTasks.list(sessionId)` 切面供输入框展示。进程的每种结束方式（`result`、abort、崩溃、watchdog）都先清空卡片并广播空列表，再发 `complete`。

  **绝不能给 agy 传 `--print-timeout`**：它限制的是整轮时长，到点时 agy 会在子代理仍在运行时提前吐出 `status: SUCCESS` 的 `result`，runtime 一关 stdin，agy 就把子代理连同工作一起掐掉，前端还显示完成。agy 的默认值 0 表示等这一轮跑完。防卡死由服务端负责：stdin 由我们持有，`result` 一旦走不到（CLI 崩溃、stdout 被截断、result 行被 agy 穿插的纯文本搞坏导致 JSON 解析失败），进程和这次 run 会无限期挂住，所以 runtime 自带一个**以 stdout 活动续期的看门狗**（`idleTimeout` / `CLOUDCLI_ANTIGRAVITY_IDLE_TIMEOUT`，默认 30 分钟），到期 SIGTERM 并按失败收尾。主 agent 等子代理期间主流完全静默，所以一个连续 30 分钟没有任何输出的子代理也会被看门狗结束。另有一个例外：agy 的 interrupted-stream result 不是终态（它会自行注入续跑提示），在它上面关 stdin 或发 `complete` 都会让前端以为这轮结束、甚至掐死异步工作，所以只有真正的 result 才收尾。

  接新的 CLI 引擎时先问两句：它的非交互模式在主循环 idle 之后如何处置未完成的后台任务；以及谁为「进程永远不退」兜底。

- **会话内的权限模式归引擎所有**：app-server 形态的引擎把权限模式持久化在会话上（zcode 写 `session.permission`），而模型会在一轮里自行切进计划模式。因此设置里的权限模式是**变更时下发**，不是每轮重申：`zcode-runtime.provider.ts` 记住每个引擎会话最后下发的模式，值没变就不发 `session/setMode`。每轮重申会在两轮之间把计划模式抹掉，模型下一次调 `ExitPlanMode` 直接拿到「can only be used while plan mode is active」，审批卡片根本不会出现，而模型可以把这句报错读成「已获批准」继续动手。进程内缓存意味着服务重启后的第一条消息仍会下发一次——这是为了让重启期间改过的设置必定生效而留的取舍。

- **常驻引擎的 stderr**：app-server 形态的引擎（zcode/codex）stderr 常驻嘈杂，别逐行转发日志——supervisor/客户端保留尾部环形缓冲（zcode 4000 字符），崩溃/crash-loop/session-lost 的错误全部附带尾部；engine 崩溃的真实死因只在 stderr 里。

- **Codex 多代理下的事件流隔离与 mailbox 抢占**：
  app-server 单连接在派生子代理时，子代理通知（含 `turn/completed`、`item/completed`）会混入父会话所在的同一事件流，但带自己的 `threadId`。若 `codex-runtime.provider.ts` 的 `onNotification` 未校验通知 `threadId`，子代理的 `turn/completed` 会提前触发主 turn 的 `settle()`，导致会话被误关中断。此外，子代理投递 mailbox 邮件时，引擎默认机制（`preempt_for_mailbox_mail`）会在 reasoning/commentary 边界抢占 sampling 导致中断。CloudCLI 在 `threadSettings.config` 中显式开启 `features.defer_mailbox_preemption = true` 将抢占推迟到安全边界，并在 runtime 强制丢弃非当前会话的通知，彻底实现多代理会话解耦。

- **全仓散落的引擎清单**：除上述契约点外，历史上有过 6 处硬编码 6 家列表/能力表的地方（MCP scopes、公开 API 文档 `public/api-docs.html` 的 `PROVIDER_ORDER` 等）。新增引擎后 `grep -rn "antigravity" src server public --include='*.ts' --include='*.tsx' --include='*.html' -l` 扫一遍清单类常量，防止新引擎被隐藏。
- `sessions`（运行时事件归一化/历史分页）与 `sessionSynchronizer`（落盘索引）是两个关注点，别混在一个类里。
- 归一化消息 id 必须唯一：一个原生事件拆多个 part 时要加判别后缀；分页契约 `limit: null` = 全量、`limit: 0` = 空页。

## 模型库：推理档位与"只用我的模型"

`effortLevels` 是每家引擎能透传的推理档位（弱→强，空数组当且仅当 `supportsEffort` 为 false），也是自定义模型条目可声明的档位集合——`provider-capabilities.test.ts` 钉住"预定义模型声明过的档位都在集合内"。目录本身仍由各引擎提供（`codex-models.provider.ts` 读 app-server、`opencode-models.provider.ts` 发现已连接 provider 的模型、其余静态表），`provider-models.service.ts` 把用户自定义模型合并上去：同 id 只显示一项（保留自定义名称并继承引擎推理强度），删除仅存在于自定义记录里的型号才切回默认。

"只用我的模型"（`setCustomModelsOnly`，存 `provider_models` 配置键）把内置型号从所有选择器里隐藏，并让第一份自定义模型成为默认值；在添加任何自定义模型之前内置型号照旧列出。`resolveResumeModel` 还会把会话行里丢过前缀的裸模型 id（`deepseek-v4.1-flash`）按目录唯一后缀还原成 `<provider>/<model>`，否则 `--model` 会被引擎当成 provider id 读而直接失败。
