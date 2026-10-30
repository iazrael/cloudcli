import React, { memo, useContext, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useTranslation } from 'react-i18next';

import { useSignedImageCandidates } from '@/modules/chat/hooks/useSignedImageCandidates';
import { usePathExistsCandidates } from '@/modules/chat/hooks/usePathExists';
import { SyntaxHighlighter, isRegisteredLanguage } from '@/modules/chat/composer/codeHighlightLanguages';
import { MermaidDiagram } from '@/modules/code-editor';
import { normalizeInlineCodeFences } from '@/modules/chat/utils/chatFormatting';
import { normalizeLatexDelimiters } from '@/modules/chat/utils/latexDelimiters';
import { remarkImageReferences } from '@/modules/chat/utils/remarkImageReferences';
import { remarkFileReferences } from '@/modules/chat/utils/remarkFileReferences';
import { isLocalAbsolutePath, joinWorktreePath, lineFromRef, looksLikeFilePath, referenceProbeCandidates, stripLineSuffix } from '@/modules/chat/utils/fileReference';
import type { ImageMediaSource } from '@/shared/types';
import { api, readApiJson } from '@/shared/api';
import { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
import { shouldProxyLocalHref } from '@/modules/chat/utils/localProxyLink';
import {
  copyTextToClipboard,
  filePathFromFileUrl,
  fileReferenceFromMarkdownHref,
  isFileUrl,
  isImageReference,
  markdownUrlTransform,
} from '@/shared/utils';
import { UnifiedImageViewer } from '@/shared/ui';
import { usePaletteOps } from '@/modules/command-palette';
import { useTheme } from '@/shared/context/ThemeContext';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  /** Render single newlines as hard line breaks (for user-typed messages). */
  breaks?: boolean;
};

// Opens a link to a service running on the server's machine through the local
// proxy, so a browser on another machine can actually reach it.
//
// The blank window is opened synchronously by the click handler and passed in
// here: opening it after awaiting the ticket would be blocked as a popup.
async function openThroughLocalProxy(
  href: string,
  popup: Window | null,
  failureMessage: string,
): Promise<void> {
  try {
    const response = await api.localProxy.createTicket(href);
    const { data } = await readApiJson<{ data: { proxyPath: string } }>(response);
    const target = popup ?? window.open('', '_blank');
    if (!target) {
      throw new Error('The browser blocked the proxy window.');
    }
    // The proxied page is served from this origin; cutting the opener keeps it
    // from reaching back into the chat window.
    target.opener = null;
    target.location.replace(data.proxyPath);
  } catch (error) {
    console.error('[LocalProxy] failed to open link', href, error);
    if (popup && !popup.closed) {
      popup.document.title = failureMessage;
      popup.document.body.textContent = `${failureMessage}\n\n${href}`;
    }
  }
}

// Links to the wider web (or in-page anchors) keep normal browser navigation;
// everything else is treated as a workspace file reference.
const isExternalHref = (href?: string): boolean =>
  !!href && (/^(https?:|mailto:|tel:|data:)/i.test(href) || href.startsWith('#'));

// Extract plain text from link children so a reference rendered only as link
// text (e.g. `[src/foo.ts]()` with an empty href) can still be opened.
const childrenToText = (children: React.ReactNode): string => {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(childrenToText).join('');
  }
  if (React.isValidElement(children)) {
    return childrenToText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
};

// The only delimiter `remark-math` recognizes with `singleDollarTextMath` off.
// `\(…\)` and `\[…\]` are already rewritten to `$$` by normalizeLatexDelimiters,
// so this one probe covers both notations.
const MATH_DELIMITER = /\$\$/;

const EMPTY_PLUGINS: never[] = [];

// micromark resolves emphasis in time quadratic in the length of one inline
// run (a paragraph), so a degenerate model output — a single 190KB line of
// `**`/「 fragments — took a minute to parse and froze the tab. Past this many
// characters a run is rendered verbatim instead; at the limit a degenerate run
// still parses in ~0.1s on desktop. Real prose paragraphs stay far below it.
const INLINE_RUN_PARSE_LIMIT = 10_000;

