import assert from 'node:assert/strict';
import test from 'node:test';

import { extractAntigravitySubagents } from '@/modules/providers/list/antigravity/antigravity-subagent.js';

// This file exercises the print runtime; pin the fallback explicitly so the
// ACP default flip does not reroute these runs (docs/design/agyACP运行时.md).
process.env.CLOUDCLI_ANTIGRAVITY_ACP = '0';

// Step shapes below are verbatim agy 1.3.1 `--output-format stream-json`
// output. The live stream names a subagent only once its invocation step is
// DONE; a backgrounded run_command stays one ACTIVE `tool` step until the
// command exits, and a finished task reports back as a contentless
// `system_message` step.
const subagentStep = (state: string, conversationIds: Array<string | undefined>) => ({
  conversation_id: 'root', step_index: 2, state, step_type: 'subagent', tool_name: 'invoke_subagent',
  subagent_info: {
    subagents: conversationIds.map((conversationId, index) => ({
      type_name: 'self',
      role: index === 0 ? 'Product Reviewer' : 'Test Runner',
      initial_prompt: 'Review UI',
      ...(conversationId ? { conversation_id: conversationId, log_uri: `file:///brain/${conversationId}` } : {}),
    })),
  },
});

test('a finished invoke_subagent step yields one agent per created subagent, named by call and conversation', () => {
  const agents = extractAntigravitySubagents(subagentStep('DONE', ['sub-1', 'sub-2']));
  assert.deepEqual(agents.map((agent) => [agent.conversationId, agent.toolUseId, agent.role]), [
    ['sub-1', 'tool_2:sub-1', 'Product Reviewer'],
    ['sub-2', 'tool_2:sub-2', 'Test Runner'],
  ]);
});

test('steps that do not name a running subagent yield no agent', () => {
  assert.deepEqual(extractAntigravitySubagents(subagentStep('ACTIVE', [undefined])), []);
  assert.deepEqual(extractAntigravitySubagents({
    step_type: 'tool', tool_name: 'run_command', state: 'ACTIVE',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 25' } },
  }), []);
  assert.deepEqual(extractAntigravitySubagents({ step_type: 'system_message', state: 'DONE' }), []);
  assert.deepEqual(extractAntigravitySubagents({ step_type: 'subagent', state: 'DONE', subagent_info: { subagents: [null, 'x'] } }), []);
});

// The runtime resolves the agy path once per process, so every run in this
// file shares one stand-in, and each test hands it a script over the env.
let stubPath: Promise<string> | null = null;

