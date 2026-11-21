# PDF 预览改用 pdfjs 内渲染

状态：已实现

## 目标与范围

文件树打开 PDF 时，内嵌预览目前把整份文件交给同源 iframe 里的浏览器内置查看器（`CodeEditorMediaPreview` 的 pdf 分支）。WebKit 内核浏览器（Safari 及其套壳）对 iframe 内嵌 PDF 只渲染第一页且无翻页控件，导致只能看一页。改为用 pdf.js（`pdfjs-dist`）在应用内渲染全部页面：连续滚动、显示页码、支持前后翻页，各浏览器表现一致。

范围：仅 code-editor 模块的 PDF 预览链路及其 i18n 文案。图片/音视频预览、后端接口不变；open in new tab、全屏、magic-byte 校验全部保留。

## 方案

- 新增 `CodeEditorPdfViewer.tsx`（模块内组件，不进 barrel，仅被 `CodeEditorMediaPreview` 使用）：接收已校验字节的 blob URL，在组件内 fetch 出 ArrayBuffer 交给 `getDocument`；逐页懒渲染。
- 渲染：页面按容器宽度缩放（fit-width）；每页一个占位块，用第 1 页宽高比估高，渲染完成后按实际尺寸校正；IntersectionObserver 判定可见页，只为可见页绘制 canvas，离开视口时取消进行中的渲染任务，避免大文档撑爆内存。
- 页码导航：observer 上报当前可见页，工具栏显示 `n / total`，并加前进/后退按钮（scrollIntoView 定位目标页）。
- 懒加载：`CodeEditorMediaPreview` 用 `React.lazy` 动态引入 viewer，`pdfjs-dist` 与 worker 仅在打开 PDF 时下载；worker 通过 `pdfjs-dist/build/pdf.worker.min.mjs?url` 注入 `GlobalWorkerOptions.workerSrc`。
- 安全：不再用同源 iframe；字节仍来自 authenticatedFetch 且已过 `%PDF-` magic-byte 校验（pdf.js 按字节解析，不在应用源执行脚本）。加密 PDF 捕获 `PasswordException` 走现有错误文案。
- 文案：`codeEditor.json` 的 `filePreview` 增加 `prevPage`、`nextPage`，全部 15 个语言补齐。

## 验证与风险

- 新增 `tests/codeEditorPdfViewer.test.tsx`：mock `pdfjs-dist`，验证页码渲染、前进/后退、加载失败文案、卸载时销毁文档与取消渲染任务。
- 跑该测试文件，随后 `npm run test:client`、`npm run build:client`、typecheck、lint；Safari/Chrome 手动打开多页 PDF 确认连续滚动与翻页（部署后由用户验收）。
- 风险：bundle 增加约 1MB，已按需分包，只在打开 PDF 时加载；首版只做 fit-width，不做手动缩放，需要时再迭代。
