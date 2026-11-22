/**
 * Antigravity ACP Session Manager
 *
 * One resident `agy acp` process per antigravity session, kept alive across
 * turns so the engine can push question/permission requests and background
 * task completions while no turn is in flight (docs/design/agyACP运行时.md).
 *
 * Processes spawn against the user's own Antigravity data directory
 * (`~/.gemini/antigravity-cli`), so conversations stay resumable from the
 * terminal and the session index stays the one the sidebar reads. The one
 * requirement is that `toolPermission` in its settings.json is not
 * `always-proceed` — the engine never emits `session/request_permission`
 * under it, which would leave the card bridge dead. The spawn prep rewrites
 * exactly that one value when found (read-merge-write, everything else
 * preserved; the engine's own default without the key asks, which is what
 * the cards need); mode-level behaviour is per session via
 * `session/set_mode`, so `--mode auto` usage stays hands-off.
 *
 * Conversation continuity survives process restarts: agy's ACP session ids
 * are its conversation ids, and `session/load` restores them. A failed load
 * fails the turn so the app session keeps its conversation mapping.
 *
 * @module antigravity-acp-session-manager
 */

import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { readObjectRecord, readOptionalString, sanitizeLeafDirectoryName } from '@/shared/utils.js';

import { getAntigravityAcpDataRoot, getAntigravityDataRoot } from './antigravity-data-root.js';
import { buildAntigravitySubprocessEnv } from './antigravity-subprocess-env.js';
import {
  AntigravityAcpClient,
  AcpConnectionClosedError,
} from './antigravity-acp-client.js';

const TRUSTED_WORKSPACES_LIMIT = 40;
let settingsWrite = Promise.resolve();

/** Updates the native settings pin before spawn. Also used by the settings tests. */
export function ensureAcpPermissionsPinned(cwd: string): Promise<void> {
  const dir = getAntigravityDataRoot();
  const write = settingsWrite.then(() => updatePinnedSettings(dir, cwd));
  // One failed update must not poison the queue for later sessions.
  settingsWrite = write.catch(() => {});
  return write;
}

