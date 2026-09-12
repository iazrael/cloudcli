import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { api } from '@/shared/api';
import { UnifiedImageViewer } from '@/shared/ui';
import type { FileTreeImageSelection } from '@/shared/types';

type ImageViewerProps = {
  file: FileTreeImageSelection;
  onClose: () => void;
};

/** Rendered by FileTree to preview an image file picked in the tree using UnifiedImageViewer. */
export default function ImageViewer({ file, onClose }: ImageViewerProps) {
  /** Blob URL created from downloaded image bytes for local preview. */
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  /** Error message displayed if loading image blob fails. */
  const [error, setError] = useState<string | null>(null);

  /** Loading state indicator while image blob is being fetched. */
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let objectUrl: string | null = null;
    const controller = new AbortController();

    const loadImage = async () => {
      try {
        setLoading(true);
        setError(null);
        setImageUrl(null);

        const response = await api.readFileBlob(file.projectId, file.path, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      } catch (loadError: unknown) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return;
        }
        console.error('Error loading image:', loadError);
        setError('无法加载图片');
      } finally {
        setLoading(false);
      }
    };

    loadImage();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [file.projectId, file.path]);

  if (!loading && imageUrl) {
    return (
      <UnifiedImageViewer
        src={imageUrl}
        alt={file.name}
        title={file.name}
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
            <p className="max-w-md break-all font-mono text-xs text-white/50">{file.path}</p>
          </>
        )}
      </div>
    </div>
  );
}
