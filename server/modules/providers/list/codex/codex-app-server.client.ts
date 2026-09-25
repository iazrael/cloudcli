import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import type { AnyRecord } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Minimal JSON-RPC client for `codex app-server`.
 *
 * `app-server` is the transport this app runs Codex over: conversations
 * (`thread/start`, `turn/start` and the item notifications those produce),
 * and the thread surgery an edited message needs (`thread/fork`, which the
 * Codex IDE clients build their own "fork" and "edit an earlier message" on
 * top of).
 *
 * The alternative, `codex exec` — what `@openai/codex-sdk` wraps — was
 * dropped: it cannot branch a thread, and its event stream numbers items per
 * process (`item_0`, `item_1`, restarting every turn) instead of reporting
 * the ids Codex records in the rollout, which left the live transcript and a
 * history read with no row identity in common.
 */

/** How long a single request may take before the child is killed. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long a compaction may run before the wait gives up. Compaction is a
 * non-steerable turn that makes its own model call over the whole
 * conversation, so it needs the model-turn order of magnitude, not the
 * control-plane one.
 */
const COMPACT_NOTIFICATION_TIMEOUT_MS = 10 * 60_000;

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * One fork of a Codex thread.
 *
 * `path` is returned by the server rather than reconstructed: the rollout
 * lands in today's date directory, not next to the file it was copied from,
 * so deriving it from the source path would be wrong roughly every day.
 */
export type CodexThreadFork = {
  threadId: string;
  path: string;
};

/**
 * Resolves the `codex` launcher shipped in node_modules.
 *
 * Deliberately not the `codex` on PATH: a machine can have a second, older
 * install, and the protocol this speaks is only guaranteed against the
 * version this package depends on.
 */
function resolveCodexLauncher(): string {
  const require_ = createRequire(import.meta.url);
  try {
    return require_.resolve('@openai/codex/bin/codex.js');
  } catch {
    throw new AppError('The Codex CLI package is not installed, so Codex conversations cannot be branched.', {
      code: 'CODEX_APP_SERVER_UNAVAILABLE',
      statusCode: 501,
    });
  }
}

/**
 * One open connection to a `codex app-server` child.
 *
 * Consumers: `withAppServer` (short one-shot exchanges such as `thread/fork`)
 * and `codex-runtime.provider.ts`, which keeps a connection for the length of
 * a turn so it can receive the item stream.
 */
export type CodexAppServerConnection = {
  /** Sends a JSON-RPC request and resolves with its result. */
  call(method: string, params: unknown): Promise<unknown>;
  /** Kills the child. Safe to call more than once. */
  close(): void;
};

/** What a caller must supply to receive the server's own traffic. */
export type CodexAppServerHandlers = {
  /** Every server-to-client notification, in arrival order. */
  onNotification?: (method: string, params: AnyRecord) => void;
  /**
   * Every server-to-client *request*. Returning a value answers it; returning
   * `undefined` rejects it as unsupported. A promise is awaited, which is what
   * lets an approval wait on a human.
   *
   * Answering is not optional: an approval request nobody replies to leaves
   * the turn blocked on it forever.
   */
  onRequest?: (method: string, params: AnyRecord) => unknown | Promise<unknown>;
  /** Called once when the child dies, with whatever explains it. */
  onExit?: (reason: string) => void;
};

/**
 * Spawns `codex app-server`, completes the handshake, and returns the open
 * connection.
 *
 * Consumer: `withAppServer` and the Codex runtime.
 */
