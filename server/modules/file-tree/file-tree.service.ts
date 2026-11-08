import path from 'node:path';

import ignore, { type Ignore } from 'ignore';

import type {
  FileTreeDirectoryEntry,
  FileTreeDirectoryListing,
  FileTreeFileSystem,
  FileTreeNode,
  FileTreeSearchMatch,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import { AppError, errorStatusCode, FORBIDDEN_WORKSPACE_PATHS, normalizeProjectPath, resolvePathUnderRoots } from '@/shared/utils.js';

const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ...HARD_EXCLUDED_DIRECTORY_NAMES,
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache', '.vercel',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

// One directory listing stops reading here so a directory holding millions of
// entries cannot exhaust the server heap or flood the browser; the listing is
// returned with `truncated` set instead.
const MAXIMUM_DIRECTORY_ENTRIES = 5_000;

// A search index is a snapshot of the project's file list. It is rebuilt after
// this long so files written outside the File Tree API (agents, the terminal,
// git) show up in search without a manual refresh.
const SEARCH_INDEX_LIFETIME_MS = 15_000;
const MAXIMUM_CACHED_SEARCH_INDEXES = 8;
// Bounds the index of a pathologically broad project root (such as a home
// directory); searches then report `indexIncomplete`.
const MAXIMUM_INDEXED_FILES = 200_000;

/**
 * One ignore file in effect for a directory listing. `baseDirectory` is the
 * project-relative directory the rules are written against ('' for the root).
 */
type IgnoreLayer = { baseDirectory: string; matcher: Ignore };

/** One indexed search candidate with the lowercase forms matching uses. */
type SearchIndexEntry = {
  relativePath: string;
  lowerPath: string;
  lowerName: string;
  type: 'file' | 'directory';
};

type SearchIndex = { entries: SearchIndexEntry[]; incomplete: boolean; builtAt: number };

/**
 * Applies hard exclusions, the fallback directory names, and the ignore layers
 * from the lowest precedence (`.git/info/exclude`, then the root `.gitignore`)
 * to the highest (the directory's own `.gitignore`), so a deeper `!pattern`
 * re-includes what a shallower rule excluded, as git does.
 */
function isEntryVisible(
  entryRelativePath: string,
  isDirectory: boolean,
  layers: IgnoreLayer[],
  useFallbackDirectoryNames: boolean,
): boolean {
  if (isDirectory) {
    const name = path.posix.basename(entryRelativePath);
    if (HARD_EXCLUDED_DIRECTORY_NAMES.has(name)) return false;
    if (useFallbackDirectoryNames && IGNORED_DIRECTORY_NAMES.has(name)) return false;
  }

  let ignored = false;
  for (const layer of layers) {
    const layerRelativePath = layer.baseDirectory
      ? entryRelativePath.slice(layer.baseDirectory.length + 1)
      : entryRelativePath;
    const verdict = layer.matcher.test(isDirectory ? `${layerRelativePath}/` : layerRelativePath);
    if (verdict.ignored) {
      ignored = true;
    } else if (verdict.unignored) {
      ignored = false;
    }
  }
  return !ignored;
}

/** Best name matches first; see `FileTreeServices.searchFiles`. */
function rankSearchEntry(entry: SearchIndexEntry, tokens: string[], phrase: string): number {
  if (entry.lowerName === phrase) return 0;
  if (tokens.every((token) => entry.lowerName.includes(token))) {
    return entry.lowerName.startsWith(tokens[0] ?? '') ? 1 : 2;
  }
  return 3;
}

/**
 * Translates a filesystem failure while resolving or reading a requested
 * directory into the per-directory error the batch reports; anything
 * unexpected is rethrown and logged by the caller.
 */
function throwDirectoryReadError(error: unknown): never {
  switch (readErrorCode(error)) {
    case 'ENOENT':
      throw createFileTreeError('Directory not found', 404, 'FILE_TREE_PATH_NOT_FOUND');
    case 'ENOTDIR':
      throw createFileTreeError('Path is not a directory', 400, 'FILE_TREE_NOT_A_DIRECTORY');
    case 'EACCES':
    case 'EPERM':
      throw createFileTreeError('Permission denied', 403, 'FILE_TREE_PERMISSION_DENIED');
    default:
      throw error;
  }
}

function compareRelativePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

function resolvePathInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const normalizedProjectRoot = path.resolve(projectRoot) + path.sep;

  if (!resolvedPath.startsWith(normalizedProjectRoot)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

/**
 * Resolves `targetPath` and verifies it falls inside one of the injected
 * external read-only roots. Both the target and the roots are resolved
 * through `realpath` before the prefix check so a symlink planted inside a
 * root cannot point the read back outside the allowlist.
 */
async function resolvePathInsideExternalRoots(
  fileSystem: FileTreeFileSystem,
  externalReadOnlyRoots: string[],
  targetPath: string,
): Promise<string> {
  if (!path.isAbsolute(targetPath)) {
    throw createFileTreeError(
      'External file path must be absolute',
      403,
      'PATH_NOT_ALLOWED',
    );
  }

  const realRoots = await Promise.all(externalReadOnlyRoots.map(async (rootPath) => {
    try {
      return await fileSystem.realpath(rootPath);
    } catch {
      // A root that does not exist (for example the legacy tree on a fresh
      // install) simply allows nothing.
      return null;
    }
  }));

  let realTargetPath: string;
  try {
    realTargetPath = await fileSystem.realpath(path.resolve(targetPath));
  } catch (error) {
    mapFileSystemError(error, {
      ENOENT: { message: 'File not found', statusCode: 404 },
      EACCES: { message: 'Permission denied', statusCode: 403 },
    });
  }

  const isAllowed = realRoots.some((realRoot) => {
    if (!realRoot) {
      return false;
    }
    const normalizedRoot = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    return realTargetPath === realRoot || realTargetPath.startsWith(normalizedRoot);
  });

  if (!isAllowed) {
    throw createFileTreeError(
      'Path is not in an allowed external read-only root',
      403,
      'PATH_NOT_ALLOWED',
    );
  }

  return realTargetPath;
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, workspace, environment, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */
export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await dependencies.projects.getProjectPathById(projectId);
    if (!projectRoot) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return projectRoot;
  }

  // Search indexes keyed by project root, least recently used first, plus the
  // builds in flight so concurrent searches share one ripgrep run.
  const searchIndexes = new Map<string, SearchIndex>();
  const pendingSearchIndexes = new Map<string, Promise<SearchIndex>>();

  /** Drops a project's search index after the File Tree API changed its files. */
  function forgetSearchIndex(projectRoot: string): void {
    searchIndexes.delete(projectRoot);
    pendingSearchIndexes.delete(projectRoot);
  }

  /**
   * Describes one entry with `lstat` metadata. Returns null when the entry
   * vanished since it was listed or indexed; other metadata failures keep the
   * entry with placeholder metadata rather than hiding it.
   */
  async function describeEntry(itemPath: string, type: 'file' | 'directory'): Promise<FileTreeNode | null> {
    const item: FileTreeNode = {
      name: path.basename(itemPath),
      path: itemPath,
      type,
      size: 0,
      modified: null,
      permissions: '000',
      permissionsRwx: '---------',
    };

    await acquire();
    try {
      const stats = await fileSystem.lstat(itemPath);
      const ownerPermissions = (stats.mode >> 6) & 7;
      const groupPermissions = (stats.mode >> 3) & 7;
      const otherPermissions = stats.mode & 7;

      item.size = stats.size;
      item.modified = stats.mtime.toISOString();
      item.permissions = `${ownerPermissions}${groupPermissions}${otherPermissions}`;
      item.permissionsRwx = permissionBitsToRwx(ownerPermissions)
        + permissionBitsToRwx(groupPermissions)
        + permissionBitsToRwx(otherPermissions);
      if (stats.isSymbolicLink()) {
        item.isSymlink = true;
      }
    } catch (error) {
      if (readErrorCode(error) === 'ENOENT') {
        return null;
      }
    } finally {
      release();
    }

    return item;
  }

  /**
   * Resolves one requested directory to its path under the project root.
   *
   * The lexical check rejects `..` traversal and foreign absolute paths before
   * the filesystem is touched; the realpath check then rejects a symlink inside
   * the project that points out of it. The returned path stays under the
   * configured project root so node paths match the rest of the File Tree API.
   */
  async function resolveListableDirectory(
    projectRoot: string,
    realProjectRoot: string,
    requestPath: string,
  ): Promise<string> {
    const rootPath = path.resolve(projectRoot);
    const lexicalPath = path.resolve(rootPath, requestPath);
    if (lexicalPath !== rootPath && !lexicalPath.startsWith(rootPath + path.sep)) {
      throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
    }

    let realPath: string;
    try {
      realPath = await fileSystem.realpath(lexicalPath);
    } catch (error) {
      throwDirectoryReadError(error);
    }
    if (realPath !== realProjectRoot && !realPath.startsWith(realProjectRoot + path.sep)) {
      throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
    }
    // Pseudo-filesystems such as /proc are never valid project content.
    if (FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(lexicalPath))) {
      throw createFileTreeError('Path is a protected system directory', 403, 'PATH_NOT_ALLOWED');
    }
    return lexicalPath;
  }

  /**
   * The ignore rules of one project for the length of one request or index
   * build. Each ignore file is read and parsed at most once; a missing or
   * unreadable file simply contributes no rules.
   */
  function createIgnoreRules(rootPath: string) {
    const ignoreFiles = new Map<string, Promise<Ignore | null>>();
    const loadIgnoreFile = (relativeFilePath: string): Promise<Ignore | null> => {
      let loaded = ignoreFiles.get(relativeFilePath);
      if (!loaded) {
        loaded = fileSystem.readTextFile(path.join(rootPath, ...relativeFilePath.split('/')))
          .then((content) => ignore().add(content))
          .catch((error: unknown) => {
            const errorCode = readErrorCode(error);
            if (errorCode !== 'ENOENT' && errorCode !== 'ENOTDIR') {
              dependencies.logger.error(`Error reading ignore file "${relativeFilePath}" in "${rootPath}"`, error);
            }
            return null;
          });
        ignoreFiles.set(relativeFilePath, loaded);
      }
      return loaded;
    };

    return {
      /** Fallback directory names apply only to a root without a `.gitignore`. */
      async usesFallbackDirectoryNames(): Promise<boolean> {
        return (await loadIgnoreFile('.gitignore')) === null;
      },
      /** The layers in effect for entries of `relativeDirectory`, lowest precedence first. */
      async layersFor(relativeDirectory: string): Promise<IgnoreLayer[]> {
        const layers: IgnoreLayer[] = [];
        const exclude = await loadIgnoreFile('.git/info/exclude');
        if (exclude) layers.push({ baseDirectory: '', matcher: exclude });
        const rootGitignore = await loadIgnoreFile('.gitignore');
        if (rootGitignore) layers.push({ baseDirectory: '', matcher: rootGitignore });
        const segments = relativeDirectory ? relativeDirectory.split('/') : [];
        for (let depth = 1; depth <= segments.length; depth += 1) {
          const baseDirectory = segments.slice(0, depth).join('/');
          const matcher = await loadIgnoreFile(`${baseDirectory}/.gitignore`);
          if (matcher) layers.push({ baseDirectory, matcher });
        }
        return layers;
      },
    };
  }

  async function listOneDirectory(
    rootPath: string,
    directoryPath: string,
    rules: ReturnType<typeof createIgnoreRules>,
  ): Promise<{ entries: FileTreeNode[]; truncated: boolean }> {
    const relativeDirectory = path.relative(rootPath, directoryPath).split(path.sep).join('/');
    const layers = await rules.layersFor(relativeDirectory);
    const useFallbackDirectoryNames = await rules.usesFallbackDirectoryNames();

    const visibleEntries: FileTreeDirectoryEntry[] = [];
    let truncated = false;
    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        const entryRelativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (!isEntryVisible(entryRelativePath, entry.isDirectory(), layers, useFallbackDirectoryNames)) {
          continue;
        }
        // Leaving the loop closes the directory stream, so the rest of a huge
        // directory is never read.
        if (visibleEntries.length >= MAXIMUM_DIRECTORY_ENTRIES) {
          truncated = true;
          break;
        }
        visibleEntries.push(entry);
      }
    } catch (error) {
      throwDirectoryReadError(error);
    } finally {
      release();
    }

    const described = await Promise.all(visibleEntries.map((entry) => describeEntry(
      path.join(directoryPath, entry.name),
      entry.isDirectory() ? 'directory' : 'file',
    )));
    const entries = described.filter((item): item is FileTreeNode => item !== null);
    entries.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
    return { entries, truncated };
  }

  /**
   * Symlinks in the given project directories that the ignore rules leave
   * visible. Ripgrep skips symlinks unless it follows them, and following them
   * would index files outside the project, so they are collected here by name
   * only, like the directory listing shows them.
   */
  async function listVisibleSymlinks(
    projectRoot: string,
    relativeDirectories: string[],
    rules: ReturnType<typeof createIgnoreRules>,
    useFallbackDirectoryNames: boolean,
  ): Promise<string[]> {
    const found = await Promise.all(relativeDirectories.map(async (relativeDirectory) => {
      const layers = await rules.layersFor(relativeDirectory);
      const links: string[] = [];
      await acquire();
      try {
        for await (const entry of fileSystem.openDirectory(path.join(projectRoot, ...relativeDirectory.split('/')))) {
          if (!entry.isSymbolicLink?.()) continue;
          const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
          if (isEntryVisible(relativePath, false, layers, useFallbackDirectoryNames)) {
            links.push(relativePath);
          }
        }
      } catch {
        // A directory that vanished or became unreadable since ripgrep listed
        // it contributes no symlinks.
      } finally {
        release();
      }
      return links;
    }));
    return found.flat();
  }

  async function buildSearchIndex(projectRoot: string): Promise<SearchIndex> {
    // Stamped before listing so the index never claims to be newer than it is.
    const builtAt = dependencies.now();
    const rules = createIgnoreRules(projectRoot);
    const useFallbackDirectoryNames = await rules.usesFallbackDirectoryNames();
    const listing = await dependencies.fileIndexer.listFiles({
      rootPath: projectRoot,
      excludedDirectoryNames: [...(useFallbackDirectoryNames ? IGNORED_DIRECTORY_NAMES : HARD_EXCLUDED_DIRECTORY_NAMES)],
      maximumFiles: MAXIMUM_INDEXED_FILES,
    });
    const { incomplete } = listing;

    // The index lists files only; directories are derived from their paths, so
    // an empty directory is not searchable.
    const directories = new Set<string>();
    for (const file of listing.files) {
      for (let separator = file.indexOf('/'); separator !== -1; separator = file.indexOf('/', separator + 1)) {
        directories.add(file.slice(0, separator));
      }
    }
    const symlinks = await listVisibleSymlinks(projectRoot, ['', ...directories], rules, useFallbackDirectoryNames);
    const files = [...listing.files, ...symlinks.slice(0, Math.max(0, MAXIMUM_INDEXED_FILES - listing.files.length))];
    const toEntry = (relativePath: string, type: 'file' | 'directory'): SearchIndexEntry => {
      const lowerPath = relativePath.toLowerCase();
      return { relativePath, lowerPath, lowerName: path.posix.basename(lowerPath), type };
    };
    const entries = [
      ...files.map((file) => toEntry(file, 'file')),
      ...[...directories].map((directory) => toEntry(directory, 'directory')),
    ].sort((left, right) => compareRelativePaths(left.relativePath, right.relativePath));
    return { entries, incomplete, builtAt };
  }

  async function loadSearchIndex(projectRoot: string): Promise<SearchIndex> {
    const cached = searchIndexes.get(projectRoot);
    if (cached && dependencies.now() - cached.builtAt < SEARCH_INDEX_LIFETIME_MS) {
      // Re-inserting keeps the Map ordered from least to most recently used.
      searchIndexes.delete(projectRoot);
      searchIndexes.set(projectRoot, cached);
      return cached;
    }

    const pending = pendingSearchIndexes.get(projectRoot);
    if (pending) return pending;

    const build = buildSearchIndex(projectRoot);
    pendingSearchIndexes.set(projectRoot, build);
    try {
      const index = await build;
      // A write that invalidated the project while ripgrep ran also dropped
      // this build, so a possibly stale listing is used once but not cached.
      if (pendingSearchIndexes.get(projectRoot) === build) {
        searchIndexes.delete(projectRoot);
        searchIndexes.set(projectRoot, index);
        while (searchIndexes.size > MAXIMUM_CACHED_SEARCH_INDEXES) {
          const leastRecentlyUsed = searchIndexes.keys().next().value;
          if (leastRecentlyUsed === undefined) break;
          searchIndexes.delete(leastRecentlyUsed);
        }
      }
      return index;
    } finally {
      if (pendingSearchIndexes.get(projectRoot) === build) {
        pendingSearchIndexes.delete(projectRoot);
      }
    }
  }

  /**
   * Resolves a directory the browser may list.
   *
   * The read-only roots (the system temp directory and the Claude projects
   * directory, see `READ_ONLY_ROOTS` in shared/utils) are browsable but never
   * writable, so they are checked before the workspace policy rejects them.
   * `createWorkspaceFolder` deliberately does not do this, which is what keeps
   * them read-only.
   */
  async function resolveBrowsablePath(targetPath: string): Promise<string> {
    const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
    if (readOnlyPath) {
      return readOnlyPath;
    }

    const validation = await dependencies.workspace.validatePath(targetPath);
    if (!validation.valid) {
      throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
    }

    return validation.resolvedPath || targetPath;
  }

  /**
   * Resolves a path the viewer is allowed to read.
   *
   * A file reference in a transcript is normally inside the project, but a
   * background command's log lives in the system temp directory and a
   * background agent's output file is a link from there into the Claude
   * projects directory, and the transcript quotes those paths verbatim. Those
   * resolve through the read-only root policy instead of the project root.
   *
   * The agent may also point at a file in another folder of the workspace, the
   * same tree `browseWorkspace` lists, so anything under the workspace root is
   * readable too. Symlinks are resolved before that comparison. The writing
   * endpoints keep using `resolvePathInsideProject` alone, so nothing outside
   * the project can be changed.
   */
  async function resolveReadablePath(projectRoot: string, targetPath: string): Promise<string> {
    if (path.isAbsolute(targetPath)) {
      const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
      if (readOnlyPath) {
        return readOnlyPath;
      }

      // workspace gateway 的 readOnlyRoot 为 null 表示工作区根读被显式关闭
      // （WORKSPACES_ROOT 误配系统目录），此时直接落回项目根校验。
      const workspaceReadOnlyRoot = dependencies.workspace.readOnlyRoot;
      if (workspaceReadOnlyRoot) {
        const workspacePath = await resolvePathUnderRoots(targetPath, [workspaceReadOnlyRoot]);
        if (workspacePath) {
          return workspacePath;
        }
      }

      if (dependencies.resolveWorktreeRoots) {
        try {
          const worktreeRoots = await dependencies.resolveWorktreeRoots(projectRoot);
          if (worktreeRoots.length > 0) {
            return await resolvePathInsideExternalRoots(fileSystem, worktreeRoots, targetPath);
          }
        } catch {
          // Not inside a worktree root, fall through to project check
        }
      }
    }

    return resolvePathInsideProject(projectRoot, targetPath);
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  async function resolveExternalAllowedRoots(projectId?: string): Promise<string[]> {
    if (!projectId || !dependencies.resolveWorktreeRoots) {
      return dependencies.externalReadOnlyRoots;
    }

    try {
      const projectRoot = await resolveProjectRoot(projectId);
      const worktreeRoots = await dependencies.resolveWorktreeRoots(projectRoot);
      if (worktreeRoots.length > 0) {
        return [...dependencies.externalReadOnlyRoots, ...worktreeRoots];
      }
    } catch {
      // If project resolution fails, fall back to default external roots
    }

    return dependencies.externalReadOnlyRoots;
  }

  return {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, inputPath)
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const resolvedPath = await resolveBrowsablePath(targetPath);

      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      // Only folder names are suggested, so no metadata is read. An unreadable
      // folder suggests nothing rather than failing the browse.
      const directoryNames: string[] = [];
      await acquire();
      try {
        for await (const entry of fileSystem.openDirectory(resolvedPath)) {
          if (entry.isDirectory() && !IGNORED_DIRECTORY_NAMES.has(entry.name)) {
            directoryNames.push(entry.name);
            if (directoryNames.length >= MAXIMUM_DIRECTORY_ENTRIES) break;
          }
        }
      } catch (error) {
        const errorCode = readErrorCode(error);
        if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
          dependencies.logger.error(`Error reading directory "${resolvedPath}"`, error);
        }
      } finally {
        release();
      }
      const directories = directoryNames
        .map((name) => ({ path: path.join(resolvedPath, name), name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: resolvedPath, suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: targetPath };
    },

    async readTextFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
        });
      }
    },

    async readExternalTextFile(filePath, projectId) {
      const allowedRoots = await resolveExternalAllowedRoots(projectId);
      const resolvedPath = await resolvePathInsideExternalRoots(
        fileSystem,
        allowedRoots,
        filePath,
      );
      try {
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }
    },

    async resolveImagePath(input) {
      let canonical: string;
      if (input.external) {
        canonical = await resolvePathInsideExternalRoots(fileSystem, await resolveExternalAllowedRoots(input.projectId), input.path);
      } else {
        if (!input.projectId) throw createFileTreeError('Project is required', 400, 'PROJECT_REQUIRED');
        const root = await resolveProjectRoot(input.projectId);
        const candidate = await resolveReadablePath(root, input.path);
        // 图片票据同时校验 realpath，防止项目内符号链接授权外部文件。
        if (candidate.startsWith(path.resolve(root) + path.sep)) {
          canonical = await resolvePathInsideExternalRoots(fileSystem, [root], candidate);
        } else {
          canonical = await fileSystem.realpath(candidate);
          await resolveReadablePath(root, canonical);
        }
      }
      const stats = await fileSystem.stat(canonical);
      if ((stats.mode & 0o170000) !== 0o100000) {
        throw createFileTreeError('Image must be a regular file', 403, 'INVALID_IMAGE_FILE');
      }
      return { path: canonical, contentType: dependencies.resolveMimeType(canonical) };
    },

    async openExternalFile(filePath, projectId) {
      const allowedRoots = await resolveExternalAllowedRoots(projectId);
      const resolvedPath = await resolvePathInsideExternalRoots(
        fileSystem,
        allowedRoots,
        filePath,
      );
      try {
        await fileSystem.access(resolvedPath);
      } catch {
        throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
      }

      return {
        contentType: dependencies.resolveMimeType(resolvedPath),
        stream: fileSystem.createReadStream(resolvedPath),
      };
    },

    async openFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        await fileSystem.access(resolvedPath);
      } catch {
        throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
      }

      return {
        contentType: dependencies.resolveMimeType(resolvedPath),
        stream: fileSystem.createReadStream(resolvedPath),
      };
    },

    async checkPathsExist(items) {
      return Promise.all(items.map(async ({ id, path: requestedPath, projectId }) => {
        try {
          if (path.isAbsolute(requestedPath)) {
            try {
              await fileSystem.stat(await resolvePathInsideExternalRoots(
                fileSystem,
                await resolveExternalAllowedRoots(projectId),
                requestedPath,
              ));
              return { id, status: 200 };
            } catch (error) {
              // 与图片签名一致：外部白名单拒绝且给了项目时，再按项目边界校验同一路径。
              if (!(error instanceof AppError && error.statusCode === 403) || !projectId) throw error;
            }
          } else if (!projectId) {
            throw createFileTreeError('Project is required', 400, 'PROJECT_REQUIRED');
          }
          const projectRoot = await resolveProjectRoot(projectId);
          const candidate = await resolveReadablePath(projectRoot, requestedPath);
          // 项目内路径同样核对 realpath，防止项目内符号链接把探测放行到外部文件。
          const canonical = candidate.startsWith(path.resolve(projectRoot) + path.sep)
            ? await resolvePathInsideExternalRoots(fileSystem, [projectRoot], candidate)
            : await fileSystem.realpath(candidate);
          await fileSystem.stat(canonical);
          return { id, status: 200 };
        } catch (error) {
          return {
            id,
            status: errorStatusCode(error),
          };
        }
      }));
    },

    async saveTextFile(projectId, filePath, content) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, filePath);
      try {
        await fileSystem.writeTextFile(resolvedPath, content);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }

      forgetSearchIndex(path.resolve(projectRoot));
      return { success: true, path: resolvedPath, message: 'File saved successfully' };
    },

    async listDirectories(projectId, paths) {
      const projectRoot = await resolveProjectRoot(projectId);
      let realProjectRoot: string;
      try {
        realProjectRoot = await fileSystem.realpath(projectRoot);
      } catch {
        throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
      }
      const rootPath = path.resolve(projectRoot);

      // Ignore files are shared by every directory of the batch.
      const rules = createIgnoreRules(rootPath);

      return Promise.all(paths.map(async (request): Promise<FileTreeDirectoryListing> => {
        try {
          const directoryPath = await resolveListableDirectory(rootPath, realProjectRoot, request);
          const { entries, truncated } = await listOneDirectory(rootPath, directoryPath, rules);
          return { request, path: directoryPath, entries, truncated };
        } catch (error) {
          if (error instanceof AppError) {
            return { request, error: { code: error.code, message: error.message } };
          }
          dependencies.logger.error(`Error listing directory "${request}" in "${rootPath}"`, error);
          return { request, error: { code: 'FILE_TREE_READ_FAILED', message: 'Unable to read directory' } };
        }
      }));
    },

    async searchFiles(input) {
      const projectRoot = path.resolve(await resolveProjectRoot(input.projectId));
      const index = await loadSearchIndex(projectRoot);

      const tokens = input.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const phrase = tokens.join(' ');
      const candidates = input.type === 'file'
        ? index.entries.filter((entry) => entry.type === 'file')
        : index.entries;
      // An empty query browses the index, which is already in path order.
      const matches = tokens.length === 0
        ? candidates
        : candidates
          .filter((entry) => tokens.every((token) => entry.lowerPath.includes(token)))
          .map((entry) => ({ entry, rank: rankSearchEntry(entry, tokens, phrase) }))
          .sort((left, right) => left.rank - right.rank
            || left.entry.relativePath.length - right.entry.relativePath.length
            || compareRelativePaths(left.entry.relativePath, right.entry.relativePath))
          .map(({ entry }) => entry);

      const described = await Promise.all(matches.slice(0, input.limit).map(async (entry) => {
        const node = await describeEntry(path.join(projectRoot, ...entry.relativePath.split('/')), entry.type);
        return node ? { ...node, relativePath: entry.relativePath } : null;
      }));
      return {
        results: described.filter((match): match is FileTreeSearchMatch => match !== null),
        truncated: matches.length > input.limit,
        indexIncomplete: index.incomplete,
      };
    },

    async createEntry(input) {
      validateFilename(input.name);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideProject(projectRoot, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      forgetSearchIndex(path.resolve(projectRoot));
      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedOldPath = resolvePathInsideProject(projectRoot, input.oldPath);

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideProject(projectRoot, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      forgetSearchIndex(path.resolve(projectRoot));
      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, input.targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      if (resolvedPath === path.resolve(projectRoot)) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      forgetSearchIndex(path.resolve(projectRoot));
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const projectRoot = await resolveProjectRoot(input.projectId);
        const resolvedTargetDirectory = !input.targetPath
          || input.targetPath === '.'
          || input.targetPath === './'
          ? path.resolve(projectRoot)
          : resolvePathInsideProject(projectRoot, input.targetPath);

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProject(projectRoot, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }

          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          await fileSystem.copyFile(file.temporaryPath, destinationPath);
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        forgetSearchIndex(path.resolve(projectRoot));
        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };
      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };
}
