import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Loader2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { ScheduledJobRun } from '@/shared/types';
import { cn } from '@/shared/utils';

type ScheduledJobRunsProps = {
  jobId: string;
  /** Bumped by the panel after "Run now" so the list refetches without a remount. */
  refreshToken: number;
  onOpenSession?: (sessionId: string) => void;
};

const STATUS_CLASS: Record<ScheduledJobRun['status'], string> = {
  running: 'text-sky-500',
  succeeded: 'text-emerald-500',
  failed: 'text-red-500',
  skipped: 'text-amber-500',
  missed: 'text-muted-foreground',
};

/** Rendered by the Scheduled tab under a job to show what each occurrence did. */
export function ScheduledJobRuns({ jobId, refreshToken, onOpenSession }: ScheduledJobRunsProps) {
  const { t } = useTranslation('scheduled');
  const [runs, setRuns] = useState<ScheduledJobRun[]>([]);
  // Kept apart from "no runs yet": a failed fetch must not read as an empty history.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const payload = await readApiJson<{ data: ScheduledJobRun[] }>(await api.scheduledJobs.runs(jobId));
        if (!cancelled) {
          setRuns(Array.isArray(payload.data) ? payload.data : []);
        }
      } catch (error) {
        console.error('Failed to load scheduled job runs:', error);
        if (!cancelled) {
          setRuns([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, refreshToken]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('runs.loading')}
      </div>
    );
  }

  if (runs.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{t('runs.empty')}</p>;
  }

  return (
    <ul className="space-y-1 px-3 py-2">
      {runs.map((run) => (
        <li key={run.id} className="flex items-start gap-2 text-xs">
          <span className={cn('mt-px w-16 shrink-0 font-medium', STATUS_CLASS[run.status])}>
            {t(`status.${run.status}`)}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {new Date(run.startedAt).toLocaleString()}
          </span>
          <span className="shrink-0 text-muted-foreground/60">
            {run.trigger === 'manual' ? t('runs.manual') : t('runs.scheduled')}
          </span>
          {run.error && (
            <span className="min-w-0 flex-1 truncate text-red-500" title={run.error}>
              {run.error}
            </span>
          )}
          {run.sessionId && onOpenSession && (
            <button
              type="button"
              onClick={() => onOpenSession(run.sessionId as string)}
              className="ml-auto inline-flex shrink-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              {t('runs.openSession')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
