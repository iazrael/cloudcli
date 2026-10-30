import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '@/modules/command-palette';
import { resolveMarkdownImageTarget } from '@/modules/code-editor/utils/markdownImagePath';
import { getPreviewKind } from '@/modules/code-editor/utils/previewableFile';
import { useSignedImage } from '@/shared/hooks/useSignedImage';
import type { MarkdownImageContext } from '@/shared/types';
import { UnifiedImageViewer } from '@/shared/ui';
import { filePathFromFileUrl, isFileUrl, isWindowsAbsolutePath } from '@/shared/utils';

type MarkdownPreviewLinkProps = {
  href?: string;
  title?: string;
  children?: ReactNode;
  context: MarkdownImageContext;
};

/** 代码编辑器的文件查看器通过 MarkdownPreview 使用；本地链接按文档目录解析。 */
export default function MarkdownPreviewLink({ href = '', title, children, context }: MarkdownPreviewLinkProps) {
  const reference = href.trim();
  const nativeLink = !isFileUrl(reference) && !isWindowsAbsolutePath(reference)
    && /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference);
  if (nativeLink) {
    return <a href={href} title={title} className="text-blue-600 hover:underline dark:text-blue-400"
      target={reference.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a>;
  }

  // 先分离 URL 查询参数和片段，再解码路径；文件名中的 # 和 ? 应使用百分号编码。
  const source = reference.split(/[?#]/)[0];
  const target = isFileUrl(source) && filePathFromFileUrl(source) === undefined
    ? { kind: 'unresolved' as const }
    : resolveMarkdownImageTarget(source, context);
  if (target.kind !== 'file') return <span title={href}>{children}</span>;

  return <LocalPreviewLink key={JSON.stringify([context.projectId, target.external, target.path, reference])}
    path={target.path} external={target.external} projectId={context.projectId}
    directory={/[/\\]$/.test(source)} title={title}>{children}</LocalPreviewLink>;
}

type LocalPreviewLinkProps = {
  path: string;
  external: boolean;
  projectId?: string;
  directory: boolean;
  title?: string;
  children?: ReactNode;
};
function LocalPreviewLink({ path, external, projectId, directory, title, children }: LocalPreviewLinkProps) {
  const { t } = useTranslation('codeEditor');
  const { openFileInEditor, openDirectory } = usePaletteOps();
  const isImage = !directory && getPreviewKind(path) === 'image';
  // 仅点击图片链接才申请，关闭查看器后仍由共享缓存保留有效票据。
  const [expanded, setExpanded] = useState(false);
  const signed = useSignedImage(isImage && expanded ? external
    ? { kind: 'external', path, ...(projectId ? { projectId } : {}) }
    : { kind: 'project', projectId: projectId!, path } : null, { eager: true });
  const loading = expanded && !signed.url && !signed.error;
  const openImage = () => {
    setExpanded(true);
    if (signed.error) signed.retry();
  };
  const label = typeof children === 'string' ? children : path.split(/[/\\]/).pop() || path;

  return <>
    {/* 本地文件是应用内操作；使用按钮避免中键或菜单把文件路径当网站 URL 打开。
        捕获点击也能接管 [![缩略图](...)](原图)，防止同时打开两个查看器。 */}
    <button type="button" title={title || path} disabled={loading} aria-busy={loading || undefined}
      className="text-left text-blue-600 hover:underline dark:text-blue-400"
      onClickCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (directory) openDirectory(path);
        else if (isImage) openImage();
        else openFileInEditor(path);
      }}>{children}</button>
    {loading && <span role="status" className="ml-2 text-xs text-muted-foreground">{t('filePreview.loading')}</span>}
    {signed.error && <span role="status" className="ml-2 inline-flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{t(`chat:imageLoad.${signed.error}`)}</span>
      <code className="break-all">{path}</code>
      <button type="button" onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openImage();
      }}>{t('common:buttons.retry')}</button>
    </span>}
    {expanded && signed.url && <UnifiedImageViewer src={signed.url} alt={label} title={title || label}
      resolveSrc={signed.ensureFresh} onImageError={signed.onError} onImageLoad={signed.onLoad}
      filePath={path} onClose={() => setExpanded(false)} />}
  </>;
}
