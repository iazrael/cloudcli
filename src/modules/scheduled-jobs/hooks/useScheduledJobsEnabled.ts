import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

/**
 * Tracks whether scheduled tasks are enabled in server settings.
 *
 * The switch is global: it gates the workspace tab, the composer's repeat
 * entry, and the agent-facing MCP bridge. Used by the workspace shell and the
 * chat composer; the settings tab dispatches `scheduledJobsSettingsChanged`
 * after a save so every consumer updates without a refetch loop.
 */
export function useScheduledJobsEnabled() {
  const [scheduledJobsEnabled, setScheduledJobsEnabled] = useState(false);

  const loadScheduledJobsSettings = useCallback(async () => {
    try {
      const response = await api.scheduledJobs.settings();
      const data = await response.json();
      setScheduledJobsEnabled(Boolean(
        response.ok
        && data?.success !== false
        && data?.data?.settings?.enabled,
      ));
    } catch {
      setScheduledJobsEnabled(false);
    }
  }, []);

  useEffect(() => {
    void loadScheduledJobsSettings();
    window.addEventListener('scheduledJobsSettingsChanged', loadScheduledJobsSettings);
    return () => window.removeEventListener('scheduledJobsSettingsChanged', loadScheduledJobsSettings);
  }, [loadScheduledJobsSettings]);

  return scheduledJobsEnabled;
}
