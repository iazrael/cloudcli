/**
 * OpenCode Service Supervisor
 *
 * Owns one long-lived `opencode serve --stdio --port 0` child per cloudcli
 * process — the same private-server recipe the CLI's own `run --standalone`
 * uses (verified against v2.0.31 source): a random password travels in
 * `OPENCODE_PASSWORD`, the server prints one `{"url":...}` line on stdout when
 * it is listening, and it exits on its own when our end of stdin closes, so a
 * crashed or restarted cloudcli never leaves an orphan behind.
 *
 * `ensureEndpoint` is lazy and idempotent: the first chat send boots the
 * server, later sends reuse it, concurrent sends share one boot, and a server
 * that died is respawned on the next demand with a short backoff.
 *
 * @module opencode-service
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

import { OpenCodeApiClient, type OpenCodeServiceEndpoint } from './opencode-api.client.js';
import { getOpenCodeEngineVersion, tryResolveOpenCodeEnginePath } from './opencode-engine-path.js';

/** Why a boot could not produce an endpoint; the runtime maps these to user-facing errors. */
export type OpenCodeServiceFailureCode =
  | 'not_installed'
  | 'unsupported_version'
  | 'boot_failed'
  | 'boot_timeout';

/**
 * Thrown by `ensureEndpoint` when the service cannot be started.
 *
 * Consumer: opencode runtime (turns the code into the chat error text).
 */
export class OpenCodeServiceError extends Error {
  constructor(readonly code: OpenCodeServiceFailureCode, message: string) {
    super(message);
    this.name = 'OpenCodeServiceError';
  }
}

type SpawnLike = typeof nodeSpawn;

type SupervisorDependencies = {
  spawn?: SpawnLike;
  resolveEnginePath?: () => string | null;
  getEngineVersion?: () => string | null;
  now?: () => number;
  /** Milliseconds to wait for the ready line; default 20s. */
  readyTimeoutMs?: number;
  /** Working directory for the server process; default the user's home. */
  cwd?: string;
};

type LiveServer = {
  child: ChildProcess;
  endpoint: OpenCodeServiceEndpoint;
  bootedAt: number;
};

const DEFAULT_READY_TIMEOUT_MS = 20_000;
/** A server that dies within this window of booting counts as a crash loop. */
const CRASH_LOOP_WINDOW_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;
/** Lines of stderr kept for the failure message when a boot dies early. */
const STDERR_TAIL_LINES = 12;

/**
 * Supervises the cloudcli-owned opencode server.
 *
 * Consumers: opencode runtime (through `opencodeServiceSupervisor`); tests
 * construct their own with a fake `serve` binary.
 */
export class OpenCodeServiceSupervisor {
  private readonly spawn: SpawnLike;
  private readonly resolveEnginePath: () => string | null;
  private readonly getEngineVersion: () => string | null;
  private readonly now: () => number;
  private readonly readyTimeoutMs: number;
  private readonly cwd: string;

  private live: LiveServer | null = null;
  private booting: Promise<OpenCodeServiceEndpoint> | null = null;
  private consecutiveEarlyExits = 0;
  private nextBootAllowedAt = 0;
  private readonly exitListeners = new Set<(endpoint: OpenCodeServiceEndpoint) => void>();
  private shuttingDown = false;

  constructor(dependencies: SupervisorDependencies = {}) {
    this.spawn = dependencies.spawn ?? nodeSpawn;
    this.resolveEnginePath = dependencies.resolveEnginePath ?? tryResolveOpenCodeEnginePath;
    this.getEngineVersion = dependencies.getEngineVersion ?? getOpenCodeEngineVersion;
    this.now = dependencies.now ?? Date.now;
    this.readyTimeoutMs = dependencies.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.cwd = dependencies.cwd ?? os.homedir();
  }

  /** The endpoint of the running server, or null when none is up. */
  currentEndpoint(): OpenCodeServiceEndpoint | null {
    return this.live?.endpoint ?? null;
  }

  /**
   * Returns a reachable endpoint, booting the server when needed. Rejects with
   * `OpenCodeServiceError` when the CLI is missing, too old, or fails to come
   * up; a boot that fails is retried on the next call after the backoff.
   */
  ensureEndpoint(): Promise<OpenCodeServiceEndpoint> {
    if (this.live) {
      return Promise.resolve(this.live.endpoint);
    }
    if (!this.booting) {
      this.booting = this.boot().finally(() => {
        this.booting = null;
      });
    }
    return this.booting;
  }

