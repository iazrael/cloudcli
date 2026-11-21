import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import CodeEditorPdfViewer, { type PdfViewerHandle } from '@/modules/code-editor/CodeEditorPdfViewer';

const { getDocumentMock } = vi.hoisted(() => ({ getDocumentMock: vi.fn() }));

vi.mock('pdfjs-dist', () => ({
  getDocument: getDocumentMock,
  GlobalWorkerOptions: {},
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.min.mjs' }));

const scrollIntoViewMock = vi.fn();

const stubFetch = () =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Response);

// 返回带 destroy 的 loading-task 形状，组件卸载时经它销毁。
const stubGetDocument = (doc?: unknown, error?: unknown) => {
  const destroy = vi.fn(async () => {});
  getDocumentMock.mockReturnValue({
    promise: error ? Promise.reject(error) : Promise.resolve(doc),
    destroy,
  });
  return { destroy };
};

const makeDoc = (numPages: number) => ({
  numPages,
  getPage: vi.fn(async () => ({
    getViewport: () => ({ width: 612, height: 792 }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  })),
});

beforeEach(() => {
  getDocumentMock.mockReset();
  (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollIntoViewMock;
  // jsdom 未实现 canvas 2D 上下文；渲染路径只需把上下文传给（被 mock 的）render。
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('加载文档后渲染占位页并上报第 1 页', async () => {
  stubFetch();
  const doc = makeDoc(3);
  stubGetDocument(doc);
  const onPageInfoChange = vi.fn();
  render(<CodeEditorPdfViewer srcUrl="blob:pdf" errorLabel="broken" onPageInfoChange={onPageInfoChange} />);
  await waitFor(() => expect(onPageInfoChange).toHaveBeenCalledWith({ current: 1, total: 3 }));
  expect(getDocumentMock).toHaveBeenCalledWith({ data: expect.any(Uint8Array) });
  // jsdom 没有 IntersectionObserver，可见页懒渲染不触发，占位页保留页码文本。
  expect(screen.getByText('3')).toBeTruthy();
});

it('handle 跳页会滚动到目标页并上报新页码', async () => {
  stubFetch();
  const doc = makeDoc(3);
  stubGetDocument(doc);
  const onPageInfoChange = vi.fn();
  const ref: { current: PdfViewerHandle | null } = { current: null };
  render(<CodeEditorPdfViewer ref={ref} srcUrl="blob:pdf" errorLabel="broken" onPageInfoChange={onPageInfoChange} />);
  await waitFor(() => expect(ref.current).not.toBeNull());
  act(() => ref.current?.goToPage(2));
  expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' });
  expect(onPageInfoChange).toHaveBeenLastCalledWith({ current: 2, total: 3 });
});

it('加载失败时显示错误文案', async () => {
  stubFetch();
  stubGetDocument(undefined, new Error('corrupt'));
  render(<CodeEditorPdfViewer srcUrl="blob:pdf" errorLabel="broken" />);
  await screen.findByText('broken');
});

it('卸载时取消进行中的渲染任务并销毁文档', async () => {
  stubFetch();
  // jsdom 没有这两个 observer；桩成"立即相交 + 固定宽度"，让懒渲染路径跑起来。
  class FakeResizeObserver {
    constructor(private callback: (entries: { contentRect: { width: number } }[]) => void) {}
    observe() {
      this.callback([{ contentRect: { width: 500 } }]);
    }
    unobserve() {}
    disconnect() {}
  }
  class FakeIntersectionObserver {
    constructor(private callback: (entries: { isIntersecting: boolean; target: Element }[]) => void) {}
    observe(el: Element) {
      this.callback([{ isIntersecting: true, target: el }]);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

  const cancel = vi.fn();
  const doc = {
    numPages: 2,
    // 渲染任务永不完成，模拟"卸载时仍有页面在画"。
    getPage: vi.fn(async () => ({
      getViewport: () => ({ width: 612, height: 792 }),
      render: () => ({ promise: new Promise<void>(() => {}), cancel }),
    })),
  };
  const task = stubGetDocument(doc);

  const view = render(<CodeEditorPdfViewer srcUrl="blob:pdf" errorLabel="broken" />);
  await waitFor(() => expect(doc.getPage).toHaveBeenCalled());
  view.unmount();
  expect(cancel).toHaveBeenCalled();
  expect(task.destroy).toHaveBeenCalledTimes(1);
});