function sharedStub(): Promise<string> {
  stubPath ??= (async () => {
    const fsSync = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(fsSync.mkdtempSync(path.join(os.tmpdir(), 'agy-bg-stub-')), 'agy');
    fsSync.writeFileSync(file, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('1.3.1'); process.exit(0); }
const { events, exitOnEof } = JSON.parse(process.env.AGY_STUB_SCRIPT);
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {});
process.stdin.on('end', () => { if (exitOnEof) process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
(async () => {
  for (const event of events) {
    if (typeof event === 'number') await new Promise((r) => setTimeout(r, event));
    else if (event.__exit !== undefined) process.exit(event.__exit);
    else console.log(JSON.stringify(event));
  }
})();
`, { mode: 0o755 });
    return file;
  })();
  return stubPath;
}

/** Runs `run` with agy replaced by a stand-in that prints `events` (numbers are delays). */
async function withStub<T>(
  events: Array<Record<string, unknown> | number>,
  run: () => Promise<T>,
  exitOnEof = true,
): Promise<T> {
  const oldPath = process.env.CLOUDCLI_ANTIGRAVITY_PATH;
  process.env.CLOUDCLI_ANTIGRAVITY_PATH = await sharedStub();
  process.env.AGY_STUB_SCRIPT = JSON.stringify({ events, exitOnEof });
  try {
    return await run();
  } finally {
    delete process.env.AGY_STUB_SCRIPT;
    if (oldPath) process.env.CLOUDCLI_ANTIGRAVITY_PATH = oldPath;
    else delete process.env.CLOUDCLI_ANTIGRAVITY_PATH;
  }
}

async function createRun(sessionId: string) {
  const { AntigravityRuntimeProvider } = await import('@/modules/providers/list/antigravity/antigravity-runtime.provider.js');
  const { AntigravitySessionsProvider } = await import('@/modules/providers/list/antigravity/antigravity-sessions.provider.js');
  const runtime = new AntigravityRuntimeProvider();
  const sessions = new AntigravitySessionsProvider();
  const sent: any[] = [];
  const writer = { userId: null, send: (msg: any) => { sent.push(msg); } };
  const context = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => null,
    normalizeMessage: (raw: any, sid: string | null) => sessions.normalizeMessage(raw, sid),
    isProviderInstalled: async () => true,
  };
  const done = runtime.run('test prompt', { sessionId }, writer as any, context as any);
  const waitForCard = async () => {
    const startedAt = Date.now();
    while (runtime.backgroundTasks.list(sessionId).length === 0 && Date.now() - startedAt < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { runtime, sent, done, waitForCard };
}

const step = (step_update: Record<string, unknown>) => ({ event: 'step_update', step_update });

test('a subagent card shows while the turn waits and clears before the turn completes', async () => {
  await withStub([
    { event: 'init', conversation_id: 'conv-sub', init: { cwd: '/tmp' } },
    step({ ...subagentStep('ACTIVE', [undefined]), conversation_id: 'conv-sub' }),
    step({ ...subagentStep('DONE', ['subagent-999']), conversation_id: 'conv-sub' }),
    step({ conversation_id: 'conv-sub', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Waiting for subagent\n' }),
    400,
    step({ conversation_id: 'conv-sub', step_index: 4, state: 'DONE', step_type: 'system_message' }),
    step({ conversation_id: 'conv-sub', step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: 'Review finished.\n' }),
    { event: 'result', result: { conversation_id: 'conv-sub', status: 'SUCCESS', num_turns: 1, usage: { total_tokens: 88 } } },
  ], async () => {
    const { runtime, sent, done, waitForCard } = await createRun('conv-sub');
    await waitForCard();
    assert.deepEqual(runtime.backgroundTasks.list('conv-sub').map((task) => [task.id, task.command]), [['tool_2:subagent-999', 'Product Reviewer']]);
    assert.equal(sent.some((msg) => msg.kind === 'complete'), false, 'agy holds its result while the subagent runs');

    await done;
    assert.deepEqual(runtime.backgroundTasks.list('conv-sub'), []);
    const statuses = sent.filter((msg) => msg.kind === 'status' && msg.text === 'background_tasks');
    assert.deepEqual(statuses.map((msg) => msg.backgroundTasks.length), [1, 0]);
    const clearedAt = sent.indexOf(statuses.at(-1));
    const completeAt = sent.findIndex((msg) => msg.kind === 'complete');
    assert.ok(clearedAt < completeAt, 'the client must not see a finished turn that still has a card');
  });
});

test('abort clears subagent cards and stops the process', async () => {
  await withStub([
    { event: 'init', conversation_id: 'conv-abort', init: { cwd: '/tmp' } },
    step({ ...subagentStep('DONE', ['subagent-abort-1']), conversation_id: 'conv-abort' }),
  ], async () => {
    const { runtime, done, waitForCard } = await createRun('conv-abort');
    await waitForCard();
    assert.equal(runtime.backgroundTasks.list('conv-abort').length, 1);
    assert.equal(await runtime.abort('conv-abort'), true);
    // The process exit settles the cards and empties the list.
    assert.equal((await done as any).aborted, true);
    assert.equal(runtime.backgroundTasks.list('conv-abort').length, 0);
  }, false);
});

test('an interrupted-stream result keeps the subagent cards of the resumed turn', async () => {
  const interrupted = 'The stream was interrupted. Please continue the task you were working on.';
  await withStub([
    { event: 'init', conversation_id: 'conv-resume', init: { cwd: '/tmp' } },
    step({ ...subagentStep('DONE', ['subagent-r']), conversation_id: 'conv-resume' }),
    { event: 'result', result: { conversation_id: 'conv-resume', status: 'ERROR', error: interrupted } },
    400,
    { event: 'result', result: { conversation_id: 'conv-resume', status: 'SUCCESS' } },
  ], async () => {
    const { runtime, done, waitForCard } = await createRun('conv-resume');
    await waitForCard();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(runtime.backgroundTasks.list('conv-resume').length, 1, 'agy resumes the turn itself');
    await done;
    assert.deepEqual(runtime.backgroundTasks.list('conv-resume'), []);
  });
});

/** Gives each conversation a transcript of its own, ending as `ending` says, under a temp data dir. */
async function withChildTranscripts<T>(endings: Record<string, 'normal' | 'error'>, run: () => Promise<T>): Promise<T> {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-children-'));
  for (const [id, ending] of Object.entries(endings)) {
    const logs = path.join(root, 'brain', id, '.system_generated', 'logs');
    await fs.mkdir(logs, { recursive: true });
    const last = ending === 'normal'
      ? { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Done.' }
      : { step_index: 1, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error' };
    await fs.writeFile(path.join(logs, 'transcript.jsonl'), [{ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'go' }, last].map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  const previous = process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR;
  process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR = root;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR;
    else process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

const agentCards = (sent: any[]) => sent.filter((msg) => msg.kind === 'tool_use' && msg.toolName === 'Agent');
const taskStatuses = (sent: any[]) => sent.filter((msg) => msg.kind === 'task_status');

test('at the turn result each agent settles by how its own transcript ended: finished is completed, errored is failed', async () => {
  await withChildTranscripts({ 'sub-1': 'normal', 'sub-2': 'error' }, () => withStub([
    { event: 'init', conversation_id: 'conv-two', init: { cwd: '/tmp' } },
    step({ ...subagentStep('DONE', ['sub-1', 'sub-2']), conversation_id: 'conv-two' }),
    step({ conversation_id: 'conv-two', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Waiting\n' }),
    300,
    { event: 'result', result: { conversation_id: 'conv-two', status: 'SUCCESS', usage: { total_tokens: 5 } } },
  ], async () => {
    const { sent, done, waitForCard } = await createRun('conv-two');
    await waitForCard();

    const cards = agentCards(sent);
    assert.deepEqual(cards.map((card) => card.toolId), ['tool_2:sub-1', 'tool_2:sub-2']);
    assert.deepEqual(cards.map((card) => card.toolInput.subagent_type), ['Product Reviewer', 'Test Runner']);
    assert.deepEqual(taskStatuses(sent).map((msg) => [msg.event, msg.toolUseId, msg.taskId]), [
      ['started', 'tool_2:sub-1', 'sub-1'],
      ['started', 'tool_2:sub-2', 'sub-2'],
    ]);

    await done;
    const settled = taskStatuses(sent).filter((msg) => msg.event === 'notification');
    assert.deepEqual(settled.map((msg) => [msg.toolUseId, msg.status]), [
      ['tool_2:sub-1', 'completed'],
      ['tool_2:sub-2', 'failed'],
    ]);
    const completeAt = sent.findIndex((msg) => msg.kind === 'complete');
    assert.ok(sent.indexOf(settled[1]) < completeAt, 'both cards settle before the turn completes');
  }));
});

test('agents still outstanding when the engine process dies are settled as stopped', async () => {
  await withStub([
    { event: 'init', conversation_id: 'conv-crash', init: { cwd: '/tmp' } },
    step({ ...subagentStep('DONE', ['sub-crash']), conversation_id: 'conv-crash' }),
    100,
    { __exit: 1 },
  ], async () => {
    const { runtime, sent, done } = await createRun('conv-crash');
    await assert.rejects(done);

    const settled = taskStatuses(sent).filter((msg) => msg.event === 'notification');
    assert.deepEqual(settled.map((msg) => [msg.toolUseId, msg.status]), [['tool_2:sub-crash', 'stopped']]);
    assert.deepEqual(runtime.backgroundTasks.list('conv-crash'), []);
  });
});

test('an abort settles the outstanding agents as stopped', async () => {
  await withStub([
    { event: 'init', conversation_id: 'conv-abort-2', init: { cwd: '/tmp' } },
    step({ ...subagentStep('DONE', ['sub-a']), conversation_id: 'conv-abort-2' }),
  ], async () => {
    const { runtime, sent, done, waitForCard } = await createRun('conv-abort-2');
    await waitForCard();
    await runtime.abort('conv-abort-2');
    await done;

    const settled = taskStatuses(sent).filter((msg) => msg.event === 'notification');
    assert.deepEqual(settled.map((msg) => msg.status), ['stopped']);
  }, false);
});

test('an aborted run leaves no session-key aliases behind', async () => {
  const { getAntigravityBackgroundKeyAliasCount } = await import('@/modules/providers/list/antigravity/antigravity-runtime.provider.js');
  const before = getAntigravityBackgroundKeyAliasCount();
  await withStub([
    { event: 'init', conversation_id: 'conv-alias', init: { cwd: '/tmp' } },
    step({ ...subagentStep('DONE', ['sub-alias']), conversation_id: 'conv-alias' }),
  ], async () => {
    const { runtime, done, waitForCard } = await createRun('conv-alias');
    await waitForCard();
    await runtime.abort('conv-alias');
    await done;
    assert.equal(getAntigravityBackgroundKeyAliasCount(), before);
  }, false);
});

test('while an agent works, its own steps stream into its card and stop when it settles', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-live-'));
  const logs = path.join(root, 'brain', 'sub-live', '.system_generated', 'logs');
  await fs.mkdir(logs, { recursive: true });
  const rows = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\ngo\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/tmp/a.ts' } }] },
    { step_index: 2, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', content: 'Created At: x\nCompleted At: y\nFile Path: `/tmp/a.ts`\n1: body' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Read it.' },
  ];
  await fs.writeFile(path.join(logs, 'transcript.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const previous = process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR;
  process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR = root;
  try {
    await withStub([
      { event: 'init', conversation_id: 'conv-live', init: { cwd: '/tmp' } },
      step({ ...subagentStep('DONE', ['sub-live']), conversation_id: 'conv-live' }),
      2500,
      { event: 'result', result: { conversation_id: 'conv-live', status: 'SUCCESS', usage: { total_tokens: 1 } } },
    ], async () => {
      const { sent, done, waitForCard } = await createRun('conv-live');
      await waitForCard();
      const deadline = Date.now() + 2000;
      while (!sent.some((msg) => msg.parentToolUseId === 'tool_2:sub-live' && msg.kind === 'text') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const steps = sent.filter((msg) => msg.parentToolUseId === 'tool_2:sub-live');
      assert.deepEqual(steps.map((msg) => [msg.kind, msg.toolName ?? msg.content]), [['tool_use', 'view_file'], ['text', 'Read it.']]);
      assert.match(steps[0].toolResult?.content ?? '', /body/);
      await done;
      const countAtEnd = sent.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(sent.length, countAtEnd, 'nothing is sent for the agent once it settled');
    });
  } finally {
    if (previous === undefined) delete process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR;
    else process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an agent\'s last steps arrive before its card settles and before the turn completes', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-order-'));
  const logs = path.join(root, 'brain', 'sub-order', '.system_generated', 'logs');
  await fs.mkdir(logs, { recursive: true });
  const file = path.join(logs, 'transcript.jsonl');
  const head = [{ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'go' }];
  const write = (rows: unknown[]) => fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const previous = process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR;
  process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR = root;
  try {
    await withStub([
      { event: 'init', conversation_id: 'conv-order', init: { cwd: '/tmp' } },
      step({ ...subagentStep('DONE', ['sub-order']), conversation_id: 'conv-order' }),
      700,
      { event: 'result', result: { conversation_id: 'conv-order', status: 'SUCCESS', usage: { total_tokens: 1 } } },
    ], async () => {
      const { sent, done, waitForCard } = await createRun('conv-order');
      await waitForCard();
      // The transcript appears only now, a moment before the turn result: there
      // was nothing to watch yet and the next poll is seconds away, so only the
      // final read at settle can find these steps.
      await new Promise((resolve) => setTimeout(resolve, 650));
      await write([...head, { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Last words.' }]);
      await done;
      await new Promise((resolve) => setTimeout(resolve, 200));

      const lastWords = sent.findIndex((msg) => msg.parentToolUseId === 'tool_2:sub-order' && msg.content === 'Last words.');
      const settled = sent.findIndex((msg) => msg.kind === 'task_status' && msg.event === 'notification');
      const complete = sent.findIndex((msg) => msg.kind === 'complete');
      assert.ok(lastWords >= 0, 'the final step reaches the page');
      assert.ok(lastWords < settled && settled < complete, 'final step, then settle, then complete');
    });
  } finally {
    if (previous === undefined) delete process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR;
    else process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('a formal agent report retires only that agent while its parent keeps working', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const first = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const second = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const parent = 'conv-report';
  await withChildTranscripts({ [parent]: 'normal', [first]: 'normal', [second]: 'error' }, async () => {
    const file = path.join(process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR!, 'brain', parent, '.system_generated', 'logs', 'transcript.jsonl');
    const report = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-23T00:00:00Z sender=${first} priority=MESSAGE_PRIORITY_LOW content=approved\n</SYSTEM_MESSAGE>`;
    // Ordinary parent prose and a child's DONE planner response are not completion receipts.
    await fs.writeFile(file, JSON.stringify({ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'The review is approved.' }) + '\n');
    await withStub([
      { event: 'init', conversation_id: parent, init: { cwd: '/tmp' } },
      step({ ...subagentStep('DONE', [first, second]), conversation_id: parent }),
      step({ conversation_id: parent, step_index: 3, state: 'DONE', step_type: 'system_message' }),
      5000,
      step({ ...subagentStep('DONE', [first, second]), conversation_id: parent }),
    ], async () => {
      const { runtime, sent, done, waitForCard } = await createRun(parent);
      try {
        await waitForCard();
        await new Promise((resolve) => setTimeout(resolve, 2200));
        assert.equal(runtime.backgroundTasks.list(parent).length, 2, 'neither prose nor an unaddressed system notification finishes an agent');
        await fs.appendFile(file, JSON.stringify({ step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: report }) + '\n');
        const deadline = Date.now() + 4000;
        while (runtime.backgroundTasks.list(parent).length === 2 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.deepEqual(runtime.backgroundTasks.list(parent).map((task) => task.id), [`tool_2:${second}`], 'a returned review must disappear before the parent turn ends');
        assert.equal(sent.some((msg) => msg.kind === 'complete'), false, 'the parent is still working');
        const notices = taskStatuses(sent).filter((msg) => msg.event === 'notification');
        assert.deepEqual(notices.map((msg) => [msg.taskId, msg.status]), [[first, 'completed']]);
        const finalStep = sent.findIndex((msg) => msg.parentToolUseId === `tool_2:${first}` && msg.content === 'Done.');
        assert.ok(finalStep >= 0 && finalStep < sent.indexOf(notices[0]), 'final child activity precedes its completion');
        const strips = sent.filter((msg) => msg.kind === 'status' && msg.text === 'background_tasks');
        assert.deepEqual(strips.at(-1).backgroundTasks.map((task: any) => task.id), [`tool_2:${second}`]);
        // Repeated receipts must not emit duplicate terminal notifications.
        await fs.appendFile(file, JSON.stringify({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: report }) + '\n');
        await new Promise((resolve) => setTimeout(resolve, 2200));
        assert.equal(taskStatuses(sent).filter((msg) => msg.event === 'notification').length, 1);
        assert.equal(taskStatuses(sent).filter((msg) => msg.event === 'started' && msg.taskId === first).length, 1, 'a replayed launch cannot resurrect a completed agent');
      } finally {
        await runtime.abort(parent);
        await done;
      }
      assert.deepEqual(taskStatuses(sent).filter((msg) => msg.event === 'notification').map((msg) => [msg.taskId, msg.status]), [[first, 'completed'], [second, 'stopped']], 'abort only settles the agent still outstanding');
    }, false);
  });
});


test('reports in a delayed full transcript retire every agent before a successful parent result', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const id = 'cccccccc-3333-4333-8333-cccccccccccc';
  const parent = 'conv-full-report';
  await withChildTranscripts({ [parent]: 'normal' }, async () => {
    const compact = path.join(process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR!, 'brain', parent, '.system_generated', 'logs', 'transcript.jsonl');
    const full = path.join(path.dirname(compact), 'transcript_full.jsonl');
    const report = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-23T00:00:00Z sender=${id} priority=MESSAGE_PRIORITY_LOW content=approved\n</SYSTEM_MESSAGE>`;
    const row = { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE' };
    await fs.writeFile(compact, JSON.stringify({ ...row, content: 'Report pending', truncated_fields: ['content'] }) + '\n');
    await withStub([
      { event: 'init', conversation_id: parent, init: { cwd: '/tmp' } },
      step({ ...subagentStep('DONE', [id]), conversation_id: parent }),
      step({ conversation_id: parent, step_index: 3, state: 'DONE', step_type: 'system_message' }),
      3500,
      { event: 'result', result: { conversation_id: parent, status: 'SUCCESS' } },
    ], async () => {
      const { runtime, sent, done, waitForCard } = await createRun(parent);
      try {
        await waitForCard();
        // The initial contentless notification may beat persistence. The full
        // artifact catches up later, without changing compact or sending a new notice.
        await new Promise((resolve) => setTimeout(resolve, 150));
        await fs.writeFile(full, JSON.stringify({ ...row, content: report }) + '\n');
        const deadline = Date.now() + 2500;
        while (runtime.backgroundTasks.list(parent).length > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.deepEqual(runtime.backgroundTasks.list(parent), []);
        assert.equal(sent.some((msg) => msg.kind === 'complete'), false);
        assert.deepEqual(taskStatuses(sent).filter((msg) => msg.event === 'notification').map((msg) => msg.status), ['completed'], 'the parent report is sufficient even without a child transcript');
        await done;
        assert.deepEqual(taskStatuses(sent).filter((msg) => msg.event === 'notification').map((msg) => msg.status), ['completed'], 'the final result does not settle a returned agent twice');
        const count = sent.length;
        await fs.appendFile(full, JSON.stringify({ ...row, step_index: 2, content: report }) + '\n');
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(sent.length, count, 'no late events after the parent turn ended');
      } finally {
        await runtime.abort(parent);
        await done;
      }
    });
  });
});

test('a parent transcript missing on the first notice is retried after it appears', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const id = 'dddddddd-4444-4444-8444-dddddddddddd';
  const parent = 'conv-late-parent';
  await withChildTranscripts({ [parent]: 'normal', [id]: 'normal' }, async () => {
    const file = path.join(process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR!, 'brain', parent, '.system_generated', 'logs', 'transcript.jsonl');
    await fs.rm(file);
    await withStub([
      { event: 'init', conversation_id: parent, init: { cwd: '/tmp' } },
      step({ ...subagentStep('DONE', [id]), conversation_id: parent }),
      step({ conversation_id: parent, step_index: 3, state: 'DONE', step_type: 'system_message' }),
    ], async () => {
      const { runtime, sent, done, waitForCard } = await createRun(parent);
      try {
        await waitForCard();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const report = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-23T00:00:00Z sender=${id} priority=MESSAGE_PRIORITY_LOW content=approved\n</SYSTEM_MESSAGE>`;
        // A user quoting an agent receipt must not finish that agent.
        await fs.writeFile(file, JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: report }) + '\n');
        await new Promise((resolve) => setTimeout(resolve, 2200));
        assert.equal(runtime.backgroundTasks.list(parent).length, 1);
        await fs.appendFile(file, JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: report }) + '\n');
        const deadline = Date.now() + 2500;
        while (runtime.backgroundTasks.list(parent).length > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.deepEqual(taskStatuses(sent).filter((msg) => msg.event === 'notification').map((msg) => msg.status), ['completed']);
        assert.deepEqual(runtime.backgroundTasks.list(parent), []);
      } finally {
        await runtime.abort(parent);
        await done;
      }
    }, false);
  });
});

