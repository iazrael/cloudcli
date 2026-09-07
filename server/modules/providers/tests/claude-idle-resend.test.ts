import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isTaskNotificationUserMessage,
  shouldResendPromptForIdleTurn,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';

test('a string-content user frame starting with the notification tag is detected', () => {
  // Shape the CLI injects on resume when a background task has no completion
  // record: a user message whose whole text is the <task-notification> block.
  assert.equal(
    isTaskNotificationUserMessage({
      type: 'user',
      message: { role: 'user', content: '<task-notification>\n<task-id>buw1q44ky</task-id>\n</task-notification>' },
    }),
    true,
  );
});

test('an array-content user frame with a leading notification tag is detected', () => {
  assert.equal(
    isTaskNotificationUserMessage({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '<task-notification> stopped' }] },
    }),
    true,
  );
});

test('regular user frames and tool-result frames are not notifications', () => {
  assert.equal(
    isTaskNotificationUserMessage({ type: 'user', message: { role: 'user', content: '开工' } }),
    false,
  );
  assert.equal(
    isTaskNotificationUserMessage({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    }),
    false,
  );
  assert.equal(
    isTaskNotificationUserMessage({ type: 'assistant', message: { role: 'assistant', content: '<task-notification>' } }),
    false,
  );
});

test('the placeholder matches with and without period or markdown emphasis', () => {
  const signals = (assistantText: string) => ({
    hasPrompt: true,
    sawTaskNotification: true,
    assistantText,
    toolUseCount: 0,
  });

  assert.equal(shouldResendPromptForIdleTurn(signals('No response requested.')), true);
  assert.equal(shouldResendPromptForIdleTurn(signals('no response requested')), true);
  assert.equal(shouldResendPromptForIdleTurn(signals('*No response requested.*')), true);
  // Any other content means the turn said something real.
  assert.equal(shouldResendPromptForIdleTurn(signals('开工 M1。先确认格子像素常量。')), false);
});

test('a resend requires a prompt, a notification, and a tool-free turn', () => {
  // Without a notification in the turn, a placeholder-like reply can be a
  // legitimate answer (e.g. the user said "don't reply").
  assert.equal(
    shouldResendPromptForIdleTurn({
      hasPrompt: true,
      sawTaskNotification: false,
      assistantText: 'No response requested.',
      toolUseCount: 0,
    }),
    false,
  );

  // With tool calls the turn acted on something.
  assert.equal(
    shouldResendPromptForIdleTurn({
      hasPrompt: true,
      sawTaskNotification: true,
      assistantText: 'No response requested.',
      toolUseCount: 2,
    }),
    false,
  );

  // No prompt to resend.
  assert.equal(
    shouldResendPromptForIdleTurn({
      hasPrompt: false,
      sawTaskNotification: true,
      assistantText: 'No response requested.',
      toolUseCount: 0,
    }),
    false,
  );
});
