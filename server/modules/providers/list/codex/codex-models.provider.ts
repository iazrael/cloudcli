import { readFile } from 'node:fs/promises';
import path from 'node:path';

import TOML from '@iarna/toml';

import { getCodexHome } from '@/shared/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderModelOption,
} from '@/shared/types.js';
import type { StaleWhileRefreshValue } from '@/shared/utils.js';
import {
  AppError,
  buildDefaultProviderCurrentActiveModel,
  createStaleWhileRefreshValue,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

import { codexAppServerTransport } from './codex-app-server.client.js';


const invalidCatalog = () => new AppError('Codex returned an invalid or empty model catalog.', {
  code: 'CODEX_MODEL_CATALOG_INVALID', statusCode: 502,
});

/** Reads only complete model entries so a broken refresh cannot replace a working catalog. */
function parseModel(value: unknown): ProviderModelOption | null {
  const entry = readObjectRecord(value);
  if (!entry) throw invalidCatalog();
  if (entry.hidden === true) return null;
  const modelId = readOptionalString(entry.model);
  const label = readOptionalString(entry.displayName);
  if (!modelId || !label || !Array.isArray(entry.supportedReasoningEfforts)) throw invalidCatalog();
  const values = entry.supportedReasoningEfforts.map((raw) => {
    const effort = readObjectRecord(raw);
    const value = readOptionalString(effort?.reasoningEffort);
    if (!value) throw invalidCatalog();
    const description = readOptionalString(effort?.description);
    return { value, ...(description ? { description } : {}) };
  });
  const defaultEffort = readOptionalString(entry.defaultReasoningEffort);
  if (defaultEffort && !values.some((item) => item.value === defaultEffort)) throw invalidCatalog();
  const description = readOptionalString(entry.description);
  return {
    value: modelId, label,
    ...(description ? { description } : {}),
    ...(values.length ? { effort: { ...(defaultEffort ? { default: defaultEffort } : {}), values } } : {}),
  };
}

/** Provider registry consumer: discovers models from the same bundled CLI used for conversations. */
export class CodexProviderModels implements IProviderModels {
  /**
   * Every turn reads the catalog, and listing it opens an app-server
   * connection, so only the first read waits; an expired catalog keeps serving
   * while it is re-listed. A failed refresh never replaces discovered models
   * with static guesses: the last catalog serves and the listing is retried
   * after a short back-off.
   */
  private readonly catalog: StaleWhileRefreshValue<ProviderModelsDefinition> = createStaleWhileRefreshValue({
    load: () => this.fetchModels(),
    ttlMs: () => 5 * 60_000,
    failureRetryMs: 10_000,
    onRefreshError: (error) => console.error('[Codex] Model catalog refresh failed:', error),
  });

  private async fetchModels(): Promise<ProviderModelsDefinition> {
    const connection = await codexAppServerTransport.open();
    try {
      const options = new Map<string, ProviderModelOption>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let defaultModel: string | undefined;
      do {
        const page = readObjectRecord(await connection.call('model/list', {
          limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}),
        }));
        if (!page || !Array.isArray(page.data)) throw invalidCatalog();
        for (const raw of page.data) {
          const option = parseModel(raw);
          if (!option) continue;
          options.set(option.value, option);
          if (readObjectRecord(raw)?.isDefault === true) defaultModel = option.value;
        }
        if (page.nextCursor != null && !readOptionalString(page.nextCursor)) throw invalidCatalog();
        cursor = readOptionalString(page.nextCursor) ?? undefined;
        if (cursor && cursors.has(cursor)) throw invalidCatalog();
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const first = options.values().next().value;
      if (!first) throw invalidCatalog();
      return { OPTIONS: [...options.values()], DEFAULT: defaultModel ?? first.value };
    } finally {
      connection.close();
    }
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return this.catalog.get();
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    let model: string | null = null;
    try {
      const raw = await readFile(path.join(getCodexHome(), 'config.toml'), 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      model = readOptionalString(parsed?.model) ?? null;
    } catch {
      // Missing or unreadable config uses the discovered default below.
    }
    return model ? { model } : buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
