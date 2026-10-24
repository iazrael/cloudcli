import { randomUUID } from 'node:crypto';
import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';

import mime from 'mime-types';
import multer from 'multer';

import { projectsDb } from '@/modules/database/index.js';
import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import {
  getAntigravityBrainRoots,
  getClaudeExternalReadOnlyRoots,
  getZcodeExternalReadOnlyRoots,
} from '@/modules/providers/index.js';
import { getProjectWorktreeRoots } from '@/modules/worktrees/index.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';
import type {
  FileTreeFileSystem,
  FileTreeLogger,
  FileTreeProjectGateway,
  FileTreeWorkspaceGateway,
} from '@/shared/types.js';
import {
  WORKSPACES_ROOT,
  createByteLimitTransform,
  getAvailableWindowsDrives,
  resolveReadOnlyRootPath,
  validateWorkspacePath,
} from '@/shared/utils.js';

const MAXIMUM_UPLOAD_SIZE_MEGABYTES = 200;
const MAXIMUM_UPLOAD_SIZE_BYTES = MAXIMUM_UPLOAD_SIZE_MEGABYTES * 1024 * 1024;
const MAXIMUM_UPLOAD_FILE_COUNT = 20;

function readFileSystemConcurrency(): number {
  const configuredConcurrency = Number.parseInt(process.env.FS_CONCURRENCY ?? '', 10);
  return Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
    ? configuredConcurrency
    : 64;
}

/**
 * OS scratch directories where provider runtimes and their tools stage
 * throwaway artifacts such as generated HTML reports. Chat file links point
 * at these like at the Antigravity brain roots, so both the per-user temp
 * directory and the shared /tmp join the external read-only allowlist. The
 * set deduplicates platforms where `os.tmpdir()` already is /tmp, and an
 * entry that does not exist (for example /tmp on Windows) allows nothing.
 */
function getExternalTempRoots(): string[] {
  return Array.from(new Set([os.tmpdir(), '/tmp']));
}

/**
 * Operator-configured extra read-only roots from `CLOUDCLI_EXTRA_READ_ROOTS`,
 * separated by the platform path delimiter (`;` on Windows, `:` elsewhere).
 * Lets chat links to tool caches outside the workspace (for example a
 * screenshot cache under the home directory) open in the editor. Relative
 * entries are dropped because they would silently resolve against the server
 * cwd; list narrow directories, never the whole home, since every file under
 * a root becomes readable.
 */
function getConfiguredExtraReadRoots(): string[] {
  const configuredRoots = (process.env.CLOUDCLI_EXTRA_READ_ROOTS ?? '')
    .split(path.delimiter)
    .map((rootPath) => rootPath.trim())
    .filter(Boolean);

  return configuredRoots.filter((rootPath) => {
    if (path.isAbsolute(rootPath)) {
      return true;
    }
    console.warn(`[file-tree] Ignoring non-absolute CLOUDCLI_EXTRA_READ_ROOTS entry: ${rootPath}`);
    return false;
  });
}

/**
 * Production filesystem adapter owned by the File Tree composition root.
 * Application services receive this complete capability explicitly and never
 * import Node's mutable filesystem APIs themselves.
 */
const fileTreeFileSystem: FileTreeFileSystem = {
  access: (candidatePath) => fsPromises.access(candidatePath),
  stat: (candidatePath) => fsPromises.stat(candidatePath),
  lstat: (candidatePath) => fsPromises.lstat(candidatePath),
  // `opendir` streams entries in batches and the handle is closed by the
  // iterator protocol, including when the caller stops early at the entry cap.
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
  copyFile: (sourcePath, destinationPath) => fsPromises.copyFile(sourcePath, destinationPath),
  createReadStream: (filePath) => fs.createReadStream(filePath),
};

/**
 * Database boundary used only by File Tree production composition.
 * The Database module is consumed through its barrel; services and routes see
 * only the narrow project-path lookup contract.
 */
const fileTreeProjects: FileTreeProjectGateway = {
  getProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
};

/**
 * Workspace-policy boundary used only by File Tree production composition.
 * Keeping both the configured root and symlink-aware validator together makes
 * the path policy explicit for every service instance.
 */
const fileTreeWorkspace: FileTreeWorkspaceGateway = {
  rootPath: WORKSPACES_ROOT,
  validatePath: (candidatePath, options) => validateWorkspacePath(candidatePath, options),
  resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
};

const fileTreeLogger: FileTreeLogger = {
  error: (message, error) => console.error(message, error),
};

