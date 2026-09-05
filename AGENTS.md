# Repository guidance

## 核心架构文档（改动必须保持同步）

本 fork 的核心架构说明在 `docs/core/`（中文）。改到下列代码时**必须同步更新对应文档**：

| 文档 | 覆盖范围 | 触发更新的改动 |
| --- | --- | --- |
| `docs/core/overview.md` | 进程拓扑、数据与持久化、认证、构建部署 | `server/index.ts`、`server/modules/database/{schema,migrations}.ts`、构建产物结构、部署方式 |
| `docs/core/providers.md` | 引擎接入框架与能力矩阵 | `server/modules/providers/**`、`server/shared/{types,interfaces}.ts` |
| `docs/core/chat.md` | 聊天链路与前端时间线 store | `server/modules/websocket/**`、`src/modules/chat/**` |
| `docs/core/frontend.md` | 前端状态分层、性能守则、i18n、PWA | `src/shared/**`、聊天渲染/性能相关 |

规则：

- **只记架构，不记琐事**：接口、协议、扩展点、能力、性能不变量变了才更新文档；文档要精不要长。
- **普通 bug 修复没动架构的，直接 `git commit --no-verify`**，不要为凑文档检查往架构文档里塞琐事。
- pre-commit 的文档同步守卫（`scripts/hooks/check-doc-sync.mjs`）会拦截未同步的核心代码提交，报错信息里就是上面两条出口。
- 上游自带的 `docs/architecture/`（英文聊天运行时六篇）随上游合并维护；其中 04/05 两篇已被本 fork 重构部分取代，以 `docs/core/chat.md` 为准。

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Service Operations & Process Management

This project is managed and monitored via **PM2**:
- Application name: `cloudcli-ui`
- Restart command: `pm2 restart cloudcli-ui`
- Logs command: `pm2 logs cloudcli-ui`
- Status command: `pm2 status`
- Default service port: `3001` (`http://localhost:3001`)

Always use PM2 commands when restarting or inspecting the server process, rather than running ad-hoc background node processes.

**Important Note on Server Restarts**:
Restarting the PM2 service will abruptly drop the live websocket/HTTP connection with the user interface. Before triggering `pm2 restart cloudcli-ui`, always send a message to the user informing them in advance that the service is about to restart and connection will temporarily drop. After the restart, wait for the user to send a prompt to resume and continue the work.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.
