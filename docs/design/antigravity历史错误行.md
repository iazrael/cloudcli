# antigravity 历史回合失败可见

状态：已实现（2026-11-09）

## 目标

antigravity 回合最终失败（引擎重试耗尽、零回复）后，刷新会话历史只剩用户消息，失败无任何痕迹。要求历史里能看到失败。

## 范围

只改 `server/modules/providers/list/antigravity/antigravity-sessions.provider.ts` 的 `fetchHistory`（新增一个模块私有规划函数 + 一个分支）。前端零改动：`kind: 'error'` 行已有渲染路径（与 zcode/codex 历史错误行同通道）。

## 方案

引擎把每次重试失败写进 transcript（`type: ERROR_MESSAGE`，一回合可有多条），自愈的回合后续会跟 PLANNER_RESPONSE/MODEL 行。实测 241 份 transcript：41 个带错的回合里 37 个自愈、仅 4 个真失败。因此：

- **回合最终失败才报**：ERROR_MESSAGE 行之后、下一条用户消息之前，若已出现 `PLANNER_RESPONSE` 或 `source: MODEL` 行（自愈证据），该错误行静默跳过——与直播行为一致（直播只报最终结果）。
- **一回合折叠成一条**：相邻未被抑制的 ERROR_MESSAGE 行折叠为一条 `kind: 'error'` 消息，内容取最后一次的错误文本；多条时追加 `(failed after N attempts)`。行位置/时间戳/sequence 取该组最后一行。
- 单条时不加后缀，保留引擎原文。

## 验证

`antigravity.test.ts` 新增 fixture 用例：多条终局折叠、自愈静默、单条原样、正文后失败 + 跨回合边界。跑该文件全部用例 + `npm run typecheck`。

## 风险

- 误报已排除：自愈回合被抑制规则覆盖；真失败才有行。
- 序列：错误行 sequence 取引擎 step_index，与既有行同坐标系，不影响排序权威化规则。
