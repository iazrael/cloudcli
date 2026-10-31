import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatToolDisplayName, getToolConfig } from '@/modules/chat/tools/configs/toolConfigs';
import {
  canonicalToolName,
  getToolDisplayCategory,
  isCommandTool,
  isEditTool,
  isFilePreviewTool,
  pickFilePath,
} from '@/modules/chat/tools/toolTaxonomy';

/**
 * Engines name their tools natively — agy's `edit_file` with Path/Target/
 * Replacement, opencode's lowercase `edit` with path/oldString/newString — and
 * any name the taxonomy does not know falls through to the generic JSON dump.
 * These pin that every in-use engine's file and command tools render through
 * the same card as Claude's.
 */

test('agy and opencode tool names resolve to the shared canonical names', () => {
  for (const [alias, canonical] of [
    ['edit_file', 'Edit'],
    ['read_file', 'Read'],
    ['write_file', 'Write'],
    ['shell', 'Bash'],
    ['bash', 'Bash'],
    ['read', 'Read'],
    ['edit', 'Edit'],
    ['write', 'Write'],
    ['grep', 'Grep'],
    ['glob', 'Glob'],
    ['webfetch', 'WebFetch'],
    ['websearch', 'WebSearch'],
  ] as const) {
    assert.equal(canonicalToolName(alias), canonical, alias);
  }
});

test('an aliased tool without its own config renders through the canonical config', () => {
  assert.equal(getToolConfig('edit_file'), getToolConfig('Edit'));
  assert.equal(getToolConfig('read_file'), getToolConfig('Read'));
  assert.equal(getToolConfig('write_file'), getToolConfig('Write'));
  assert.equal(getToolConfig('shell'), getToolConfig('Bash'));
  assert.equal(getToolConfig('replace_file_content'), getToolConfig('Edit'));
  assert.equal(getToolConfig('view_file'), getToolConfig('Read'));
  assert.equal(getToolConfig('write_to_file'), getToolConfig('Write'));
  assert.equal(getToolConfig('run_command'), getToolConfig('Bash'));
  assert.equal(getToolConfig('totally_unknown_tool'), getToolConfig('Default'));
});

test('agy edit_file feeds the Edit diff card', () => {
  const props = getToolConfig('edit_file').input.getContentProps?.({
    Path: '/repo/work/run_k6_clean.py',
    Target: 'assert a == 1',
    Replacement: 'assert a == 2',
  });
  assert.equal(props.filePath, '/repo/work/run_k6_clean.py');
  assert.equal(props.oldContent, 'assert a == 1');
  assert.equal(props.newContent, 'assert a == 2');

  const title = getToolConfig('edit_file').input.title as (input: unknown) => string;
  assert.equal(title({ Path: '/repo/work/run_k6_clean.py' }), 'run_k6_clean.py');
});

test('agy replace_file_content keeps feeding the Edit diff card', () => {
  const props = getToolConfig('replace_file_content').input.getContentProps?.({
    TargetFile: '/repo/a.ts',
    TargetContent: 'old',
    ReplacementContent: 'new',
  });
  assert.deepEqual([props.filePath, props.oldContent, props.newContent], ['/repo/a.ts', 'old', 'new']);
});

test('opencode edit feeds the Edit diff card', () => {
  const props = getToolConfig('edit').input.getContentProps?.({
    path: '/repo/b.ts',
    oldString: 'const a = 1;',
    newString: 'const a = 2;',
  });
  assert.deepEqual([props.filePath, props.oldContent, props.newContent], ['/repo/b.ts', 'const a = 1;', 'const a = 2;']);
});

