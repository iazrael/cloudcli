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
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    externalReadOnlyRoots,
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('listProjectFiles applies gitignore alongside hard directory exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const gitDirectory = path.join(projectRoot, '.git');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.git', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [createDirectoryEntry('build', true)];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('foo.md', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === documentationDirectory
        || candidatePath === buildDocumentationDirectory
        || candidatePath === sourceDirectory
        || candidatePath === gitDirectory
        || candidatePath === nodeModulesDirectory,
      0o754,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'src', 'README.md']);
  const documentationEntry = tree[0];
  assert.deepEqual(documentationEntry?.children?.map((entry) => entry.name), ['build']);
  assert.deepEqual(documentationEntry?.children?.[0]?.children?.map((entry) => entry.name), ['foo.md']);
  const sourceEntry = tree[1];
  assert.ok(sourceEntry);
  assert.equal(sourceEntry.type, 'directory');
  assert.equal(sourceEntry.permissions, '754');
  assert.equal(sourceEntry.permissionsRwx, 'rwxr-xr--');
  assert.deepEqual(sourceEntry.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(gitDirectory), false);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
});

test('listProjectFiles excludes gitignored entries only when requested', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const cacheDirectory = path.join(projectRoot, 'cache');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('cache', true),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('keep.log', false),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === cacheDirectory) {
        return [createDirectoryEntry('cached.txt', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === cacheDirectory || candidatePath === sourceDirectory,
      0o644,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['src', '.gitignore', 'keep.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(cacheDirectory), false);
});

test('listProjectFiles falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('node_modules', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [
          createDirectoryEntry('build', true),
          createDirectoryEntry('guide.md', false),
        ];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('generated.md', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(candidatePath === documentationDirectory, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'debug.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['guide.md']);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
  assert.equal(readDirectories.includes(buildDocumentationDirectory), false);
});

test('listProjectFiles rejects a tree that exceeds the server entry limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('listProjectFiles abandons a directory stream as soon as the entry limit is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the walk has to stop consuming the stream itself
    // instead of waiting for the directory listing to be materialized.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
  // The budget plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 10_001);
});

test('listProjectFiles shares the entry limit across nested directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const firstDirectory = path.join(projectRoot, 'first');
  const secondDirectory = path.join(projectRoot, 'second');
  const directoryPaths = new Set([firstDirectory, secondDirectory]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('first', true),
          createDirectoryEntry('second', true),
        ];
      }
      if (directoryPaths.has(directoryPath)) {
        return Array.from(
          { length: 5_000 },
          (_, index) => createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false),
        );
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
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

test('browseWorkspace returns available drives when requested on Windows', async () => {
  const fileSystem = createFakeFileSystem();
  const dependencies: FileTreeServiceDependencies = {
    ...createDependencies(fileSystem, path.resolve('file-tree-test-project')),
    getAvailableDrives: async () => ['C:\\', 'E:\\'],
  };
  const service = createFileTreeService(dependencies);

  if (process.platform === 'win32') {
    const result = await service.browseWorkspace('drives');
    assert.equal(result.path, 'drives');
    assert.deepEqual(result.drives, ['C:\\', 'E:\\']);
    assert.equal(result.suggestions.length, 2);
    assert.equal(result.suggestions[0]?.name, 'Local Disk (C:)');
    assert.equal(result.suggestions[1]?.name, 'Local Disk (E:)');
  }
});

test('browseWorkspace passes allowDriveRoot when validating candidate browse paths', async () => {
  let capturedOptions: { allowDriveRoot?: boolean } | undefined;
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => {},
    stat: async () => ({ isDirectory: () => true } as any),
    openDirectory: async function* () {},
  });
  const dependencies: FileTreeServiceDependencies = {
    ...createDependencies(fileSystem, projectRoot),
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath, options) => {
        capturedOptions = options;
        return { valid: true, resolvedPath: candidatePath };
      },
      resolveReadOnlyRootPath: async () => null,
    },
  };
  const service = createFileTreeService(dependencies);
  await service.browseWorkspace(projectRoot);
  assert.equal(capturedOptions?.allowDriveRoot, true);
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
function createRealFileSystemService(projectRoot: string): FileTreeServices {
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
      rootPath: projectRoot,
      validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
      resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    externalReadOnlyRoots: [],
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  });
}

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
    // The Windows temp directory sits under the home workspace root, so a
    // workspace folder may be created there by design.
    if (process.platform !== 'win32') {
      await assert.rejects(
        service.createWorkspaceFolder(path.join(temporaryDirectory, 'new-folder')),
        (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
      );
    }
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
