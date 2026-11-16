# agy 后台任务清单卡（manage_task Action=list）

> 状态：实施中（2026-11-16）
> 分支：`feat/agy-manage-task-list-card`
> 目标：agy 时间线里的 "Task / list" 行目前只剩一行工具名，看不到它查到的后台任务。把 Action=list 的结果放行并渲染成后台任务卡（任务名 + 命令 + 运行中状态，空态一行灰字），直播与刷新历史都生效。

## 现状与数据形态

- 截图里的 "Task / list" 是 agy 引擎的 `manage_task` 工具、`Action=list`。它查的不是计划清单，是**正在跑的后台命令任务**（backgrounded run_command）。
- 引擎结果（transcript GENERIC 行，`tool_result` 清洗后原样到前端）两种形态，均从本地 `~/.gemini/antigravity-cli/brain/*/.../transcript.jsonl` 实证：
  - 新式（紧凑数组）：
    ```
    Created At: ...
    Completed At: ...
    You have 1 background task(s) currently running:
    [{"taskId":"<brain>/task-3148","toolName":"run_command","toolSummary":"Run prep-sprites.mjs and render 18-tower comparison grid","description":"node scripts/...","startTime":"...","logUri":"file://..."}]
    ```
  - 旧式（每个对象一行 pretty JSON），前缀同样带 `You have N background task(s) currently running:`。
  - 空态：`No background tasks are currently running.`
- 完成通知是后续 SYSTEM_MESSAGE 行（`Task id "..." finished with result: Command exited with code N`），headless 无结构化状态；这些行清洗后任务身份丢失（既有定案：阶段一启发式关联不做）。本任务不碰完成关联。

## 为什么现在看不见

- `toolConfigs.ts` 的 `manage_task.result.hideOnSuccess: true` + `shouldHideToolResult`（toolConfigs.ts）把成功结果整体隐藏；`MessageComponent` 的结果区因此跳过。
- 即使放行，`manage_task.result` 没有 `type`/`contentType`，`mode="result"` 的 ToolRenderer 走到末尾 `return null`，什么都不画。
- `hideOnSuccess` 是静态布尔，而 `shouldHideToolResult(toolName, toolResult)` 收不到工具入参，无法按 Action 区分。

## 方案（纯前端渲染层，两路通用）

1. `hideOnSuccess` 类型放宽为 `boolean | ((input) => boolean)`；`shouldHideToolResult` 增加第三个可选参 `toolInput` 并解析谓词。调用方（`MessageComponent`、`ToolRenderer` 行内输出、`tools/index.ts` 若有）把 `toolInput` 传入。
2. `manage_task.result`：`hideOnSuccess: (input) => Action !== 'list'`（status/kill 维持隐藏）；`type: 'collapsible'`、标题 "Task list"、新 `contentType: 'background-tasks'`。
3. 新解析器（纯函数，独立模块可单测）：剥离 `Created At/Completed At` 头，识别 `You have N background task(s) currently running:` 后的紧凑数组或逐行对象，兜底不可解析（返回 null，渲染层回落为普通文本折叠，不丢信息）。
4. 新渲染组件：每行 = 运行中状态点 + toolSummary（缺省取 description 首行）+ description 等宽截断（title 全文）；空态一行灰字。logUri 是 `file://` 本机路径，WebUI 打不开，不渲染链接。
5. 标签沿用本模块英文惯例（toolConfigs 现有标签均未走 i18n）。

## 验证

- 解析器单测：紧凑数组 / 逐行对象 / 空态 / 带头两行 / 非 list 噪声文本。
- `MessageComponent`/`ToolRenderer` 现有工具测试套件回归。
- 真实历史会话（fa6c6012，美术素材重制）刷新后确认卡片出现且旧会话不受影响。

## 风险

- `shouldHideToolResult` 签名变化触及三处调用点，均为增量可选参数，行为不变。
- 解析失败回落为文本折叠，最坏退回"多显示一段原文"，不破坏现有行。
