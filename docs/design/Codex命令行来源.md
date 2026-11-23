# Codex 命令行来源（CODEX_CLI_PATH）

> 基准：2.25.0 / 2026-11-23
> 状态：已实现（2.25.0 分支 `feat/codex-cli-path`；单测、类型检查、lint 与真实 app-server 探针通过）

## 目标

让运维用 `CODEX_CLI_PATH` 指定本机安装的 Codex CLI，代替 CloudCLI 依赖里锁定的 `@openai/codex`，不必每次为了升级 Codex 去改仓库依赖、重新构建发布。默认行为不变：没有设置这个变量时仍用仓库依赖，升级方式与以前一样。

## 范围

- Chat（`codex app-server`）、设置页的 CLI 版本探测、额度读取统一按同一来源解析，不再出现"聊天用内置、额度用 PATH"的分裂。
- 设置页在没有更新动作时，能区分"随 CloudCLI 提供"和"使用服务器上安装的 CLI"两种说法。
- 不做：自动发现 PATH 上的 codex（PATH 顺序不可控，本机就有比内置 0.166.0 更旧的 0.155.0）；不改依赖版本；不提供从界面切换来源的开关。

## 方案

新增 `server/modules/providers/list/codex/codex-cli-path.ts`，导出 `resolveCodexCliLaunchSpec()` 和 `isCodexCliOverrideActive()`：

1. 读取 `CODEX_CLI_PATH`（去空白、去首尾引号）。为空则解析内置依赖：`@openai/codex/bin/codex.js`，用 `process.execPath` 启动；依赖缺失时返回 `null`，调用方按"未安装"处理（与现状一致）。
2. 指定了路径时，按扩展名判断启动方式：`.js` / `.mjs` / `.cjs` 用 `process.execPath` 启动，其余视为可执行文件直接启动（也接受 PATH 上的命令名）。两种情况都带 `--version` 探测一次，确认能跑并读出版本。
3. 版本守卫：探测失败或退出码非 0 回退内置并写一条警告；读出版本且低于内置版本时同样回退并警告；版本读不出来但能正常退出时保留这个 CLI，警告"版本无法校验"。理由：本仓的 app-server 协议按 `package.json` 锁定的版本验证过，静默降级到更旧的引擎可能让会话、队列方法在运行时才炸。
4. 解析结果按 `CODEX_CLI_PATH` 的值缓存在进程内：每次开 app-server 都探一次 `--version` 代价太高。同一路径上的原地升级不重新探测，服务重启后生效；设置页显示的版本仍由认证状态每次现探，不受缓存影响。

调用方：

- `codex-app-server.client.ts`：`resolveLauncher()` 返回脚本路径或原生可执行文件；按扩展名决定是否用 `node` 启动。既有的测试替换点不变。
- `codex-auth.provider.ts`：`checkInstalled()` 探测解析出的命令，删掉原来未使用的 `createCliInstallationProbe({ command: () => 'codex' })`。
- `codex-quota.provider.ts`：`startAppServer` 使用同一份启动配置（`app-server --stdio`），CLI 缺失时给出明确错误。
- `provider-cli.service.ts`：新增 `updateUnavailableReason: 'external'`；Codex 在覆盖生效时报告 `external`，设置页据此显示"使用服务器上安装的 CLI"，不再误报"随 CloudCLI 一起更新"。

## 验证

- 新增 `codex-cli-path.test.ts`：默认为内置；脚本覆盖走 node；原生可执行覆盖直接启动；更旧版本回退内置并警告；探测失败回退内置；同一路径只探测一次。
- `provider-cli.service.test.ts`：设置 `CODEX_CLI_PATH` 后报告覆盖版本与 `external`；隔离环境恢复该变量。
- `codex-app-server.client.test.ts`：原生启动器不经过 node。
- 前端 `providerCliVersion.test.tsx`：`external` 文案、不出现更新按钮。
- 实跑：本机 `codex` 0.171.0 对 `app-server`、`app-server --stdio` 都能完成 `initialize`，与内置 0.166.0 行为一致。用本文件改后的代码设置 `CODEX_CLI_PATH=$HOME/.local/bin/codex` 打开真实 app-server，`model/list` 返回 10 个模型；把路径指向不存在的文件时回退内置 0.166.0 并打警告。

## 风险

- 协议兼容由运维自行负责：覆盖版本高于内置时只做版本下限检查，新版本如果改了方法语义，Codex 会话可能在运行中报错。设置页会显示实际版本，排查时可对照仓库锁定的版本。
- 覆盖路径写错或不可执行会静默回退到内置（日志有警告）；这是有意的保守选择，避免一次配置失误让 Codex 完全不可用。
- Windows 上给 `.cmd` shim 直接设置 `CODEX_CLI_PATH` 仍不能启动（`spawn` 不经 shell）；应指向 npm 包里的 `codex.js` 或原生 `.exe`。当前使用场景是 macOS/Linux。
