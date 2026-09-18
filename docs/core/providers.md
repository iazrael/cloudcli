# Provider 架构与接入指南

> 基准：2.3.3 / 2026-09-18
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
| `runtime` | 拉起/中止引擎执行 | `run(command, options, writer, context)`、`abort(sessionId)`；可选 `permissions`（权限批准网关）→ `providerRuntimeService` |
| `models` | 模型目录 | `getSupportedModels()`（预置目录）、`getCurrentActiveModel()`（只读兜底）→ `providerModelsService` |
| `auth` | 安装/登录状态 | `getStatus()`（"未安装/未登录"是数据不是异常）；可选 `getQuota()`（配额）→ `providerAuthService` |
| `mcp` | 引擎原生 MCP 配置读写 | `McpProvider` 基类（scope/transport 校验）→ `providerMcpService` |
| `skills` | 技能发现/写入 | `SkillsProvider` 基类（SKILL.md 扫描）→ `providerSkillsService` |
| `sessions` | 事件归一化 + 历史 | `normalizeMessage`、`fetchHistory`；可选 `getTokenUsage` / `resolveEditAnchor`（编辑锚点）/ `rewindSession`（codex 分支式回退）/ `cleanupSession` → `sessionsService` |
| `sessionSynchronizer` | 落盘索引 | `getSessionWatchTarget()`（声明 watch 根）、`synchronize()`、`synchronizeFile()` → `sessionSynchronizerService` + `sessions-watcher.service.ts` |
| `fork?`（可选） | 会话分支复制 | `forkSession()`；**缺省即"该引擎无 fork 能力"** |

**可选成员就是能力开关**，这是整个框架的核心设计。

## 能力矩阵：推导而非手写

`server/modules/providers/services/provider-capabilities.service.ts`：

- `deriveCapabilities` 从注册表里的切面**推导**能力——`runtime.permissions` 存在 ⇒ `supportsPermissionRequests`；`sessions.resolveEditAnchor` 存在 ⇒ `supportsMessageEditing`；`fork` 存在 ⇒ `supportsSessionForking`；`sessions.getTokenUsage` 存在 ⇒ `supportsTokenUsage`。
- 静态部分（权限模式列表、图片/文件/中止/effort）来自 `provider-capabilities.catalog.ts` 的 `PROVIDER_CATALOG`。
- `provider-capabilities.test.ts` 把推导结果钉在显式基线上：切面增删会以"评审过的测试差异"呈现，而不是静默改能力。
- **前端零 provider 分支**：composer/设置页完全按 `GET /api/providers/capabilities` 渲染。首屏与请求失败时的回退镜像在 `src/shared/providerCatalogFallback.ts`（`PROVIDER_FALLBACK_CATALOG`），由跨树 parity 测试（`server/modules/providers/tests/provider-catalog-parity.test.ts`）钉住与后端目录一致；**其 key 顺序就是全应用的引擎规范顺序**。

## 共享基础设施（写新引擎前先看）

都在 `server/modules/providers/shared/`：

- `engine-path/cli-engine-path.ts`：引擎二进制定位工厂——env 覆盖 → PATH → 平台安装路径，带 TTL 正/负缓存。配套 `installation/cli-installation-probe.ts` 探测原语。zcode / antigravity 有各自薄封装（`list/zcode/zcode-engine-path.ts` 等）。
- `sessions/sqlite-session-synchronizer.provider.ts`：`SqliteSessionSynchronizer<Row>` 模板方法基类——watch 过滤、高水位增量、只读短连接、pending-app-session 绑定。zcode / antigravity / opencode 共用；claude / codex 解析 JSONL，cursor 读 store.db，各自实现。
- `mcp/mcp.provider.ts`、`skills/skills.provider.ts`：MCP 与技能的校验/扫描基类。
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
本来就按这个方法分发配额请求。

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

