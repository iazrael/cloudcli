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

test('the catalog is not consulted unless the caller allows it for its gateway', async () => {
  await withCatalog({ 'opencode-go': { 'deepseek-v4.1-flash': 1_000_000 } }, () => {
    // A gateway that is not OpenCode must not inherit OpenCode's cached numbers.
    assert.equal(resolveModelContextWindow('deepseek-v4.1-flash'), null);
    assert.equal(
      resolveModelContextWindow('deepseek-v4.1-flash', { allowCatalog: true }),
      1_000_000,
    );
  });
});

test('the opencode-go family is preferred over the opencode family', async () => {
  await withCatalog({
    opencode: { 'deepseek-v4.1-flash': 500_000 },
    'opencode-go': { 'deepseek-v4.1-flash': 1_000_000 },
  }, () => {
    assert.equal(
      resolveModelContextWindow('deepseek-v4.1-flash', { allowCatalog: true }),
      1_000_000,
    );
  });
});

test('the opencode family is used when opencode-go has no entry', async () => {
  await withCatalog({
    opencode: { 'kimi-k3.1-pro': 1_048_576 },
  }, () => {
    assert.equal(
      resolveModelContextWindow('kimi-k3.1-pro', { allowCatalog: true }),
      1_048_576,
    );
  });
});

test('models found only in other families are not borrowed', async () => {
  await withCatalog({
    anthropic: { 'claude-sonnet-5-5': 1_000_000 },
    openrouter: { 'minimax-m3.1-flash': 1_000_000 },
  }, () => {
    // Claude Models' own window and third-party families are not the OpenCode
    // gateway's declaration, so the catalog stays out of them.
    assert.equal(resolveModelContextWindow('claude-sonnet-5-5', { allowCatalog: true }), null);
    assert.equal(resolveModelContextWindow('minimax-m3.1-flash', { allowCatalog: true }), null);
  });
});

test('an unknown model or a missing catalog resolves to null', async () => {
  await withCatalog(null, () => {
    assert.equal(resolveModelContextWindow('deepseek-v4.1-flash', { allowCatalog: true }), null);
  });

  await withCatalog({ 'opencode-go': { 'deepseek-v4.1-flash': 1_000_000 } }, () => {
    assert.equal(resolveModelContextWindow('some-other-model', { allowCatalog: true }), null);
    assert.equal(resolveModelContextWindow(null, { allowCatalog: true }), null);
  });
});

test('a refreshed catalog is re-read after the database changes', async () => {
  await withCatalog({ 'opencode-go': { 'deepseek-v4.1-flash': 1_000_000 } }, async () => {
    assert.equal(
      resolveModelContextWindow('deepseek-v4.1-flash', { allowCatalog: true }),
      1_000_000,
    );

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

    assert.equal(
      resolveModelContextWindow('deepseek-v4.1-flash', { allowCatalog: true }),
      2_000_000,
    );
  });
});
