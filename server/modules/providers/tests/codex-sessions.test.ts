import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { AppError } from '@/shared/utils.js';
import { codexBackgroundWork } from '@/modules/providers/list/codex/codex-background-work.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { readCodexProposedPlan } from '@/modules/providers/list/codex/codex-thread-items.js';
import { liftMemoryCitations } from '@/modules/providers/shared/memory-citations.js';

import { createWorkspaceFixture } from './workspace-fixture.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes one Codex rollout transcript. `firstUserMessage` mirrors the
 * `event_msg`/`user_message` payload the runtime records for the prompt the
 * user typed; omitting it produces a transcript with no user turn.
 */
const writeCodexTranscript = async (
  homeDir: string,
  codexSessionId: string,
  workspacePath: string,
  firstUserMessage?: string,
): Promise<string> => {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '07');
  await mkdir(sessionsDir, { recursive: true });

  const lines: string[] = [
    JSON.stringify({ type: 'session_meta', payload: { id: codexSessionId, cwd: workspacePath } }),
  ];
  if (firstUserMessage !== undefined) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: firstUserMessage } }));
  }

  const filePath = path.join(sessionsDir, `rollout-${codexSessionId}.jsonl`);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

test('Codex synchronizer preserves the title assigned when CloudCLI creates a session', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-app-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeCodexTranscript(tempRoot, 'codex-app-1', workspacePath, 'Provider transcript title must not win');
    await withIsolatedDatabase(async () => {
      // The app allocates its own id and later maps the provider id onto it,
      // exactly as a message sent from cloudcli does.
      sessionsDb.createAppSession('app-1', 'codex', workspacePath, 'Fix the login redirect');
      sessionsDb.assignProviderSessionId('app-1', 'codex-app-1');

      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Fix the login redirect');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer skips sub-agent rollout files', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-subagent-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Codex >=0.144 spawn_agent threads write their own rollout files into the
    // same sessions tree, marked via thread_source/source in session_meta.
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, 'rollout-codex-subagent-1.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'codex-subagent-1',
          cwd: workspacePath,
          thread_source: 'subagent',
          parent_thread_id: 'codex-parent-1',
          source: { subagent: { thread_spawn: { parent_thread_id: 'codex-parent-1', depth: 1 } } },
        },
      })}\n`,
      'utf8'
    );
    await writeCodexTranscript(tempRoot, 'codex-parent-1', workspacePath);

    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      const processed = await synchronizer.synchronize();

      assert.equal(processed, 1);
      assert.ok(sessionsDb.getSessionById('codex-parent-1'));
      assert.equal(sessionsDb.getSessionById('codex-subagent-1'), null);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer leaves indexed sessions untitled when no name is available', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-indexed-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // A CLI-created session has no app row; its first user message must NOT be
    // used as the title, preserving the existing indexing behavior.
    await writeCodexTranscript(tempRoot, 'codex-indexed-1', workspacePath, 'This prompt should be ignored');
    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('codex-indexed-1')?.custom_name, 'Untitled Codex Session');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer follows the engine rename recorded last in session_index.jsonl', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-rename-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeCodexTranscript(tempRoot, 'codex-rename-1', workspacePath);
    // Codex appends one record when the thread is created and another when its
    // AI title lands seconds later; the last record is the current name.
    const codexHome = path.join(tempRoot, '.codex');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(codexHome, 'session_index.jsonl'),
      [
        JSON.stringify({ id: 'codex-rename-1', thread_name: 'hello', updated_at: '2026-07-07T10:00:00Z' }),
        JSON.stringify({ id: 'codex-rename-1', thread_name: '真正的智能标题', updated_at: '2026-07-07T10:00:04Z' }),
      ].join('\n') + '\n',
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('codex-rename-1')?.custom_name, '真正的智能标题');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer replaces an earlier synced name with the engine thread name', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-follow-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeCodexTranscript(tempRoot, 'codex-follow-1', workspacePath);
    const codexHome = path.join(tempRoot, '.codex');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: 'codex-follow-1', thread_name: 'Codex generated name', updated_at: '2026-07-07T10:00:00Z' }) + '\n',
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      // A name an earlier pass derived (fallback upgrade path) must not stick
      // once the engine has generated its own.
      sessionsDb.createSession('codex-follow-1', 'codex', workspacePath, 'Earlier synced name');

      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('codex-follow-1')?.custom_name, 'Codex generated name');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer keeps a user-locked name over the engine thread name', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-locked-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeCodexTranscript(tempRoot, 'codex-locked-1', workspacePath);
    const codexHome = path.join(tempRoot, '.codex');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: 'codex-locked-1', thread_name: 'Codex generated name', updated_at: '2026-07-07T10:00:00Z' }) + '\n',
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession('codex-locked-1', 'codex', workspacePath, 'My rename');
      sessionsDb.updateSessionCustomName('codex-locked-1', 'My rename', { lockName: true });

      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('codex-locked-1')?.custom_name, 'My rename');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history reads 0.153-era prompts from item_completed UserMessage rows', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-user-153-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-user-153-1';
    // Mirrors a real 0.153.4 rollout: injected context rides an unnamed
    // `response_item` user message, the typed prompt arrives as an
    // `event_msg`/`item_completed` whose item is a `UserMessage`.
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions>AGENTS.md body</user_instructions>' }] },
      }),
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'UserMessage', id: 'item-u1', content: [{ type: 'text', text: 'first prompt' }] } },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'AgentMessage', id: 'msg-a1', content: [{ type: 'Text', text: 'first answer' }] } },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } }),
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-2' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'item_completed', turn_id: 'turn-2', item: { type: 'UserMessage', id: 'item-u2', content: [{ type: 'text', text: 'second prompt' }] } },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'item_completed', turn_id: 'turn-2', item: { type: 'AgentMessage', id: 'msg-a2', content: [{ type: 'Text', text: 'second answer' }] } },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } }),
    ];
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, `rollout-${providerSessionId}.jsonl`);
    await writeFile(transcriptPath, `${lines.join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-user-153-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-user-153-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-user-153-1');
      const userRows = history.messages.filter((message) => message.kind === 'text' && message.role === 'user');
      const assistantRows = history.messages.filter((message) => message.kind === 'text' && message.role === 'assistant');

      assert.equal(userRows.length, 2);
      assert.equal(userRows[0]?.content, 'first prompt');
      assert.equal(userRows[1]?.content, 'second prompt');
      // The typed prompt anchors its turn so edit/fork stay addressable.
      assert.equal(userRows[0]?.transcriptAnchorId, 'turn-1');
      assert.equal(userRows[1]?.transcriptAnchorId, 'turn-2');
      // Injected context must not surface as a user row.
      assert.ok(!userRows.some((message) => String(message.content).includes('AGENTS.md')));
      assert.equal(assistantRows.length, 2);
      assert.equal(assistantRows[0]?.content, 'first answer');
      assert.equal(assistantRows[1]?.content, 'second answer');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('getTokenUsage reads the latest token_count snapshot from the indexed rollout', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-token-usage-'));
  const sessionFilePath = path.join(tempDirectory, 'rollout-provider-session.jsonl');

  try {
    await writeFile(sessionFilePath, [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            model_context_window: 100_000,
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49 },
            model_context_window: 250_000,
          },
        },
      }),
    ].join('\n'));

    const provider = new CodexSessionsProvider();
    assert.deepEqual(
      await provider.getTokenUsage({
        appSessionId: 'app-session',
        nativeSessionId: 'provider-session',
        jsonlPath: sessionFilePath,
        projectPath: null,
      }),
      { used: 49, total: 250_000, inputTokens: 40, outputTokens: 9, breakdown: { input: 40, output: 9 } },
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('getTokenUsage 404s when no rollout file can be located', async () => {
  const restoreHomeDir = patchHomeDir(await mkdtemp(path.join(os.tmpdir(), 'codex-token-usage-empty-')));
  try {
    const provider = new CodexSessionsProvider();
    await assert.rejects(
      () => provider.getTokenUsage({
        appSessionId: 'app-session',
        nativeSessionId: 'provider-session',
        jsonlPath: null,
        projectPath: null,
      }),
      (error: unknown) => (
        error instanceof AppError
        && error.code === 'CODEX_SESSION_FILE_NOT_FOUND'
        && error.statusCode === 404
      ),
    );
  } finally {
    restoreHomeDir();
  }
});

test('Codex history renders one file row per patched file, from the applied diff', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-patch-history-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-patch-1';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);
    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      // Codex applies the patch and reports the result as one assembled item,
      // keyed by path. The raw `custom_tool_call` beside it is not read.
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'FileChange',
            id: 'exec-patch-1',
            status: 'completed',
            changes: {
              '/repo/b.ts': { type: 'update', unified_diff: '@@\n-const b = 1;\n+const b = 22;\n' },
              '/repo/a.ts': { type: 'update', unified_diff: '@@\n-const a = 1;\n+const a = 22;\n' },
            },
          },
        },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-patch-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-patch-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-patch-1');
      const edits = history.messages.filter((message) => message.kind === 'tool_use');

      assert.equal(edits.length, 2, 'the patch must not be rendered twice');
      // Both rows are named after the item, so a second read produces the
      // same two ids and the live copies they replace.
      assert.deepEqual(edits.map((edit) => edit.id).sort(), ['exec-patch-1_0', 'exec-patch-1_1']);
      const byPath = new Map(edits.map((edit) => {
        const input = JSON.parse(String(edit.toolInput)) as { file_path: string; new_string: string };
        return [input.file_path, { edit, input }];
      }));

      assert.equal(byPath.get('/repo/a.ts')?.edit.toolName, 'Edit');
      assert.equal(byPath.get('/repo/a.ts')?.input.new_string, 'const a = 22;');
      assert.equal(byPath.get('/repo/b.ts')?.input.new_string, 'const b = 22;');
      for (const edit of edits) {
        assert.equal(edit.toolResult?.isError, false, 'a successful patch must resolve its row');
      }
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history attaches a spawned agent\'s own transcript to the Agent row', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-history-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-parent-2';
    const agentThreadId = 'codex-agent-thread-2';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);

    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      // A spawn reaches the item stream only as this lifecycle event, so the
      // Agent row is built from it and keeps its id.
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'SubAgentActivity',
            id: 'spawn-1',
            kind: 'started',
            agent_thread_id: agentThreadId,
            agent_path: '/root/test_agent_1',
          },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root/test_agent_1',
          content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nSender: /root/test_agent_1\nPayload:\nAll done.' }],
        },
      }),
    ].join('\n')}\n`, 'utf8');

    // Codex writes a spawned agent's rollout next to its parent's, named after
    // the agent thread id.
    await writeFile(
      path.join(path.dirname(transcriptPath), `rollout-2026-07-07T00-00-00-${agentThreadId}.jsonl`),
      `${[
        JSON.stringify({
          type: 'session_meta',
          payload: { id: agentThreadId, cwd: workspacePath, thread_source: 'subagent', agent_nickname: 'Hegel' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'CommandExecution',
              id: 'exec-agent-call-1',
              command: ['/bin/zsh', '-lc', 'ls'],
              status: 'completed',
              aggregated_output: 'README.md\n',
              exit_code: 0,
            },
          },
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-parent-2', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-parent-2', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-parent-2');
      const task = history.messages.find((message) => message.kind === 'tool_use' && message.toolName === 'Agent');

      assert.ok(task, 'a spawned agent must produce a Agent row');
      assert.equal(task.subagent?.id, agentThreadId);
      assert.equal(task.subagent?.name, 'Hegel');
      assert.equal(task.subagent?.status, 'completed');
      assert.equal(task.toolResult?.content, 'All done.');

      // The agent's own shell call is translated exactly like the parent's.
      assert.equal(task.subagentTools?.length, 1);
      assert.equal(task.subagentTools?.[0].kind, 'tool');
      assert.equal(task.subagentTools?.[0].toolName, 'Bash');
      assert.equal(task.subagentTools?.[0].toolResult?.content, 'README.md\n');
      assert.equal(task.id, 'spawn-1', 'the Agent row is named after the lifecycle item');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history closes a still-running subagent when its turn was aborted', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-aborted-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-parent-3';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);

    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'SubAgentActivity',
            id: 'spawn-3',
            kind: 'started',
            agent_thread_id: 'codex-agent-thread-3',
            agent_path: '/root/product_review',
          },
        },
      }),
      // A usage-limit abort ends the whole agent tree: no FINAL_ANSWER and no
      // completing lifecycle event ever arrive for the spawned agent.
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'turn-3', reason: 'interrupted' },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-parent-3', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-parent-3', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-parent-3');
      const task = history.messages.find((message) => message.kind === 'tool_use' && message.toolName === 'Agent');

      assert.ok(task, 'the spawned agent must produce a Agent row');
      assert.equal(task.subagent?.status, 'stopped', 'an aborted turn ends the agent without a result, as the live stream settles it');
      assert.ok(task.toolResult, 'the Agent card needs a result row to settle its spinner');
      assert.equal(task.toolResult?.isError, true, 'an agent the abort cut off did not finish its work');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * A turn the engine refused to run.
 *
 * The rollout records the cause on the record that closes the turn and
 * nowhere else: no item carries it, so a reader that only walks the item
 * stream keeps the prompt and loses the reason. The live stream showed the
 * failure, and the transcript has to show it too — under the id the live row
 * carries, so the persisted copy replaces it instead of doubling it.
 */
