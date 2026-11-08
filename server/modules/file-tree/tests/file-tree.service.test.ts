import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeDirectoryListing,
  FileTreeFileIndexer,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
} from '@/shared/types.js';
import { AppError, resolveReadOnlyRootPath, validateWorkspacePath } from '@/shared/utils.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
  externalReadOnlyRoots: string[] = [],
  overrides: Partial<FileTreeServiceDependencies> = {},
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      readOnlyRoot: null,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    externalReadOnlyRoots,
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
    fileIndexer: {
      listFiles: async () => {
        throw new Error('Unexpected File Tree index build');
      },
    },
    now: () => 0,
    ...overrides,
  };
}

type FakeTree = Record<string, string[]>;

/**
 * Builds a path-keyed fake filesystem from a compact description: each key is
 * a directory relative to `projectRoot` ('' is the root) and lists its entries,
 * with a trailing `/` marking subdirectories. `files` maps relative paths to
 * text content (used for `.gitignore` files); `links` maps a relative path to
 * the absolute target `realpath` reports for it.
 */
function createTreeFileSystem(
  projectRoot: string,
  tree: FakeTree,
  options: {
    files?: Record<string, string>;
    links?: Record<string, string>;
    readDirectories?: string[];
    overrides?: Partial<FileTreeFileSystem>;
  } = {},
): FileTreeFileSystem {
  const absolute = (relativePath: string) => (relativePath ? path.join(projectRoot, relativePath) : projectRoot);
  const directories = new Set(Object.keys(tree).map(absolute));
  const files = new Map(Object.entries(options.files ?? {}).map(([relativePath, content]) => [absolute(relativePath), content]));
  const links = new Map(Object.entries(options.links ?? {}).map(([relativePath, target]) => [absolute(relativePath), target]));
  const knownPaths = new Set<string>([...directories, ...files.keys(), ...links.keys()]);
  for (const [relativeDirectory, entries] of Object.entries(tree)) {
    for (const entry of entries) {
      knownPaths.add(path.join(absolute(relativeDirectory), entry.replace(/\/$/, '')));
    }
  }

  return createFakeFileSystem({
    access: async (candidatePath) => {
      if (!knownPaths.has(candidatePath)) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    realpath: async (candidatePath) => {
      const linked = links.get(candidatePath);
      if (linked) return linked;
      if (!knownPaths.has(candidatePath)) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return candidatePath;
    },
    readTextFile: async (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return content;
    },
    openDirectory: async function* (directoryPath) {
      options.readDirectories?.push(directoryPath);
      if (!directories.has(directoryPath)) {
        throw Object.assign(new Error('not a directory'), {
          code: knownPaths.has(directoryPath) ? 'ENOTDIR' : 'ENOENT',
        });
      }
      const relativeDirectory = path.relative(projectRoot, directoryPath);
      for (const entry of tree[relativeDirectory] ?? []) {
        yield createDirectoryEntry(entry.replace(/\/$/, ''), entry.endsWith('/'));
      }
    },
    lstat: async (candidatePath) => createStats(directories.has(candidatePath), 0o754),
    ...options.overrides,
  });
}

function createStaticIndexer(files: string[], calls: Array<Parameters<FileTreeFileIndexer['listFiles']>[0]> = []): FileTreeFileIndexer {
  return {
    listFiles: async (input) => {
      calls.push(input);
      return { files: [...files], incomplete: false };
    },
  };
}

function listingNames(listing: FileTreeDirectoryListing | undefined): string[] {
  assert.ok(listing && 'entries' in listing, `expected a listing, got ${JSON.stringify(listing)}`);
  return listing.entries.map((entry) => entry.name);
}

function listingError(listing: FileTreeDirectoryListing | undefined): string {
  assert.ok(listing && 'error' in listing, `expected an error, got ${JSON.stringify(listing)}`);
  return listing.error.code;
}

const fakeProjectRoot = path.resolve('file-tree-test-project');

test('listDirectories lists one level, directories first, without reading subdirectories', async () => {
  const readDirectories: string[] = [];
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {
    '': ['.git/', 'node_modules/', 'README.md', 'docs/', 'src/', 'debug.log', '.gitignore'],
    src: ['index.ts'],
    docs: [],
  }, { files: { '.gitignore': '*.log' }, readDirectories });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot));

  const [root] = await service.listDirectories('project-1', ['']);

  assert.deepEqual(listingNames(root), ['docs', 'src', '.gitignore', 'README.md']);
  assert.ok(root && 'entries' in root);
  assert.equal(root.request, '');
  assert.equal(root.path, fakeProjectRoot);
  assert.equal(root.truncated, false);
  const source = root.entries[1];
  assert.equal(source?.type, 'directory');
  assert.equal(source?.path, path.join(fakeProjectRoot, 'src'));
  assert.equal(source?.permissions, '754');
  assert.equal(source?.permissionsRwx, 'rwxr-xr--');
  assert.equal('children' in (source ?? {}), false);
  assert.deepEqual(readDirectories, [fakeProjectRoot]);
});

