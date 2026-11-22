# agy ACP 运行时（提问+权限双桥接）

> 状态：步骤 1–5 与生命周期修复已实现，浏览器端到端验收和切换默认值待做
> 基准：v2.23.0 / 2026-11-15
> 分支：`feat/antigravity-acp-runtime`

## 目标

antigravity 运行时从 print 单回合 spawn（`-p --input-format stream-json --output-format stream-json`）切换为 `agy acp` 持久会话：

1. 模型 `ask_question` 弹**可回答的问题卡**，答案当轮生效（现状：引擎无头自答空行，用户永远答不了）。
2. `session/request_permission` 接**权限卡**，批准/拒绝真实生效。
3. 后台任务完成从"注册表猜"升级为"引擎事件推"，补 [[agy后台任务清单卡]] 记录的失联三缺（通知/查询/卡片）中的通知与结果。
4. 获得 session resume、`systemPrompt.append` 注入、模式映射等后续能力基础。

## 现场与证据（2026-11-22 探针，agy 1.5.14）

- **提问闭环**：`ask_question` → `tool_call`（in_progress→pending）+ 问题文本回显 → `session/prompt` 返回 `end_turn` 挂起；下一条 `session/prompt`（答案文本）→ 引擎立即 `tool_call_update: completed` 并带真答案继续。不走 ACP v2 `elicitation/create`，是自家"回合停→下一条 prompt 即答案"约定（同 claude plan 模式形状）。
- **权限桥**：`toolPermission: request-review` 下 `session/request_permission` 到达，带完整 `toolCall`（toolCallId/name/args/kind/title/locations/content diff 预览）+ `options:[{optionId:"allow",kind:"allow_once"},{optionId:"deny",kind:"reject_once"}]`；回 `{outcome:{outcome:"selected_once",optionId:"allow"}}`→执行落盘；回 `{outcome:{outcome:"cancel"}}`→工具 `failed`、回合 `end_turn` 优雅收场。write_file 与 run_command（含 IsDaemon 后台）都走此通道。
- **后台任务**：`run_command IsDaemon:true` 回合结束后引擎主动推 `tool_call_update: completed` + 完成消息（退出码/输出/brain `.system_generated/tasks/task-N.log` 日志路径）。
- **子代理**：父级一张 `invoke_subagent` 卡，内部步骤不上 ACP 流、只落 brain 转录——与 print 同构，agent-tail 零改动。
- **abort**：`session/cancel` 通知 → prompt 立即 resolve `stopReason:"cancelled"`，会话继续可用。
- **转录**：ACP 会话照常落 `conversations/*.db` + `brain/<id>/` + `annotations/*.pbtxt`（与 print 同构）。
- **能力**：initialize 返回 `loadSession`/resume/close/load/list、promptCapabilities（image/embeddedContext）、`_meta.antigravity{tier, systemPrompt.append}`；session/new 带模型列表 + modes（default/accept-edits/auto/plan…）+ 斜杠命令。
- **关键坑**：①用户 settings.json `"toolPermission":"always-proceed"` 吞掉全部权限请求（探针实锤零请求全放行）；合法值 `always-proceed`/`request-review`/`strict`（二进制 strings）。②`--app-data-dir` 只收相对 GeminiDir 的路径。③临时 HOME 报 `Authentication required`（凭据绑定真实钥匙串上下文）。

## 方案

### 进程与会话模型

- 每个 cloudcli antigravity 应用会话 = 一个常驻 `agy acp` 子进程（进程内一个 ACP session）。不启用 `--process-per-session`（一进程一会话已是默认形态）。
- 空闲回收：无在途回合、无 pending 权限/提问、无后台任务 → 空闲 10 分钟（可配）kill。有任何工作永不回收。
- 崩溃兜底：进程意外退出时在途回合按现有进程退出语义收场；下次 send 重新 spawn 并 `session/load` 恢复（失败时结束本轮，保留原会话映射）。

### 数据目录（原生共享 + 权限钉档；2026-11-22 起弃用托管目录）

- ~~spawn 带 `--app-data-dir cloudcli-acp`（独立托管目录）~~ → **改为与终端共用用户自有 `~/.gemini/antigravity-cli/`**：会话原件、summaries 索引、brain 转录全在原生根——终端 `agy --conversation` 可续聊 ACP 会话，summaries 单库（同步器无需双根扫描，侧栏收录/自动改名天然工作）。
- **前提**：settings.json 的 `toolPermission` 不得为 `always-proceed`（唯一会吞掉全部权限请求的取值）。spawn 前读-改-写用户自有 settings.json：仅当该键为 `always-proceed` 时改写为 `request-review`（其余取值含缺省不动，用户自留空间），`trustedWorkspaces` 并入会话 cwd（列表上限裁剪最旧）；其余键（模型显示名、statusLine 等）原样保留，原子替换写盘、串行队列防并发撕裂。
- 实测语义（探针）：`request-review` + `set_mode auto` → 编辑与命令零请求（auto 模式自动批准一切，CLI `--mode auto` 用法不受钉档影响）；无 `toolPermission` 键 → 引擎默认询问，权限卡正常。
- **遗留**：`~/.gemini/cloudcli-acp/` 为 2026-11-22 前创建的 ACP 会话（只读保留：转录双根读侧覆盖，历史可看可续聊降级为提示）。

