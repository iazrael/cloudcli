/**
 * Every transcript row must have an id derived from the engine's own record.
 *
 * A row that is persisted exists twice: once as a live frame while the run is
 * in flight, once as the row a later history read returns. The client shows
 * one row for both only if it can tell they are the same row, and the only
 * honest way to tell is a shared id. When an adapter invents the id at emit
 * time instead, the same message comes back under a new id on every read, and
 * the client is left comparing text, timestamps and array positions — which
 * is how one prompt ended up rendered twice in the transcript.
 *
 * Two properties are checked here, per engine, because either one failing
 * brings the guessing back:
 *
 *   1. Determinism — normalizing the same record twice yields the same id.
 *   2. Cross-path agreement — the live frame and the persisted row for one
 *      logical row carry the same id.
 *
 * cursor and opencode are out of scope for this fork; they are exercised only
 * by the determinism property, which costs nothing to hold.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AntigravitySessionsProvider } from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import {
  codexThreadItemToRows,
  readCodexAppServerItem,
  readCodexRolloutItem,
} from '@/modules/providers/list/codex/codex-thread-items.js';
import { ZCodeSessionsProvider } from '@/modules/providers/list/zcode/zcode-sessions.provider.js';
import { enforceNormalizedMessageContract } from '@/shared/normalized-message-contract.js';
import type { NormalizedMessage } from '@/shared/types.js';

const SESSION_ID = 'session-under-test';
const CODEX_TIMESTAMP = '2026-01-01T00:00:00.000Z';

// Captured from one `codex app-server` turn and the rollout it wrote.
const CODEX_LIVE_AGENT_MESSAGE = {
  type: 'agentMessage',
  id: 'msg_02c8dbf5b38a0554016ab15ce008f487d08eeca161bae5821c',
  text: '完成。',
  phase: 'final_answer',
};
const CODEX_PERSISTED_AGENT_MESSAGE = {
  type: 'AgentMessage',
  id: 'msg_02c8dbf5b38a0554016ab15ce008f487d08eeca161bae5821c',
  content: [{ type: 'Text', text: '完成。' }],
  phase: 'final_answer',
};
const CODEX_LIVE_COMMAND = {
  type: 'commandExecution',
  id: 'exec-894d4147-e8aa-4799-8578-6cc60ce7bbd0',
  command: "/bin/zsh -lc 'echo hello'",
  cwd: '/tmp/cxprobe/ws2',
  status: 'completed',
  aggregatedOutput: 'hello\n',
  exitCode: 0,
};
const CODEX_PERSISTED_COMMAND = {
  type: 'CommandExecution',
  id: 'exec-894d4147-e8aa-4799-8578-6cc60ce7bbd0',
  command: ['/bin/zsh', '-lc', 'echo hello'],
  cwd: 'file:///tmp/cxprobe/ws2',
  status: 'completed',
  stdout: 'hello\n',
  aggregated_output: 'hello\n',
  exit_code: 0,
};

/** The transcript rows one captured item produces, in emit order. */
function codexRows(item: ReturnType<typeof readCodexRolloutItem>) {
  if (!item) {
    throw new Error('a captured Codex item was not recognized by its reader');
  }
  return codexThreadItemToRows(item, CODEX_TIMESTAMP);
}

type EngineCase = {
  provider: string;
  /** Raw records the engine produces, in the shape `normalizeMessage` receives. */
  records: ReadonlyArray<{ label: string; raw: unknown }>;
  normalize: (raw: unknown) => NormalizedMessage[];
};

const claude = new ClaudeSessionsProvider();
const codex = new CodexSessionsProvider();
const antigravity = new AntigravitySessionsProvider();
const zcode = new ZCodeSessionsProvider();

const ENGINE_CASES: readonly EngineCase[] = [
  {
    provider: 'claude',
    normalize: (raw) => claude.normalizeMessage(raw, SESSION_ID),
    records: [
      {
        label: 'assistant text',
        raw: {
          uuid: 'c841b977-a3e4-49ec-8d8c-f074975abe00',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        },
      },
      {
        label: 'user prompt',
        raw: {
          uuid: '3c16ee84-e3f9-4bb1-a7b0-1a2a962c0b17',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'user', content: 'run the tests' },
        },
      },
      {
        label: 'tool call',
        raw: {
          uuid: '835dde10-32be-4af0-a703-ae6eb7e22cac',
          timestamp: '2026-01-01T00:00:02.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
          },
        },
      },
    ],
  },
  {
    provider: 'codex',
    normalize: (raw) => codex.normalizeMessage(raw, SESSION_ID),
    // Both sides are produced by the real readers from records captured off a
    // live `codex app-server` session and the rollout that same turn wrote.
    // Hand-written fixtures are what let this guard pass while the product
    // rendered every reply twice: the invented "live" frame carried a `msg_…`
    // id, and no Codex transport has ever emitted one there.
    records: [
      {
        label: 'live assistant text',
        raw: codexRows(readCodexAppServerItem(CODEX_LIVE_AGENT_MESSAGE))[0],
      },
      {
        label: 'persisted assistant text',
        raw: codexRows(readCodexRolloutItem(CODEX_PERSISTED_AGENT_MESSAGE))[0],
      },
      {
        label: 'live shell call',
        raw: codexRows(readCodexAppServerItem(CODEX_LIVE_COMMAND))[0],
      },
      {
        label: 'persisted shell call',
        raw: codexRows(readCodexRolloutItem(CODEX_PERSISTED_COMMAND))[0],
      },
    ],
  },
  {
    provider: 'antigravity',
    normalize: (raw) => antigravity.normalizeMessage(raw, SESSION_ID),
    records: [
      {
        label: 'live tool call',
        raw: {
          event: 'step_update',
          step_update: {
            step_index: 7,
            step_type: 'tool',
            state: 'ACTIVE',
            tool_name: 'run_command',
            tool_info: { parameters: { command: 'ls' } },
          },
        },
      },
      {
        label: 'live tool result',
        raw: {
          event: 'step_update',
          step_update: {
            step_index: 7,
            step_type: 'tool',
            state: 'DONE',
            tool_name: 'run_command',
            tool_info: { output: 'a.txt' },
          },
        },
      },
    ],
  },
  {
    provider: 'zcode',
    normalize: (raw) => zcode.normalizeMessage(raw, SESSION_ID),
    records: [
      {
        label: 'live assistant text',
        raw: {
          type: 'model_response',
          id: 'zcode-message-1',
          sessionId: SESSION_ID,
          payload: { text: 'hello' },
        },
      },
      {
        // The reasoning stream names the message only through the payload's
        // assistantMessageId; the envelope id is a fresh per-event UUID that
        // joins nothing and must not leak into the row id.
        label: 'live assistant reasoning',
        raw: {
          type: 'model_streaming',
          id: 'd1f2f0d4-0f6a-4a1e-9d2a-6c9f2a1b7c33',
          sessionId: SESSION_ID,
          payload: { kind: 'reasoning_delta', delta: 'thinking it through', assistantMessageId: 'zcode-message-1' },
        },
      },
    ],
  },
];

