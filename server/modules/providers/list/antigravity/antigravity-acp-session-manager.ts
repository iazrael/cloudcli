/**
 * Antigravity ACP Session Manager
 *
 * One resident `agy acp` process per antigravity session, kept alive across
 * turns so the engine can push question/permission requests and background
 * task completions while no turn is in flight (docs/design/agyACP运行时.md).
 *
 * Processes spawn with a cloudcli-managed app-data directory
 * (`~/.gemini/cloudcli-acp/`) whose settings pin `toolPermission:
 * "request-review"` — the user's own settings.json may say
 * `always-proceed`, which silently swallows every permission request and
 * would leave the bridge dead. The user's own directory is never touched.
 *
 * Conversation continuity survives process restarts: agy's ACP session ids
 * are its conversation ids, and `session/load` restores them (probe-verified
 * against agy 1.5.14). A failed load degrades to a fresh session and is
 * reported through the handle so the runtime can tell the user.
 *
 * @module antigravity-acp-session-manager
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { getAntigravityAcpDataRoot } from './antigravity-data-root.js';
import {
  AntigravityAcpClient,
  AcpConnectionClosedError,
  type AcpNotification,
  type AcpServerRequestHandler,
} from './antigravity-acp-client.js';

/** The app-data directory name under `~/.gemini/` this runtime manages. */
export const ACP_APP_DATA_DIR_NAME = 'cloudcli-acp';

/** Resolves the managed directory for settings writes (tests override via env). */
function managedDataDirPath(): string {
  return getAntigravityAcpDataRoot();
}

/** How many workspace paths the managed trustedWorkspaces list retains. */
const TRUSTED_WORKSPACES_LIMIT = 40;

/**
 * Creates the managed data directory and pins `request-review` there, adding
 * the session's workspace to the trusted list so the engine does not halt on
 * a trust prompt the ACP surface has no dialog for. Idempotent; keeps other
 * workspaces already listed.
 */
