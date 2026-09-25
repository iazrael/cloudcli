import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/shared/ui';
import { api, readApiJson } from '@/shared/api';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';

type ScheduledJobsSettings = {
  enabled: boolean;
};

type ScheduledJobsProviderRegistration = {
  provider: string;
  created: boolean;
  error?: string;
};

type ScheduledJobsStatus = {
  enabled: boolean;
  available: boolean;
  mcpServerName: string;
  providers: ScheduledJobsProviderRegistration[] | null;
  message: string;
};

/**
 * Rendered by Settings for the "scheduled" tab: the global switch for recurring
 * tasks. On means agents can manage tasks over MCP and the workspace's
 * Scheduled tab and composer repeat entry are visible; off means tasks stop
 * firing and the bridge is unregistered from every engine.
 */
export default function ScheduledJobsSettingsTab() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<ScheduledJobsSettings | null>(null);
  const [status, setStatus] = useState<ScheduledJobsStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    const response = await api.scheduledJobs.settings();
    const data = await readApiJson<{ data: { settings: ScheduledJobsSettings } }>(response);
    setSettings(data.data.settings);
  }, []);

  const loadStatus = useCallback(async () => {
    const response = await api.scheduledJobs.status();
    const data = await readApiJson<{ data: ScheduledJobsStatus }>(response);
    setStatus(data.data);
  }, []);

  useEffect(() => {
    setError(null);
    setIsLoading(true);
    void Promise.all([loadSettings(), loadStatus()])
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : t('scheduledJobsSettings.loadFailed'));
      })
      .finally(() => setIsLoading(false));
  }, [loadSettings, loadStatus, t]);

  const updateSettings = async (next: Partial<ScheduledJobsSettings>) => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.scheduledJobs.saveSettings(next);
      const data = await readApiJson<{ data: { settings: ScheduledJobsSettings } }>(response);
      setSettings(data.data.settings);
      // The workspace shell and composer listen for this instead of polling.
      window.dispatchEvent(new Event('scheduledJobsSettingsChanged'));
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scheduledJobsSettings.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const syncMcp = async () => {
    setIsSyncing(true);
    setError(null);
    try {
      const response = await api.scheduledJobs.syncMcp();
      await readApiJson(response);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scheduledJobsSettings.syncFailed'));
    } finally {
      setIsSyncing(false);
    }
  };

  const enabled = settings?.enabled === true;

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('scheduledJobsSettings.sectionTitle')}
        description={t('scheduledJobsSettings.sectionDescription')}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t('scheduledJobsSettings.enableLabel')}
            description={t('scheduledJobsSettings.enableDescription')}
          >
            {isLoading && !settings ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <SettingsToggle
                checked={enabled}
                onChange={(value) => void updateSettings({ enabled: value })}
                ariaLabel={t('scheduledJobsSettings.enableAriaLabel')}
                disabled={isSaving}
              />
            )}
          </SettingsRow>

          <div className="space-y-4 px-4 py-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-md border border-border px-2 py-1">
                {t('scheduledJobsSettings.statusPrefix')}: {isLoading && !status
                  ? t('scheduledJobsSettings.checking')
                  : enabled
                    ? t('scheduledJobsSettings.enabled')
                    : t('scheduledJobsSettings.disabled')}
              </span>
              {enabled && status?.providers && (
                <>
                  <span className="rounded-md border border-border px-2 py-1">
                    {t('scheduledJobsSettings.mcpLabel')}: {status.mcpServerName}
                  </span>
                  {status.providers.map((registration) => (
                    <span
                      key={registration.provider}
                      title={registration.error}
                      className={`rounded-md border px-2 py-1 ${
                        registration.created
                          ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                          : 'border-red-500/30 text-red-500'
                      }`}
                    >
                      {registration.provider}: {registration.created
                        ? t('scheduledJobsSettings.providerRegistered')
                        : t('scheduledJobsSettings.providerFailed')}
                    </span>
                  ))}
                </>
              )}
            </div>

            {enabled && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="min-w-0 text-sm text-muted-foreground">
                  {t('scheduledJobsSettings.mcpDescription')}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void syncMcp()}
                  disabled={isSyncing}
                  className="flex-shrink-0"
                >
                  {isSyncing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {isSyncing ? t('scheduledJobsSettings.syncing') : t('scheduledJobsSettings.syncMcp')}
                </Button>
              </div>
            )}

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
                {error}
              </div>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
