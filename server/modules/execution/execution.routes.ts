import { timingSafeEqual } from 'node:crypto';

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { createExecutionService } from './execution.service.js';

type RouterOptions = {
  token: string | undefined;
  service(): ReturnType<typeof createExecutionService>;
};

/** 服务入口在通用 API 鉴权之外挂载此 MCP 路由，由专用令牌和本机限制保护。 */
export function createExecutionRouter(options: RouterOptions): express.Router {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!options.token || options.token.length < 32) {
      res.status(503).json({ error: '执行 MCP 未启用：需要至少 32 字符的 CLOUDCLI_EXECUTION_TOKEN 和允许目录配置' });
      return;
    }
    // 只接受直接本机连接，不信任代理头，也不接受浏览器和公网域名。
    const peer = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') || req.headers.origin
      || !['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)
      || ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip'].some((name) => req.headers[name] !== undefined)) {
      res.status(403).json({ error: '执行 MCP 仅接受本机非浏览器请求' });
      return;
    }
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.status(401).json({ error: '执行 MCP 令牌无效' });
      return;
    }
    next();
  });
  router.post('/', async (req, res) => {
    let server: McpServer | undefined;
    try {
      const service = options.service();
      server = new McpServer({ name: 'cloudcli-execution', version: '1.0.0' });
      for (const tool of service.tools) {
        server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema.shape }, async (input) => {
          try {
            const data = await service.call(tool.name, input);
            return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> };
          } catch (error) {
            return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '执行操作失败' }] };
          }
        });
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { void server?.close().catch((error: unknown) => console.error('[ExecutionMCP] 传输关闭失败', error)); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[ExecutionMCP] 请求处理失败', error);
      if (!res.headersSent) res.status(503).json({ error: '执行 MCP 不可用，请检查服务端配置和日志' });
      await server?.close();
    }
  });
  router.all('/', (_req, res) => res.status(405).end());
  return router;
}
