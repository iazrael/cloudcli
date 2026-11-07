import { useCallback, useEffect, useState } from 'react';
import { HardDrive, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { api, readApiJson } from '@/shared/api';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';

type CleanupSettings = {
  enabled: boolean;
  retentionDays: number;
  purgeConversations: boolean;
};

type CleanupReport = {
  ranAt: string;
  bytesFreed: number;
  sessionsCleaned: number;
  sessionsDeleted: number;
  skipped: number;
  failed: number;
};

type CleanupPreview = {
  sessions: number;
  artifactBytes: number;
  purgeableSessions: number;
  purgeBytes: number;
  partial: boolean;
};

/** GET .../settings: the stored settings plus whether a pass is running now. */
type CleanupState = {
  settings: CleanupSettings;
  lastReport: CleanupReport | null;
  running: boolean;
  /** Why the last pass broke off, if it did. */
  error: string | null;
};

type SettingsChange = Partial<CleanupSettings> & { confirmPurge?: boolean };

/** An irreversible action waiting for its second click. */
type PendingConfirmation =
  | { kind: 'enablePurge' }
  | { kind: 'runPurge' }
  | { kind: 'widenPurge'; change: SettingsChange }
  | null;

const RETENTION_OPTIONS = [7, 14, 30, 60, 90];

/** One pass deletes at most this many conversations, matching the server's batch. */
const MAX_PURGED_SESSIONS_PER_RUN = 200;

/** A pass runs in the background on the server; the tab checks on it this often. */
const RUN_POLL_INTERVAL_MS = 2000;

const CONFIRM_TITLE_KEYS = {
  enablePurge: 'purgeConfirmTitle',
  runPurge: 'runConfirmTitle',
  widenPurge: 'widenConfirmTitle',
} as const;

const readData = async <T,>(response: Response): Promise<T> => (
  (await readApiJson<{ data: T }>(response)).data
);

const formatBytes = (bytes: number) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
};

