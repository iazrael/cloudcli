# ZCode 引擎自发回合上报

> 状态：实施中
> 分支：`fix/zcode-engine-turn-activity`
> 目标：ZCode 引擎自己在会话上跑回合时（后台任务通知叫醒的汇报回合、CloudCLI 那轮失败后引擎接着干的回合），页面重新显示「进行中」，而不是看起来空闲。

## 为什么

真实会话 `3bee3756-8850-4e4c-be39-8845470d0ea5`（CrimsonFantasy）：

- 21:31:56 起跑，21:41:18 派两个子 agent。
- 21:44:34 主轮被引擎的限流打断（`[1302] 您的账户已达到速率限制…`，`session_turn_failures` 有记录，日志 `[RunOutcome] … reason=engine_failed exit=1 duration=757910ms`），CloudCLI 结束该轮。
- 22:22:09、22:24:03 两个子 agent 结束，引擎用 `task_notification` 自己在父会话上起新回合继续干，一直干到 22:48:37。
- 这 26 分钟里页面没有任何进行中状态：没有活动条、没有 Stop、输入框也不排队；但时间线一直在长（zcode 的 sqlite 同步器把引擎新落库的消息同步进来）。

原因：`/api/providers/sessions/running` 只有三个来源——`chatRunRegistry` 的 run、`runtime.listBackgroundWork()`（子 agent/后台命令）、Claude CLI 进程。引擎自发的回合三个都不占，于是会话在页面上是空闲的。Codex 有 `reporting` 口径表达同一件事（引擎自己跑汇报回合），ZCode 没实现。

## 引擎的真实语义（从 `zcode.cjs` 0.16.9 核实）

- 会话事件流里有 `turn.started` / `turn.completed` / `turn.failed`，信封带 `turnId`；`turn.started` 的 payload 带 `turnNumber`、`inputId`、`inputSource`、`backgroundSource`（`bash` / `subagent`）。
- 引擎自己起的回合也发 `turn.started`，只是 `inputId` 不是 CloudCLI 那轮的输入 id。所以「引擎在不在跑回合」不需要区分是谁起的，看事件流就够。
- 回合失败（限流）会发 `turn.failed` 收尾本轮；之后后台任务通知到达时引擎另起一个新回合，发的是新的 `turn.started`。所以「失败即本轮结束」本身是对的，缺的是后续回合的可见性。

## 方案

### 一、运行时记录「引擎正跑着哪个回合」

`zcode-engine-turns.ts`（新文件，模块私有）：

- 一张 `Map<引擎会话 id, { turnId, startedAt }>`。
- 收到 `turn.started` 就登记（同一 turnId 重复公告保留最早的开始时间）；`turn.completed` / `turn.failed` 清掉，信封 `turnId` 和登记的不一致时视为更早被抢占回合的迟到终态，不动。
- 引擎进程丢失（`zcode:session/lost`）清掉对应会话；引擎整体崩溃时路由额外发一条不带会话 id 的丢失通知，整表清空（没有监听器的会话也在表里）。`session.closed` 同样清掉；该会话两小时没有任何引擎事件也按结束处理——每条会话事件都为登记续期，所以只看静默、不看回合跑了多久，漏掉终态时不会把发送永久卡住。
- `startedAt` 取事件时间戳（ISO 字符串，解析失败退回当前时间），前端直接按它算已用时长。

### 二、观察点是协议路由，不是每个 run 的监听器

`zcode-request-router.ts` 增加一个全局会话事件观察者（`setSessionEventObserver`），在 `routeSessionEvent` 里先调它再过 dispatch 给会话监听器。run 的监听器在轮结束时会被摘掉，而这个观察者一直在，所以轮结束后引擎继续发的事件仍然看得到；也不需要给每个会话挂一个永久的监听器。

### 三、折进 running-sessions 轮询

- `IProviderRuntime` 增加可选 `listEngineTurns?(): ActiveEngineTurn[]`（`ActiveEngineTurn` 放 `server/shared/types.ts`）。
- zcode 运行时实现它，直接读上面的登记表。
- `sessions.service.listRunningSessions()` 在 Claude CLI 之后、附加 `queued`/`reporting` 之前补一段：引擎会话 id 经 `sessionsDb.getSessionByProviderSessionId` 映射成 app 会话，已经列过的不重复加；新增条目 `canInterrupt: false`（CloudCLI 没有这轮的控制权，不提供 Stop），`lastSeq` 沿用该会话 run 的最后序号供客户端补播。

前端不改：条目进 `processingSessions` 后，活动条照常显示（默认的「Thinking…」文案 + 已用时长），`canAbortSession` 为 false 所以不出现 Stop，输入框按现有规则排队。

## 不在本次范围

- ZCode 后台 **bash/exec** 任务不进 `listBackgroundWork`（现在只认 subagent），所以后台命令运行中不会有输入框上方的后台任务卡片。引擎把这类命令记在工具调用卡上（`commandStatus: backgrounded` + progress 事件），要单独做。
- 停止引擎自发回合：运行时的 abort 依赖 run handle，没有 run 就没有停止入口。

## 验证

- `server/modules/providers/tests/zcode-engine-turns.test.ts`：开始/终态/迟到终态/会话丢失/过期。
- `server/modules/providers/tests/sessions.service.test.ts`：引擎回合被列成 `canInterrupt: false` 的一条；run 已覆盖的会话不重复列。
- 手工：起 dev，命中一次真实自发回合（或直接给观察者喂一对事件）后看 `GET /api/providers/sessions/running` 和页面活动条。

## 风险

- 事件漏收（进程重启、订阅缺失）会漏报：表现为不显示，而不是误显示，且引擎下一步事件会补上。
- 终态判断依赖 `turnId` 匹配；信封不带 `turnId` 的一代引擎退化成「终态即结束」，与 run 的现有判断一致。
- 误判成进行中会挡住发送（输入框排队）。因此登记以「静默两小时」而不是「开始多久」过期，且用户仍可在排队卡上强制发送。