test('listDirectories applies the gitignore chain from the root down, deeper rules winning', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {
    '': ['src/', 'notes.md', 'top.log'],
    src: ['a.log', 'important.log', 'local.txt', 'index.ts', 'build/', 'notes.md', '.gitignore'],
    'src/build': [],
  }, {
    files: {
      '.gitignore': ['*.log', 'build/'].join('\n'),
      'src/.gitignore': ['!important.log', 'local.txt'].join('\n'),
      '.git/info/exclude': 'notes.md',
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot));

  const [root, source] = await service.listDirectories('project-1', ['', 'src']);

  assert.deepEqual(listingNames(root), ['src']);
  assert.deepEqual(listingNames(source), ['.gitignore', 'important.log', 'index.ts']);
});

test('listDirectories ignores .ignore files', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {
    '': ['.ignore', 'kept.png'],
  }, { files: { '.ignore': '*.png' } });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot));

  const [root] = await service.listDirectories('project-1', ['']);

  assert.deepEqual(listingNames(root), ['.ignore', 'kept.png']);
});

test('listDirectories falls back to conventional directory names when the root has no gitignore', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {
    '': ['debug.log', 'docs/', 'node_modules/', 'dist/'],
    docs: ['build/', 'guide.md'],
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot));

  const [root, documentation] = await service.listDirectories('project-1', ['', 'docs']);

  assert.deepEqual(listingNames(root), ['docs', 'debug.log']);
  assert.deepEqual(listingNames(documentation), ['guide.md']);
});

test('listDirectories truncates one oversized directory without reading it all', async () => {
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    realpath: async (candidatePath) => candidatePath,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    // Endless on purpose: the read has to stop consuming the stream itself.
    openDirectory: async function* () {
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot));

  const [root] = await service.listDirectories('project-1', ['']);

  assert.ok(root && 'entries' in root);
  assert.equal(root.entries.length, 5_000);
  assert.equal(root.truncated, true);
  // The cap plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 5_001);
});

test('listDirectories answers each path of a batch independently', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {
    '': ['src/', 'README.md'],
    src: ['index.ts'],
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot));

  const listings = await service.listDirectories('project-1', [
    'src/gone',
    path.join(fakeProjectRoot, 'src'),
    'README.md',
    './src/',
  ]);

  assert.deepEqual(listings.map((listing) => listing.request), [
    'src/gone',
    path.join(fakeProjectRoot, 'src'),
    'README.md',
    './src/',
  ]);
  assert.equal(listingError(listings[0]), 'FILE_TREE_PATH_NOT_FOUND');
  assert.deepEqual(listingNames(listings[1]), ['index.ts']);
  assert.equal(listingError(listings[2]), 'FILE_TREE_NOT_A_DIRECTORY');
  assert.deepEqual(listingNames(listings[3]), ['index.ts']);
  assert.ok(listings[3] && 'path' in listings[3]);
  assert.equal(listings[3].path, path.join(fakeProjectRoot, 'src'));
});

test('listDirectories refuses paths that leave the project, including through symlinks', async () => {
  const readDirectories: string[] = [];
  const outside = path.resolve('somewhere-else');
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {
    '': ['escape/', 'src/'],
    src: [],
    escape: ['secret.txt'],
  }, {
    links: { escape: outside },
    readDirectories,
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot));

  const listings = await service.listDirectories('project-1', [
    '../outside',
    outside,
    `${fakeProjectRoot}-sibling`,
    'escape',
  ]);

  assert.deepEqual(listings.map(listingError), [
    'PATH_OUTSIDE_PROJECT',
    'PATH_OUTSIDE_PROJECT',
    'PATH_OUTSIDE_PROJECT',
    'PATH_OUTSIDE_PROJECT',
  ]);
  assert.deepEqual(readDirectories, []);
});

test('listDirectories works when the project root itself is a symlink', async () => {
  const realRoot = path.resolve('real-project-location');
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {
    '': ['src/'],
    src: ['index.ts'],
  }, {
    overrides: {
      realpath: async (candidatePath) => {
        const relative = path.relative(fakeProjectRoot, candidatePath);
        if (relative.startsWith('..')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return relative ? path.join(realRoot, relative) : realRoot;
      },
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot));

  const [source] = await service.listDirectories('project-1', ['src']);

  assert.deepEqual(listingNames(source), ['index.ts']);
  assert.ok(source && 'path' in source);
  assert.equal(source.path, path.join(fakeProjectRoot, 'src'));
});

test('listDirectories reports a missing project root as a request error', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {});
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot));

  await assert.rejects(
    service.listDirectories('project-1', ['']),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
});

