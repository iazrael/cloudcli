/**
 * Cached CLI installation probe.
 *
 * @module cli-installation-probe
 */

import fs from 'node:fs';
import path from 'node:path';

import spawn from 'cross-spawn';

/**
 * How long an "uninstalled" result stays cached before the next query probes
 * again. A short TTL matters because users legitimately install a CLI right
 * after seeing "not installed" (the onboarding flow walks them through it).
 *
 * Consumers: the CLI auth providers via `createCliInstallationProbe`, and
 * `cli-engine-path` for its negative-cache expiry so both caches share the
 * product-agreed window.
 */
export const DEFAULT_NEGATIVE_PROBE_TTL_MS = 120_000;

/**
 * How long a timed-out probe is trusted as "installed" before the next query
 * probes again. A timeout means the binary exists and launched (a missing one
 * is caught by the PATH check in `probeSpawnAsync`) but did not answer in time — in practice CPU/disk
 * contention right after a server restart, when the initial session sync runs
 * alongside the first status checks. Reporting that as "not installed" would
 * hide the provider for the whole negative TTL.
 *
 * Consumers: `createCliInstallationProbe`, and its tests to step the clock
 * across the window.
 */
export const TIMED_OUT_PROBE_TTL_MS = 10_000;

/**
 * Configuration for one provider's installation probe.
 *
 * Consumers: cursor/claude/codex/opencode auth providers (one module-level
 * probe instance each).
 */
export type CliInstallationProbeConfig = {
  /**
   * Resolves the command to probe on each attempt (not cached): claude needs
   * `resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH)` so env
   * overrides take effect without a server restart.
   */
  command: () => string;
  /** Probe arguments; defaults to a `--version` run, matching the historical
   * check that only counts a CLI as installed when it actually executes. */
  args?: string[];
  /** Probe timeout in milliseconds; defaults to 5000 like the previous
   * synchronous checks. */
  timeoutMs?: number;
  /** How long an "uninstalled" result is cached; defaults to
   * `DEFAULT_NEGATIVE_PROBE_TTL_MS`. */
  negativeTtlMs?: number;
};

/**
 * The probe surface consumed by auth providers' `getStatus()`.
 *
 * Consumers: cursor/claude/codex/opencode auth providers.
 */
export type CliInstallationProbe = {
  isInstalled(): Promise<boolean>;
};

/**
 * One subprocess probe outcome, shaped so the installed check mirrors the
 * fixed `spawnSync` semantics: exit 0 without an error means installed;
 * ENOENT, non-zero exit, and thrown errors mean not installed. A timeout
 * (`timedOut`) means the CLI launched but was too slow to answer.
 */
type ProbeOutcome = {
  error?: Error;
  status: number | null;
  timedOut?: boolean;
};

/**
 * Test seam for `createCliInstallationProbe`: production uses the default
 * asynchronous cross-spawn wrapper, tests stub it to avoid real subprocesses.
 */
export type ProbeSpawn = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<ProbeOutcome>;

const isFile = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * Whether `command` resolves to a file, either as a path or through PATH
 * (plus PATHEXT on Windows).
 *
 * Consumers: `probeSpawnAsync`, to answer "not installed" without spawning.
 * On Windows cross-spawn wraps an unresolvable command in `cmd.exe /c`, so a
 * missing CLI does not fail fast with ENOENT — it waits for cmd to exit, which
 * under startup contention outlasts the probe timeout and would be misread as
 * an installed-but-slow CLI.
 */
const isCommandResolvable = (command: string): boolean => {
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  const bases = path.isAbsolute(command) || /[\\/]/.test(command)
    ? [path.resolve(command)]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  return bases.some((base) => extensions.some((extension) => isFile(base + extension)));
};

const probeSpawnAsync: ProbeSpawn = (command, args, { timeoutMs }) =>
  new Promise((resolve) => {
    if (!isCommandResolvable(command)) {
      resolve({ error: new Error(`${command} not found on PATH`), status: null });
      return;
    }


    let settled = false;
    let childProcess: ReturnType<typeof spawn> | undefined;

    // A hung CLI must not pin the status endpoint; give up and flag the timeout.
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      childProcess?.kill();
      resolve({ error: new Error('installation probe timed out'), status: null, timedOut: true });
    }, timeoutMs);

    try {
      childProcess = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      clearTimeout(timeout);
      settled = true;
      resolve({ error: error as Error, status: null });
      return;
    }

    childProcess.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ error, status: null });
    });

    childProcess.on('close', (status: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status });
    });
  });

/**
 * Creates a cached, asynchronous installation probe for one CLI.
 *
 * Consumers: cursor/claude/codex/opencode auth providers. Caching rules:
 * "installed" is cached for the process lifetime (CLIs are not uninstalled
 * mid-use); "not installed" is cached for `negativeTtlMs` so the status
 * endpoint stops spawning a subprocess per request while still self-healing
 * shortly after the user installs the CLI; a timed-out probe counts as
 * installed for `TIMED_OUT_PROBE_TTL_MS`, then probes again. Concurrent
 * queries during a probe share the in-flight attempt.
 */
export function createCliInstallationProbe(
  config: CliInstallationProbeConfig,
  dependencies: { spawnAsync?: ProbeSpawn; now?: () => number } = {},
): CliInstallationProbe {
  const spawnAsync = dependencies.spawnAsync ?? probeSpawnAsync;
  const now = dependencies.now ?? Date.now;
  const negativeTtlMs = config.negativeTtlMs ?? DEFAULT_NEGATIVE_PROBE_TTL_MS;

  /** Last probe verdict, trusted until `cachedUntil` (`Infinity` for a confirmed install). */
  let cachedInstalled: boolean | null = null;
  let cachedUntil = 0;
  let inFlight: Promise<boolean> | null = null;

  const remember = (installed: boolean, ttlMs: number): boolean => {
    cachedInstalled = installed;
    cachedUntil = now() + ttlMs;
    return installed;
  };

  const isInstalled = (): Promise<boolean> => {
    if (cachedInstalled !== null && now() < cachedUntil) {
      return Promise.resolve(cachedInstalled);
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const outcome = await spawnAsync(
          config.command(),
          config.args ?? ['--version'],
          { timeoutMs: config.timeoutMs ?? 5000 },
        );
        if (outcome.timedOut) {
          return remember(true, TIMED_OUT_PROBE_TTL_MS);
        }
        const installed = !outcome.error && outcome.status === 0;
        return remember(installed, installed ? Infinity : negativeTtlMs);
      } catch {
        // A crashed probe is indistinguishable from a broken install; report
        // not installed and let the negative TTL schedule a retry.
        return remember(false, negativeTtlMs);
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };

  return { isInstalled };
}
