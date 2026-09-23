import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { scheduledJobsService } from '@/modules/scheduled-jobs/services/scheduled-jobs.service.js';
import { runScheduledJobNow } from '@/modules/scheduled-jobs/services/scheduled-job-dispatcher.service.js';
import { scheduledJobsSettingsService } from '@/modules/scheduled-jobs/services/scheduled-jobs-settings.service.js';

/**
 * What the MCP bridge tells us about itself: which engine spawned it and the
 * machine's timezone. Sent with every tool call.
 *
 * The bridge's working directory is deliberately NOT part of this: engines
 * spawn MCP servers from different places (OpenCode's shared server runs from
 * the app root), so a workspace is only ever taken from the calling session or
 * an explicit argument.
 */
type AgentCallContext = {
  provider: string | null;
  timezone: string | null;
};

type AgentToolInput = Record<string, unknown> & {
  context?: {
    provider?: unknown;
    timezone?: unknown;
  };
};

function readOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readRequiredText(value: unknown, field: string): string {
  const text = readOptionalText(value);
  if (!text) {
    throw new Error(`${field} is required.`);
  }
  return text;
}

function readContext(input: AgentToolInput): AgentCallContext {
  return {
    provider: readOptionalText(input.context?.provider),
    timezone: readOptionalText(input.context?.timezone),
  };
}

/** A task name derived from the prompt, for when the agent did not supply one. */
function deriveName(prompt: string): string {
  const firstLine = prompt.split('\n')[0]?.trim() || prompt;
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
}

/** The conversation a tool call is running in, as far as it can be inferred. */
type CallerSession = {
  sessionId: string;
  provider: string;
  projectPath: string;
};

/**
 * Finds the session the current tool call is running in.
 *
 * An agent calls MCP tools mid-turn, so its own run is active. Matching the
 * bridge's engine (and workspace, when known) against the run registry yields
 * exactly one candidate in the normal case; anything ambiguous returns null
 * and the caller falls back to a fresh-session task instead of guessing.
 */
