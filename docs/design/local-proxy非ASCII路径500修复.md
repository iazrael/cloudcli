# local-proxy 非 ASCII 路径 500 修复

状态：已实施（本文件为唯一进度记录处）

## 目标

聊天链接经 local-proxy 转发含非 ASCII 字符的本地服务路径（如 `http://127.0.0.1:8766/试听.html`）时不再返回 500 INTERNAL_ERROR，上游收到正确编码的路径。

## 根因

`server/shared/utils.ts` 的 `forwardToLoopbackService` 把 Express 解码后的路径（`req.params[0]`，如 `/试听.html`）直接作为 `path` 传给 `http.request()`；Node 对含未转义非 ASCII 的请求路径抛 `ERR_UNESCAPED_CHARACTERS`，被全局错误处理转成 500。

## 方案

在 `forwardToLoopbackService` 内只对 `?` 之前的 pathname 做 `encodeURI`，query 部分原样透传：

- pathname 经"浏览器编码 → Express 解码 → encodeURI"是编码往返，无损还原（`%E8%AF%95` → `试听` → `%E8%AF%95`；`100%25.html` → `100%.html` → `100%25.html`）。
- query 两处调用方均已编码（local-proxy 由 URLSearchParams 重建、plugins 从 `req.url` 原样截取），不能整段 path 一起 encodeURI——实测 `encodeURI('?q=%E4%B8%AD')` 会把已有 `%XX` 二次编码成 `%25XX`，打坏现存的非 ASCII query。

覆盖范围：local-proxy 与 plugins rpc 两个调用方共用此函数，同根因一次修复。routes 层不改。

## 验证

- `local-proxy.routes.test.ts` 新增非 ASCII 路径用例（`/试听.html`），断言上游收到的原始 `req.url` 为 percent 编码形式；修复前红（500）、修复后绿。
- 新增含非 ASCII 值 query 的回归用例（`?q=中文`），钉死 query 不被二次编码。
- `npm run test`（模块范围）、`npm run build`、`npm run typecheck`、`npm run lint`。

## 风险

- pathname 中的字面 `#`（Express 解码 `%23` 而来）encodeURI 不转义，行为与现状一致（上游按 fragment 截断），无回归。
- Express 对非法 percent 序列（如裸 `100%.html` 的请求行）本就在参数解码时拒绝，进不到转发层。
- 纯 ASCII 路径 encodeURI 为恒等变换，现有行为不变。

## 关联

- 运行时产物上有旧热补丁（`~/.cloudcli/runtime/.../utils.js` 整段 path encodeURI），与 query 不二次编码的结论冲突，发版部署后随之覆盖作废，不再单独重启生效。
