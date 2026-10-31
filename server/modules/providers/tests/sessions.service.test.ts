import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mkdir } from 'node:fs/promises';
import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { connectedClients } from '@/modules/websocket/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { BackgroundTaskSummary, LLMProvider } from '@/shared/types.js';

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function withProviders(
  runtimes: Partial<Record<LLMProvider, IProvider['runtime']>>,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const realListProviders = providerRegistry.listProviders;
  providerRegistry.listProviders = () =>
    Object.entries(runtimes).map(([id, runtime]) => ({ id, runtime }) as IProvider);
  try {
    await runTest();
  } finally {
    providerRegistry.listProviders = realListProviders;
    chatRunRegistry.clearAll();
  }
}

async function withClaudeCliRegistry(
  records: Array<Record<string, unknown>>,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-registry-'));
  await mkdir(path.join(homeDirectory, '.claude', 'sessions'), { recursive: true });
  for (const record of records) {
    await writeFile(
      path.join(homeDirectory, '.claude', 'sessions', `${record.pid}.json`),
      JSON.stringify(record),
      'utf8',
    );
  }

  const realHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDirectory;
  try {
    await runTest();
  } finally {
    (os as unknown as { homedir: () => string }).homedir = realHomedir;
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

test('provider session id returns the mapped native id', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-id', 'codex', '/tmp/session-id-copy-project');
    sessionsDb.assignProviderSessionId('app-session-id', 'codex-native-session-id');

    assert.equal(sessionsService.getProviderSessionId('app-session-id'), 'codex-native-session-id');
  });
});

test('app session names take the first sentence of the initial message', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession(
      'codex',
      '/tmp/session-name-project',
      '帮我看看登录重定向的问题。然后顺便把超时也调大一点',
    );

    assert.equal(result.sessionName, '帮我看看登录重定向的问题');
    assert.equal(
      sessionsDb.getSessionById(result.sessionId)?.custom_name,
      '帮我看看登录重定向的问题',
    );
  });
});

test('app session names fall back to the first line capped at 40 characters', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const longLine = '这个消息没有任何句读就是一长串文字'.repeat(4);
    const result = sessionsService.createAppSession('codex', '/tmp/session-name-project', longLine);

    assert.equal(result.sessionName, longLine.slice(0, 40));
  });
});

test('app session names cut at Latin exclamation or question marks but not periods', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const excited = sessionsService.createAppSession('claude', '/tmp/session-name-project', 'Fix this! Then also that');
    assert.equal(excited.sessionName, 'Fix this');

    // A Latin period is often a list marker or abbreviation ("1.", "e.g."),
    // so it never splits the name.
    const listed = sessionsService.createAppSession('claude', '/tmp/session-name-project', '1. 先做这个 2. 再做那个');
    assert.equal(listed.sessionName, '1. 先做这个 2. 再做那个');
  });
});

test('app session names skip leading terminators instead of giving up', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const exclaimed = sessionsService.createAppSession('claude', '/tmp/session-name-project', '？？？为什么这里会崩');
    assert.equal(exclaimed.sessionName, '为什么这里会崩');

    // A message that is only punctuation has nothing to name.
    const punctuated = sessionsService.createAppSession('claude', '/tmp/session-name-project', '？？？');
    assert.equal(punctuated.sessionName, 'Untitled Session');
  });
});

test('app sessions without message text receive a stable fallback name', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession('claude', '/tmp/attachment-only-project', '  \n ');

    assert.equal(result.sessionName, 'Untitled Session');
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.custom_name, 'Untitled Session');
  });
});

test('provider session id is unavailable until the provider assigns one', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('pending-app-session', 'claude', '/tmp/session-id-copy-project');

    assert.throws(
      () => sessionsService.getProviderSessionId('pending-app-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'PROVIDER_SESSION_ID_NOT_AVAILABLE' && typedError.statusCode === 409;
      },
    );
  });
});

test('provider session id reports a missing app session', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => sessionsService.getProviderSessionId('missing-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_NOT_FOUND' && typedError.statusCode === 404;
      },
    );
  });
});

