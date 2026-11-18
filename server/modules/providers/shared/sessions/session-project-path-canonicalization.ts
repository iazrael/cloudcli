/**
 * Session Project Path Canonicalization
 *
 * One rule deciding which stored project path a session directory discovered
 * inside engine storage maps to when the engine reports a different but
 * filesystem-equivalent spelling of the same directory. Engines that
 * canonicalize their working directory at startup (claude ≥ 2.1.327 resolves
 * symlinks, recording the physical `/Volumes/...` form for a project the user
 * opens through `/Users/...`) otherwise split one directory into two sidebar
 * projects: the synchronizer writes the engine-reported spelling into
 * `sessions.project_path`, `ensureProjectPath` registers a second project row
 * for it, and every later session keeps filing into the twin.
 *
 * The rule merges exact filesystem equivalents only: a reported path whose
 * `realpath` equals the `realpath` of an existing active project row maps
 * onto that row's stored spelling, preferring the equivalent with the most
 * sessions so a freshly split twin cannot outrun the original. Everything
 * else — brand-new directories, unresolvable paths — keeps the
 * engine-reported spelling, so project formation behaves exactly as before.
 *
 * Deliberately out of scope: sessions recorded inside a project's
 * subdirectory or one of its worktrees. `project/subdir` is a legitimately
 * different directory that today forms its own project, and worktree
 * reunification is the worktree placement policy's job; a prefix match here
 * would silently move both.
 *
 * Every session synchronizer — the SQLite skeleton (antigravity, zcode,
 * opencode) and the file-scanning indexers (claude, codex, cursor) — asks
 * this right after parsing the session directory, so one rule covers all
 * engines instead of each indexer growing its own workaround.
 *
 * @module session-project-path-canonicalization
 */

import fsSync from 'node:fs';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import type { ProjectRepositoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

/**
 * Resolves a session directory reported by an engine to the stored spelling
 * of an equivalent registered project, or returns it unchanged.
 *
 * Consumers: the session synchronizers listed in the module doc comment.
 * Synchronous on purpose: every caller sits in an async flow already, and the
 * fast path (the reported spelling is the directory's canonical form, the
 * case for every project without a symlinked ancestor) never touches the
 * database.
 */
export function canonicalizeSessionProjectPath(projectPath: string): string {
  const normalizedPath = normalizeProjectPath(projectPath);
  if (!normalizedPath) {
    return normalizedPath;
  }

  let resolvedPath: string;
  try {
    resolvedPath = normalizeProjectPath(fsSync.realpathSync.native(normalizedPath));
  } catch {
    // A path that cannot be resolved has no equivalent spelling to merge with.
    return normalizedPath;
  }

  // No early exit on `resolvedPath === normalizedPath`: the registered project
  // may sit under either spelling, and only the registry knows. The scan is
  // one SELECT plus a realpath per row over a project table the sidebar keeps
  // small, so the equivalence check is affordable on every rescan.
  const equivalentSpelling = resolveEquivalentProjectSpelling(resolvedPath);
  return equivalentSpelling ?? normalizedPath;
}

/**
 * Finds the stored spelling of the active project whose directory resolves to
 * `resolvedPath`, preferring the equivalent with the most sessions.
 *
 * A twin pair (the broken state this module heals) resolves both rows to the
 * same directory; the heavier side wins, so rescans drain the twin onto the
 * original instead of bouncing sessions back and forth. A tie — two empty
 * rows, which is exactly what a fresh split looks like before any rescan —
 * keeps the registry's first row. Archived rows never win: a user who
 * archived a twin decided it must not come back, and filing sessions into it
 * would resurrect it.
 */
function resolveEquivalentProjectSpelling(resolvedPath: string): string | null {
  let bestRow: ProjectRepositoryRow | null = null;
  let bestSessionCount = -1;

  for (const project of projectsDb.getProjectPaths()) {
    if (project.isArchived) {
      continue;
    }

    let projectResolvedPath: string;
    try {
      projectResolvedPath = normalizeProjectPath(fsSync.realpathSync.native(project.project_path));
    } catch {
      // A project whose directory vanished has no equivalent spelling.
      continue;
    }

    if (projectResolvedPath !== resolvedPath) {
      continue;
    }

    const sessionCount = sessionsDb.countSessionsByProjectPath(project.project_path);
    if (sessionCount > bestSessionCount) {
      bestRow = project;
      bestSessionCount = sessionCount;
    }
  }

  return bestRow?.project_path ?? null;
}