### 协议客户端（步骤 1 本体）

`antigravity-acp-client.ts`（模块私有）：ndjson JSON-RPC over stdio。id 自增 + pending 响应表 + 超时；服务端请求按方法分发到注册 handler，**未注册的回 `{}`**（探针实测引擎可接受，防挂死）；服务端通知透传订阅者。客户端不做任何 antigravity 业务语义。

### 运行时映射（步骤 2+）

- `session/update` → NormalizedMessage：`agent_thought_chunk`→思考块、`agent_message_chunk`→文本、`tool_call`/`tool_call_update`→工具卡（`ask_question` 特判问题卡）、`session_info_update`→标题。
- **两种挂起状态机**（关键差异）：
  - 权限挂起：prompt 在途（未 resolve）+ `request_permission` 未决 → 权限卡 → resolve 后回合继续。
  - 提问挂起：prompt 已 `end_turn` + ask_question 卡 pending → 问题卡；**用户的下一条 send 就是答案**（引擎语义如此，即便内容是新指令）；turn 2 先行 `tool_call_update: completed`，随后正常直播文本。
- **回合外消息**：后台任务完成事件在无活动回合时到达 → 作为系统/助手行入时间线尾部并广播（print 模式进程已死收不到，此为新行为）。
- **早到的 end_turn 与排空（真机回归修复，2026-11-22）**：ACP 的 `session/prompt` 不像 print 那样等子 agent 汇报完才返回——模型可以先回 end_turn，子 agent（及其后的父汇总）继续在流上推帧。回合循环在 end_turn 时若仍有未绑定的 spawn 调用或已登记未汇报的 agent，就进入**排空**：保持泵与 writer 不结算，等汇报结算把登记簿清空（exit/取消随时打断），再走正常收尾；期间帧照常直播、会话保持 processing。这也让 agent 卡按真实汇报结算，而不是在早到的结算里被判 stopped。
- **提问回显抑制（真机回归修复）**：引擎在 ask_question 卡旁边会把问题原文作为 agent_message_chunk 再回显一遍（只存在于直播流，不进转录——刷新后不重复）。翻译器在卡挂起期间丢弃消息 chunk，运行时在发出答案 prompt 时解除。
- 后台任务注册表：从 `backgroundKeyAliases` 进程别名映射改为 ACP 事件驱动；通知链路复用 antigravity-background-work。
- abort：杀进程 → `session/cancel`，5 秒未结束时关连接并停止进程。
- 看门狗：pending 权限/提问不算静默。卡片 30 分钟到期后主动结算。
- 模式映射：`default`→default、`acceptEdits`→accept-edits、`plan`→plan（`session/set_mode`）、`bypassPermissions`→spawn 带 `--dangerously-skip-permissions`。模型选择通道待探（session/new 参数或 set_model），失败回落引擎默认。

### 生命周期与权限切换修复

- 按应用会话独占一次回合。启动前登记这次获取，创建子进程后立即纳入取消和停机。回合释放只影响它自己获取的进程。
- 进程复用要求工作目录与启动权限一致。启动权限变更时，先停止旧进程并确认退出，再加载原引擎会话。agy 1.5.14 对缺失的会话 ID 也可能应答成功，加载前先确认托管 ACP 根里的原生会话文件存在。agy 在另一个数据根加载旧 ID 时也可能应答成功，随后 prompt 失败。目前旧 print 会话需用 print 续聊，跨根迁移数据需单独设计。旧进程还有后台任务时保留进程，本轮发送失败并提示稍后重试。恢复失败、权限模式不可用或设置失败时，本轮不发送 prompt。每轮重申审批模式。显式模式优先于旧的免审批布尔设置。
- 握手、加载、新建、模式和模型设置各有 30 秒超时，超时的连接退出。prompt 仍由输出看门狗监测，等待卡片期间暂停；卡片自己定时到期并结算。提前回答的问题在引擎返回 end_turn 后使用已经收到的决定。
- 按进程跟踪 agy 后台命令的开始与终态，前台回合内外都处理同一事件。后台命令完成后才开始计空闲时间，进程退出时清理状态。
- 校验 stdio 消息结构，坏帧留在协议边界处理。保留每个文本分片的原始空白。托管 settings 串行更新、以原子替换写盘，文件不存在时初始化，其余读取错误上报。托管设置和 agy 启动参数共用同一个数据根。
- 验证覆盖权限双向切换、恢复失败、后台跨回合及权限切换冲突、启动超时和取消、卡片过期与提前作答、坏帧、流式空白及并发配置更新。完成 provider/WS 回归和独立审查后进入真机验收。

### 灰度开关

