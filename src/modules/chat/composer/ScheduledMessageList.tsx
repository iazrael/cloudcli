import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock, Repeat, X } from 'lucide-react';

import type { ScheduledJob, ScheduledMessage } from '@/shared/types';
import { describeSchedule } from '@/modules/scheduled-jobs';

type ScheduledMessageListProps = {
  scheduledMessages: ScheduledMessage[];
  /** Recurring jobs bound to this session, shown alongside the one-off sends. */
  scheduledJobs: ScheduledJob[];
  onCancel: (id: string) => void;
  onDeleteJob: (id: string) => void;
};

/**
 * Rendered by ChatComposer above the input, so a message waiting to be sent —
 * or a recurring task bound to this session — is visible where it applies, and
 * can be called off.
 *
 * Failed ones are shown too: a message that did not go is exactly the thing a
 * user needs to know about, and the server records why. Dismissing one goes
 * through the same cancel endpoint, so it stays gone across reloads.
 */
export function ScheduledMessageList({
  scheduledMessages,
  scheduledJobs,
  onCancel,
  onDeleteJob,
}: ScheduledMessageListProps) {
  const { t } = useTranslation('chat');
  const { t: tScheduled } = useTranslation('scheduled');
  const visible = scheduledMessages.filter(
    (message) => message.status === 'pending' || message.status === 'failed',
  );
  const visibleJobs = scheduledJobs.filter((job) => job.enabled);

  if (visible.length === 0 && visibleJobs.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto mb-2 flex max-w-[54.25rem] flex-col gap-1.5">
      {visibleJobs.map((job) => {
        // A one-off has no expression worth reading; its instant is the whole
        // schedule. Either way the banner is only shown while it is enabled,
        // so a completed one-off drops out on the next refresh.
        const description = describeSchedule(job.cronExpression);
        const scheduleText = job.runAt
          ? tScheduled('composer.boundOnce', { when: new Date(job.runAt).toLocaleString() })
          : tScheduled('composer.boundJob', {
            schedule: tScheduled(description.key, description.params),
            when: new Date(job.nextRunAt).toLocaleString(),
          });

        return (
          <div
            key={job.id}
            className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs"
          >
            <Repeat className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground">{scheduleText}</p>
              <p className="mt-0.5 truncate text-foreground">{job.prompt}</p>
            </div>
            <button
              type="button"
              onClick={() => onDeleteJob(job.id)}
              title={tScheduled('job.delete')}
              aria-label={tScheduled('job.delete')}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-red-500"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      {visible.map((message) => {
        const isFailed = message.status === 'failed';

        return (
          <div
            key={message.id}
            className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
              isFailed
                ? 'border-red-500/30 bg-red-500/10'
                : 'border-border/60 bg-muted/40'
            }`}
          >
            {isFailed ? (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
            ) : (
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground">
                {isFailed
                  ? t('schedule.failed', { reason: message.failureReason ?? '' })
                  : t('schedule.pending', { when: new Date(message.scheduledFor).toLocaleString() })}
              </p>
              <p className="mt-0.5 truncate text-foreground">{message.content}</p>
            </div>
            <button
              type="button"
              onClick={() => onCancel(message.id)}
              title={isFailed ? t('schedule.dismiss') : t('schedule.cancel')}
              aria-label={isFailed ? t('schedule.dismiss') : t('schedule.cancel')}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
