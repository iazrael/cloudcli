/**
 * ZCode Engine Crash stderr Test
 *
 * End-to-end against a real spawned engine stub: when the engine dies right
 * after spawn, the stderr it printed is the only explanation it ever gave.
 * The supervisor's tail buffer must carry it through the crash into both the
 * rejected in-flight request and the error row the chat stream shows.
 *
 * Lives in its own file because the shared runtime-test stub is a long-lived
 * app-server, and this stub deliberately crashes it.
 */

import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

import { protocolClient } from '../list/zcode/zcode-protocol.client.js';
import { ZCodeRuntimeProvider } from '../list/zcode/zcode-runtime.provider.js';
import { ZCodeSessionsProvider } from '../list/zcode/zcode-sessions.provider.js';

const crashDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'zcode-crash-'));
const crashStubPath = path.join(crashDir, 'zcode-crash.cjs');
fsSync.writeFileSync(crashStubPath, `#!/usr/bin/env node
process.stderr.write('EADDRINUSE: crash port busy\\n');
process.exit(1);
`);

const runtimeTestDbPath = path.join(crashDir, 'auth.db');
fsSync.writeFileSync(runtimeTestDbPath, '');
process.env.CLOUDCLI_ZCODE_ENGINE = crashStubPath;
process.env.DATABASE_PATH = runtimeTestDbPath;

before(async () => {
  await initializeDatabase();
});

const sessionsProvider = new ZCodeSessionsProvider();

const context: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'glm-5.3' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

const createWriter = (): { messages: NormalizedMessage[]; writer: ProviderRuntimeWriter } => {
  const messages: NormalizedMessage[] = [];
  const writer: ProviderRuntimeWriter = {
    userId: null,
    send: (data: unknown) => messages.push(data as NormalizedMessage),
    setSessionId: () => undefined,
  };
  return { messages, writer };
};

test('a crashing engine surfaces its stderr tail in the failure the user sees', async () => {
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  await assert.rejects(
    () => runtime.run('hello', { sessionId: 'app-crash', cwd: crashDir }, writer, context),
    /EADDRINUSE/,
    'the in-flight request rejection must carry the engine stderr',
  );

  const errorRow = messages.find((msg) => msg.kind === 'error');
  assert.ok(errorRow, 'the failure must surface as an error row');
  assert.ok(
    String(errorRow.content).includes('EADDRINUSE: crash port busy'),
    'the error row must carry the stderr tail',
  );
});

after(async () => {
  closeConnection();
  await protocolClient.shutdown();
  await rm(crashDir, { recursive: true, force: true });
});
