import { useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSignedImage } from '@/shared/hooks/useSignedImage';
import { UnifiedImageViewer } from '@/shared/ui';
import type { ChatImage } from '@/shared/types';
import { TranscriptRenderContext } from '@/modules/chat/context/TranscriptRenderContext';

type ChatMessageImagesProps = {
  images: ChatImage[];
  projectId?: string | null;
};

// 导出保留嵌入字节；交互式历史签发引用，JS 不读取图片字节。
function useChatImageSrc(image: ChatImage, projectId?: string | null) {
  const { isExporting, assetData } = useContext(TranscriptRenderContext);
  const storedDataPath = image.data?.startsWith('/api/assets/images/') ? image.data : null;
  const inlineData = (isExporting && assetData?.[image.path || storedDataPath || '']) || (storedDataPath ? null : image.data);
  const imagePath = image.path || storedDataPath;
  const signed = useSignedImage(!inlineData && imagePath ? {
    kind: 'asset', filename: imagePath.split(/[\\/]/).pop() || '',
    ...(projectId ? { projectId, fallbackPath: imagePath } : {}),
  } : null);
  return { ...signed, src: inlineData || signed.url, failed: !inlineData && (Boolean(signed.error) || !imagePath) };
}

/**
 * Used by chat's ComposerAttachment to expand an attachment preview to full size
 * using the unified image viewer.
 */
export function ImageLightbox({ src, alt, filePath, onClose }: { src: string; alt: string; filePath?: string; onClose: () => void }) {
  return <UnifiedImageViewer src={src} alt={alt} title={alt} filePath={filePath} onClose={onClose} />;
}

/** 聊天时间线用此组件显示签名附件预览并打开统一查看器。 */
export function ChatMessageImage({ image, projectId }: { image: ChatImage; projectId?: string | null }) {
  const { t } = useTranslation();
  const { observe, ...signed } = useChatImageSrc(image, projectId);
  const { src, failed } = signed;
  // 展开由用户点击决定，与图片加载状态分开。
  const [expanded, setExpanded] = useState(false);
  const alt = image.name || 'Attached image';

  if (failed) {
    return (
      <div className="flex h-28 w-28 items-center justify-center rounded-xl border border-border/50 bg-muted px-2 text-center text-[10px] text-muted-foreground">
        <span>{alt}</span>
        {signed.error && <button type="button" onClick={signed.retry}>{t('common:buttons.retry')}</button>}
      </div>
    );
  }

  if (!src) {
    return <div ref={observe} className="h-28 w-28 animate-pulse rounded-xl border border-border/50 bg-muted" />;
  }

  return (
    <>
      <button
        ref={observe}
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={t('chat:misc.expandImage', { name: alt })}
        className="block overflow-hidden rounded-xl border border-border/50 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
      >
        <img
          loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={signed.onLoad} onError={signed.onError}
          src={src}
          alt={alt}
          className="h-28 w-28 cursor-zoom-in object-cover transition-transform duration-200 hover:scale-105"
        />
      </button>
      {expanded && (
        <UnifiedImageViewer
          src={src}
          alt={alt}
          title={alt}
          resolveSrc={image.data && !image.data.startsWith('/api/') ? undefined : signed.ensureFresh}
          onImageError={signed.onError} onImageLoad={signed.onLoad}
          filePath={image.path || (image.data?.startsWith('/api/assets/images/') ? image.data : undefined)}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}

/**
 * Image attachments for a user turn, rendered claude.ai-style: standalone
 * rounded square cards shown above the message bubble. Each thumbnail
 * expands to a fullscreen lightbox on click.
 *
 * Rendered by chat's MessageComponent for the images attached to a user turn.
 */
export default function ChatMessageImages({ images, projectId }: ChatMessageImagesProps) {
  if (!images || images.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {images.map((image, index) => (
        <ChatMessageImage key={image.path || image.name || index} image={image} projectId={projectId} />
      ))}
    </div>
  );
}
