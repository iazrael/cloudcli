import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearEnginePathCache,
  getEngineVersion,
  readZCodeAppVersion,
  tryResolveEnginePath,
} from '@/modules/providers/list/zcode/zcode-engine-path.js';

/** Restores the previous CLOUDCLI_ZCODE_ENGINE value after each test. */
const withEngineEnv = async (engineValue: string | undefined, runTest: () => Promise<void>): Promise<void> => {
  const previous = process.env.CLOUDCLI_ZCODE_ENGINE;
  if (engineValue === undefined) {
    delete process.env.CLOUDCLI_ZCODE_ENGINE;
  } else {
    process.env.CLOUDCLI_ZCODE_ENGINE = engineValue;
  }

  clearEnginePathCache();

  try {
    await runTest();
  } finally {
    if (previous === undefined) {
      delete process.env.CLOUDCLI_ZCODE_ENGINE;
    } else {
      process.env.CLOUDCLI_ZCODE_ENGINE = previous;
    }
    clearEnginePathCache();
  }
};

test('tryResolveEnginePath prefers an existing CLOUDCLI_ZCODE_ENGINE file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-engine-'));
  const enginePath = path.join(tempDir, 'zcode.cjs');
  await writeFile(enginePath, '#!/usr/bin/env node\n', 'utf8');

  try {
    await withEngineEnv(enginePath, async () => {
      const resolved = tryResolveEnginePath();
      assert.equal(resolved, enginePath);

      // Cached: a second resolution returns the same path without re-stat.
      assert.equal(tryResolveEnginePath(), enginePath);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('tryResolveEnginePath ignores a CLOUDCLI_ZCODE_ENGINE value that is not a regular file', async () => {
  await withEngineEnv(path.join(os.tmpdir(), `missing-${Date.now()}.cjs`), async () => {
    const resolved = tryResolveEnginePath();

    // Falls through to platform discovery: either nothing is installed
    // (null) or an existing engine file is found - never the bogus override.
    if (resolved !== null) {
      assert.equal(fs.statSync(resolved).isFile(), true);
    }
  });
});

test('tryResolveEnginePath never throws on machines without ZCode', async () => {
  await withEngineEnv(undefined, async () => {
    // Whatever this machine has installed, the resolver must degrade to a
    // value or null instead of throwing (integration plan §3.2.4).
    const resolved = tryResolveEnginePath();
    assert.ok(resolved === null || typeof resolved === 'string');
  });
});

test('getEngineVersion returns null or a semver string without throwing', async () => {
  await withEngineEnv(undefined, async () => {
    const version = getEngineVersion();
    assert.ok(version === null || /^\d+\.\d+\.\d+$/.test(version));
  });
});

/** Builds a fake `ZCode.app/Contents` tree and returns its engine path. */
const createAppBundle = async (infoPlist: string | null): Promise<{ root: string; enginePath: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zcode-app-bundle-'));
  const contentsDir = path.join(root, 'ZCode.app', 'Contents');
  const engineDir = path.join(contentsDir, 'Resources', 'glm');
  await mkdir(engineDir, { recursive: true });
  const enginePath = path.join(engineDir, 'zcode.cjs');
  await writeFile(enginePath, '', 'utf8');
  if (infoPlist !== null) {
    await writeFile(path.join(contentsDir, 'Info.plist'), infoPlist, 'utf8');
  }
  return { root, enginePath };
};

const plistWithVersion = (version: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>CFBundleVersion</key>
    <string>9999</string>
    <key>CFBundleShortVersionString</key>
    <string>${version}</string>
</dict>
</plist>
`;

test('readZCodeAppVersion reads the short version from the enclosing app bundle', async () => {
  const { root, enginePath } = await createAppBundle(plistWithVersion('3.17.2'));
  try {
    assert.equal(readZCodeAppVersion(enginePath), '3.17.2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readZCodeAppVersion returns null outside an app bundle', async () => {
  const { root, enginePath } = await createAppBundle(null);
  try {
    assert.equal(readZCodeAppVersion(enginePath), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readZCodeAppVersion returns null when the plist has no usable version', async () => {
  const unusable = [
    '<plist><dict><key>CFBundleVersion</key><string>1.2.3</string></dict></plist>',
    plistWithVersion('not-a-version'),
    'bplist00\u0000binary',
  ];
  for (const content of unusable) {
    const { root, enginePath } = await createAppBundle(content);
    try {
      assert.equal(readZCodeAppVersion(enginePath), null, content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
