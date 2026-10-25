#!/usr/bin/env node
// Live probe for the Claude live-process reuse contract.
//
// Guards the SDK/CLI behaviour the claude runtime's background-work hold
// depends on: (1) a second user message can be pushed into a CLI process that
// is already running a background Bash task, without that task being killed,
// (2) the CLI echoes the client uuid on the turn's result (how the runtime
// binds a result to the turn that submitted it), and (3) background tasks are
// reported through `background_tasks_changed` / `task_started` frames (how
// the runtime decides the process must stay alive).
//
// The probe drives a real Claude CLI (no server needed) and makes a handful of
// small model calls; it uses `persistSession: false` so nothing lands in
// ~/.claude/projects.
//
// Usage: npx tsx --tsconfig server/tsconfig.json scripts/probe/claude-bg-reuse-probe.mjs
// Set CLAUDE_CLI_PATH to override the CLI executable, as in production.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bg-probe-'));
const marker = path.join(cwd, 'bg-done.txt');

const queue = [];
let wake = null;
let released = false;
const stream = (async function* () {
  while (!released) {
    while (queue.length > 0) yield queue.shift();
    if (released) break;
    await new Promise((resolve) => { wake = resolve; });
    wake = null;
  }
})();

function push(content) {
  const uuid = crypto.randomUUID();
  queue.push({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid,
    timestamp: new Date().toISOString(),
  });
  wake?.();
  return uuid;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.error(`[probe] timed out waiting for ${label}`);
  return false;
}

const executable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
const queryInstance = query({
  prompt: stream,
  options: {
    cwd,
    persistSession: false,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
  },
});

const firstUuid = push(
  `Use the Bash tool with run_in_background=true to run this exact command: "sleep 40 && echo done > ${marker.replace(/\\/g, '/')}". `
  + 'After the tool call returns, reply with exactly: STARTED',
);

let sawBackgroundTasksChanged = false;
let sawTaskStarted = false;
const results = [];

const reader = (async () => {
  for await (const message of queryInstance) {
    if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
      sawBackgroundTasksChanged = true;
    }
    if (message.type === 'system' && message.subtype === 'task_started' && message.is_backgrounded === true) {
      sawTaskStarted = true;
    }
    if (message.type === 'result') {
      const claimed = Array.isArray(message.user_message_uuids)
        ? message.user_message_uuids
        : (typeof message.user_message_uuid === 'string' ? [message.user_message_uuid] : []);
      results.push({ claimed });
    }
  }
})();

const checks = [];
try {
  checks.push(['first turn produced a result', await waitFor(() => results.length >= 1, 120000, 'first result')]);

  const secondUuid = push('Reply with exactly: PING');
  checks.push(['second turn produced a result', await waitFor(() => results.length >= 2, 120000, 'second result')]);
  checks.push(['the background task survived the second turn', !fs.existsSync(marker)]);

  checks.push(['background follow-up turn arrived', await waitFor(() => results.length >= 3, 90000, 'background follow-up result')]);
  checks.push(['the background task actually finished', fs.existsSync(marker)]);

  checks.push(['CLI echoed the first turn uuid', results[0]?.claimed.includes(firstUuid) === true]);
  checks.push(['CLI echoed the second turn uuid', results[1]?.claimed.includes(secondUuid) === true]);
  checks.push(['background task frames were emitted', sawBackgroundTasksChanged && sawTaskStarted]);
} finally {
  released = true;
  wake?.();
  try {
    await Promise.race([reader, new Promise((resolve) => setTimeout(resolve, 15000))]);
  } catch {
    // Reader errors during shutdown are expected noise.
  }
  queryInstance.close?.();
  fs.rmSync(cwd, { recursive: true, force: true });
}

let failed = false;
for (const [label, ok] of checks) {
  console.log(`[probe] ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error('[probe] RED: the live-process reuse contract regressed');
  process.exit(1);
}
console.log('[probe] GREEN: live-process reuse, uuid binding, and task frames all verified');
process.exit(0);
