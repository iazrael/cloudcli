import { useTranslation } from 'react-i18next';
import { PencilIcon, XIcon, Zap } from 'lucide-react';

type QueuedMessageCardProps = {
  content: string;
  permissionMode?: string;
  attachmentCount?: number;
  onEdit: () => void;
  onDelete: () => void;
  onForceSend?: () => void;
  isWaitingForBackgroundTasks?: boolean;
};

/**
 * Rendered by chat's ChatComposer to show the message queued for a busy
 * session, with edit, delete, and force-send actions before it is auto-sent.
 */
export default function QueuedMessageCard({
  content,
  permissionMode,
  attachmentCount = 0,
  onEdit,
  onDelete,
  onForceSend,
  isWaitingForBackgroundTasks = false,
}: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');

  return (
    <div className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl rounded-t-none border border-dashed border-primary/25 bg-primary/[0.04] px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary/70">
            <span>{t('input.queue.label', { defaultValue: 'Queued' })}</span>
            <span className="normal-case text-muted-foreground/60">
              ·{' '}
              {isWaitingForBackgroundTasks
                ? t('input.queue.willSendAfterBackground', {
                    defaultValue: '后台任务完成后将自动发送',
                  })
                : t('input.queue.willSend', { defaultValue: 'Will send when this finishes' })}
            </span>
          </div>
          <p tabIndex={0} className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-sm text-sm text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{content}</p>
          {permissionMode && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('input.queue.permission', {
                mode: t(`codex.modes.${permissionMode}`, { defaultValue: permissionMode }),
                defaultValue: 'Whole queued message: {{mode}}. New additions apply the latest settings.',
              })}
            </p>
          )}
          {attachmentCount > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {attachmentCount} {attachmentCount === 1 ? 'file' : 'files'} attached
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {onForceSend && (
            <button
              type="button"
              onClick={onForceSend}
              aria-label={t('input.queue.forceSend', { defaultValue: 'Send now; background tasks keep running' })}
              title={t('input.queue.forceSend', { defaultValue: 'Send now; background tasks keep running' })}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-600 bg-amber-500/10 hover:bg-amber-500/20 dark:text-amber-400 transition-colors"
            >
              <Zap className="h-3.5 w-3.5" />
              <span>{t('input.queue.forceSendButton', { defaultValue: '立即发送' })}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            title={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            title={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
