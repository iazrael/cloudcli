import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TerminalIcon, Square } from 'lucide-react';
import type { ActiveBackgroundTask } from '@/shared/types';

type BackgroundTaskIndicatorProps = {
  tasks: ActiveBackgroundTask[];
  /** Stops the task launched by `toolUseId`, or every task when omitted. */
  onStopTasks?: (toolUseId?: string) => void;
  /** Reveals the task's card in the transcript; omitted rows stay inert. */
  onRevealTask?: (task: ActiveBackgroundTask) => void;
};

function formatElapsed(elapsedSeconds: number): string {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  if (minutes < 1) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

/** Used by ChatComposer to display running background tasks. */
export default function BackgroundTaskIndicator({ tasks, onStopTasks, onRevealTask }: BackgroundTaskIndicatorProps) {
  const { t } = useTranslation('chat');
  const [, setTick] = useState(0);

  // Periodically refresh elapsed time every second while tasks are running
  useEffect(() => {
    if (tasks.length === 0) return;
    const interval = setInterval(() => {
      setTick((tick) => tick + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [tasks.length]);

  if (!tasks || tasks.length === 0) {
    return null;
  }

  return (
    <div
      className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl border border-sky-500/25 bg-sky-500/[0.04] px-3 py-2 text-xs"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-sky-500/15">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
          <span className="font-medium text-foreground">
            {t('composer.backgroundTasks.title', {
              count: tasks.length,
              defaultValue: '后台任务运行中 ({{count}})',
            })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground/80">
            <span className="hidden sm:inline">
              {t('composer.backgroundTasks.hint', {
                defaultValue: '发送消息将排队，任务完成后自动发送',
              })}
            </span>
            <span className="sm:hidden">
              {t('composer.backgroundTasks.hintShort', {
                defaultValue: '发送将排队',
              })}
            </span>
          </span>
          {onStopTasks && (
            <button
              type="button"
              onClick={() => onStopTasks()}
              aria-label={t('composer.backgroundTasks.abort', { defaultValue: '中止后台任务' })}
              title={t('composer.backgroundTasks.abort', { defaultValue: '中止后台任务' })}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              <span>{t('composer.backgroundTasks.abortButton', { defaultValue: '中止' })}</span>
            </button>
          )}
        </div>
      </div>

      <div className="mt-1.5 space-y-1 max-h-36 overflow-y-auto">
        {tasks.map((task) => {
          const elapsedSeconds = Math.max(
            0,
            Math.floor((Date.now() - (task.startedAt || Date.now())) / 1000),
          );
          const taskDetail = task.command || task.description || task.id;

          // The label region is its own control so the row can both reveal the
          // card and keep the stop button beside it (a button inside a button
          // is not a thing). A task with nothing to reveal stays a plain div.
          const labelContent = (
            <>
              <TerminalIcon className="h-3 w-3 shrink-0 text-sky-500/80" />
              <span className="shrink-0 font-medium text-sky-600 dark:text-sky-400">
                {task.toolName}:
              </span>
              <span className="truncate font-mono text-muted-foreground" title={taskDetail}>
                {taskDetail}
              </span>
            </>
          );

          return (
            <div
              key={task.id}
              className="flex items-center justify-between gap-2 rounded-md bg-background/50 px-2 py-1 text-[11px]"
            >
              {onRevealTask ? (
                <button
                  type="button"
                  onClick={() => onRevealTask(task)}
                  title={t('composer.backgroundTasks.reveal', { defaultValue: '定位到对应卡片' })}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-foreground"
                >
                  {labelContent}
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">{labelContent}</div>
              )}
              <span className="shrink-0 tabular-nums text-muted-foreground/70">
                {formatElapsed(elapsedSeconds)}
              </span>
              {onStopTasks && (
                <button
                  type="button"
                  onClick={() => onStopTasks(task.id)}
                  aria-label={t('composer.backgroundTasks.stopOne', { defaultValue: '停止此任务' })}
                  title={t('composer.backgroundTasks.stopOne', { defaultValue: '停止此任务' })}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Square className="h-2.5 w-2.5 fill-current" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
