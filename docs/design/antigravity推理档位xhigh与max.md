# Antigravity 推理档位补齐 xhigh 与 max

状态：已实现（2026-11-13）

## 目标

`agy models` 新增 `gemini-4-hydrogen-xhigh`（`Gemini 4 Hydrogen (XHigh)`），`agy --help` 的 `--effort` 也支持 `low | medium | high | xhigh | max`。当前折叠逻辑只认 `low / medium / high`，导致 `Gemini 4 Hydrogen (XHigh)` 单独漏进模型列表。将 `xhigh` 与 `max` 纳入 Antigravity 档位体系，使其正常折叠进模型族的 Reasoning 菜单。

## 范围

- `server/modules/providers/list/antigravity/antigravity-model-effort.ts`：扩展 `ANTIGRAVITY_EFFORT_TIERS`、后缀与标签正则、`EFFORT_DESCRIPTIONS`（顺序按弱到强：`low`、`medium`、`high`、`xhigh`、`max`；默认档位仍优先选 `high`）。
- `server/modules/providers/list/antigravity/antigravity-models.provider.ts`：同步内置兜底模型清单 `ANTIGRAVITY_BUILTIN_RAW_MODELS`（补入 `gemini-4-hydrogen-{high,xhigh,medium,low}` 与 `gemini-pro-orchestrator-g1-pro`）。
- `server/modules/providers/services/provider-capabilities.catalog.ts`：将 `antigravity.effortLevels` 更新为 `['low', 'medium', 'high', 'xhigh', 'max']`。
- `src/modules/chat/constants/providerEffort.ts`：同步前端兜底表 `FALLBACK_PROVIDER_EFFORT_VALUES.antigravity`。
- 测试：`server/modules/providers/tests/{antigravity.test.ts,provider-capabilities.test.ts,provider-models.service.test.ts}`。

## 方案

- 档位集合从 `['low', 'medium', 'high']` 扩为 `['low', 'medium', 'high', 'xhigh', 'max']`。
- `EFFORT_SUFFIX_PATTERN` 与 `LABEL_TIER_PATTERN`（含 `findCatalogOptionForModelString` 的标签档位提取）统一覆盖 `xhigh / XHigh` 与 `max / Max`；复用同一正则/解析规则，避免两处不同步。
- `defaultTierOf` 保持优先选 `high`，避免切换模型时默认落到高耗时的 `xhigh` / `max`。
- `ANTIGRAVITY_BUILTIN_RAW_MODELS` 更新为当前 `agy models` 输出的完整基线，避免 `agy models` 失败回退时丢失 `Gemini 4 Hydrogen` 及 `Orchestrator (Argon)`。

## 验证

- TDD 先红后绿：在 `antigravity.test.ts`、`provider-capabilities.test.ts`、`provider-models.service.test.ts` 补齐用例并跑目标测试文件。
- 全量校验：`npm run typecheck && npm run lint && npm run test:client && npm run build`。

## 风险

- `agy models` 目前仅返回 `-xhigh` 模型，尚未返回 `-max` 模型；由于 `dedupeAntigravityVariantModels` 按该模型实际返回的变体过滤 `effort.values`，`Gemini 4 Hydrogen` 的 Reasoning 菜单只会出现 `Low / Medium / High / XHigh`，不会虚构 `Max`。
- 只有用户自定义模型库可为 Antigravity 额外勾选 `max`（若引擎原生支持 `--effort max` 则直接生效，与 `agy --help` 一致）。
