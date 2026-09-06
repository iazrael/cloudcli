import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  canonicalToolName,
  getToolDisplayCategory,
  isCommandTool,
  isEditTool,
  isFilePreviewTool,
  pickCommandField,
  unwrapNestedCommand,
} from '@/modules/chat/tools/toolTaxonomy';
import { getNormalizedToolGroupKey } from '@/modules/chat/utils/toolGrouping';

/**
 * Pins the tool-name taxonomy: the alias → canonical map is the one authority
 * behind grouping keys, command rows, edit-card behavior and file previews.
 * Before this module the same lists lived in four files and drifted.
 */

test('every engine alias resolves to its canonical name', () => {
  assert.equal(canonicalToolName('run_command'), 'Bash');
  assert.equal(canonicalToolName('exec'), 'Bash');
  assert.equal(canonicalToolName('command_execution'), 'Bash');
  assert.equal(canonicalToolName('view_file'), 'Read');
  assert.equal(canonicalToolName('replace_file_content'), 'Edit');
  assert.equal(canonicalToolName('apply_patch'), 'Edit');
  assert.equal(canonicalToolName('ApplyPatch'), 'Edit');
  assert.equal(canonicalToolName('write_to_file'), 'Write');
  assert.equal(canonicalToolName('find_by_name'), 'Glob');
  assert.equal(canonicalToolName('grep_search'), 'Grep');
  assert.equal(canonicalToolName('list_dir'), 'LS');
  assert.equal(canonicalToolName('search_web'), 'WebSearch');
  assert.equal(canonicalToolName('read_url_content'), 'WebFetch');
  assert.equal(canonicalToolName('manage_task'), 'Task');
  assert.equal(canonicalToolName('manage_subagents'), 'Subagent');
  assert.equal(canonicalToolName('invoke_subagent'), 'Subagent');
  assert.equal(canonicalToolName('ExitPlanMode'), 'Plan');
  assert.equal(canonicalToolName('update_plan'), 'Plan');
});

test('an unknown tool name is its own canonical name', () => {
  assert.equal(canonicalToolName('mcp__github__create_issue'), 'mcp__github__create_issue');
});

test('the grouping key is exactly the canonical name', () => {
  for (const [alias, canonical] of [
    ['run_command', 'Bash'],
    ['apply_patch', 'Edit'],
    ['ExitPlanMode', 'Plan'],
    ['TodoWrite', 'TodoWrite'],
  ] as const) {
    assert.equal(getNormalizedToolGroupKey(alias), canonical);
  }
});

test('command-row membership follows the canonical name', () => {
  assert.equal(isCommandTool('Bash'), true);
  assert.equal(isCommandTool('run_command'), true);
  assert.equal(isCommandTool('command_execution'), true);
  assert.equal(isCommandTool('Write'), false);
});

test('edit-family membership includes the apply_patch alias', () => {
  assert.equal(isEditTool('Edit'), true);
  assert.equal(isEditTool('write_to_file'), true);
  assert.equal(isEditTool('ApplyPatch'), true);
  assert.equal(isEditTool('apply_patch'), true);
  assert.equal(isEditTool('Read'), false);
});

test('file-preview membership follows the canonical family', () => {
  assert.equal(isFilePreviewTool('view_file'), true);
  assert.equal(isFilePreviewTool('list_dir'), true);
  assert.equal(isFilePreviewTool('replace_file_content'), true);
  assert.equal(isFilePreviewTool('Glob'), false);
  assert.equal(isFilePreviewTool('Bash'), false);
});

test('display categories keep their explicit mapping, including cross-family names', () => {
  assert.equal(getToolDisplayCategory('replace_file_content'), 'edit');
  assert.equal(getToolDisplayCategory('grep_search'), 'search');
  assert.equal(getToolDisplayCategory('run_command'), 'bash');
  assert.equal(getToolDisplayCategory('TodoWrite'), 'todo');
  assert.equal(getToolDisplayCategory('manage_task'), 'task', 'manage_task is task work');
  assert.equal(getToolDisplayCategory('Task'), 'agent', 'while Task is subagent delegation');
  assert.equal(getToolDisplayCategory('exit_plan_mode'), 'plan');
  assert.equal(getToolDisplayCategory('AskUserQuestion'), 'question');
  assert.equal(getToolDisplayCategory('mcp__something__do_thing'), 'default');
});

test('pickCommandField reads the command/cmd/CommandLine field of a parsed input', () => {
  assert.equal(pickCommandField({ command: 'ls' }), 'ls');
  assert.equal(pickCommandField({ cmd: 'ls' }), 'ls');
  assert.equal(pickCommandField({ CommandLine: 'ls' }), 'ls');
  assert.equal(pickCommandField({ file_path: '/a.ts' }), '');
  assert.equal(pickCommandField('a raw string'), '');
  assert.equal(pickCommandField(null), '');
});

test('unwrapNestedCommand leaves ordinary commands untouched', () => {
  assert.equal(unwrapNestedCommand('ls -la'), 'ls -la');
  assert.equal(unwrapNestedCommand(''), '');
});

test('unwrapNestedCommand extracts the real command from a wrapped runner call', () => {
  assert.equal(
    unwrapNestedCommand('tools.exec_command {"cmd": "ls -la"}'),
    'ls -la',
  );
  assert.equal(
    unwrapNestedCommand(`tools.shell_command {"cmd": \`npm test\`}`),
    'npm test',
  );
  assert.equal(
    unwrapNestedCommand(`tools.exec_command {"command": 'git status'}`),
    'git status',
  );
});

test('unwrapNestedCommand falls back to the raw input when the command itself is empty', () => {
  assert.equal(
    unwrapNestedCommand('', `tools.exec_command {"cmd": "echo hi"}`),
    'echo hi',
  );
  // A fallback without the marker must not leak into an empty command.
  assert.equal(unwrapNestedCommand('', 'plain text'), '');
});

test('unwrapNestedCommand keeps the wrapped string when it cannot parse the payload', () => {
  const wrapped = 'tools.exec_command {"cmd": ';
  assert.equal(unwrapNestedCommand(wrapped), wrapped);
});
