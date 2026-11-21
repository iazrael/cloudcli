# agy ACP 运行时（提问+权限双桥接）

> 状态：设计已批准（2026-11-22），实施中——步骤 1
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
- 崩溃兜底：进程意外退出时在途回合按现有进程退出语义收场；下次 send 重新 spawn 并 `session/load` 恢复（失败降级新 session，如实标注）。

### 托管数据目录（权限钉档）

- spawn 带 `--app-data-dir cloudcli-acp`（相对 GeminiDir → `~/.gemini/cloudcli-acp/`）。cloudcli 独立 `settings.json`：`{ "toolPermission": "request-review" }` + `trustedWorkspaces`（spawn 前并入会话 cwd，列表上限裁剪最旧）。
- 用户自有 `~/.gemini/antigravity-cli/` 完全不动（IDE/print 会话不受影响）。
- **转录分裂代价**：ACP 会话转录落在 `cloudcli-acp/` 而非 `antigravity-cli/`。`antigravity-data-root.ts` 是集中点，扩为双根扫描（brain 按 conversation id 无冲突）。认证/MCP 配置/配额/model 列表均不受 app-data-dir 影响（钥匙串、`~/.gemini/config/mcp_config.json`、API）。

### 协议客户端（步骤 1 本体）

`antigravity-acp-client.ts`（模块私有）：ndjson JSON-RPC over stdio。id 自增 + pending 响应表 + 超时；服务端请求按方法分发到注册 handler，**未注册的回 `{}`**（探针实测引擎可接受，防挂死）；服务端通知透传订阅者。客户端不做任何 antigravity 业务语义。

### 运行时映射（步骤 2+）

- `session/update` → NormalizedMessage：`agent_thought_chunk`→思考块、`agent_message_chunk`→文本、`tool_call`/`tool_call_update`→工具卡（`ask_question` 特判问题卡）、`session_info_update`→标题。
- **两种挂起状态机**（关键差异）：
  - 权限挂起：prompt 在途（未 resolve）+ `request_permission` 未决 → 权限卡 → resolve 后回合继续。
  - 提问挂起：prompt 已 `end_turn` + ask_question 卡 pending → 问题卡；**用户的下一条 send 就是答案**（引擎语义如此，即便内容是新指令）；turn 2 先行 `tool_call_update: completed`，随后正常直播文本。
- **回合外消息**：后台任务完成事件在无活动回合时到达 → 作为系统/助手行入时间线尾部并广播（print 模式进程已死收不到，此为新行为）。
- 后台任务注册表：从 `backgroundKeyAliases` 进程别名映射改为 ACP 事件驱动；通知链路复用 antigravity-background-work。
- abort：杀进程 → `session/cancel`；进程兜底 kill 保留。
- 看门狗：pending 权限/提问不算静默，不杀进程。
- 模式映射：`default`→default、`acceptEdits`→accept-edits、`plan`→plan（`session/set_mode`）、`bypassPermissions`→spawn 带 `--dangerously-skip-permissions`。模型选择通道待探（session/new 参数或 set_model），失败回落引擎默认。

### 灰度开关

`ANTIGRAVITY_ACP_MODE`（env，经 ecosystem 配置）切换新旧路径，默认 **print 老路径**；真机验收后翻转默认，print 路径删除另行拍板。

## 分步实施

1. 设计文档 + acp 客户端原语模块（假 stdio 服务器桩单测）。
2. 持久会话管理器：spawn/复用/空闲回收/abort（cancel）/崩溃兜底/看门狗；runtime 内核替换；行为对齐（流式文本/工具卡/思考块/标题/agent tail）。
2.5 后台任务事件化（跨回合完成事件 → 通知 + 卡片；`supportsInputAcceptance`/`isPending`/`canInterrupt` 契约重对齐）。
3. 权限桥（approve/deny 全路径、撤帧、TTL）。
4. 提问桥（挂起状态机、答案回合标记、连环提问）。
5. 模式/模型映射 + 转录联动（data-root 双根）+ 能力矩阵文档同步。
6. 端到端真机验收；灰度开关翻转。

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
