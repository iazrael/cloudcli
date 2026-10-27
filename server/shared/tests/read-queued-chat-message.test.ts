import assert from 'node:assert/strict';
import test from 'node:test';

import { readQueuedChatMessage } from '../utils.js';
test('queue reader rejects empty or invalid values and normalizes legacy attachments and options', () => {
  for (const value of [null, 3, [], 'text', {}, { content: '  ' }]) assert.equal(readQueuedChatMessage(value), null);
  assert.deepEqual(readQueuedChatMessage({ content: ' A ', images: ['old'], options: { model: 'x' } }), { content: ' A ', attachments: ['old'], options: { model: 'x' } });
  assert.deepEqual(readQueuedChatMessage({ images: ['old'], attachments: ['new'], options: [] }), { content: '', attachments: ['new'] });
});
