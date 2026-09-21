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

const apiUrl = (process.env.CLOUDCLI_SCHEDULED_JOBS_API_URL
  || 'http://127.0.0.1:3001/api/scheduled-jobs-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_SCHEDULED_JOBS_MCP_TOKEN || '';
// Which engine this copy of the bridge belongs to, so a task created without an
// explicit provider defaults to the engine that created it.
const providerId = process.env.CLOUDCLI_SCHEDULED_JOBS_PROVIDER || '';
const API_TIMEOUT_MS = Number.parseInt(process.env.CLOUDCLI_SCHEDULED_JOBS_API_TIMEOUT_MS || '30000', 10);

/** The machine's IANA zone, so "09:00" means the user's 09:00 by default. */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

async function callScheduledJobsApi(toolName: string, input: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_SCHEDULED_JOBS_MCP_TOKEN is not configured.');
  }

  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...input,
      context: {
        provider: providerId || undefined,
        timezone: localTimezone(),
      },
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  const data = await response.json() as {
    success?: boolean;
    data?: unknown;
    error?: string | { message?: string };
  };
  if (!response.ok || data.success === false) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(message || `Scheduled tasks API request failed (${response.status})`);
  }
  return data.data;
}

const cronDescription =
  "Five-field cron expression (minute hour day month weekday), e.g. '0 9 * * 1-5' for weekdays at 09:00.";

const tools: McpToolDefinition[] = [
  {
    name: 'create_scheduled_task',
    description:
      'Create a recurring task that sends a prompt on a cron schedule. By default it runs in the current '
      + "session; pass sessionMode='new' to give each run a fresh session in the workspace (projectPath is "
      + 'required then, unless a running session lets it be inferred). Runs never interrupt a session that is '
      + 'busy — a conflicting occurrence is skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short task name; derived from the prompt when omitted.' },
        prompt: { type: 'string', description: 'The prompt to send on every run.' },
        cron: { type: 'string', description: cronDescription },
        timezone: { type: 'string', description: 'IANA timezone; defaults to this machine\'s timezone.' },
        sessionId: { type: 'string', description: 'Run in this existing session (overrides inference).' },
        sessionMode: { type: 'string', enum: ['reuse', 'new'], description: "Use 'new' for a fresh session per run." },
        projectPath: { type: 'string', description: 'Workspace path for fresh-session tasks; defaults to the calling session\'s workspace.' },
        provider: { type: 'string', description: 'Engine for new sessions; defaults to the calling engine.' },
        permissionMode: { type: 'string', description: 'Permission mode for runs; defaults to bypassPermissions.' },
      },
      required: ['prompt', 'cron'],
    },
  },
  {
    name: 'list_scheduled_tasks',
    description:
      'List scheduled tasks with their schedule, next run, last status, and where each run goes. Scoped to '
      + 'the calling workspace when it can be inferred; pass projectPath to look at another workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Only tasks in this workspace.' },
        sessionId: { type: 'string', description: 'Only tasks bound to this session.' },
      },
    },
  },
  {
    name: 'update_scheduled_task',
    description:
      'Update a scheduled task: name, prompt, cron schedule, timezone, permission mode, or enabled state '
      + '(set enabled=false to pause it, true to resume).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id from list_scheduled_tasks.' },
        name: { type: 'string' },
        prompt: { type: 'string' },
        cron: { type: 'string', description: cronDescription },
        timezone: { type: 'string' },
        permissionMode: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_scheduled_task',
    description: 'Delete a scheduled task and its run history.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id from list_scheduled_tasks.' } },
      required: ['id'],
    },
  },
  {
    name: 'run_scheduled_task_now',
    description:
      'Start a task immediately without changing its schedule. Returns the run id; the run continues in '
      + 'the background, and its outcome appears in get_scheduled_task_runs.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id from list_scheduled_tasks.' } },
      required: ['id'],
    },
  },
  {
    name: 'get_scheduled_task_runs',
    description:
      'Show recent runs of a task: status (running/succeeded/failed/skipped/missed), error, session, and '
      + 'timestamps. Useful for checking whether a task has been succeeding.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id from list_scheduled_tasks.' },
        limit: { type: 'number', description: 'How many runs to return (1-50, default 50).' },
      },
      required: ['id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'create_scheduled_task':
      return mcpJson(await callScheduledJobsApi(name, {
        name: readMcpOptionalString(args.name),
        prompt: readMcpString(args.prompt, 'prompt'),
        cron: readMcpString(args.cron, 'cron'),
        timezone: readMcpOptionalString(args.timezone),
        sessionId: readMcpOptionalString(args.sessionId),
        sessionMode: readMcpOptionalString(args.sessionMode),
        projectPath: readMcpOptionalString(args.projectPath),
        provider: readMcpOptionalString(args.provider),
        permissionMode: readMcpOptionalString(args.permissionMode),
      }));
    case 'list_scheduled_tasks':
      return mcpJson(await callScheduledJobsApi(name, {
        projectPath: readMcpOptionalString(args.projectPath),
        sessionId: readMcpOptionalString(args.sessionId),
      }));
    case 'update_scheduled_task':
      return mcpJson(await callScheduledJobsApi(name, {
        id: readMcpString(args.id, 'id'),
        name: readMcpOptionalString(args.name),
        prompt: readMcpOptionalString(args.prompt),
        cron: readMcpOptionalString(args.cron),
        timezone: readMcpOptionalString(args.timezone),
        permissionMode: readMcpOptionalString(args.permissionMode),
        enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
      }));
    case 'delete_scheduled_task':
      return mcpJson(await callScheduledJobsApi(name, { id: readMcpString(args.id, 'id') }));
    case 'run_scheduled_task_now':
      return mcpJson(await callScheduledJobsApi(name, { id: readMcpString(args.id, 'id') }));
    case 'get_scheduled_task_runs':
      return mcpJson(await callScheduledJobsApi(name, {
        id: readMcpString(args.id, 'id'),
        limit: readMcpNumber(args.limit),
      }));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

serveMcpStdio({
  serverName: 'cloudcli-scheduled-tasks',
  tools,
  callTool,
});