const searchableFiles = [
  'src/app/Button.tsx',
  'src/button.css',
  'docs/buttons-guide.md',
  'lib/old/button',
  'test/a-button-x.ts',
  'src/other.ts',
];

test('searchFiles ranks exact names, then name prefixes, then name substrings, then path matches', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {}, {
    overrides: { lstat: async () => createStats(false, 0o644) },
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot, [], {
    fileIndexer: createStaticIndexer([...searchableFiles, 'button-docs/readme.md']),
  }));

  const result = await service.searchFiles({ projectId: 'project-1', query: 'BUTTON', limit: 50, type: 'file' });

  assert.deepEqual(result.results.map((match) => match.relativePath), [
    'lib/old/button',
    'src/button.css',
    'src/app/Button.tsx',
    'docs/buttons-guide.md',
    'test/a-button-x.ts',
    'button-docs/readme.md',
  ]);
  assert.equal(result.truncated, false);
  assert.equal(result.indexIncomplete, false);
  const first = result.results[0];
  assert.equal(first?.path, path.join(fakeProjectRoot, 'lib', 'old', 'button'));
  assert.equal(first?.name, 'button');
  assert.equal(first?.type, 'file');
  assert.equal(first?.size, 24);
});

test('searchFiles requires every whitespace-separated token somewhere in the path', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {}, {
    overrides: { lstat: async () => createStats(false, 0o644) },
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot, [], {
    fileIndexer: createStaticIndexer(searchableFiles),
  }));

  const result = await service.searchFiles({ projectId: 'project-1', query: '  src   TSX ', limit: 50, type: 'file' });

  assert.deepEqual(result.results.map((match) => match.relativePath), ['src/app/Button.tsx']);
});

test('searchFiles includes containing directories only for type any', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {}, {
    overrides: { lstat: async (candidatePath) => createStats(!path.extname(candidatePath), 0o755) },
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot, [], {
    fileIndexer: createStaticIndexer(searchableFiles),
  }));

  const any = await service.searchFiles({ projectId: 'project-1', query: 'app', limit: 50, type: 'any' });
  const filesOnly = await service.searchFiles({ projectId: 'project-1', query: 'app', limit: 50, type: 'file' });

  assert.deepEqual(any.results.map((match) => [match.relativePath, match.type]), [
    ['src/app', 'directory'],
    ['src/app/Button.tsx', 'file'],
  ]);
  assert.deepEqual(filesOnly.results.map((match) => match.relativePath), ['src/app/Button.tsx']);
});

test('searchFiles limits results, flags truncation, and lists path order for an empty query', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {}, {
    overrides: { lstat: async () => createStats(false, 0o644) },
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot, [], {
    fileIndexer: createStaticIndexer(searchableFiles),
  }));

  const limited = await service.searchFiles({ projectId: 'project-1', query: 'button', limit: 2, type: 'file' });
  const browse = await service.searchFiles({ projectId: 'project-1', query: '   ', limit: 3, type: 'file' });

  assert.deepEqual(limited.results.map((match) => match.relativePath), ['lib/old/button', 'src/button.css']);
  assert.equal(limited.truncated, true);
  assert.deepEqual(browse.results.map((match) => match.relativePath), [
    'docs/buttons-guide.md',
    'lib/old/button',
    'src/app/Button.tsx',
  ]);
  assert.equal(browse.truncated, true);
});

test('searchFiles drops matches deleted since the index was built', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {}, {
    overrides: {
      lstat: async (candidatePath) => {
        if (candidatePath.endsWith('button.css')) {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        return createStats(false, 0o644);
      },
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot, [], {
    fileIndexer: createStaticIndexer(searchableFiles),
  }));

  const result = await service.searchFiles({ projectId: 'project-1', query: 'button.', limit: 50, type: 'file' });

  assert.deepEqual(result.results.map((match) => match.relativePath), ['src/app/Button.tsx']);
});

