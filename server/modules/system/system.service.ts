import path from 'node:path';

import type {
  SystemUpdateCommit,
  SystemUpdateJob,
  SystemUpdateMode,
  SystemUpdateRefusal,
  SystemUpdateStatus,
  SystemUpdateUnsupportedReason,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type GitResult = { exitCode: number; stdout: string; stderr: string };

type SystemUpdateDependencies = {
  appRoot: string;
  installMode: 'git' | 'npm';
  isPlatform: boolean;
  /** PM2 app name when this server is supervised by PM2, else null. */
  pm2AppName: string | null;
  /** JSON job state shared with `scripts/self-update.mjs`. */
  statePath: string;
  /** Plain-text log the updater appends to. */
  logPath: string;
  runGit(args: string[]): Promise<GitResult>;
  readTextFile(filePath: string): string | null;
  writeTextFile(filePath: string, content: string): void;
  isProcessAlive(pid: number): boolean;
  /** Starts the detached updater; it takes over the job state from here. */
  launchUpdater(mode: SystemUpdateMode): void;
  now(): Date;
};

/** The job as persisted: the public job shape plus the runner's pid, without the log tail. */
type PersistedJob = Omit<SystemUpdateJob, 'logTail'> & { pid: number | null };

/** The UI polls every 30 minutes; fetching a little more eagerly keeps a poll from ever hitting a stale cache. */
const FETCH_INTERVAL_MS = 25 * 60 * 1000;
/** How long a queued job may wait for the runner to record its pid before it counts as lost. */
const LAUNCH_GRACE_MS = 60 * 1000;
const MAX_LISTED_COMMITS = 30;
const MAX_LISTED_DIRTY_FILES = 20;
const LOG_TAIL_LINES = 40;

/**
 * Creates the self-update service used by the system module: it reports whether
 * this git checkout is behind its upstream (or ahead of its running build) and
 * hands a confirmed update to the detached `scripts/self-update.mjs` runner.
 * All process, file and git access is injected so the tests can drive it.
 */
export function createSystemUpdateService(dependencies: SystemUpdateDependencies) {
  const builtCommit = readBuiltCommit();
  let lastFetchedAt: Date | null = null;
  let fetchError: string | null = null;
  let inflightFetch: Promise<void> | null = null;

  settleJobAfterRestart();

  function readBuiltCommit(): string | null {
    const raw = dependencies.readTextFile(path.join(dependencies.appRoot, 'dist', 'build-info.json'));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { commit?: unknown };
      return typeof parsed.commit === 'string' && parsed.commit ? parsed.commit : null;
    } catch {
      return null;
    }
  }

  function readJob(): PersistedJob | null {
    const raw = dependencies.readTextFile(dependencies.statePath);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PersistedJob;
    } catch {
      return null;
    }
  }

  function writeJob(job: PersistedJob): void {
    dependencies.writeTextFile(dependencies.statePath, JSON.stringify(job, null, 2));
  }

  function failJob(job: PersistedJob, error: string): PersistedJob {
    const failed: PersistedJob = {
      ...job,
      state: 'failed',
      step: null,
      error,
      finishedAt: dependencies.now().toISOString(),
    };
    writeJob(failed);
    return failed;
  }

  // The runner's last act is `pm2 restart`, so it cannot see the outcome; the
  // server it restarted records it, judged by whether it booted the target build.
  function settleJobAfterRestart(): void {
    const job = readJob();
    if (!job || job.state !== 'restarting') return;
    if (job.targetCommit && builtCommit === job.targetCommit) {
      writeJob({ ...job, state: 'succeeded', step: null, finishedAt: dependencies.now().toISOString() });
      return;
    }
    failJob(job, `The server restarted on build ${builtCommit ?? 'unknown'} instead of ${job.targetCommit ?? 'unknown'}.`);
  }

  // A runner that died without recording an outcome would otherwise block
  // every later update behind a job that never finishes.
  function currentJob(): PersistedJob | null {
    const job = readJob();
    if (!job || job.state !== 'running') return job;
    if (job.pid !== null) {
      return dependencies.isProcessAlive(job.pid)
        ? job
        : failJob(job, 'The updater exited without reporting a result. See the log below.');
    }
    const queuedFor = dependencies.now().getTime() - Date.parse(job.startedAt);
    return queuedFor > LAUNCH_GRACE_MS ? failJob(job, 'The updater never started.') : job;
  }

  function readLogTail(): string[] {
    const raw = dependencies.readTextFile(dependencies.logPath);
    if (!raw) return [];
    return raw.split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL_LINES);
  }

  function toPublicJob(job: PersistedJob | null): SystemUpdateJob | null {
    if (!job) return null;
    const { pid: _pid, ...publicJob } = job;
    return { ...publicJob, logTail: readLogTail() };
  }

  async function git(args: string[]): Promise<string | null> {
    const result = await dependencies.runGit(args);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async function fetchIfStale(force: boolean): Promise<void> {
    const stale = !lastFetchedAt || dependencies.now().getTime() - lastFetchedAt.getTime() >= FETCH_INTERVAL_MS;
    if (!force && !stale) return;
    // Concurrent status requests share one fetch instead of racing on the same refs.
    inflightFetch ??= (async () => {
      const result = await dependencies.runGit(['fetch', '--quiet']);
      lastFetchedAt = dependencies.now();
      fetchError = result.exitCode === 0 ? null : (result.stderr.trim() || `git fetch exited with code ${result.exitCode}`);
    })().finally(() => {
      inflightFetch = null;
    });
    await inflightFetch;
  }

  function emptyStatus(reason: SystemUpdateUnsupportedReason): SystemUpdateStatus {
    return {
      supported: false,
      reason,
      branch: null,
      upstream: null,
      headCommit: null,
      remoteCommit: null,
      builtCommit,
      behind: 0,
      ahead: 0,
      commits: [],
      dirtyFiles: [],
      availableMode: null,
      diverged: false,
      lastFetchedAt: null,
      fetchError: null,
      job: toPublicJob(currentJob()),
    };
  }

  async function getStatus({ refresh = false }: { refresh?: boolean } = {}): Promise<SystemUpdateStatus> {
    if (dependencies.isPlatform) return emptyStatus('platform');
    if (dependencies.installMode !== 'git') return emptyStatus('not-git');

    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (!upstream) return { ...emptyStatus('no-upstream'), branch };

    await fetchIfStale(refresh);

    const headCommit = await git(['rev-parse', 'HEAD']);
    const remoteCommit = await git(['rev-parse', '@{u}']);
    const [ahead, behind] = ((await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])) ?? '0 0')
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10) || 0);

    const commits: SystemUpdateCommit[] = behind > 0
      ? ((await git(['log', '--format=%h%x09%s', `-n${MAX_LISTED_COMMITS}`, 'HEAD..@{u}'])) ?? '')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const [hash, ...subject] = line.split('\t');
            return { hash, subject: subject.join('\t') };
          })
      : [];

    // Untracked files never block a fast-forward, so only tracked changes count.
    const dirtyFiles = ((await git(['status', '--porcelain', '--untracked-files=no'])) ?? '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3))
      .slice(0, MAX_LISTED_DIRTY_FILES);

    const diverged = ahead > 0 && behind > 0;
    const availableMode: SystemUpdateMode | null = diverged
      ? null
      : behind > 0
        ? 'pull'
        : builtCommit && headCommit && builtCommit !== headCommit
          ? 'rebuild'
          : null;

    const reason: SystemUpdateUnsupportedReason | null = dependencies.pm2AppName ? null : 'not-pm2';
    return {
      supported: reason === null,
      reason,
      branch,
      upstream,
      headCommit,
      remoteCommit,
      builtCommit,
      behind,
      ahead,
      commits,
      dirtyFiles,
      availableMode,
      diverged,
      lastFetchedAt: lastFetchedAt?.toISOString() ?? null,
      fetchError,
      job: toPublicJob(currentJob()),
    };
  }

  function refuse(code: SystemUpdateRefusal, message: string): never {
    throw new AppError(message, { code, statusCode: 409 });
  }

  async function startUpdate(): Promise<{ jobId: string; mode: SystemUpdateMode }> {
    const status = await getStatus({ refresh: true });
    if (!status.supported) {
      refuse(status.reason ?? 'not-git', `This installation cannot update itself (${status.reason}).`);
    }
    if (status.job && (status.job.state === 'running' || status.job.state === 'restarting')) {
      refuse('already-running', 'An update is already running.');
    }
    if (status.dirtyFiles.length > 0) {
      refuse('dirty', 'The checkout has uncommitted changes; commit or stash them first.');
    }
    if (status.diverged) {
      refuse('diverged', `Local commits and ${status.upstream} have diverged; a fast-forward is impossible.`);
    }
    if (!status.availableMode || !status.headCommit) {
      refuse('up-to-date', 'Already up to date.');
    }

    const startedAt = dependencies.now();
    const job: PersistedJob = {
      id: `${startedAt.getTime()}`,
      mode: status.availableMode,
      state: 'running',
      step: 'queued',
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      fromCommit: status.headCommit,
      targetCommit: null,
      error: null,
      pid: null,
    };
    // Written before launching so a status poll right after this request
    // already sees the job, and a second click is refused.
    writeJob(job);
    dependencies.writeTextFile(dependencies.logPath, '');
    try {
      dependencies.launchUpdater(job.mode);
    } catch (error) {
      failJob(job, `Could not start the updater: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    return { jobId: job.id, mode: job.mode };
  }

  return { getStatus, startUpdate };
}
