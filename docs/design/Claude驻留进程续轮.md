# Claude 驻留进程续轮

> 状态：已实施（2026-10-19）
> 目标：Claude 会话里，后台工作还在跑时发的新消息直接写进还挂着的那个 CLI 进程，不再起新进程。后台工作因此能活过下一轮，停止回复后可以马上换方向接着聊，Claude 会话不再因为后台工作而排队。行为和 Claude Code CLI 一致。

## 为什么要改

先看一个例子。Claude 在后台跑 `npm run dev`，前台改错了文件，用户点停止，然后写“别改那个文件，改成 X”。

现在 CloudCLI 的处理：

1. 停止只打断这一轮，CLI 进程为后台的 `npm run dev` 继续挂着（`abortClaudeSDKSession` 的只停回合分支）。
2. 用户的纠正消息进了排队，因为前端只要看到后台工作就排队（`useChatComposerState` 的 `isBusy = isLoading || hasActiveBackgroundTasks`）。
3. `npm run dev` 不会自己结束，所以纠正消息一直发不出去。点“立即发送”能发，但会起一个新 CLI 进程：`addSession` 的接替分支先 `interrupt()` 旧进程、关它的输入流，再 `backgroundWork.clear()`，结果 `npm run dev` 被杀掉。

CLI 里没有这个二选一：按 Esc 之后直接打字，新消息进的是同一个进程，后台进程照常跑。CloudCLI 做不到，原因是每一轮都调用一次 `queryClaudeSDK`，每次调用都起一个新的 CLI 进程（`context.createQuery`）。

## 实测依据

2026-10-19 用 agent SDK 驱动本机 claude CLI（haiku 模型），在同一个 `query()` 的流式输入里先后写入四条消息，得到三条事实：

- **同一个进程能接着收新消息。** 每条消息各自成为一轮，各有自己的 `system init` 和 `result`，`session_id` 不变。
- **后台 Bash 能跨轮存活。** 第一轮起的 `sleep 30` 在中间又跑了两轮之后照常完成（`task_notification completed`），CLI 随后自己跑了一轮汇报。
- **回合进行中写入的消息会并进当前这一轮。** 第 4 条是在第 3 轮执行时写进去的，模型一并回复，只出了一个 `result`。

同一天的另一次实测（中途 `interrupt()`）：被打断的一轮立即以 `subtype: error_during_execution` 的 `result` 结束；后台 Bash 继续运行；后台 agent 被 CLI 当场停掉，并发出 `task_notification stopped`。

## 方案

### 后端：一个进程，多轮共用

引入“驻留进程”这个概念：一个已经结束了自己那一轮、但还为后台工作挂着输入流的 Claude CLI 进程（现有代码里的 `heldForBackgroundWork`）。

`queryClaudeSDK` 开始一轮时，先查这个会话有没有驻留进程：

- **有，而且能续用**：不起新进程。新一轮的消息写进驻留进程的输入流，进程的消息循环把输出改发给新一轮的 writer。这一轮的 `result` 到达时，向新一轮发 `complete`，并兑现新一轮的 `run()` promise。
- **没有，或者不能续用**：和现在一样起新进程。旧的驻留进程按现有接替逻辑结束。

“能续用”的条件：工作目录、MCP 配置、用户的工具许可设置、ultracode 设置都没变，而且这一轮不是编辑重发（`resumeAnchorId`）或从头重来（`resumeFromScratch`）。模型、权限模式、效果档位变了也能续用：先调用 SDK 的 `setModel`、`setPermissionMode`、`applyFlagSettings({ effortLevel })` 改掉，再写入消息。三个例外仍起新进程：离开进程启动时所在的 plan 模式（启动参数已放行 plan 模式那批工具，中途收不回）；打开跳过权限（实测 CLI 拒绝中途切到 `bypassPermissions`）；进程带 `--effort` 启动、这一轮回到默认档位（`effortLevel: null` 只回落到启动参数，回不到 CLI 默认值）。

为此要把消息循环里按轮次计的状态，从 `queryClaudeSDK` 的局部变量收进一个可以换绑的“当前一轮”对象。这些状态包括：writer、`turnCompleteSent`、空闲重发判定用的 `turnSawTaskNotification` / `turnAssistantText` / `turnToolUseCount`、权限请求的 `runToken`、通知用的会话名。拥有进程的那次调用继续跑消息循环；续用的那次调用只负责换绑和等待自己这一轮结束。

几条边界：

