# ZCode App 供应商模型目录接入

状态：已实施（双来源合并 297930c3；启用过滤对齐 App 见本分支 feat/zcode-native-provider-enablement）

## 目标

用户在 ZCode App 设置页配置的自定义供应商（如"阿里云百炼（中国）"）能出现在 cloudcli 的 zcode 模型菜单里，选中后真正按该模型执行。

## 背景事实（2026-11-17 实测）

- ZCode App 的供应商配置写在 `~/.zcode/v2/provider_config.json`（schemaVersion 1）：`config.providerConfigRules.providerRules[]` 每条含 `providerId`/`templateId`/`providerName`/`config.{access{type,apiKey}, api{baseUrl}, personalModelIds, modelOrder}`；`modelOrder` 是显示全集（模板模型+手动添加），用户的每模型开关只存偏离项（`modelConfigRules.providerModelRules[]`），手动添加的模型在 `manualProviderModelRules[]`。
- **模板默认启停**在引擎 builtin 配置（随安装包，`findBuiltinConfig` 可定位）`config.modelConfigRules.templateModelRules[]`：按 `templateId`+`modelId`、对模板全量穷举（本机 aliyun 模板 13 条，默认仅 `qwen3.8-max`/`qwen3.8-flash` 启用）。App 模型页=用户规则覆盖模板默认后启用的子集（实测 4 个：两个 qwen3.8 + 手动加的 deepseek-v4.1-flash-1017、qwen-image-3.0-pro）。首轮"缺省视为启用"会列满 15 个，与 App 不符，本分支修正。
- cloudcli 的 zcode 模型目录此前只读 `~/.zcode/cli/config.json` 的 `provider.*` 表，所以 App 配的供应商既列不出来，`resolveZCodeModelRef` 也路由不到（裸模型名会静默落回 bigmodel 默认 provider）。
- 引擎侧不需要改：cloudcli spawn 引擎时注入的 personal provider registry（`zcode-provider-config.ts`）本来就会合并 native `v2/provider_config.json` 的规则；无可物化条目时直接回落到该文件。引擎凭这条配置自持 api-key 执行请求。

## 范围与方案

只改 `server/modules/providers/list/zcode/zcode-models.provider.ts`：

1. 新增内部读取函数 `readNativePersonalProviderRules()`：解析 `v2/provider_config.json`，产出 `{providerId, providerName, modelIds(有序去重，应用每模型 enabled 过滤), apiKeyConfigured}` 列表；跳过禁用 provider、`builtin:`/`account:` 保留行与 `bigmodel-coding-plan` 字面行（套餐路由另有权威）。`modelIds = modelOrder ∪ personalModelIds ∪ manual(启用)`。启用判定顺序：用户 `providerModelRules` 规则 → 该 provider `templateId`（缺省用 providerId）在 `templateModelRules` 的默认值（模板已登记但无该模型条目 → 不列）→ `personalModelIds` 成员视为启用 → 模板默认值整体不可得（引擎未装/builtin 缺失）时宽松启用。`zcode-provider-config.ts` 新增 `readZCodeTemplateModelDefaults()` 负责读模板默认值，按 builtin 文件 mtime+size 进程内缓存。
2. 列表合并：`readZCodeModelConfig()` 在 cli 表之后合并 native 条目，裸 key 去重（cli 优先，与发送路由一致），native 选项带 `group = providerName`、无 effort 元数据（native 配置不含推理档位）。
3. 发送路由：`resolveZCodeModelRef()` 在 cli 查找失败后查 native 列表返回其 providerId；`buildZCodeSendModelParams()` 对 native provider 只下发 `modelSelection` + `modelExecution:{selectionScope:'execution'}`，**不带 requestAuth**——凭据留在交给引擎的配置文件里，不进发送参数；无 api-key 凭据的 native 条目按既有哲学降级为 null（引擎默认模型执行）。

## 验证

- `server/modules/providers/tests/zcode-models.test.ts` 新增六项：合并列表（白名单/disabled/manual/保留行）、native-only 目录、cli 同名优先、裸 id 路由、发送参数不复制 key、无凭据降级。本分支补三项：模板默认值只列启用集（禁用模板模型不出现在列表且发送为 null）、模板不可得时宽松启用、personalModelIds 成员无规则也启用。
- 窄测试 + typecheck + 构建。

## 风险与已知边界

- 目录在 server 进程内只读一次且无失效入口，App 改配置后要重启服务端才刷新（既有行为，本次不改）。
- 裸模型 id 跨供应商重名时 cli/config.json 优先命中；native 菜单不带推理档位。
- App 后续若用非 api-key 鉴权类型，native 条目会被判不可执行而降级；届时再扩。
