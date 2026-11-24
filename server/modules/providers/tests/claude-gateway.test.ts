import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearClaudeGatewayCache,
  isOpenCodeGateway,
} from '@/modules/providers/list/claude/claude-gateway.js';

/**
 * The OpenCode catalog is only a valid window source while Claude Code
 * actually calls the OpenCode gateway. These tests pin the detection: the
 * base URL from the server process env or the user's Claude settings, and
 * nothing else.
 */
async function withClaudeSettings(
  settingsEnv: Record<string, string> | null,
  body: () => Promise<void> | void,
): Promise<void> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'claude-gateway-'));
  const originalHomedir = os.homedir;
  const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  (os as any).homedir = () => homeDir;
  delete process.env.ANTHROPIC_BASE_URL;
  clearClaudeGatewayCache();
  try {
    if (settingsEnv) {
      await mkdir(path.join(homeDir, '.claude'), { recursive: true });
      await writeFile(
        path.join(homeDir, '.claude', 'settings.json'),
        JSON.stringify({ env: settingsEnv }),
      );
    }
    await body();
  } finally {
    clearClaudeGatewayCache();
    (os as any).homedir = originalHomedir;
    if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    await rm(homeDir, { recursive: true, force: true });
  }
}

test('the OpenCode gateway is detected from the Claude settings env block', async () => {
  await withClaudeSettings(
    { ANTHROPIC_BASE_URL: 'https://opencode.ai/inference/go/anthropic' },
    () => {
      assert.equal(isOpenCodeGateway(), true);
    },
  );
});

test('the OpenCode gateway is detected from the process env, which wins', async () => {
  await withClaudeSettings(
    { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.opencode.ai/v1';
      clearClaudeGatewayCache();
      assert.equal(isOpenCodeGateway(), true);
    },
  );
});

test('other endpoints and an empty configuration are not the OpenCode gateway', async () => {
  await withClaudeSettings({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, () => {
    assert.equal(isOpenCodeGateway(), false);
  });

  await withClaudeSettings(
    { ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic' },
    () => {
      assert.equal(isOpenCodeGateway(), false);
    },
  );

  await withClaudeSettings(null, () => {
    assert.equal(isOpenCodeGateway(), false);
  });
});

test('the detection is cached for a short while and can be refreshed', async () => {
  await withClaudeSettings({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, async () => {
    assert.equal(isOpenCodeGateway(), false);

    // Rewriting the settings file does not flip the cached answer…
    await writeFile(
      path.join(os.homedir(), '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://opencode.ai/x' } }),
    );
    assert.equal(isOpenCodeGateway(), false);

    // …but the next refresh reads the new configuration.
    clearClaudeGatewayCache();
    assert.equal(isOpenCodeGateway(), true);
  });
});
