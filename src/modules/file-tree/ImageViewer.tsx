import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { useSignedImage } from '@/shared/hooks/useSignedImage';
import { UnifiedImageViewer } from '@/shared/ui';
import type { FileTreeImageSelection } from '@/shared/types';

type ImageViewerProps = {
  file: FileTreeImageSelection;
  onClose: () => void;
};

/** Rendered by FileTree to preview an image file picked in the tree using UnifiedImageViewer. */
export default function ImageViewer({ file, onClose }: ImageViewerProps) {
  const { t } = useTranslation();
  const signed = useSignedImage({ kind: 'project', projectId: file.projectId, path: file.path }, { eager: true });
  const imageUrl = signed.url;
  const error = signed.error ? '无法加载图片' : null;
  const loading = !imageUrl && !error;

  if (!loading && imageUrl) {
    return (
      <UnifiedImageViewer
        src={imageUrl}
        alt={file.name}
        title={file.name}
        resolveSrc={signed.ensureFresh} onImageError={signed.onError} onImageLoad={signed.onLoad}
        filePath={file.path}
        onClose={onClose}
      />
    );
  }

  // Loading or Error fallback overlay
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/90 p-4 backdrop-blur-md"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex items-center justify-center rounded-full bg-white/20 p-2 text-white shadow-lg transition-colors hover:bg-white/35 active:scale-95"
        title="关闭"
        aria-label="关闭"
      >
        <X className="h-5 w-5" />
      </button>

      <div className="flex flex-col items-center gap-3 text-center text-white/80">
        {loading ? (
          <>
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
            <p className="text-sm font-medium">正在加载图片...</p>
          </>
        ) : (
          <>
            <p className="text-sm text-red-400">{error || '无法加载图片'}</p>
            <button type="button" onClick={signed.retry}>{t('common:buttons.retry')}</button>
            <p className="max-w-md break-all font-mono text-xs text-white/50">{file.path}</p>
          </>
        )}
      </div>
    </div>
  );
}
