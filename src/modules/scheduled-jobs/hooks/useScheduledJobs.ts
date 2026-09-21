import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ScheduledJob } from '@/shared/types';

type ScheduledJobFilter = {
  /** Jobs bound to one conversation, for the composer's banner. */
  sessionId?: string | null;
  /** Jobs belonging to one workspace, for the Scheduled tab. */
  projectPath?: string | null;
};

type ScheduledJobDraft = {
  name: string;
  prompt: string;
  sessionMode: 'reuse' | 'new';
  sessionId?: string;
  provider?: string;
  projectPath?: string;
  options?: unknown;
  cronExpression: string;
  timezone: string;
};

type ScheduledJobPatch = {
  name?: string;
  prompt?: string;
  options?: unknown;
  cronExpression?: string;
  timezone?: string;
  sessionMode?: 'reuse' | 'new';
  sessionId?: string;
  enabled?: boolean;
};

/**
 * The scheduled jobs for one scope, plus the mutations the composer and the
 * Scheduled tab share.
 *
 * The server owns the schedule, so this is a plain fetch rather than anything
 * realtime: the list changes when this client creates, edits or removes a job,
 * and it is refetched when the scope changes.
 *
 * Used by the chat composer (session scope) and the Scheduled workspace tab
 * (project scope).
 */
export function useScheduledJobs(filter: ScheduledJobFilter) {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  // Why the last load failed, so the panel can say so instead of showing an
  // empty list that looks like "no jobs".
  const [error, setError] = useState<string | null>(null);

  const scopeKey = `${filter.sessionId ?? ''}|${filter.projectPath ?? ''}`;
  // Which scope the jobs on screen belong to; a fetch that resolves after the
  // user moved on must not paint the old scope's jobs over the new one.
  const activeScopeRef = useRef(scopeKey);

  const refresh = useCallback(async () => {
    try {
      const response = await api.scheduledJobs.list({
        sessionId: filter.sessionId ?? undefined,
        projectPath: filter.projectPath ?? undefined,
      });
      const payload = await readApiJson<{ data: ScheduledJob[] }>(response);
      if (activeScopeRef.current !== scopeKey) {
        return;
      }
      setJobs(Array.isArray(payload.data) ? payload.data : []);
      setError(null);
    } catch (caught) {
      if (activeScopeRef.current !== scopeKey) {
        return;
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (activeScopeRef.current === scopeKey) {
        setLoading(false);
      }
    }
    // `scopeKey` encodes the filter's contents, so a caller passing an inline
    // object does not refetch on every render.
    // eslint-disable-next-line react/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    activeScopeRef.current = scopeKey;
    setLoading(true);
    setJobs([]);
    void refresh();
  }, [refresh, scopeKey]);

  const createJob = useCallback(async (draft: ScheduledJobDraft) => {
    const response = await api.scheduledJobs.create(draft);
    const payload = await readApiJson<{ data: ScheduledJob }>(response);
    await refresh();
    return payload.data;
  }, [refresh]);

  const updateJob = useCallback(async (id: string, patch: ScheduledJobPatch) => {
    const response = await api.scheduledJobs.update(id, patch);
    const payload = await readApiJson<{ data: ScheduledJob }>(response);
    await refresh();
    return payload.data;
  }, [refresh]);

  const removeJob = useCallback(async (id: string) => {
    await readApiJson(await api.scheduledJobs.remove(id));
    await refresh();
  }, [refresh]);

  const runNow = useCallback(async (id: string) => {
    await readApiJson(await api.scheduledJobs.runNow(id));
  }, []);

  return { jobs, loading, error, refresh, createJob, updateJob, removeJob, runNow };
}
