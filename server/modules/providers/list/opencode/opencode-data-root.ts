/**
 * OpenCode Data Root
 *
 * Single source of truth for OpenCode CLI filesystem locations. Mirrors the
 * antigravity/zcode data-root convention so provider path knowledge lives in
 * the provider module rather than the global shared layer.
 *
 * @module opencode-data-root
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Resolves the OpenCode SQLite session database path.
 *
 * OpenCode stores session, message, part, and project metadata in one shared
 * `opencode.db` file under its XDG data directory. Provider readers and
 * synchronizers should use this path for read-only access and should never
 * store it as a deletable transcript path for an individual app session row.
 *
 * Consumers: opencode models, sessions, and session synchronizer providers.
 */
export function getOpenCodeDatabasePath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * Resolves OpenCode's own model-registry cache path.
 *
 * The file is models.dev data OpenCode refreshed for its registry; its
 * `providerID.modelID.limit.context` entries are the only place this app can
 * learn a model's context window without calling the gateway.
 *
 * Consumers: opencode models provider (live catalog overlay) and opencode
 * sessions provider (context-usage percent).
 */
export function getOpenCodeModelsCachePath(): string {
  return path.join(os.homedir(), '.cache', 'opencode', 'models.json');
}
