import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';

type SweepResult = { files: number; bytes: number };

type DerivedSweepOptions = {
  cutoffMs: number;
  dryRun?: boolean;
  assetsDir?: string;
};

type UploadSweepOptions = {
  cutoffMs: number;
  /** Every path that can mention an upload. An empty list refuses to run. */
  referenceRoots: string[];
  dryRun?: boolean;
  assetsDir?: string;
  readFileStream?: (filePath: string) => Readable;
};

/** Derived from a transcript or an engine artifact, so reading history recreates them. */
const DERIVED_ASSET_PATTERN = /^(inline|zcode)-/;

/** The name an upload is stored under: its random id, then the original file name. */
const UPLOAD_NAME_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i;

/** A run long enough to hold one id fragment, in any case. */
const ID_RUN_PATTERN = /[0-9a-f-]{17,}/gi;

const FRAGMENT_LENGTH = 17;

/** Keeps the tail of each chunk so an id split across two reads is still seen. */
const UPLOAD_ID_TAIL = 35;

async function listOldAssets(assetsDir: string, cutoffMs: number, pattern: RegExp) {
  const entries = await fs.readdir(assetsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const assets: { name: string; filePath: string; size: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const filePath = path.join(assetsDir, entry.name);
    const stats = await fs.lstat(filePath);
    if (stats.mtimeMs < cutoffMs) assets.push({ name: entry.name, filePath, size: stats.size });
  }
  return assets;
}

/**
 * Maps both ends of every wanted id to that id. SQLite spills long text into
 * overflow pages, each opening with a 4-byte pointer, so a stored id can have
 * junk bytes in the middle. One break always leaves an intact end of at least
 * 18 characters, so either end counts as a mention. Keeping an upload by
 * mistake costs a little disk; deleting one by mistake cannot be undone.
 */
function buildIdFragments(ids: Set<string>): Map<string, string> {
  const fragments = new Map<string, string>();
  for (const id of ids) {
    fragments.set(id.slice(0, FRAGMENT_LENGTH), id);
    fragments.set(id.slice(-FRAGMENT_LENGTH), id);
  }
  return fragments;
}

async function collectMentionedUploadIds(
  entryPath: string,
  scan: {
    fragments: Map<string, string>;
    mentioned: Set<string>;
    visited: Set<string>;
    readFileStream: (filePath: string) => Readable;
  },
): Promise<void> {
  let realPath: string;
  try {
    // Relocated engine data is often a symlink, and skipping one would look
    // like an empty engine. Following it here makes it an ordinary scan.
    realPath = await fs.realpath(entryPath);
  } catch (error) {
    // A missing path means this engine has stored nothing there.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (scan.visited.has(realPath)) return;
  scan.visited.add(realPath);

  if ((await fs.stat(realPath)).isDirectory()) {
    for (const entry of await fs.readdir(realPath)) {
      await collectMentionedUploadIds(path.join(realPath, entry), scan);
    }
    return;
  }

  let tail = '';
  for await (const chunk of scan.readFileStream(realPath)) {
    // latin1 maps every byte to one character, so ASCII ids survive in binary files.
    const text = tail + (chunk as Buffer).toString('latin1');
    for (const [run] of text.matchAll(ID_RUN_PATTERN)) {
      const lower = run.toLowerCase();
      for (let index = 0; index + FRAGMENT_LENGTH <= lower.length; index += 1) {
        const id = scan.fragments.get(lower.slice(index, index + FRAGMENT_LENGTH));
        if (id) scan.mentioned.add(id);
      }
    }
    tail = text.slice(-UPLOAD_ID_TAIL);
  }
}

/**
 * Removes derived images older than the cutoff. Nothing tracks which session
 * uses them, and nothing needs to: the next history read recreates a missing
 * one while its source exists. Used by the providers module's storage cleanup.
 */
export async function sweepDerivedAssets({
  cutoffMs,
  dryRun = false,
  assetsDir = getGlobalImageAssetsDir(),
}: DerivedSweepOptions): Promise<SweepResult> {
  const assets = await listOldAssets(assetsDir, cutoffMs, DERIVED_ASSET_PATTERN);
  if (!dryRun) {
    await Promise.all(assets.map(({ filePath }) => fs.rm(filePath, { force: true })));
  }
  return { files: assets.length, bytes: assets.reduce((total, { size }) => total + size, 0) };
}

/**
 * Removes old uploads no stored conversation mentions. History keeps only the
 * path, so a mentioned upload must stay. Any unreadable path rejects before a
 * single file goes, because an incomplete scan cannot prove a file is unused.
 * Used by the providers module's storage cleanup.
 */
export async function sweepUnreferencedUploads({
  cutoffMs,
  referenceRoots,
  dryRun = false,
  assetsDir = getGlobalImageAssetsDir(),
  readFileStream = (filePath) => createReadStream(filePath, { highWaterMark: 1024 * 1024 }),
}: UploadSweepOptions): Promise<SweepResult> {
  if (referenceRoots.length === 0) {
    throw new Error('Refusing to sweep uploads without reference roots');
  }
  const uploads = await listOldAssets(assetsDir, cutoffMs, UPLOAD_NAME_PATTERN);
  // Nothing to prove, so the daily pass leaves every engine's storage unread.
  if (uploads.length === 0) return { files: 0, bytes: 0 };
  const idOf = (name: string) => UPLOAD_NAME_PATTERN.exec(name)![1].toLowerCase();
  const mentioned = new Set<string>();
  const scan = {
    fragments: buildIdFragments(new Set(uploads.map(({ name }) => idOf(name)))),
    mentioned,
    visited: new Set<string>(),
    readFileStream,
  };
  for (const rootPath of referenceRoots) {
    if (mentioned.size === uploads.length) break;
    await collectMentionedUploadIds(rootPath, scan);
  }

  const orphans = uploads.filter(({ name }) => !mentioned.has(idOf(name)));
  if (!dryRun) {
    await Promise.all(orphans.map(({ filePath }) => fs.rm(filePath, { force: true })));
  }
  return { files: orphans.length, bytes: orphans.reduce((total, { size }) => total + size, 0) };
}
