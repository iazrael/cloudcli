import { useTranslation } from 'react-i18next';
import { useState } from 'react';

import type { MarkdownImageContext } from '@/shared/types';
import { useSignedImage } from '@/shared/hooks/useSignedImage';
import { UnifiedImageViewer } from '@/shared/ui';
import { resolveMarkdownImageTarget } from '@/modules/code-editor/utils/markdownImagePath';

type MarkdownPreviewImageProps = {
  node?: unknown;
  src?: string;
  alt?: string;
  title?: string;
  context: MarkdownImageContext;
};

/**
 * `img` renderer for the code editor's markdown preview. Workspace images use
 * signed URLs so the browser loads the bytes directly, web images
 * pass straight through, and anything unresolvable falls back to its
 * alternative text instead of a broken-image placeholder. Clicking a resolved
 * image opens the shared image viewer.
 *
 * Used by code-editor's MarkdownPreview, which serves the code editor's file
 * viewer; chat renders markdown through its own Markdown component instead.
 */
export default function MarkdownPreviewImage({ src, alt, title, context }: MarkdownPreviewImageProps) {
  const { t } = useTranslation();
  const source = src ?? '';
  const { projectId } = context;
  // Cheap string work, so it is redone per render rather than memoized on a
  // context object whose identity the caller does not guarantee.
  const target = resolveMarkdownImageTarget(source, context);
  const { observe, ...signed } = useSignedImage(target.kind === 'file' ? target.external
    ? { kind: 'external', path: target.path, ...(projectId ? { projectId } : {}) }
    : { kind: 'project', path: target.path, projectId: projectId! } : null);
  // Controls the viewer only after a resolved image is clicked: closing it must
  // keep the image in the document, so it cannot be derived from the URL.
  const [expanded, setExpanded] = useState(false);

  const targetKind = target.kind;
  const targetPath = targetKind === 'file' ? target.path : '';
  const label = alt || source;

  if (targetKind === 'browser') {
    return (
      <img
        src={target.src}
        alt={alt ?? ''}
        title={title}
        loading="lazy"
        decoding="async"
        className="my-2 rounded-lg"
      />
    );
  }

  if (signed.error) return <span role="status" className="text-xs text-muted-foreground">
    {label} <button type="button" onClick={signed.retry}>{t('common:buttons.retry')}</button>
  </span>;

  if (targetKind !== 'file') {
    // No route can serve this path; the alternative text keeps the document
    // readable without a broken-image icon.
    return <span className="text-xs italic text-muted-foreground">{label}</span>;
  }

  if (!signed.url) {
    return <span ref={observe} aria-hidden="true" className="my-2 block h-40 max-w-md animate-pulse rounded-lg bg-muted" />;
  }

  return (
    <>
      <img
        src={signed.url}
        alt={alt ?? ''}
        title={title}
        loading="lazy"
        decoding="async"
        ref={observe} referrerPolicy="no-referrer" onLoad={signed.onLoad} onError={signed.onError}
        onClick={() => setExpanded(true)}
        className="my-2 cursor-zoom-in rounded-lg"
      />
      {expanded && (
        <UnifiedImageViewer
          src={signed.url}
          alt={label}
          title={title || label}
          resolveSrc={signed.ensureFresh} onImageError={signed.onError} onImageLoad={signed.onLoad}
          filePath={targetPath}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}