async function updatePinnedSettings(dir: string, cwd: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    const current = readObjectRecord(JSON.parse(await fsp.readFile(settingsPath, 'utf8')));
    if (!current) throw new Error('Antigravity ACP settings must be a JSON object');
    settings = current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // The engine's default (no key) asks, and 'strict' asks; the only value
  // that kills the card bridge is 'always-proceed'. Intervene on that one
  // value and leave every other choice — including the key's absence — to
  // the user.
  if (settings.toolPermission === 'always-proceed') {
    console.info(`[AntigravityAcp] settings.json toolPermission 'always-proceed' suppresses every permission request; pinning it to 'request-review' (the ACP card bridge requires it).`);
    settings.toolPermission = 'request-review';
  }
  const trusted = Array.isArray(settings.trustedWorkspaces)
    ? settings.trustedWorkspaces.filter((entry): entry is string => typeof entry === 'string')
    : [];
  settings.trustedWorkspaces = [...trusted.filter((entry) => entry !== cwd), cwd].slice(-TRUSTED_WORKSPACES_LIMIT);
  const temporaryPath = path.join(dir, `.settings-${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fsp.rename(temporaryPath, settingsPath);
  } finally {
    await fsp.rm(temporaryPath, { force: true });
  }
}

async function hasNativeConversation(dataRoot: string, sessionId: string): Promise<boolean> {
  const base = path.join(dataRoot, 'conversations', sessionId);
  try {
    if ((await fsp.stat(`${base}.db`)).isFile()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    return (await fsp.stat(base)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

async function checkResumeSource(sessionId: string): Promise<void> {
  const safeId = sanitizeLeafDirectoryName(sessionId, 'Antigravity session ID');
  if (safeId === '.') throw new Error('Invalid Antigravity session ID.');
  // agy 1.5.14 acknowledges loads for missing IDs. The session is only
  // usable if its native conversation is present in the shared data root
  // (print and ACP conversations live in the same store now). Conversations
  // from the retired managed directory are history-only: their files are not
  // in this store, and loading one would falsely succeed then fail at
  // prompt time.
  if (await hasNativeConversation(getAntigravityDataRoot(), safeId)) return;
  if (await hasNativeConversation(getAntigravityAcpDataRoot(), safeId)) {
    throw new Error('This Antigravity conversation was created in the retired managed directory; its history stays readable, but resuming needs a new conversation.');
  }
  throw new Error(`Antigravity conversation ${safeId} was not found in the Antigravity data directory.`);
}

/** Session identity and configuration used by the runtime after it acquires a turn. */
type AcpSessionHandle = {
  client: AntigravityAcpClient;
  /** agy conversation id (equals the ACP session id). */
  sessionId: string;
  availableModeIds: string[];
  currentModelId: string | null;
  /** The engine's settable model ids (tier-suffixed families included). */
  availableModelIds: string[];
  continuity: 'resumed' | 'started';
};

type AcpAcquireOptions = {
  cwd: string;
  /** agy conversation id to restore via `session/load`; null opens a new one. */
  resumeProviderSessionId?: string | null;
  /** Spawns with `--dangerously-skip-permissions` (bypass modes). */
  skipPermissions?: boolean;
};

type AcpManagerEvents = {
  onSessionExit: (appSessionId: string, info: { code: number | null; signal: NodeJS.Signals | null }, client: AntigravityAcpClient) => void;
  hasPendingCards?: (appSessionId: string) => boolean;
};

function readIdleRecycleMs(): number {
  const minutes = Number(process.env.CLOUDCLI_ANTIGRAVITY_ACP_IDLE_MINUTES ?? '10');
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(minutes * 60_000, 2_147_483_647);
}

type ManagedSession = {
  client: AntigravityAcpClient;
  cwd: string;
  skipPermissions: boolean;
  handle?: AcpSessionHandle;
  busy: boolean;
  backgroundCommands: Set<string>;
  idleTimer?: NodeJS.Timeout;
  cancelTimer?: NodeJS.Timeout;
};

/** Owns process lifetime and turn reservations for the Antigravity runtime. */
export class AntigravityAcpSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly opening = new Map<string, AbortController>();
  private readonly idleMs = readIdleRecycleMs();
  private closed = false;

  constructor(
    private readonly events: AcpManagerEvents,
    private readonly enginePath: string,
  ) {}

  /** Reserves one turn before any asynchronous startup or replacement. */
  async acquire(appSessionId: string, options: AcpAcquireOptions): Promise<AcpSessionHandle> {
    if (this.closed) throw new Error('Antigravity ACP is shutting down');
    const existing = this.sessions.get(appSessionId);
    if (existing?.busy || this.opening.has(appSessionId)) {
      throw new Error(`Antigravity session ${appSessionId} is busy with another turn`);
    }

    const skipPermissions = options.skipPermissions === true;
    const resumeId = existing?.handle?.sessionId ?? options.resumeProviderSessionId;
    if (existing && !existing.client.isClosed()) {
      const matching = existing.cwd === options.cwd && existing.skipPermissions === skipPermissions;
      if (this.events.hasPendingCards?.(appSessionId)) {
        throw new Error('Antigravity is waiting for a pending card. Answer it before sending another message.');
      }
      if (matching && existing.handle) {
        existing.busy = true;
        this.clearIdleTimer(existing);
        return existing.handle;
      }
      if (existing.backgroundCommands.size > 0) {
        throw new Error('Antigravity cannot change the workspace or startup permissions while background commands are running. Retry after they finish.');
      }
    }

    const opening = new AbortController();
    this.opening.set(appSessionId, opening);
    try {
      if (existing) await this.stopAndWait(existing);
      opening.signal.throwIfAborted();
      if (resumeId) await checkResumeSource(resumeId);
      opening.signal.throwIfAborted();
      await ensureAcpPermissionsPinned(options.cwd);
      opening.signal.throwIfAborted();

      const spawnArgs = ['acp', '--add-dir', options.cwd];
      if (skipPermissions) spawnArgs.push('--dangerously-skip-permissions');
      const client = new AntigravityAcpClient({
        enginePath: this.enginePath,
        args: spawnArgs,
        cwd: options.cwd,
        env: buildAntigravitySubprocessEnv(),
        onDiagnostic: (line) => console.debug(`[AntigravityAcp] ${line}`),
      });
      const session: ManagedSession = { client, cwd: options.cwd, skipPermissions, busy: true, backgroundCommands: new Set() };
      this.sessions.set(appSessionId, session);
      void client.whenExit().then((info) => {
        if (this.sessions.get(appSessionId) !== session) return;
        this.sessions.delete(appSessionId);
        this.clearIdleTimer(session);
        clearTimeout(session.cancelTimer);
        this.events.onSessionExit(appSessionId, info, client);
      });

      client.handleServerRequest('session/request_permission', () => ({ outcome: { outcome: 'cancel' } }));
      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      const workspace = { cwd: options.cwd, mcpServers: [] };
      const payload = readObjectRecord(resumeId
        ? await client.request('session/load', { ...workspace, sessionId: resumeId })
        : await client.request('session/new', workspace));
      opening.signal.throwIfAborted();
      if (client.isClosed()) throw new Error('Antigravity ACP closed during setup');
      session.handle = this.toHandle(client, payload, resumeId);
      this.trackBackgroundCommands(appSessionId, session, session.handle.sessionId);
      return session.handle;
    } catch (error) {
      const failed = this.sessions.get(appSessionId);
      if (failed && failed !== existing) {
        failed.busy = false;
        failed.client.close();
      }
      throw error;
    } finally {
      this.opening.delete(appSessionId);
    }
  }

  /** Releases a turn only if this exact handle still owns the resident process. */
  release(appSessionId: string, handle: AcpSessionHandle): void {
    const session = this.sessions.get(appSessionId);
    if (!session || session.handle !== handle) return;
    clearTimeout(session.cancelTimer);
    session.cancelTimer = undefined;
    session.busy = false;
    this.armIdleTimer(appSessionId, session);
  }

  /** Cancels a foreground turn or an in-progress acquisition. */
  cancelTurn(appSessionId: string): boolean {
    const opening = this.opening.get(appSessionId);
    const session = this.sessions.get(appSessionId);
    if (opening) {
      opening.abort();
      session?.client.close();
      return true;
    }
    if (!session?.handle || !session.busy || session.client.isClosed()) return false;
    session.client.notify('session/cancel', { sessionId: session.handle.sessionId });
    session.cancelTimer ??= setTimeout(() => session.client.close(), 5_000);
    session.cancelTimer.unref();
    return true;
  }

  /** Stops a resident process. Its entry stays reserved until it exits. */
  destroy(appSessionId: string): void {
    this.opening.get(appSessionId)?.abort();
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    this.clearIdleTimer(session);
    clearTimeout(session.cancelTimer);
    session.client.close();
  }

  /** Cancels acquisitions and closes every process during server shutdown. */
  async destroyAll(): Promise<void> {
    this.closed = true;
    for (const opening of this.opening.values()) opening.abort();
    await Promise.all([...this.sessions.values()].map((session) => this.stopAndWait(session)));
  }

  /** Live process count observed by the session manager tests. */
  get size(): number {
    return this.sessions.size;
  }

  private async stopAndWait(session: ManagedSession): Promise<void> {
    this.clearIdleTimer(session);
    clearTimeout(session.cancelTimer);
    session.client.close();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.client.whenExit(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Antigravity ACP did not exit after termination')), 5_000);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private trackBackgroundCommands(appSessionId: string, session: ManagedSession, sessionId: string): void {
    session.client.onNotification(({ method, params }) => {
      if (method !== 'session/update') return;
      const payload = readObjectRecord(params);
      if (payload?.sessionId !== sessionId) return;
      const update = readObjectRecord(payload.update);
      const callId = readOptionalString(update?.toolCallId);
      if (!callId || !update) return;
      const kind = update.sessionUpdate;
      if (kind !== 'tool_call' && kind !== 'tool_call_update') return;
      const status = update.status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        if (session.backgroundCommands.delete(callId)) this.armIdleTimer(appSessionId, session);
        return;
      }
      const input = readObjectRecord(update.args ?? update.rawInput);
      if (update.name === 'run_command' && input?.IsDaemon === true) {
        session.backgroundCommands.add(callId);
        this.clearIdleTimer(session);
      }
    });
  }

  private toHandle(
    client: AntigravityAcpClient,
    payload: Record<string, unknown> | null,
    resumeId?: string | null,
  ): AcpSessionHandle {
    const reportedId = readOptionalString(payload?.sessionId);
    const sessionId = reportedId ?? resumeId;
    if (!payload || !sessionId || (resumeId && reportedId && reportedId !== resumeId)) {
      throw new AcpConnectionClosedError('agy acp returned an invalid session identity', -32000);
    }
    const modes = readObjectRecord(payload?.modes);
    const modeList = Array.isArray(modes?.availableModes) ? modes.availableModes : [];
    const models = readObjectRecord(payload?.models);
    const modelList = Array.isArray(models?.availableModels) ? models.availableModels : [];
    return {
      client,
      sessionId,
      availableModeIds: modeList
        .map((mode) => readOptionalString(readObjectRecord(mode)?.id))
        .filter((id): id is string => Boolean(id)),
      currentModelId: readOptionalString(models?.currentModelId) ?? null,
      availableModelIds: modelList
        .map((model) => readOptionalString(readObjectRecord(model)?.modelId))
        .filter((id): id is string => Boolean(id)),
      continuity: resumeId ? 'resumed' : 'started',
    };
  }

  private armIdleTimer(appSessionId: string, session: ManagedSession): void {
    this.clearIdleTimer(session);
    if (this.idleMs <= 0 || session.busy || session.client.isClosed() || session.backgroundCommands.size > 0) return;
    session.idleTimer = setTimeout(() => {
      if (this.events.hasPendingCards?.(appSessionId)) {
        this.armIdleTimer(appSessionId, session);
        return;
      }
      console.info(`[AntigravityAcp] Recycling idle session process ${appSessionId}`);
      this.destroy(appSessionId);
    }, this.idleMs);
    session.idleTimer.unref();
  }

  private clearIdleTimer(session: ManagedSession): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }
}
