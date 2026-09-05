import assert from 'node:assert/strict';

import { test } from 'vitest';

import { getToolConfig } from '@/modules/chat/tools/configs/toolConfigs';

/**
 * Title clicks on Write cards hand the editor a content snapshot instead of a
 * path-only open, and useCodeEditorDocument skips the disk read whenever that
 * snapshot carries both old and new strings. Codex normalizes its file writes
 * to old_string/new_string, which the Write config did not read, so every
 * codex Write title click opened the editor as an empty "0 changes" document
 * even though the path chip right below it showed the real file.
 */

test('Write content snapshot falls back to new_string for codex-style rows', () => {
  const config = getToolConfig('Write');
  const props = config.input.getContentProps?.({
    file_path: '/repo/server/zcode-live-event-normalizer.ts',
    old_string: '',
    new_string: 'export function normalize() {}\n',
  });

  assert.equal(props.newContent, 'export function normalize() {}\n');
  assert.equal(props.oldContent, '');
  assert.equal(props.filePath, '/repo/server/zcode-live-event-normalizer.ts');
  assert.equal(props.badge, 'New');
});

test('Write content snapshot keeps reading provider-native content fields first', () => {
  const config = getToolConfig('Write');

  assert.equal(
    config.input.getContentProps?.({ file_path: '/a.ts', content: 'claude style' }).newContent,
    'claude style',
  );
  assert.equal(
    config.input.getContentProps?.({ TargetFile: '/b.ts', CodeContent: 'legacy style' }).newContent,
    'legacy style',
  );
  assert.equal(config.input.getContentProps?.({ file_path: '/c.ts' }).newContent, '');
});

test('write_to_file content snapshot also falls back to new_string', () => {
  const config = getToolConfig('write_to_file');

  assert.equal(
    config.input.getContentProps?.({ TargetFile: '/d.ts', new_string: 'patch style' }).newContent,
    'patch style',
  );
  assert.equal(
    config.input.getContentProps?.({ TargetFile: '/d.ts', CodeContent: 'legacy style' }).newContent,
    'legacy style',
  );
});