test('Codex history keeps the reason a turn failed', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-failed-turn-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-failed-turn-1';
    const turnId = '01a0c4d2-a3fe-7330-bb87-5a99871777d0';
    const failure = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro).';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);

    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
      JSON.stringify({ type: 'turn_context', payload: { turn_id: turnId } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: turnId,
          item: { type: 'UserMessage', id: 'item-u1', content: [{ type: 'text', text: 'say hi' }] },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turnId, error: { message: failure } },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-failed-turn-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-failed-turn-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-failed-turn-1');
      const errorRows = history.messages.filter((message) => message.kind === 'error');

      assert.equal(errorRows.length, 1, 'the failure is one row of the transcript');
      assert.equal(errorRows[0]?.content, failure, 'the engine\'s own words are the row');
      assert.equal(
        errorRows[0]?.id,
        `${turnId}_error`,
        'the row is named after the turn, so the live row of the same turn is replaced by this one',
      );
      assert.ok(
        history.messages.some((message) => message.kind === 'text' && message.role === 'user'),
        'the prompt the failed turn answered stays in the transcript',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * One failure is one row.
 *
 * The engine closes a turn once, but a rollout can hold the same failure
 * twice (a turn recorded again by a resumed process). Two rows with the same
 * id would be two cards for one failure.
 */
test('Codex history writes one row for a failure recorded twice', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-failed-twice-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-failed-turn-3';
    const turnId = '01a0c4d2-a3fe-7330-bb87-5a99871777d1';
    const failure = 'You’ve hit your usage limit.';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);

    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turnId, error: { message: failure } },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turnId, error: { message: failure } },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-failed-turn-3', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-failed-turn-3', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-failed-turn-3');
      const errorRows = history.messages.filter((message) => message.kind === 'error');

      assert.equal(errorRows.length, 1, 'one failure is one row');
      assert.equal(errorRows[0]?.id, `${turnId}_error`);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * A failure the engine recorded without naming the turn.
 *
 * The reason is the point of the row; the turn id only makes it joinable with
 * the live copy. A record without one must still show the reason — a
 * transcript that keeps the prompt and drops the reason is the very failure
 * this row exists to prevent.
 */
