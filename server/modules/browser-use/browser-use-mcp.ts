#!/usr/bin/env node
// The MCP executable must load the root environment bootstrap before reading configuration.
// eslint-disable-next-line boundaries/no-unknown
import '../../load-env.js';

import {
  mcpJson,
  readMcpNumber,
  readMcpOptionalString,
  readMcpString,
  serveMcpStdio,
  type McpToolDefinition,
} from '@/shared/mcp-stdio.js';

const apiUrl = (process.env.CLOUDCLI_BROWSER_USE_API_URL || 'http://127.0.0.1:3001/api/browser-use-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_BROWSER_USE_MCP_TOKEN || '';
const API_TIMEOUT_MS = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_API_TIMEOUT_MS || '60000', 10);

async function callBrowserUseApi(toolName: string, input: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_BROWSER_USE_MCP_TOKEN is not configured.');
  }

  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Browser API request failed (${response.status})`);
  }
  return data.data;
}

const sessionIdSchema = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: 'Browser session id.' },
  },
  required: ['sessionId'],
};

const tools: McpToolDefinition[] = [
  {
    name: 'browser_create_session',
    description: 'Create a temporary Browser session that the agent can control. Optionally provide a background profileName to reuse cookies and storage.',
    inputSchema: {
      type: 'object',
      properties: {
        profileName: { type: 'string', description: 'Optional background profile name for persistent browser storage.' },
      },
    },
  },
  {
    name: 'browser_list_sessions',
    description: 'List Browser sessions currently available to agents.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_snapshot',
    description: 'Capture current page metadata, screenshot data URL, and visible body text for a Browser session.',
    inputSchema: sessionIdSchema,
  },
  {
    name: 'browser_take_screenshot',
    description: 'Capture the latest screenshot for a Browser session.',
    inputSchema: sessionIdSchema,
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a Browser session to an HTTP or HTTPS URL.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['sessionId', 'url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector, visible text, or x/y coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into the focused page or fill a CSS selector. Set submit to press Enter after typing.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['sessionId', 'text'],
    },
  },
  {
    name: 'browser_fill_form',
    description: 'Fill multiple form fields using CSS selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['selector', 'value'],
          },
        },
      },
      required: ['sessionId', 'fields'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a keyboard key, for example Enter, Escape, Tab, or Control+A.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['sessionId', 'key'],
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select option values in a select element found by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        values: { type: 'array', items: { type: 'string' } },
      },
      required: ['sessionId', 'selector', 'values'],
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for visible text, a URL pattern, or a short timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string' },
        url: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_tabs',
    description: 'List, open, select, or close tabs in a Browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        index: { type: 'number' },
        url: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_close_session',
    description: 'Stop a Browser session controlled by agents.',
    inputSchema: sessionIdSchema,
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'browser_create_session':
      return mcpJson(await callBrowserUseApi(name, {
        profileName: readMcpOptionalString(args.profileName),
      }));
    case 'browser_list_sessions':
      return mcpJson(await callBrowserUseApi(name, {}));
    case 'browser_snapshot':
      return mcpJson(await callBrowserUseApi(name, { sessionId: readMcpString(args.sessionId, 'sessionId') }));
    case 'browser_take_screenshot': {
      return mcpJson(await callBrowserUseApi(name, { sessionId: readMcpString(args.sessionId, 'sessionId') }));
    }
    case 'browser_navigate':
      return mcpJson(await callBrowserUseApi(name, {
        sessionId: readMcpString(args.sessionId, 'sessionId'),
        url: readMcpString(args.url, 'url'),
      }));
    case 'browser_click':
      return mcpJson(await callBrowserUseApi(name, {
        sessionId: readMcpString(args.sessionId, 'sessionId'),
        selector: readMcpOptionalString(args.selector),
        text: readMcpOptionalString(args.text),
        x: readMcpNumber(args.x),
        y: readMcpNumber(args.y),
      }));
    case 'browser_type':
      return mcpJson(await callBrowserUseApi(name, {
        sessionId: readMcpString(args.sessionId, 'sessionId'),
        selector: readMcpOptionalString(args.selector),
        text: readMcpString(args.text, 'text'),
        submit: args.submit === true,
      }));
    case 'browser_fill_form': {
      const fields = Array.isArray(args.fields)
        ? args.fields.map((field) => {
          const record = field as Record<string, unknown>;
          return {
            selector: readMcpString(record.selector, 'field.selector'),
            value: readMcpString(record.value, 'field.value'),
          };
        })
        : [];
      return mcpJson(await callBrowserUseApi(name, {
        sessionId: readMcpString(args.sessionId, 'sessionId'),
        fields,
      }));
    }
    case 'browser_press_key':
      return mcpJson(await callBrowserUseApi(name, {
        sessionId: readMcpString(args.sessionId, 'sessionId'),
        key: readMcpString(args.key, 'key'),
      }));
    case 'browser_select_option':
      return mcpJson(await callBrowserUseApi(name, {
        sessionId: readMcpString(args.sessionId, 'sessionId'),
        selector: readMcpString(args.selector, 'selector'),
        values: Array.isArray(args.values) ? args.values.filter((value): value is string => typeof value === 'string') : [],
      }));
    case 'browser_wait_for':
      return mcpJson(await callBrowserUseApi(name, {
        sessionId: readMcpString(args.sessionId, 'sessionId'),
        text: readMcpOptionalString(args.text),
        url: readMcpOptionalString(args.url),
        timeoutMs: readMcpNumber(args.timeoutMs),
      }));
    case 'browser_tabs':
      return mcpJson(await callBrowserUseApi(name, {
        sessionId: readMcpString(args.sessionId, 'sessionId'),
        action: args.action === 'new' || args.action === 'select' || args.action === 'close' || args.action === 'list'
          ? args.action
          : undefined,
        index: readMcpNumber(args.index),
        url: readMcpOptionalString(args.url),
      }));
    case 'browser_close_session':
      return mcpJson(await callBrowserUseApi(name, { sessionId: readMcpString(args.sessionId, 'sessionId') }));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

serveMcpStdio({
  serverName: 'cloudcli-browser',
  tools,
  callTool,
});
