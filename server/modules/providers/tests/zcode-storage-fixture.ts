import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { clearEnginePathCache } from '@/modules/providers/list/zcode/zcode-engine-path.js';

/**
 * Runs one test against an isolated ZCode storage tree: `ZCODE_STORAGE_DIR`
 * points at a fresh temp dir for the duration and is restored afterwards, so
 * the engine database, agent sidecars and config a test writes never touch
 * the developer's real `~/.zcode`.
 *
 * Engine resolution is pinned to a fixture bundle without a builtin provider
 * config, so readers of the engine's builtin table (reasoning specs, plan
 * catalogs, context windows) cannot leak the developer's real install into
 * assertions. The resolver caches per process, so it is reset around every
 * case.
 *
 * Consumers: the ZCode sessions and subagent tests.
 */
export async function withZCodeStorage(runTest: (storageDir: string) => Promise<void>): Promise<void> {
  const previous = process.env.ZCODE_STORAGE_DIR;
  const previousEngine = process.env.CLOUDCLI_ZCODE_ENGINE;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-sessions-'));
  process.env.ZCODE_STORAGE_DIR = tempDir;
  const enginePath = path.join(tempDir, 'engine', 'zcode.cjs');
  await mkdir(path.dirname(enginePath), { recursive: true });
  await writeFile(enginePath, '', 'utf8');
  process.env.CLOUDCLI_ZCODE_ENGINE = enginePath;
  clearEnginePathCache();

  try {
    await runTest(tempDir);
  } finally {
    if (previous === undefined) {
      delete process.env.ZCODE_STORAGE_DIR;
    } else {
      process.env.ZCODE_STORAGE_DIR = previous;
    }
    if (previousEngine === undefined) {
      delete process.env.CLOUDCLI_ZCODE_ENGINE;
    } else {
      process.env.CLOUDCLI_ZCODE_ENGINE = previousEngine;
    }
    clearEnginePathCache();
    await rm(tempDir, { recursive: true, force: true });
  }
}