test('recent sessions map project metadata and preserve database pagination', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'older-session',
      'claude',
      '/tmp/recent-project',
      'Older conversation',
      '2026-08-01T08:00:00.000Z',
      '2026-08-01T09:00:00.000Z',
    );
    sessionsDb.createSession(
      'newer-session',
      'codex',
      '/tmp/recent-project',
      'Newer conversation',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T11:00:00.000Z',
    );
    projectsDb.updateCustomProjectName('/tmp/recent-project', 'Recent Project');

    const project = projectsDb.getProjectPath('/tmp/recent-project');
    const page = sessionsService.listRecentSessions(1, 0);

    assert.deepEqual(page, {
      conversations: [{
        sessionId: 'newer-session',
        provider: 'codex',
        projectId: project?.project_id ?? null,
        projectDisplayName: 'Recent Project',
        sessionTitle: 'Newer conversation',
        lastActivity: '2026-08-01T11:00:00.000Z',
        isPinned: false,
      }],
      total: 2,
      hasMore: true,
    });
  });
});

/** One Claude transcript row of user or assistant text, linked by uuid chain. */
function claudeTextRow(
  sessionId: string,
  role: 'user' | 'assistant',
  text: string,
  ordinal: number,
): Record<string, unknown> {
  return {
    type: role,
    uuid: `row-${ordinal}`,
    parentUuid: ordinal === 0 ? null : `row-${ordinal - 1}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)).toISOString(),
    sessionId,
    message: { role, content: [{ type: 'text', text }] },
  };
}

test('history pages are sliced from the cached full transcript and see appended rows', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-history-'));
  const sessionId = 'claude-history-cache-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      const rows = [
        claudeTextRow(sessionId, 'user', 'one', 0),
        claudeTextRow(sessionId, 'assistant', 'reply one', 1),
        claudeTextRow(sessionId, 'user', 'two', 2),
        claudeTextRow(sessionId, 'assistant', 'reply two', 3),
      ];
      await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      sessionsDb.createSession(
        sessionId,
        'claude',
        '/tmp/history-cache-project',
        'History cache conversation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:10.000Z',
        transcriptPath,
      );

      const page = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(page.total, 4);
      assert.equal(page.hasMore, true);
      assert.deepEqual(page.messages.map((message) => message.content), ['two', 'reply two']);

      // A row appended after the page was cached must appear on the next read.
      await appendFile(
        transcriptPath,
        `${JSON.stringify(claudeTextRow(sessionId, 'user', 'three', 4))}\n`,
        'utf8',
      );
      const refreshed = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(refreshed.total, 5);
      assert.deepEqual(refreshed.messages.map((message) => message.content), ['reply two', 'three']);

      // An older page keeps the tail-offset contract while served from cache.
      const older = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 2 });
      assert.deepEqual(older.messages.map((message) => message.content), ['reply one', 'two']);
      assert.equal(older.hasMore, true);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

test('deleteOrArchiveSessionById deletes session when given provider_session_id', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-id-1', 'codex', '/tmp/delete-test');
    sessionsDb.assignProviderSessionId('app-id-1', 'native-id-1');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    const result = await sessionsService.deleteOrArchiveSessionById('native-id-1', {
      force: true,
      deletedFromDisk: false,
    });

    assert.equal(result.sessionId, 'app-id-1');
    assert.equal(result.action, 'deleted');
    assert.equal(sessionsDb.getSessionById('app-id-1'), null);
    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].kind, 'session_removed');
    assert.deepEqual(connection.frames[0].sessionIds, ['app-id-1']);
  });
});

test('deleteOrArchiveSessionById archives without force and broadcasts the removal', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-id-2', 'codex', '/tmp/archive-test');

    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    const result = await sessionsService.deleteOrArchiveSessionById('app-id-2', {});

    assert.equal(result.action, 'archived');
    assert.equal(sessionsDb.getSessionById('app-id-2')?.isArchived, 1);
    assert.equal(connection.frames.length, 1);
    assert.deepEqual(connection.frames[0].sessionIds, ['app-id-2']);
  });
});

test('a repeated create-session request with the same clientRequestId reuses the first session', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const first = sessionsService.createAppSession('codex', '/tmp/idempotent-project', 'hello there', {
      clientRequestId: 'client-request-1',
    });
    const second = sessionsService.createAppSession('codex', '/tmp/idempotent-project', 'hello there', {
      clientRequestId: 'client-request-1',
    });

    assert.equal(second.sessionId, first.sessionId);
    assert.equal(
      sessionsDb.getSessionsByProjectPathIncludingArchived('/tmp/idempotent-project').length,
      1,
    );
  });
});

test('create-session requests without a clientRequestId still allocate distinct sessions', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const first = sessionsService.createAppSession('codex', '/tmp/distinct-project', 'hello');
    const second = sessionsService.createAppSession('codex', '/tmp/distinct-project', 'hello');

    assert.notEqual(second.sessionId, first.sessionId);
  });
});

test('distinct clientRequestIds allocate distinct sessions', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const first = sessionsService.createAppSession('codex', '/tmp/two-requests-project', 'hello', {
      clientRequestId: 'client-request-a',
    });
    const second = sessionsService.createAppSession('codex', '/tmp/two-requests-project', 'hello', {
      clientRequestId: 'client-request-b',
    });

    assert.notEqual(second.sessionId, first.sessionId);
  });
});

const task = (taskId: string, startedAt: number): BackgroundTaskSummary => ({
  taskId,
  toolUseId: `toolu_${taskId}`,
  taskType: 'local_agent',
  description: `Task ${taskId}`,
  startedAt,
});

test('running sessions list a session whose background work outlived its turn', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('held-session', 'claude', '/tmp/running-project');
    // The turn ran and completed: the registry still holds the finished run.
    const run = chatRunRegistry.startRun({
      appSessionId: 'held-session', provider: 'claude', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);
    run.writer.send({ kind: 'text', content: 'launched', sessionId: 'held-session', provider: 'claude' });
    run.writer.sendComplete({ exitCode: 0 });
    assert.equal(run.status, 'completed');

    let tasks = [task('late', 2_000), task('early', 1_000)];
    await withClaudeCliRegistry([], async () => await withProviders(
      { claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'held-session', tasks }] } },
      async () => {
        for (const currentTasks of [tasks, []]) {
          tasks = currentTasks;
          assert.deepEqual(await sessionsService.listRunningSessions(), [{
            sessionId: 'held-session',
            provider: 'claude',
            startedAt: tasks.length ? 1_000 : run.startedAt,
            lastSeq: run.lastSeq,
            background: true,
            canInterrupt: false,
            tasks,
        }]);
        assert.ok(run.lastSeq > 0, 'the finished run still reports its sequence for replay');
        }
      },
    ));
  });
});

test('running sessions carry their tasks on a chat run that is still going', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('busy-session', 'claude', '/tmp/running-project');
    sessionsDb.createAppSession('idle-session', 'codex', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'busy-session', provider: 'claude', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    const tasks = [task('agent', 5_000)];
    await withClaudeCliRegistry([], async () => await withProviders(
      {
        claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'busy-session', tasks }] },
        // A runtime without background work contributes chat runs alone.
        codex: { run: async () => undefined, abort: () => false },
      },
      async () => {
        const sessions = await sessionsService.listRunningSessions();
        assert.equal(sessions.length, 1, 'a session with a running chat run is listed once');
        assert.deepEqual(sessions[0], {
          sessionId: 'busy-session',
          provider: 'claude',
          startedAt: run.startedAt,
          lastSeq: 0,
          tasks,
        });
      },
    ));
  });
});

test('background work whose runtime can still stop it offers the stop', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('report-session', 'opencode', '/tmp/running-project');
    await withClaudeCliRegistry([], async () => await withProviders(
      {
        opencode: {
          run: async () => undefined,
          abort: () => false,
          // The engine reports on finished background work in a turn of its own.
          listBackgroundWork: () => [{ sessionId: 'report-session', tasks: [] }],
          getSessionActivity: () => ({ queued: false, reporting: true }),
          backgroundTasks: { list: () => [], canInterrupt: () => true },
        },
      },
      async () => {
        const sessions = await sessionsService.listRunningSessions();
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].background, true);
        assert.equal(sessions[0].canInterrupt, true, 'abort can stop the report turn');
        assert.equal(sessions[0].reporting, true);
      },
    ));
  });
});

test('a running session says whether its round waits for the engine', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('queued-session', 'codex', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'queued-session', provider: 'codex', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    await withClaudeCliRegistry([], async () => await withProviders(
      {
        codex: {
          run: async () => undefined,
          abort: () => false,
          // The engine has the round but has not started its turn.
          getSessionActivity: () => ({ queued: true, reporting: false }),
        },
      },
      async () => {
        const sessions = await sessionsService.listRunningSessions();
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].queued, true);
        assert.equal(sessions[0].reporting, false);
      },
    ));
  });
});

test('running sessions with no background work are the chat runs alone', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('plain-session', 'codex', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'plain-session', provider: 'codex', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    await withClaudeCliRegistry([], async () => await withProviders(
      { codex: { run: async () => undefined, abort: () => false } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'plain-session', provider: 'codex', startedAt: run.startedAt, lastSeq: 0,
        }]);
      },
    ));
  });
});

test('running sessions report a turn driven by the Claude CLI', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('cli-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('cli-session', 'claude-native-1');

    // `process.pid` is the one pid guaranteed to be alive; omitting procStart
    // keeps the fixture portable, since the start-time cross-check is Linux-only.
    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-1', status: 'busy', entrypoint: 'cli', startedAt: 4_000 }],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          assert.deepEqual(await sessionsService.listRunningSessions(), [{
            sessionId: 'cli-session',
            provider: 'claude',
            startedAt: 4_000,
            lastSeq: 0,
            canInterrupt: false,
            statusText: 'Running in the Claude CLI',
          }]);
        },
      ),
    );
  });
});

test('running sessions ignore registry files a crash left behind', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('stale-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('stale-session', 'claude-native-stale');

    await withClaudeCliRegistry(
      [
        // The process is gone: signal 0 cannot find this pid.
        { pid: 4_194_302, sessionId: 'claude-native-stale', status: 'busy', startedAt: 1_000 },
        // Alive, but waiting for input rather than producing a response.
        { pid: process.pid, sessionId: 'claude-native-idle', status: 'idle', startedAt: 2_000 },
      ],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          assert.deepEqual(await sessionsService.listRunningSessions(), []);
        },
      ),
    );
  });
});

test('a CLI turn does not duplicate a session already running a chat run', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('both-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('both-session', 'claude-native-both');
    const run = chatRunRegistry.startRun({
      appSessionId: 'both-session', provider: 'claude', providerSessionId: 'claude-native-both', connection: null, userId: null,
    });
    assert.ok(run);

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-both', status: 'busy', startedAt: 3_000 }],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          const sessions = await sessionsService.listRunningSessions();
          assert.equal(sessions.length, 1, 'the chat run already covers this session');
          assert.equal(sessions[0].canInterrupt, undefined, 'the interruptible chat run entry wins');
        },
      ),
    );
  });
});

test('an unreadable registry never fails the running-sessions poll', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('safe-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('safe-session', 'claude-native-safe');

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-safe', status: 'busy', startedAt: 5_000 }],
      async () => {
        // A half-written file sits alongside the good one; it must be skipped
        // rather than abort the whole poll.
        await writeFile(path.join(os.homedir(), '.claude', 'sessions', 'broken.json'), '{"pid":', 'utf8');
        await withProviders(
          { claude: { run: async () => undefined, abort: () => false } },
          async () => {
            const sessions = await sessionsService.listRunningSessions();
            assert.deepEqual(sessions.map((session) => session.sessionId), ['safe-session']);
          },
        );
      },
    );
  });
});
