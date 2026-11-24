/**
 * Model Context Window Service
 *
 * Single source of truth for the context window a model runs with when the
 * engine does not report one. Claude Code behind an Anthropic-compatible
 * gateway (for example the OpenCode inference endpoint) returns no
 * `modelUsage.contextWindow`, so the provider needs a local answer instead of
 * falling back to one server-wide default.
 *
 * The data source is the models.dev catalog the OpenCode CLI caches in its own
 * database (`kv` -> `models-dev:v2:catalog` / `models-dev:catalog`). It is a
 * local read-only file, refreshed by the CLI itself, and carries `limit.context`
 * per `<family>/<modelId>`.
 *
 * Consumers: the Claude runtime and transcript reader (window denominator), and
 * the OpenCode models provider (same catalog parsing for picker metadata).
 *
 * @module model-context-window
 */

import fs from 'node:fs';

import Database from 'better-sqlite3';

import { readJsonRecord, readObjectRecord } from '@/shared/utils.js';
import { getOpenCodeDatabasePath } from '@/modules/providers/list/opencode/opencode-data-root.js';

/** One catalog record; only `limit.context` is read here. */
export type LocalModelCatalogEntry = Record<string, unknown>;

/** `kv` keys of the cached models.dev catalog, newest layout first (v2.2 renamed it). */
const CATALOG_KV_KEYS = ['models-dev:v2:catalog', 'models-dev:catalog'];

/**
 * Families tried first when the caller only has the bare model id. Claude
 * served through the OpenCode gateway requests `deepseek-v4.1-flash`, while the
 * catalog keys it as `opencode-go/deepseek-v4.1-flash`.
 */
const PREFERRED_CATALOG_FAMILIES = ['opencode-go', 'opencode'];

type CatalogCache = {
  path: string;
  mtimeMs: number;
  entries: Map<string, LocalModelCatalogEntry>;
};

/** Parsed catalog, invalidated when the OpenCode database file changes. */
let catalogCache: CatalogCache | null = null;

function readCatalogFromDatabase(dbPath: string): Map<string, LocalModelCatalogEntry> {
  const entries = new Map<string, LocalModelCatalogEntry>();
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const readKey = db.prepare('SELECT value FROM kv WHERE key = ?');
      const row = CATALOG_KV_KEYS
        .map((key) => readKey.get(key) as { value?: string } | undefined)
        .find((candidate) => candidate?.value);
      const parsed = readJsonRecord(row?.value);
      let body: unknown = parsed?.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }
      const families = readObjectRecord(body) ?? {};
      for (const [familyId, family] of Object.entries(families)) {
        const models = readObjectRecord(readObjectRecord(family)?.models) ?? {};
        for (const [modelId, model] of Object.entries(models)) {
          const record = readObjectRecord(model);
          if (record) {
            entries.set(`${familyId}/${modelId}`, record);
          }
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // No database or no cached catalog: callers fall back to their defaults.
  }
  return entries;
}

/**
 * Reads every `<family>/<modelId>` entry of the locally cached models.dev
 * catalog. Consumer: the OpenCode models provider (display names, effort
 * tiers) and `resolveModelContextWindow` below.
 *
 * Parsing is cached by the database file's mtime, so a CLI refresh is picked up
 * on the next call without re-parsing the multi-megabyte JSON per request.
 */
export function readLocalModelCatalog(): Map<string, LocalModelCatalogEntry> {
  const dbPath = getOpenCodeDatabasePath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(dbPath).mtimeMs;
  } catch {
    catalogCache = null;
    return new Map();
  }
  if (catalogCache && catalogCache.path === dbPath && catalogCache.mtimeMs === mtimeMs) {
    return catalogCache.entries;
  }
  const entries = readCatalogFromDatabase(dbPath);
  catalogCache = { path: dbPath, mtimeMs, entries };
  return entries;
}

/** `model=window,model2=window2`; explicit entries win over the catalog. */
function readConfiguredWindows(): Map<string, number> {
  const windows = new Map<string, number>();
  for (const part of (process.env.MODEL_CONTEXT_WINDOWS ?? '').split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const modelId = part.slice(0, separator).trim();
    const window = Number(part.slice(separator + 1).trim());
    if (modelId && Number.isFinite(window) && window > 0) {
      windows.set(modelId, window);
    }
  }
  return windows;
}

function readContextLimit(entry: LocalModelCatalogEntry | undefined): number | null {
  const context = Number(readObjectRecord(entry?.limit)?.context);
  return Number.isFinite(context) && context > 0 ? context : null;
}

/**
 * Resolves the context window for one model id from local metadata.
 *
 * Order: `MODEL_CONTEXT_WINDOWS` (exact id), then the cached models.dev catalog
 * — the bare id as a full key, then the `opencode-go` / `opencode` families,
 * then any other family only when every match declares the same window. A
 * missing catalog, unknown model, or conflicting other-family windows answer
 * null so the caller keeps its own fallback instead of guessing.
 */
export function resolveModelContextWindow(modelId: string | null | undefined): number | null {
  const id = modelId?.trim();
  if (!id) {
    return null;
  }

  const configured = readConfiguredWindows().get(id);
  if (configured) {
    return configured;
  }

  const entries = readLocalModelCatalog();
  if (entries.size === 0) {
    return null;
  }

  // A caller that already passes `<family>/<id>` names the entry directly.
  const direct = readContextLimit(entries.get(id));
  if (direct) {
    return direct;
  }

  for (const family of PREFERRED_CATALOG_FAMILIES) {
    const limit = readContextLimit(entries.get(`${family}/${id}`));
    if (limit) {
      return limit;
    }
  }

  const otherFamilyLimits = new Set<number>();
  for (const [key, entry] of entries) {
    if (!key.endsWith(`/${id}`)) continue;
    const limit = readContextLimit(entry);
    if (limit) otherFamilyLimits.add(limit);
  }
  return otherFamilyLimits.size === 1 ? [...otherFamilyLimits][0] : null;
}
