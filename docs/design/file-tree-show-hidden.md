# 文件树「显示隐藏与忽略文件」临时开关

状态：已实施（待合入 main）
基准：feat/file-tree-show-hidden @ 2026-11-17

## 目标

文件管理器（File Tree）增加一个会话内临时开关，激活后把被 gitignore/内置忽略名单挡住的文件与目录一并加载出来，用于临时排查。不持久化，刷新页面后回到默认隐藏。

## 范围

- 服务端 `POST /api/file-tree/projects/:projectId/directories` 增加 `showHidden` 可选布尔。
- 服务端目录列举在 `showHidden` 时跳过 ignore 规则（`.git/info/exclude`、各级 `.gitignore`）与 fallback 内置忽略名单。
- 前端 File Tree 工具栏增加切换按钮；切换后重读根目录与当前已展开目录，收起目录标记 stale 在下次展开时按新模式重读。

不改动：

- 搜索（`searchFiles`）继续遵循 ignore 规则，索引上限 20 万文件不变；
- 工作区浏览器（`browseWorkspace`，建项目选目录用）保持原过滤；
- 写入/删除等操作的边界校验不变（隐藏模式只是显示层变化）。

## 方案

- 常驻排除（任何模式都不显示）：`.git`、`.svn`、`.hg` 三个 VCS 内部目录——纯版本控制元数据，无浏览价值且可能巨大。`node_modules`、`dist` 等其余目录在隐藏模式下放行。
- 单目录 5000 条上限（`MAXIMUM_DIRECTORY_ENTRIES`）与 `truncated` 标记保持不变；目录懒加载不变，因此激活开关只影响已展开目录的条目数，不会触发全项目扫描。

## 验证

- 服务端测试：隐藏模式显示 gitignored 文件、fallback 忽略目录与 node_modules；`.git` 仍不显示；路由透传 `showHidden`。
- 前端测试：切换开关后根目录与已展开目录按新参数重读。
- `npm run typecheck`、lint、build、相关测试套件全绿。

## 风险

- 隐藏模式下大目录（如 node_modules）条目变多，受 5000 条/目录上限兜底。
- 搜索结果与树显示不一致（搜索仍隐藏 ignored 文件），属已知边界。
