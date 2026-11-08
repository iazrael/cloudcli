import { spawn } from 'node:child_process';
import path from 'node:path';

import type { FileTreeFileIndexer } from '@/shared/types.js';

// Enough of ripgrep's stderr to explain a failure without buffering a flood of
// per-directory permission errors.
const MAXIMUM_CAPTURED_STDERR_BYTES = 4_096;

/**
 * Ripgrep-backed project file listing used by the File Tree composition root
 * (`file-tree.module.ts`) to build search indexes.
 *
 * Ripgrep applies every nested `.gitignore` and `.git/info/exclude`, also
 * outside git repositories (`--no-require-git`), while `.ignore`/`.rgignore`,
 * global and parent ignore files are switched off so search sees the same
 * files the directory listing shows. Output is NUL-separated so any file name
 * survives, and the child is killed as soon as `maximumFiles` is reached.
 */
export function createRipgrepFileIndexer(ripgrepPath: string): FileTreeFileIndexer {
  return {
    listFiles({ rootPath, excludedDirectoryNames, maximumFiles }) {
      const args = [
        '--files',
        '--hidden',
        '--null',
        '--no-require-git',
        '--no-ignore-dot',
        '--no-ignore-global',
        '--no-ignore-parent',
        '--no-config',
        // A trailing slash makes each glob match directories of that name at
        // any depth, the same rule the directory listing applies.
        ...excludedDirectoryNames.flatMap((name) => ['--glob', `!${name}/`]),
      ];

      return new Promise((resolve, reject) => {
        const child = spawn(ripgrepPath, args, { cwd: rootPath, stdio: ['ignore', 'pipe', 'pipe'] });
        const files: string[] = [];
        let pending = '';
        let stderr = '';
        let incomplete = false;

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (incomplete) return;
          const parts = (pending + chunk).split('\0');
          pending = parts.pop() ?? '';
          for (const part of parts) {
            if (files.length >= maximumFiles) {
              incomplete = true;
              child.kill();
              return;
            }
            files.push(path.sep === '/' ? part : part.split(path.sep).join('/'));
          }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          if (stderr.length < MAXIMUM_CAPTURED_STDERR_BYTES) {
            stderr += chunk.slice(0, MAXIMUM_CAPTURED_STDERR_BYTES - stderr.length);
          }
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (incomplete) {
            resolve({ files, incomplete: true });
            return;
          }
          // 1 means "no files"; 2 means some paths could not be read, which
          // still leaves a usable listing unless nothing was listed at all.
          if (code === 0 || code === 1 || (code === 2 && files.length > 0)) {
            resolve({ files, incomplete: false });
            return;
          }
          reject(new Error(`ripgrep exited with code ${code}: ${stderr.trim()}`));
        });
      });
    },
  };
}
