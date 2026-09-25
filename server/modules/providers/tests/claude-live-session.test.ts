import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeProcessFingerprint,
  canReuseClaudeLiveProcess,
  claudeResultFinishesTurn,
  createClaudeBackgroundWorkTracker,
  createClaudeHeldPromptStream,
  readClaudeClaimedUserMessageUuids,
  readClaudeInitUuidStampingSupport,
  type ClaudeInputMessage,
} from '@/modules/providers/list/claude/claude-live-session.js';

function inputMessage(content: string): ClaudeInputMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    timestamp: new Date(0).toISOString(),
  };
}

test('the held stream yields the initial prompt, then delivers pushed turns until released', async () => {
  const stream = createClaudeHeldPromptStream([inputMessage('first')]);
  const iterator = stream.stream[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.message.content, 'first');

  // Nothing queued: the iterator parks instead of ending the stream.
  const pending = iterator.next();
  assert.equal(stream.push(inputMessage('second')), true);
  const second = await pending;
  assert.equal(second.done, false);
  assert.equal(second.value?.message.content, 'second');

  const closing = iterator.next();
  stream.release();
  const end = await closing;
  assert.equal(end.done, true);
  assert.equal(stream.isReleased(), true);
  assert.equal(stream.push(inputMessage('third')), false);
});

test('a held stream parks until the first push when it starts empty', async () => {
  const stream = createClaudeHeldPromptStream([]);
  const iterator = stream.stream[Symbol.asyncIterator]();

  const pending = iterator.next();
  stream.push(inputMessage('only'));
  const next = await pending;
  assert.equal(next.value?.message.content, 'only');

  const closing = iterator.next();
  stream.release();
  assert.equal((await closing).done, true);
});

test('background task frames keep the live set, with replace semantics and ambient exclusion', () => {
  const tracker = createClaudeBackgroundWorkTracker();

  tracker.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [
      { task_id: 'bg-1', task_type: 'local_bash', description: 'train' },
      { task_id: 'ambient-1', task_type: 'local_bash', description: 'watcher', ambient: true },
    ],
  });
  assert.equal(tracker.hasOutstanding(), true);
  assert.equal(tracker.hasObservations(), true);

  // The payload is the full live set: bg-1 is gone even though no
  // task_notification for it was ever seen.
  tracker.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'bg-2', task_type: 'local_agent', description: 'research' }],
  });
  assert.equal(tracker.hasOutstanding(), true);

  tracker.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [],
  });
  assert.equal(tracker.hasOutstanding(), false);
});

test('task_started and task_notification track tasks when no change frame arrives', () => {
  const tracker = createClaudeBackgroundWorkTracker();

  // A foreground start proves nothing about background tracking.
  tracker.observe({ type: 'system', subtype: 'task_started', task_id: 'fg-1', is_backgrounded: false });
  assert.equal(tracker.hasObservations(), false);

  tracker.observe({ type: 'system', subtype: 'task_started', task_id: 'bg-1', is_backgrounded: true });
  assert.equal(tracker.hasOutstanding(), true);
  assert.equal(tracker.hasObservations(), true);

  tracker.observe({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed' });
  assert.equal(tracker.hasOutstanding(), false);
});

test('unrelated frames and malformed payloads leave the tracker untouched', () => {
  const tracker = createClaudeBackgroundWorkTracker();

  tracker.observe(null);
  tracker.observe('not-a-message');
  tracker.observe({ type: 'assistant', message: { content: [] } });
  tracker.observe({ type: 'system', subtype: 'task_notification', task_id: 42 });
  tracker.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: 'nope' });

  assert.equal(tracker.hasOutstanding(), false);
  assert.equal(tracker.hasObservations(), false);
});

function fingerprint(overrides: Record<string, unknown> = {}) {
  return buildClaudeProcessFingerprint({
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'default',
    cwd: '/repo',
    allowedTools: ['Read', 'Bash'],
    disallowedTools: [],
    mcpServers: null,
    ...overrides,
  });
}

test('a live process is reused only when every spawn option still matches', () => {
  const live = fingerprint();

  assert.equal(
    canReuseClaudeLiveProcess({
      liveFingerprint: live,
      turnFingerprint: fingerprint(),
      released: false,
      turnActive: false,
      rewritesHistory: false,
    }),
    true,
  );

  for (const mismatch of [
    { model: 'opus' },
    { effort: 'low' },
    { permissionMode: 'plan' },
    { cwd: '/other' },
    { allowedTools: ['Read'] },
    { disallowedTools: ['Bash'] },
    { mcpServers: { github: { type: 'http', url: 'https://example.test/mcp' } } },
  ]) {
    assert.equal(
      canReuseClaudeLiveProcess({
        liveFingerprint: live,
        turnFingerprint: fingerprint(mismatch),
        released: false,
        turnActive: false,
        rewritesHistory: false,
      }),
      false,
      `expected a new process for ${JSON.stringify(mismatch)}`,
    );
  }
});