export async function openCodexAppServer(
  handlers: CodexAppServerHandlers = {},
): Promise<CodexAppServerConnection> {
  const launcher = resolveCodexLauncher();
  const child = spawn(process.execPath, [launcher, 'app-server'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // The server logs sandbox and skill warnings to stderr on every start. They
  // are not failures and drowning the app log in them helps nobody, so stderr
  // is only kept around to explain a spawn that dies.
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  let nextRequestId = 1;
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let exitReason: string | null = null;

  const write = (message: unknown): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };

  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcResponse & { method?: string; params?: unknown };
    try {
      message = JSON.parse(line) as JsonRpcResponse & { method?: string; params?: unknown };
    } catch {
      // A non-JSON banner is not a reply to anything this client asked for.
      return;
    }

    if (typeof message.method === 'string') {
      const params = (message.params ?? {}) as AnyRecord;
      if (typeof message.id === 'number') {
        // A server-to-client request. It must be answered or whatever asked
        // for it waits forever — including an approval, which resolves only
        // once a human answers it.
        const requestId = message.id;
        const unsupported = () => write({
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32601, message: `cloudcli does not implement "${message.method}".` },
        });
        void (async () => {
          try {
            const result = await handlers.onRequest?.(message.method as string, params);
            if (result === undefined) {
              unsupported();
              return;
            }
            write({ jsonrpc: '2.0', id: requestId, result });
          } catch (error) {
            write({
              jsonrpc: '2.0',
              id: requestId,
              error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            });
          }
        })();
        return;
      }
      handlers.onNotification?.(message.method, params);
      return;
    }

    if (typeof message.id !== 'number') {
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  // Set by `close()` so the exit log can say whether cloudcli asked the
  // process to stop or it went away on its own — the two look identical in
  // the engine's own transcript, which records only that its turn ended.
  let closedByClient = false;

  const failPending = (reason: string) => {
    if (exitReason) {
      return;
    }
    exitReason = reason;
    for (const resolve of pending.values()) {
      resolve({ error: { message: reason } });
    }
    pending.clear();
    handlers.onExit?.(stderr.trim() ? `${reason} — ${stderr.trim().split('\n').slice(-1)[0]}` : reason);
  };

  child.on('error', (error) => failPending(error.message));
  child.on('exit', (code, signal) => {
    console.log(
      `[Codex] app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'}, `
      + `closedByCloudCLI=${closedByClient})`,
    );
    failPending(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
  });
  // A child that dies mid-request leaves its pipes broken, and the next write
  // raises EPIPE on the stream rather than at the call site. Without a
  // listener that is an unhandled 'error' event, which takes the whole server
  // down over one failed call.
  child.stdin?.on('error', (error) => failPending(error.message));
  child.stdout?.on('error', (error) => failPending(error.message));
  child.stderr?.on('error', () => {});

  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (exitReason) {
        reject(new AppError(`Codex app-server is not running: ${exitReason}`, {
          code: 'CODEX_APP_SERVER_UNAVAILABLE',
          statusCode: 502,
        }));
        return;
      }

      const id = nextRequestId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AppError(`Codex app-server did not answer "${method}" within ${REQUEST_TIMEOUT_MS}ms.`, {
          code: 'CODEX_APP_SERVER_TIMEOUT',
          statusCode: 504,
        }));
      }, REQUEST_TIMEOUT_MS);

      pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) {
          reject(new AppError(response.error.message || `Codex app-server rejected "${method}".`, {
            code: 'CODEX_APP_SERVER_ERROR',
            statusCode: 502,
            details: { method, rpcCode: response.error.code },
          }));
          return;
        }
        resolve(response.result);
      });

      write({ jsonrpc: '2.0', id, method, params });
    });

  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    closedByClient = true;
    reader.close();
    child.kill();
  };

  try {
    // `capabilities` is deliberately empty. `thread/fork` with `lastTurnId`,
    // `turn/start` and the item notifications are all in the stable protocol;
    // only `beforeTurnId` and the turn-listing methods are gated behind
    // `experimentalApi`, and none of those is needed here.
    await call('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
      capabilities: {},
    });
    write({ jsonrpc: '2.0', method: 'initialized', params: {} });
  } catch (error) {
    close();
    throw error;
  }

  return { call, close };
}

/**
 * The indirection production and tests share for opening a connection.
 *
 * `codex-runtime.provider.ts` goes through this rather than calling
 * `openCodexAppServer` directly so a test can substitute a fake server the
 * same way the previous runtime's tests substituted the SDK's thread class.
 * Production never replaces it.
 */
export const codexAppServerTransport = { open: openCodexAppServer };

/**
 * Runs one exchange against a freshly spawned `codex app-server`.
 *
 * A process per operation rather than a pooled long-lived one: the handshake
 * costs a fraction of a second, forking happens at most once per user action,
 * and a shared child would need lifecycle handling — restarts, back-pressure,
 * a crash taking every pending fork with it — for no measurable gain next to
 * the model turn that follows.
 */
