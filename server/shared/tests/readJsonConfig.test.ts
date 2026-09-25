import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJsonConfig } from '@/shared/utils.js';

/**
 * Engines and installers leave 0-byte config placeholders behind (agy's
 * `~/.gemini/config/mcp_config.json` on this machine did), and every MCP
 * provider goes through a read-modify-write with this helper — so an empty
 * file must read as "no configuration", not as a parse error.
 */
test('readJsonConfig treats a missing or empty file as no configuration', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'read-json-config-'));
  try {
    assert.deepEqual(await readJsonConfig(path.join(directory, 'missing.json')), {});

    const emptyPath = path.join(directory, 'empty.json');
    await writeFile(emptyPath, '');
    assert.deepEqual(await readJsonConfig(emptyPath), {});

    const whitespacePath = path.join(directory, 'whitespace.json');
    await writeFile(whitespacePath, '  \n\t');
    assert.deepEqual(await readJsonConfig(whitespacePath), {});

    const validPath = path.join(directory, 'valid.json');
    await writeFile(validPath, '{"mcpServers":{"a":{"command":"x"}}}');
    assert.deepEqual(await readJsonConfig(validPath), { mcpServers: { a: { command: 'x' } } });

    // Real corruption still surfaces instead of being silently discarded.
    const corruptPath = path.join(directory, 'corrupt.json');
    await writeFile(corruptPath, '{not json');
    await assert.rejects(() => readJsonConfig(corruptPath), SyntaxError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
