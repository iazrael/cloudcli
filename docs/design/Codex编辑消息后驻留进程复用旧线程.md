# Codex 编辑消息后驻留进程复用旧线程

> 状态：方案已定，测试与实现进行中
> 基准：2.10.x / 2026-11-19

## 目标

编辑 Codex 会话的消息（尤其首条）触发 `rewindSession` 换线程后，下一次运行不得再复用持有旧线程的驻留进程；会话行与引擎线程的映射必须保持一致，历史记录不得因映射失真而显示为空。

生产事故（会话 `4837c1e5`）：首条消息编辑重发 → `rewindSession(null)` 把旧行程标记 superseded 并清空 `provider_session_id`/`jsonl_path`，约定下一轮开新线程；但上一轮失败后驻留进程仍握着旧线程，下一轮 `acquireCodexResidentSession` 命中现存驻留直接复用，`adoptNativeThread` 把会话接回已废弃线程，整轮回答写进索引器拒绝重扫的文件，行保持 NULL/NULL，重开会话历史为空。

## 范围

只改 Codex provider 两个文件与其测试，不动共享接口、不动前端：

- `server/modules/providers/list/codex/codex-sessions.provider.ts`：`rewindSession` 释放驻留进程；`getCodexSessionMessages` 在 `jsonl_path` 缺失时按 `provider_session_id` 兜底定位 rollout 文件（与 `getTokenUsage` 同一做法）。
- `server/modules/providers/list/codex/codex-session-manager.ts`：驻留复用守卫把"调用方声明开新线程（`nativeThreadId` 为 null）但现存驻留已持有线程"也判定为线程变更，弃旧开新。

## 方案

1. `rewindSession` 在改动数据库行之前调用 `releaseCodexResidentSession(sessionId, { dispose: true })`（无驻留时为空操作）。detach 与 fork 两个分支共用这一处。驻留进程关闭后，下一轮 acquire 走新建路径：`nativeThreadId` 为 null → `thread/start` 开新线程、写新 rollout、`session_created` 携带新 id，运行写入器同值去重不再命中，行映射按既有流程重建。
2. 复用守卫从 `Boolean(nativeThreadId) && settled.threadId !== nativeThreadId` 收紧为 `nativeThreadId !== settled.threadId`。调用方（`queryCodex` 是唯一生产调用方）传 null 表示"开新线程"，现存驻留持有的任何线程都与之不符；`settled.threadId` 初始化后恒为非空串，不存在误伤。辅助线程借用（`borrowCodexAuxiliaryThread`）不走该守卫，不受影响。
3. `getCodexSessionMessages` 兜底：`jsonl_path` 存在照用；缺失且行上有 `provider_session_id` 时按 `findCodexSessionFile` 在 `~/.codex/sessions` 递归定位；两者皆无时维持现行为（空历史）。该兜底覆盖"`jsonl_path` 被清而 `provider_session_id` 幸存"的中间态，不覆盖两者皆空的最终态——最终态由方案 1、2 从源头杜绝。

## 验证

- `server/modules/providers/tests/codex-message-editing.test.ts` 新增测试：建驻留（假 app-server transport）→ `rewindSession` → 断言驻留表无该会话、假进程已关闭；先跑失败再实现。
- `server/modules/providers/tests/codex-session-manager.test.ts` 新增测试：现存驻留下以 `nativeThreadId: null` acquire → 断言旧进程被弃用（关闭）、新进程新线程。
- `server/modules/providers/tests/codex-sessions.test.ts` 或同文件新增测试：行上 `jsonl_path` 缺失、`provider_session_id` 命中磁盘 rollout → `fetchHistory` 返回消息。
- 回归：上述两个测试文件全量 + `npm run typecheck` + `npm run build`。

## 风险

- 守卫收紧改变了"null + 现存驻留"时的行为：由复用变为弃旧开新。生产上该状态只出现在行被 detach 之后（本缺陷）或行从未被赋 id（首跑采纳前不可能已有驻留），弃旧开新都是正确取向；驻留管理模块 2100 行既有测试回归把关。
- 兜底按文件名含 `provider_session_id` 匹配，子代理线程不会误命中（rollout 文件名以顶层线程 id 命名）；误命中最坏情形是读到另一份同 id 文件，`findCodexSessionFile` 与 `getTokenUsage` 共用同一假设。
- 一次性数据修复已完成（行重连 + 撤销 superseded 记录），与本代码修复相互独立。
