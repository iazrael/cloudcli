import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runTaskContinuationsMcp } from '@/modules/task-continuations/cli/task-continuations-mcp.js';

async function runProtocol(messages: unknown[], env: NodeJS.ProcessEnv = {}): Promise<unknown[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const output: string[] = [];
  stdout.on('data', (chunk) => output.push(String(chunk)));
  const done = runTaskContinuationsMcp({ stdin, stdout, env });
  for (const message of messages) {
    stdin.write(`${JSON.stringify(message)}\n`);
  }
  stdin.end();
  await done;
  return output.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('stdio MCP advertises run, status, and notification cancellation tools', async () => {
  const responses = await runProtocol([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);

  assert.equal(responses.length, 2);
  assert.deepEqual((responses[1] as any).result.tools.map((tool: any) => tool.name), [
    'cloudcli_task_run',
    'cloudcli_task_status',
    'cloudcli_task_cancel_notification',
  ]);
  assert.equal((responses[1] as any).result.tools[0].annotations?.readOnlyHint, false);
  assert.equal((responses[1] as any).result.tools[0].annotations?.openWorldHint, undefined);
  assert.equal((responses[1] as any).result.tools[0].annotations?.destructiveHint, undefined);
  assert.equal((responses[1] as any).result.tools[1].annotations?.readOnlyHint, true);
});

test('a resident process calls the bridge with the engine own call identity', async () => {
  const received: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      received.push({
        url: request.url ?? '',
        headers: request.headers as Record<string, string>,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: { taskId: 'task_1', status: 'completed' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const responses = await runProtocol([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'cloudcli_task_status',
          arguments: { taskId: 'task_1' },
          _meta: {
            callId: 'call-7',
            threadId: 'native-thread-1',
            sessionId: 'native-session-1',
            'x-codex-turn-metadata': { thread_id: 'native-thread-1', turn_id: 'native-turn-1' },
          },
        },
      },
    ], {
      CLOUDCLI_TASK_API_URL: `http://127.0.0.1:${port}`,
      CLOUDCLI_TASK_BRIDGE: 'tbc_bridge-token',
    });

    assert.equal((responses[0] as any).result.isError, undefined);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/api/tasks/mcp/invoke');
    assert.equal(received[0].headers.authorization, 'Bearer tbc_bridge-token');
    // The global API key never reaches a resident process.
    assert.equal(received[0].headers['x-api-key'], undefined);
    assert.deepEqual(received[0].body.identity, {
      callId: 'call-7',
      threadId: 'native-thread-1',
      turnId: 'native-turn-1',
    });
    assert.equal(received[0].body.tool, 'cloudcli_task_status');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a refused bridge call reports the host error code and message', async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        success: false,
        error: { code: 'TASK_CONTINUATIONS_DISABLED', message: 'Asynchronous task registration is disabled.' },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const responses = await runProtocol([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'cloudcli_task_status',
          arguments: { taskId: 'task_1' },
          _meta: {
            callId: 'call-8',
            threadId: 'native-thread-1',
            'x-codex-turn-metadata': { turn_id: 'native-turn-1' },
          },
        },
      },
    ], {
      CLOUDCLI_TASK_API_URL: `http://127.0.0.1:${port}`,
      CLOUDCLI_TASK_BRIDGE: 'tbc_bridge-token',
    });

    assert.equal((responses[0] as any).result.isError, true);
    assert.equal(
      (responses[0] as any).result.content[0].text,
      'Task host rejected the request with HTTP 409 (TASK_CONTINUATIONS_DISABLED): Asynchronous task registration is disabled.',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('tool calls fail closed when the host capability environment is absent', async () => {
  const responses = await runProtocol([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cloudcli_task_status', arguments: { taskId: 'task_1' } } },
  ]);

  assert.equal((responses[0] as any).result.isError, true);
  assert.match((responses[0] as any).result.content[0].text, /not available/i);
});
