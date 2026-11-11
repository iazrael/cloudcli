import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { FileIcon, RotateCwIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ImageLightbox } from '@/modules/chat/transcript/ChatMessageImages';
import { MAX_ATTACHMENT_SIZE_LABEL } from '@/shared/constants';
import type { ComposerAttachmentItem, ComposerAttachmentQueue } from '@/shared/types';

type ComposerAttachmentProps = {
  item: ComposerAttachmentItem;
  queue: ComposerAttachmentQueue;
};

const MASK_CLASS_NAME = 'absolute inset-0 flex items-center justify-center rounded-xl';

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

/** Subscribes on its own so a percent change repaints this mask, not the whole composer. */
const UploadProgressMask = ({ item, queue }: ComposerAttachmentProps) => {
  const { t } = useTranslation('chat');
  const { id, file } = item;
  const subscribe = useCallback((listener: () => void) => queue.subscribeProgress(id, listener), [id, queue]);
  const progress = useSyncExternalStore(subscribe, () => queue.getProgress(id));

  return (
    <div
      role="progressbar"
      aria-label={t('input.attachments.progress', { name: file.name })}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      className={`${MASK_CLASS_NAME} pointer-events-none bg-black/50 text-sm font-semibold tabular-nums text-white`}
    >
      {progress}%
    </div>
  );
};

/**
 * Rendered by chat's ChatComposer for each attachment, showing its thumbnail or
 * file card under a mask that tracks the upload, with retry and remove controls.
 */
const ComposerAttachment = ({ item, queue }: ComposerAttachmentProps) => {
  const { t } = useTranslation('chat');
  const { file, status, error } = item;
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const isImage = file.type.startsWith('image/');

  useEffect(() => {
    if (!isImage) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div className="group relative max-w-full">
      {isImage ? (
        <button
          type="button"
          onClick={() => preview && setExpanded(true)}
          aria-label={`Expand ${file.name}`}
          className="block overflow-hidden rounded-xl border border-border/50 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
        >
          {preview
            ? <img src={preview} alt={file.name} className="h-20 w-20 cursor-zoom-in object-cover" />
            : <div className="h-20 w-20 animate-pulse bg-muted" />}
        </button>
      ) : (
        <div className="flex h-20 w-56 max-w-full items-center gap-3 rounded-xl border border-border/50 bg-background/80 px-3 shadow-sm">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileIcon className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={file.name}>{file.name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
          </div>
        </div>
      )}
      {(status === 'queued' || status === 'uploading') && <UploadProgressMask item={item} queue={queue} />}
      {status === 'failed' && (
        <button
          type="button"
          onClick={() => queue.retry(item.id)}
          title={error}
          aria-label={t('input.attachments.retry', { name: file.name })}
          className={`${MASK_CLASS_NAME} bg-red-500/60 text-white`}
        >
          <RotateCwIcon className="h-5 w-5" aria-hidden />
        </button>
      )}
      {status === 'tooLarge' && (
        <div className={`${MASK_CLASS_NAME} pointer-events-none bg-red-500/60 px-1 text-center text-xs font-medium text-white`}>
          {t('input.attachments.tooLarge', { size: MAX_ATTACHMENT_SIZE_LABEL })}
        </div>
      )}
      <button
        type="button"
        onClick={() => queue.remove(item.id)}
        className="absolute -right-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur transition-opacity hover:bg-background focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label={`Remove ${file.name}`}
      >
        <XIcon className="h-3 w-3" aria-hidden />
      </button>
      {expanded && preview && (
        <ImageLightbox src={preview} alt={file.name} filePath={file.name} onClose={() => setExpanded(false)} />
      )}
    </div>
  );
};

export default ComposerAttachment;
