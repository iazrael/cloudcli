import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
// Vite 在构建期把 ？url 后缀编译成资源 URL 字符串（类型由 vite/client 提供）；
// oxlint 的 import 插件解析不了带 query 的深层导入，此处为误报。
// oxlint-disable-next-line import/default
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// worker 指向 Vite 打包出的本地资源；本模块经 React.lazy 动态引入，
// pdf.js 与 worker 只在真正打开 PDF 时才下载。
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** 当前可见页码与总页数，由 viewer 上报给宿主用于工具栏显示。 */
export type PdfPageInfo = { current: number; total: number };

type PdfViewerProps = {
  /** Blob URL；字节必须已通过 magic-byte 校验。 */
  srcUrl: string;
  errorLabel: string;
  onPageInfoChange?: (info: PdfPageInfo | null) => void;
};

export type PdfViewerHandle = {
  /** 跳到指定页（1 起始），越界时收敛到首尾。 */
  goToPage: (page: number) => void;
};

type PageSize = { width: number; height: number };

// IntersectionObserver 的预渲染边距：提前把即将滚入的页画好，滚动不露白。
const PRE_RENDER_MARGIN = '600px 0px';
// 渲染像素密度上限，避免高分屏下 canvas 过大。
const MAX_DEVICE_PIXEL_RATIO = 2;
// 页面 CSS 宽度上限；超宽屏上全宽渲染会显得过大。
const MAX_PAGE_CSS_WIDTH = 1100;
// 宽度抖动小于 1px 视为未变化。
const WIDTH_EPSILON = 1;

/**
 * Lazy-loaded by CodeEditorMediaPreview to render PDF files in-app with pdf.js:
 * continuous scroll across all pages plus page navigation, so embedded PDFs
 * show every page even in WebKit browsers whose built-in viewer only renders
 * the first page inside an iframe. Isolated in its own module so the pdf.js
 * bundle is only fetched when a PDF is actually opened.
 */