test('agy and opencode file writes feed the Write card', () => {
  const agy = getToolConfig('write_file').input.getContentProps?.({ Path: '/repo/c.py', Content: 'print(1)\n' });
  assert.deepEqual([agy.filePath, agy.newContent, agy.badge], ['/repo/c.py', 'print(1)\n', 'New']);

  const opencode = getToolConfig('write').input.getContentProps?.({ path: '/repo/d.ts', content: 'x' });
  assert.deepEqual([opencode.filePath, opencode.newContent], ['/repo/d.ts', 'x']);

  const legacy = getToolConfig('write_to_file').input.getContentProps?.({ TargetFile: '/repo/e.ts', CodeContent: 'y' });
  assert.deepEqual([legacy.filePath, legacy.newContent], ['/repo/e.ts', 'y']);
});

test('every engine read names the file it opens', () => {
  assert.equal(getToolConfig('read_file').input.getValue?.({ Path: '/repo/f.ts', StartLine: 1 }), '/repo/f.ts');
  assert.equal(getToolConfig('view_file').input.getValue?.({ AbsolutePath: '/repo/g.ts' }), '/repo/g.ts');
  assert.equal(getToolConfig('read').input.getValue?.({ path: '/repo/h.ts', offset: 1 }), '/repo/h.ts');
  assert.equal(getToolConfig('Read').input.getValue?.({ file_path: '/repo/i.ts' }), '/repo/i.ts');
});

test('opencode search and web tools show their query instead of a JSON dump', () => {
  assert.equal(getToolConfig('grep').input.getValue?.({ pattern: 'TODO', path: 'src' }), 'TODO');
  assert.equal(getToolConfig('glob').input.getValue?.({ pattern: '**/*.ts' }), '**/*.ts');
  assert.equal(getToolConfig('webfetch').input.getValue?.({ url: 'https://example.com' }), 'https://example.com');
  assert.equal(getToolConfig('websearch').input.getValue?.({ query: 'vitest' }), 'vitest');
});

test('new engine aliases join the command, edit and file-preview families', () => {
  assert.equal(isCommandTool('shell'), true);
  assert.equal(isCommandTool('bash'), true);
  assert.equal(isEditTool('edit_file'), true);
  assert.equal(isEditTool('write_file'), true);
  assert.equal(isEditTool('edit'), true);
  assert.equal(isFilePreviewTool('read_file'), true);
  assert.equal(getToolDisplayCategory('edit_file'), 'edit');
  assert.equal(getToolDisplayCategory('write_file'), 'edit');
  assert.equal(getToolDisplayCategory('edit'), 'edit');
  assert.equal(getToolDisplayCategory('grep'), 'search');
  assert.equal(getToolDisplayCategory('shell'), 'bash');
  // Categories that cross alias families stay explicit.
  assert.equal(getToolDisplayCategory('manage_task'), 'task');
  assert.equal(getToolDisplayCategory('ExitPlanMode'), 'plan');
  assert.equal(getToolDisplayCategory('update_plan'), 'default');
});

test('pickFilePath reads every engine path field', () => {
  assert.equal(pickFilePath({ file_path: '/a' }), '/a');
  assert.equal(pickFilePath({ TargetFile: '/b' }), '/b');
  assert.equal(pickFilePath({ AbsolutePath: '/c' }), '/c');
  assert.equal(pickFilePath({ Path: '/d' }), '/d');
  assert.equal(pickFilePath({ path: '/e' }), '/e');
  assert.equal(pickFilePath({ filePath: '/f' }), '/f');
  assert.equal(pickFilePath({}), '');
  assert.equal(pickFilePath(null), '');
});

test('an aliased tool is labeled by its canonical name in card and group headers', () => {
  assert.equal(formatToolDisplayName('write_file'), 'Write');
  assert.equal(formatToolDisplayName('edit_file'), 'Edit');
  assert.equal(formatToolDisplayName('replace_file_content'), 'Edit');
  assert.equal(formatToolDisplayName('write'), 'Write');
  assert.equal(formatToolDisplayName('edit'), 'Edit');
  assert.equal(formatToolDisplayName('Write'), 'Write');
  assert.equal(formatToolDisplayName('AskUserQuestion'), 'Question');
  assert.equal(formatToolDisplayName('mcp__github__create_issue'), 'create_issue');
  assert.equal(formatToolDisplayName('generate_image'), 'generate_image');
});
