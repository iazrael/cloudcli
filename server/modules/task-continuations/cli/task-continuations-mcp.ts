import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppError, readObjectRecord } from '@/shared/utils.js';

const PROTOCOL_VERSION = '2025-03-26';
const TASK_API_URL_ENV = 'CLOUDCLI_TASK_API_URL';
const TASK_API_KEY_ENV = 'CLOUDCLI_TASK_API_KEY';
const TASK_RUN_CONTEXT_ENV = 'CLOUDCLI_TASK_RUN_CONTEXT';
const TASK_BRIDGE_ENV = 'CLOUDCLI_TASK_BRIDGE';
const MAX_LINE_BYTES = 64 * 1024;

type RpcMessage = {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
};

type McpRuntime = {
  stdin: Readable;
  stdout: Writable;
  env: NodeJS.ProcessEnv;
};

function response(id: string | number | null | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function readArguments(value: unknown): Record<string, unknown> {
  const argumentsRecord = readObjectRecord(value);
  if (!argumentsRecord) {
    throw new AppError('Tool arguments must be an object.', { code: 'INVALID_TOOL_ARGUMENTS', statusCode: 400 });
  }
  return argumentsRecord;
}

function readTaskId(value: unknown): string {
  if (typeof value !== 'string' || !/^task_[A-Za-z0-9_-]{1,180}$/.test(value)) {
    throw new AppError('taskId is invalid.', { code: 'INVALID_TASK_ID', statusCode: 400 });
  }
  return value;
}

function readTaskCapability(env: NodeJS.ProcessEnv): { apiUrl: string; token: string } {
  const apiUrl = env[TASK_API_URL_ENV]?.trim();
  const token = env[TASK_RUN_CONTEXT_ENV]?.trim();
  if (!apiUrl || !token) {
    throw new AppError('Task continuation tools are not available for this run.', {
      code: 'TASK_RUN_CONTEXT_UNAVAILABLE',
      statusCode: 401,
    });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    throw new AppError('Task continuation host URL is invalid.', { code: 'TASK_HOST_UNAVAILABLE', statusCode: 503 });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new AppError('Task continuation host URL is invalid.', { code: 'TASK_HOST_UNAVAILABLE', statusCode: 503 });
  }
  if (!token.startsWith('trc_')) {
    throw new AppError('Task continuation tools are not available for this run.', {
      code: 'TASK_RUN_CONTEXT_UNAVAILABLE',
      statusCode: 401,
    });
  }
  return { apiUrl: parsedUrl.toString().replace(/\/$/, ''), token };
}

/**
 * The engine's own identity for a tool call.
 *
 * The engine puts it into the request's metadata: `callId` names the call,
 * `threadId` the native thread, and the turn metadata carries the native turn.
 * It is the only thing that tells the host which round made the call, because
 * a resident process outlives the round that started it.
 */
type BridgeCallIdentity = {
  callId: string;
  threadId: string;
  turnId: string | null;
};

function readBridgeCallIdentity(params: Record<string, unknown>): BridgeCallIdentity | null {
  const meta = readObjectRecord(params._meta);
  if (!meta) {
    return null;
  }
  const callId = typeof meta.callId === 'string' ? meta.callId.trim() : '';
  const threadId = typeof meta.threadId === 'string' ? meta.threadId.trim() : '';
  const turnMetadata = readObjectRecord(meta['x-codex-turn-metadata']);
  const turnId = typeof turnMetadata?.turn_id === 'string' && turnMetadata.turn_id.trim()
    ? turnMetadata.turn_id.trim()
    : null;
  if (!callId || !threadId) {
    return null;
  }
  return { callId, threadId, turnId };
}

/**
 * The text a refused host request shows the model.
 *
 * The host's error middleware nests the code and message under `error`; the
 * code alone often does not say what to do next (a disabled switch and an
 * unannounced call are both refusals), so the host's own message goes along.
 */
function describeHostRefusal(status: number, body: unknown): string {
  const record = readObjectRecord(body);
  const error = readObjectRecord(record?.error);
  // A bare `{ code }` body still names the refusal.
  const rawCode = error?.code ?? record?.code;
  const code = typeof rawCode === 'string' && rawCode ? ` (${rawCode})` : '';
  const message = typeof error?.message === 'string' && error.message.trim()
    ? `: ${error.message.trim().slice(0, 300)}`
    : '.';
  return `Task host rejected the request with HTTP ${status}${code}${message}`;
}

/**
 * Calls the host's bridge entry with the engine's call identity.
 *
 * The bridge credential replaces the global API key here: a resident process
 * authenticates with its own narrow credential, and the host matches the call
 * against the engine call it observed.
 */
async function requestHostViaBridge(
  env: NodeJS.ProcessEnv,
  tool: string,
  toolArguments: Record<string, unknown>,
  requestId: string | undefined,
  identity: BridgeCallIdentity | null,
): Promise<Record<string, unknown>> {
  const apiUrl = env[TASK_API_URL_ENV]?.trim();
  const token = env[TASK_BRIDGE_ENV]?.trim();
  if (!apiUrl || !token) {
    throw new AppError('Task continuation tools are not available for this run.', {
      code: 'TASK_RUN_CONTEXT_UNAVAILABLE',
      statusCode: 401,
    });
  }
  if (!identity) {
    throw new AppError('The engine did not identify this call.', {
      code: 'TASK_BRIDGE_CALL_UNKNOWN',
      statusCode: 403,
    });
  }

  let result: unknown;
  try {
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/tasks/mcp/invoke`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tool, arguments: toolArguments, requestId, identity }),
      signal: AbortSignal.timeout(40_000),
    });
    result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new AppError(describeHostRefusal(response.status, result), {
        code: 'TASK_HOST_REQUEST_FAILED',
        statusCode: response.status,
      });
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Task host request failed.', { code: 'TASK_HOST_UNAVAILABLE', statusCode: 503 });
  }

  const envelope = readObjectRecord(result);
  const data = readObjectRecord(envelope?.data);
  if (envelope?.success !== true || !data) {
    throw new AppError('Task host returned an invalid response.', { code: 'INVALID_TASK_HOST_RESPONSE', statusCode: 502 });
  }
  return data;
}

async function requestHost(
  env: NodeJS.ProcessEnv,
  request: { method: string; path: string; body?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const { apiUrl, token } = readTaskCapability(env);
  const apiKey = env[TASK_API_KEY_ENV];
  let result: unknown;
  try {
    const response = await fetch(`${apiUrl}${request.path}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(request.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(request.path === '/api/tasks/mcp/register' ? 40_000 : 10_000),
    });
    result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new AppError(describeHostRefusal(response.status, result), {
        code: 'TASK_HOST_REQUEST_FAILED',
        statusCode: response.status,
      });
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('Task host request failed.', { code: 'TASK_HOST_UNAVAILABLE', statusCode: 503 });
  }

  const envelope = readObjectRecord(result);
  const data = readObjectRecord(envelope?.data);
  if (envelope?.success !== true || !data) {
    throw new AppError('Task host returned an invalid response.', { code: 'INVALID_TASK_HOST_RESPONSE', statusCode: 502 });
  }
  return data;
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

async function callTaskTool(
  name: string,
  rawArguments: unknown,
  env: NodeJS.ProcessEnv,
  requestId?: string,
  identity: BridgeCallIdentity | null = null,
): Promise<Record<string, unknown>> {
  const args = readArguments(rawArguments);
  if (env[TASK_BRIDGE_ENV]?.trim()) {
    // A resident process authenticates with the bridge credential, and the
    // host matches the call against the engine call it observed.
    const data = await requestHostViaBridge(env, name, args, requestId, identity);
    if (name === 'cloudcli_task_run') {
      const taskId = readTaskId(data.taskId);
      return textResult({
        taskId,
        title: typeof data.title === 'string' ? data.title : String(args.title ?? ''),
        status: ['uncertain', 'completed', 'failed', 'cancelled'].includes(String(data.status))
          ? data.status
          : 'accepted',
        duplicate: data.duplicate === true,
      });
    }
    return textResult(data);
  }
  if (name === 'cloudcli_task_run') {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const command = typeof args.command === 'string' ? args.command : '';
    const commandArgs = args.args === undefined ? [] : args.args;
    if (!title || title.length > 200 || !command.trim() || command.length > 4096 || command.includes('\0')
      || !Array.isArray(commandArgs) || commandArgs.length > 128
      || commandArgs.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
      || (args.notify !== undefined && typeof args.notify !== 'boolean')) {
      throw new AppError('Task title or command arguments are invalid.', {
        code: 'INVALID_TASK_ARGUMENTS',
        statusCode: 400,
      });
    }
    if (!requestId || requestId.length > 256) {
      throw new AppError('Task registration requires a JSON-RPC request id.', {
        code: 'TASK_REQUEST_ID_REQUIRED',
        statusCode: 400,
      });
    }
    const data = await requestHost(env, {
      method: 'POST',
      path: '/api/tasks/mcp/register',
      body: {
        title,
        command: [command, ...(commandArgs as string[])],
        autoNotify: args.notify === true,
        requestId,
      },
    });
    const taskId = readTaskId(data.taskId);
    return textResult({
      taskId,
      title: typeof data.title === 'string' ? data.title : title,
      status: ['uncertain', 'completed', 'failed', 'cancelled'].includes(String(data.status))
        ? data.status
        : 'accepted',
      duplicate: data.duplicate === true,
    });
  }

  if (name === 'cloudcli_task_status') {
    const taskId = readTaskId(args.taskId);
    const data = await requestHost(env, { method: 'GET', path: `/api/tasks/mcp/${encodeURIComponent(taskId)}` });
    return textResult(data);
  }

  if (name === 'cloudcli_task_cancel_notification') {
    const taskId = readTaskId(args.taskId);
    const reason = typeof args.reason === 'string' ? args.reason.slice(0, 500) : undefined;
    const data = await requestHost(env, {
      method: 'POST',
      path: `/api/tasks/mcp/${encodeURIComponent(taskId)}/cancel-notification`,
      body: reason === undefined ? {} : { reason },
    });
    return textResult(data);
  }

  throw new AppError(`Unknown task tool: ${name}`, { code: 'UNKNOWN_TASK_TOOL', statusCode: 404 });
}

function listTools(): Record<string, unknown> {
  return {
    tools: [
      {
        name: 'cloudcli_task_run',
        description: 'Run a command as a detached CloudCLI task in the current run sandbox.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            command: { type: 'string', minLength: 1, maxLength: 4096 },
            args: { type: 'array', items: { type: 'string', maxLength: 4096 }, maxItems: 128 },
            notify: { type: 'boolean', description: 'Automatically report the result in this chat.' },
          },
          required: ['title', 'command'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
      },
      {
        name: 'cloudcli_task_status',
        description: 'Read the status of a task created in this chat.',
        inputSchema: {
          type: 'object',
          properties: { taskId: { type: 'string', minLength: 6, maxLength: 185 } },
          required: ['taskId'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: 'cloudcli_task_cancel_notification',
        description: 'Cancel a pending result notification without stopping the task.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', minLength: 6, maxLength: 185 },
            reason: { type: 'string', maxLength: 500 },
          },
          required: ['taskId'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    ],
  };
}

async function handleMessage(message: RpcMessage, env: NodeJS.ProcessEnv): Promise<Record<string, unknown> | null> {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  if (message.jsonrpc !== '2.0' || !method) {
    return rpcError(id, -32600, 'Invalid JSON-RPC request.');
  }
  if (id === undefined && method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'initialize') {
    return response(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'cloudcli-task-continuations', version: '1.0.0' },
    });
  }
  if (method === 'ping') {
    return response(id, {});
  }
  if (method === 'tools/list') {
    return response(id, listTools());
  }
  if (method === 'tools/call') {
    const params = readObjectRecord(message.params);
    if (!params || typeof params.name !== 'string') {
      return response(id, { isError: true, content: [{ type: 'text', text: 'Invalid tool call.' }] });
    }
    try {
      const requestId = typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
      return response(id, await callTaskTool(
        params.name,
        params.arguments,
        env,
        requestId,
        readBridgeCallIdentity(params),
      ));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Task tool failed.';
      return response(id, { isError: true, content: [{ type: 'text', text: messageText }] });
    }
  }
  return rpcError(id, -32601, 'Method not found.');
}

/** Runs the stdio MCP endpoint used only by the active Codex app-server run. */
export async function runTaskContinuationsMcp(runtime: McpRuntime): Promise<void> {
  const lines = createInterface({ input: runtime.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      runtime.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Request is too large.'))}\n`);
      continue;
    }
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      runtime.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error.'))}\n`);
      continue;
    }
    const reply = await handleMessage(message, runtime.env);
    if (reply) {
      runtime.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runTaskContinuationsMcp({ stdin: process.stdin, stdout: process.stdout, env: process.env });
}