test('searchFiles excludes conventional directory names only when the root has no gitignore', async () => {
  const withGitignore: Array<Parameters<FileTreeFileIndexer['listFiles']>[0]> = [];
  const withoutGitignore: Array<Parameters<FileTreeFileIndexer['listFiles']>[0]> = [];
  const ignoredRoot = createTreeFileSystem(fakeProjectRoot, { '': ['.gitignore'] }, { files: { '.gitignore': '' } });
  const plainRoot = createTreeFileSystem(fakeProjectRoot, { '': [] });

  await createFileTreeService(createDependencies(ignoredRoot, fakeProjectRoot, [], {
    fileIndexer: createStaticIndexer([], withGitignore),
  })).searchFiles({ projectId: 'project-1', query: 'x', limit: 5, type: 'file' });
  await createFileTreeService(createDependencies(plainRoot, fakeProjectRoot, [], {
    fileIndexer: createStaticIndexer([], withoutGitignore),
  })).searchFiles({ projectId: 'project-1', query: 'x', limit: 5, type: 'file' });

  assert.equal(withGitignore[0]?.rootPath, fakeProjectRoot);
  assert.equal(withGitignore[0]?.maximumFiles, 200_000);
  assert.deepEqual([...(withGitignore[0]?.excludedDirectoryNames ?? [])].sort(), ['.git', '.hg', '.svn', 'node_modules']);
  assert.ok(withoutGitignore[0]?.excludedDirectoryNames.includes('dist'));
  assert.ok(withoutGitignore[0]?.excludedDirectoryNames.includes('node_modules'));
});

test('searchFiles indexes visible symlinks by name without following them', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, {}, {
    files: { '.gitignore': 'ignored-link' },
    overrides: {
      lstat: async () => createStats(false, 0o644),
      openDirectory: async function* (directoryPath) {
        const link = (name: string): FileTreeDirectoryEntry => ({ name, isDirectory: () => false, isSymbolicLink: () => true });
        if (directoryPath === fakeProjectRoot) {
          yield createDirectoryEntry('AGENTS.md', false);
          yield link('CLAUDE.md');
          yield link('ignored-link');
        } else if (directoryPath === path.join(fakeProjectRoot, 'docs')) {
          yield link('linked-dir');
        }
      },
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot, [], {
    fileIndexer: createStaticIndexer(['AGENTS.md', 'docs/guide.md']),
  }));

  const result = await service.searchFiles({ projectId: 'project-1', query: '', limit: 50, type: 'file' });

  assert.deepEqual(result.results.map((match) => match.relativePath), [
    'AGENTS.md',
    'CLAUDE.md',
    'docs/guide.md',
    'docs/linked-dir',
  ]);
});

test('searchFiles reuses the index within its lifetime and shares a build in flight', async () => {
  let clock = 1_000;
  let builds = 0;
  let releaseBuild: () => void = () => undefined;
  const fileSystem = createTreeFileSystem(fakeProjectRoot, { '': [] }, {
    overrides: { lstat: async () => createStats(false, 0o644) },
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot, [], {
    now: () => clock,
    fileIndexer: {
      listFiles: async () => {
        builds += 1;
        await new Promise<void>((resolve) => {
          releaseBuild = resolve;
        });
        return { files: ['a.ts'], incomplete: false };
      },
    },
  }));
  const search = () => service.searchFiles({ projectId: 'project-1', query: 'a', limit: 5, type: 'file' });

  const concurrent = Promise.all([search(), search()]);
  await new Promise((resolve) => setImmediate(resolve));
  releaseBuild();
  await concurrent;
  assert.equal(builds, 1);

  clock += 14_000;
  await search();
  assert.equal(builds, 1);

  clock += 2_000;
  const expired = search();
  await new Promise((resolve) => setImmediate(resolve));
  releaseBuild();
  await expired;
  assert.equal(builds, 2);
});

test('searchFiles rebuilds the index after a write through the File Tree API', async () => {
  let builds = 0;
  const fileSystem = createTreeFileSystem(fakeProjectRoot, { '': [] }, {
    overrides: {
      lstat: async () => createStats(false, 0o644),
      makeDirectory: async () => undefined,
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot, [], {
    fileIndexer: {
      listFiles: async () => {
        builds += 1;
        return { files: ['a.ts'], incomplete: false };
      },
    },
  }));
  const search = () => service.searchFiles({ projectId: 'project-1', query: 'a', limit: 5, type: 'file' });

  await search();
  await service.createEntry({ projectId: 'project-1', parentPath: '', type: 'directory', name: 'fresh' });
  await search();

  assert.equal(builds, 2);
});

test('searchFiles reports an incomplete index and propagates indexer failures', async () => {
  const fileSystem = createTreeFileSystem(fakeProjectRoot, { '': [] }, {
    overrides: { lstat: async () => createStats(false, 0o644) },
  });
  const incomplete = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot, [], {
    fileIndexer: { listFiles: async () => ({ files: ['a.ts'], incomplete: true }) },
  }));
  const failing = createFileTreeService(createDependencies(fileSystem, fakeProjectRoot, [], {
    fileIndexer: { listFiles: async () => { throw new Error('rg exploded'); } },
  }));

  const result = await incomplete.searchFiles({ projectId: 'project-1', query: 'a', limit: 5, type: 'file' });
  assert.equal(result.indexIncomplete, true);
  await assert.rejects(
    failing.searchFiles({ projectId: 'project-1', query: 'a', limit: 5, type: 'file' }),
    /rg exploded/,
  );
  // A failed build is not cached as a result.
  await assert.rejects(
    failing.searchFiles({ projectId: 'project-1', query: 'a', limit: 5, type: 'file' }),
    /rg exploded/,
  );
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('readTextFile reports a directory as a client error, not a 500', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    readTextFile: async () => {
      const error = new Error('EISDIR: illegal operation on a directory, read');
      (error as NodeJS.ErrnoException).code = 'EISDIR';
      throw error;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'decisions'),
    (error: unknown) => error instanceof AppError
      && error.code === 'EISDIR'
      && error.statusCode === 400
      && error.message === 'Path is a directory, not a file',
  );
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});

