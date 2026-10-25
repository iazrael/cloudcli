import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { sessionsService } from '@/modules/providers/index.js';
import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderSessionIdReplacement,
} from '@/shared/types.js';

/**
 * Editing the first prompt of a Claude conversation makes the SDK start a
 * brand-new session (`resumeFromScratch` omits `resume`). The runtime must
 * notice that the id in the stream replaces the one the session row still
 * holds, and tell the gateway which transcript the conversation moved to —
 * otherwise the row keeps pointing at the old transcript while the new one is
 * indexed as a second sidebar session.
 */

const APP_SESSION_ID = 'first-prompt-edit-app';
const OLD_PROVIDER_SESSION_ID = 'first-prompt-edit-old';
const NEW_PROVIDER_SESSION_ID = 'first-prompt-edit-new';

type Announcement = {
  sessionId: string;
  replacement?: ProviderSessionIdReplacement;
};

/** Drives one scripted SDK stream and returns what the runtime sent/announced. */
async function runScripted(options: {
  appSessionId: string;
  providerSessionId: string | null;
  transcriptPath: string | null;
  resumeFromScratch?: boolean;
  streamSessionId: string;
}): Promise<{ sent: NormalizedMessage[]; announcements: Announcement[] }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-first-prompt-edit-'));
  const sent: NormalizedMessage[] = [];
  const announcements: Announcement[] = [];
  const writer = {
    send: (message: NormalizedMessage) => { sent.push(message); },
    setSessionId: (sessionId: string, replacement?: ProviderSessionIdReplacement) => {
      announcements.push(replacement ? { sessionId, replacement } : { sessionId });
    },
    userId: null,
  };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const stream = [
    { type: 'system', subtype: 'init', session_id: options.streamSessionId },
    {
      type: 'assistant',
      session_id: options.streamSessionId,
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'the new answer' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: 'result',
      subtype: 'success',
      session_id: options.streamSessionId,
      result: 'ok',
      duration_ms: 1,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => options.providerSessionId,
    resolveTranscriptPath: () => options.transcriptPath,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: ({ prompt }) => {
      // Drain the held prompt like the CLI would read its stdin.
      void (async () => { for await (const _message of prompt) { /* read */ } })();
      const iterator = (async function* () { yield* stream; })();
      return Object.assign(iterator, { interrupt: async () => {} }) as never;
    },
  };

  try {
    await queryClaudeSDK(
      'a better first prompt',
      {
        sessionId: options.appSessionId,
        cwd,
        ...(options.resumeFromScratch ? { resumeFromScratch: true } : {}),
      },
      writer as never,
      context,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  return { sent, announcements };
}

test('an edited first prompt announces the replacement session and its transcript', async () => {
  const transcriptPath = path.join(os.tmpdir(), `${OLD_PROVIDER_SESSION_ID}.jsonl`);
  const { sent, announcements } = await runScripted({
    appSessionId: APP_SESSION_ID,
    providerSessionId: OLD_PROVIDER_SESSION_ID,
    transcriptPath,
    resumeFromScratch: true,
    streamSessionId: NEW_PROVIDER_SESSION_ID,
  });

  // The replacement is not a first-time mapping: the gateway has to move the
  // row's provider_session_id *and* jsonl_path, deriving the new transcript
  // beside the one the conversation is leaving.
  assert.deepEqual(announcements, [{
    sessionId: NEW_PROVIDER_SESSION_ID,
    replacement: {
      transcriptPath: path.join(path.dirname(transcriptPath), `${NEW_PROVIDER_SESSION_ID}.jsonl`),
    },
  }]);

  // Everything after the capture belongs to the new provider session.
  const answer = sent.find((message) => message.kind === 'text' && message.role === 'assistant');
  assert.ok(answer, 'the new answer is streamed');
});

test('an ordinary resume never mistakes a different stream id for a replacement', async () => {
  const transcriptPath = path.join(os.tmpdir(), `${OLD_PROVIDER_SESSION_ID}.jsonl`);
  const { announcements } = await runScripted({
    appSessionId: `${APP_SESSION_ID}-resume`,
    providerSessionId: OLD_PROVIDER_SESSION_ID,
    transcriptPath,
    streamSessionId: NEW_PROVIDER_SESSION_ID,
  });

  assert.deepEqual(announcements, [], 'a resumed run keeps the session it resumed');
});

test('a brand-new session announces its id without a replacement descriptor', async () => {
  const { announcements } = await runScripted({
    appSessionId: `${APP_SESSION_ID}-new`,
    providerSessionId: null,
    transcriptPath: null,
    streamSessionId: NEW_PROVIDER_SESSION_ID,
  });

  assert.deepEqual(announcements, [{ sessionId: NEW_PROVIDER_SESSION_ID }]);
});

test('history reads the replacement transcript after the row is repointed', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-first-prompt-edit-history-'));
  const oldProviderSessionId = 'history-old';
  const newProviderSessionId = 'history-new';
  const appSessionId = 'history-app';
  const oldTranscriptPath = path.join(tempDirectory, `${oldProviderSessionId}.jsonl`);
  const newTranscriptPath = path.join(tempDirectory, `${newProviderSessionId}.jsonl`);

  const transcriptRow = (uuid: string, providerSessionId: string, role: 'user' | 'assistant', text: string) => ({
    type: role,
    uuid,
    parentUuid: null,
    sessionId: providerSessionId,
    timestamp: '2026-08-23T12:00:00.000Z',
    message: { role, model: role === 'assistant' ? 'claude-opus-5' : undefined, content: [{ type: 'text', text }] },
  });
  await writeFile(
    oldTranscriptPath,
    `${[
      transcriptRow('old-u1', oldProviderSessionId, 'user', 'the original prompt'),
      transcriptRow('old-a1', oldProviderSessionId, 'assistant', 'the original answer'),
    ].map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
  await writeFile(
    newTranscriptPath,
    `${[
      transcriptRow('new-u1', newProviderSessionId, 'user', 'the edited prompt'),
      transcriptRow('new-a1', newProviderSessionId, 'assistant', 'the replacement answer'),
    ].map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  try {
    const now = new Date().toISOString();
    sessionsDb.createAppSession(appSessionId, 'claude', tempDirectory, 'Edited first prompt');
    sessionsDb.assignProviderSessionId(appSessionId, oldProviderSessionId);
    sessionsDb.createSession(
      oldProviderSessionId,
      'claude',
      tempDirectory,
      'Edited first prompt',
      now,
      now,
      oldTranscriptPath,
    );

    sessionsDb.repointSessionToProviderSession(appSessionId, {
      providerSessionId: newProviderSessionId,
      jsonlPath: newTranscriptPath,
      supersedePrevious: true,
    });

    // The messages endpoint resolves the row's jsonl_path, so it must return the
    // conversation the user actually sees after the edit.
    const history = await sessionsService.fetchHistory(appSessionId);
    const contents = history.messages
      .map((message) => message.content)
      .filter((content): content is string => typeof content === 'string');
    assert.ok(contents.includes('the edited prompt'), 'the replacement prompt is readable');
    assert.ok(contents.includes('the replacement answer'), 'the replacement answer is readable');
    assert.ok(!contents.includes('the original prompt'), 'the superseded transcript is no longer read');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
