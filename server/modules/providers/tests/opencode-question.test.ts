import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { toQuestionCardInput } from '@/modules/providers/list/opencode/opencode-question.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import { toClientToolName } from '@/modules/providers/list/opencode/opencode-subagent.js';

// opencode's `question` call as 1.18 persists it: Claude's question shape, but
// multi-select is spelled `multiple` and the picks live in `state.metadata`.
const questionInput = {
  questions: [
    {
      header: '命名与形态',
      question: '这份图今后按哪种形态维护？',
      options: [{ label: '日期快照', description: 'a' }, { label: '活文档单文件', description: 'b' }],
    },
    {
      header: '一起入库的内容',
      question: '哪些一起放进 reviews/？',
      multiple: true,
      options: [{ label: 'README.md', description: 'c' }, { label: 'spec JSON', description: 'd' }],
    },
  ],
};

test('the question tool reaches the client as the shared AskUserQuestion card', () => {
  assert.equal(toClientToolName('question'), 'AskUserQuestion');
  assert.equal(toClientToolName('subagent'), 'Agent');
  assert.equal(toClientToolName('read'), 'read');
});

test('question input maps multiple onto multiSelect and folds the picks in by question text', () => {
  const card = toQuestionCardInput(questionInput, { answers: [['活文档单文件'], ['README.md', 'spec JSON']] }) as any;

  assert.equal(card.questions[0].multiSelect, undefined);
  assert.equal(card.questions[1].multiSelect, true);
  assert.equal('multiple' in card.questions[1], false);
  assert.deepEqual(card.answers, {
    '这份图今后按哪种形态维护？': '活文档单文件',
    '哪些一起放进 reviews/？': 'README.md, spec JSON',
  });
});

test('an unanswered question carries no answers, and malformed input passes through', () => {
  const pending = toQuestionCardInput(questionInput, undefined) as any;
  assert.equal('answers' in pending, false);
  assert.equal(pending.questions.length, 2);

  const partly = toQuestionCardInput(questionInput, { answers: [[], ['spec JSON']] }) as any;
  assert.deepEqual(partly.answers, { '哪些一起放进 reviews/？': 'spec JSON' });

  assert.equal(toQuestionCardInput('not json', {}), 'not json');
  assert.deepEqual(toQuestionCardInput({ foo: 1 }, {}), { foo: 1 });
});

test('v2 history draws an answered opencode question as an AskUserQuestion card', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-question-'));
  const originalHomedir = os.homedir;
  (os as any).homedir = () => tempRoot;

  try {
    const dataDir = path.join(tempRoot, '.local', 'share', 'opencode');
    await mkdir(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'opencode.db'));
    try {
      db.exec(`
        CREATE TABLE session_v2 (
          id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL,
          title text, version text NOT NULL,
          tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
          tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
          tokens_cache_write integer DEFAULT 0 NOT NULL,
          time_created integer NOT NULL, time_updated integer NOT NULL
        );
        CREATE TABLE session_message (
          id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
          time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
        );
        INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('ses_q', 'proj_1', 'q', '/tmp/proj', 'Q', '2.0.31', 1000, 2000);
      `);
      db.prepare("INSERT INTO session_message VALUES ('msg_a', 'ses_q', 'assistant', 1, 1100, 1200, ?)").run(JSON.stringify({
        time: { created: 1100 },
        content: [{
          type: 'tool',
          id: 'call_q',
          name: 'question',
          state: {
            status: 'completed',
            input: questionInput,
            content: [{ type: 'text', text: 'User has answered your questions.' }],
            metadata: { answers: [['日期快照'], ['README.md']] },
          },
        }],
      }));
    } finally {
      db.close();
    }

    const history = await new OpenCodeSessionsProvider().fetchHistory('ses_q');
    const row = history.messages.find((message) => message.kind === 'tool_use') as any;

    assert.equal(row?.toolName, 'AskUserQuestion');
    assert.equal(row?.toolInput.questions[1].multiSelect, true);
    assert.deepEqual(row?.toolInput.answers, {
      '这份图今后按哪种形态维护？': '日期快照',
      '哪些一起放进 reviews/？': 'README.md',
    });
  } finally {
    (os as any).homedir = originalHomedir;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
