# Repository guidance

## Core architecture docs (must stay in sync)

This fork's core architecture guides live in `docs/core/` (written in Chinese). Changes to the code below **must update the matching doc**:

| Doc | Covers | Triggered by changes to |
| --- | --- | --- |
| `docs/core/overview.md` | Process topology, data & persistence, auth, build & deploy | `server/index.ts`, `server/modules/database/{schema,migrations}.ts`, build output layout, deployment |
| `docs/core/providers.md` | Engine integration framework & capability matrix | `server/modules/providers/**`, `server/shared/{types,interfaces}.ts` |
| `docs/core/chat.md` | Chat pipeline & the frontend timeline store | `server/modules/websocket/**`, `src/modules/chat/**` |
| `docs/core/frontend.md` | Frontend state layering, performance rules, i18n, PWA | `src/shared/**`, chat rendering/perf code |

Rules:

- **Architecture only, no trivia.** Update docs when interfaces, protocols, extension points, capabilities, or performance invariants change; keep the docs lean, not long.
- **Ordinary bug fixes that don't touch architecture: just `git commit --no-verify`.** Never pad the architecture docs just to satisfy the check.
- The pre-commit guard (`scripts/hooks/check-doc-sync.mjs`) blocks core-code commits whose doc wasn't staged; its error message spells out these two exits.
- Upstream's `docs/architecture/` (six English chat-runtime docs) is maintained via upstream merges; 04/05 are partially superseded by this fork's rework — treat `docs/core/chat.md` as authoritative.

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