const FENCE_LINE = /^\s*(```|~~~)/;

// Length of the longest stretch the inline parser would treat as one run.
// Fenced code is literal (no emphasis pass), and each table row is parsed per
// cell, so neither counts toward a run.
const longestInlineRun = (text: string): number => {
  let longest = 0;
  let run = 0;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      run = 0;
      continue;
    }
    const trimmed = line.trim();
    if (inFence || !trimmed || trimmed.startsWith('|')) {
      run = 0;
      continue;
    }
    run += line.length + 1;
    if (run > longest) longest = run;
  }
  return longest;
};

type CodeBlockProps = {
  node?: any;
  className?: string;
  children?: React.ReactNode;
  /** Set by the custom `pre` renderer: this code element is a fenced/indented block. */
  forceBlock?: boolean;
};

// `node` is destructured out so react-markdown's hast node never reaches the DOM.
const CodeBlock = memo(function CodeBlock({ node: _node, className, children, forceBlock, ...props }: CodeBlockProps) {
  const { t } = useTranslation('chat');
  const { isDarkMode } = useTheme();
  const [copied, setCopied] = useState(false);
  // Fenced blocks carry a trailing newline in the tree; trim it so the
  // highlighter doesn't render an empty final line.
  const raw = (Array.isArray(children) ? children.join('') : String(children ?? '')).replace(/\n$/, '');
  // react-markdown v9+ dropped the `inline` prop: block code is whatever the
  // `pre` renderer hands us (forceBlock). Multiline is kept as a safety net.
  const shouldInline = !forceBlock && !/[\r\n]/.test(raw);

  if (shouldInline) {
    return (
      <code
        className={`whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-foreground ${className || ''
          }`}
        {...props}
      >
        {children}
      </code>
    );
  }

  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';
  const languageLabel = language.charAt(0).toUpperCase() + language.slice(1);

  if (language === 'mermaid') {
    return <MermaidDiagram code={raw} />;
  }

  return (
    <div className="group my-3 overflow-hidden rounded-xl border border-border bg-muted/50 shadow-sm dark:bg-zinc-900">
      {/* Label row shares the block's background — no divider, ChatGPT-style */}
      <div className="flex items-center justify-between px-4 pt-2">
        <span className="select-none text-xs text-muted-foreground">{languageLabel}</span>
        <button
          type="button"
          onClick={() =>
            copyTextToClipboard(raw).then((success) => {
              if (success) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            })
          }
          className={`rounded-md p-1 transition-opacity focus-visible:opacity-100 ${copied
            ? 'text-green-600 opacity-100 dark:text-green-500'
            : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100'
            }`}
          title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
          aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
        >
          {copied ? (
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a 1 1 0 010 1.414l-8 8a 1 1 0 01-1.414 0l-4-4a 1 1 0 011.414-1.414L8 12.586l7.293-7.293a 1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
            </svg>
          )}
        </button>
      </div>

      {isRegisteredLanguage(language) ? (
        <SyntaxHighlighter
          language={language}
          style={isDarkMode ? oneDark : oneLight}
          customStyle={{
            margin: 0,
            borderRadius: 0,
            fontSize: '0.8125rem',
            lineHeight: 1.6,
            padding: '0.5rem 1rem 1rem',
            // The container owns the background so the label row and code read as one panel.
            background: 'transparent',
          }}
          codeTagProps={{
            style: {
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              background: 'transparent',
            },
          }}
        >
          {raw}
        </SyntaxHighlighter>
      ) : (
        // Fence language without a registered grammar: plain monospace block
        // instead of refractor's "Unknown language" throw.
        <pre className="overflow-x-auto whitespace-pre px-4 pb-4 pt-1 font-mono text-[0.8125rem] leading-[1.6]">
          <code>{raw}</code>
        </pre>
      )}
    </div>
  );
});

// 保留现有静态图片地址语义；其他绝对引用按文件路径处理。
// 不按目录层级或扩展名猜测是否可读，权限由后端校验。
const COMMON_STATIC_WEB_PREFIX_RE = /^\/(assets|static|public|icons|images|favicon|logo)[/.?#]/i;
const BROWSER_LOADABLE_IMAGE_SRC = /^(https?:|data:|blob:)/i;

type MarkdownImageTarget =
  | { kind: 'browser'; src: string }
  | { kind: 'absolute' | 'relative'; path: string }
  | { kind: 'unresolved' };

/** 相对图片引用的双候选签名源：会话工作树拼接路径优先（外部接口 + 项目回退），项目根兜底；绝对路径维持单一候选。 */
function signedImageSources(
  target: MarkdownImageTarget,
  projectId: string | null,
  worktreePath: string | null,
): { primary: ImageMediaSource | null; fallback: ImageMediaSource | null } {
  const absolute = target.kind === 'absolute' ? target.path : null;
  if (absolute) {
    return {
      primary: { kind: 'external', path: absolute, ...(projectId ? { projectId, projectFallback: true } : {}) },
      fallback: null,
    };
  }
  if (target.kind !== 'relative' || !projectId) return { primary: null, fallback: null };
  const projectSource: ImageMediaSource = { kind: 'project', projectId, path: target.path };
  if (!worktreePath) return { primary: projectSource, fallback: null };
  return {
    primary: { kind: 'external', path: joinWorktreePath(worktreePath, target.path), projectId, projectFallback: true },
    fallback: projectSource,
  };
}

function resolveImageTarget(src: string): MarkdownImageTarget {
  const value = src.trim();
  if (!value) return { kind: 'unresolved' };
  if (BROWSER_LOADABLE_IMAGE_SRC.test(value) || value.startsWith('//') || COMMON_STATIC_WEB_PREFIX_RE.test(value)) {
    return { kind: 'browser', src: value };
  }
  if (isFileUrl(value)) {
    const filePath = filePathFromFileUrl(value);
    return filePath ? { kind: 'absolute', path: filePath } : { kind: 'unresolved' };
  }
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // 无效百分号编码可能是文件名中的字面字符，保留原文。
  }
  if (isLocalAbsolutePath(decoded)) {
    return { kind: 'absolute', path: decoded };
  }
  // 未知协议不能作为工作区文件名读取。
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return { kind: 'unresolved' };
  return { kind: 'relative', path: decoded.replace(/^\.\//, '') };
}

type MarkdownImageProps = { node?: unknown } & React.ImgHTMLAttributes<HTMLImageElement>;
type ImageLoadError = 'unauthorized' | 'forbidden' | 'notFound' | 'failed' | 'decode' | 'unresolved';


// 历史消息与流式回复共用此入口，本地文件复用鉴权接口，失败时保留引用。
function MarkdownImage(props: MarkdownImageProps) {
  const { projectId, worktreePath } = useContext(MarkdownWorkspaceContext);
  // 引用、项目或工作树变化时销毁旧的展开及错误状态。
  return <MarkdownImageContent key={JSON.stringify([projectId, worktreePath, props.src])} {...props} projectId={projectId} worktreePath={worktreePath ?? null} />;
}

function MarkdownImageContent({ src = '', alt, node: _node, projectId, worktreePath, ...props }: MarkdownImageProps & { projectId: string | null; worktreePath: string | null }) {
  const { t } = useTranslation('chat');
  const target = resolveImageTarget(src);
  const localPath = target.kind === 'absolute' ? target.path : undefined;
  const workspaceRelative = target.kind === 'relative' ? target.path : undefined;
  const browserSrc = target.kind === 'browser' ? target.src : undefined;
  const sources = signedImageSources(target, projectId, worktreePath);
  const { observe, ...signed } = useSignedImageCandidates(sources.primary, sources.fallback);
  const key = JSON.stringify([projectId, worktreePath, src]);
  // 网页图片保留自己的加载错误；本地错误由签名 Hook 提供。
  const [browserFailed, setBrowserFailed] = useState(false);
  // 显示复制结果，让用户知道是否需要手动复制路径。
  const [copyResult, setCopyResult] = useState<{ key: string; success: boolean } | null>(null);
  // 仅用户点击时打开查看器，加载或切换图片不能自动打开。
  const [expanded, setExpanded] = useState<string | null>(null);
  const unresolved = target.kind === 'unresolved' || (target.kind === 'relative' && !projectId);
  const error: ImageLoadError | undefined = browserFailed ? 'failed' : signed.error ?? (unresolved ? 'unresolved' : undefined);
  const imageSrc = browserSrc ?? signed.url;

  if (error) {
    return (
      <span ref={observe} role="status" className="my-2 inline-flex max-w-full flex-col gap-1 rounded-lg border p-3 text-sm">
        {alt && <span>{alt}</span>}
        <span>{t(`imageLoad.${error}`)}</span>
        {src && <code className="whitespace-pre-wrap break-all text-xs">{src}</code>}
        <span className="flex gap-3">
          {src && <button type="button" onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void copyTextToClipboard(localPath ?? workspaceRelative ?? src).then((success) => setCopyResult({ key, success }));
          }}>{t('common:fileOperations.copyPath')}</button>}
          {!unresolved && <button type="button" onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (browserSrc) setBrowserFailed(false); else signed.retry();
          }}>{t('common:buttons.retry')}</button>}
        </span>
        {copyResult?.key === key && <span>{t(copyResult.success ? 'imageLoad.copied' : 'imageLoad.copyFailed')}</span>}
      </span>
    );
  }

  if (!imageSrc) {
    return <span ref={observe} aria-hidden className="my-1 block h-28 max-w-sm animate-pulse rounded-lg bg-muted" />;
  }

  const image = <img {...props} src={imageSrc} alt={alt} loading="lazy" decoding="async" className="rounded-lg"
    referrerPolicy="no-referrer" onLoad={signed.onLoad} onError={() => browserSrc ? setBrowserFailed(true) : signed.onError()} />;
  if (browserSrc) return image;
  return (
    <>
      <button ref={observe} type="button" onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(key);
      }} aria-label={t('misc.expandImage', { name: alt ?? '' })} className="block max-w-full cursor-zoom-in">
        {image}
      </button>
      {expanded === key && (
        <UnifiedImageViewer src={imageSrc} alt={alt ?? ''} title={alt ?? ''}
          resolveSrc={signed.ensureFresh} onImageError={signed.onError} onImageLoad={signed.onLoad} filePath={localPath ?? workspaceRelative} onClose={() => setExpanded(null)} />
      )}
    </>
  );
}

function ImageReferenceLink({ source, projectId, worktreePath, children }: {
  source: string;
  projectId: string | null;
  worktreePath: string | null;
  children: React.ReactNode;
}) {
  const { t } = useTranslation('chat');
  const target = resolveImageTarget(source);
  // 查看器仍由用户点击打开；签名同时承担挂载时的存在性探测。
  const [expanded, setExpanded] = useState(false);
  // 远程图片的解码失败不属于本地签名请求，单独保留以提供重试。
  const [browserFailed, setBrowserFailed] = useState(false);
  const sources = signedImageSources(target, projectId, worktreePath);
  const signed = useSignedImageCandidates(sources.primary, sources.fallback, { eager: true });
  const unresolved = target.kind === 'unresolved' || (target.kind === 'relative' && !projectId);
  const error = expanded ? unresolved ? 'unresolved' : browserFailed ? 'failed' : signed.error : undefined;
  const imageSrc = target.kind === 'browser' ? target.src : signed.url;
  const path = target.kind === 'absolute' || target.kind === 'relative' ? target.path : source;
  const loading = expanded && !imageSrc && !error;
  const open = () => {
    setExpanded(true);
    setBrowserFailed(false);
    if (signed.error) signed.retry();
  };

  // 探测明确不存在或不可读的本地引用按默认样式显示，不提供点击；其余保持原有可点行为。
  if (!unresolved && target.kind !== 'browser' && (signed.error === 'notFound' || signed.error === 'forbidden')) {
    return <>{children}</>;
  }

  return <>
    <button type="button" title={source} disabled={loading} aria-busy={loading || undefined}
      className="max-w-full break-all text-left text-blue-600 hover:underline dark:text-blue-400 [&_code]:text-inherit"
      onClickCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
        open();
      }}>{children}</button>
    {loading && <span role="status" className="ml-2 text-xs text-muted-foreground">{t('codeEditor:filePreview.loading')}</span>}
    {error && <span role="status" className="ml-2 inline-flex max-w-full flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{t(`imageLoad.${error}`)}</span>
      <code className="break-all">{path}</code>
      {!unresolved && <button type="button" onClick={open}>{t('common:buttons.retry')}</button>}
    </span>}
    {expanded && imageSrc && !error && <UnifiedImageViewer src={imageSrc} alt={source} title={source} filePath={path}
      resolveSrc={target.kind === 'browser' ? undefined : signed.ensureFresh}
      onImageError={target.kind === 'browser' ? () => setBrowserFailed(true) : signed.onError}
      onImageLoad={target.kind === 'browser' ? undefined : signed.onLoad}
      onClose={() => setExpanded(false)} />}
  </>;
}

/** 聊天 Markdown 用它渲染本地文件与目录引用，探测明确不可读时退回普通文字。 */
function FileReferenceLink({ href, reference, projectId, worktreePath, children }: {
  href: string;
  reference: string;
  projectId: string | null;
  worktreePath: string | null;
  children: React.ReactNode;
}) {
  const { openFileInEditor, openDirectory } = usePaletteOps();
  // 与点击目标保持一致：目录引用保留结尾斜杠，文件引用去掉行号后缀再探测。
  const probePath = reference.endsWith('/') ? reference : stripLineSuffix(reference);
  const resolvable = isLocalAbsolutePath(probePath) || !!projectId;
  const candidates = resolvable
    ? referenceProbeCandidates(probePath, projectId, worktreePath)
    : { primary: null, fallback: null };
  const toProbeSource = (path: string | null) => path !== null && (isLocalAbsolutePath(path) || projectId)
    ? { path, projectId: projectId ?? undefined }
    : null;
  const { verdict, existsPath } = usePathExistsCandidates(toProbeSource(candidates.primary), toProbeSource(candidates.fallback));
  if (verdict === 'missing') return <>{children}</>;
  return (
    <a
      href={href}
      className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400 [&_code]:text-inherit"
      onClick={(event) => {
        event.preventDefault();
        // 工作树候选命中时打开那份副本，否则维持项目根语义的原始引用。
        const target = verdict === 'exists' && existsPath ? existsPath : reference;
        if (reference.endsWith('/')) {
          openDirectory(target);
          return;
        }
        openFileInEditor(stripLineSuffix(target), lineFromRef(reference));
      }}
    >
      {children}
    </a>
  );
}

const markdownComponents = {
  code: CodeBlock,
  // 工作区引用转换为短期签名 URL，浏览器直接加载字节。
  img: MarkdownImage,
  // Fenced/indented code arrives as <pre><code>. Re-render the child CodeBlock
  // with `forceBlock` so it always gets the block treatment (react-markdown v9+
  // no longer passes an `inline` flag), and skip the outer <pre> so Tailwind
  // Typography doesn't wrap the highlighter in a second dark shell.
  pre: ({ children }: { children?: React.ReactNode }) => {
    const child = Array.isArray(children) ? children.find(React.isValidElement) : children;
    if (React.isValidElement(child) && child.type === CodeBlock) {
      return <CodeBlock {...(child.props as CodeBlockProps)} forceBlock />;
    }
    return <>{children}</>;
  },
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-3 border-l-2 border-primary/50 pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-t border-border" />,
  p: ({ children }: { children?: React.ReactNode }) => <div className="mb-2 last:mb-0">{children}</div>,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-2 list-outside list-disc space-y-1 pl-5 marker:text-current last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-2 list-outside list-decimal space-y-1 pl-5 marker:text-current last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li className="[&>div:last-child]:mb-0 [&>div]:mb-1">{children}</li>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      {/* my-0 cancels Tailwind Typography's table margin, which would show as blank bands inside the border */}
      <table className="my-0 min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-muted/60">{children}</thead>,
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="[&:last-child>td]:border-b-0">{children}</tr>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-b border-border/60 px-3 py-2 align-top">{children}</td>
  ),
};

type MarkdownBodyProps = {
  children: string;
  /** Render single newlines as hard line breaks (for user-typed messages). */
  breaks?: boolean;
};

// Memoized: a re-render of an unchanged message must not re-parse its
// markdown (react-markdown runs the whole remark/rehype pipeline
// synchronously, plus KaTeX and Prism highlighting).
//
// Renders the markdown AST without a wrapper element so StreamingMarkdown can
// place the settled and pending halves of a streaming reply side by side as
// direct children of one prose container, keeping block spacing identical to a
// single-document render.
export const MarkdownBody = memo(function MarkdownBody({ children, breaks = false }: MarkdownBodyProps) {
  const content = useMemo(
    // The LaTeX pass runs second because it reads the code spans the fence pass
    // normalizes, and must leave the LaTeX inside them literal.
    () => normalizeLatexDelimiters(normalizeInlineCodeFences(children)),
    [children],
  );
  // Math support costs a remark tree pass plus a full KaTeX walk on every
  // render, and almost no assistant message contains math. Only wire the two
  // plugins up when the text has a delimiter they could act on.
  const hasMath = useMemo(() => MATH_DELIMITER.test(content), [content]);
  const exceedsParseBudget = useMemo(() => longestInlineRun(content) > INLINE_RUN_PARSE_LIMIT, [content]);
  const remarkPlugins = useMemo(
    () => (breaks
      ? [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkBreaks, remarkImageReferences, remarkFileReferences]
      : [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkImageReferences, remarkFileReferences]) as any,
    [breaks],
  );
  const rehypePlugins = useMemo(() => (hasMath ? [rehypeKatex] : EMPTY_PLUGINS), [hasMath]);
  const { projectId, worktreePath } = useContext(MarkdownWorkspaceContext);
  const { t } = useTranslation('chat');

  const components = useMemo(
    () => ({
      ...markdownComponents,
      a: ({ href, children: linkChildren }: { href?: string; children?: React.ReactNode }) => {
        // Prefer the href when it is a real path; otherwise fall back to the
        // link text, since models often emit `[src/foo.ts]()` with an empty href.
        // Normalize Markdown's percent-escaped local paths and `file://` URLs
        // before handing them to the editor.
        const linkText = childrenToText(linkChildren);
        const pathHref = fileReferenceFromMarkdownHref(href);
        const fileRef = looksLikeFilePath(pathHref) ? pathHref : looksLikeFilePath(linkText) ? linkText : undefined;

        const imageSource = href?.trim() || linkText.trim();
        if (isImageReference(imageSource) && !shouldProxyLocalHref(imageSource, window.location.origin)) {
          return <ImageReferenceLink key={JSON.stringify([projectId, worktreePath, imageSource])} source={imageSource} projectId={projectId} worktreePath={worktreePath ?? null}>{linkChildren}</ImageReferenceLink>;
        }

        if (fileRef && !isExternalHref(pathHref)) {
          return (
            // fileRef 来自链接文字回退时可能带尾随空格（``[`src/foo.ts:12` ]()``），
            // 会破坏按 `$` 锚定的行号后缀剥离，这里与点击时一样先归一化。
            <FileReferenceLink key={JSON.stringify([projectId, worktreePath, fileRef])} href={pathHref || fileRef} reference={fileRef.trim()} projectId={projectId} worktreePath={worktreePath ?? null}>
              {linkChildren}
            </FileReferenceLink>
          );
        }

        if (shouldProxyLocalHref(href, window.location.origin)) {
          return (
            <a
              href={href}
              className="text-blue-600 hover:underline dark:text-blue-400"
              title={t('localProxy.linkHint')}
              onClick={(event) => {
                event.preventDefault();
                void openThroughLocalProxy(href as string, window.open('', '_blank'), t('localProxy.failed'));
              }}
            >
              {linkChildren}
            </a>
          );
        }

        return (
          <a
            href={href}
            className="text-blue-600 hover:underline dark:text-blue-400"
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkChildren}
          </a>
        );
      },
    }),
    [projectId, worktreePath, t],
  );

  if (exceedsParseBudget) {
    // Verbatim text keeps every character readable and copyable; only the
    // formatting is lost, and only for text the parser could not handle.
    return <div className="whitespace-pre-wrap break-words">{children}</div>;
  }

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={markdownUrlTransform}
      components={components as any}
    >
      {content}
    </ReactMarkdown>
  );
});

// Memoized shell: children/className/breaks are compared shallowly, so an
// unchanged message re-renders neither the shell nor the parse inside.
export const Markdown = memo(function Markdown({ children, className, breaks = false }: MarkdownProps) {
  return (
    <div className={className}>
      <MarkdownBody breaks={breaks}>{String(children ?? '')}</MarkdownBody>
    </div>
  );
});