const fileTreeServices = createFileTreeService({
  fileSystem: fileTreeFileSystem,
  projects: fileTreeProjects,
  workspace: fileTreeWorkspace,
  resolveMimeType: (filePath) => mime.lookup(filePath) || 'application/octet-stream',
  fileSystemConcurrency: readFileSystemConcurrency(),
  logger: fileTreeLogger,
  getAvailableDrives: getAvailableWindowsDrives,
  // Providers store chat-referenced artifacts outside the active workspace:
  // Antigravity uses brain directories, Claude uses its per-project tree, and
  // ZCode uses narrow memory/skill/instruction paths. Attachments live in
  // ~/.cloudcli/assets, while provider runtimes stage temporary reports under
  // OS temp directories; operators may add more via CLOUDCLI_EXTRA_READ_ROOTS.
  // The editor may open these roots read-only without widening project-scoped
  // write access.
  externalReadOnlyRoots: [
    ...getAntigravityBrainRoots(),
    ...getClaudeExternalReadOnlyRoots(),
    getGlobalImageAssetsDir(),
    ...getExternalTempRoots(),
    ...getZcodeExternalReadOnlyRoots(),
    ...getConfiguredExtraReadRoots(),
  ],
  resolveWorktreeRoots: (projectRoot) => getProjectWorktreeRoots(projectRoot),
});

/**
 * Disk storage for file uploads that never writes more than `maxBytes`.
 *
 * Mirrors `multer.diskStorage` (same temp destination and
 * `cloudcli-file-upload-<uuid>` names) but routes the incoming stream through
 * `createByteLimitTransform`, because Multer's `fileSize + 1` Busboy limit
 * lets one extra byte reach a built-in storage before the abort. Open write
 * streams are tracked so `_removeFile` can wait for the descriptor to close
 * before unlinking (Windows refuses to unlink an open file), like Multer's
 * own disk storage.
 *
 * Consumer: `fileUploadMiddleware` below; exercised directly by
 * `server/modules/file-tree/tests/file-tree-upload-storage.test.ts`.
 */
export function createBoundedDiskStorage(maxBytes: number): multer.StorageEngine {
  const openStreams = new WeakMap<Express.Multer.File, fs.WriteStream>();

  return {
    _handleFile(_request, file, callback) {
      const destination = os.tmpdir();
      const filename = `cloudcli-file-upload-${randomUUID()}`;
      const finalPath = path.join(destination, filename);
      const output = fs.createWriteStream(finalPath);
      file.path = finalPath;
      openStreams.set(file, output);
      output.once('close', () => openStreams.delete(file));

      pipeline(file.stream, createByteLimitTransform(maxBytes), output, (error) => {
        if (error) {
          callback(error);
          return;
        }
        callback(null, {
          destination,
          filename,
          path: finalPath,
          size: output.bytesWritten,
        });
      });
    },

    _removeFile(_request, file, callback) {
      const finalPath = file.path;
      const mutableFile = file as { destination?: string; filename?: string; path?: string };

      delete mutableFile.destination;
      delete mutableFile.filename;
      delete mutableFile.path;

      if (!finalPath) {
        callback(null);
        return;
      }

      const unlink = () => {
        fs.unlink(finalPath, (error) => callback(error?.code === 'ENOENT' ? null : error));
      };

      const output = openStreams.get(file);
      if (!output || output.closed) {
        unlink();
        return;
      }

      // The descriptor is still open: wait for it to be released, whichever
      // way it goes, then unlink.
      function onReleased() {
        output!.removeListener('close', onReleased);
        output!.removeListener('error', onReleased);
        unlink();
      }
      output.once('close', onReleased);
      output.once('error', onReleased);
      output.destroy();
    },
  };
}

const fileUploadMiddleware = multer({
  storage: createBoundedDiskStorage(MAXIMUM_UPLOAD_SIZE_BYTES),
  limits: {
    fileSize: MAXIMUM_UPLOAD_SIZE_BYTES,
    files: MAXIMUM_UPLOAD_FILE_COUNT,
  },
}).array('files', MAXIMUM_UPLOAD_FILE_COUNT);

/**
 * File Tree router used by the server entrypoint to mount the authenticated
 * browsing, editing, file-management, and upload API under `/api/file-tree`.
 */
export const fileTreeRoutes = createFileTreeRouter(
  fileTreeServices,
  fileUploadMiddleware,
  {
    maximumFileSizeMegabytes: MAXIMUM_UPLOAD_SIZE_MEGABYTES,
    maximumFileCount: MAXIMUM_UPLOAD_FILE_COUNT,
  },
  fileTreeLogger,
);
