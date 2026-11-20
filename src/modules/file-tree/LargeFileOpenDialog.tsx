import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { LARGE_FILE_OPEN_LABEL } from '@/shared/constants';
import { formatFileSize } from '@/modules/file-tree/utils/fileTreeUtils';

type LargeFileOpenDialogProps = {
  name: string;
  size?: number;
  /** True while the streaming download kicked off from the dialog is in flight. */
  downloading: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onCancel: () => void;
};

/**
 * Rendered by the file-tree module and the project-workspace open guard to ask
 * whether an oversized file should still be loaded into the editor or be
 * downloaded directly instead — loading a document above the threshold stalls
 * the pane.
 */
export default function LargeFileOpenDialog({ name, size, downloading, onOpen, onDownload, onCancel }: LargeFileOpenDialogProps) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
      <div className="mx-4 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
        <div className="mb-4 flex items-center gap-3">
          <div className="rounded-full bg-amber-100 p-2 dark:bg-amber-900/30">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <h3 className="font-medium text-foreground">
              {t('fileTree.largeFile.title', 'Large file')}
            </h3>
            <p className="text-sm text-muted-foreground">{name}</p>
          </div>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          {t('fileTree.largeFile.message', 'This file is {{size}}, larger than the {{threshold}} open limit. Opening it loads the whole file into the editor and may stall the page — you can download it directly instead.', {
            size: formatFileSize(size),
            threshold: LARGE_FILE_OPEN_LABEL,
          })}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            onClick={onDownload}
            disabled={downloading}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-50"
          >
            {downloading && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('fileTree.largeFile.download', 'Download instead')}
          </button>
          <button
            onClick={onOpen}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-blue-700"
          >
            {t('fileTree.largeFile.continueOpen', 'Open anyway')}
          </button>
        </div>
      </div>
    </div>
  );
}
