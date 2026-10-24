/**
 * Self-update contract served by `GET /api/system/update/status` and started
 * by `POST /api/system/update`.
 *
 * Only a git checkout supervised by PM2 can update itself: the server pulls the
 * branch's upstream, rebuilds, and has PM2 restart it. Every other install gets
 * `supported: false` and a reason, and the UI offers no update action.
 */

/** Why this install cannot update itself; absent when it can. */
export type SystemUpdateUnsupportedReason =
  | 'platform'
  | 'not-git'
  | 'not-pm2'
  | 'no-upstream';

/** One commit on the upstream branch that the local checkout does not have yet. */
export type SystemUpdateCommit = {
  hash: string;
  subject: string;
};

/**
 * Which update the server would run now: `pull` fast-forwards to the upstream
 * and rebuilds; `rebuild` only rebuilds, for a checkout whose HEAD moved past
 * the build the server is running (commits made on this machine).
 */
export type SystemUpdateMode = 'pull' | 'rebuild';

/** Where a started update currently is. `restarting` hands off to the new server, which settles it. */
export type SystemUpdateJobState = 'running' | 'restarting' | 'succeeded' | 'failed';

/** The most recent update run on this machine, persisted across the restart it causes. */
export type SystemUpdateJob = {
  id: string;
  mode: SystemUpdateMode;
  state: SystemUpdateJobState;
  /** The step being run, for progress display (`fetch`, `install`, `build-client`, …). */
  step: string | null;
  startedAt: string;
  finishedAt: string | null;
  fromCommit: string;
  targetCommit: string | null;
  error: string | null;
  /** Last lines of the update log. */
  logTail: string[];
};

/** Everything the UI needs to decide whether to offer an update and how to label it. */
export type SystemUpdateStatus = {
  supported: boolean;
  reason: SystemUpdateUnsupportedReason | null;
  branch: string | null;
  /** The tracked remote branch, e.g. `myfork/main`. */
  upstream: string | null;
  headCommit: string | null;
  remoteCommit: string | null;
  /** Commit the running build was made from; null when the build predates build-info. */
  builtCommit: string | null;
  behind: number;
  ahead: number;
  /** Commits `pull` would bring in, newest first (capped). */
  commits: SystemUpdateCommit[];
  /** Tracked files with uncommitted changes; a dirty tree blocks updating. */
  dirtyFiles: string[];
  /** The update the server would run now, or null when there is nothing to do. */
  availableMode: SystemUpdateMode | null;
  /** Local and upstream both have commits the other lacks; a fast-forward is impossible. */
  diverged: boolean;
  lastFetchedAt: string | null;
  fetchError: string | null;
  job: SystemUpdateJob | null;
};

/** Why `POST /api/system/update` refused to start. */
export type SystemUpdateRefusal =
  | SystemUpdateUnsupportedReason
  | 'dirty'
  | 'diverged'
  | 'up-to-date'
  | 'already-running';
