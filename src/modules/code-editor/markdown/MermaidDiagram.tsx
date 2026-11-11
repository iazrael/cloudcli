import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
// Type-only: erased at build time, so it does not pull mermaid into the main chunk.
import type mermaid from 'mermaid';

import { useTheme } from '@/shared/context/ThemeContext';
import { UnifiedImageViewer } from '@/shared/ui';

// Mermaid is ~1.5MB minified, so it is loaded on demand the first time a
// diagram is rendered and shared by every instance afterwards.
let mermaidPromise: Promise<typeof mermaid> | null = null;
const loadMermaid = () => {
  mermaidPromise ??= import('mermaid').then((module) => module.default);
  return mermaidPromise;
};

// Data URL for the fullscreen viewer. mermaid returns DOMPurify's HTML
// serialization (unclosed <br>, &nbsp;), but <img> parses image/svg+xml as
// strict XML and rejects the whole image on either; reading it with the HTML
// parser and writing it back with XMLSerializer yields well-formed XML.
// Mermaid also emits a relative width plus a max-width style, which leaves an
// <img> without an intrinsic size; rewriting both from the viewBox makes the
// viewer's 100% zoom the diagram's native pixel size and lets object-fit
// letterbox it into the screen.
const toViewerDataUrl = (svg: string): string => {
  const root = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
  if (!root) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    root.setAttribute('width', String(Math.round(viewBox[2])));
    root.setAttribute('height', String(Math.round(viewBox[3])));
    root.style.removeProperty('max-width');
  }
  // The HTML parser keeps mermaid's xmlns on foreignObject's HTML children as a
  // plain attribute; XMLSerializer declares the namespace itself, so leaving it
  // would emit a duplicate xmlns, which is again malformed XML.
  root.querySelectorAll('foreignObject *').forEach((element) => element.removeAttribute('xmlns'));
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
};

type MermaidDiagramProps = {
  /** Raw mermaid source, i.e. the body of a ```mermaid fenced block. */
  code: string;
};

/**
 * Renders a ```mermaid code block as an SVG diagram, GitHub-preview style.
 *
 * Used by the chat module to render mermaid blocks in assistant messages, and
 * by MarkdownCodeBlock inside code-editor for markdown previews.
 *
 * While mermaid is loading — or when the source doesn't parse (e.g. a block
 * that is still streaming in) — the raw source is shown instead, so the
 * content is never blank or replaced by an error box. The rendered diagram
 * opens the shared fullscreen image viewer on click, so wide diagrams stay
 * readable on phones (pinch zoom, pan and the zoom buttons come for free).
 */
export default function MermaidDiagram({ code }: MermaidDiagramProps) {
  const { isDarkMode } = useTheme();
  const { t } = useTranslation();
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  // 用户点击流程图后打开的全屏查看器；关闭即卸载，不常驻 DOM。
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;

    loadMermaid()
      .then((mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDarkMode ? 'dark' : 'default',
          suppressErrorRendering: true,
        });
        return mermaid.render(renderId, code.trim());
      })
      .then((result) => {
        if (!cancelled) {
          setSvg(result.svg);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSvg(null);
        }
        // suppressErrorRendering still leaves the scratch element behind on
        // parse failures in some mermaid versions; clean it up.
        document.getElementById(`d${renderId}`)?.remove();
      });

    return () => {
      cancelled = true;
    };
  }, [code, isDarkMode, reactId]);

  if (!svg) {
    return (
      <pre className="my-3 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 font-mono text-[0.8125rem] leading-relaxed text-muted-foreground dark:bg-zinc-900">
        {code.trim()}
      </pre>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={t('common:imageViewer.expandDiagram')}
        className="my-3 block w-full cursor-zoom-in rounded-xl border border-border bg-white text-left shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60 dark:bg-zinc-900"
      >
        <div
          className="flex justify-center overflow-x-auto p-4 [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </button>
      {expanded && (
        <UnifiedImageViewer
          src={toViewerDataUrl(svg)}
          alt={t('common:imageViewer.diagram')}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}
