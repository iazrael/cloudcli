import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { codexThreadItemToRows, readCodexRolloutItem } from '@/modules/providers/list/codex/codex-thread-items.js';
import { CursorSessionsProvider } from '@/modules/providers/list/cursor/cursor-sessions.provider.js';
import { appendFilesInputTag, appendImagesInputTag } from '@/shared/image-attachments.js';

const SESSION_ID = 'session-1';
const originalHome = os.homedir;
let fixtureHome: string;
test.beforeEach(async () => { fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'attachment-history-')); os.homedir = () => fixtureHome; });
test.afterEach(async () => { os.homedir = originalHome; await rm(fixtureHome, { recursive: true, force: true }); });
const storedImage = (base64: string, extension: string) => `/api/assets/images/inline-${createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')}.${extension}`;


// ---------------------------------------------------------------- Claude

test('claude history: base64 image blocks surface as user message images', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this screenshot?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'REVG' } },
      ],
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'What is in this screenshot?');
  assert.deepEqual(messages[0].images, [
    { path: storedImage('QUJD', 'png') },
    { path: storedImage('REVG', 'jpg') },
  ]);
});

test('claude history: image-only user turns still produce a bubble', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      ],
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '');
  assert.deepEqual(messages[0].images, [{ path: storedImage('QUJD', 'png') }]);
});

test('claude history: plain text user turns carry no images field', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    type: 'user',
    uuid: 'u3',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].images, undefined);
});

test('claude history: file reference blocks restore non-image attachments', () => {
  const provider = new ClaudeSessionsProvider();
  const entry = {
    type: 'user',
    uuid: 'u4',
    timestamp: '2026-07-03T10:00:00.000Z',
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: appendFilesInputTag('Summarize this', [
          { path: 'C:/Users/x/.cloudcli/assets/brief.pdf', name: 'brief.pdf' },
        ]),
      }],
    },
  };

  const messages = provider.normalizeMessage(entry, SESSION_ID);
  assert.equal(messages[0].content, 'Summarize this');
  assert.deepEqual(messages[0].files, [
    { path: 'C:/Users/x/.cloudcli/assets/brief.pdf', name: 'brief.pdf' },
  ]);
});

// ---------------------------------------------------------------- Codex

/** The images one `UserMessage` item carries, as the transcript row records them. */
const codexPromptImages = (item: unknown) => {
  const parsed = readCodexRolloutItem(item);
  assert.ok(parsed);
  return codexThreadItemToRows(parsed, '2026-01-01T00:00:00.000Z')[0]?.images;
};

test('codex history: local_image content parts become path attachments', () => {
  // Captured from a real rollout: an attached screenshot rides the prompt as
  // a `local_image` content part.
  assert.deepEqual(
    codexPromptImages({
      type: 'UserMessage',
      id: '01a0a182-00f5-7451-9616-9cbd8599cc80',
      content: [
        { type: 'local_image', path: 'C:\\proj\\.cloudcli\\assets\\a.png' },
        { type: 'text', text: 'can u see attached image?', text_elements: [] },
      ],
    }),
    [{ path: 'C:/proj/.cloudcli/assets/a.png' }],
  );
  assert.equal(
    codexPromptImages({
      type: 'UserMessage',
      id: 'u-plain',
      content: [{ type: 'text', text: 'hi', text_elements: [] }],
    }),
    undefined,
  );
});

test('codex history: base64 data URLs become stored image attachments', () => {
  const dataUrl = 'data:image/png;base64,QUJD';
  assert.deepEqual(
    codexPromptImages({
      type: 'UserMessage',
      id: 'u-data',
      content: [
        { type: 'local_image', path: 'C:\\proj\\a.png' },
        { type: 'image', url: dataUrl },
        { type: 'text', text: 'look', text_elements: [] },
      ],
    }),
    [{ path: 'C:/proj/a.png' }, { path: storedImage('QUJD', 'png') }],
  );
});

