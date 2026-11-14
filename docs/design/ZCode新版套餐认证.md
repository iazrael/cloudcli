# ZCode 新版套餐认证

状态：已完成
基准：ZCode 3.18.2 / 2026-11-15

## 目标与范围

修复个人套餐发送使用旧 `cli/config.json` Key 导致 401 的问题。仅修改 ZCode 凭证识别、账号套餐启用、发送参数和 runtime headers 桥接；自定义提供方和体验套餐保留原行为，不修改用户凭证文件，不部署或重启。

## 方案

新版登录使用当前账号的 OAuth 业务凭证，按账号匹配已保存的 `project-key-location:v1` 个人项目，再向 BigModel 固定 HTTPS origin 的项目 `access_tokens` 接口换取短期模型令牌。OAuth 凭证不能直接用作模型 Key。换取由引擎的 runtime headers 请求触发，发送参数仅选择账号套餐，不下发旧 Key。保留旧版唯一个人套餐 Key 的兼容路径；旧 BigModel OAuth 字段本身不作为新版标记，按新版存储标记和安装 App >= 3.18.2 区分，旧版/无法识别 App 版本时必须匹配当前 BigModel 账号 ID 才能使用旧 Key；存在新版登录但材料损坏、账号不匹配或项目不唯一时拒绝发送，不回退旧 Key。令牌只存内存，每次请求核对账号，按有效期缓存并处理引擎报告的已拒绝令牌指纹。

安装包静态核对：`out/host/chunk-IEBWXNOE.js` 的 `ProjectAccessTokenClient` 和 `ProjectAccessTokenCache`，以及 `out/host/index.js` 的 `resolveAccountRequestAuth`。REA Evidence：`ev_7d3fcf80d75d9c68de1a6e9d6bf62832ea6f73584b611df75095fbcf069c3662`；只选定两个 host 源文件，未分析范围保持未知；sharp 原生伴随文件 hash 与 ASAR 声明不符，使用 record-and-continue，不能据此证明安装包整体完整性。相关流程另以当前源码和真实请求验证。

## 验证

先写失败回归：新版凭证下模型路由和发送不再使用旧 Key；runtime headers 仅向固定 origin 换取并返回项目令牌。验证账号/项目不匹配、令牌禁用、业务/HTTP 拒绝、有效期和刷新、旧版及自定义提供方兼容。运行 ZCode 相关测试、类型检查、lint、构建；真实凭证只做最小对话验证，日志不输出密钥。完成独立 Agent 审查。

## 风险

错误账号或项目会消耗其他套餐额度，因此只接受当前账号明确匹配的个人项目；不自动创建或选择其他项目。换取失败和未初始化项目明确报错，不能静默改套餐。生产运行是静态副本，代码合回不会自动生效；部署由用户执行。

## 验证结果

ZCode 相关 285 项测试通过（其中新增认证回归 20 项）；typecheck、build、lint 通过，lint 保留仓库既有警告，本次文件无新增警告。真实旧 Key 请求返回 401；项目令牌交换后相同模型接口返回 HTTP 200 文本回复。隔离存储下由 CloudCLI runtime 驱动真实 app-server 收到正文 `stream_delta` 和 `complete`，无错误，临时存储已清理。独立 Agent 审查指出的登录过渡和旧版 OAuth 兼容问题均已修复并复审通过。生产部署由用户执行。
