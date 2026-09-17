import type { ChildProcess } from 'node:child_process';
import net from 'node:net';

import crossSpawn from 'cross-spawn';

import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/**
 * HTTP/SSE client for the OpenCode server (`opencode serve`).
 *
 * The OpenCode CLI's non-interactive `run` mode cannot surface tool
 * permissions: any `ask` rule is auto-rejected by the CLI itself, so the chat
 * has no way to render an approval card. The server exposes the primitives the
 * TUI uses instead — a session/message API, a `/global/event` event stream, and
 * `permission`/`question` reply endpoints — which this module drives.
 *
 * One server process is shared by every OpenCode run in the app. Requests carry
 * the target project through `?directory=`; events arrive on the single
 * `/global/event` stream wrapped in a `GlobalEvent` envelope, so the runtime
 * routes each payload to its run by `sessionID`.
 *
 * Consumers: `opencode-runtime.provider.js` (run/abort) and
 * `opencode-permission-bridge.ts` (approval cards).
 */

export type OpenCodeServerHandle = {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
};

/** One server event, unwrapped from the `/global/event` envelope. */
export type OpenCodeServerEvent = {
  readonly type: string;
  readonly properties: AnyRecord;
  readonly directory: string | null;
};

const SERVER_READY_TIMEOUT_MS = 30_000;
const SERVER_IDLE_SHUTDOWN_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 10 * 60_000;

type ServerState = {
  process: ChildProcess;
  baseUrl: string;
  headers: Record<string, string>;
  subscribers: Set<(event: OpenCodeServerEvent) => void>;
  refCount: number;
  idleTimer: NodeJS.Timeout | null;
  streamAbort: AbortController;
};

let serverState: ServerState | null = null;
let serverStarting: Promise<ServerState> | null = null;

/** Picks a free loopback port for the shared server. */
function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
          return;
        }
        reject(new Error('Could not reserve a loopback port for the OpenCode server.'));
      });
    });
  });
}

/** Basic-auth header for `opencode serve` when the user secured it. */
function openCodeServerAuthHeaders(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) {
    return {};
  }

  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  };
}

function buildUrl(baseUrl: string, path: string, directory: string | null): string {
  if (!directory) {
    return `${baseUrl}${path}`;
  }
  const separator = path.includes('?') ? '&' : '?';
  return `${baseUrl}${path}${separator}directory=${encodeURIComponent(directory)}`;
}

async function waitForServer(baseUrl: string, headers: Record<string, string>, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCode server exited before it was ready (code ${child.exitCode}).`);
    }

    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('OpenCode server did not become ready in time.');
}

async function readOpenCodeServerEventStream(state: ServerState): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${state.baseUrl}/global/event`, {
      headers: { accept: 'text/event-stream', ...state.headers },
      signal: state.streamAbort.signal,
    });
  } catch {
    return;
  }

  if (!response.ok || !response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatchEventChunk(state, chunk);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch {
    // Stream aborted at shutdown, or the server died; the next run restarts it.
  }
}

function dispatchEventChunk(state: ServerState, chunk: string): void {
  const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) {
    return;
  }

  let envelope: AnyRecord;
  try {
    envelope = JSON.parse(dataLine.slice(5).trim()) as AnyRecord;
  } catch {
    return;
  }

  const payload = readObjectRecord(envelope.payload) ?? envelope;
  const type = readOptionalString(payload.type);
  if (!type) {
    return;
  }

  const event: OpenCodeServerEvent = {
    type,
    properties: readObjectRecord(payload.properties) ?? {},
    directory: readOptionalString(envelope.directory) ?? null,
  };

  for (const subscriber of state.subscribers) {
    try {
      subscriber(event);
    } catch {
      // One misbehaving run must not stop delivery to the others.
    }
  }
}

