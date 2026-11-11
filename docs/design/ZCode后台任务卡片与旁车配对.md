# ZCode 后台任务卡片与旁车配对

> 状态：已实施（2026-11-11）
> 分支：`feat/zcode-background-task-card`
> 目标：ZCode 用 `SendMessage` 把一个已结束的 agent 复活到后台时，原来那张 `Agent` 卡重新转成“运行中”，跑完再结算；刷新后这张卡的资料和子时间线不丢。

## 为什么要改

真实会话 `sess_039f62ad-3beb-43d1-aa1e-b828a38a5b66`：模型先派了一个 `code-reviewer` agent 拿到评审报告，再用 `SendMessage` 把这个已结束的 agent 复活到后台复审。页面只显示一句“复审在后台跑”，没有卡片在转。刷新后，原来的 `Agent` 卡还丢了 agent 名称、类型、模型和 136 条子时间线。

## 引擎的真实语义

以下都从引擎包 `zcode.cjs` 和磁盘数据核实过：

- 复活走 `resumeTerminalAgentInBackground`。它把旁车 `metadata.json` 的 `parentToolUseId` **改写成 SendMessage 的调用 id**，状态改回 `running`。
- 复活发出的 `subagent_spawned` 带 `resumed: true`，`parentToolCallId` 是 SendMessage 的调用 id。随后的 `subagent_stopped` 和子 agent 镜像到父会话的工具事件，`parentToolCallId` 也都是 SendMessage 的调用 id，**且不带 `resumed`**。
- 子 agent 发起的批准请求，`origin` 里带 `agentId`，`parentToolCallId` 同样是 SendMessage 的调用 id。
- 引擎自己的界面按 agentId 归一：复活时复用原来那一行，改成运行中，不新建第二张卡；同时在后台工作列表加一项。
- 引擎的派发工具集合是 `Agent`/`Task`/`subagent`，**不含 `SendMessage`**。
- 引擎重建历史时不信旁车的 `parentToolUseId`，而是从工具结果文本里用正则 `(?:^|\r?\n)agentId:\s*([^\s(]+)` 取 agentId。前台派发和后台派发的 `Agent` 结果都带这一行。

## 方案

### 一、历史按 agent 认领旁车

`zcode-sessions.provider.ts`：

- 旁车按 agentId 建索引。
- `Agent` 行先用引擎同款正则从自己的结果文本取 agentId，再找旁车；结果里没有这一行时，回落到旁车的 `parentToolUseId`。
- 引擎改写 `parentToolUseId` 不再影响配对。复活过的 agent，卡上的状态和子时间线就是它最后一次运行后的样子（同一个子会话，两次运行的记录都在里面）。

### 二、实时事件折回原 `Agent` 卡

`zcode-live-event-normalizer.ts`（逻辑）+ `zcode-sessions.provider.ts`（查库）：

- 收到 `resumed: true` 的 `subagent_spawned` 时，按 agentId 查引擎库，找到结果里写着这个 agentId 的 `Agent` 调用，记下“SendMessage 调用 id → `Agent` 调用 id”。查库而不是靠内存记录：复活往往发生在很多轮之后，中间服务可能重启过。
- 此后这个会话里 `parentToolCallId` 等于该 SendMessage 调用 id 的事件——生命周期事件和子 agent 的镜像工具事件——都改写到 `Agent` 调用 id。镜像工具行因此折进原卡的时间线，不再漏到主时间线。`subagent_stopped` 到达后删掉这条记录。这条记录不随回合结束清空，因为 agent 在回合结束后还在跑。
- 复活的 `started` 事件带 `resumed: true` 发给前端。
- 查不到（结果里没有 agentId）时维持原样：状态落在 SendMessage 行上，不改写。

### 三、批准卡片按 agentId 撤回

`zcode-run-lifecycle.ts`：子 agent 停下时撤回它没答完的批准卡片，匹配条件从“调用 id”改成 `origin.agentId`。批准请求里的调用 id 是 SendMessage 的，而停止事件改写后是 `Agent` 的，按调用 id 会对不上；agentId 两边都有，且不会变。

### 四、前端让复活压过历史定论

现行规则是：历史行的 `subagent` 一旦给出 `running` 以外的状态就是定论，实时状态压不过它。修好第一条以后，复活前加载的历史会把这张卡定成“已完成”，复活的 `started` 就再也转不起来。

- `LiveTaskStatus` 增加 `resumed`：由带 `resumed: true` 的 `started` 置上，之后同一任务的事件沿用。
- `resolveBackgroundTaskStatus` 遇到 `resumed` 的实时状态时，以实时为准。
- 复活中的卡，时间线 = 历史 `subagentTools` + 直播折进来的子行。

### 五、`SendMessage` 行

保持普通工具行，与引擎一致。它的结果文本写着“resumed it in the background”，加上原卡复活和输入框上方的后台任务条，用户能看懂。不新建第二张 agent 卡，否则同一个 agent 两张卡、同一个子会话的时间线显示两遍。

## 改动范围

| 文件 | 改什么 |
| --- | --- |
| `server/modules/providers/list/zcode/zcode-sessions.provider.ts` | 旁车按 agentId 索引；`Agent` 行按结果里的 agentId 认领；给归一化器提供“agentId → `Agent` 调用 id”的查库函数 |
| `server/modules/providers/list/zcode/zcode-live-event-normalizer.ts` | 复活调用 id 改写；`started` 带 `resumed` |
| `server/modules/providers/list/zcode/zcode-run-lifecycle.ts` | 子 agent 批准卡按 agentId 撤回 |
| `server/modules/providers/list/zcode/zcode-runtime.provider.ts` | 撤回时传 agentId |
| `shared/protocol/chatEvents.ts` | `task_status` 和 `LiveTaskStatus` 增加 `resumed` |
| `src/modules/chat/hooks/useChatMessages.ts`、`src/modules/chat/utils/backgroundTasks.ts`、`src/modules/chat/tools/SubagentPanel.tsx` | 复活状态压过历史定论；复活中拼接实时子行 |

## 验证

1. 历史：旁车 `parentToolUseId` 被改写成 SendMessage 调用 id，`Agent` 行仍拿到 `subagent` 和子时间线；结果里没有 agentId 时按 `parentToolUseId` 回落。
2. 归一化：复活的 `subagent_spawned`、镜像工具事件、`subagent_stopped` 都指向 `Agent` 调用 id；`started` 带 `resumed`；查不到 `Agent` 调用时维持原样。
3. 运行时：子 agent 停下时撤回它的批准卡（按 agentId）。
4. 前端：历史已是 `completed` 的 `Agent` 卡，收到 `resumed` 的 `started` 后显示运行中，再收到结算后显示结算结果。
5. 真实会话 `sess_039f62ad…` 跑 `fetchHistory`：`Agent` 行 `subagent` 和 `subagentTools` 都在。
6. 全量后端、前端测试，类型检查，lint。

## 风险

- **依赖结果文本里的 `agentId:` 一行**。这是引擎自己重建历史用的规则，改了引擎自己也会坏。失效时退回到改之前的样子，不会画错。
- **复活中刷新页面**：历史里的子时间线已包含复活后的记录，如果实时层还留着复活中的子行，卡上可能重复显示这几行，刷新结束后恢复正常。
- **复活中服务重启**：停止事件没人收，实时层的 `resumed` 状态会一直转，直到页面刷新。

## 不做什么

- 不改引擎包。
- 不改输入框上方的后台任务条机制，它按 agentId 登记，复活期间本来就显示。
- 不给 `SendMessage` 行画卡片。