export async function ensureAcpManagedDataDir(cwd: string): Promise<void> {
  const dir = managedDataDirPath();
  await fsp.mkdir(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = readObjectRecord(JSON.parse(await fsp.readFile(settingsPath, 'utf8'))) ?? {};
  } catch {
    // First run or a torn write: start from a clean managed object.
  }
  settings.toolPermission = 'request-review';
  const trusted = Array.isArray(settings.trustedWorkspaces)
    ? settings.trustedWorkspaces.filter((entry): entry is string => typeof entry === 'string')
    : [];
  settings.trustedWorkspaces = [...trusted.filter((entry) => entry !== cwd), cwd].slice(-TRUSTED_WORKSPACES_LIMIT);
  await fsp.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/** The session facts `session/new` / `session/load` hand back. */
export type AcpSessionHandle = {
  client: AntigravityAcpClient;
  /** agy conversation id (equals the ACP session id). */
  sessionId: string;
  currentModeId: string | null;
  availableModeIds: string[];
  currentModelId: string | null;
  /** The engine's settable model ids (tier-suffixed families included). */
  availableModelIds: string[];
  /** False when a requested resume failed and a fresh conversation was opened. */
  continuity: 'resumed' | 'started' | 'restarted';
};

export type AcpAcquireOptions = {
  cwd: string;
  /** agy conversation id to restore via `session/load`; null opens a new one. */
  resumeProviderSessionId?: string | null;
  /** Spawns with `--dangerously-skip-permissions` (bypass modes). */
  skipPermissions?: boolean;
};

export type AcpManagerEvents = {
  /** The engine process died; in-flight runs must settle from this. */
  onSessionExit: (appSessionId: string, info: { code: number | null; signal: NodeJS.Signals | null }) => void;
};

/** Idle minutes after which an idle session's process is recycled; 0 keeps it forever. */
function readIdleRecycleMs(): number {
  const minutes = Number(process.env.CLOUDCLI_ANTIGRAVITY_ACP_IDLE_MINUTES ?? '10');
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return minutes * 60_000;
}

type ManagedSession = {
  appSessionId: string;
  handle: AcpSessionHandle;
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
};

export class AntigravityAcpSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly idleMs = readIdleRecycleMs();

  constructor(
    private readonly events: AcpManagerEvents,
    /** Absolute engine executable path, resolved by the runtime (tryResolveEnginePath). */
    private readonly enginePath: string,
  ) {}

  /**
   * Returns the resident session for the app session, spawning or resuming
   * one when needed. A turn-in-flight session cannot be acquired twice: the
   * chat gateway queues a session's messages, and an interleaved
   * `session/prompt` would corrupt the engine's turn.
   */
  async acquire(appSessionId: string, options: AcpAcquireOptions): Promise<AcpSessionHandle> {
    const existing = this.sessions.get(appSessionId);
    if (existing) {
      if (existing.busy) {
        throw new Error(`antigravity session ${appSessionId} is busy with another turn`);
      }
      if (existing.handle.client.isClosed()) {
        this.destroy(appSessionId);
      } else {
        this.touch(appSessionId);
        return existing.handle;
      }
    }

    await ensureAcpManagedDataDir(options.cwd);

    const spawnArgs = ['acp', '--app-data-dir', ACP_APP_DATA_DIR_NAME];
    if (options.skipPermissions) spawnArgs.push('--dangerously-skip-permissions');
    // Parity with the print runtime: only an explicitly requested directory
    // becomes a declared agy workspace via --add-dir (the spawn cwd alone is
    // not enough for the engine to operate there).
    spawnArgs.push('--add-dir', options.cwd);

    const client = new AntigravityAcpClient({
      enginePath: this.enginePath,
      args: spawnArgs,
      cwd: options.cwd,
      onDiagnostic: (line) => console.debug(`[AntigravityAcp] ${line}`),
    });

    client.whenExit().then((info) => {
      const session = this.sessions.get(appSessionId);
      if (session?.handle.client === client) {
        this.destroy(appSessionId);
      }
      this.events.onSessionExit(appSessionId, info);
    }).catch(() => {
      // whenExit never rejects; kept for symmetry.
    });

    try {
      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });

      let handle: AcpSessionHandle;
      const resumeId = options.resumeProviderSessionId ?? null;
      if (resumeId) {
        try {
          const loaded = readObjectRecord(await client.request('session/load', {
            sessionId: resumeId,
            cwd: options.cwd,
            mcpServers: [],
          }));
          handle = this.toHandle(client, loaded, 'resumed');
        } catch (error) {
          // A lost or foreign conversation id must not brick the session:
          // fall back to a fresh conversation and let the runtime mark it.
          console.warn(`[AntigravityAcp] session/load failed for ${resumeId}; opening a fresh conversation:`, error);
          const opened = readObjectRecord(await client.request('session/new', { cwd: options.cwd, mcpServers: [] }));
          handle = this.toHandle(client, opened, 'restarted');
        }
      } else {
        const opened = readObjectRecord(await client.request('session/new', { cwd: options.cwd, mcpServers: [] }));
        handle = this.toHandle(client, opened, 'started');
      }

      const session: ManagedSession = { appSessionId, handle, busy: false, idleTimer: null };
      this.sessions.set(appSessionId, session);
      this.armIdleTimer(appSessionId);
      return handle;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  /** Marks a turn in flight so the idle recycler keeps the process. */
  setBusy(appSessionId: string, busy: boolean): void {
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    session.busy = busy;
    if (!busy) this.touch(appSessionId);
    else this.clearIdleTimer(session);
  }

  /** Delivers `session/cancel`, the engine's abort for the in-flight turn. */
  cancelTurn(appSessionId: string): boolean {
    const session = this.sessions.get(appSessionId);
    if (!session || session.handle.client.isClosed()) return false;
    session.handle.client.notify('session/cancel', { sessionId: session.handle.sessionId });
    return true;
  }

  /** Registers a handler on the session's client (permission bridge). */
  handleServerRequests(appSessionId: string, method: string, handler: AcpServerRequestHandler): void {
    this.sessions.get(appSessionId)?.handle.client.handleServerRequest(method, handler);
  }

  /** Subscribes to notifications of a resident session. */
  onNotification(appSessionId: string, subscriber: (notification: AcpNotification) => void): () => void {
    return this.sessions.get(appSessionId)?.handle.client.onNotification(subscriber) ?? (() => {});
  }

  /** Kills one session's process immediately. */
  destroy(appSessionId: string): void {
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    this.sessions.delete(appSessionId);
    this.clearIdleTimer(session);
    session.handle.client.close();
  }

  /** Kills every resident process (shutdown / provider reload). */
  destroyAll(): void {
    for (const appSessionId of [...this.sessions.keys()]) this.destroy(appSessionId);
  }

  /** Live session count, for tests and diagnostics. */
  get size(): number {
    return this.sessions.size;
  }

  private toHandle(
    client: AntigravityAcpClient,
    payload: Record<string, unknown> | null,
    continuity: AcpSessionHandle['continuity'],
  ): AcpSessionHandle {
    const sessionId = readOptionalString(payload?.sessionId) ?? '';
    if (!sessionId) {
      throw new AcpConnectionClosedError('agy acp returned no sessionId', -32000);
    }
    const modes = readObjectRecord(payload?.modes);
    const modeList = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
    const models = readObjectRecord(payload?.models);
    const modelList = Array.isArray(models?.availableModels) ? models.availableModels : [];
    return {
      client,
      sessionId,
      currentModeId: readOptionalString(modes?.currentModeId) ?? null,
      availableModeIds: modeList
        .map((mode) => readOptionalString(readObjectRecord(mode)?.id))
        .filter((id): id is string => Boolean(id)),
      currentModelId: readOptionalString(models?.currentModelId) ?? null,
      availableModelIds: modelList
        .map((model) => readOptionalString(readObjectRecord(model)?.modelId))
        .filter((id): id is string => Boolean(id)),
      continuity,
    };
  }

  private touch(appSessionId: string): void {
    const session = this.sessions.get(appSessionId);
    if (!session || this.idleMs <= 0) return;
    this.clearIdleTimer(session);
    this.armIdleTimer(appSessionId);
  }

  private armIdleTimer(appSessionId: string): void {
    if (this.idleMs <= 0) return;
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    session.idleTimer = setTimeout(() => {
      // A busy session must never be recycled; the runtime clears the flag
      // when its turn settles, so a lingering busy here is a bug — skip and
      // let the next activity re-arm.
      if (session.busy) return;
      console.info(`[AntigravityAcp] Recycling idle session process ${appSessionId}`);
      this.destroy(appSessionId);
    }, this.idleMs);
    session.idleTimer.unref?.();
  }

  private clearIdleTimer(session: ManagedSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }
}

/** Settings-path export for tests. */
export const acpManagedSettingsPathForTests = () => path.join(managedDataDirPath(), 'settings.json');
