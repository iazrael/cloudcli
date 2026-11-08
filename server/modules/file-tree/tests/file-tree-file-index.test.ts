import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { rgPath } from '@vscode/ripgrep';

import { createRipgrepFileIndexer } from '@/modules/file-tree/file-tree-file-index.js';

async function createProject(files: Record<string, string>): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cloudcli-file-index-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, content);
  }
  return root;
}

test('ripgrep indexer applies nested gitignores, skips excluded names and lists hidden files', async (t) => {
  const root = await createProject({
    '.gitignore': '*.log\n',
    'top.txt': '',
    'debug.log': '',
    '.config/settings.json': '',
    'sub/.gitignore': 'drop.txt\n',
    'sub/deep/keep.txt': '',
    'sub/deep/drop.txt': '',
    'node_modules/pkg/index.js': '',
    'packages/a/node_modules/pkg/index.js': '',
    'packages/a/dist/out.js': '',
    '.ignore': 'top.txt\n',
  });
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));

  const result = await createRipgrepFileIndexer(rgPath).listFiles({
    rootPath: root,
    excludedDirectoryNames: ['node_modules', 'dist'],
    maximumFiles: 100,
  });

  assert.equal(result.incomplete, false);
  assert.deepEqual([...result.files].sort(), [
    '.config/settings.json',
    '.gitignore',
    '.ignore',
    'sub/.gitignore',
    'sub/deep/keep.txt',
    'top.txt',
  ]);
});

test('ripgrep indexer stops at the file cap and reports an incomplete index', async (t) => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 50; index += 1) {
    files[`many/file-${index}.txt`] = '';
  }
  const root = await createProject(files);
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));

  const result = await createRipgrepFileIndexer(rgPath).listFiles({
    rootPath: root,
    excludedDirectoryNames: [],
    maximumFiles: 10,
  });

  assert.equal(result.incomplete, true);
  assert.equal(result.files.length, 10);
});

test('ripgrep indexer returns an empty list for an empty project', async (t) => {
  const root = await createProject({});
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));

  const result = await createRipgrepFileIndexer(rgPath).listFiles({
    rootPath: root,
    excludedDirectoryNames: [],
    maximumFiles: 10,
  });

  assert.deepEqual(result, { files: [], incomplete: false });
});

test('ripgrep indexer rejects when ripgrep cannot run', async () => {
  await assert.rejects(
    createRipgrepFileIndexer('/nonexistent/rg-binary').listFiles({
      rootPath: os.tmpdir(),
      excludedDirectoryNames: [],
      maximumFiles: 10,
    }),
  );
});