**MCP 配置格式的能力同样由切面声明**：`IProviderMcp.capabilities` 给出可用 scope、transport、
是否支持工作目录、是否支持环境变量间接（`env_vars` / `bearer_token_env_var` / `env_http_headers`，
目前只有 codex 有；普通 `env` 与 HTTP `headers` 六家都写，不需要开关）。
矩阵原样透出，服务器表单据此渲染。

前端为首屏与请求失败保留一份镜像 `src/shared/mcpCapabilitiesFallback.ts`，
由 `provider-catalog-parity.test.ts` 跨树钉住——这正是它此前缺的：
旧的三张散表没有守卫，Cursor 明明会写 `cwd`，表里却写着不支持，工作目录字段因此对 Cursor 用户一直不可见。

## 差异吃在适配器里，不漏给前端

引擎的私有包装与字段命名**必须在各自适配器里归一化掉**，共用的渲染与展示代码不得认识任何一家。
两个已收回的例子，都曾以「前端按引擎名分支」的形式存在并腐坏：

- **会话标题**：各家同步器把自己推导出的名字写进 `custom_name`，会话行一律以 `summary` 下发。
  前端一度为 Cursor 单独读一个 `name` 字段——后端从未下发过它，于是 Cursor 会话长期显示占位名。
- **Codex 的 `<proposed_plan>` 信封**：由 `readCodexProposedPlan` 拆成与 Claude 相同的
  `ExitPlanMode` 计划卡。实时、会话读取、持久化三条归一化路径**都要做**；
  此前持久化那条漏了，共用的消息渲染组件便长出一段只给 codex 用的剥标签逻辑。

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
外加乐观回显的簿记字段 `replacesAnchorId` / `replacesAfterRowCount`。

**工具卡同样要两路描述一致。** Codex 的实时与历史 `toolId` 来自两个 id 空间
（SDK item id ／ rollout `call_id`），精确匹配结构性地不可能，只能靠「工具名 + 完整入参」指纹。
因此入参必须逐字相同：命令文本统一成 shell 包装里的那条命令（`readCodexCommandLine`），
多命令脚本在历史侧**按命令拆行**，与实时每条命令一个 item 的粒度对齐，
也与本适配器子代理路径的既有做法一致。

**历史只能包含转录行。** `complete`、`stream_delta`、`stream_end`、`session_created`
描述的是"一次运行正在进行"，历史里没有运行，也就不该出现这些 kind。
zcode 曾为每个持久化 step 产出一条 `complete`——真实会话里占全部行数的 35%，
一行都渲染不出来，却照样计入分页、计入每一次遍历转录的扫描、计入客户端发送时记录的行数。
`history-kind-standard.test.ts` 对四家逐一把关。

**子代理的线程 id 也是适配器的责任。** Codex 用 `agent_thread_id` 指向子代理自己的同级 rollout；
该 id 曾只从 `sub_agent_activity` 顶层事件读取，而当前版本把它放在 `item_completed` 的
`SubAgentActivity` 项里，于是 id 永远拿不到、子代理卡片一律空时间线。
两种形状现在都路由到同一个处理函数（`applySubagentActivity`）——
引擎换事件形状是常态，认一种就等于埋一颗定时炸弹。

**跨路行身份是适配器的责任，不是前端的猜测活。** `providerRowKey` 一旦缺席，
前端只能退回按挂钟定位回合、按文本相似度判重——重复回复正是这么来的。
六家引擎目前的实现情况：

| 引擎 | 行身份 | 依据 |
| --- | --- | --- |
| codex | 有 | 两路同一个响应项 id（实时 SDK `item.id`／rollout `payload.id`） |
| antigravity | 有 | `assistant-step:<step_index>` |
| claude | **无** | 历史行有 `uuid`，实时 SDK 事件不暴露同一个 id；宁可没有也不能伪造 |
| zcode | **无** | 落盘行身份是 `(message_id, part_id)`，而实时文本事件只带 `messageId`——一条 message 可以有多个 part，用 message 级 id 会是 1:N |
| cursor / opencode | **未盘点** | 见 `docs/design/跨路行身份.md` |