test('abort stops child polling immediately even while a parent report read is blocked', async (t) => {
  const fs = (await import('node:fs/promises')).default;
  const path = await import('node:path');
  const { AntigravitySessionsProvider } = await import('@/modules/providers/list/antigravity/antigravity-sessions.provider.js');
  const parent = 'conv-blocked-report';
  const id = 'sub-blocked-report';
  await withChildTranscripts({ [parent]: 'normal', [id]: 'normal' }, async () => {
    const parentFile = path.join(process.env.CLOUDCLI_ANTIGRAVITY_DATA_DIR!, 'brain', parent, '.system_generated', 'logs', 'transcript.jsonl');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let blocked = false;
    const stat = fs.stat;
    t.mock.method(fs, 'stat', async (...args: Parameters<typeof stat>) => {
      if (args[0] === parentFile) { blocked = true; await gate; }
      return stat(...args);
    });
    let childReads = 0;
    const fetch = AntigravitySessionsProvider.prototype.fetchHistory;
    t.mock.method(AntigravitySessionsProvider.prototype, 'fetchHistory', async function (this: InstanceType<typeof AntigravitySessionsProvider>, ...args: Parameters<typeof fetch>) {
      if (args[0] === id) childReads += 1;
      return fetch.apply(this, args);
    });
    await withStub([
      { event: 'init', conversation_id: parent, init: { cwd: '/tmp' } },
      step({ ...subagentStep('DONE', [id]), conversation_id: parent }),
      step({ conversation_id: parent, step_index: 3, state: 'DONE', step_type: 'system_message' }),
    ], async () => {
      const { runtime, sent, done, waitForCard } = await createRun(parent);
      try {
        await waitForCard();
        const deadline = Date.now() + 1000;
        while (!blocked && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(blocked, 'the parent report read is in flight');
        await runtime.abort(parent);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const readsAfterStop = childReads;
        await new Promise((resolve) => setTimeout(resolve, 2200));
        assert.equal(childReads, readsAfterStop, 'child polling must stop without waiting for the parent read');
        release();
        await done;
        assert.deepEqual(taskStatuses(sent).filter((msg) => msg.event === 'notification').map((msg) => msg.status), ['stopped']);
      } finally {
        release();
        await runtime.abort(parent);
        await done;
      }
    }, false);
  });
});

test('a final child read that exceeds the timeout cannot emit after the parent completes', async (t) => {
  const { AntigravitySessionsProvider } = await import('@/modules/providers/list/antigravity/antigravity-sessions.provider.js');
  const parent = 'conv-slow-child';
  const id = 'sub-slow-child';
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  const fetch = AntigravitySessionsProvider.prototype.fetchHistory;
  t.mock.method(AntigravitySessionsProvider.prototype, 'fetchHistory', async function (this: InstanceType<typeof AntigravitySessionsProvider>, ...args: Parameters<typeof fetch>) {
    if (args[0] === id) await gate;
    return fetch.apply(this, args);
  });
  await withChildTranscripts({ [id]: 'normal' }, () => withStub([
    { event: 'init', conversation_id: parent, init: { cwd: '/tmp' } },
    step({ ...subagentStep('DONE', [id]), conversation_id: parent }),
    150,
    { event: 'result', result: { conversation_id: parent, status: 'SUCCESS' } },
  ], async () => {
    const { sent, done } = await createRun(parent);
    try {
      await done;
      assert.ok(warnings.some((line) => line.includes('Final agent transcript reads did not finish in time')));
      const count = sent.length;
      release();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(sent.length, count, 'a timed-out child read must not write past complete');
    } finally {
      release();
    }
  }));
});
