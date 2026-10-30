# 移除 TaskMaster 功能

状态：已完成（分支 `refactor/remove-task-master`，已验证待合入）

基准：2.16.0 / 2026-10-29

## 目标

TaskMaster 是上游（claude-task-master 集成）的功能，本仓库不使用。整体移除，
腾出启动资源（原 `module-settings` chunk 因 settings 与 task-master 强制同 chunk，
被撑到 727KB，且 `TaskMasterProvider` 等被 `App.tsx` 静态挂载、启动即请求
`/api/taskmaster/*`）。

## 范围

**前端删除**

- `src/modules/task-master/`（24 个文件）与 `src/modules/prd-editor/`——后者是
  task-master 的附属（PRD 存于 `.taskmaster/docs`，读写走 `api.taskmaster`），
  随之删除。
- `App.tsx`：`TaskMasterProvider` / `TasksSettingsProvider` 挂载。
- `chat`：`ChatInterface`、`ProviderSelectionEmptyState` 的 NextTaskBanner 与
  `isTaskMasterInstalled` 传参。
- `project-workspace`：`tasks` 工作区 tab（`TaskMasterPanel`、项目同步 hook）、
  `WorkspaceTitle` 的 TaskMaster 标签、`useProjectsState` 的 taskmaster 缓存合并、
  `projectSelectionMetadata` / `projectsMerge` 的 `taskmaster` 字段、相关测试。
- `settings`：`tasks` 设置 tab（`TasksSettingsTab`）、侧栏导航项、constants 条目。
- `sidebar`：`TaskIndicator`、`useTaskMaster` / `useTasksSettings` 接线、
  `sidebarProjectFormatting` 的 `taskmaster-only` 分支。
- `command-palette`：`tasks` 命令条目。
- `shared`：`api.ts` 的 taskmaster 端点组、`types.ts` 的 TaskMaster/PRD 类型与
  `Project.taskmaster` 字段、`constants.ts` 的 tasks tab、两处仅注释提及的文件
  （`Tooltip.tsx`、`MarkdownPreview.tsx`、`Shell.tsx`）。

**后端删除**

- `server/modules/taskmaster/`（含测试）、`projects-has-taskmaster.service` 及其在
  `projects.routes.ts` 的路由、`server/index.ts` 的挂载。
- 数据库无 taskmaster 列（已确认 schema/migrations 无引用），无迁移需求。

**i18n**

- 删除 `tasks` 命名空间（仅 task-master 使用）×15 语言文件，`config.ts` ns 列表
  同步移除；`settings.json` 的顶层 `tasks` 设置段与 `mainTabs.tasks` 侧栏文案
  一并删除。

**构建**

- `vite.config.js`：移除 task-master 的 chunk 归并规则；settings 不再被 task-master
  撑大，cycle 注释一并删除。

## 验证

- `npm run typecheck` 0 错误；`npm run lint` 退出码 0；全量 `npm run test:client`
  1306/1306 通过；后端 typecheck 随 `npm run typecheck` 一并通过。
- `npm run build:client` 后 dist 无 task/prd 产物、bundle 无 taskmaster 字符串；
  `module-settings` chunk 727KB → 647KB（gzip 196KB → 178KB）。settings 本体仍在
  modulepreload 里，其懒加载属后续 chunk 拆分工作。
- 附带修复：i18n 懒加载合入时未跑全量测试，断言翻译文案的测试会拿到空 bundle；
  已在 11 个断言文案的测试文件中显式 `await initI18n()`，composerPermissionMenu
  的 `changeLanguage` 改走 `switchLanguage`。

## 风险

- 上游合并摩擦：task-master 是上游功能，后续 upstream merge 触及这些文件时会出
  现冲突，按"fork 已删除"处理即可。
- PRD 编辑器一并删除属连带决定（存储依赖 taskmaster API），如需保留需另行重建。
- `docs/requirements/图片预览.md` 的 PRD 预览表述需同步；README 翻译（上游维护）
  不动。