/** Rendered by the sessions settings tab to configure and run the storage cleanup. */
export default function SessionsStorageCleanup() {
  const { t } = useTranslation('settings');
  // The server owns these; null until the first load finishes.
  const [settings, setSettings] = useState<CleanupSettings | null>(null);
  // Result of the last pass, shown so a scheduled run is visible at all.
  const [lastReport, setLastReport] = useState<CleanupReport | null>(null);
  // What a pass would do now; refetched whenever the window changes.
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  // Which irreversible action is waiting for the second click.
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    try {
      setPreview(await readData<CleanupPreview>(await api.providers.previewStorageCleanup()));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await readData<CleanupState>(await api.providers.storageCleanupSettings());
        setSettings(loaded.settings);
        setLastReport(loaded.lastReport);
        // A pass started earlier, or from another device, is still followed to its end.
        setIsRunning(loaded.running);
        // Measuring asks every engine, so it waits until the feature is in use.
        if (loaded.settings.enabled || loaded.settings.purgeConversations) await loadPreview();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [loadPreview]);

  const save = async (change: SettingsChange) => {
    setIsSaving(true);
    setErrorMessage(null);
    try {
      setSettings(await readData<CleanupSettings>(await api.providers.updateStorageCleanupSettings(change)));
      if (change.retentionDays !== undefined) await loadPreview();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  // Follows a running pass until the server reports it finished.
  useEffect(() => {
    if (!isRunning) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await readData<CleanupState>(await api.providers.storageCleanupSettings());
        if (cancelled) return;
        if (status.running) {
          timer = setTimeout(() => void poll(), RUN_POLL_INTERVAL_MS);
          return;
        }
        setLastReport(status.lastReport);
        setErrorMessage(status.error);
        setIsRunning(false);
        void loadPreview();
      } catch {
        // A dropped poll, say from a phone waking up, says nothing about the pass; ask again.
        if (!cancelled) timer = setTimeout(() => void poll(), RUN_POLL_INTERVAL_MS);
      }
    };
    timer = setTimeout(() => void poll(), RUN_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isRunning, loadPreview]);

  const run = async () => {
    setIsRunning(true);
    setErrorMessage(null);
    try {
      await readApiJson(await api.providers.runStorageCleanup({ confirmPurge: Boolean(settings?.purgeConversations) }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setIsRunning(false);
    }
  };

  const confirm = () => {
    const action = pendingConfirmation;
    setPendingConfirmation(null);
    if (action?.kind === 'enablePurge') void save({ purgeConversations: true, confirmPurge: true });
    if (action?.kind === 'runPurge') void run();
    if (action?.kind === 'widenPurge') void save({ ...action.change, confirmPurge: true });
  };

  /** Saves a change, stopping first when it would delete more than was agreed to. */
  const requestChange = (change: Pick<CleanupSettings, 'retentionDays'> | Pick<CleanupSettings, 'enabled'>) => {
    const widens = settings?.purgeConversations && (
      ('retentionDays' in change && change.retentionDays < settings.retentionDays)
      || ('enabled' in change && change.enabled && !settings.enabled)
    );
    if (widens) setPendingConfirmation({ kind: 'widenPurge', change });
    else void save(change);
  };

  if (!settings) {
    return errorMessage
      ? <div className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">{errorMessage}</div>
      : null;
  }

  const purgeableCount = preview?.purgeableSessions ?? 0;

  return (
    <SettingsSection title={t('sessions.storageCleanup.title')}>
      <SettingsCard>
        <SettingsRow
          label={t('sessions.storageCleanup.enableLabel')}
          description={t('sessions.storageCleanup.enableDescription')}
        >
          <SettingsToggle
            checked={settings.enabled}
            onChange={(enabled) => {
              requestChange({ enabled });
              if (enabled) void loadPreview();
            }}
            ariaLabel={t('sessions.storageCleanup.enableLabel')}
            disabled={isSaving}
          />
        </SettingsRow>

        <div className="border-t border-border/60 px-4 py-4">
          <div className="text-sm font-medium text-foreground">{t('sessions.storageCleanup.retentionLabel')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('sessions.storageCleanup.retentionDescription')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {RETENTION_OPTIONS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => requestChange({ retentionDays: days })}
                disabled={isSaving}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  settings.retentionDays === days
                    ? 'border-primary bg-primary/10 text-primary shadow-sm'
                    : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                {t('sessions.storageCleanup.days', { count: days })}
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-border/60 px-4 py-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={settings.purgeConversations}
              disabled={isSaving}
              onChange={(event) => {
                if (event.target.checked) {
                  setPendingConfirmation({ kind: 'enablePurge' });
                  void loadPreview();
                } else {
                  void save({ purgeConversations: false });
                }
              }}
              className="mt-0.5 h-4 w-4 rounded border-border accent-destructive"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">{t('sessions.storageCleanup.purgeLabel')}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t('sessions.storageCleanup.purgeDescription')}</span>
            </span>
          </label>
        </div>

        <Dialog
          open={pendingConfirmation !== null}
          onOpenChange={(open) => {
            if (!open) setPendingConfirmation(null);
          }}
        >
          {pendingConfirmation && (
            // Above the settings modal, which sits at z-[9999].
            <DialogContent
              wrapperClassName="z-[10000]"
              className="w-[calc(100%-2rem)] max-w-sm p-5"
              aria-describedby="storage-cleanup-confirm-body"
            >
              <DialogTitle className="not-sr-only text-base font-semibold text-destructive">
                {t(`sessions.storageCleanup.${CONFIRM_TITLE_KEYS[pendingConfirmation.kind]}`)}
              </DialogTitle>
              <p id="storage-cleanup-confirm-body" className="mt-2 text-sm text-foreground">
                {pendingConfirmation.kind === 'enablePurge' && t('sessions.storageCleanup.purgeConfirmBody', { count: purgeableCount })}
                {pendingConfirmation.kind === 'runPurge' && t('sessions.storageCleanup.runConfirmBody', {
                  count: Math.min(purgeableCount, MAX_PURGED_SESSIONS_PER_RUN),
                })}
                {pendingConfirmation.kind === 'widenPurge' && t('sessions.storageCleanup.widenConfirmBody')}
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setPendingConfirmation(null)}>
                  {t('sessions.storageCleanup.cancel')}
                </Button>
                <Button variant="destructive" size="sm" onClick={confirm}>
                  {t('sessions.storageCleanup.purgeConfirmButton')}
                </Button>
              </div>
            </DialogContent>
          )}
        </Dialog>

        <div className="border-t border-border/60 p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t('sessions.storageCleanup.runTitle')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('sessions.storageCleanup.runDescription')}</div>
              {!preview && (
                <button
                  type="button"
                  onClick={() => void loadPreview()}
                  className="mt-2 text-xs font-medium text-primary hover:underline"
                >
                  {t('sessions.storageCleanup.previewButton')}
                </button>
              )}
              {preview && (
                <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  <div>
                    {t('sessions.storageCleanup.previewArtifacts', {
                      count: preview.sessions,
                      size: formatBytes(preview.artifactBytes),
                    })}
                  </div>
                  <div>
                    {t('sessions.storageCleanup.previewPurge', {
                      count: preview.purgeableSessions,
                      size: formatBytes(preview.purgeBytes),
                    })}
                  </div>
                  {preview.partial && <div>{t('sessions.storageCleanup.previewPartial')}</div>}
                </div>
              )}
            </div>
            <Button
              onClick={() => {
                if (settings.purgeConversations) {
                  setPendingConfirmation({ kind: 'runPurge' });
                  void loadPreview();
                } else {
                  void run();
                }
              }}
              disabled={isRunning}
              className="flex items-center gap-2 self-start sm:self-auto"
            >
              {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />}
              {t('sessions.storageCleanup.runButton')}
            </Button>
          </div>

          {isRunning && (
            <div className="mt-3 text-xs text-muted-foreground">{t('sessions.storageCleanup.runningHint')}</div>
          )}

          {!isRunning && lastReport && (
            <div className="mt-3 text-xs text-muted-foreground">
              {t('sessions.storageCleanup.lastRun', {
                time: new Date(lastReport.ranAt).toLocaleString(),
                size: formatBytes(lastReport.bytesFreed),
                cleaned: lastReport.sessionsCleaned,
                deleted: lastReport.sessionsDeleted,
                skipped: lastReport.skipped,
                failed: lastReport.failed,
              })}
            </div>
          )}

          {errorMessage && (
            <div className="mt-3 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">{errorMessage}</div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
