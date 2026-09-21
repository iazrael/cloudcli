import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Loader2, Plus, RefreshCw, X } from 'lucide-react';

import type { LLMProvider, ScheduledJob } from '@/shared/types';
import { useScheduledJobs } from '@/modules/scheduled-jobs/hooks/useScheduledJobs';
import { ScheduledJobForm } from '@/modules/scheduled-jobs/ScheduledJobForm';
import { ScheduledJobList } from '@/modules/scheduled-jobs/ScheduledJobList';
import { ScheduledJobRuns } from '@/modules/scheduled-jobs/ScheduledJobRuns';

type ScheduledJobsPanelProps = {
  projectPath: string;
  /** Opens a run's session in the chat pane; omitted on surfaces without navigation. */
  onNavigateToSession?: (sessionId: string) => void;
};

/**
 * Rendered by the workspace's Scheduled tab: this project's recurring jobs,
 * with create/edit, pause/resume, run-now, delete and run history.
 */
export default function ScheduledJobsPanel({ projectPath, onNavigateToSession }: ScheduledJobsPanelProps) {
  const { t } = useTranslation('scheduled');
  const { jobs, loading, error, createJob, updateJob, removeJob, runNow } = useScheduledJobs({ projectPath });

  // Which form is open: none, creating, or editing one job.
  const [editingJob, setEditingJob] = useState<ScheduledJob | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // A failed row action (pause, delete, run) is reported here instead of
  // disappearing into the console, since it leaves the list unchanged.
  const [actionError, setActionError] = useState<string | null>(null);
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [openHistoryJobId, setOpenHistoryJobId] = useState<string | null>(null);
  // Bumped after "Run now" so the open history refetches and shows the run.
  const [historyToken, setHistoryToken] = useState(0);

  const closeForm = useCallback(() => {
    setIsFormOpen(false);
    setEditingJob(null);
    setFormError(null);
  }, []);

  const handleSave = useCallback(async (input: {
    name: string;
    prompt: string;
    provider: LLMProvider;
    permissionMode: string;
    cronExpression: string;
    timezone: string;
  }) => {
    setSaving(true);
    setFormError(null);
    try {
      if (editingJob) {
        await updateJob(editingJob.id, {
          name: input.name,
          prompt: input.prompt,
          options: { ...editingJob.options, permissionMode: input.permissionMode },
          cronExpression: input.cronExpression,
          timezone: input.timezone,
        });
      } else {
        await createJob({
          name: input.name,
          prompt: input.prompt,
          sessionMode: 'new',
          provider: input.provider,
          projectPath,
          options: { permissionMode: input.permissionMode },
          cronExpression: input.cronExpression,
          timezone: input.timezone,
        });
      }
      closeForm();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }, [closeForm, createJob, editingJob, projectPath, updateJob]);

  const handleToggleEnabled = useCallback(async (job: ScheduledJob) => {
    setActionError(null);
    try {
      await updateJob(job.id, { enabled: !job.enabled });
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [updateJob]);

  const handleRunNow = useCallback(async (job: ScheduledJob) => {
    setActionError(null);
    setRunningJobId(job.id);
    try {
      await runNow(job.id);
      setOpenHistoryJobId(job.id);
      setHistoryToken((token) => token + 1);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningJobId(null);
    }
  }, [runNow]);

  const handleDelete = useCallback(async (job: ScheduledJob) => {
    setActionError(null);
    try {
      await removeJob(job.id);
      if (openHistoryJobId === job.id) {
        setOpenHistoryJobId(null);
      }
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [openHistoryJobId, removeJob]);

  const historyJob = jobs.find((job) => job.id === openHistoryJobId) ?? null;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Clock className="h-4 w-4 text-muted-foreground" />
              {t('panel.title')}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">{t('panel.description')}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditingJob(null);
              setFormError(null);
              setIsFormOpen(true);
            }}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('panel.newJob')}
          </button>
        </div>

        {isFormOpen && (
          <ScheduledJobForm
            projectPath={projectPath}
            editingJob={editingJob}
            saving={saving}
            error={formError}
            onSave={(input) => void handleSave(input)}
            onCancel={closeForm}
          />
        )}

        {(actionError || error) && (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {actionError ?? error}
          </p>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('panel.loading')}
          </div>
        ) : jobs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            {t('panel.empty')}
          </div>
        ) : (
          <ScheduledJobList
            jobs={jobs}
            runningJobId={runningJobId}
            openHistoryJobId={openHistoryJobId}
            onToggleEnabled={(job) => void handleToggleEnabled(job)}
            onRunNow={(job) => void handleRunNow(job)}
            onEdit={(job) => {
              setEditingJob(job);
              setFormError(null);
              setIsFormOpen(true);
            }}
            onDelete={(job) => void handleDelete(job)}
            onToggleHistory={(job) => {
              setOpenHistoryJobId((current) => (current === job.id ? null : job.id));
              setHistoryToken((token) => token + 1);
            }}
          />
        )}

        {historyJob && (
          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('runs.title')} · {historyJob.name}
              </h4>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setHistoryToken((token) => token + 1)}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={t('runs.refresh')}
                  title={t('runs.refresh')}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setOpenHistoryJobId(null)}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={t('runs.close')}
                  title={t('runs.close')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <ScheduledJobRuns
              jobId={historyJob.id}
              refreshToken={historyToken}
              onOpenSession={onNavigateToSession}
            />
          </section>
        )}
      </div>
    </div>
  );
}