test('Codex history keeps a failure that names no turn', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-failed-turn-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-failed-turn-2';
    const failure = 'Selected model is at capacity. Please try a different model.';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);

    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', id: 'item-u2', content: [{ type: 'text', text: 'say hi' }] },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', error: { message: failure } },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-failed-turn-2', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-failed-turn-2', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-failed-turn-2');
      const errorRows = history.messages.filter((message) => message.kind === 'error');

      assert.equal(errorRows.length, 1, 'the reason survives even without a turn to name it');
      assert.equal(errorRows[0]?.content, failure);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/** Writes a rollout whose only agent has a start record and no end record. */
async function writeUnfinishedAgentRollout(tempRoot: string, workspacePath: string, providerSessionId: string): Promise<void> {
  const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);
  await writeFile(transcriptPath, `${[
    JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'SubAgentActivity', id: 'spawn-open', kind: 'started', agent_thread_id: 'codex-agent-open', agent_path: '/root/open_agent' },
      },
    }),
  ].join('\n')}\n`, 'utf8');
}

test('Codex history reads an agent with no end record as stopped when no run tracks it', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-open-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeUnfinishedAgentRollout(tempRoot, workspacePath, 'codex-parent-open');
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-parent-open', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-parent-open', 'codex-parent-open');
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-parent-open');
      const task = history.messages.find((message) => message.kind === 'tool_use' && message.toolName === 'Agent');
      assert.equal(task?.subagent?.status, 'stopped', 'the app-server that ran it is gone, so it can never report');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history reads an agent with no end record as running while the runtime tracks it', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-live-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeUnfinishedAgentRollout(tempRoot, workspacePath, 'codex-parent-live');
    codexBackgroundWork.start('app-parent-live', {
      taskId: 'codex-agent-open', toolUseId: 'spawn-open', taskType: 'collab_agent', description: 'Open agent',
    });
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-parent-live', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-parent-live', 'codex-parent-live');
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-parent-live');
      const task = history.messages.find((message) => message.kind === 'tool_use' && message.toolName === 'Agent');
      assert.equal(task?.subagent?.status, 'running');
    });
  } finally {
    codexBackgroundWork.clearSession('app-parent-live');
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// The parent writes no end record when its own turn fails first; the agent's
// own rollout still says how its last turn ended, and the live card settles
// from that same turn.
for (const [lastTurn, expected] of [
  [{ type: 'task_complete', error: { message: 'You’ve hit your usage limit.', codex_error_info: 'usage_limit_exceeded' } }, 'failed'],
  [{ type: 'task_complete', last_agent_message: 'done' }, 'completed'],
  [{ type: 'turn_aborted', reason: 'interrupted' }, 'stopped'],
] as const) {
  test(`Codex history reads an untracked agent with no end record from its own last turn (${expected})`, { concurrency: false }, async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-last-turn-'));
    const workspacePath = await createWorkspaceFixture();
    const restoreHomeDir = patchHomeDir(tempRoot);

    try {
      await writeUnfinishedAgentRollout(tempRoot, workspacePath, 'codex-parent-last-turn');
      // Beside the parent rollout, where `writeCodexTranscript` puts it.
      const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
      await writeFile(path.join(sessionsDir, 'rollout-2026-07-07T00-00-00-codex-agent-open.jsonl'), `${[
        JSON.stringify({ type: 'session_meta', payload: { id: 'codex-agent-open', agent_nickname: 'Open' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'agent-turn-1' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'agent-turn-1', last_agent_message: 'first' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'agent-turn-2' } }),
        JSON.stringify({ type: 'event_msg', payload: { ...lastTurn, turn_id: 'agent-turn-2' } }),
      ].join('\n')}\n`, 'utf8');
      await withIsolatedDatabase(async () => {
        sessionsDb.createAppSession('app-parent-last-turn', 'codex', workspacePath);
        sessionsDb.assignProviderSessionId('app-parent-last-turn', 'codex-parent-last-turn');
        await new CodexSessionSynchronizer().synchronize();

        const history = await new CodexSessionsProvider().fetchHistory('app-parent-last-turn');
        const task = history.messages.find((message) => message.kind === 'tool_use' && message.toolName === 'Agent');
        assert.equal(task?.subagent?.status, expected);
      });
    } finally {
      restoreHomeDir();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
}

test('Codex memory citations are lifted out of the reply they trail', () => {
  const reply = [
    'Here is the answer.',
    '',
    '<oai-mem-citation>',
    '<citation_entries>',
    'MEMORY.md:137-142|note=[used verified container provisioning details]',
    'notes/deploy.md:4-9',
    '</citation_entries>',
    '<rollout_ids>',
    '019eda6d-c2f7-70c1-8b42-bf03c44a1f35',
    '</rollout_ids>',
    '</oai-mem-citation>',
  ].join('\n');

  const { text, memoryCitations } = liftMemoryCitations('codex', reply);

  assert.equal(text, 'Here is the answer.');
  assert.deepEqual(memoryCitations, [
    { source: 'MEMORY.md:137-142', note: 'used verified container provisioning details' },
    { source: 'notes/deploy.md:4-9' },
  ]);
});

test('a plan followed by a memory citation is still recognized as a plan', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-plan-citation-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-plan-citation-1';
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, `rollout-${providerSessionId}.jsonl`), `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'AgentMessage',
            id: 'plan-1',
            content: [{
              type: 'Text',
              text: '<proposed_plan>\n# Ship it\n</proposed_plan>\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[prior deploy steps]\n</citation_entries>\n</oai-mem-citation>',
            }],
          },
        },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-plan-citation-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-plan-citation-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-plan-citation-1');
      const plan = history.messages.find((message) => message.toolName === 'ExitPlanMode');

      assert.ok(plan, 'the trailing citation block must not hide the plan envelope');
      assert.deepEqual(plan.toolInput, { plan: '# Ship it' });
      assert.deepEqual(plan.memoryCitations, [{ source: 'MEMORY.md:1-2', note: 'prior deploy steps' }]);
      assert.ok(
        !history.messages.some((message) => JSON.stringify(message).includes('oai-mem-citation')),
        'no transcript row may still carry the raw citation markup',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('an interrupted subagent closes its Agent row instead of running forever', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-interrupted-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-subagent-interrupted-1';
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    // Event shapes mirror a real rollout: the `started` activity carries the
    // agent path, and the agent later dies without ever sending a
    // FINAL_ANSWER that would close its Agent card.
    await writeFile(path.join(sessionsDir, `rollout-${providerSessionId}.jsonl`), `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'SubAgentActivity',
            id: 'call_spawn_1',
            agent_path: '/root/review_normalizer',
            agent_thread_id: 'thread-1',
            kind: 'started',
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'SubAgentActivity',
            id: 'interrupt-1',
            agent_path: '/root/review_normalizer',
            agent_thread_id: 'thread-1',
            kind: 'interrupted',
          },
        },
      }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-subagent-interrupted-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-subagent-interrupted-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-subagent-interrupted-1');
      const task = history.messages.find((message) => message.toolName === 'Agent');

      assert.ok(task, 'the spawn must render as a Agent row');
      assert.ok(task.toolResult, 'an interrupted subagent must not leave its card running');
      assert.match(String(task.toolResult?.content), /interrupted/i);
      assert.equal(task.toolResult?.isError, false);
      assert.equal(task.subagent?.status, 'stopped', 'live settles an interrupted agent as stopped; history must agree');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a subagent whose completed activity is on record stays completed through a later turn abort', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-completed-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-subagent-completed-1';
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    // Real rollouts carry agent reports the reader cannot parse as a
    // FINAL_ANSWER; the `completed` activity is then the only word that the
    // agent finished, and live settles the card on it.
    const activity = (id: string, kind: string) => JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'SubAgentActivity', id, agent_path: '/root/reviewer', agent_thread_id: 'thread-1', kind },
      },
    });
    await writeFile(path.join(sessionsDir, `rollout-${providerSessionId}.jsonl`), `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      activity('call_spawn_1', 'started'),
      activity('done-1', 'completed'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' } }),
    ].join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-subagent-completed-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-subagent-completed-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-subagent-completed-1');
      const agent = history.messages.find((message) => message.toolName === 'Agent');

      assert.ok(agent, 'the spawn must render as an Agent row');
      assert.equal(agent.subagent?.status, 'completed', 'live settles a completed activity as completed; history must agree');
      assert.notEqual(agent.toolResult?.isError, true);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a persisted assistant plan normalizes to the same plan card as a live one', () => {
  const provider = new CodexSessionsProvider();
  const plan = '# Rework the merge\n\n1. Anchor the order\n2. Delete the guess';

  const persisted = provider.normalizeMessage({
    uuid: 'row-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'assistant', content: `<proposed_plan>\n${plan}\n</proposed_plan>` },
  }, 'session-1');

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].kind, 'tool_use');
  assert.equal(persisted[0].toolName, 'ExitPlanMode');
  assert.deepEqual(persisted[0].toolInput, { plan });
});

test('a persisted assistant message without a plan envelope stays prose', () => {
  const provider = new CodexSessionsProvider();

  const persisted = provider.normalizeMessage({
    uuid: 'row-2',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'assistant', content: 'Here is what I found.' },
  }, 'session-1');

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].kind, 'text');
  assert.equal(persisted[0].content, 'Here is what I found.');
});

/**
 * Envelope edge cases. These moved here with the unwrapping itself: they used
 * to guard a client-side copy that stripped the tags at render time.
 */
test('readCodexProposedPlan reads a complete outer envelope', () => {
  assert.equal(
    readCodexProposedPlan('<proposed_plan>\n# Session Timeline\n\nPlan body\n</proposed_plan>'),
    '# Session Timeline\n\nPlan body',
  );
});

test('readCodexProposedPlan reads a plan whose closing tag has not streamed yet', () => {
  assert.equal(readCodexProposedPlan('<proposed_plan>\n# Partial plan'), '# Partial plan');
});

test('readCodexProposedPlan ignores a tag that is not the outer envelope', () => {
  assert.equal(readCodexProposedPlan('Use `<proposed_plan>` only for plans.'), null);
});

test('readCodexProposedPlan ignores an unmatched terminal closing tag', () => {
  assert.equal(
    readCodexProposedPlan('Ordinary text that mentions a terminal tag.\n</proposed_plan>'),
    null,
  );
});

test('a spawned agent picks up its thread id from a SubAgentActivity item', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-thread-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-subagent-thread-1';
    const agentThreadId = 'agent-thread-1';
    const callId = 'call_spawn_lighting';
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });

    // The spawned agent's own transcript is a sibling rollout named by its
    // thread id — the file the parent can only find once it knows that id.
    await writeFile(path.join(sessionsDir, `rollout-${agentThreadId}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: agentThreadId, cwd: workspacePath } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'AgentMessage', id: 'msg_agent_1', content: [{ type: 'Text', text: 'looked at the lighting code' }] },
        },
      }),
    ].join('\n') + '\n', 'utf8');

    await writeFile(path.join(sessionsDir, `rollout-${providerSessionId}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'check the lighting' }] } },
      }),
      // A spawn reaches the item stream only as a SubAgentActivity.
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn-1',
          item: { type: 'SubAgentActivity', id: callId, kind: 'started', agent_thread_id: agentThreadId, agent_path: '/root/original_lighting' },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root/original_lighting',
          content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nSender: /root/original_lighting\nPayload:\ndone' }],
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    ].join('\n') + '\n', 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-subagent-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-subagent-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-subagent-1');
      const spawned = history.messages.find((message) => message.subagent);

      assert.ok(spawned, 'the spawn should produce a card carrying subagent info');
      assert.equal(spawned.subagent?.id, agentThreadId, 'the thread id must reach the card');
      assert.ok(
        (spawned.subagentTools?.length ?? 0) > 0,
        "the agent's own transcript must be attached, not an empty timeline",
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history rows reuse the item id on every read', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-row-identity-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-row-identity-1';
    const lines = [
      JSON.stringify({ type: 'session_meta', ordinal: 0, payload: { id: providerSessionId, cwd: workspacePath } }),
      JSON.stringify({ type: 'event_msg', ordinal: 1, payload: { type: 'task_started', turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'event_msg',
        ordinal: 2,
        payload: {
          type: 'item_completed',
          turn_id: 'turn-1',
          item: { type: 'UserMessage', id: 'item-u1', content: [{ type: 'text', text: 'the prompt' }] },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        ordinal: 3,
        payload: {
          type: 'item_completed',
          turn_id: 'turn-1',
          item: { type: 'AgentMessage', id: 'msg_rollout_1', content: [{ type: 'Text', text: 'the answer' }] },
        },
      }),
      JSON.stringify({ type: 'event_msg', ordinal: 4, payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    ];
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, `rollout-${providerSessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-row-identity-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-row-identity-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const provider = new CodexSessionsProvider();
      const first = await provider.fetchHistory('app-row-identity-1');
      const second = await provider.fetchHistory('app-row-identity-1');

      assert.deepEqual(
        second.messages.map((message) => message.id),
        first.messages.map((message) => message.id),
        'two reads of one rollout must name the same rows the same way',
      );

      const assistantRow = first.messages.find(
        (message) => message.kind === 'text' && message.role === 'assistant',
      );
      assert.ok(assistantRow);
      assert.equal(
        assistantRow.id,
        'msg_rollout_1',
        'the persisted reply keeps the item id the live frame already used',
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});


test('Codex history restores user prompts from typed item_completed rows', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-typed-user-history-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-typed-1';
    const prompt = 'Typed prompt that must survive a refresh';
    const transcriptPath = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07', 'rollout-' + providerSessionId + '.jsonl');
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    const lineEnd = String.fromCharCode(10);
    const typedLine = JSON.stringify({
      timestamp: '2026-09-07T17:59:17.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 'typed-turn-1',
        item: {
          type: 'UserMessage',
          id: 'item-user-1',
          content: [
            { type: 'text', text: prompt, text_elements: [] },
            { type: 'local_image', path: '/tmp/prompt-picture.png', detail: null },
          ],
        },
      },
    });
    const wireUserEcho = JSON.stringify({
      timestamp: '2026-09-07T17:59:19.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
    });
    await writeFile(
      transcriptPath,
      [JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }), typedLine, wireUserEcho].join(lineEnd) + lineEnd,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-typed-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-typed-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-typed-1');
      const users = history.messages.filter((message) => message.role === 'user');
      const images = users[0]?.images as Array<{ path?: string; data?: string }> | undefined;

      assert.equal(users.length, 1, 'the wire user echo must not duplicate the typed prompt');
      assert.equal(users[0]?.content, prompt);
      assert.equal(images?.[0]?.path, '/tmp/prompt-picture.png');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history joins a spawn acknowledgement to the child transcript', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-history-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-parent-2';
    const agentThreadId = 'codex-agent-thread-2';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);

    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      // A spawn reaches the item stream only as this lifecycle event, so the
      // Agent row is built from it and keeps its id.
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CollabAgentToolCall',
            id: 'spawn-1',
            tool: 'spawn_agent',
            status: 'completed',
            receiver_thread_ids: [agentThreadId],
            receiver_agents: [{ thread_id: agentThreadId, agent_nickname: 'test_agent_1' }],
          },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root/test_agent_1',
          content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nSender: /root/test_agent_1\nPayload:\nAll done.' }],
        },
      }),
    ].join('\n')}\n`, 'utf8');

    // Codex writes a spawned agent's rollout next to its parent's, named after
    // the agent thread id.
    await writeFile(
      path.join(path.dirname(transcriptPath), `rollout-2026-07-07T00-00-00-${agentThreadId}.jsonl`),
      `${[
        JSON.stringify({
          type: 'session_meta',
          payload: { id: agentThreadId, cwd: workspacePath, thread_source: 'subagent', agent_nickname: 'Hegel' },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child-turn' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'CommandExecution',
              id: 'exec-agent-call-1',
              command: ['/bin/zsh', '-lc', 'ls'],
              status: 'completed',
              aggregated_output: 'README.md\n',
              exit_code: 0,
            },
          },
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-parent-2', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-parent-2', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-parent-2');
      const task = history.messages.find((message) => message.kind === 'tool_use' && message.toolName === 'Agent');

      assert.ok(task, 'a spawned agent must produce a Agent row');
      assert.equal(task.subagent?.id, agentThreadId);
      assert.equal(task.subagent?.name, 'Hegel');
      assert.equal(task.subagent?.status, 'completed');
      assert.equal((task.toolResult?.toolUseResult as any)?.isAsync, true);

      // The agent's own shell call is translated exactly like the parent's.
      assert.equal(task.subagentTools?.length, 1);
      assert.equal(task.subagentTools?.[0].kind, 'tool');
      assert.equal(task.subagentTools?.[0].toolName, 'Bash');
      assert.equal(task.subagentTools?.[0].toolResult?.content, 'README.md\n');
      assert.equal(task.id, 'spawn-1', 'the Agent row is named after the lifecycle item');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});