function resolveCallerSession(context: AgentCallContext, projectPath: string | null): CallerSession | null {
  const candidates: CallerSession[] = [];

  for (const run of chatRunRegistry.listRunningRuns()) {
    if (context.provider && run.provider !== context.provider) {
      continue;
    }
    const session = sessionsDb.getSessionById(run.sessionId);
    if (!session?.project_path) {
      continue;
    }
    if (projectPath && session.project_path !== projectPath) {
      continue;
    }
    candidates.push({
      sessionId: session.session_id,
      provider: session.provider,
      projectPath: session.project_path,
    });
  }

  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Executes the scheduled-tasks MCP tools.
 *
 * Consumed by the token-authenticated MCP HTTP route. Tool calls have no
 * session identity of their own, so they act as the account that enabled the
 * feature and infer the calling session from the run registry when possible.
 */
export const scheduledJobsAgentService = {
  async executeTool(toolName: string, input: AgentToolInput): Promise<unknown> {
    const settings = scheduledJobsSettingsService.getSettings();
    if (!settings.enabled) {
      throw new Error('Scheduled tasks are disabled in CloudCLI settings.');
    }
    if (settings.ownerUserId === null) {
      throw new Error('Scheduled tasks have no owner account; toggle the feature in settings again.');
    }

    const userId = settings.ownerUserId;
    const context = readContext(input);

    switch (toolName) {
      case 'create_scheduled_task':
        return this.createTask(userId, input, context);
      case 'list_scheduled_tasks':
        return this.listTasks(userId, input, context);
      case 'update_scheduled_task':
        return this.updateTask(userId, input);
      case 'delete_scheduled_task': {
        const id = readRequiredText(input.id, 'id');
        scheduledJobsService.remove(userId, id);
        return { deleted: true, id };
      }
      case 'run_scheduled_task_now': {
        const id = readRequiredText(input.id, 'id');
        const { runId } = await runScheduledJobNow(userId, id);
        return { id, runId, status: 'running' };
      }
      case 'get_scheduled_task_runs': {
        const id = readRequiredText(input.id, 'id');
        const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
          ? Math.min(Math.max(Math.trunc(input.limit), 1), 50)
          : undefined;
        return { runs: scheduledJobsService.listRuns(userId, id, limit) };
      }
      default:
        throw new Error(`Unknown scheduled-tasks tool "${toolName}".`);
    }
  },

  /**
   * Creates a task. Defaults to the calling session (`reuse`); pass
   * `sessionMode: 'new'` (or call outside a run) to get a fresh session per
   * occurrence in `projectPath`.
   *
   * `cron` makes it recurring; `runAt` makes it a one-off that disables itself
   * once it has fired. Exactly one of the two is required.
   */
  createTask(userId: number, input: AgentToolInput, context: AgentCallContext) {
    const prompt = readRequiredText(input.prompt, 'prompt');
    const cronExpression = readOptionalText(input.cron);
    const runAt = readOptionalText(input.runAt);
    if (cronExpression && runAt) {
      throw new Error('Provide either cron or runAt, not both.');
    }
    if (!cronExpression && !runAt) {
      throw new Error('Either cron or runAt is required.');
    }
    const name = readOptionalText(input.name) ?? deriveName(prompt);
    const timezone = readOptionalText(input.timezone) ?? context.timezone ?? 'UTC';
    // Agent-created tasks run unattended, so they cannot answer approval
    // prompts; bypass is the only mode that lets them finish on their own.
    const permissionMode = readOptionalText(input.permissionMode) ?? 'bypassPermissions';

    const explicitSessionId = readOptionalText(input.sessionId);
    const explicitProjectPath = readOptionalText(input.projectPath);
    const forceNewSession = readOptionalText(input.sessionMode) === 'new';

    let sessionId: string | null = null;
    let provider = readOptionalText(input.provider) ?? context.provider;
    let projectPath = explicitProjectPath;

    if (explicitSessionId) {
      sessionId = explicitSessionId;
    } else if (!forceNewSession) {
      const caller = resolveCallerSession(context, explicitProjectPath);
      if (caller) {
        sessionId = caller.sessionId;
        provider = caller.provider;
        projectPath = caller.projectPath;
      }
    }

    if (!sessionId) {
      if (!provider) {
        throw new Error('provider is required when a task runs in a new session.');
      }
      if (!projectPath) {
        throw new Error(
          'projectPath is required when a task runs in a new session; no active session was available to infer it from.',
        );
      }
    }

    const task = scheduledJobsService.create({
      userId,
      name,
      provider: provider ?? undefined,
      projectPath: projectPath ?? undefined,
      sessionId: sessionId ?? undefined,
      sessionMode: sessionId ? 'reuse' : 'new',
      prompt,
      options: { permissionMode },
      cronExpression: cronExpression ?? undefined,
      runAt: runAt ?? undefined,
      timezone,
    });

    return {
      task,
      note: runAt
        ? 'A one-off task: it fires once at the given time, then completes.'
        : sessionId
          ? 'Runs in the calling session; a conflicting occurrence is skipped, never interrupting a run in progress.'
          : 'Each run creates a new session in the workspace.',
    };
  },

  /** Lists tasks, scoped to the calling workspace when one can be inferred. */
  listTasks(userId: number, input: AgentToolInput, context: AgentCallContext) {
    const explicitProjectPath = readOptionalText(input.projectPath);
    const explicitSessionId = readOptionalText(input.sessionId);
    const filter: { projectPath?: string; sessionId?: string } = {};

    if (explicitSessionId) {
      filter.sessionId = explicitSessionId;
    } else if (explicitProjectPath) {
      filter.projectPath = explicitProjectPath;
    } else {
      const caller = resolveCallerSession(context, null);
      if (caller) {
        filter.projectPath = caller.projectPath;
      }
      // With no workspace to infer, every task is returned rather than an
      // empty list that would read as "nothing is scheduled".
    }

    return { tasks: scheduledJobsService.list(userId, filter) };
  },

  updateTask(userId: number, input: AgentToolInput) {
    const id = readRequiredText(input.id, 'id');
    const patch: {
      name?: unknown;
      prompt?: unknown;
      options?: unknown;
      cronExpression?: unknown;
      timezone?: unknown;
      runAt?: unknown;
      enabled?: unknown;
    } = {};

    if (input.name !== undefined) patch.name = input.name;
    if (input.prompt !== undefined) patch.prompt = input.prompt;
    if (input.cron !== undefined) patch.cronExpression = input.cron;
    if (input.runAt !== undefined) patch.runAt = input.runAt;
    if (input.timezone !== undefined) patch.timezone = input.timezone;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.permissionMode !== undefined) {
      const existing = scheduledJobsService.list(userId, {}).find((task) => task.id === id);
      if (!existing) {
        throw new Error(`Scheduled task "${id}" was not found.`);
      }
      patch.options = { ...existing.options, permissionMode: input.permissionMode };
    }

    return { task: scheduledJobsService.update(userId, id, patch) };
  },
};