test('tool list order does not force a new process, ultracode changes do', () => {
  const live = buildClaudeProcessFingerprint({
    model: 'sonnet',
    allowedTools: ['Bash', 'Read'],
    disallowedTools: ['Write', 'Edit'],
  });
  const reordered = buildClaudeProcessFingerprint({
    model: 'sonnet',
    allowedTools: ['Read', 'Bash'],
    disallowedTools: ['Edit', 'Write'],
  });
  assert.equal(
    canReuseClaudeLiveProcess({
      liveFingerprint: live,
      turnFingerprint: reordered,
      released: false,
      turnActive: false,
      rewritesHistory: false,
    }),
    true,
  );

  const ultracode = buildClaudeProcessFingerprint({
    model: 'sonnet',
    allowedTools: ['Bash', 'Read'],
    disallowedTools: ['Write', 'Edit'],
    settings: { ultracode: true, enableWorkflows: true },
  });
  assert.equal(
    canReuseClaudeLiveProcess({
      liveFingerprint: live,
      turnFingerprint: ultracode,
      released: false,
      turnActive: false,
      rewritesHistory: false,
    }),
    false,
  );
});

test('a released, busy, or history-rewriting turn never reuses the process', () => {
  const live = fingerprint();

  for (const state of [
    { released: true, turnActive: false, rewritesHistory: false },
    { released: false, turnActive: true, rewritesHistory: false },
    { released: false, turnActive: false, rewritesHistory: true },
  ]) {
    assert.equal(
      canReuseClaudeLiveProcess({
        liveFingerprint: live,
        turnFingerprint: fingerprint(),
        ...state,
      }),
      false,
      `expected no reuse for ${JSON.stringify(state)}`,
    );
  }

  assert.equal(
    canReuseClaudeLiveProcess({
      liveFingerprint: null,
      turnFingerprint: fingerprint(),
      released: false,
      turnActive: false,
      rewritesHistory: false,
    }),
    false,
  );
});

test('claimed uuids are read from both the single and the batch field', () => {
  assert.deepEqual(
    readClaudeClaimedUserMessageUuids({
      user_message_uuid: 'turn-2',
      user_message_uuids: ['turn-1', 'turn-2'],
    }),
    ['turn-1', 'turn-2'],
  );
  assert.deepEqual(readClaudeClaimedUserMessageUuids({ type: 'assistant' }), []);
  assert.deepEqual(readClaudeClaimedUserMessageUuids(null), []);
  assert.deepEqual(
    readClaudeClaimedUserMessageUuids({ user_message_uuids: ['ok', 7, '', null] }),
    ['ok'],
  );
});

test('a result binds to the turn whose uuid it names', () => {
  // The submitted turn's own result.
  assert.equal(
    claudeResultFinishesTurn({
      turnUuid: 'turn-2',
      turnExplicit: true,
      claimedUuids: ['turn-1', 'turn-2'],
      uuidStampingSupported: true,
    }),
    true,
  );

  // A queued/follow-up turn finished while this turn is still waiting.
  assert.equal(
    claudeResultFinishesTurn({
      turnUuid: 'turn-3',
      turnExplicit: true,
      claimedUuids: ['turn-2'],
      uuidStampingSupported: true,
    }),
    false,
  );
});

test('an unstamped result closes a follow-up turn but not a waiting explicit one', () => {
  const stampedCli = { uuidStampingSupported: true };

  assert.equal(
    claudeResultFinishesTurn({
      turnUuid: null,
      turnExplicit: false,
      claimedUuids: [],
      ...stampedCli,
    }),
    true,
  );
  assert.equal(
    claudeResultFinishesTurn({
      turnUuid: 'turn-3',
      turnExplicit: true,
      claimedUuids: [],
      ...stampedCli,
    }),
    false,
  );

  // A CLI that never stamps falls back to arrival order for every turn.
  assert.equal(
    claudeResultFinishesTurn({
      turnUuid: 'turn-3',
      turnExplicit: true,
      claimedUuids: [],
      uuidStampingSupported: false,
    }),
    true,
  );
  assert.equal(
    claudeResultFinishesTurn({
      turnUuid: 'turn-3',
      turnExplicit: true,
      claimedUuids: [],
      uuidStampingSupported: null,
    }),
    true,
  );
});

test('the init frame settles uuid stamping support from the CLI version', () => {
  const init = (version: unknown) => ({ type: 'system', subtype: 'init', claude_code_version: version });

  assert.equal(readClaudeInitUuidStampingSupport(init('2.1.259')), true);
  assert.equal(readClaudeInitUuidStampingSupport(init('2.1.282')), true);
  assert.equal(readClaudeInitUuidStampingSupport(init('2.2.0')), true);
  assert.equal(readClaudeInitUuidStampingSupport(init('3.0.0-beta.1')), true);

  // Older or unreadable versions keep the caller's first-result fallback.
  assert.equal(readClaudeInitUuidStampingSupport(init('2.1.258')), null);
  assert.equal(readClaudeInitUuidStampingSupport(init('1.9.999')), null);
  assert.equal(readClaudeInitUuidStampingSupport(init(undefined)), null);
  assert.equal(readClaudeInitUuidStampingSupport(init('dev')), null);

  // Only the init frame carries the answer.
  assert.equal(readClaudeInitUuidStampingSupport({ type: 'system', subtype: 'status', claude_code_version: '2.1.282' }), null);
  assert.equal(readClaudeInitUuidStampingSupport({ type: 'result', claude_code_version: '2.1.282' }), null);
});

test('a resume that opens with an unstamped CLI-pushed turn does not finish the waiting user turn', () => {
  // A stamping CLI known from init: the "background task stopped" follow-up
  // result carries no uuid, and must not close the explicit turn behind it.
  assert.equal(
    claudeResultFinishesTurn({
      turnUuid: 'user-turn',
      turnExplicit: true,
      claimedUuids: [],
      uuidStampingSupported: readClaudeInitUuidStampingSupport({ type: 'system', subtype: 'init', claude_code_version: '2.1.282' }),
    }),
    false,
  );
});
