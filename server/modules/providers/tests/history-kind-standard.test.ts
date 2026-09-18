/**
 * A stored transcript may only contain transcript rows.
 *
 * Several `MessageKind` values describe a run in flight rather than something
 * said: `complete` terminates a run and there is exactly one per run,
 * `stream_delta` / `stream_end` are the text of a reply still arriving, and
 * `session_created` announces an id the backend swallows. None of them can
 * occur in history, where there is no run and the reply has already arrived.
 *
 * zcode used to emit one `complete` per persisted step: about a third of a
 * real session's rows, none of which render anything. They still counted for
 * pagination, for every scan that walks the transcript, and for the row counts
 * the client records when it sends — so a page of fifty rows could show a
 * handful of messages.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { MessageKind } from '@/shared/types.js';

/** Kinds that describe a live run and can only be emitted while one exists. */
const LIVE_ONLY_KINDS: readonly MessageKind[] = [
  'complete',
  'stream_delta',
  'stream_end',
  'session_created',
];

/**
 * Where each provider turns its stored transcript into rows. Reading the
 * source is deliberate: these paths pull from files and databases this test
 * cannot supply, while the rule being checked is a property of the code.
 * cursor and opencode are out of scope for this fork.
 */
const HISTORY_SOURCES: ReadonlyArray<{ provider: string; file: string; historyFunctions: readonly string[] }> = [
  { provider: 'zcode', file: 'zcode/zcode-sessions.provider.ts', historyFunctions: ['normalizeHistoryRows'] },
  { provider: 'antigravity', file: 'antigravity/antigravity-sessions.provider.ts', historyFunctions: ['fetchHistory'] },
  { provider: 'codex', file: 'codex/codex-sessions.provider.ts', historyFunctions: ['getCodexSessionMessages'] },
  { provider: 'claude', file: 'claude/claude-sessions.provider.ts', historyFunctions: ['fetchHistory'] },
];

/** The body of one function, from its declaration to the matching brace. */
function readFunctionBody(source: string, functionName: string): string | null {
  const start = source.search(new RegExp(`(async\\s+)?(function\\s+)?${functionName}\\s*\\(`));
  if (start < 0) {
    return null;
  }
  const open = source.indexOf('{', start);
  if (open < 0) {
    return null;
  }
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

for (const { provider, file, historyFunctions } of HISTORY_SOURCES) {
  test(`${provider} history emits no live-only message kinds`, async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const source = await readFile(
      path.join(process.cwd(), 'server/modules/providers/list', file),
      'utf8',
    );

    for (const functionName of historyFunctions) {
      const body = readFunctionBody(source, functionName);
      assert.ok(body, `${provider}: could not read ${functionName}`);

      for (const kind of LIVE_ONLY_KINDS) {
        assert.equal(
          body.includes(`kind: '${kind}'`),
          false,
          `${provider}'s ${functionName} emits '${kind}', which only exists while a run is in flight`,
        );
      }
    }
  });
}