没有行身份的引擎**不要伪造一个**。用序号、行号或本端生成值顶替，会让对账从"知道自己不知道"
变成"自信地答错"；没有 key 时前端至少还会走 [chat.md](./chat.md) 里那套因果回退。

zcode 要具备行身份，需要**引擎侧**在文本流事件上带出 part id——它的 `tool_result`
事件已经带了 `resultPartId`，文本事件没有对应字段。这是引擎的改动，不是适配器能补的。

Codex 的两路在 `normalizeHistoryEntry` 汇合——实时 `agent_message` 带 `message.role`，
在 `normalizeMessage` 开头就被转到这里，所以 key 在汇合点统一取，
而不是在看似对应的实时分支里各取一次。

**跨路文本身份要求**：`NormalizedMessage.providerRowKey` 是 provider 在同一会话内为一条最终可渲染行生成的稳定身份，只在 live 与历史两路都能从原生数据复建时设置；它不承担消息展示 id、WebSocket `seq`、provider 排序 `sequence` 或编辑锚点的职责。前端只在 `(provider, sessionId, providerRowKey)` 唯一对应时认定两路属于同一行，再按 provider 明确给出的正文完整度选择展示来源；正文不参与身份猜测。同 key 多候选或缺 key 且无法证明同一用户回合时保留双方。Antigravity 只为实时 `agent_response` 与历史纯正文 `PLANNER_RESPONSE` 设置 `assistant-step:<step_index>`，不推广到用户、工具或 `GENERIC` 行。

**工具 id 同源要求**：live 与历史两路对同一工具调用必须产出**同一个 toolId**（理想：都读引擎原生 call id，如 zcode 的 `callID` 恰等于 live `toolCallId`）。做不到的引擎（codex/antigravity 现状——三命名空间无桥、锚点不同），影子卡去重只能靠前端指纹层 `src/modules/chat/utils/toolIdentity.ts` 兜底，新引擎接入时先回答这个问题。

**Antigravity 转录读取**：`antigravity-transcript.provider.ts` 是 compact `transcript.jsonl` 与 `transcript_full.jsonl` 的唯一读取入口。它按原生 `step_index` 以 full 覆盖同一步、保留 compact 尚未被 full 追上的尾部，并跳过损坏 JSONL 尾行；历史正文同时带明确的完整度事实。历史专属 thinking 不进入可见时间线，因为它没有可与实时流对应的稳定身份。

**会话层级要求**：会话列表只索引顶层、可由用户继续对话的 provider 会话。Antigravity 使用其摘要库的 `parent_conversation_id` 与 `nesting_depth` 识别子 agent；子 agent 不写入活动列表，已被旧版本索引的行会软归档，原始 transcript 与本地元数据保留。缺少这两个字段的旧版 Antigravity 摘要库按顶层兼容读取。

### ⚠ 已知坑

- **常驻引擎的 stderr**：app-server 形态的引擎（zcode/codex）stderr 常驻嘈杂，别逐行转发日志——supervisor/客户端保留尾部环形缓冲（zcode 4000 字符），崩溃/crash-loop/session-lost 的错误全部附带尾部；engine 崩溃的真实死因只在 stderr 里。

- **全仓散落的引擎清单**：除上述契约点外，历史上有过 6 处硬编码 6 家列表/能力表的地方（MCP scopes、公开 API 文档 `public/api-docs.html` 的 `PROVIDER_ORDER` 等）。新增引擎后 `grep -rn "antigravity" src server public --include='*.ts' --include='*.tsx' --include='*.html' -l` 扫一遍清单类常量，防止新引擎被隐藏。
- `sessions`（运行时事件归一化/历史分页）与 `sessionSynchronizer`（落盘索引）是两个关注点，别混在一个类里。
- 归一化消息 id 必须唯一：一个原生事件拆多个 part 时要加判别后缀；分页契约 `limit: null` = 全量、`limit: 0` = 空页。