async function startOpenCodeServer(): Promise<ServerState> {
  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', ...openCodeServerAuthHeaders() };
  const child = crossSpawn('opencode', ['serve', '--port', String(port)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  // Drain both pipes: an unread stream back-pressures the child and stalls it.
  child.stdout?.on('data', () => {});
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  try {
    await waitForServer(baseUrl, headers, child);
  } catch (error) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    const detail = stderrTail.trim() ? `: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}` : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
  }

  const state: ServerState = {
    process: child,
    baseUrl,
    headers,
    subscribers: new Set(),
    refCount: 0,
    idleTimer: null,
    streamAbort: new AbortController(),
  };

  void readOpenCodeServerEventStream(state);

  child.once('exit', () => {
    if (serverState === state) {
      serverState = null;
    }
    state.streamAbort.abort();
  });

  return state;
}

/**
 * Starts the shared server if needed and pins it against idle shutdown for the
 * duration of one run. Always pair with `releaseOpenCodeServer`.
 */
export async function acquireOpenCodeServer(): Promise<OpenCodeServerHandle> {
  if (serverState) {
    if (serverState.idleTimer) {
      clearTimeout(serverState.idleTimer);
      serverState.idleTimer = null;
    }
    serverState.refCount += 1;
    return { baseUrl: serverState.baseUrl, headers: serverState.headers };
  }

  if (!serverStarting) {
    serverStarting = startOpenCodeServer();
  }

  let state: ServerState;
  try {
    state = await serverStarting;
  } finally {
    serverStarting = null;
  }

  serverState = state;
  state.refCount += 1;
  return { baseUrl: state.baseUrl, headers: state.headers };
}

/** Drops one run's hold on the shared server; idle servers shut down later. */
export function releaseOpenCodeServer(): void {
  const state = serverState;
  if (!state) {
    return;
  }

  state.refCount = Math.max(0, state.refCount - 1);
  if (state.refCount > 0 || state.idleTimer) {
    return;
  }

  state.idleTimer = setTimeout(() => {
    if (serverState !== state || state.refCount > 0) {
      return;
    }
    serverState = null;
    state.streamAbort.abort();
    try {
      state.process.kill();
    } catch {
      // Already gone.
    }
  }, SERVER_IDLE_SHUTDOWN_MS);
  state.idleTimer.unref?.();
}

/** Subscribes to the shared event stream; returns an unsubscribe function. */
export function subscribeOpenCodeEvents(handler: (event: OpenCodeServerEvent) => void): () => void {
  const state = serverState;
  if (!state) {
    return () => {};
  }
  state.subscribers.add(handler);
  return () => {
    state.subscribers.delete(handler);
  };
}

async function requestJson(
  handle: OpenCodeServerHandle,
  method: 'POST' | 'GET',
  path: string,
  directory: string | null,
  body: unknown,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<unknown> {
  const url = buildUrl(handle.baseUrl, path, directory);
  const response = await fetch(url, {
    method,
    headers: handle.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const suffix = detail.trim() ? `: ${detail.trim().slice(0, 300)}` : '';
    const error = new Error(`OpenCode server ${method} ${path} failed (HTTP ${response.status})${suffix}`);
    (error as { status?: number }).status = response.status;
    throw error;
  }

  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Maps a UI permission mode onto the OpenCode agent the run should use.
 * `plan` is OpenCode's built-in read-only agent; the other modes keep the
 * caller's configured agent (default `build`).
 */
export function resolveOpenCodeAgent(permissionMode: string | undefined): string | undefined {
  return permissionMode === 'plan' ? 'plan' : undefined;
}

/**
 * Permission actions `acceptEdits` approves without asking, mirroring the
 * `{ edit: "allow" }` override the runtime used to pass to the CLI.
 */
const OPENCODE_EDIT_ACTIONS = new Set(['edit', 'write', 'patch']);

/**
 * Whether a permission request must be approved without asking the user.
 * `bypassPermissions` mirrors `opencode run --auto`: every request that is not
 * explicitly denied is answered `once` immediately. `acceptEdits` auto-approves
 * file-editing actions only; anything else still renders a card.
 */
export function shouldAutoApproveOpenCodePermission(
  permissionMode: string | undefined,
  permission?: string | null,
): boolean {
  if (permissionMode === 'bypassPermissions') {
    return true;
  }
  return permissionMode === 'acceptEdits'
    && typeof permission === 'string'
    && OPENCODE_EDIT_ACTIONS.has(permission);
}

/** Creates a provider-side session and returns its `ses_…` id. */
export async function createOpenCodeSession(
  handle: OpenCodeServerHandle,
  directory: string,
  model: { providerId: string; modelId: string } | null,
  agent: string | undefined,
): Promise<string> {
  const body: AnyRecord = {};
  if (model) {
    body.model = { id: model.modelId, providerID: model.providerId };
  }
  if (agent) {
    body.agent = agent;
  }

  const created = await requestJson(handle, 'POST', '/session', directory, body);
  const id = readOptionalString(readObjectRecord(created)?.id);
  if (!id) {
    throw new Error('OpenCode did not return a session id.');
  }
  return id;
}

/**
 * Sends one user turn and resolves when the assistant turn completes. Live
 * output arrives through the event stream meanwhile.
 */
export async function sendOpenCodeMessage(
  handle: OpenCodeServerHandle,
  directory: string,
  sessionId: string,
  input: {
    text: string;
    model: { providerId: string; modelId: string } | null;
    agent?: string;
    variant?: string;
  },
): Promise<void> {
  const body: AnyRecord = {
    parts: [{ type: 'text', text: input.text }],
  };
  if (input.model) {
    body.model = { providerID: input.model.providerId, modelID: input.model.modelId };
  }
  if (input.agent) {
    body.agent = input.agent;
  }
  if (input.variant) {
    body.variant = input.variant;
  }

  await requestJson(handle, 'POST', `/session/${encodeURIComponent(sessionId)}/message`, directory, body);
}

/** Requests cancellation of the running turn for one session. */
export async function abortOpenCodeSession(
  handle: OpenCodeServerHandle,
  directory: string,
  sessionId: string,
): Promise<void> {
  try {
    await requestJson(handle, 'POST', `/session/${encodeURIComponent(sessionId)}/abort`, directory, undefined, 15_000);
  } catch {
    // A run that already finished has nothing to abort.
  }
}

/**
 * Marks a session reverted at `messageId`: that message and everything after it
 * is dropped the next time a prompt is sent. Used by the edit flow, where the
 * replacement turn must not be appended to the conversation it replaces.
 */
export async function revertOpenCodeSession(
  handle: OpenCodeServerHandle,
  directory: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  await requestJson(
    handle,
    'POST',
    `/session/${encodeURIComponent(sessionId)}/revert`,
    directory,
    { messageID: messageId },
    30_000,
  );
}

/** Answers one pending permission request. Returns false if it was already gone. */
export async function replyOpenCodePermission(
  handle: OpenCodeServerHandle,
  directory: string,
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  message?: string,
): Promise<boolean> {
  try {
    const body: AnyRecord = { reply };
    if (message) {
      body.message = message;
    }
    await requestJson(handle, 'POST', `/permission/${encodeURIComponent(requestId)}/reply`, directory, body, 15_000);
    return true;
  } catch {
    return false;
  }
}

/** Answers a pending question request; `answers` is one label array per question. */
export async function replyOpenCodeQuestion(
  handle: OpenCodeServerHandle,
  directory: string,
  requestId: string,
  answers: string[][],
): Promise<boolean> {
  try {
    await requestJson(handle, 'POST', `/question/${encodeURIComponent(requestId)}/reply`, directory, { answers }, 15_000);
    return true;
  } catch {
    return false;
  }
}

/** Rejects a pending question request (the user skipped it). */
export async function rejectOpenCodeQuestion(
  handle: OpenCodeServerHandle,
  directory: string,
  requestId: string,
): Promise<boolean> {
  try {
    await requestJson(handle, 'POST', `/question/${encodeURIComponent(requestId)}/reject`, directory, undefined, 15_000);
    return true;
  } catch {
    return false;
  }
}

/** Test hook: tears the shared server down immediately. */
export function shutdownOpenCodeServer(): void {
  const state = serverState;
  serverState = null;
  serverStarting = null;
  if (!state) {
    return;
  }
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
  }
  state.streamAbort.abort();
  try {
    state.process.kill();
  } catch {
    // Already gone.
  }
}