  /** Fires when the live server exits for any reason (crash, shutdown). */
  onExit(listener: (endpoint: OpenCodeServiceEndpoint) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /** Closes the ownership lease (stdin) and escalates to SIGTERM/SIGKILL if the server lingers. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const live = this.live;
    this.live = null;
    if (!live) {
      return;
    }
    await terminateChild(live.child);
  }

  private async boot(): Promise<OpenCodeServiceEndpoint> {
    this.shuttingDown = false;
    const waitMs = this.nextBootAllowedAt - this.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const enginePath = this.resolveEnginePath();
    if (!enginePath) {
      throw new OpenCodeServiceError(
        'not_installed',
        'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/',
      );
    }
    const version = this.getEngineVersion();
    const major = version ? Number.parseInt(version.split('.')[0] ?? '', 10) : null;
    if (major !== null && Number.isFinite(major) && major < 2) {
      throw new OpenCodeServiceError(
        'unsupported_version',
        `OpenCode CLI ${version} is too old for chat; cloudcli drives the v2 service API. Upgrade to opencode v2.`,
      );
    }

    const password = randomBytes(32).toString('base64url');
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const child = this.spawn(enginePath, ['serve', '--stdio', '--port', '0'], {
      cwd: this.cwd,
      // The explicit entry wins over anything inherited, so a user-exported
      // OPENCODE_PASSWORD cannot shadow the lease credential.
      env: { ...process.env, OPENCODE_PASSWORD: password },
      stdio: ['pipe', 'pipe', 'pipe'],
      // The engine is a console binary on Windows: a console-less parent (pm2)
      // would otherwise get a stray console window for the server's lifetime.
      windowsHide: true,
    });

    const bootedAt = this.now();
    const stderrTail: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const rawLine of chunk.toString().split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        // Cap each line: a giant dump must not pin memory or flood the exit warning.
        stderrTail.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
        if (stderrTail.length > STDERR_TAIL_LINES) {
          stderrTail.shift();
        }
      }
    });

    let endpoint: OpenCodeServiceEndpoint;
    try {
      const url = await readReadyUrl(child, this.readyTimeoutMs);
      endpoint = { url, authorization };
    } catch (error) {
      await terminateChild(child);
      this.recordEarlyExit();
      const detail = stderrTail.length > 0 ? ` (${stderrTail.join(' | ')})` : '';
      if (error instanceof OpenCodeServiceError) {
        throw new OpenCodeServiceError(error.code, `${error.message}${detail}`);
      }
      throw new OpenCodeServiceError(
        'boot_failed',
        `OpenCode service failed to start: ${error instanceof Error ? error.message : String(error)}${detail}`,
      );
    }

    // Keep draining stdout after readiness so later server writes cannot
    // block on a full pipe.
    child.stdout?.on('data', () => {});

    const live: LiveServer = { child, endpoint, bootedAt };
    this.live = live;
    this.consecutiveEarlyExits = 0;
    child.once('exit', (code, signal) => {
      if (this.live === live) {
        this.live = null;
      }
      if (!this.shuttingDown) {
        if (this.now() - bootedAt < CRASH_LOOP_WINDOW_MS) {
          this.recordEarlyExit();
        }
        console.warn(
          `[OpenCode] service exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
          + (stderrTail.length > 0 ? `: ${stderrTail.join(' | ')}` : ''),
        );
      }
      for (const listener of this.exitListeners) {
        try {
          listener(endpoint);
        } catch (listenerError) {
          console.warn('[OpenCode] service exit listener failed:', listenerError);
        }
      }
    });
    return endpoint;
  }

  private recordEarlyExit(): void {
    this.consecutiveEarlyExits += 1;
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.consecutiveEarlyExits - 1));
    this.nextBootAllowedAt = this.now() + backoff;
  }
}

/**
 * The production supervisor: one `opencode serve` child per cloudcli process.
 *
 * Consumers: opencode runtime (the `opencodeRuntime` singleton drives runs
 * through it) and `connectOpenCodeApiClient` below. Sharing one instance is
 * what keeps an edit or fork from booting a second server beside the runtime's.
 */
export const opencodeServiceSupervisor = new OpenCodeServiceSupervisor();

/**
 * A client bound to the production server, booting it when nothing is up.
 *
 * Consumers: opencode sessions provider (edit rewind) and fork provider — the
 * facets that act on a session outside a run.
 */
export async function connectOpenCodeApiClient(): Promise<OpenCodeApiClient> {
  return new OpenCodeApiClient(await opencodeServiceSupervisor.ensureEndpoint());
}

/**
 * Resolves with the URL from the server's first stdout line, or rejects when
 * the process exits or stays silent past the timeout.
 */
function readReadyUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new OpenCodeServiceError('boot_timeout', `OpenCode service did not report readiness within ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as { url?: unknown };
          if (typeof parsed.url === 'string' && parsed.url) {
            finish(() => resolve(parsed.url as string));
            return;
          }
        } catch {
          // Not the ready line (e.g. a log line); keep waiting.
        }
      }
    };
    const onExit = (code: number | null) => {
      finish(() => reject(new Error(`server exited before reporting readiness (code ${code ?? 'null'})`)));
    };
    const onError = (error: Error) => {
      finish(() => reject(error));
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

/** Ends the stdin lease, then SIGTERM after 3s and SIGKILL after 6s if the server is still alive. */
function terminateChild(child: ChildProcess): Promise<void> {
  const alive = () => child.exitCode === null && child.signalCode === null;
  if (!alive()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timers: NodeJS.Timeout[] = [];
    const done = () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      resolve();
    };
    child.once('exit', done);
    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }
    const schedule = (delayMs: number, action: () => void) => {
      const timer = setTimeout(action, delayMs);
      timer.unref?.();
      timers.push(timer);
    };
    schedule(3_000, () => { if (alive()) child.kill('SIGTERM'); });
    schedule(6_000, () => { if (alive()) child.kill('SIGKILL'); });
    // A process that ignores SIGKILL cannot exist; this only guards a lost 'exit'.
    schedule(7_000, done);
  });
}
