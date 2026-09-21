import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { History, Loader2, Pencil, Play, Power, Trash2 } from 'lucide-react';

import type { ScheduledJob } from '@/shared/types';
import { cn } from '@/shared/utils';
import { describeSchedule } from '@/modules/scheduled-jobs/utils/schedulePresets';

type ScheduledJobListProps = {
  jobs: ScheduledJob[];
  /** The job whose "Run now" is in flight, so only that button spins. */
  runningJobId: string | null;
  /** The job whose history is expanded below the list. */
  openHistoryJobId: string | null;
  onToggleEnabled: (job: ScheduledJob) => void;
  onRunNow: (job: ScheduledJob) => void;
  onEdit: (job: ScheduledJob) => void;
  onDelete: (job: ScheduledJob) => void;
  onToggleHistory: (job: ScheduledJob) => void;
};

const STATUS_CLASS: Record<string, string> = {
  succeeded: 'text-emerald-500',
  failed: 'text-red-500',
  skipped: 'text-amber-500',
  missed: 'text-muted-foreground',
};

/** Rendered by the Scheduled tab to list one workspace's jobs and their actions. */
export function ScheduledJobList({
  jobs,
  runningJobId,
  openHistoryJobId,
  onToggleEnabled,
  onRunNow,
  onEdit,
  onDelete,
  onToggleHistory,
}: ScheduledJobListProps) {
  const { t } = useTranslation('scheduled');
  // Which row is waiting for a second click before it is deleted; the first
  // click only arms it so a mis-tap cannot remove a task outright.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const describeJobSchedule = (job: ScheduledJob) => {
    const description = describeSchedule(job.cronExpression);
    return t(description.key, description.params);
  };

  return (
    <ul className="space-y-2">
      {jobs.map((job) => {
        const isDeleting = confirmingDeleteId === job.id;
        const isHistoryOpen = openHistoryJobId === job.id;

        return (
          <li
            key={job.id}
            className={cn(
              'rounded-lg border border-border bg-card p-3',
              !job.enabled && 'opacity-60',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{job.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {job.provider}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {job.sessionMode === 'new' ? t('job.newSessionEachRun') : t('job.boundSession')}
                  </span>
                  {!job.enabled && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                      {t('job.paused')}
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground" title={job.prompt}>
                  {job.prompt}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span className="font-mono text-foreground/80">{describeJobSchedule(job)}</span>
                  <span>
                    {job.enabled
                      ? t('job.nextRun', { when: new Date(job.nextRunAt).toLocaleString() })
                      : t('job.paused')}
                  </span>
                  <span className={cn(job.lastStatus ? STATUS_CLASS[job.lastStatus] : undefined)}>
                    {job.lastRunAt
                      ? t('job.lastRun', {
                        when: new Date(job.lastRunAt).toLocaleString(),
                        status: job.lastStatus ? t(`status.${job.lastStatus}`) : '',
                      })
                      : t('job.neverRan')}
                  </span>
                </div>
              </div>

              <div className="flex flex-shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onToggleEnabled(job)}
                  title={job.enabled ? t('job.pause') : t('job.resume')}
                  aria-label={job.enabled ? t('job.pause') : t('job.resume')}
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Power className={cn('h-3.5 w-3.5', job.enabled && 'text-emerald-500')} />
                </button>
                <button
                  type="button"
                  onClick={() => onRunNow(job)}
                  disabled={runningJobId === job.id}
                  title={t('job.runNow')}
                  aria-label={t('job.runNow')}
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                >
                  {runningJobId === job.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(job)}
                  title={t('job.edit')}
                  aria-label={t('job.edit')}
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onToggleHistory(job)}
                  title={t('job.history')}
                  aria-label={t('job.history')}
                  className={cn(
                    'rounded p-1.5 transition-colors hover:bg-muted hover:text-foreground',
                    isHistoryOpen ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <History className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!isDeleting) {
                      setConfirmingDeleteId(job.id);
                      return;
                    }
                    setConfirmingDeleteId(null);
                    onDelete(job);
                  }}
                  title={isDeleting ? t('job.confirmDelete') : t('job.delete')}
                  aria-label={isDeleting ? t('job.confirmDelete') : t('job.delete')}
                  className={cn(
                    'rounded p-1.5 transition-colors',
                    isDeleting
                      ? 'bg-red-50 text-red-500 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30'
                      : 'text-muted-foreground hover:bg-muted hover:text-red-500',
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