test('normalizing the same engine record twice yields the same ids', () => {
  for (const engineCase of ENGINE_CASES) {
    for (const record of engineCase.records) {
      const first = engineCase.normalize(record.raw).map((message) => message.id);
      const second = engineCase.normalize(record.raw).map((message) => message.id);
      assert.deepEqual(
        second,
        first,
        `${engineCase.provider}/${record.label}: ids changed between two reads of the same record`,
      );
    }
  }
});

test('no transcript row leaves an engine with an id invented at emit time', () => {
  for (const engineCase of ENGINE_CASES) {
    for (const record of engineCase.records) {
      for (const message of engineCase.normalize(record.raw)) {
        const checked = enforceNormalizedMessageContract(message);
        assert.ok(checked.ok, `${engineCase.provider}/${record.label}: rejected by the contract`);
        assert.deepEqual(
          checked.contractViolations,
          [],
          `${engineCase.provider}/${record.label}: ${checked.contractViolations.join('; ')}`,
        );
      }
    }
  }
});

/**
 * Antigravity reports a tool call twice: live at its own step, and in history
 * on the planner entry that declared it one step earlier. Both paths already
 * agree on `toolId`; the row id has to agree too, or the persisted card
 * renders beside the live one.
 */
test('antigravity names one tool call the same way on both paths', () => {
  const live = antigravity.normalizeMessage({
    event: 'step_update',
    step_update: {
      step_index: 8,
      step_type: 'tool',
      state: 'ACTIVE',
      tool_name: 'run_command',
      tool_info: { parameters: { command: 'ls' } },
    },
  }, SESSION_ID).find((message) => message.kind === 'tool_use');

  assert.ok(live, 'the live event produces a tool_use row');
  assert.equal(live.toolId, 'tool_8');
  assert.equal(
    live.id,
    `msg_${SESSION_ID}_tool_8`,
    'the live row id is derived from the call identity both paths compute',
  );
});

/**
 * ZCode names a persisted row `(message_id, part_id)` but its live stream
 * only mentions the message: assistant text arrives as `text_delta` events
 * carrying `assistantMessageId`, while the event envelope's `id` is a random
 * UUID minted per event and joins nothing. The message id is what both sides
 * carry, and it is published as the row key so the client reconciles the
 * streamed reply with the persisted one by identity rather than by comparing
 * the text of the two.
 */
test('zcode publishes one row key for a reply on both paths', () => {
  const messageId = 'msg_muaj6bc0_a3536698';
  const live = zcode.normalizeMessage({
    type: 'model_streaming',
    id: 'd1f2f0d4-0f6a-4a1e-9d2a-6c9f2a1b7c33',
    sessionId: SESSION_ID,
    payload: { kind: 'text_delta', delta: 'the answer', assistantMessageId: messageId },
  }, SESSION_ID);

  assert.equal(live.length, 1);
  assert.equal(live[0].kind, 'stream_delta');
  assert.equal(live[0].providerRowKey, `zcode-message:${messageId}`);
});

/**
 * Codex reports one item twice: live over `app-server`, and again in the
 * rollout a history read parses. Both carry Codex's own item id, and both are
 * read into rows by the same renderer, so the ids must match exactly — that
 * agreement is the only thing standing between the user and two copies of
 * every reply.
 */
test('codex names one item the same way live and from history', () => {
  const pairs = [
    ['assistant text', CODEX_LIVE_AGENT_MESSAGE, CODEX_PERSISTED_AGENT_MESSAGE],
    ['shell call', CODEX_LIVE_COMMAND, CODEX_PERSISTED_COMMAND],
  ] as const;

  for (const [label, liveItem, persistedItem] of pairs) {
    const live = codexRows(readCodexAppServerItem(liveItem))
      .flatMap((row) => codex.normalizeMessage(row, SESSION_ID))
      .map((message) => message.id);
    const persisted = codexRows(readCodexRolloutItem(persistedItem))
      .flatMap((row) => codex.normalizeMessage(row, SESSION_ID))
      .map((message) => message.id);

    assert.ok(live.length > 0, `${label}: the live item produced no rows`);
    assert.deepEqual(persisted, live, `${label}: the two transports name the same row differently`);
  }
});
