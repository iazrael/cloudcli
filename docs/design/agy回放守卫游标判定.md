# agy 回放守卫游标判定（修首 chunk 被误吞导致的重复回复）

> 状态：已实现并通过 antigravity 运行时测试（2026-11-26）
> 基准：v2.26.0 / 2026-11-26
> 分支：`fix/antigravity-replay-cursor`

## 目标

消除 antigravity（agy ACP）续跑会话时，模型真实回复的第一个 chunk 被 replay guard 误判为历史回放而丢弃的问题。该丢字使前端流式占位行与持久化行开头不一致，内容形状比对永远无法收敛，回复在时间线与导出中显示两遍。

## 现场与证据（2026-11-26 实测，会话 e1fcdd6a / 对话 8478ba29）

- 引擎 transcript（`transcript_full.jsonl` step 113）完整回复以「已把 `zcode`」开头；而 websocket 帧里本轮第一条 `stream_delta` 是「把 `zcode`…」——首 chunk「已」在流里缺失，其余 1741 字符逐字一致。
- 丢失位置：`antigravity-runtime.provider.ts` 的 replay guard。每个 `continuity === 'resumed'` 的 run 都武装守卫（agy 的 `session/load` 会把整段历史当 `agent_message_chunk` 重放），逐 chunk 用 `isReplayTailMatch` 分类：
  ```ts
  return tailText.includes(probe) || tailText.endsWith(probe.slice(0, 40));
  ```
  首个真实 chunk「已」（单字）在 12k 字历史尾巴里必然 `includes` 命中（上轮回复含「已有 24 条有效软链」），被当回放丢弃；下一 chunk 不在尾巴里才转 live。守卫全程只丢这一小段。
- 前端 `sessionTimelineStore.ts` 的 `reconcileStreamedPlaceholderByContent` 只在「完全相等 / 服务端行以实时文本开头 / 实时文本以截断服务端行开头」三种形状下收掉占位行；开头差一字全部不成立 → verdict `retain` → 占位行永久残留。前端设计「宁可保留不误删」正确，不在本次修改范围。

## 方案

把「全局 includes 撞字」改成「游标续接」：回放是按时间序的、且终点就是转录尾巴的末尾，所以已消费位置之后的文本不可能再是回放。

新增两个纯函数（替换 `isReplayTailMatch`，仍仅供运行时与测试使用）：

- `classifyBufferedReplay(tailText, bufferText)`：尾巴就绪后对缓冲整体定性。
  1. 尾巴为空 → 非回放（交由调用方按 live 冲刷）。
  2. 缓冲尾部（≤400 字符）恰好是尾巴的**后缀** → 整段缓冲都是回放，游标置尾巴末尾；此后逐 chunk 一律 live。
  3. 缓冲尾部在尾巴中段命中（`indexOf`）→ 回放在尾巴中途中止，游标置命中终点，残余回放继续逐 chunk 消费。
  4. 缓冲尾部前 40 字符与尾巴末尾重合（引擎重复投递边界）→ 整段回放，游标置末尾。
  5. 其余 → 缓冲以新文本结尾（模型在尾巴就绪前已开写），交由调用方按 live 冲刷。
- `consumeReplayChunk(tailText, cursor, chunkText)`：逐 chunk 消费。
  1. 空白 chunk → 保持回放态丢弃、游标不动（与原「whitespace hold」一致）。
  2. 游标已到尾巴末尾（或尾巴为空）→ live。**这是本次缺陷的关键不变量。**
  3. chunk 头部（≤120 字符，与原探针口径一致）在游标处续接尾巴 → 回放，游标推进。
  4. 游标前方 ≤200 字符的跳读窗口内命中 → 回放（容忍 history 清洗造成的空白漂移），游标跳到命中终点。
  5. chunk 头部与尾巴末尾重合 → 回放（边界重复），游标置末尾。
  6. 其余 → live，首个新 chunk 起交由 live。

运行时改动仅在 `antigravity-runtime.provider.ts`：守卫状态加 `tailCursor`，缓冲翻转与逐 chunk 两处调用点换用上述函数；尾巴读取（`fetchHistory` limit 6、12k 截断）与失败回退（读不到尾巴按 live）不变。

## 范围

- `server/modules/providers/list/antigravity/antigravity-runtime.provider.ts`
- `server/modules/providers/tests/antigravity-acp-runtime.test.ts`

不改前端归一、不改 translator、不改尾巴构造。

## 验证

- 单测（`antigravity-acp-runtime.test.ts`）：
  - 纯函数覆盖：续接、跳读、尽尾转 live、**真实事故场景**（尾巴含「已」、缓冲整段回放后游标在末尾、首 chunk「已」→ live）、空白 hold、无尾巴 live、边界重合。
  - 端到端：resident 会话第二轮（continuity resumed）下，stub 先重放上一轮回复再输出「已」+ 新回复 + 断言最终 delta 拼接含完整新回复且不含重放文本（HOME fixture 内置 transcript 以控制尾巴）。
- `npm run test`（providers 相关文件）+ `npm run typecheck` + `npm run build`。

## 风险

- 游标判据过严可能把残余回放当 live（旧回复粘进新气泡——守卫最初要防的回归）：跳读窗口 + 边界重合规则保留容错；端到端测试覆盖「重放文本必须被吞掉」。
- 缓冲翻转走到 live 冲刷分支时，缓冲头部若含早期回放仍会粘出（与现状一致，非本次回归面）；实测中尾巴读取慢于回放完成，主路径走「整段缓冲=回放」分支。
