import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';

import { cn } from '@/shared/utils';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';
import {
  buildCronExpression,
  readLocalTimezone,
  type SchedulePresetId,
} from '@/modules/scheduled-jobs';

type ScheduleMessagePopoverProps = {
  disabled: boolean;
  onSchedule: (scheduledFor: Date) => void;
  /** Creates a recurring job bound to the current session instead of a one-off message. */
  onScheduleRecurring: (schedule: { cronExpression: string; timezone: string }) => void;
  /** Whether the engine also schedules inside its own session (drives the hint). */
  supportsNativeScheduling: boolean;
  /** Whether the scheduled-tasks feature is on; when off the popover is one-off only. */
  recurringEnabled: boolean;
};

/** Offsets people actually mean when they say "later". */
const QUICK_OFFSETS_MINUTES = [15, 60, 8 * 60, 24 * 60];

const RECURRING_PRESETS: SchedulePresetId[] = ['daily', 'weekdays', 'weekly', 'hourly', 'custom'];

/**
 * Turns the picker's `datetime-local` value into an absolute instant.
 *
 * That input carries no zone, and `new Date(value)` reads it in the browser's
 * — which is what the user meant, since they picked it off their own clock.
 * Converting here means the server stores one unambiguous instant, so the
 * schedule does not move if they are on another device when it fires.
 */
function readLocalDateTime(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toLocalInputValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * Rendered by chat's ChatComposer beside the send button so the message in the
 * box can be sent later — once, or on a recurring schedule bound to this
 * session — instead of now.
 */
export function ScheduleMessagePopover({
  disabled,
  onSchedule,
  onScheduleRecurring,
  supportsNativeScheduling,
  recurringEnabled,
}: ScheduleMessagePopoverProps) {
  const { t } = useTranslation('chat');
  const { t: tScheduled } = useTranslation('scheduled');
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  // Portalled and anchored like the model and permission menus: the composer
  // sits inside the scrolling transcript's stacking context, so a popover
  // positioned inside it is clipped by the message pane.
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);
  // Seeded an hour out, because a picker that opens on "now" is never what
  // scheduling means.
  const [customValue, setCustomValue] = useState(() => toLocalInputValue(new Date(Date.now() + 3_600_000)));
  // Which half of the popover is showing: a one-off send or a recurring task.
  const [mode, setMode] = useState<'once' | 'recurring'>('once');
  const [preset, setPreset] = useState<SchedulePresetId>('daily');
  const [time, setTime] = useState('09:00');
  const [customCron, setCustomCron] = useState('');

  const commit = (scheduledFor: Date) => {
    onSchedule(scheduledFor);
    setIsOpen(false);
  };

  const commitRecurring = () => {
    const cronExpression = buildCronExpression(preset, { time, customExpression: customCron });
    if (cronExpression.split(/\s+/).length !== 5) {
      return;
    }
    onScheduleRecurring({ cronExpression, timezone: readLocalTimezone() });
    setIsOpen(false);
  };

  // A hand-written expression must look like cron before the button enables;
  // the presets always build a valid five-field one.
  const recurringValid = preset !== 'custom' || customCron.trim().split(/\s+/).length === 5;

  const ariaLabel = t('schedule.trigger');
  // With the feature off, the popover keeps its original one-off behavior.
  const showRecurring = recurringEnabled && mode === 'recurring';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground transition-colors',
          disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted hover:text-foreground',
          isOpen && 'text-foreground',
        )}
      >
        <Clock className="h-4 w-4" />
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {recurringEnabled && (
            <div className="flex gap-1 px-2.5 pb-1.5 pt-0.5">
              {(['once', 'recurring'] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => setMode(candidate)}
                  className={cn(
                    'flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                    mode === candidate
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {candidate === 'once' ? tScheduled('composer.once') : tScheduled('composer.recurring')}
                </button>
              ))}
            </div>
          )}

          {!showRecurring ? (
            <>
              <ComposerMenuHeading>{t('schedule.heading')}</ComposerMenuHeading>
              {QUICK_OFFSETS_MINUTES.map((minutes) => (
                <ComposerMenuItem
                  key={minutes}
                  label={t(`schedule.in.${minutes}`)}
                  description={new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  isSelected={false}
                  onSelect={() => commit(new Date(Date.now() + minutes * 60_000))}
                />
              ))}

              <ComposerMenuSeparator />
              <div className="px-2.5 pb-1.5">
                <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="schedule-at">
                  {t('schedule.customLabel')}
                </label>
                <input
                  id="schedule-at"
                  type="datetime-local"
                  value={customValue}
                  onChange={(event) => setCustomValue(event.target.value)}
                  className="mt-1 w-full rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-foreground"
                />
                <button
                  type="button"
                  onClick={() => {
                    const parsed = readLocalDateTime(customValue);
                    if (parsed) commit(parsed);
                  }}
                  className="mt-2 w-full rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  {t('schedule.confirm')}
                </button>
              </div>
            </>
          ) : (
            <>
              <ComposerMenuHeading>{tScheduled('composer.recurringHeading')}</ComposerMenuHeading>
              <div className="space-y-2 px-2.5 pb-2">
                <select
                  value={preset}
                  onChange={(event) => setPreset(event.target.value as SchedulePresetId)}
                  className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs text-foreground"
                >
                  {RECURRING_PRESETS.map((option) => (
                    <option key={option} value={option}>{tScheduled(`form.preset.${option}`)}</option>
                  ))}
                </select>

                {preset !== 'custom' && preset !== 'hourly' && (
                  <input
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-foreground"
                  />
                )}

                {preset === 'custom' && (
                  <input
                    type="text"
                    value={customCron}
                    onChange={(event) => setCustomCron(event.target.value)}
                    placeholder={tScheduled('form.cronPlaceholder')}
                    className="w-full rounded-md border border-border/60 bg-background px-2 py-1 font-mono text-xs text-foreground"
                  />
                )}

                <p className="text-[11px] leading-snug text-muted-foreground/70">
                  {tScheduled('composer.recurringHint')}
                </p>

                {supportsNativeScheduling && (
                  <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
                    {tScheduled('composer.nativeSchedulingHint')}
                  </p>
                )}

                <button
                  type="button"
                  onClick={commitRecurring}
                  disabled={!recurringValid}
                  className="w-full rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {tScheduled('composer.recurringCreate')}
                </button>
              </div>
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}
