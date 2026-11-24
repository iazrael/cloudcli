import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { resolveModelContextWindow } from '@/modules/providers/services/model-context-window.service.js';

const catalogBody = (families: Record<string, Record<string, number>>) => {
  const body: Record<string, unknown> = {};
  for (const [family, models] of Object.entries(families)) {
    body[family] = {
      models: Object.fromEntries(
        Object.entries(models).map(([modelId, context]) => [modelId, { limit: { context } }]),
      ),
    };
  }
  return JSON.stringify({ updatedAt: 1, digest: 'd', body: JSON.stringify(body) });
};

/** Runs one test against a throwaway HOME holding an OpenCode catalog database. */
async function withCatalog(
  families: Record<string, Record<string, number>> | null,
  body: () => Promise<void> | void,
): Promise<void> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'model-context-window-'));
  const originalHomedir = os.homedir;
  (os as any).homedir = () => homeDir;
  try {
    if (families) {
      const dbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
      await mkdir(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      try {
        db.exec('CREATE TABLE kv (key text PRIMARY KEY, value text NOT NULL);');
        db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(
          'models-dev:v2:catalog',
          catalogBody(families),
        );
      } finally {
        db.close();
      }
    }
    await body();
  } finally {
    (os as any).homedir = originalHomedir;
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function withConfiguredWindows(value: string | undefined, body: () => Promise<void> | void): Promise<void> {
  const previous = process.env.MODEL_CONTEXT_WINDOWS;
  if (value === undefined) delete process.env.MODEL_CONTEXT_WINDOWS;
  else process.env.MODEL_CONTEXT_WINDOWS = value;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.MODEL_CONTEXT_WINDOWS;
    else process.env.MODEL_CONTEXT_WINDOWS = previous;
  }
}

test('an explicit MODEL_CONTEXT_WINDOWS entry wins over the cached catalog', async () => {
  await withCatalog({ 'opencode-go': { 'deepseek-v4.1-flash': 1_000_000 } }, async () => {
    await withConfiguredWindows('deepseek-v4.1-flash=777777', () => {
      assert.equal(resolveModelContextWindow('deepseek-v4.1-flash'), 777_777);
    });
  });
});

test('the opencode-go family is preferred over other families', async () => {
  await withCatalog({
    opencode: { 'deepseek-v4.1-flash': 500_000 },
    'opencode-go': { 'deepseek-v4.1-flash': 1_000_000 },
    openrouter: { 'deepseek-v4.1-flash': 1_048_576 },
  }, () => {
    assert.equal(resolveModelContextWindow('deepseek-v4.1-flash'), 1_000_000);
  });
});

test('the opencode family is used when opencode-go has no entry', async () => {
  await withCatalog({
    opencode: { 'kimi-k3.1-pro': 1_048_576 },
    openrouter: { 'kimi-k3.1-pro': 1_048_576 },
  }, () => {
    assert.equal(resolveModelContextWindow('kimi-k3.1-pro'), 1_048_576);
  });
});

test('a model in several other families is used only when those families agree', async () => {
  await withCatalog({
    openrouter: { 'minimax-m3.1-flash': 1_000_000 },
    vercel: { 'minimax-m3.1-flash': 1_000_000 },
  }, () => {
    assert.equal(resolveModelContextWindow('minimax-m3.1-flash'), 1_000_000);
  });

  await withCatalog({
    openrouter: { 'minimax-m3.1-flash': 1_000_000 },
    scaleway: { 'minimax-m3.1-flash': 256_000 },
  }, () => {
    assert.equal(resolveModelContextWindow('minimax-m3.1-flash'), null);
  });
});

test('an unknown model or a missing catalog resolves to null', async () => {
  await withCatalog(null, () => {
    assert.equal(resolveModelContextWindow('deepseek-v4.1-flash'), null);
  });

  await withCatalog({ 'opencode-go': { 'deepseek-v4.1-flash': 1_000_000 } }, () => {
    assert.equal(resolveModelContextWindow('some-other-model'), null);
    assert.equal(resolveModelContextWindow(null), null);
  });
});

test('a refreshed catalog is re-read after the database changes', async () => {
  await withCatalog({ 'opencode-go': { 'deepseek-v4.1-flash': 1_000_000 } }, async () => {
    assert.equal(resolveModelContextWindow('deepseek-v4.1-flash'), 1_000_000);

    const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
    const db = new Database(dbPath);
    try {
      db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(
        catalogBody({ 'opencode-go': { 'deepseek-v4.1-flash': 2_000_000 } }),
        'models-dev:v2:catalog',
      );
    } finally {
      db.close();
    }
    // Push the mtime forward explicitly: some filesystems keep the same
    // timestamp for writes inside one test tick.
    const future = new Date(Date.now() + 5_000);
    await utimes(dbPath, future, future);

    assert.equal(resolveModelContextWindow('deepseek-v4.1-flash'), 2_000_000);
  });
});