test('readExternalTextFile reads a file inside an allowlisted external root', async () => {
  const brainRoot = path.resolve('antigravity-brain');
  const planPath = path.join(brainRoot, '28b2c337-session', 'plan.md');
  const fileSystem = createFakeFileSystem({
    realpath: async (candidatePath) => candidatePath,
    readTextFile: async (filePath) => {
      assert.equal(filePath, planPath);
      return '# Plan';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, path.resolve('file-tree-test-project'), [brainRoot]));

  const result = await service.readExternalTextFile(planPath);

  assert.equal(result.content, '# Plan');
  assert.equal(result.path, planPath);
});

test('readExternalTextFile accepts the legacy brain root as well', async () => {
  const currentRoot = path.resolve('antigravity-brain');
  const legacyRoot = path.resolve('legacy-antigravity-brain');
  const legacyPlanPath = path.join(legacyRoot, 'old-session', 'plan.md');
  const fileSystem = createFakeFileSystem({
    realpath: async (candidatePath) => candidatePath,
    readTextFile: async (filePath) => {
      assert.equal(filePath, legacyPlanPath);
      return '# Legacy Plan';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, path.resolve('file-tree-test-project'), [currentRoot, legacyRoot]));

  const result = await service.readExternalTextFile(legacyPlanPath);

  assert.equal(result.content, '# Legacy Plan');
});

test('readExternalTextFile rejects paths outside every allowlisted root', async () => {
  const brainRoot = path.resolve('antigravity-brain');
  const outsidePath = path.resolve('/etc/passwd');
  const fileSystem = createFakeFileSystem({
    realpath: async (candidatePath) => candidatePath,
  });
  const service = createFileTreeService(createDependencies(fileSystem, path.resolve('file-tree-test-project'), [brainRoot]));

  await assert.rejects(
    service.readExternalTextFile(outsidePath),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 403
      && error.code === 'PATH_NOT_ALLOWED',
  );
});

test('readExternalTextFile rejects relative paths before touching the filesystem', async () => {
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    realpath: async (candidatePath) => {
      readPaths.push(candidatePath);
      return candidatePath;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, path.resolve('file-tree-test-project'), [path.resolve('antigravity-brain')]));

  await assert.rejects(
    service.readExternalTextFile('brain/plan.md'),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 403
      && error.code === 'PATH_NOT_ALLOWED',
  );
  assert.deepEqual(readPaths, []);
});

test('readExternalTextFile rejects a symlink planted inside a root that points outside', async () => {
  const brainRoot = path.resolve('antigravity-brain');
  const linkPath = path.join(brainRoot, 'escape.md');
  const outsideTarget = path.resolve('/etc/passwd');
  const fileSystem = createFakeFileSystem({
    realpath: async (candidatePath) => (candidatePath === linkPath ? outsideTarget : candidatePath),
  });
  const service = createFileTreeService(createDependencies(fileSystem, path.resolve('file-tree-test-project'), [brainRoot]));

  await assert.rejects(
    service.readExternalTextFile(linkPath),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 403
      && error.code === 'PATH_NOT_ALLOWED',
  );
});

test('readExternalTextFile maps a missing file to 404', async () => {
  const brainRoot = path.resolve('antigravity-brain');
  const missingPath = path.join(brainRoot, 'missing.md');
  const fileSystem = createFakeFileSystem({
    realpath: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, path.resolve('file-tree-test-project'), [brainRoot]));

  await assert.rejects(
    service.readExternalTextFile(missingPath),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
});

test('openExternalFile streams a file inside an allowlisted external root', async () => {
  const assetsRoot = path.resolve('cloudcli-assets');
  const imagePath = path.join(assetsRoot, 'shot.png');
  const fileSystem = createFakeFileSystem({
    realpath: async (candidatePath) => candidatePath,
    access: async () => {},
    createReadStream: () => Readable.from(Buffer.from([0x89, 0x50, 0x4e, 0x47])) as any,
  });
  const dependencies = {
    ...createDependencies(fileSystem, path.resolve('file-tree-test-project'), [assetsRoot]),
    resolveMimeType: () => 'image/png',
  };
  const service = createFileTreeService(dependencies);

  const result = await service.openExternalFile(imagePath);
  assert.equal(result.contentType, 'image/png');
  assert.ok(result.stream);
});

test('readExternalTextFile and openExternalFile allow reading inside a linked worktree when projectId is supplied', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const worktreeRoot = path.resolve('file-tree-test-worktrees/feature-branch');
  const worktreeFilePath = path.join(worktreeRoot, 'notes.txt');
  const worktreeImagePath = path.join(worktreeRoot, 'preview.png');

  const fileSystem = createFakeFileSystem({
    realpath: async (candidatePath) => candidatePath,
    access: async () => {},
    readTextFile: async (filePath) => {
      assert.equal(filePath, worktreeFilePath);
      return 'worktree content';
    },
    createReadStream: () => Readable.from(Buffer.from([0x89, 0x50, 0x4e, 0x47])) as any,
  });

  const dependencies = {
    ...createDependencies(fileSystem, projectRoot, []),
    resolveWorktreeRoots: async (root: string) => {
      assert.equal(root, projectRoot);
      return [worktreeRoot];
    },
    resolveMimeType: () => 'image/png',
  };
  const service = createFileTreeService(dependencies);

  // Text file in worktree
  const textResult = await service.readExternalTextFile(worktreeFilePath, 'project-1');
  assert.equal(textResult.content, 'worktree content');

  // Media file in worktree
  const mediaResult = await service.openExternalFile(worktreeImagePath, 'project-1');
  assert.equal(mediaResult.contentType, 'image/png');
  assert.ok(mediaResult.stream);

  // Path outside worktree rejected
  const outsidePath = path.resolve('unrelated-directory/secret.txt');
  await assert.rejects(
    service.readExternalTextFile(outsidePath, 'project-1'),
    (error: unknown) => error instanceof AppError && error.statusCode === 403,
  );
  await assert.rejects(
    service.openExternalFile(outsidePath, 'project-1'),
    (error: unknown) => error instanceof AppError && error.statusCode === 403,
  );
});

/**
 * Builds the service against the real filesystem and the real workspace policy,
 * which is the only way to exercise the read-only roots: the whole guarantee
 * rests on `realpath` resolving symlinks before the comparison.
 */
function createRealFileSystemService(projectRoot: string, workspaceRoot = projectRoot): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath) => fsPromises.access(candidatePath),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
      realpath: (candidatePath) => fsPromises.realpath(candidatePath),
      readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
      async makeDirectory(directoryPath, recursive) {
        await fsPromises.mkdir(directoryPath, { recursive });
      },
      rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
      async removeDirectory(directoryPath) {
        await fsPromises.rm(directoryPath, { recursive: true, force: true });
      },
      unlink: (filePath) => fsPromises.unlink(filePath),
      copyFile: (source, destination) => fsPromises.copyFile(source, destination),
      createReadStream: (filePath) => createReadStream(filePath),
    },
    projects: { getProjectPathById: async () => projectRoot },
    workspace: {
      rootPath: workspaceRoot,
      readOnlyRoot: workspaceRoot,
      validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
      resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    externalReadOnlyRoots: [],
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
    fileIndexer: {
      listFiles: async () => {
        throw new Error('Unexpected File Tree index build');
      },
    },
    now: () => 0,
  });
}

