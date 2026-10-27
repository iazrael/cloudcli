import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import chokidar from 'chokidar';

import { createWatcherIgnoredMatcher } from '@/modules/providers/services/sessions-watcher.service.js';

test('watcher ignores only excluded paths below its root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watcher-'));
  const files = ['valid/transcript.jsonl', '..archive/node_modules/dep/file', '.git/HEAD', 'valid/out.tmp'];
  try {
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), '{}');
    }
    const ignored = createWatcherIgnoredMatcher(root);
    assert.equal(ignored(root), false);
    assert.equal(ignored(path.join(root, '..archive', 'node_modules', 'dep')), true);
    assert.equal(ignored(path.join(root, '..archive', 'transcript.jsonl')), false);
    assert.equal(ignored(path.join(root, '..', 'node_modules')), false);
    const watcher = chokidar.watch(root, { ignored, ignoreInitial: false });
    const added: string[] = [];
    watcher.on('add', (filePath) => added.push(path.relative(root, filePath)));
    try {
      await new Promise<void>((resolve, reject) => { watcher.once('ready', resolve); watcher.once('error', reject); });
      assert.deepEqual(added, [path.join('valid', 'transcript.jsonl')]);
    } finally {
      await watcher.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
