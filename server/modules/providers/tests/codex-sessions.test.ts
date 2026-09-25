import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { AppError } from '@/shared/utils.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { readCodexProposedPlan } from '@/modules/providers/list/codex/codex-thread-items.js';
import { liftMemoryCitations } from '@/modules/providers/shared/memory-citations.js';

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
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
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
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
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
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
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

test('Codex history reads 0.153-era prompts from item_completed UserMessage rows', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-history-user-153-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
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
            last_token_usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
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
            last_token_usage: { input_tokens: 36, output_tokens: 6, total_tokens: 42 },
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
      {
        // `used` is the latest turn's prompt (what the context window holds);
        // the session's cumulative spend stays available next to it.
        used: 42,
        total: 250_000,
        inputTokens: 36,
        outputTokens: 6,
        breakdown: { input: 36, output: 6 },
        cumulative: { used: 49, inputTokens: 40, outputTokens: 9 },
      },
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
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
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

test('Codex history attaches a spawned agent\'s own transcript to the Task row', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-parent-2';
    const agentThreadId = 'codex-agent-thread-2';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);

    await writeFile(transcriptPath, `${[
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
      // A spawn reaches the item stream only as this lifecycle event, so the
      // Task row is built from it and keeps its id.
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
      const task = history.messages.find((message) => message.kind === 'tool_use' && message.toolName === 'Task');

      assert.ok(task, 'a spawned agent must produce a Task row');
      assert.equal(task.subagent?.id, agentThreadId);
      assert.equal(task.subagent?.name, 'Hegel');
      assert.equal(task.subagent?.status, 'completed');
      assert.equal(task.toolResult?.content, 'All done.');

      // The agent's own shell call is translated exactly like the parent's.
      assert.equal(task.subagentTools?.length, 1);
      assert.equal(task.subagentTools?.[0].kind, 'tool');
      assert.equal(task.subagentTools?.[0].toolName, 'Bash');
      assert.equal(task.subagentTools?.[0].toolResult?.content, 'README.md\n');
      assert.equal(task.id, 'spawn-1', 'the Task row is named after the lifecycle item');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history closes a still-running subagent when its turn was aborted', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-aborted-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
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
      const task = history.messages.find((message) => message.kind === 'tool_use' && message.toolName === 'Task');

      assert.ok(task, 'the spawned agent must produce a Task row');
      assert.equal(task.subagent?.status, 'completed', 'an aborted turn must not leave the Task card running forever');
      assert.ok(task.toolResult, 'the Task card needs a result row to settle its spinner');
      assert.equal(task.toolResult?.isError, true, 'an agent the abort cut off did not finish its work');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

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
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
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

test('an interrupted subagent closes its Task row instead of running forever', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-interrupted-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-subagent-interrupted-1';
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    // Event shapes mirror a real rollout: the `started` activity carries the
    // agent path, and the agent later dies without ever sending a
    // FINAL_ANSWER that would close its Task card.
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
      const task = history.messages.find((message) => message.toolName === 'Task');

      assert.ok(task, 'the spawn must render as a Task row');
      assert.ok(task.toolResult, 'an interrupted subagent must not leave its card running');
      assert.match(String(task.toolResult?.content), /interrupted/i);
      assert.equal(task.toolResult?.isError, false);
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
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
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
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
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