const CodeEditorPdfViewer = forwardRef<PdfViewerHandle, PdfViewerProps>(function CodeEditorPdfViewer(
  { srcUrl, errorLabel, onPageInfoChange },
  ref,
) {
  // 文档对象放 ref：不参与渲染；加载任务用 effect 局部变量在各次加载的
  // cleanup 里销毁（pdf.js v6 起文档的销毁走 loadingTask.destroy()）。
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pageElsRef = useRef<(HTMLDivElement | null)[]>([]);
  // 总页数同时存 ref：滚动、跳页和上报回调都读 ref，回调身份保持稳定，
  // 不因加载完成后 numPages 状态更新而重新触发加载 effect。
  const numPagesRef = useRef(0);
  // 已完成渲染的页；宽度变化后作废以便重画。
  const renderedPagesRef = useRef<Set<number>>(new Set());
  // 当前与滚动容器相交的页，resize 后按它重画可见页。
  const intersectingRef = useRef<Set<number>>(new Set());
  const renderTasksRef = useRef<Map<number, { cancel: () => void }>>(new Map());
  const scrollRafRef = useRef<number | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  // 最近一次上报的页码，用于滚动回调去重。
  const reportedPageRef = useRef<PdfPageInfo | null>(null);
  // 回调走 ref 转发，宿主传入的内联函数不会触发本组件重新加载文档。
  const onPageInfoRef = useRef(onPageInfoChange);
  useEffect(() => {
    onPageInfoRef.current = onPageInfoChange;
  });

  // 总页数 state 只用于渲染占位列表。
  const [numPages, setNumPages] = useState(0);
  // 第 1 页的原始尺寸；占位高度按它估算，个别页面尺寸不同由渲染时校正。
  const [basePageSize, setBasePageSize] = useState<PageSize | null>(null);
  // 滚动容器内容宽度（ResizeObserver 上报），页面按它 fit-width 渲染。
  const [containerWidth, setContainerWidth] = useState(0);
  // 加载失败的错误文案；null 表示加载与渲染正常。
  const [error, setError] = useState<string | null>(null);

  const cancelAllRenderTasks = useCallback(() => {
    for (const task of renderTasksRef.current.values()) {
      try {
        task.cancel();
      } catch {
        // cancel 不应抛错；防御性处理避免清理中断。
      }
    }
    renderTasksRef.current.clear();
  }, []);

  const reportPage = useCallback((current: number) => {
    const total = numPagesRef.current;
    if (!total || reportedPageRef.current?.current === current) return;
    reportedPageRef.current = { current, total };
    onPageInfoRef.current?.({ current, total });
  }, []);

  // 渲染单页：以容器宽度定标，按设备像素比绘制；同页并发与重复渲染都会被跳过。
  const renderPage = useCallback(
    async (pageIndex: number) => {
      const doc = docRef.current;
      const el = pageElsRef.current[pageIndex];
      if (!doc || !el || containerWidth <= 0) return;
      if (renderedPagesRef.current.has(pageIndex) || renderTasksRef.current.has(pageIndex)) return;

      // 先占位，防止同一页因 observer 重复回调而并发渲染。
      renderTasksRef.current.set(pageIndex, { cancel: () => {} });
      try {
        const page = await doc.getPage(pageIndex + 1);
        if (!docRef.current || !el.isConnected) return;
        const base = page.getViewport({ scale: 1 });
        const cssWidth = Math.min(containerWidth, MAX_PAGE_CSS_WIDTH);
        const cssScale = cssWidth / base.width;
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
        const viewport = page.getViewport({ scale: cssScale * dpr });
        // 按本页实际比例校正占位高度（多数 PDF 页面尺寸一致，通常无需变化）。
        el.style.height = `${Math.round(cssScale * base.height)}px`;

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        el.textContent = '';
        el.appendChild(canvas);

        const task = page.render({ canvas, canvasContext: canvas.getContext('2d') ?? undefined, viewport });
        renderTasksRef.current.set(pageIndex, task);
        await task.promise;
        renderedPagesRef.current.add(pageIndex);
      } catch (renderError: unknown) {
        // 离屏取消属正常流程；其余失败保留占位，交由 observer 后续重试。
        if ((renderError as { name?: string } | null)?.name === 'RenderingCancelledException') return;
        console.error('[PdfViewer] page render failed:', renderError);
        renderedPagesRef.current.delete(pageIndex);
      } finally {
        renderTasksRef.current.delete(pageIndex);
      }
    },
    [containerWidth],
  );

  // 加载文档：字节来自已校验的 blob URL；卸载或换文件时取消一切并销毁文档。
  useEffect(() => {
    let cancelled = false;
    // 本次加载的任务只交给本 effect 的 cleanup 销毁，不经过 ref。
    let activeLoadingTask: PDFDocumentLoadingTask | null = null;
    setError(null);
    setNumPages(0);
    numPagesRef.current = 0;
    setBasePageSize(null);
    reportedPageRef.current = null;
    renderedPagesRef.current.clear();
    intersectingRef.current.clear();

    const load = async () => {
      try {
        const response = await fetch(srcUrl);
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        const loadingTask = pdfjsLib.getDocument({ data });
        activeLoadingTask = loadingTask;
        const doc = await loadingTask.promise;
        if (cancelled) return;
        docRef.current = doc;
        const firstPage = await doc.getPage(1);
        if (cancelled) return;
        const viewport = firstPage.getViewport({ scale: 1 });
        setBasePageSize({ width: viewport.width, height: viewport.height });
        numPagesRef.current = doc.numPages;
        setNumPages(doc.numPages);
        reportPage(1);
      } catch (loadError: unknown) {
        if (cancelled) return;
        console.error('[PdfViewer] failed to load document:', loadError);
        setError(errorLabel);
      }
    };
    void load();

    return () => {
      cancelled = true;
      cancelAllRenderTasks();
      docRef.current = null;
      // destroy 会中止未完成的加载并销毁文档与 worker。
      void activeLoadingTask?.destroy();
      onPageInfoRef.current?.(null);
    };
  }, [srcUrl, errorLabel, reportPage, cancelAllRenderTasks]);

  // 跟踪滚动容器宽度；宽度变化触发重渲染（见下方失效 effect）。
  useEffect(() => {
    const wrapper = contentRef.current;
    if (!wrapper || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth((previous) => (Math.abs(previous - width) < WIDTH_EPSILON ? previous : width));
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // 容器宽度变化后旧 canvas 尺寸不再匹配：作废渲染记录并取消进行中的任务，
  // 交由下方 observer effect 重新观察并对可见页重画。
  useEffect(() => {
    if (containerWidth <= 0) return;
    cancelAllRenderTasks();
    renderedPagesRef.current.clear();
  }, [containerWidth, cancelAllRenderTasks]);

  // 观察各页与滚动容器的相交状态：进入（含预渲染边距）即渲染，离开则登记。
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!numPages || !scrollEl || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.pageIndex);
          if (entry.isIntersecting) {
            intersectingRef.current.add(index);
            void renderPage(index);
          } else {
            intersectingRef.current.delete(index);
          }
        }
      },
      { root: scrollEl, rootMargin: PRE_RENDER_MARGIN },
    );
    for (const el of pageElsRef.current) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [numPages, containerWidth, renderPage]);

  // 滚动时把容器中线所在页上报给宿主；rAF 节流避免高频回调。
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const scrollEl = scrollRef.current;
      if (!numPagesRef.current || !scrollEl) return;
      const midline = scrollEl.scrollTop + scrollEl.clientHeight / 2;
      let current = numPagesRef.current;
      for (let index = 0; index < numPagesRef.current; index += 1) {
        const el = pageElsRef.current[index];
        if (el && el.offsetTop + el.offsetHeight > midline) {
          current = index + 1;
          break;
        }
      }
      reportPage(current);
    });
  }, [reportPage]);

  useImperativeHandle(
    ref,
    () => ({
      goToPage: (page: number) => {
        if (!numPagesRef.current) return;
        const target = Math.min(Math.max(page, 1), numPagesRef.current);
        // jsdom 未实现 scrollIntoView，测试里以桩替换，运行时按可选调用兜底。
        pageElsRef.current[target - 1]?.scrollIntoView?.({ block: 'start' });
        // 立即上报目标页；滚动结束后的滚动回调会把页码收敛到实际落点。
        reportPage(target);
      },
    }),
    [reportPage],
  );

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {error}
      </div>
    );
  }

  const pageCssWidth = containerWidth > 0 ? Math.min(containerWidth, MAX_PAGE_CSS_WIDTH) : 0;
  const pageCssHeight =
    pageCssWidth > 0 && basePageSize ? (pageCssWidth * basePageSize.height) / basePageSize.width : undefined;

  return (
    <div ref={scrollRef} className="relative h-full w-full overflow-y-auto" onScroll={handleScroll}>
      <div ref={contentRef} className="flex flex-col items-center gap-3 p-3">
        {Array.from({ length: numPages }, (_, index) => (
          <div
            key={index}
            ref={(el) => {
              pageElsRef.current[index] = el;
            }}
            data-page-index={index}
            className="flex items-center justify-center overflow-hidden bg-white text-xs text-muted-foreground shadow-sm"
            style={{ width: pageCssWidth || undefined, height: pageCssHeight }}
          >
            {index + 1}
          </div>
        ))}
      </div>
    </div>
  );
});

export default CodeEditorPdfViewer;