test('listDirectories on a real filesystem refuses a symlink out of the project and never lists it', async () => {
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  const outside = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-outside-'));

  try {
    await fsPromises.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.mkdir(path.join(projectRoot, 'src'));
    await fsPromises.writeFile(path.join(projectRoot, 'src', 'index.ts'), '', 'utf8');
    await fsPromises.symlink(outside, path.join(projectRoot, 'escape'));
    const service = createRealFileSystemService(projectRoot);

    const [root, escape, nested, source] = await service.listDirectories('project-1', ['', 'escape', 'escape/.', 'src']);

    // The link shows up as an entry but is a symlink, never a directory to expand.
    assert.ok(root && 'entries' in root);
    const link = root.entries.find((entry) => entry.name === 'escape');
    assert.equal(link?.type, 'file');
    assert.equal(link?.isSymlink, true);
    assert.ok(escape && 'error' in escape);
    assert.equal(escape.error.code, 'PATH_OUTSIDE_PROJECT');
    assert.ok(nested && 'error' in nested);
    assert.equal(nested.error.code, 'PATH_OUTSIDE_PROJECT');
    assert.ok(source && 'entries' in source);
    assert.deepEqual(source.entries.map((entry) => entry.name), ['index.ts']);
  } finally {
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outside, { recursive: true, force: true });
  }
});

