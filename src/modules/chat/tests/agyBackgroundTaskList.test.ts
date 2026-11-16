import assert from 'node:assert/strict';

import { test } from 'vitest';

import { parseAgyBackgroundTaskList } from '@/modules/chat/tools/utils/agyBackgroundTasks';
import { shouldHideToolResult } from '@/modules/chat/tools/configs/toolConfigs';

/**
 * agy's `manage_task` Action=list answers arrive as a `Created At/Completed At`
 * receipt header followed by either a compact JSON array or one pretty-printed
 * object per running task; an idle session answers with a plain sentence. All
 * four shapes below were captured verbatim from local engine transcripts.
 */
test('parses the compact-array answer with its receipt header', () => {
  const content = [
    'Created At: 2026-11-16T00:55:35+08:00',
    'Completed At: 2026-11-16T00:55:36+08:00',
    'You have 1 background task(s) currently running:',
    '[{"taskId":"fa6c6012/task-3148","toolName":"run_command","toolSummary":"Run prep-sprites.mjs and render 18-tower comparison grid","description":"node scripts/prep-sprites.mjs && python3 - <<\'PY\'","startTime":"2026-11-15T16:57:55Z","logUri":"file:///tmp/task-3148.log"}]',
  ].join('\n');

  const parsed = parseAgyBackgroundTaskList(content);
  assert.equal(parsed?.kind, 'tasks');
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0].taskId, 'fa6c6012/task-3148');
  assert.equal(parsed.tasks[0].summary, 'Run prep-sprites.mjs and render 18-tower comparison grid');
  assert.equal(parsed.tasks[0].description, "node scripts/prep-sprites.mjs && python3 - <<'PY'");
});

test('parses the pretty-printed one-object-per-line answer', () => {
  const content = [
    'Created At: 2026-10-07T19:45:34+08:00',
    'Completed At: 2026-10-07T19:45:34+08:00',
    'You have 3 background task(s) currently running:',
    '{',
    '  "taskId": "8c3abaae/task-12",',
    '  "toolName": "run_command",',
    '  "toolSummary": "Search for GetHomePoint in research",',
    '  "description": "grep -rn \\"GetHomePoint\\" research/",',
    '  "startTime": "2026-10-07T11:44:29.226863Z",',
    '  "stepIndex": 12,',
    '  "logUri": "file:///tmp/task-12.log"',
    '}',
    '{',
    '  "taskId": "8c3abaae/task-22",',
    '  "toolName": "run_command",',
    '  "toolSummary": "Search homeMap and tickHomeAnchor",',
    '  "description": "grep -rn \\"tickHomeAnchor\\" packages/ apps/",',
    '  "startTime": "2026-10-07T11:44:50.519155Z",',
    '  "logUri": "file:///tmp/task-22.log"',
    '}',
  ].join('\n');

  const parsed = parseAgyBackgroundTaskList(content);
  assert.equal(parsed?.kind, 'tasks');
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0].summary, 'Search for GetHomePoint in research');
  assert.equal(parsed.tasks[1].taskId, '8c3abaae/task-22');
});

test('recognizes the idle answer as empty', () => {
  const parsed = parseAgyBackgroundTaskList('Created At: 2026-10-18T21:39:04+08:00\nCompleted At: 2026-10-18T21:39:04+08:00\nNo background tasks are currently running.');
  assert.equal(parsed?.kind, 'empty');
});

test('parses a bare array with no receipt header', () => {
  const parsed = parseAgyBackgroundTaskList('[{"taskId":"t/1","toolName":"run_command"}]');
  assert.equal(parsed?.kind, 'tasks');
  // toolSummary missing → falls back to the description, then the taskId.
  assert.equal(parsed.tasks[0].summary, 't/1');
});

test('falls back to raw text when the marker is there but nothing parses', () => {
  const content = 'You have 1 background task(s) currently running:\n<not json>';
  const parsed = parseAgyBackgroundTaskList(content);
  assert.equal(parsed?.kind, 'raw');
  assert.equal(parsed.text, content);
});

test('repairs raw control characters the engine leaves inside JSON strings', () => {
  // Captured from engine transcript fa6c6012 step 1115: the description's
  // real newlines are written unescaped inside the JSON string literal.
  const content = [
    'You have 1 background task(s) currently running:',
    '[{"taskId":"fa6c6012/task-1105","toolName":"run_command","toolSummary":"Generate remaining 6 graveyard masters","description":"python3.14 -c \'\nimport subprocess, time\nprint(1)\'","startTime":"2026-11-15T06:33:35Z"}]',
  ].join('\n');

  const parsed = parseAgyBackgroundTaskList(content);
  assert.equal(parsed?.kind, 'tasks');
  assert.equal(parsed.tasks[0].taskId, 'fa6c6012/task-1105');
  assert.equal(parsed.tasks[0].description, "python3.14 -c '\nimport subprocess, time\nprint(1)'");
});

test('returns null for content that is not a background-task answer', () => {
  assert.equal(parseAgyBackgroundTaskList('Command exited with code 1.'), null);
  assert.equal(parseAgyBackgroundTaskList(''), null);
});

test('shouldHideToolResult admits manage_task Action=list and keeps others suppressed', () => {
  const success = { content: 'You have 1 background task(s) currently running:\n[]', isError: false };
  assert.equal(shouldHideToolResult('manage_task', success, { Action: 'list' }), false);
  assert.equal(shouldHideToolResult('manage_task', success, '{"Action":"list"}'), false);
  assert.equal(shouldHideToolResult('manage_task', success, { Action: 'status' }), true);
  // No input → the predicate cannot name list, so the old hide-on-success holds.
  assert.equal(shouldHideToolResult('manage_task', success), true);
  // Errors are always visible, whatever the action.
  assert.equal(shouldHideToolResult('manage_task', { content: 'boom', isError: true }, { Action: 'status' }), false);
  // Static hideOnSuccess configs are untouched.
  assert.equal(shouldHideToolResult('call_mcp_tool', success, {}), true);
});
