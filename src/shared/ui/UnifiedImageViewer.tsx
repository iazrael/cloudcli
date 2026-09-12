import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Plus, RotateCcw, X } from 'lucide-react';

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
};

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
}: UnifiedImageViewerProps) {
  /** Current zoom scale displayed in the floating header control. */
  const [scale, setScale] = useState<number>(1);

  /** Imperative handle to trigger zoomIn, zoomOut, and resetZoom on the inner viewer. */
  const viewerRef = useRef<ImageViewerHandle | null>(null);

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

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={displayName}
      className="fixed inset-0 z-[100] flex touch-none select-none flex-col bg-black/90 backdrop-blur-md"
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

      {/* Main Image Body */}
      <main className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <ImageViewerSurface
          src={src}
          alt={displayName}
          viewerRef={viewerRef}
          onScaleChange={setScale}
        />
      </main>

      {/* Bottom Path Indicator if available */}
      {filePath && (
        <footer className="pointer-events-none relative z-10 flex shrink-0 justify-center px-4 py-2">
          <span className="max-w-[90vw] truncate rounded-full border border-white/10 bg-black/60 px-3 py-1 font-mono text-[11px] text-white/70 shadow backdrop-blur-md">
            {filePath}
          </span>
        </footer>
      )}
    </div>,
    document.body,
  );
}
