import { sweepDerivedAssets, sweepUnreferencedUploads } from '@/modules/assets/index.js';
import {
  appConfigDb,
  getConnection,
  getDatabasePath,
  scheduledMessagesDb,
  sessionDraftsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import type { ArchivedSessionRow } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import { AppError, measurePathBytes } from '@/shared/utils.js';

/**
 * Storage cleanup options. Used by provider.routes and the settings tab.
 */
export type SessionsStorageCleanupSettings = {
  enabled: boolean;
  retentionDays: number;
  /** Permanently deletes eligible conversations instead of only their derived data. */
  purgeConversations: boolean;
};

/** What one cleanup pass did. Stored so the settings tab can show it. */
export type SessionsStorageCleanupReport = {
  ranAt: string;
  retentionDays: number;
  purgeConversations: boolean;
  sessionsCleaned: number;
  sessionsDeleted: number;
  uploadsDeleted: number;
  bytesFreed: number;
  skipped: number;
  failed: number;
  /** A few distinct reasons, without message content, for the settings tab and logs. */
  errors: string[];
};

/** What a cleanup would do now, for either mode. Changes nothing. */
export type SessionsStorageCleanupPreview = {
  cutoff: string;
  sessions: number;
  skipped: number;
  artifactBytes: number;
  purgeableSessions: number;
  purgeBytes: number;
  /** True when some sizes could not be measured, so the byte totals are low. */
  partial: boolean;
};

type SessionsCleanupDependencies = {
  listProviders: () => string[];
  resolveSessions: (provider: string) => IProviderSessions;
  runtime: {
    hasSessionWork: (sessionId: string) => boolean;
    closeSessionAdmission: (sessionId: string) => void;
    openSessionAdmission: (sessionId: string) => void;
  };
  deleteSession: (sessionId: string) => Promise<unknown>;
  sweepDerivedAssets: typeof sweepDerivedAssets;
  sweepUnreferencedUploads: typeof sweepUnreferencedUploads;
  now: () => Date;
};

type RunOptions = {
  /** Required for a pass that permanently deletes conversations. */
  confirmPurge?: boolean;
  backupDatabase?: () => Promise<void>;
};

export const DEFAULT_STORAGE_CLEANUP_SETTINGS: SessionsStorageCleanupSettings = {
  enabled: false,
  retentionDays: 30,
  purgeConversations: false,
};

/**
 * The offered windows. One and three days stay out: with auto-archive on they
 * would leave almost no history.
 */
export const STORAGE_CLEANUP_RETENTION_OPTIONS: readonly number[] = [7, 14, 30, 60, 90];

const SETTINGS_KEY = 'sessions_storage_cleanup_settings';
const REPORT_KEY = 'sessions_storage_cleanup_last_report';
const BACKUP_KEY = 'sessions_storage_cleanup_backup_path';

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 10 * 60 * 1000;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ZCode's reference check blocks its engine for a full scan of message parts,
 * so one pass makes one bounded call and the next pass takes the rest.
 */
const MAX_PURGED_SESSIONS_PER_RUN = 200;

const MAX_REPORTED_ERRORS = 5;

const nativeIdOf = (row: ArchivedSessionRow) => row.provider_session_id || row.session_id;

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Backs up through SQLite so a live database copies consistently. */
async function backupApplicationDatabase(now: Date): Promise<void> {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const target = `${getDatabasePath()}.bak.storage-cleanup-${stamp}`;
  await getConnection().backup(target);
  appConfigDb.set(BACKUP_KEY, target);
}

/**
 * Keeps only rows whose deletion cannot harm a surviving session: nothing that
 * stays forks from them, and nothing that stays shares their engine data. Runs
 * to a fixed point because dropping a row can strand its own parent.
 */
function withoutSurvivorDependencies(rows: ArchivedSessionRow[]): ArchivedSessionRow[] {
  const links = sessionsDb.listForkLinks();
  const purgeable = new Map(rows.map((row) => [row.session_id, row]));
  const nativeOwners = new Map<string, string[]>();
  for (const { session_id: id, provider, provider_session_id: nativeId } of sessionsDb.listNativeSessionRefs()) {
    const key = `${provider}:${nativeId ?? id}`;
    nativeOwners.set(key, [...(nativeOwners.get(key) ?? []), id]);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const { session_id: child, forked_from_session_id: parent } of links) {
      if (purgeable.has(parent) && !purgeable.has(child)) {
        purgeable.delete(parent);
        changed = true;
      }
    }
    for (const row of [...purgeable.values()]) {
      const owners = nativeOwners.get(`${row.provider}:${nativeIdOf(row)}`) ?? [];
      if (owners.some((owner) => !purgeable.has(owner))) {
        purgeable.delete(row.session_id);
        changed = true;
      }
    }
  }
  return rows.filter((row) => purgeable.has(row.session_id));
}

