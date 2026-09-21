import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import { scheduledJobsAgentService } from '@/modules/scheduled-jobs/services/scheduled-jobs-agent.service.js';
import {
  closeScheduledJobDispatcher,
  initializeScheduledJobDispatcher,
} from '@/modules/scheduled-jobs/services/scheduled-job-dispatcher.service.js';
import { scheduledJobsSettingsService } from '@/modules/scheduled-jobs/services/scheduled-jobs-settings.service.js';
import { scheduledJobsService } from '@/modules/scheduled-jobs/services/scheduled-jobs.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const SESSION_ID = 'agent-caller-session';
const SECOND_SESSION_ID = 'agent-other-session';
const TIMEZONE = 'Asia/Shanghai';

async function withIsolatedDatabase(
  runTest: (userId: number, projectPath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-jobs-agent-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('agent', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Calling session');
    sessionsDb.createAppSession(SECOND_SESSION_ID, 'claude', tempDirectory, 'Second session');
    await runTest(Number(user.id), tempDirectory);
  } finally {
    closeScheduledJobDispatcher();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Turns the feature on without touching real engine configs. */
async function enableScheduledTasks(userId: number): Promise<() => void> {
  const addMock = mock.method(providerMcpService, 'addMcpServerToAllProviders', async () => []);
  const removeMock = mock.method(providerMcpService, 'removeMcpServerFromAllProviders', async () => []);
  await scheduledJobsSettingsService.updateSettings({ enabled: true, ownerUserId: userId });
  return () => {
    addMock.mock.restore();
    removeMock.mock.restore();
  };
}

function startCallerRun(provider: string, sessionId: string, userId: number) {
  return chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: provider as never,
    providerSessionId: null,
    connection: null,
    userId,
  });
}

test('the feature starts disabled and refuses tool calls until enabled', async () => {
  await withIsolatedDatabase(async () => {
    assert.equal(scheduledJobsSettingsService.getSettings().enabled, false);
    await assert.rejects(
      () => scheduledJobsAgentService.executeTool('list_scheduled_tasks', {}),
      /disabled/i,
    );
  });
});

test('enabling registers the managed MCP with per-provider context; disabling removes it', async () => {
  await withIsolatedDatabase(async (userId) => {
    const addCalls: Array<{ name: string; envFor?: (provider: string) => Record<string, string> }> = [];
    const removeCalls: unknown[] = [];
    const addMock = mock.method(providerMcpService, 'addMcpServerToAllProviders', async (input: never) => {
      addCalls.push(input);
      return [];
    });
    const removeMock = mock.method(providerMcpService, 'removeMcpServerFromAllProviders', async (input: never) => {
      removeCalls.push(input);
      return [];
    });

    try {
      const disabledSync = await scheduledJobsSettingsService.syncAgentMcpIfNeeded();
      assert.deepEqual(disabledSync, { synced: false, reason: 'disabled' });

      const enabled = await scheduledJobsSettingsService.updateSettings({ enabled: true, ownerUserId: userId });
      assert.equal(enabled.enabled, true);
      assert.equal(enabled.ownerUserId, userId);
      assert.equal(addCalls.length, 1);
      assert.equal(addCalls[0].name, 'cloudcli-scheduled-tasks');
      assert.equal(
        addCalls[0].envFor?.('opencode').CLOUDCLI_SCHEDULED_JOBS_PROVIDER,
        'opencode',
      );

      const sync = await scheduledJobsSettingsService.syncAgentMcpIfNeeded();
      assert.equal(sync.synced, true);

      const status = await scheduledJobsSettingsService.getStatus();
      assert.equal(status.enabled, true);

      await scheduledJobsSettingsService.updateSettings({ enabled: false });
      assert.equal(scheduledJobsSettingsService.isEnabled(), false);
      assert.equal(removeCalls.length, 1);
    } finally {
      addMock.mock.restore();
      removeMock.mock.restore();
    }
  });
});

test('create_scheduled_task binds to the calling session when its run is active', async () => {
  await withIsolatedDatabase(async (userId, projectPath) => {
    const restoreMcp = await enableScheduledTasks(userId);
    try {
      startCallerRun('claude', SESSION_ID, userId);

      const result = await scheduledJobsAgentService.executeTool('create_scheduled_task', {
        prompt: 'run the nightly checks',
        cron: '30 9 * * *',
        context: { provider: 'claude', timezone: TIMEZONE },
      }) as { task: { sessionMode: string; sessionId: string | null; provider: string; projectPath: string; options: Record<string, unknown>; nextRunAt: string } };

      assert.equal(result.task.sessionMode, 'reuse');
      assert.equal(result.task.sessionId, SESSION_ID);
      assert.equal(result.task.provider, 'claude');
      assert.equal(result.task.projectPath, projectPath);
      assert.equal(result.task.options.permissionMode, 'bypassPermissions');
      assert.ok(new Date(result.task.nextRunAt).getTime() > Date.now());
    } finally {
      restoreMcp();
    }
  });
});

test('create_scheduled_task falls back to a fresh session per run without a caller', async () => {
  await withIsolatedDatabase(async (userId, projectPath) => {
    const restoreMcp = await enableScheduledTasks(userId);
    try {
      const result = await scheduledJobsAgentService.executeTool('create_scheduled_task', {
        prompt: 'audit the workspace',
        cron: '0 8 * * 1',
        projectPath,
        context: { provider: 'opencode', timezone: TIMEZONE },
      }) as { task: { sessionMode: string; sessionId: string | null; provider: string } };

      assert.equal(result.task.sessionMode, 'new');
      assert.equal(result.task.sessionId, null);
      assert.equal(result.task.provider, 'opencode');

      await assert.rejects(
        () => scheduledJobsAgentService.executeTool('create_scheduled_task', {
          prompt: 'no workspace',
          cron: '0 8 * * 1',
          context: { provider: 'opencode' },
        }),
        /projectPath is required/,
      );
    } finally {
      restoreMcp();
    }
  });
});

test('ambiguous active runs fall back to a fresh-session task', async () => {
  await withIsolatedDatabase(async (userId, projectPath) => {
    const restoreMcp = await enableScheduledTasks(userId);
    try {
      startCallerRun('claude', SESSION_ID, userId);
      startCallerRun('claude', SECOND_SESSION_ID, userId);

      const result = await scheduledJobsAgentService.executeTool('create_scheduled_task', {
        prompt: 'ambiguous caller',
        cron: '0 8 * * 1',
        projectPath,
        context: { provider: 'claude', timezone: TIMEZONE },
      }) as { task: { sessionMode: string } };

      assert.equal(result.task.sessionMode, 'new');
    } finally {
      restoreMcp();
    }
  });
});

test('list_scheduled_tasks scopes to the calling workspace', async () => {
  await withIsolatedDatabase(async (userId, projectPath) => {
    const restoreMcp = await enableScheduledTasks(userId);
    try {
      scheduledJobsService.create({
        userId,
        name: 'Here',
        sessionMode: 'new',
        sessionId: undefined,
        provider: 'claude',
        projectPath,
        prompt: 'here',
        cronExpression: '0 8 * * 1',
        timezone: TIMEZONE,
      });
      scheduledJobsService.create({
        userId,
        name: 'Elsewhere',
        sessionMode: 'new',
        sessionId: undefined,
        provider: 'claude',
        projectPath: path.join(projectPath, 'other'),
        prompt: 'elsewhere',
        cronExpression: '0 8 * * 1',
        timezone: TIMEZONE,
      });

      startCallerRun('claude', SESSION_ID, userId);
      const scoped = await scheduledJobsAgentService.executeTool('list_scheduled_tasks', {
        context: { provider: 'claude', timezone: TIMEZONE },
      }) as { tasks: Array<{ name: string }> };
      assert.deepEqual(scoped.tasks.map((task) => task.name), ['Here']);

      chatRunRegistry.clearAll();
      const all = await scheduledJobsAgentService.executeTool('list_scheduled_tasks', {
        context: { provider: 'claude', timezone: TIMEZONE },
      }) as { tasks: unknown[] };
      assert.equal(all.tasks.length, 2);
    } finally {
      restoreMcp();
    }
  });
});

test('update, run-now, history and delete work through the tools', async () => {
  await withIsolatedDatabase(async (userId) => {
    const restoreMcp = await enableScheduledTasks(userId);
    try {
      const created = await scheduledJobsAgentService.executeTool('create_scheduled_task', {
        prompt: 'check the deploy',
        cron: '0 9 * * *',
        context: { provider: 'claude', timezone: TIMEZONE },
        sessionId: SESSION_ID,
      }) as { task: { id: string } };
      const taskId = created.task.id;

      const updated = await scheduledJobsAgentService.executeTool('update_scheduled_task', {
        id: taskId,
        prompt: 'check the deploy twice',
        cron: '0 10 * * *',
        enabled: false,
      }) as { task: { prompt: string; cronExpression: string; enabled: boolean } };
      assert.equal(updated.task.prompt, 'check the deploy twice');
      assert.equal(updated.task.cronExpression, '0 10 * * *');
      assert.equal(updated.task.enabled, false);

      const runsBefore = await scheduledJobsAgentService.executeTool('get_scheduled_task_runs', {
        id: taskId,
      }) as { runs: unknown[] };
      assert.deepEqual(runsBefore.runs, []);

      initializeScheduledJobDispatcher({
        hasRuntime: () => true,
        run: async () => {},
        abort: async () => true,
      } as never);
      await scheduledJobsAgentService.executeTool('run_scheduled_task_now', { id: taskId });

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const runs = scheduledJobsService.listRuns(userId, taskId);
        if (runs[0] && runs[0].status !== 'running') {
          assert.equal(runs[0].status, 'succeeded');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const deleted = await scheduledJobsAgentService.executeTool('delete_scheduled_task', { id: taskId });
      assert.deepEqual(deleted, { deleted: true, id: taskId });
      await assert.rejects(
        () => scheduledJobsAgentService.executeTool('get_scheduled_task_runs', { id: taskId }),
        /not found/,
      );
    } finally {
      restoreMcp();
    }
  });
});
