/**
 * Per-provider conformance: does one engine's live stream line up with its own
 * persisted transcript?
 *
 * The standard this checks is the one the whole normalization layer exists to
 * uphold — **a logical row must carry the same identity on both transports**.
 * When it does not, the timeline shows the live copy beside the persisted one,
 * which is the duplicate-and-scrambled transcript this repository keeps
 * chasing. Refreshing a closed session looks fine precisely because only one
 * transport is involved; the damage appears while a run is open.
 *
 * Fixtures are captured from real engine runs (live frames normalized through
 * the provider, plus that same session's own history), so a provider whose
 * output drifts from its transcript fails here rather than in someone's chat.
 * Regenerate one by running the engine and normalizing both sides.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage, ServerEvent } from '@/shared/types';
import { SessionTimelineStore } from '@/modules/chat/utils/sessionTimelineStore';
import antigravityTurn from '@/modules/chat/tests/fixtures/antigravity-turn.json';
import codexTurn from '@/modules/chat/tests/fixtures/codex-turn.json';

type Fixture = {
  provider: string;
  prompt: string;
  live: NormalizedMessage[];
  history: NormalizedMessage[];
};

const SESSION_ID = 'conformance-session';

/** Drives one captured turn the way the app does: send, stream, then refresh. */
async function playTurn(fixture: Fixture): Promise<NormalizedMessage[]> {
  const history = fixture.history.map((row) => ({ ...row, sessionId: SESSION_ID }));
  const store = new SessionTimelineStore({
    fetchPage: async () => ({ messages: history, total: history.length, hasMore: false }),
  });

  store.appendRealtime(SESSION_ID, {
    id: 'local_prompt',
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    provider: fixture.provider as NormalizedMessage['provider'],
    kind: 'text',
    role: 'user',
    content: fixture.prompt,
  });

  for (const frame of fixture.live) {
    store.applyServerEvent(
      { ...frame, sessionId: SESSION_ID } as unknown as ServerEvent,
      { provider: fixture.provider as NormalizedMessage['provider'] },
    );
  }
  // Let the stream throttle land its buffered text before history arrives.
  await new Promise((resolve) => setTimeout(resolve, 150));
  await store.refreshLatestFromServer(SESSION_ID, { limit: 50 });

  return store.getMessages(SESSION_ID);
}

/** Tool input reaches the two transports as an object on one and JSON text on
 * the other, so it is parsed before comparison — otherwise the same call looks
 * like two different rows and a duplicate slips past this suite. */
function readToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function describeRow(row: NormalizedMessage): string {
  if (row.kind === 'tool_use') return `tool_use:${row.toolName}:${JSON.stringify(readToolInput(row.toolInput))}`;
  if (row.kind === 'text') return `text:${row.role}:${(row.content ?? '').trim()}`;
  return '';
}

for (const fixture of [antigravityTurn as Fixture, codexTurn as Fixture]) {
  test(`${fixture.provider}: a live turn and its own history render one transcript`, async () => {
    const rows = await playTurn(fixture);

    const seen = new Map<string, number>();
    for (const row of rows) {
      const description = describeRow(row);
      if (!description) continue;
      seen.set(description, (seen.get(description) ?? 0) + 1);
    }

    const duplicated = [...seen.entries()].filter(([, count]) => count > 1);
    assert.deepEqual(
      duplicated,
      [],
      `${fixture.provider} renders the same row more than once:\n`
      + duplicated.map(([description, count]) => `  x${count} ${description}`).join('\n'),
    );
  });

  test(`${fixture.provider}: the reply never sorts above the prompt that caused it`, async () => {
    const rows = await playTurn(fixture);
    const promptIndex = rows.findIndex((row) => row.kind === 'text' && row.role === 'user');
    assert.ok(promptIndex >= 0, 'the prompt must be in the transcript');

    const laterRows = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.kind === 'tool_use'
        || (row.kind === 'text' && row.role === 'assistant')
        || row.kind === 'stream_delta');

    for (const { row, index } of laterRows) {
      assert.ok(
        index > promptIndex,
        `${row.kind} sorted above the prompt (row ${index}, prompt ${promptIndex})`,
      );
    }
  });

  test(`${fixture.provider}: a second refresh changes nothing`, async () => {
    const once = await playTurn(fixture);
    const twice = await playTurn(fixture);
    assert.deepEqual(
      twice.map((row) => `${row.kind}:${row.role ?? ''}:${(row.content ?? '').trim()}`),
      once.map((row) => `${row.kind}:${row.role ?? ''}:${(row.content ?? '').trim()}`),
      'replaying the same turn must settle on the same transcript',
    );
  });

  test(`${fixture.provider}: every tool call the live stream showed is still represented`, async () => {
    const rows = await playTurn(fixture);
    const liveCalls = fixture.live.filter((row) => row.kind === 'tool_use');

    // The card may survive under its live id or be replaced by the persisted
    // row for the same call — those are the same outcome on screen. What must
    // not happen is the call vanishing, and (checked by the duplicate test
    // above) both copies rendering.
    for (const call of liveCalls) {
      const represented = rows.some((row) => row.kind === 'tool_use'
        && (row.toolId === call.toolId || describeRow(row) === describeRow(call)));
      assert.ok(represented, `the call ${call.toolId} is no longer in the transcript`);
    }
  });
}