test('Codex history restores each child of a multi-agent spawn', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-history-'));
  const workspacePath = await createWorkspaceFixture();
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-parent-2';
    const agentThreadId = 'codex-agent-thread-2';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);

    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      // A spawn reaches the item stream only as this lifecycle event, so the
      // Agent row is built from it and keeps its id.
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CollabAgentToolCall',
            id: 'spawn-1',
            tool: 'spawn_agent',
            status: 'completed',
            receiver_thread_ids: [agentThreadId, "codex-agent-thread-3"],
            receiver_agents: [{ thread_id: agentThreadId, agent_nickname: 'test_agent_1' }],
          },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root/test_agent_1',
          content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nSender: /root/test_agent_1\nPayload:\nAll done.' }],
        },
      }),
    ].join('\n')}\n`, 'utf8');

    // Codex writes a spawned agent's rollout next to its parent's, named after
    // the agent thread id.
    await writeFile(
      path.join(path.dirname(transcriptPath), `rollout-2026-07-07T00-00-00-${agentThreadId}.jsonl`),
      `${[
        JSON.stringify({
          type: 'session_meta',
          payload: { id: agentThreadId, cwd: workspacePath, thread_source: 'subagent', agent_nickname: 'Hegel' },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child-turn' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'CommandExecution',
              id: 'exec-agent-call-1',
              command: ['/bin/zsh', '-lc', 'ls'],
              status: 'completed',
              aggregated_output: 'README.md\n',
              exit_code: 0,
            },
          },
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    await writeFile(path.join(path.dirname(transcriptPath), 'rollout-2026-07-07T00-00-00-codex-agent-thread-3.jsonl'), `${[
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-agent-thread-3', agent_nickname: 'Second' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'second-result', content: [{ type: 'text', text: 'Second report' }] } } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'second-turn' } }),
    ].join('\n')}\n`);

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-parent-2', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-parent-2', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-parent-2');
      const cards = history.messages.filter((message) => message.kind === 'tool_use' && message.toolName === 'Agent');
      assert.equal(cards.length, 2);
      const task = cards.find((message) => message.subagent?.id === agentThreadId);
      const second = cards.find((message) => message.subagent?.id === 'codex-agent-thread-3');
      assert.equal(second?.subagent?.status, 'completed');
      assert.equal(second?.subagentTools?.[0]?.content, 'Second report');

      assert.ok(task, 'a spawned agent must produce a Agent row');
      assert.equal(task.subagent?.id, agentThreadId);
      assert.equal(task.subagent?.name, 'Hegel');
      assert.equal(task.subagent?.status, 'completed');
      assert.equal((task.toolResult?.toolUseResult as any)?.isAsync, true);

      // The agent's own shell call is translated exactly like the parent's.
      assert.equal(task.subagentTools?.length, 1);
      assert.equal(task.subagentTools?.[0].kind, 'tool');
      assert.equal(task.subagentTools?.[0].toolName, 'Bash');
      assert.equal(task.subagentTools?.[0].toolResult?.content, 'README.md\n');
      assert.equal(task.id, `spawn-1:${agentThreadId}`,  'the Agent row is named after the lifecycle item');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
