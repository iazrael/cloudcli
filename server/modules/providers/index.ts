export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
// sessionsService: used by Projects (to clean up provider storage during project force-delete)
// and Routes/Websocket to manage session state.
export { sessionsService } from './services/sessions.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';
export { providerTokenUsageService } from './services/provider-token-usage.service.js';

// executeCodexSandboxCommand: the task-continuations worker uses Codex's
// independent command/exec endpoint while keeping the original sandbox.
export { executeCodexSandboxCommand } from './list/codex/codex-runtime.provider.js';
export { listCodexThreadTurns } from './list/codex/codex-app-server.client.js';

// setCodexHostTaskSource and createBackgroundTasksStatusMessage: the server
// entrypoint connects the commands the host runs for a Codex chat
// (`cloudcli_task_run`) to the composer strip, and re-sends the strip when
// one of them starts or ends.
export { setCodexHostTaskSource } from './list/codex/codex-background-work.js';
export { createBackgroundTasksStatusMessage } from './shared/background-work/task-status.js';

// closeCodexResidentSessions: used by the server entrypoint to stop the
// Codex processes that stay alive between rounds.
export { closeCodexResidentSessions } from './list/codex/codex-session-manager.js';

// closeClaudeResidentSessions: used by the server entrypoint to stop the
// Claude processes kept alive between turns or for background work.
export { closeClaudeResidentSessions } from './list/claude/claude-runtime.provider.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';

// sessionsAutoArchiveService: used by Server bootstrap and Provider routes to manage
// session auto-archive configuration and background lifecycle.
export {
  sessionsAutoArchiveService,
  type SessionsAutoArchiveSettings,
} from './services/sessions-auto-archive.service.js';


// shutdownZCodeRuntime: used by the server entrypoint (server/index.ts) to stop
// the shared ZCode app-server subprocess during the shutdown flow.
export { shutdownZCodeRuntime } from './list/zcode/index.js';

// getAntigravityBrainRoots: used by the File Tree composition root as the
// read-only allowlist for workspace-external Antigravity plan documents.
export { getAntigravityBrainRoots } from './list/antigravity/index.js';

// getClaudeExternalReadOnlyRoots: used by the File Tree composition root as
// the read-only allowlist for Claude project artifacts referenced from chat.
export { getClaudeExternalReadOnlyRoots } from './list/claude/claude-data-root.js';

// getZcodeExternalReadOnlyRoots: used by the File Tree composition root as the
// read-only allowlist for workspace-external ZCode files (memories, skills,
// AGENTS.md) referenced from chat.
export { getZcodeExternalReadOnlyRoots } from './list/zcode/index.js';

// setSessionWorktreeHomeResolver: used by the server entrypoint to wire the
// Worktrees module's git resolver into the session worktree placement policy
// (injected rather than statically imported to keep the module graph acyclic).
export { setSessionWorktreeHomeResolver } from './shared/sessions/session-worktree-placement.js';

export type {
  AntigravityQuotaData,
  AntigravityQuotaGroup,
  AntigravityQuotaBucket,
} from './list/antigravity/index.js';
