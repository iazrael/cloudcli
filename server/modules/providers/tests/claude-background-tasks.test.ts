import assert from 'node:assert/strict';
import test from 'node:test';

import { extractBackgroundTasks } from '@/modules/providers/list/claude/claude-runtime.provider.js';

test('extracts background tasks from Bash tool with run_in_background: true', () => {
  const message = {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_bash_1',
          name: 'Bash',
          input: {
            command: 'npm run test',
            run_in_background: true,
          },
        },
      ],
    },
  };

  const tasks = extractBackgroundTasks(message);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'toolu_bash_1');
  assert.equal(tasks[0].toolName, 'Bash');
  assert.equal(tasks[0].command, 'npm run test');
  assert.ok(typeof tasks[0].startedAt === 'number');
});

test('ignores Bash tool without run_in_background: true', () => {
  const message = {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_bash_2',
          name: 'Bash',
          input: {
            command: 'ls -la',
          },
        },
      ],
    },
  };

  const tasks = extractBackgroundTasks(message);
  assert.equal(tasks.length, 0);
});

test('extracts background tasks from deferred work tools like Monitor', () => {
  const message = {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_task_1',
          name: 'Monitor',
          input: {
            description: 'Run background analysis',
          },
        },
      ],
    },
  };

  const tasks = extractBackgroundTasks(message);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'toolu_task_1');
  assert.equal(tasks[0].toolName, 'Monitor');
  assert.equal(tasks[0].command, 'Run background analysis');
});

test('TaskCreate only writes a to-do item and creates no running-task card', () => {
  assert.deepEqual(extractBackgroundTasks({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_todo', name: 'TaskCreate', input: { subject: 'Plan work' } }] },
  }), []);
});

test('returns empty array when content has no tool use or non-array content', () => {
  assert.deepEqual(extractBackgroundTasks({ type: 'user', message: { content: 'hello' } }), []);
  assert.deepEqual(extractBackgroundTasks(null), []);
});
