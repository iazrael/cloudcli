import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createExecutionRouter } from '../execution.routes.js';
import { createExecutionService } from '../execution.service.js';

test('MCP requires the dedicated token, rejects browser origins and supports SDK discovery and calls', async () => {
  let calls = 0;
  const token = 'test-token-with-at-least-32-characters';
  const service = {
    tools: [{ name: 'execution_capabilities', description: 'capabilities', schema: (await import('zod')).z.object({}).strict() }],
    async call() { calls++; return { version: 1, providers: [{ provider: 'zcode', models: ['test'] }] }; },
  } as unknown as ReturnType<typeof createExecutionService>;
  const app = express();
  app.use(express.json());
  app.use('/mcp/execution', createExecutionRouter({ token, service: () => service }));
  app.use('/disabled', createExecutionRouter({ token: undefined, service: () => { throw new Error('must not initialize'); } }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp/execution`);
  const client = new Client({ name: 'execution-test', version: '1' });
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(new URL('/disabled', url), { method: 'POST' })).status, 503);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    assert.equal((await client.listTools()).tools[0]?.name, 'execution_capabilities');
    const result = await client.callTool({ name: 'execution_capabilities', arguments: {} });
    assert.deepEqual(result.structuredContent, { version: 1, providers: [{ provider: 'zcode', models: ['test'] }] });
    assert.equal(calls, 1);
  } finally { await client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
