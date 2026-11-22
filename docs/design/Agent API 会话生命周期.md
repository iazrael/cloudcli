# Agent API 会话生命周期

> 状态：已完成。abort、状态查询、`sessionId` 单独续聊、`wait:false` 与结果查询；不做回合中插话
> 基准：2.21.0 / 2026-11-14（`wait:false` 与结果查询补于 2.24.0）

## 目标与范围

`POST /api/agent` 原来只能同步等完整轮 run：调用方拿不到停止入口，不能只凭 `sessionId` 继续会话，断线后也无法查询 run 是否还在跑。本方案补齐运维所需的能力：

- `POST /api/agent/:sessionId/abort`：停止正在跑的 run；没有活动 run 时幂等返回。
- `GET /api/agent/:sessionId`：查询会话所在的 provider、项目、run 状态和最近事件序号。
- `POST /api/agent` 允许只传 `sessionId`：项目路径和 provider 从会话行推断，不再强制重复传 `projectPath`。
- `POST /api/agent` 的 `wait:false`：注册 run 后立即返回 app 会话 id，调用方不再为长任务挂住一条 HTTP 请求。
- `GET /api/agent/:sessionId/result`：从持久化的 transcript 读最后一轮回复，断线或服务重启后仍可查。
- `clientRequestId`：同一次派发的重试复用同一个 app 会话，不重复开会话。

不在范围内：回合进行中插话（所有 provider 都没有 `injectInput` 实现，产品本身也是排队）、断线后的完整事件重放、后台子任务逐个停止。

## 方案

### abort

路由复用聊天网关已有的停止路径，不新造运行时能力：

1. 用应用会话 id 或 provider 原生 id 解析会话行，未知会话返回 404。
2. `chatRunRegistry.getRun()` 命中 running run 时调用 `runtime.abort(provider, sessionId)`，成功后用 `completeRunIfCurrent(run, { aborted: true, reason: 'client_abort' })` 发出终止帧。
3. 没有 running run 但 `runtime.hasBackgroundWork(sessionId)` 为真时，同样转给 `runtime.abort`，与 UI 的 `chat.abort` 一致。
4. 两者都没有时返回 `200 { success: true, aborted: false }`，让重试安全；provider 拒绝停止返回 409。

原本还在等待的 `POST /api/agent` 会照常收到终止帧：流式响应发 `status: Run aborted`，非流式响应返回 `{ success: false, aborted: true }`，分支/PR 不会执行。

### 状态查询

`GET /api/agent/:sessionId` 返回：

```json
{
  "success": true,
  "sessionId": "app-...",
  "provider": "claude",
  "providerSessionId": "native-...",
  "projectPath": "/path/to/project",
  "name": "会话名",
  "archived": false,
  "status": "running | background | idle",
  "run": { "startedAt": "2026-11-14T...Z", "lastSeq": 12 },
  "createdAt": "2026-11-14T...Z",
  "updatedAt": "2026-11-14T...Z"
}
```

`run` 仅在 `status: running` 时有值。查询同样接受 provider 原生 id。

### wait:false 与结果查询

长跑子代理不需要调用方为整轮挂住一条 HTTP 请求。`POST /api/agent` 增加 `wait`（默认 `true`）：

- `wait: true`：保持原来的流式/JSON 响应。
- `wait: false`：run 注册进 run registry 后立刻返回 `202`，body 与状态查询同形：

```json
{
  "success": true,
  "sessionId": "app-...",
  "provider": "opencode",
  "providerSessionId": null,
  "projectPath": "/path/to/project",
  "status": "running",
  "run": { "startedAt": "2026-11-22T...Z", "lastSeq": 0 }
}
```

provider 在后台继续跑，调用方用两个 API-key 路由收尾：

- `GET /api/agent/:sessionId`：轮询 `status`，`running` / `background` 继续等，`idle` 收尾。
- `GET /api/agent/:sessionId/result`：从持久化 transcript 读最后一轮回复。返回 `status`、`messages`（assistant 文本事件）、`reply`（拼好的文本）、`tokens`、`providerSessionId`。`limit` 控制读的尾部页（默认 200，最大 1000），用最后一条用户文本锚定这一轮，续聊只返回最新一轮。

为什么是读 transcript 而不是内存事件：断线、进程重启、甚至 cloudcli 重启后，`result` 仍能回答。代价是运行中读到的可能是部分回复（`status` 会同时返回），调用方应以 `idle` 后的结果为准。

`wait:false` 的回答早于分支/PR，因此与 `createBranch`/`createPR` 同时出现时返回 400；需要分支/PR 的调用方继续用 `wait:true`。`stream` 在 `wait:false` 下被忽略（没有响应可继续写）。

`clientRequestId` 是可选的幂等键：新会话的第一次请求把 app 会话 id 记在内存（与 `POST /api/providers/sessions` 同一套）。`wait:false` 的重试落在原 run 仍在跑时，直接再回一次 202 和同一个 run；原 run 已经结束时不会自动重放，调用方应先查状态/结果再决定是否重派。

### sessionId 单独续聊

`sessionId` 与 `githubUrl`/`projectPath` 都不传时返回 400。只传 `sessionId` 时用会话行的 `project_path` 作为工作目录；会话没有项目路径则返回 400。传了 `projectPath` 时仍按原逻辑校验它与会话行一致。

## 验证

- `server/modules/agent/tests/agent-run-registration.test.ts` 增加：abort 终止 held run 且原响应报告 aborted；无活动 run 幂等；未知会话 404；状态查询 running/idle；`sessionId` 单独续聊；`wait:false` 立即返回 id 且 run 继续，`result` 在运行中/结束后都能读最后一轮，`wait:false` 拒绝分支/PR，`result` 404。
- 运行 `npx tsx --tsconfig server/tsconfig.json --test server/modules/agent/tests/agent-run-registration.test.ts server/modules/agent/tests/agent.routes.test.ts`。
- 运行 `npx tsc --noEmit -p server/tsconfig.json` 和 `npx oxlint server/modules/agent`。

实施后结果：agent 两个测试文件 37 项全部通过；server typecheck 通过；`npm run build:server` 通过；`oxlint` 只剩既有的 `no-async-promise-executor` 警告。

## 风险与边界

- abort 与 run 自然结束存在竞态：`completeRunIfCurrent` 只终止当前 run，不会误杀同会话的后继 run；provider 已自行发终止帧时该调用为 no-op。
- 断开的 SSE 连接不会阻止 run 继续；`wait:false` + `/result` 覆盖了结果读取，但不提供事件流的断线续传（后续可加 `GET /api/agent/runs/:runId/events?after=`）。
- `wait:false` 不支持分支/PR，因为回答早于它们产生；需要时用 `wait:true`。
- `/result` 从 provider transcript 读，运行中可能只有部分回复；以 `status: idle` 后的读数为准。transcript 尚未落盘的极端窗口由调用方重试几次覆盖。
- `wait:false` 的新会话在 202 里的 `providerSessionId` 可能为 `null`；最终 id 以 `/result` 或状态查询为准。
- `clientRequestId` 的幂等表在进程内存里，服务重启后同一 id 可能重新开会话；它防的是短时间重试，不是跨重启去重。
- 现有会话表没有用户归属，API key 的权限边界与当前续聊接口一致（单用户/自托管假设）。
