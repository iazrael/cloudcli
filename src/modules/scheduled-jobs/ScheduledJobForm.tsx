import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import type { LLMProvider, ScheduledJob } from '@/shared/types';
import { PROVIDER_FALLBACK_ORDER } from '@/shared/providerCatalogFallback';
import { useProviderCapabilitiesMap } from '@/shared/hooks/useProviderCapabilities';
import {
  buildCronExpression,
  presetForPattern,
  readLocalTimezone,
  readSchedulePattern,
  type SchedulePresetId,
} from '@/modules/scheduled-jobs/utils/schedulePresets';

type ScheduledJobFormProps = {
  projectPath: string;
  /** The job being edited, or null when creating a new one. */
  editingJob: ScheduledJob | null;
  saving: boolean;
  error: string | null;
  onSave: (input: {
    name: string;
    prompt: string;
    provider: LLMProvider;
    permissionMode: string;
    cronExpression: string;
    timezone: string;
  }) => void;
  onCancel: () => void;
};

const PRESET_OPTIONS: SchedulePresetId[] = ['daily', 'weekdays', 'weekly', 'hourly', 'custom'];

/**
 * Rendered by the Scheduled tab to create a job (always `new` mode: a fresh
 * session per run) or edit an existing one's name, prompt, permission mode and
 * schedule.
 */
export function ScheduledJobForm({
  projectPath,
  editingJob,
  saving,
  error,
  onSave,
  onCancel,
}: ScheduledJobFormProps) {
  const { t } = useTranslation('scheduled');
  const { capabilities } = useProviderCapabilitiesMap();

  const providers = useMemo(() => (
    PROVIDER_FALLBACK_ORDER.filter((provider) => !capabilities || capabilities[provider])
  ), [capabilities]);

  const initialPattern = useMemo(
    () => readSchedulePattern(editingJob?.cronExpression ?? '0 9 * * *'),
    [editingJob],
  );

  const [name, setName] = useState(editingJob?.name ?? '');
  const [prompt, setPrompt] = useState(editingJob?.prompt ?? '');
  const [provider, setProvider] = useState<LLMProvider>(
    editingJob?.provider ?? (providers[0] ?? 'claude'),
  );
  const [permissionMode, setPermissionMode] = useState(() => {
    const stored = editingJob?.options.permissionMode;
    return typeof stored === 'string' && stored ? stored : 'bypassPermissions';
  });
  const [preset, setPreset] = useState<SchedulePresetId>(presetForPattern(initialPattern));
  // Hourly has no time input, so its minute is carried in the time field —
  // otherwise editing an existing "at :30" job would quietly reset it to :00.
  const [time, setTime] = useState(() => {
    if (initialPattern.kind === 'hourly') {
      return `00:${String(initialPattern.minute).padStart(2, '0')}`;
    }
    return 'time' in initialPattern ? initialPattern.time : '09:00';
  });
  const [customCron, setCustomCron] = useState(
    initialPattern.kind === 'custom' ? editingJob?.cronExpression ?? '' : '',
  );
  // Validation is only surfaced after a save attempt, so the form does not
  // complain while the user is still typing the first field.
  const [validationError, setValidationError] = useState<string | null>(null);

  const timezone = editingJob?.timezone ?? readLocalTimezone();
  const isReuseJob = editingJob?.sessionMode === 'reuse';
  const capability = capabilities?.[provider];
  const permissionModes = capability?.permissionModes ?? ['default'];
  const supportsNativeScheduling = capability?.supportsNativeScheduling ?? false;

  const submit = () => {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName || !trimmedPrompt) {
      setValidationError(t('form.required'));
      return;
    }

    const cronExpression = buildCronExpression(preset, { time, customExpression: customCron });
    if (cronExpression.split(/\s+/).length !== 5) {
      setValidationError(t('form.invalidCron'));
      return;
    }

    setValidationError(null);
    onSave({
      name: trimmedName,
      prompt: trimmedPrompt,
      provider,
      permissionMode,
      cronExpression,
      timezone,
    });
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h4 className="text-sm font-semibold text-foreground">
        {editingJob ? t('form.editTitle') : t('form.createTitle')}
      </h4>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">{t('form.name')}</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('form.namePlaceholder')}
            className="mt-1 w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">{t('form.provider')}</span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as LLMProvider)}
            disabled={isReuseJob}
            className="mt-1 w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-60"
          >
            {providers.map((candidate) => (
              <option key={candidate} value={candidate}>{candidate}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">{t('form.prompt')}</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t('form.promptPlaceholder')}
          rows={3}
          className="mt-1 w-full resize-y rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">{t('form.permissionMode')}</span>
          <select
            value={permissionMode}
            onChange={(event) => setPermissionMode(event.target.value)}
            className="mt-1 w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground"
          >
            {permissionModes.map((mode) => (
              <option key={mode} value={mode}>{mode}</option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] leading-snug text-muted-foreground/70">
            {t('form.permissionHintUnattended')}
          </span>
        </label>

        <div>
          <span className="text-xs font-medium text-muted-foreground">{t('form.schedule')}</span>
          <div className="mt-1 flex gap-2">
            <select
              value={preset}
              onChange={(event) => setPreset(event.target.value as SchedulePresetId)}
              className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground"
            >
              {PRESET_OPTIONS.map((option) => (
                <option key={option} value={option}>{t(`form.preset.${option}`)}</option>
              ))}
            </select>
            {preset !== 'custom' && preset !== 'hourly' && (
              <input
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                className="w-32 shrink-0 rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground"
              />
            )}
          </div>
          {preset === 'custom' && (
            <>
              <input
                type="text"
                value={customCron}
                onChange={(event) => setCustomCron(event.target.value)}
                placeholder={t('form.cronPlaceholder')}
                className="mt-1 w-full rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono text-sm text-foreground"
              />
              <span className="mt-1 block text-[11px] leading-snug text-muted-foreground/70">
                {t('form.cronHint')}
              </span>
            </>
          )}
          <span className="mt-1 block text-[11px] leading-snug text-muted-foreground/70">
            {t('form.timezone', { timezone })}
          </span>
        </div>
      </div>

      {isReuseJob ? (
        <p className="text-[11px] leading-snug text-muted-foreground/70">{t('form.sessionReuseHint')}</p>
      ) : (
        <p className="text-[11px] leading-snug text-muted-foreground/70">{t('form.sessionNewHint', { projectPath })}</p>
      )}

      {supportsNativeScheduling && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          {t('form.nativeSchedulingHint')}
        </p>
      )}

      {(validationError || error) && (
        <p className="text-sm text-red-500">{validationError ?? error}</p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t('form.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md bg-foreground px-4 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {editingJob ? t('form.save') : t('form.create')}
        </button>
      </div>
    </div>
  );
}
