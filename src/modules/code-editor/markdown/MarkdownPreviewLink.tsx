import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '@/modules/command-palette';
import { resolveMarkdownImageTarget } from '@/modules/code-editor/utils/markdownImagePath';
import { getPreviewKind } from '@/modules/code-editor/utils/previewableFile';
import { api, readExternalFileContent } from '@/shared/api';
import type { MarkdownImageContext } from '@/shared/types';
import { UnifiedImageViewer } from '@/shared/ui';
import { filePathFromFileUrl, isFileUrl, isWindowsAbsolutePath } from '@/shared/utils';

type MarkdownPreviewLinkProps = {
  href?: string;
  title?: string;
  children?: ReactNode;
  context: MarkdownImageContext;
};

/** 文件查看器和 PRD 编辑器通过 MarkdownPreview 使用；本地链接按文档目录解析。 */
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
type ImageResult = { attempt: number; url?: string; error?: 'unauthorized' | 'forbidden' | 'notFound' | 'failed' };

function LocalPreviewLink({ path, external, projectId, directory, title, children }: LocalPreviewLinkProps) {
  const { t } = useTranslation('codeEditor');
  const { openFileInEditor, openDirectory } = usePaletteOps();
  const isImage = !directory && getPreviewKind(path) === 'image';
  // 仅点击图片链接或重试后读取，渲染报告时不预取所有原图。
  const [attempt, setAttempt] = useState(0);
  // 保留本次读取结果；关闭查看器后仍可复用已加载的图片。
  const [loaded, setLoaded] = useState<ImageResult | null>(null);
  // 查看器是否打开由用户点击决定，关闭不会丢失报告或图片缓存。
  const [expanded, setExpanded] = useState(false);
  const current = loaded?.attempt === attempt ? loaded : null;
  const loading = attempt > 0 && !current;

  useEffect(() => {
    if (!isImage || attempt === 0) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const load = async () => {
      try {
        const response = external
          ? await readExternalFileContent(path, { signal: controller.signal }, projectId)
          : await api.readFileBlob(projectId!, path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!response.ok) {
          const error = response.status === 401 ? 'unauthorized'
            : response.status === 403 ? 'forbidden' : response.status === 404 ? 'notFound' : 'failed';
          setLoaded({ attempt, error });
          return;
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ attempt, url: objectUrl });
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error('[MarkdownImage] load failed:', error);
          setLoaded({ attempt, error: 'failed' });
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, external, isImage, path, projectId]);

  const openImage = () => {
    setExpanded(true);
    if (!current?.url) setAttempt((value) => value + 1);
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
    {current?.error && <span role="status" className="ml-2 inline-flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{t(`chat:imageLoad.${current.error}`)}</span>
      <code className="break-all">{path}</code>
      <button type="button" onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openImage();
      }}>{t('common:buttons.retry')}</button>
    </span>}
    {expanded && current?.url && <UnifiedImageViewer src={current.url} alt={label} title={title || label}
      filePath={path} onClose={() => setExpanded(false)} />}
  </>;
}
