/**
 * Minimal MCP stdio server shared by CloudCLI's managed MCP bridges
 * (`cloudcli-browser`, `cloudcli-scheduled-tasks`).
 *
 * The bridges are plain JSON-RPC over newline-delimited stdio — NOT the LSP
 * `Content-Length` framing — and they all implement the same three methods
 * (`initialize`, `tools/list`, `tools/call`) before forwarding the actual work
 * to an HTTP endpoint on the CloudCLI server. Keeping the transport here means
 * a bridge file only declares its tools and their handler.
 *
 * Consumers: server/modules/browser-use/browser-use-mcp.ts and
 * server/modules/scheduled-jobs/scheduled-jobs-mcp.ts.
 */

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

/** One tool as `tools/list` reports it. */
export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** The `tools/call` result shape both bridges return. */
export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
};

/** A tool result carrying plain text. */
export function mcpText(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

/** A tool result carrying pretty-printed JSON, which is what agents parse. */
export function mcpJson(value: unknown): McpToolResult {
  return mcpText(JSON.stringify(value, null, 2));
}

/** Reads a required, non-empty string tool argument. */
export function readMcpString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

/** Reads an optional non-empty string tool argument. */
export function readMcpOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Reads an optional finite number tool argument. */
export function readMcpNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Serves one MCP bridge over stdio until the parent closes the pipe.
 *
 * `callTool` receives validated-by-contract arguments and either returns a
 * result or throws; a thrown error becomes a JSON-RPC error response so the
 * engine can show the message to the agent instead of hanging.
 */
export function serveMcpStdio(options: {
  serverName: string;
  serverVersion?: string;
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
}): void {
  const { serverName, serverVersion = '1.0.0', tools, callTool } = options;

  const handleMessage = async (message: JsonRpcRequest): Promise<unknown> => {
    if (message.method === 'initialize') {
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: serverVersion },
      };
    }

    if (message.method === 'tools/list') {
      return { tools };
    }

    if (message.method === 'tools/call') {
      const params = message.params || {};
      const name = readMcpString(params.name, 'name');
      const args = (params.arguments && typeof params.arguments === 'object'
        ? params.arguments
        : {}) as Record<string, unknown>;
      return callTool(name, args);
    }

    if (message.method.startsWith('notifications/')) {
      return undefined;
    }

    throw new Error(`Unsupported method: ${message.method}`);
  };

  const writeMessage = (message: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const sendResult = (id: string | number | null | undefined, result: unknown) => {
    if (id === undefined) {
      return;
    }
    writeMessage({ jsonrpc: '2.0', id, result });
  };

  const sendError = (id: string | number | null | undefined, error: unknown) => {
    if (id === undefined) {
      return;
    }
    writeMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  };

  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const rawMessage = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!rawMessage) {
        continue;
      }

      void (async () => {
        let request: JsonRpcRequest;
        try {
          request = JSON.parse(rawMessage) as JsonRpcRequest;
        } catch (error) {
          sendError(null, error);
          return;
        }
        try {
          const result = await handleMessage(request);
          sendResult(request.id, result);
        } catch (error) {
          sendError(request.id, error);
        }
      })();
    }
  });
}