/**
 * Takes one pass's bounded batch, forks before parents. Forks sort newest, so a
 * plain cut would keep the parent and leave its fork for later, and the batch
 * would have to drop that parent again on every pass.
 */
function takeBatch(rows: ArchivedSessionRow[]): ArchivedSessionRow[] {
  const parents = new Set(sessionsDb.listForkLinks().map((link) => link.forked_from_session_id));
  const leavesFirst = [
    ...rows.filter((row) => !parents.has(row.session_id)),
    ...rows.filter((row) => parents.has(row.session_id)),
  ];
  return withoutSurvivorDependencies(leavesFirst.slice(0, MAX_PURGED_SESSIONS_PER_RUN));
}

/**
 * Builds the cleanup with its collaborators passed in, so destructive paths can
 * be tested against fakes. Consumers use `sessionsStorageCleanupService`.
 */
export function createSessionsStorageCleanupService(deps: SessionsCleanupDependencies) {
  let isRunning = false;
  let schedulerTimer: ReturnType<typeof setInterval> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;

  const cutoffFor = (retentionDays: number) => new Date(deps.now().getTime() - retentionDays * DAY_MS);

  /** Splits the old archived sessions into those a pass may touch and those it must not. */
  const listEligible = (cutoff: Date) => {
    const candidates = sessionsDb.listArchivedSessionsOlderThanCutoff(cutoff.toISOString());
    const known = new Set(deps.listProviders());
    const waiting = new Set([
      ...sessionDraftsDb.listScopesWithQueuedMessage(),
      ...scheduledMessagesDb.listSessionIdsWithPending(),
    ]);
    const eligible = candidates.filter((row) => (
      // A row from a removed engine cannot be cleaned and must not stop the rest.
      known.has(row.provider)
      && !waiting.has(row.session_id)
      && !deps.runtime.hasSessionWork(row.session_id)
    ));
    return { eligible, skipped: candidates.length - eligible.length };
  };

  /** Measures each row's permanent deletion, keyed by application id. */
  const measureRows = async (rows: ArchivedSessionRow[]) => {
    const sizes = new Map<string, number>();
    let partial = false;
    for (const provider of new Set(rows.map((row) => row.provider))) {
      const group = rows.filter((row) => row.provider === provider);
      const sessions = deps.resolveSessions(provider);
      try {
        const native = await sessions.measureSessionStorage?.(group.map(nativeIdOf));
        for (const row of group) {
          const transcriptBytes = row.jsonl_path ? await measurePathBytes(row.jsonl_path) : 0;
          sizes.set(row.session_id, native?.get(nativeIdOf(row)) ?? transcriptBytes);
        }
      } catch {
        partial = true;
      }
    }
    return { sizes, partial };
  };

  /** Runs one session's artifact cleanup with its admission closed, so no turn starts mid-delete. */
  const cleanArtifacts = async (row: ArchivedSessionRow, report: SessionsStorageCleanupReport, fail: (reason: string) => void) => {
    const sessions = deps.resolveSessions(row.provider);
    deps.runtime.closeSessionAdmission(row.session_id);
    try {
      if (deps.runtime.hasSessionWork(row.session_id)) {
        report.skipped += 1;
        return;
      }
      if (sessions.cleanupSessionArtifacts) {
        report.bytesFreed += await sessions.cleanupSessionArtifacts(nativeIdOf(row));
        report.sessionsCleaned += 1;
      }
    } catch (error) {
      fail(`artifacts of ${row.session_id}: ${describeError(error)}`);
    } finally {
      deps.runtime.openSessionAdmission(row.session_id);
    }
  };

  const deleteRow = async (row: ArchivedSessionRow, bytes: number, report: SessionsStorageCleanupReport, fail: (reason: string) => void) => {
    try {
      await deps.deleteSession(row.session_id);
      report.sessionsDeleted += 1;
      report.bytesFreed += bytes;
    } catch (error) {
      fail(`delete ${row.session_id}: ${describeError(error)}`);
    }
  };

  /**
   * Re-reads eligibility right before an irreversible step. A pass can spend
   * minutes between listing and deleting, and in that time the user may restore
   * or pin a session, or send it a message; those sessions must survive.
   */
  const currentlyPurgeable = async (rows: ArchivedSessionRow[], report: SessionsStorageCleanupReport) => {
    const { eligible } = listEligible(cutoffFor(service.getSettings().retentionDays));
    const stillEligible = new Set(withoutSurvivorDependencies(eligible).map((row) => row.session_id));
    const current = rows.filter((row) => stillEligible.has(row.session_id));
    report.skipped += rows.length - current.length;
    return current;
  };

  /** Lets the engine decide per session; only what it reports deleted loses its row. */
  const purgeThroughEngine = async (
    provider: string,
    rows: ArchivedSessionRow[],
    report: SessionsStorageCleanupReport,
    fail: (reason: string) => void,
  ) => {
    const sessions = deps.resolveSessions(provider);
    let result;
    // No turn may start between the last eligibility check and the engine's delete.
    rows.forEach((row) => deps.runtime.closeSessionAdmission(row.session_id));
    try {
      const current = await currentlyPurgeable(rows, report);
      if (current.length === 0) return true;
      result = await sessions.purgeSessions!(current.map(nativeIdOf));
      rows = current;
    } catch (error) {
      fail(`${provider} purge: ${describeError(error)}`);
      return false;
    } finally {
      rows.forEach((row) => deps.runtime.openSessionAdmission(row.session_id));
    }
    const bytesById = new Map(result.deleted.map(({ sessionId, bytes }) => [sessionId, bytes]));
    const keptIds = new Set(result.kept.map(({ sessionId }) => sessionId));
    report.skipped += keptIds.size;
    for (const { sessionId, code } of result.failed) {
      fail(`${provider} purge of ${sessionId ?? 'a session'}: ${code}`);
    }
    const failedIds = new Set(result.failed.map(({ sessionId }) => sessionId));
    for (const row of rows) {
      const id = nativeIdOf(row);
      if (bytesById.has(id)) {
        await deleteRow(row, bytesById.get(id)!, report, fail);
      } else if (!keptIds.has(id) && !failedIds.has(id)) {
        // An engine that says nothing about a session has not deleted it.
        fail(`${provider} purge gave no result for ${row.session_id}`);
      }
    }
    return true;
  };

  /** Returns false when any engine's data may remain unaccounted for, which stops the upload sweep. */
  const purgeConversations = async (
    rows: ArchivedSessionRow[],
    report: SessionsStorageCleanupReport,
    fail: (reason: string) => void,
  ) => {
    let allEnginesAnswered = true;
    for (const provider of new Set(rows.map((row) => row.provider))) {
      const group = rows.filter((row) => row.provider === provider);
      if (deps.resolveSessions(provider).purgeSessions) {
        allEnginesAnswered = await purgeThroughEngine(provider, group, report, fail) && allEnginesAnswered;
        continue;
      }
      const current = await currentlyPurgeable(group, report);
      const { sizes } = await measureRows(current);
      for (const row of current) {
        await deleteRow(row, sizes.get(row.session_id) ?? 0, report, fail);
      }
    }
    return allEnginesAnswered;
  };

  const sweepUploads = async (cutoff: Date, report: SessionsStorageCleanupReport, fail: (reason: string) => void) => {
    const providers = deps.listProviders();
    const missing = providers.filter((provider) => !deps.resolveSessions(provider).listStorageRoots);
    if (missing.length > 0) {
      fail(`upload sweep skipped: no storage roots for ${missing.join(', ')}`);
      return;
    }
    try {
      const referenceRoots = [
        ...providers.flatMap((provider) => deps.resolveSessions(provider).listStorageRoots!()),
        getDatabasePath(),
        // Recent drafts can live only in the write-ahead log.
        `${getDatabasePath()}-wal`,
      ];
      const { files, bytes } = await deps.sweepUnreferencedUploads({ cutoffMs: cutoff.getTime(), referenceRoots });
      report.uploadsDeleted = files;
      report.bytesFreed += bytes;
    } catch (error) {
      fail(`upload sweep: ${describeError(error)}`);
    }
  };

  const service = {
    getSettings(): SessionsStorageCleanupSettings {
      const raw = appConfigDb.get(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_STORAGE_CLEANUP_SETTINGS };
      try {
        const parsed = JSON.parse(raw) as Partial<SessionsStorageCleanupSettings>;
        return {
          enabled: parsed.enabled === true,
          retentionDays: STORAGE_CLEANUP_RETENTION_OPTIONS.includes(parsed.retentionDays as number)
            ? parsed.retentionDays as number
            : DEFAULT_STORAGE_CLEANUP_SETTINGS.retentionDays,
          // Only an exact true counts as consent to delete.
          purgeConversations: parsed.purgeConversations === true,
        };
      } catch {
        return { ...DEFAULT_STORAGE_CLEANUP_SETTINGS };
      }
    },

    updateSettings(
      partial: Partial<SessionsStorageCleanupSettings> & { confirmPurge?: boolean },
    ): SessionsStorageCleanupSettings {
      const current = service.getSettings();
      const purgeAfter = partial.purgeConversations ?? current.purgeConversations;
      // Consent was given for the old scope: anything that deletes more asks again.
      const widensPurge = purgeAfter && (
        !current.purgeConversations
        || (partial.retentionDays !== undefined && partial.retentionDays < current.retentionDays)
        || (partial.enabled === true && !current.enabled)
      );
      if (widensPurge && !partial.confirmPurge) {
        throw new AppError('Deleting conversations must be confirmed.', {
          code: 'STORAGE_CLEANUP_CONFIRMATION_REQUIRED',
          statusCode: 400,
        });
      }
      const next: SessionsStorageCleanupSettings = {
        enabled: partial.enabled ?? current.enabled,
        retentionDays: partial.retentionDays ?? current.retentionDays,
        purgeConversations: partial.purgeConversations ?? current.purgeConversations,
      };
      appConfigDb.set(SETTINGS_KEY, JSON.stringify(next));
      return next;
    },

    getLastReport(): SessionsStorageCleanupReport | null {
      const raw = appConfigDb.get(REPORT_KEY);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as SessionsStorageCleanupReport;
      } catch {
        return null;
      }
    },

    async preview(): Promise<SessionsStorageCleanupPreview> {
      const cutoff = cutoffFor(service.getSettings().retentionDays);
      const { eligible, skipped } = listEligible(cutoff);
      let artifactBytes = (await deps.sweepDerivedAssets({ cutoffMs: cutoff.getTime(), dryRun: true })).bytes;
      let partial = false;
      for (const row of eligible) {
        try {
          artifactBytes += await deps.resolveSessions(row.provider)
            .cleanupSessionArtifacts?.(nativeIdOf(row), { dryRun: true }) ?? 0;
        } catch {
          partial = true;
        }
      }
      const purgeable = withoutSurvivorDependencies(eligible);
      const measured = await measureRows(purgeable);
      const measuredBytes = [...measured.sizes.values()].reduce((total, value) => total + value, 0);
      return {
        cutoff: cutoff.toISOString(),
        sessions: eligible.length,
        skipped,
        artifactBytes,
        purgeableSessions: purgeable.length,
        purgeBytes: artifactBytes + measuredBytes,
        partial: partial || measured.partial,
      };
    },

    async run(options: RunOptions = {}): Promise<SessionsStorageCleanupReport> {
      const settings = service.getSettings();
      if (settings.purgeConversations && !options.confirmPurge) {
        throw new AppError('Deleting conversations must be confirmed.', {
          code: 'STORAGE_CLEANUP_CONFIRMATION_REQUIRED',
          statusCode: 400,
        });
      }
      if (isRunning) {
        throw new AppError('A storage cleanup is already running.', {
          code: 'STORAGE_CLEANUP_RUNNING',
          statusCode: 409,
        });
      }

      isRunning = true;
      const report: SessionsStorageCleanupReport = {
        ranAt: deps.now().toISOString(),
        retentionDays: settings.retentionDays,
        purgeConversations: settings.purgeConversations,
        sessionsCleaned: 0,
        sessionsDeleted: 0,
        uploadsDeleted: 0,
        bytesFreed: 0,
        skipped: 0,
        failed: 0,
        errors: [],
      };
      const fail = (reason: string) => {
        report.failed += 1;
        if (report.errors.length < MAX_REPORTED_ERRORS) report.errors.push(reason);
        console.warn(`[SessionsStorageCleanup] ${reason}`);
      };

      try {
        const cutoff = cutoffFor(settings.retentionDays);
        const { eligible, skipped } = listEligible(cutoff);
        report.skipped = skipped;

        for (const row of eligible) {
          await cleanArtifacts(row, report, fail);
        }
        const derived = await deps.sweepDerivedAssets({ cutoffMs: cutoff.getTime() });
        report.bytesFreed += derived.bytes;

        if (settings.purgeConversations) {
          const purgeable = withoutSurvivorDependencies(eligible);
          report.skipped += eligible.length - purgeable.length;
          const batch = takeBatch(purgeable);
          try {
            if (batch.length > 0 && !appConfigDb.get(BACKUP_KEY)) {
              await (options.backupDatabase ?? (() => backupApplicationDatabase(deps.now())))();
            }
            if (await purgeConversations(batch, report, fail)) {
              await sweepUploads(cutoff, report, fail);
            }
          } catch (error) {
            fail(`purge stopped: ${describeError(error)}`);
          }
        }

        appConfigDb.set(REPORT_KEY, JSON.stringify(report));
        console.log(
          `[SessionsStorageCleanup] cleaned ${report.sessionsCleaned}, deleted ${report.sessionsDeleted}, `
          + `uploads ${report.uploadsDeleted}, freed ${report.bytesFreed} bytes, `
          + `skipped ${report.skipped}, failed ${report.failed}`,
        );
        return report;
      } finally {
        isRunning = false;
      }
    },

    /** Runs a pass when enabled and a full day has passed, so restarts do not repeat it. */
    async runIfDue(): Promise<boolean> {
      if (!service.getSettings().enabled) return false;
      const lastRun = service.getLastReport()?.ranAt;
      if (lastRun && deps.now().getTime() - new Date(lastRun).getTime() < RUN_INTERVAL_MS) return false;
      // The stored setting is the consent for scheduled passes.
      await service.run({ confirmPurge: true });
      return true;
    },

    startScheduler(): void {
      if (schedulerTimer) return;
      const check = () => {
        service.runIfDue().catch((error: unknown) => {
          console.error('[SessionsStorageCleanup] Scheduled run failed:', error);
        });
      };
      startupTimer = setTimeout(() => {
        startupTimer = null;
        check();
      }, STARTUP_DELAY_MS);
      schedulerTimer = setInterval(check, CHECK_INTERVAL_MS);
      startupTimer.unref?.();
      schedulerTimer.unref?.();
    },

    stopScheduler(): void {
      if (startupTimer) clearTimeout(startupTimer);
      if (schedulerTimer) clearInterval(schedulerTimer);
      startupTimer = null;
      schedulerTimer = null;
    },
  };

  return service;
}

/** Used by provider.routes (settings, preview, manual run) and server/index.ts (scheduler). */
export const sessionsStorageCleanupService = createSessionsStorageCleanupService({
  // Read on use: these modules import each other, so none is ready at load time.
  listProviders: () => providerRegistry.listProviders().map((provider) => provider.id),
  resolveSessions: (provider) => providerRegistry.resolveProvider(provider).sessions,
  runtime: {
    hasSessionWork: (sessionId) => providerRuntimeService.hasSessionWork(sessionId),
    closeSessionAdmission: (sessionId) => providerRuntimeService.closeSessionAdmission(sessionId),
    openSessionAdmission: (sessionId) => providerRuntimeService.openSessionAdmission(sessionId),
  },
  deleteSession: (sessionId) => sessionsService.deleteOrArchiveSessionById(sessionId, {
    force: true,
    deletedFromDisk: true,
  }),
  sweepDerivedAssets,
  sweepUnreferencedUploads,
  now: () => new Date(),
});
