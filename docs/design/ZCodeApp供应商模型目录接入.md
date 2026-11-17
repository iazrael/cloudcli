# ZCode App 供应商模型目录接入

状态：已实施（2026-11-17，分支 feat/zcode-native-provider-catalog）

## 目标

用户在 ZCode App 设置页配置的自定义供应商（如"阿里云百炼（中国）"）能出现在 cloudcli 的 zcode 模型菜单里，选中后真正按该模型执行。

## 背景事实（2026-11-17 实测）

- ZCode App 的供应商配置写在 `~/.zcode/v2/provider_config.json`（schemaVersion 1）：`config.providerConfigRules.providerRules[]` 每条含 `providerId`/`providerName`/`config.{access{type,apiKey}, api{baseUrl}, personalModelIds, modelOrder}`；每模型的开关在 `config.modelConfigRules.providerModelRules[]`（缺省视为启用），手动添加的模型在 `manualProviderModelRules[]`。
- cloudcli 的 zcode 模型目录此前只读 `~/.zcode/cli/config.json` 的 `provider.*` 表，所以 App 配的供应商既列不出来，`resolveZCodeModelRef` 也路由不到（裸模型名会静默落回 bigmodel 默认 provider）。
- 引擎侧不需要改：cloudcli spawn 引擎时注入的 personal provider registry（`zcode-provider-config.ts`）本来就会合并 native `v2/provider_config.json` 的规则；无可物化条目时直接回落到该文件。引擎凭这条配置自持 api-key 执行请求。

## 范围与方案

只改 `server/modules/providers/list/zcode/zcode-models.provider.ts`：

1. 新增内部读取函数 `readNativePersonalProviderRules()`：解析 `v2/provider_config.json`，产出 `{providerId, providerName, modelIds(有序去重，应用每模型 enabled 过滤), apiKeyConfigured}` 列表；跳过禁用 provider、`builtin:`/`account:` 保留行与 `bigmodel-coding-plan` 字面行（套餐路由另有权威）。`modelIds = modelOrder ∪ personalModelIds ∪ manual(启用)`。
2. 列表合并：`readZCodeModelConfig()` 在 cli 表之后合并 native 条目，裸 key 去重（cli 优先，与发送路由一致），native 选项带 `group = providerName`、无 effort 元数据（native 配置不含推理档位）。
3. 发送路由：`resolveZCodeModelRef()` 在 cli 查找失败后查 native 列表返回其 providerId；`buildZCodeSendModelParams()` 对 native provider 只下发 `modelSelection` + `modelExecution:{selectionScope:'execution'}`，**不带 requestAuth**——凭据留在交给引擎的配置文件里，不进发送参数；无 api-key 凭据的 native 条目按既有哲学降级为 null（引擎默认模型执行）。

## 验证

- `server/modules/providers/tests/zcode-models.test.ts` 新增六项：合并列表（白名单/disabled/manual/保留行）、native-only 目录、cli 同名优先、裸 id 路由、发送参数不复制 key、无凭据降级。
- 窄测试 + typecheck + 构建。

## 风险与已知边界

- 目录在 server 进程内只读一次且无失效入口，App 改配置后要重启服务端才刷新（既有行为，本次不改）。
- 裸模型 id 跨供应商重名时 cli/config.json 优先命中；native 菜单不带推理档位。
- App 后续若用非 api-key 鉴权类型，native 条目会被判不可执行而降级；届时再扩。