- **CLI 自己发起的汇报轮还在跑时用户发消息**：消息并进这一轮（实测第 3 条事实），这一轮的 `result` 同时结束用户的这一轮。CLI 里也是这样。
- **续用的这一轮里进程死了**：错误和 `complete` 发给当前绑定的 writer，续用那次调用的 promise 随之结束，不会悬空。
- **空闲重发**（这一轮只回应了注入的任务通知、吞掉了用户的话）：判定照旧，重发改为再写一次输入流，不再起新进程。
- **停止**：回复进行中停止，只打断这一轮（已实现）；后台阶段停止，结束整个进程（已实现）。两者在续用的轮次里含义不变。
- **兜底时长**：驻留进程挂着的上限（`CLOUDCLI_CLAUDE_BG_WAIT_CEILING_MS`，默认 24 小时，0 不限）按“距最后一条消息”计，新一轮写入会清掉计时。
- **停止落在交接窗口里**：一轮已交给驻留进程、还在等汇报轮结束时用户点停止，只撤回这一轮；用户停掉回复后、被打断的一轮还没出 `result` 时发来的一轮，等那条 `result` 之后写入，不起新进程。

### 前端：Claude 后台工作不再排队

排队的目的是不让新消息打断后台工作。续轮之后，Claude 的新消息不会打断后台工作，排队就没有理由了。

- 运行时声明后台工作是否挡住输入：后台任务条帧加 `backgroundWorkQueuesInput`，订阅确认带同名字段，缺省为 true。Claude 发 false，其余引擎不变。
- composer 的排队条件从“有前台回复或有后台工作”改成“有前台回复，或有挡住输入的后台工作”。Claude 的后台阶段里，输入框照常发送；后台任务条和活动指示照常显示。
- 后台任务条的提示随之改：后台工作不挡输入时不显示“发送将排队”；有前台回复时显示“本轮结束后发送”（原来写“任务完成后自动发送”，对 Codex 等轮内派 agent 的引擎不准确）。
- 后台工作不挡输入时，任务条写“可直接发送，后台任务继续运行”。
- 排队卡片“立即发送”的提示改成“立即发送，后台任务继续运行”。续轮之后，还会出现这个按钮的只剩 ZCode（回合结束后 agent 还在跑），而 ZCode 新开一轮不会停掉 agent，所以这句话属实。

ZCode 回合结束后的排队按 2026-10-19 的决定保留，不在本稿范围。

### 测试

后端用 `claude-runtime-hold.test.ts` 的脚本化 query（`context.createQuery`）驱动：

- 后台工作挂着时发第二轮：不调用第二次 `createQuery`；第二轮的消息出现在同一条输入流里；后台任务卡片保留；第二轮的 `result` 只给第二轮发 `complete`。
- 第二轮换了模型或权限模式：调用 `setModel` / `setPermissionMode` 后续用。
- 第二轮换了工作目录、是编辑重发：起新进程，旧进程按接替逻辑结束。
- 续用的一轮里进程报错：第二轮收到错误和 `complete`，promise 结束。
- 续用的一轮里停止：只打断这一轮，后台工作保留。

前端：Claude 后台阶段直接发送、不排队；ZCode 后台阶段照旧排队；条带提示三种情形各一条。

## 改动范围

后端：`claude-runtime.provider.ts`（主体）、`shared/interfaces.ts`、`provider-runtime.service.ts`、`chat-websocket.service.ts`、`shared/protocol/frames.ts`。
前端：`sessionTimelineStore.ts`、`useChatComposerState.ts`、`useChatSessionState.ts`、`ChatComposer.tsx`、`BackgroundTaskIndicator.tsx`、`QueuedMessageCard.tsx`，以及 en / zh-CN / zh-TW 三份 `chat.json` 文案（其余语种按约定回退英文）。
文档：`docs/core/providers.md`（Claude 后台任务生命周期）、`docs/core/chat.md`（后台任务与输入排队）。

## 代价与风险

- **`claude-runtime.provider.ts` 的消息循环要动刀。** 把按轮次计的状态收进可换绑对象，会碰到空闲重发、权限请求撤回、通知、被接替运行的静默这些已有逻辑。现有 34 个驻留相关测试是护栏。
- **长时间驻留的进程会累积上下文。** 这和 CLI 一样，不是新问题；会话本来就靠 resume 续上同一段上下文。
- **什么情况下反而更亏**：如果 SDK 的中途切换不可靠，续轮会让用户在切换后仍在旧模型、旧权限或旧档位下跑。2026-10-19 已实测三者都在下一轮生效；切换超时或被拒时这一轮改起新进程，后台工作随之结束。
- **残留时序窗口**：后台任务恰好在新一轮写入的同一刻完成时，CLI 可能先跑汇报轮再处理新消息，页面会先看到这一轮结束、再看到它的回复。窗口是毫秒级，不丢消息。