async function withAppServer<T>(
  run: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  let exitReason: string | null = null;
  const connection = await openCodexAppServer({ onExit: (reason) => { exitReason = reason; } });

  try {
    return await run(connection.call);
  } catch (error) {
    if (error instanceof AppError && exitReason) {
      throw new AppError(`${error.message} — ${exitReason}`, {
        code: error.code,
        statusCode: error.statusCode,
      });
    }
    throw error;
  } finally {
    connection.close();
  }
}

export const codexAppServer = {
  /**
   * Copies a thread into a new one that ends at `lastTurnId`, or copies the
   * whole thread when it is omitted.
   *
   * `lastTurnId` is inclusive of the turn it names, which is the same
   * convention the app's edit anchor uses ("the last row to keep").
   *
   * `cwd` decides the working directory recorded in the copy's `session_meta`,
   * and that field is what the session indexer keys a session's project off —
   * omitting it would file every fork under whatever directory this server
   * happens to be running from.
   */
  async forkThread(input: {
    threadId: string;
    lastTurnId?: string;
    cwd: string;
  }): Promise<CodexThreadFork> {
    return withAppServer(async (call) => {
      const result = await call('thread/fork', {
        threadId: input.threadId,
        ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }) as { thread?: { id?: unknown; path?: unknown } } | undefined;

      const threadId = typeof result?.thread?.id === 'string' ? result.thread.id : '';
      const path = typeof result?.thread?.path === 'string' ? result.thread.path : '';
      if (!threadId || !path) {
        throw new AppError('Codex reported a fork without a thread id or transcript path.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      // Confirmed rather than trusted: both callers are about to point a
      // database row at this file, and a row naming a transcript that is not
      // there is a session that can never be opened.
      try {
        await stat(path);
      } catch {
        throw new AppError('Codex reported a fork but wrote no transcript for it.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      return { threadId, path };
    });
  },

  /**
   * Compacts a thread's carried conversation into a summary the next turn
   * builds on, in place.
   *
   * `thread/compact/start` only STARTS a non-steerable compaction turn (the
   * response is empty), and the work — a model call over the whole
   * conversation — completes asynchronously. This client spawns a fresh
   * app-server per operation, so it waits for that completion before the child
   * is torn down; killing the server earlier discards the summary. The thread
   * is resumed with its turns hydrated first, because the summarizer reads the
   * conversation it is replacing.
   */
  async compactThread(input: { threadId: string }): Promise<void> {
    let settleFinished!: () => void;
    let failFinished!: (error: Error) => void;
    const finished = new Promise<void>((resolve, reject) => {
      settleFinished = resolve;
      failFinished = reject;
    });

    // Both completion signals are watched from before the request goes out:
    // the compacting turn ends with a `contextCompaction` item, and the turn
    // boundary itself is the fallback for builds that emit only one of the two.
    const connection = await openCodexAppServer({
      onNotification: (method, params) => {
        const compactionItem = params.item as { type?: unknown } | undefined;
        if (
          (method === 'item/completed'
            && params.threadId === input.threadId
            && compactionItem?.type === 'contextCompaction')
          || (method === 'turn/completed' && params.threadId === input.threadId)
        ) {
          settleFinished();
        }
      },
      onExit: (reason) => {
        failFinished(new AppError(`Codex app-server is not running: ${reason}`, {
          code: 'CODEX_APP_SERVER_UNAVAILABLE',
          statusCode: 502,
        }));
      },
    });

    const timer = setTimeout(() => {
      failFinished(new AppError(
        `Codex app-server did not report the compaction within ${COMPACT_NOTIFICATION_TIMEOUT_MS}ms.`,
        { code: 'CODEX_APP_SERVER_TIMEOUT', statusCode: 504 },
      ));
    }, COMPACT_NOTIFICATION_TIMEOUT_MS);

    try {
      await connection.call('thread/resume', { threadId: input.threadId });
      await connection.call('thread/compact/start', { threadId: input.threadId });
      await finished;
    } finally {
      clearTimeout(timer);
      connection.close();
    }
  },
};
