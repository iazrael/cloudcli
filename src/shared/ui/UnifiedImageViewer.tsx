import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Minus, Plus, RotateCcw, X } from 'lucide-react';

import { saveOrShareBlob } from '@/shared/utils';
import {
  ImageViewerSurface,
  MAX_SCALE,
  MIN_SCALE,
  type ImageViewerHandle,
} from '@/shared/ui/ImageViewerSurface';

type UnifiedImageViewerProps = {
  src: string;
  alt?: string;
  title?: string;
  filePath?: string;
  onClose: () => void;
  resolveSrc?: () => Promise<string | null>;
  onImageError?: () => void;
  onImageLoad?: () => void;
};

// Markdown labels may be descriptions or full URLs rather than filenames.
function getDownloadFilename(src: string, label: string, filePath: string | undefined, mimeType: string): string {
  const url = new URL(src, window.location.href);
  let sourceName = /^https?:$/.test(url.protocol) ? url.pathname.split('/').pop() || '' : '';
  try {
    sourceName = decodeURIComponent(sourceName);
  } catch {
    // A literal '%' is valid in an image URL; retain its encoded name if decoding fails.
  }
  const name = filePath || (/^https?:\/\//i.test(label) ? sourceName : label) || sourceName || 'image';
  const basename = name.split(/[\\/]/).pop()?.replace(/[<>:"|?*\u0000-\u001f]/g, '_') || 'image';
  if (/\.[a-z0-9]+$/i.test(basename)) return basename;
  const subtype = mimeType.split(';')[0].split('/')[1];
  const extension = subtype === 'svg+xml' ? 'svg' : subtype === 'jpeg' ? 'jpg' : subtype;
  return extension && /^[a-z0-9]+$/i.test(extension) ? `${basename}.${extension}` : basename;
}

/**
 * Shared modal for previewing images across chat messages, file tree, and tools
 * with pan, zoom, pinch-to-zoom, and high-contrast controls.
 */
export function UnifiedImageViewer({
  src,
  alt = 'Image Preview',
  title,
  filePath,
  onClose,
  resolveSrc,
  onImageError,
  onImageLoad,
}: UnifiedImageViewerProps) {
  /** Current zoom scale displayed in the floating header control. */
  const [scale, setScale] = useState<number>(1);

  /** Prevent repeated clicks while image bytes are handed to the browser or share sheet. */
  const [isDownloading, setIsDownloading] = useState(false);

  /** Keep download failures visible without interrupting the image preview. */
  const [downloadError, setDownloadError] = useState<string | null>(null);

  /** Imperative handle to trigger zoomIn, zoomOut, and resetZoom on the inner viewer. */
  const viewerRef = useRef<ImageViewerHandle | null>(null);

  // 打开查看器可能晚于内嵌图片加载，新的读取按需续签。
  const initialResolver = useRef(resolveSrc);
  useEffect(() => { void initialResolver.current?.(); }, []);

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const canZoomOut = scale > MIN_SCALE + 0.01;
  const canZoomIn = scale < MAX_SCALE - 0.01;
  const displayName = title || alt || (filePath ? filePath.split('/').pop() : undefined) || 'Image Preview';

  const downloadImage = async () => {
    if (isDownloading) return;
    setIsDownloading(true);
    setDownloadError(null);
    try {
      // Read the original source; zoom/pan transforms must never affect saved bytes.
      // Plain fetch avoids sending app credentials to remote Markdown images.
      const downloadSrc = resolveSrc ? await resolveSrc() : src;
      if (!downloadSrc) throw new Error('Image URL unavailable');
      const response = await fetch(downloadSrc, { referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
      const blob = await response.blob();
      const filename = getDownloadFilename(src, title || alt, filePath, blob.type);
      await saveOrShareBlob(blob, filename);
    } catch (error) {
      console.error('Failed to download image:', error);
      setDownloadError('图片下载失败，请重试；外链图片可能不允许下载。');
    } finally {
      setIsDownloading(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={displayName}
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-md"
      onClick={(e) => {
        // Close if clicking outside the image container
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {/* Top Floating Control Bar */}
      <header className="relative z-10 flex shrink-0 items-center justify-between gap-3 px-4 py-3 sm:px-6">
        {/* Title */}
        <div className="flex min-w-0 flex-1 items-center">
          <h2
            className="truncate text-sm font-medium text-white/90 drop-shadow-md sm:text-base"
            title={displayName}
          >
            {displayName}
          </h2>
        </div>

        {/* Central / Right Floating Action Pill */}
        <div
          className="flex shrink-0 items-center gap-1 rounded-full border border-white/15 bg-neutral-900/80 px-2 py-1 shadow-2xl backdrop-blur-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            disabled={!canZoomOut}
            onClick={() => viewerRef.current?.zoomOut()}
            className={`flex items-center justify-center rounded-full p-1.5 transition-colors ${
              canZoomOut
                ? 'text-white/80 hover:bg-white/15 hover:text-white'
                : 'cursor-not-allowed text-white/40 opacity-30'
            }`}
            title="缩小"
            aria-label="缩小"
          >
            <Minus className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => viewerRef.current?.resetZoom()}
            className="rounded-full px-2 py-0.5 font-mono text-xs font-medium text-white/90 transition-colors hover:bg-white/15"
            title="重置缩放 (100%)"
            aria-label="重置缩放"
          >
            {Math.round(scale * 100)}%
          </button>

          <button
            type="button"
            disabled={!canZoomIn}
            onClick={() => viewerRef.current?.zoomIn()}
            className={`flex items-center justify-center rounded-full p-1.5 transition-colors ${
              canZoomIn
                ? 'text-white/80 hover:bg-white/15 hover:text-white'
                : 'cursor-not-allowed text-white/40 opacity-30'
            }`}
            title="放大"
            aria-label="放大"
          >
            <Plus className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => viewerRef.current?.resetZoom()}
            className="flex items-center justify-center rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
            title="还原原始大小"
            aria-label="还原原始大小"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>

          <div className="mx-1 h-3.5 w-px bg-white/20" />

          <button
            type="button"
            onClick={() => void downloadImage()}
            disabled={isDownloading}
            className="flex items-center justify-center rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/15 hover:text-white disabled:cursor-wait disabled:opacity-40"
            title={isDownloading ? '正在下载图片' : '下载图片'}
            aria-label={isDownloading ? '正在下载图片' : '下载图片'}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
          </button>

          {/* High-contrast close button with permanent background */}
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center rounded-full bg-white/20 p-1.5 text-white shadow-md transition-colors hover:bg-white/35 active:scale-95"
            title="关闭 (Esc)"
            aria-label="关闭图片预览"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {downloadError && (
        <p role="alert" className="shrink-0 px-4 pb-2 text-center text-sm text-red-300">
          {downloadError}
        </p>
      )}

      {/* Main Image Body */}
      <main className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <ImageViewerSurface
          src={src}
          filePath={filePath}
          dark
          onError={onImageError} onLoad={onImageLoad}
          alt={displayName}
          viewerRef={viewerRef}
          onScaleChange={setScale}
        />
      </main>

    </div>,
    document.body,
  );
}
