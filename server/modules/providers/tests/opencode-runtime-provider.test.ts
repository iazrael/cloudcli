/**
 * OpenCode runtime context-budget tests.
 *
 * OpenCode only reports token usage once a run finishes, which left the
 * composer's context badge frozen throughout a long tool loop. These tests
 * drive `spawnOpenCode` against a stub `opencode serve` (a PATH shim pointing
 * at a local HTTP server that replays the event envelope) and pin that a
 * `token_budget` frame is published while the turn is still running, in
 * addition to the frame the run tail always sent.
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { spawnOpenCode } from '@/modules/providers/list/opencode/opencode-runtime.provider.js';
import { shutdownOpenCodeServer } from '@/modules/providers/list/opencode/opencode-server.client.js';
import { OpenCodeSessionsProvider } from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const stubSessionId = 'ses_stub_live';

/**
 * Minimal OpenCode server: health probe, event stream, session create, and one
 * blocking message POST. The POST emits `message.updated` for an assistant
 * step and only then answers, so the runtime has to publish the running turn's
 * budget before the request resolves — exactly the ordering a real tool loop
 * produces.
 */
const openCodeStubScript = `const http = require('node:http');

const portIndex = process.argv.indexOf('--port');
const port = Number(process.argv[portIndex + 1]);
const sessionId = '${stubSessionId}';

let streamResponse = null;
let markStreamReady = null;
const streamReady = new Promise((resolve) => {
  markStreamReady = resolve;
});

const writeEvent = (payload) => {
  if (!streamResponse) {
    return;
  }
  streamResponse.write('data: ' + JSON.stringify({ directory: null, payload }) + '\\n\\n');
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (url.pathname === '/global/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ healthy: true }));
    return;
  }

  if (url.pathname === '/global/event') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    streamResponse = response;
    markStreamReady();
    return;
  }

  if (url.pathname === '/session' && request.method === 'POST') {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: sessionId }));
    return;
  }

  if (url.pathname === '/session/' + sessionId + '/message' && request.method === 'POST') {
    request.resume();
    void streamReady.then(() => {
      writeEvent({
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: { id: 'message-stub-assistant', role: 'assistant' },
        },
      });
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ info: { id: 'message-stub-assistant' } }));
      }, 300);
    });
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{}');
});

server.listen(port, '127.0.0.1');
`;

/** Writes a PATH entry that resolves the `opencode` command to the stub. */
async function writeOpenCodeShim(binDir: string, stubPath: string): Promise<void> {
  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, 'opencode.cmd'), `@echo off\r\nnode "${stubPath}" %*\r\n`);
    return;
  }

  const shimPath = path.join(binDir, 'opencode');
  await writeFile(shimPath, `#!/bin/sh\nexec node "${stubPath}" "$@"\n`);
  await chmod(shimPath, 0o755);
}

/**
 * Seeds the engine DB and model cache the live read consumes: one finished
 * assistant step at 52,027 tokens inside a 1M window.
 */
async function seedOpenCodeContextUsage(homeDir: string): Promise<void> {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );

      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)')
      .run(stubSessionId, 1_700_000_000_000, 1_700_000_002_000);
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
      .run(
        'message-stub-assistant',
        stubSessionId,
        1_700_000_001_000,
        1_700_000_002_000,
        JSON.stringify({
          role: 'assistant',
          providerID: 'opencode-go',
          modelID: 'deepseek-v4.1-flash',
          tokens: {
            total: 52_027,
            input: 13_510,
            output: 366,
            reasoning: 0,
            cache: { read: 38_151, write: 0 },
          },
        }),
      );
  } finally {
    db.close();
  }

  const cacheDir = path.join(homeDir, '.cache', 'opencode');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    path.join(cacheDir, 'models.json'),
    JSON.stringify({
      'opencode-go': {
        models: {
          'deepseek-v4.1-flash': { limit: { context: 1_000_000, output: 384_000 } },
        },
      },
    }),
  );
}

test('a running OpenCode turn publishes its context budget before it completes', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-live-budget-'));
  const binDir = path.join(tempRoot, 'bin');
  const previousPath = process.env.PATH;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHomeDir = os.homedir;

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();
  (os as unknown as { homedir: () => string }).homedir = () => tempRoot;

  try {
    await mkdir(binDir, { recursive: true });
    const stubPath = path.join(tempRoot, 'opencode-stub.cjs');
    await writeFile(stubPath, openCodeStubScript);
    await writeOpenCodeShim(binDir, stubPath);
    await seedOpenCodeContextUsage(tempRoot);

    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;

    const messages: NormalizedMessage[] = [];
    const writer: ProviderRuntimeWriter = {
      userId: null,
      send: (message) => {
        messages.push(message as NormalizedMessage);
      },
    };
    const sessionsProvider = new OpenCodeSessionsProvider();
    const context = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async (_sessionId: string | undefined, model?: string | null) =>
        model ?? 'opencode-go/deepseek-v4.1-flash',
      getProviderModels: async () => ({}),
      normalizeMessage: (raw: unknown, sessionId: string | null) =>
        sessionsProvider.normalizeMessage(raw, sessionId),
      isProviderInstalled: async () => true,
    } as unknown as ProviderRuntimeContext;

    await spawnOpenCode('hello', { sessionId: 'app-sess-live', cwd: tempRoot }, writer, context);

    const budgetFrames = messages.filter(
      (message) => message.kind === 'status' && message.text === 'token_budget',
    );
    const completeIndex = messages.findIndex((message) => message.kind === 'complete');
    assert.ok(completeIndex !== -1, 'the run must still end with a complete frame');
    // One frame while the prompt request was still pending, one from the run
    // tail. Before the mid-turn publish existed, only the tail frame arrived.
    assert.equal(budgetFrames.length, 2, 'a running turn must publish its context usage');

    const liveFrame = budgetFrames[0];
    assert.ok(liveFrame);
    assert.ok(
      messages.indexOf(liveFrame) < completeIndex,
      'the context frame must arrive before the terminal complete',
    );

    // The same shape `/token-usage` returns, addressed to the app session so
    // clients viewing another conversation ignore it.
    assert.equal(liveFrame.sessionId, 'app-sess-live');
    assert.deepEqual(liveFrame.tokenBudget, {
      used: 52_027,
      total: 1_000_000,
      inputTokens: 51_661,
      outputTokens: 366,
      breakdown: { input: 51_661, output: 366 },
      cumulative: { used: 52_027, inputTokens: 51_661, outputTokens: 366 },
    });
  } finally {
    shutdownOpenCodeServer();
    (os as unknown as { homedir: () => string }).homedir = previousHomeDir;
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
