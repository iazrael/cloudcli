import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { getZcodeExternalReadOnlyRoots } from '@/modules/providers/list/zcode/zcode-data-root.js';

/**
 * The File Tree external read-only allowlist must expose exactly the ZCode
 * files chat can reference (memories, skills, AGENTS.md) under the configured
 * storage dir — never the credentials or hook config that share the tree.
 */
test('getZcodeExternalReadOnlyRoots follows the storage dir override', () => {
  const previous = process.env.ZCODE_STORAGE_DIR;
  try {
    process.env.ZCODE_STORAGE_DIR = '/tmp/zcode-storage-test';
    assert.deepEqual(getZcodeExternalReadOnlyRoots(), [
      path.join('/tmp/zcode-storage-test', 'cli', 'memories'),
      path.join('/tmp/zcode-storage-test', 'skills'),
      path.join('/tmp/zcode-storage-test', 'AGENTS.md'),
    ]);
  } finally {
    if (previous === undefined) {
      delete process.env.ZCODE_STORAGE_DIR;
    } else {
      process.env.ZCODE_STORAGE_DIR = previous;
    }
  }
});
