import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import scheduledJobsMcpRoutes from '@/modules/scheduled-jobs/scheduled-jobs-mcp.routes.js';
import { closeScheduledJobDispatcher } from '@/modules/scheduled-jobs/services/scheduled-job-dispatcher.service.js';
import { scheduledJobsSettingsService } from '@/modules/scheduled-jobs/services/scheduled-jobs-settings.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const SESSION_ID = 'mcp-route-session';

type ApiEnvelope = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: string | { message?: string };
};

async function withMcpRoute(
  runTest: (
    request: (method: string, url: string, body?: unknown, token?: string | null) => Promise<{ status: number; body: ApiEnvelope }>,
    userId: number,
  ) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-jobs-mcp-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const user = userDb.createUser('mcp', 'hash');
  const userId = Number(user.id);
  sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'MCP session');

  const app = express().use(express.json()).use('/api/scheduled-jobs-mcp', scheduledJobsMcpRoutes);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const request = async (method: string, url: string, body?: unknown, token?: string | null) => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (token !== null && token !== undefined) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`http://127.0.0.1:${address.port}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: ApiEnvelope;
      try {
        parsed = JSON.parse(text) as ApiEnvelope;
      } catch {
        parsed = { error: text.slice(0, 200) };
      }
      return { status: response.status, body: parsed };
    };
    await runTest(request, userId);
  } finally {
    closeScheduledJobDispatcher();
    chatRunRegistry.clearAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('the MCP route rejects a bad token and refuses calls while disabled', async () => {
  await withMcpRoute(async (request) => {
    const token = scheduledJobsSettingsService.getMcpToken();

    const unauthorized = await request('POST', '/api/scheduled-jobs-mcp/tools/list_scheduled_tasks', {}, 'wrong');
    assert.equal(unauthorized.status, 401);

    const disabled = await request('POST', '/api/scheduled-jobs-mcp/tools/list_scheduled_tasks', {}, token);
    assert.equal(disabled.status, 403);
  });
});

test('the MCP route runs tools for the enabling account once enabled', async () => {
  await withMcpRoute(async (request, userId) => {
    const addMock = mock.method(providerMcpService, 'addMcpServerToAllProviders', async () => []);
    const removeMock = mock.method(providerMcpService, 'removeMcpServerFromAllProviders', async () => []);
    try {
      await scheduledJobsSettingsService.updateSettings({ enabled: true, ownerUserId: userId });
      const token = scheduledJobsSettingsService.getMcpToken();
      chatRunRegistry.startRun({
        appSessionId: SESSION_ID,
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId,
      });

      const created = await request(
        'POST',
        '/api/scheduled-jobs-mcp/tools/create_scheduled_task',
        {
          prompt: 'run the checks',
          cron: '30 9 * * *',
          context: { provider: 'claude', timezone: 'Asia/Shanghai' },
        },
        token,
      );
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const task = created.body.data?.task as { sessionMode: string; sessionId: string };
      assert.equal(task.sessionMode, 'reuse');
      assert.equal(task.sessionId, SESSION_ID);

      const listed = await request('POST', '/api/scheduled-jobs-mcp/tools/list_scheduled_tasks', {
        context: { provider: 'claude', timezone: 'Asia/Shanghai' },
      }, token);
      assert.equal(listed.status, 200);
      assert.equal((listed.body.data?.tasks as unknown[]).length, 1);

      const unknown = await request('POST', '/api/scheduled-jobs-mcp/tools/nope', {}, token);
      assert.equal(unknown.status, 400);
    } finally {
      addMock.mock.restore();
      removeMock.mock.restore();
    }
  });
});
