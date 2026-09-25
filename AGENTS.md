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

The **production instance** runs from the fixed runtime directory `~/.cloudcli/runtime/node_modules/cloudcli` as a static copy fully detached from this repo — editing repo code or running dev here never affects it. PM2 persists its config in `~/.pm2/ecosystem.config.cjs` (process env vars must live there; PM2-managed processes never read `.zshrc`).

- Application name: `cloudcli`
- Publish a new build: `pnpm run deploy` (build → pack → isolated staging install → fixed-runtime cutover → PM2 restart → health check → `pm2 save`); the script auto-increments the patch version and commits it. **Only the user may run this command**, because it restarts PM2. Deployments are serialized by `~/.cloudcli/deploy.lock`, retain the previous runtime for automatic rollback, and update the global `cloudcli` command to point at the fixed runtime. Release-pipeline deploys pass `--no-bump` to keep the tagged release version instead. The script re-launches itself as a detached background process logging to `~/.cloudcli/deploy.log`, so closing the terminal — or the cutover restarting the server that hosts the calling session — no longer aborts the deploy; the caller only tails that log. Inside a cloudcli-hosted session the cutover still drops your own connection, so watch `~/.cloudcli/deploy.log` for the rest.
- Service port: `3030` (`http://localhost:3030`)
- Restart command: `pm2 restart cloudcli` (**must be run by the user**)
- UI self-update: the version modal's "update & restart" (`POST /api/system/update`, runner `scripts/self-update.mjs`) pulls, rebuilds and restarts PM2 on a git checkout. It is a restart mechanism: **only the user clicks it**; the agent must never call that endpoint.
- Logs command: `pm2 logs cloudcli`
- Status command: `pm2 status`
- Local dev keeps the defaults (`3001` server + `5173` vite), so dev and production coexist; after config changes run `pm2 save` so `pm2 resurrect` doesn't restore a stale snapshot.

Use PM2 commands when inspecting the server process, rather than ad-hoc background node processes. The agent must never restart PM2 or trigger any command that restarts PM2; only the user may do so.

**Important Note on Server Restarts**:
Restarting PM2 abruptly drops the live websocket/HTTP connection. The agent must not execute `pm2 restart`, `pnpm run deploy`, or any indirect restart mechanism, even after warning the user. When a restart is needed, report the exact command and reason, then wait for the user to run it and confirm completion before resuming work.

## Release pipeline

Saying "发布/发版本" (release a version) means running this whole pipeline unattended, in this exact order — the tag must exist before the build, or the sidebar version string drifts:

1. Draft release notes from `git log <last-tag>..HEAD`: user-facing changes grouped under 新功能/问题修复 (内部 only when notable), drop internal refactors/tests/chore, append the compare link. Bump minor when features landed, patch otherwise.
2. Bump three places: `npm version X.Y.Z --no-git-tag-version` (package.json + lock) and hand-edit `redirect-package/package.json`.
3. `git commit --no-verify -m "chore(release): bump version to X.Y.Z"`, scoped to exactly those three files.
4. `git tag -a vX.Y.Z -m "CloudCLI X.Y.Z"` (annotated, before any build).
5. Build and deploy **from a clean worktree of the tag** — the main tree is routinely dirtied by parallel sessions, which bakes `-dirty` into the build fingerprint: `git worktree add --detach /tmp/rel-vX.Y.Z vX.Y.Z`, `cp -Rc node_modules /tmp/rel-vX.Y.Z/` (the repo has no pnpm-lock, so `pnpm install` there fails), then build in the worktree and verify the fingerprint is `vX.Y.Z-<hash>` without `-dirty`.
6. `git push origin main --follow-tags`, then `gh release create vX.Y.Z -R flufy3d/cloudcli --title "CloudCLI X.Y.Z" --notes-file ...` — always pass `-R`; `origin` is flufy3d/cloudcli, `upstream` is the read-only iazrael/cloudcli.
7. Stop before the restart-producing deploy step. Tell the user to run `node scripts/deploy.mjs --no-bump` from the worktree themselves; non-interactive shells need `PATH="$HOME/Library/pnpm:$PATH" PNPM_HOME="$HOME/Library/pnpm"` so pnpm and the stable global CLI entry are available. Resume verification only after the user confirms it completed.
8. Verify four things: pm2 online with the new version, `curl http://localhost:3030/` returns 200, the fixed runtime's `dist/assets/*.js` fingerprint has no `-dirty`, and `gh release view` confirms the release.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.