ACP 默认**开启**；`CLOUDCLI_ANTIGRAVITY_ACP=0` 回退 print 老路径（保留为未动回退，删除另行拍板）；空闲回收 `CLOUDCLI_ANTIGRAVITY_ACP_IDLE_MINUTES`（默认 10）。

### 通知预览（2026-11-22）

回合结束推送原先只有"provider: completed"——预览捕获在 writer 侧只认 `kind:'text'` 行，而 zcode 是唯一发 text 行的引擎，antigravity 的回复全走 `stream_delta`，预览从未生效。运行时泵现在累积回复文本并按会话 id 写入通知预览注册表（回显抑制期间不计入），排空期的后续播报也覆盖。

## 分步实施

1. ✅ 设计文档 + acp 客户端原语模块（假 stdio 服务器桩单测，9 用例）。
2. ✅ 持久会话管理器（spawn/复用/空闲回收/abort=cancel/崩溃兜底/看门狗）+ ACP 步骤翻译器 + runtime 内核替换；子代理卡从父 transcript 的 spawn 回执轮询绑定（ACP 帧不带 conversationId）。
2.5 ✅ 后台任务事件化：会话级 between-turns 路由把 run 外帧（IsDaemon 命令完成）经 `context.publishSessionEvent` 发到会话频道。
3. ✅ 权限桥（approve/deny、撤帧、TTL 僵尸清扫；agy 无限等答，无重发竞态）。
4. ✅ 提问桥（挂起循环：allow→答案 prompt 同 run 续跑；deny/过期→回合完成收场；abort→唤醒并按 aborted 结算）。
5. ✅ 模式映射（set_mode；bypass 走 spawn flag）+ 模型映射（family-tier 拼 id 对 availableModels 匹配，尽力而为）+ data-root 双根（转录/brain/token 持久化覆盖 `~/.gemini/cloudcli-acp`）+ providers.md 能力条目。
6. ⬜ 端到端真机验收（worktree dev 实例，端口 3021）；灰度开关翻转。

**独立审查修复（2026-11-22）**：①ACP spawn 复用 `buildAntigravitySubprocessEnv()`（pm2 残留 SSH 变量会把 agy 切到文件 token store 破坏认证）；②prompt 被引擎以 JSON-RPC error 拒绝时按失败结算（原先吞成 success，用户消息静默丢失）；③未知 stopReason 一律失败结算；④提问挂起 race 加入引擎死亡；⑤pending 卡期间看门狗解除武装（cardHold 计数），不再与 30m 卡 TTL 双触发竞态；⑥`closeAntigravityAcpSessions` 接入 server/index 停机序列；⑦卡片帧（显示/撤回）双通道发布（writer + publishSessionEvent）；⑧deny/过期提问改发合成"未回答，自行判断"prompt 让引擎自行收尾（避免下一条用户消息被引擎当答案吃掉）；⑨路由按 client 实体重装（respawn 时序洞）；注释与文档环境变量名修正。

**已知残留（验收段处理）**：~~①引擎会话列表的 summaries db 仍在用户自有根~~ → **已修（2026-11-22，真机发现自动改名失效的显性回归）**：ACP 会话的 conversation_summaries.db 落在托管目录，同步器只盯用户自有根，自动改名/会话收录失灵——骨架加 `getSecondaryDatabasePaths()`（默认空，单根 provider 零影响），watcher 支持 `extraRootPaths`，antigravity 子类声明 ACP 根；顺带关掉"引擎侧 ACP 会话不进侧栏"。其余残留：②`session/set_model` 的实际生效未验证（RPC 被接受 ≠ 生效）。③plan 模式自动批准回归在 ACP 下是否消失待复验。④问答卡的答案不进引擎转录的 ask 工具结果（引擎自己折叠，刷新后以转录为准）。

## 验证

- 单测：acp 客户端桩（握手/请求响应/服务端请求分发/断线）；权限/提问状态机；后台任务事件映射。
- 契约：探针场景（提问两轮闭环、权限 approve/deny、后台完成推送、session/cancel）固化为测试——agy 升级改协议时立刻发现。
- 回归：providers 套件全绿（707 基线）+ 现有 antigravity 行为对齐（subagent tail、流中断降级、token usage）。
- 真机：生产实例人工验收（提问当轮生效、权限卡、后台完成通知、长会话 resume、plan 模式复验——自动批准回归是否随权限桥消失）。
- L3 独立审查照流程走。

## 风险与边界

- acp 是非主流入口，engine 升级可能动协议细节 → 探针固化为契约回归兜底。
- 权限/提问等待期间进程长挂：看门狗豁免，否则误杀。
- 双路径并行期维护成本 → 灰度开关 + 验收后收敛（另行拍板）。
- agy 自身行为（如子代理文件写入是否自动批准、计划模式 stop hook）可能与 print 模式有差异 → 真机验收项逐条过。

## 关系文档

- [[agy后台任务清单卡]]：纯前端渲染 manage_task list（读转录），与本设计的事件化互补，不冲突。
- [[antigravity-background-tasks-lifecycle]]：print 模式后台任务定案（失联三缺），本设计的事件化是其后续治理。
