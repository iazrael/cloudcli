import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { APP_VERSION } from '@/shared/constants';
import type { SystemUpdateStatus } from '@/shared/types';

/** Matches the server's fetch throttle (25 min), so each poll sees fresh refs. */
const STATUS_POLL_MS = 30 * 60 * 1000;

/**
 * Used by the sidebar module (update banner + version modal) and the settings
 * module's About tab to learn whether this git checkout can pull new commits or
 * rebuild past its running build. Polls `/api/system/update/status`; `reload`
 * lets the version modal poll faster while an update job runs.
 */
export function useSystemUpdate() {
  // Latest server answer; kept on a failed request so a restarting server does
  // not make the job progress vanish mid-update.
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null);
  // A user-requested check forces a `git fetch`, which can take seconds; the
  // flag disables the button meanwhile.
  const [isChecking, setIsChecking] = useState(false);
  // The server process runs a different version than this bundle was built
  // for: files on disk changed but the process was never restarted.
  const [restartRequired, setRestartRequired] = useState(false);

  const reload = useCallback(async (refresh = false): Promise<SystemUpdateStatus | null> => {
    try {
      const response = await api.system.updateStatus(refresh);
      if (!response.ok) return null;
      const data = (await response.json()) as SystemUpdateStatus;
      setStatus(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  const checkNow = useCallback(async () => {
    setIsChecking(true);
    try {
      return await reload(true);
    } finally {
      setIsChecking(false);
    }
  }, [reload]);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (typeof data.version === 'string' && data.version.length > 0) {
          setRestartRequired(data.version !== APP_VERSION);
        }
      } catch {
        // No restart hint when health is unreachable.
      }
    };
    void fetchHealth();
  }, []);

  useEffect(() => {
    void reload();
    const interval = setInterval(() => void reload(), STATUS_POLL_MS);
    // Coming back to the tab re-reads the status, so a push made elsewhere (or
    // a commit made here) shows up without waiting for the next poll. Cheap:
    // the server still throttles the actual `git fetch`.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [reload]);

  const job = status?.job;
  const isUpdating = job?.state === 'running' || job?.state === 'restarting';
  const updateAvailable = Boolean(status?.supported && status.availableMode);

  return { status, updateAvailable, isUpdating, restartRequired, isChecking, checkNow, reload };
}