test('the temp directory can be browsed and read, but never written to', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    // The shape a task notification quotes: an agent's output file written to
    // the system temp directory, outside every project.
    await fsPromises.mkdir(path.join(temporaryDirectory, 'tasks'));
    const outputPath = path.join(temporaryDirectory, 'tasks', 'agent.output');
    await fsPromises.writeFile(outputPath, 'what the agent found', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const browsed = await service.browseWorkspace(temporaryDirectory);
    assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['tasks']);

    const opened = await service.readTextFile('project-1', outputPath);
    assert.equal(opened.content, 'what the agent found');

    const streamed = await service.openFile('project-1', outputPath);
    streamed.stream.destroy();

    // Read-only means read-only: nothing may be created or changed there.
    await assert.rejects(
      service.saveTextFile('project-1', outputPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.createWorkspaceFolder(path.join(temporaryDirectory, 'new-folder')),
      (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
    );
    await assert.rejects(
      service.createEntry({
        projectId: 'project-1',
        parentPath: path.join(temporaryDirectory, 'tasks'),
        type: 'file',
        name: 'planted.txt',
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: outputPath, newName: 'renamed.output' }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    const uploadedTemporaryPath = path.join(projectRoot, 'upload.tmp');
    await fsPromises.writeFile(uploadedTemporaryPath, 'upload', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.join(temporaryDirectory, 'tasks'),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'upload.txt', temporaryPath: uploadedTemporaryPath, size: 6, mimeType: 'text/plain' }],
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: outputPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.deepEqual(await fsPromises.readdir(path.join(temporaryDirectory, 'tasks')), ['agent.output']);
    assert.equal(await fsPromises.readFile(outputPath, 'utf8'), 'what the agent found');
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

// This fork browses the temp directories on purpose, so when the repo itself
// is checked out under one (scratch worktrees), no fixture can sit outside
// every root and this case's premise collapses. Skip there; it still runs for
// checkouts outside the temp directories.
const tempRootsReal = await Promise.all(['/tmp', os.tmpdir()].map((root) => fsPromises.realpath(root).catch(() => null)));
const repoUnderReadOnlyRoot = tempRootsReal.some((root) => root !== null && (testDirectory.startsWith(root + '/')));
test('reading through a symlink out of the temp directory is still refused', { skip: repoUnderReadOnlyRoot }, async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  // The link target has to sit under no read-only root. Beside this file is
  // deterministic; a directory under `$HOME` lands under `/tmp` whenever a
  // test run isolates its home there, and the Claude projects directory is a
  // read-only root too.
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    assert.equal(await resolveReadOnlyRootPath(outsideDirectory), null);
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(temporaryDirectory, 'escape'));

    const service = createRealFileSystemService(projectRoot);
    await assert.rejects(
      service.readTextFile('project-1', path.join(temporaryDirectory, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('a null readOnlyRoot disables the workspace-root read grant even when rootPath points elsewhere', async () => {
  // WORKSPACES_ROOT 误配系统目录时守卫注入 null：即使 rootPath 仍指向某个
  // 目录，工作区根授权也必须不生效，路径回落到项目边界被拒。
  const siblingPath = path.resolve('file-tree-test-workspace/sibling.txt');
  const fileSystem = createFakeFileSystem({
    realpath: async (candidatePath) => candidatePath,
  });
  const dependencies = createDependencies(fileSystem, path.resolve('file-tree-test-project'), []);
  dependencies.workspace.rootPath = path.resolve('file-tree-test-workspace');
  dependencies.workspace.readOnlyRoot = null;

  const service = createFileTreeService(dependencies);
  await assert.rejects(
    service.readTextFile('project-1', siblingPath),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 403
      && error.code === 'PATH_OUTSIDE_PROJECT',
  );
});

test('a file in another folder of the workspace can be read, but never written to', { skip: repoUnderReadOnlyRoot }, async () => {
  // Both sit beside this file, outside every read-only root, for the reason
  // given in the symlink test above; only the workspace-root grant may admit
  // the sibling file, so the temp roots must stay out of the picture.
  const workspaceRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-workspace-'));
  const projectRoot = path.join(workspaceRoot, 'project');
  const siblingDirectory = path.join(workspaceRoot, 'packages', 'run-1');
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.mkdir(projectRoot, { recursive: true });
    await fsPromises.mkdir(siblingDirectory, { recursive: true });
    const reportPath = path.join(siblingDirectory, 'report.md');
    await fsPromises.writeFile(reportPath, 'what the run found', 'utf8');
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(workspaceRoot, 'escape'));

    const service = createRealFileSystemService(projectRoot, workspaceRoot);

    const opened = await service.readTextFile('project-1', reportPath);
    assert.equal(opened.content, 'what the run found');
    const streamed = await service.openFile('project-1', reportPath);
    streamed.stream.destroy();

    // 聊天链接的可点性走批量探测接口，工作区根下的路径必须同样给出 200。
    const probes = await service.checkPathsExist([{ id: 'sibling', path: reportPath, projectId: 'p' }]);
    assert.deepEqual(probes, [{ id: 'sibling', status: 200 }]);

    await assert.rejects(
      service.saveTextFile('project-1', reportPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: reportPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.equal(await fsPromises.readFile(reportPath, 'utf8'), 'what the run found');

    // 工作区里的符号链接不能打开它指向的外部文件。
    await assert.rejects(
      service.readTextFile('project-1', path.join(workspaceRoot, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('image inspection canonicalizes project files and rejects symlink escapes, traversal and directories', async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cloudcli-image-policy-'));
  try {
    const project = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    await fsPromises.mkdir(project);
    await fsPromises.mkdir(outside);
    await fsPromises.writeFile(path.join(project, 'ok.png'), 'PNG');
    await fsPromises.writeFile(path.join(outside, 'secret.png'), 'SECRET');
    await fsPromises.symlink(path.join(outside, 'secret.png'), path.join(project, 'escape.png'));
    await fsPromises.symlink(path.join(project, 'ok.png'), path.join(project, 'inside.png'));
    const dependencies = createDependencies(createFakeFileSystem({ realpath: fsPromises.realpath, stat: fsPromises.stat }), project, [outside]);
    dependencies.resolveMimeType = () => 'image/png';
    const service = createFileTreeService(dependencies);
    assert.equal((await service.resolveImagePath({ path: 'inside.png', projectId: 'p', external: false })).path, await fsPromises.realpath(path.join(project, 'ok.png')));
    for (const candidate of ['escape.png', '../outside/secret.png', '.']) {
      await assert.rejects(service.resolveImagePath({ path: candidate, projectId: 'p', external: false }));
    }
    assert.equal((await service.resolveImagePath({ path: path.join(outside, 'secret.png'), external: true })).path, await fsPromises.realpath(path.join(outside, 'secret.png')));
    await assert.rejects(service.resolveImagePath({ path: 'secret.png', external: true }));
    await fsPromises.unlink(path.join(project, 'inside.png'));
    await fsPromises.symlink(path.join(outside, 'secret.png'), path.join(project, 'inside.png'));
    await assert.rejects(service.resolveImagePath({ path: 'inside.png', projectId: 'p', external: false }));
  } finally { await fsPromises.rm(root, { recursive: true, force: true }); }
});

test('checkPathsExist applies read boundaries without reading contents', async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cloudcli-path-exists-'));
  try {
    const project = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    await fsPromises.mkdir(path.join(project, 'reports'), { recursive: true });
    await fsPromises.mkdir(outside);
    await fsPromises.writeFile(path.join(project, 'readme.md'), 'doc');
    await fsPromises.writeFile(path.join(outside, 'secret.txt'), 'SECRET');
    await fsPromises.writeFile(path.join(root, 'secret.txt'), 'SECRET');
    const dependencies = createDependencies(createFakeFileSystem({ realpath: fsPromises.realpath, stat: fsPromises.stat }), project, [outside]);
    const service = createFileTreeService(dependencies);

    const results = await service.checkPathsExist([
      { id: 'relative-file', path: 'readme.md', projectId: 'p' },
      { id: 'relative-directory', path: 'reports/', projectId: 'p' },
      { id: 'relative-missing', path: 'nope.md', projectId: 'p' },
      { id: 'external-file', path: path.join(outside, 'secret.txt') },
      { id: 'external-missing', path: path.join(outside, 'gone.txt') },
      { id: 'outside-every-root', path: path.join(root, 'secret.txt'), projectId: 'p' },
      { id: 'project-absolute', path: path.join(project, 'readme.md'), projectId: 'p' },
      { id: 'relative-without-project', path: 'readme.md' },
      { id: 'traversal', path: '../outside/secret.txt', projectId: 'p' },
      { id: 'absolute-missing-outside-project', path: path.join(project, 'gone.md') },
    ]);

    assert.deepEqual(Object.fromEntries(results.map(({ id, status }) => [id, status])), {
      'relative-file': 200,
      'relative-directory': 200,
      'relative-missing': 404,
      'external-file': 200,
      'external-missing': 404,
      'outside-every-root': 403,
      'project-absolute': 200,
      'relative-without-project': 400,
      traversal: 403,
      'absolute-missing-outside-project': 404,
    });
  } finally { await fsPromises.rm(root, { recursive: true, force: true }); }
});