test('codex history: rollout spelling image_url becomes a stored image attachment', () => {
  // Captured from a real rollout: the assembled UserMessage item spells the
  // data URL `image_url`, while the app-server's live item spells it `url`.
  // Both serializations must read back, or the transcript loses the prompt's
  // images the moment history takes over.
  const dataUrl = 'data:image/png;base64,QUJD';
  assert.deepEqual(
    codexPromptImages({
      type: 'UserMessage',
      id: 'u-rollout',
      content: [
        { type: 'text', text: 'look', text_elements: [] },
        { type: 'image', image_url: dataUrl },
      ],
    }),
    [{ path: storedImage('QUJD', 'png') }],
  );
});

test('codex history: normalized user entries keep their images', () => {
  const provider = new CodexSessionsProvider();
  const messages = provider.normalizeMessage(
    {
      timestamp: '2026-07-03T10:00:00.000Z',
      message: { role: 'user', content: 'Look at this' },
      images: [{ path: '.cloudcli/assets/a.png' }],
    },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Look at this');
  assert.deepEqual(messages[0].images, [{ path: '.cloudcli/assets/a.png' }]);
});

test('codex history: normalized user entries restore file reference blocks', () => {
  const provider = new CodexSessionsProvider();
  const messages = provider.normalizeMessage(
    {
      timestamp: '2026-07-03T10:00:00.000Z',
      message: {
        role: 'user',
        content: appendFilesInputTag('Review this', [
          { path: 'C:/Users/x/.cloudcli/assets/spec.docx', name: 'spec.docx' },
        ]),
      },
    },
    SESSION_ID,
  );

  assert.equal(messages[0].content, 'Review this');
  assert.deepEqual(messages[0].files, [
    { path: 'C:/Users/x/.cloudcli/assets/spec.docx', name: 'spec.docx' },
  ]);
});

// ---------------------------------------------------------------- Cursor

test('cursor history: <images_input> inside user_query is stripped and attached', () => {
  const provider = new CursorSessionsProvider();
  const taggedPrompt = appendImagesInputTag('Fix the layout bug', [{ path: '.cloudcli/assets/shot.png' }]);
  const blobs = [
    {
      id: 'blob1',
      sequence: 1,
      rowid: 1,
      content: {
        role: 'user',
        content: `<timestamp>2026-07-03</timestamp>\n<user_query>${taggedPrompt}</user_query>`,
      },
    },
    {
      id: 'blob2',
      sequence: 2,
      rowid: 2,
      content: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done — the flex container was wrong.' }],
      },
    },
  ];

  const messages = provider.normalizeCursorBlobs(blobs, SESSION_ID);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Fix the layout bug');
  assert.deepEqual(messages[0].images, [{ path: '.cloudcli/assets/shot.png' }]);
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].images, undefined);
});

test('cursor history: user text without a tag keeps existing behavior', () => {
  const provider = new CursorSessionsProvider();
  const blobs = [
    {
      id: 'blob1',
      sequence: 1,
      rowid: 1,
      content: {
        role: 'user',
        content: '<timestamp>2026-07-03</timestamp>\n<user_query>plain question</user_query>',
      },
    },
  ];

  const messages = provider.normalizeCursorBlobs(blobs, SESSION_ID);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'plain question');
  assert.equal(messages[0].images, undefined);
});

test('cursor history: file reference blocks are stripped and attached', () => {
  const provider = new CursorSessionsProvider();
  const taggedPrompt = appendFilesInputTag('Check the data', [
    { path: 'C:/Users/x/.cloudcli/assets/data.csv', name: 'data.csv' },
  ]);
  const messages = provider.normalizeCursorBlobs([
    {
      id: 'blob-file',
      sequence: 1,
      rowid: 1,
      content: {
        role: 'user',
        content: `<user_query>${taggedPrompt}</user_query>`,
      },
    },
  ], SESSION_ID);

  assert.equal(messages[0].content, 'Check the data');
  assert.deepEqual(messages[0].files, [
    { path: 'C:/Users/x/.cloudcli/assets/data.csv', name: 'data.csv' },
  ]);
});
