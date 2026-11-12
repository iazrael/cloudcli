import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import type { AnyRecord } from '@/shared/types.js';
import { AppError, SIDE_CONVERSATION_BOUNDARY_PROMPT, SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS, SIDE_QUESTION_ANSWER_SEPARATOR } from '@/shared/utils.js';

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
  call(method: string, params: unknown, options?: { timeoutMs?: number; onLateResult?: (result: unknown) => void | Promise<void> }): Promise<unknown>;
  /** Kills the child. Safe to call more than once. */
  close(): void;
  /** Stacks one more notification listener; returns its removal. */
  addNotificationListener(handler: (method: string, params: AnyRecord) => void): () => void;
  /** Stacks one more exit listener; returns its removal. */
  addExitListener(handler: (reason: string) => void): () => void;
  /**
   * Resolves when the child process is gone.
   *
   * A thread can only be resumed by one process at a time, so a caller that
   * replaces the process has to wait for this one to release the thread.
   */
  waitForExit?: () => Promise<void>;
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
 * One side question's whole turn, fork included (upstream #1673): minutes
 * covers a model reading a large transcript on a read-only fork without
 * letting a hung turn hold the question forever.
 */
const SIDE_QUESTION_TURN_TIMEOUT_MS = 5 * 60_000;

/** Per-connection environment values that must not mutate the server process. */
export type CodexAppServerOptions = {
  env?: NodeJS.ProcessEnv;
  /** Starts a detached worker server from its explicit allowlisted environment. */
  inheritEnv?: boolean;
  /** Enables protocol methods marked experimental by Codex. */
  experimentalApi?: boolean;
  /** Kills the child when it fires, handshake included. */
  signal?: AbortSignal;
};

/**
 * Spawns `codex app-server`, completes the handshake, and returns the open
 * connection.
 *
 * Consumer: `withAppServer` and the Codex runtime.
 */
export async function openCodexAppServer(
  handlers: CodexAppServerHandlers = {},
  options: CodexAppServerOptions = {},
): Promise<CodexAppServerConnection> {
  const launcher = codexAppServer.resolveLauncher();
  const child = spawn(process.execPath, [launcher, 'app-server'], {
    env: { ...(options.inheritEnv === false ? {} : process.env), ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
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
      dispatchNotification(message.method as string, params);
      return;
    }

    if (typeof message.id !== 'number') {
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  // Set by `close()` (and the abort path above) so the exit log can say
  // whether cloudcli asked the process to stop or it went away on its own —
  // the two look identical in the engine's own transcript, which records
  // only that its turn ended.
  let closedByClient = false;

  // A caller-supplied signal kills the child the moment it fires — including
  // while the `initialize` handshake below is still pending, where a pending
  // call would otherwise wait out its full request timeout. The connection's
  // own failPending turns the kill into every waiter's rejection.
  let onAbortSignal: (() => void) | null = null;
  if (options.signal) {
    onAbortSignal = () => {
      closedByClient = true;
      child.kill();
    };
    options.signal.addEventListener('abort', onAbortSignal, { once: true });
  }

  // The server logs sandbox and skill warnings to stderr on every start. They
  // are not failures and drowning the app log in them helps nobody, so stderr
  // is only kept around to explain a spawn that dies.
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  const failPending = (reason: string) => {
    if (exitReason) {
      return;
    }
    exitReason = reason;
    for (const resolve of pending.values()) {
      resolve({ error: { message: reason } });
    }
    pending.clear();
    dispatchExit(stderr.trim() ? `${reason} — ${stderr.trim().split('\n').slice(-1)[0]}` : reason);
  };

  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => { markExited = resolve; });
  child.on('error', (error) => failPending(error.message));
  child.on('exit', (code, signal) => {
    markExited();
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

  const call: CodexAppServerConnection['call'] = (method, params, options) =>
    new Promise((resolve, reject) => {
      if (exitReason) {
        reject(new AppError(`Codex app-server is not running: ${exitReason}`, {
          code: 'CODEX_APP_SERVER_UNAVAILABLE',
          statusCode: 502,
        }));
        return;
      }

      const timeoutMs = Number.isSafeInteger(options?.timeoutMs) && (options?.timeoutMs ?? 0) > 0
        ? options!.timeoutMs!
        : REQUEST_TIMEOUT_MS;
      const id = nextRequestId++;
      const timer = setTimeout(() => {
        if (options?.onLateResult) {
          // A timeout ends the caller's wait, not the engine request. Keep a
          // cleanup owner until the late response or connection exit arrives.
          pending.set(id, (response) => {
            if (response.error) { console.warn(`[Codex] Late RPC ${method} failed.`); return; }
            void Promise.resolve().then(() => options.onLateResult!(response.result))
              .catch(() => { console.warn(`[Codex] Late RPC cleanup for ${method} failed.`); });
          });
        } else pending.delete(id);
        reject(new AppError(`Codex app-server did not answer "${method}" within ${timeoutMs}ms.`, {
          code: 'CODEX_APP_SERVER_TIMEOUT',
          statusCode: 504,
        }));
      }, timeoutMs);

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
    if (onAbortSignal && options.signal) {
      options.signal.removeEventListener('abort', onAbortSignal);
    }
    reader.close();
    child.kill();
  };

  // One registered handler in the common cases; a side question stacks one
  // more for its turn and removes it when it settles. Notification handlers
  // fire in registration order; an exit handler fires once, on the child's
  // death.
  let notificationHandler: ((method: string, params: AnyRecord) => void) | null = handlers.onNotification ?? null;
  const extraNotificationListeners = new Set<(method: string, params: AnyRecord) => void>();
  const dispatchNotification = (method: string, params: AnyRecord) => {
    notificationHandler?.(method, params);
    for (const listener of extraNotificationListeners) {
      listener(method, params);
    }
  };
  const exitListeners = new Set<(reason: string) => void>();
  const dispatchExit = (reason: string) => {
    for (const listener of exitListeners) {
      listener(reason);
    }
  };

  try {
    await call('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
      capabilities: options.experimentalApi ? { experimentalApi: true } : {},
    });
    write({ jsonrpc: '2.0', method: 'initialized', params: {} });
  } catch (error) {
    close();
    throw error;
  }

  return {
    call,
    close,
    waitForExit: () => exited,
    addNotificationListener: (handler: (method: string, params: AnyRecord) => void) => {
      extraNotificationListeners.add(handler);
      return () => extraNotificationListeners.delete(handler);
    },
    addExitListener: (handler: (reason: string) => void) => {
      exitListeners.add(handler);
      return () => exitListeners.delete(handler);
    },
  };
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
 * Whether the engine refused the thread because another process holds it.
 *
 * The message is the engine's own; the rpc code is too general to tell this
 * refusal from any other invalid request.
 */
function isThreadHeldByAnotherProcess(error: unknown): boolean {
  return error instanceof AppError && error.message.includes('already has an active writer');
}

/** Reads every persisted turn for one Codex thread using the paginated app-server API. */
export async function listCodexThreadTurns(threadId: string): Promise<unknown[]> {
  if (!threadId.trim()) {
    throw new AppError('A Codex thread id is required to read conversation history.', {
      code: 'CODEX_HISTORY_THREAD_REQUIRED',
      statusCode: 400,
    });
  }
  const connection = await codexAppServerTransport.open({}, { experimentalApi: true });
  try {
    // A resident conversation holds its own thread, and the engine allows one
    // writer per thread. The listing does not need the thread loaded, so a
    // thread another process holds is read without taking it over.
    try {
      const resumed = await connection.call('thread/resume', { threadId, excludeTurns: true }) as {
        thread?: { id?: unknown };
      } | undefined;
      if (resumed?.thread?.id !== threadId) {
        throw new AppError('Codex resumed a different thread while checking task history.', {
          code: 'CODEX_HISTORY_THREAD_MISMATCH',
          statusCode: 502,
        });
      }
    } catch (error) {
      if (!isThreadHeldByAnotherProcess(error)) {
        throw error;
      }
    }

    const turns: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page += 1) {
      const response = await connection.call('thread/turns/list', {
        threadId,
        ...(cursor ? { cursor } : {}),
        limit: 100,
        itemsView: 'full',
      }) as { data?: unknown; nextCursor?: unknown } | undefined;
      if (!response || !Array.isArray(response.data)) {
        throw new AppError('Codex returned an invalid thread history page.', {
          code: 'CODEX_HISTORY_INVALID_PAGE',
          statusCode: 502,
        });
      }
      turns.push(...response.data);
      if (response.nextCursor === null || response.nextCursor === undefined || response.nextCursor === '') {
        return turns;
      }
      if (typeof response.nextCursor !== 'string' || seenCursors.has(response.nextCursor)) {
        throw new AppError('Codex returned a repeated or invalid history cursor.', {
          code: 'CODEX_HISTORY_INVALID_CURSOR',
          statusCode: 502,
        });
      }
      cursor = response.nextCursor;
      seenCursors.add(cursor);
    }
    throw new AppError('Codex history exceeded the supported page limit.', {
      code: 'CODEX_HISTORY_PAGE_LIMIT',
      statusCode: 502,
    });
  } finally {
    connection.close();
  }
}

/** `abortError` shaped like every other AppError this module throws. */
function abortError(): AppError {
  return new AppError('The operation was aborted.', { code: 'CODEX_APP_SERVER_ABORTED', statusCode: 499 });
}

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
  run: (connection: {
    call: (method: string, params: unknown) => Promise<unknown>;
    /** Registers one notification handler for the run's duration. */
    onNotification: (handler: (method: string, params: AnyRecord) => void) => () => void;
    /** Registers one exit handler for the run's duration. */
    onExit: (handler: (reason: string) => void) => () => void;
  }) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let exitReason: string | null = null;
  // The signal goes into the factory, so a dismiss while `initialize` is
  // still pending kills the child at once instead of waiting out its request
  // timeout; every waiter then rejects through the child's exit.
  const connection = await openCodexAppServer(
    { onExit: (reason) => { exitReason = reason; } },
    signal ? { signal } : {},
  );

  try {
    if (signal?.aborted) {
      throw abortError();
    }
    return await run({
      call: connection.call,
      onNotification: (handler) => {
        // The connection takes one handler; wrap it so several runs can stack.
        return connection.addNotificationListener(handler);
      },
      onExit: (handler) => connection.addExitListener(handler),
    });
  } catch (error) {
    if (signal?.aborted) {
      // A dismiss during the handshake surfaces as the killed child's exit;
      // report it as the abort it was.
      throw abortError();
    }
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
   * Resolves the `@openai/codex` CLI this process's app-server protocol is
   * guaranteed against. A property on the exported object rather than a
   * module function so tests can swap in a fake app-server script, the same
   * seam `forkThread` and `askSideQuestion` already use.
   */
  resolveLauncher(): string {
    return resolveCodexLauncher();
  },

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
    return withAppServer(async ({ call }) => {
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
   * Asks one question on an ephemeral, read-only fork of `threadId` and
   * resolves the concatenated answer. Used by `codexRuntime.askSideQuestion`
   * (`codex-runtime.provider.ts`) to answer a side question without touching
   * the parent thread (upstream #1673).
   *
   * `ephemeral: true` keeps the fork off disk; `excludeTurns: true` only
   * leaves `thread.turns` out of the `thread/fork` response — this fork is
   * never listed anywhere, so there is nothing else for it to exclude.
   * `sandbox: 'read-only'` and `approvalPolicy: 'never'` keep it from
   * mutating anything while it has no one to approve a request. The turn
   * itself is the boundary prompt followed by the question, exactly as
   * Codex's own side-conversation support sends it.
   *
   * `config` carries a per-server `enabled: false` for every MCP server and
   * app `config/read` names (plus the `_default` apps fallback), plus
   * `web_search: 'disabled'` and `features: { plugins: false }`, so the fork
   * starts no MCP server, connector or plugin of its own. `config/read` is
   * sent with `cwd` so a trusted project's own `.codex/config.toml` entries
   * are named too — without it the app-server only reads the user-level
   * config. All measured against the real 0.166.0 binary upstream.
   */
  async askSideQuestion(
    input: { threadId: string; cwd: string; model: string; question: string; signal: AbortSignal },
    onDelta: (text: string) => void,
  ): Promise<string> {
    const abortedError = () => new AppError('The side question was aborted.', {
      code: 'CODEX_SIDE_QUESTION_ABORTED',
      statusCode: 499,
    });

    if (input.signal.aborted) {
      throw abortedError();
    }

    return withAppServer(async ({ call, onNotification, onExit }) => {
      // Reads the config layer stack the same way `thread/fork` below will
      // see it — `cwd` is what makes `config/read` fold in the project
      // layer — and turns each MCP server and app it names off by name.
      const configOverridesOff = async (): Promise<{
        mcpServers: Record<string, unknown>;
        apps: Record<string, unknown>;
      }> => {
        const configResult = await call('config/read', input.cwd ? { cwd: input.cwd } : {}) as {
          config?: { mcp_servers?: Record<string, unknown>; apps?: Record<string, unknown> };
        } | undefined;
        const mcpServerNames = Object.keys(configResult?.config?.mcp_servers ?? {});
        const appNames = Object.keys(configResult?.config?.apps ?? {});
        return {
          mcpServers: Object.fromEntries(mcpServerNames.map((name) => [name, { enabled: false }])),
          apps: Object.fromEntries(
            [...new Set([...appNames, '_default'])].map((name) => [name, { enabled: false }]),
          ),
        };
      };

      // `plugin/list` can fail offline (no auth, no network) and that is not
      // a reason to refuse the side question — it just means there is
      // nothing to name in `disabledPluginIds`, same as a user with no
      // plugins installed.
      const pluginIdsOff = async (): Promise<string[]> => {
        try {
          const result = await call('plugin/list', {}) as {
            marketplaces?: Array<{ plugins?: Array<{ id?: unknown }> }>;
          } | undefined;
          const ids: string[] = [];
          for (const marketplace of result?.marketplaces ?? []) {
            for (const plugin of marketplace.plugins ?? []) {
              if (typeof plugin?.id === 'string') {
                ids.push(plugin.id);
              }
            }
          }
          return ids;
        } catch {
          return [];
        }
      };

      return new Promise<string>((resolve, reject) => {
        let text = '';
        // Deltas are optional and `item/completed` is the final item, so an
        // agent message that never streamed is taken from there instead.
        const streamedItemIds = new Set<string>();
        // Codex often writes a progress note ("I'll read math.js…") and the
        // answer as two agentMessage items. A new item id after text already
        // sent starts a new paragraph. A delta without an item id is taken as
        // part of the current item: a seam guessed wrong would split a word.
        let currentItemId: string | null = null;
        const appendAgentText = (itemId: string | null, chunk: string) => {
          if (text && itemId !== null && currentItemId !== null && itemId !== currentItemId) {
            text += SIDE_QUESTION_ANSWER_SEPARATOR;
            onDelta(SIDE_QUESTION_ANSWER_SEPARATOR);
          }
          if (itemId !== null) {
            currentItemId = itemId;
          }
          text += chunk;
          onDelta(chunk);
        };
        let settled = false;
        let removeNotificationListener: (() => void) | null = null;
        let removeExitListener: (() => void) | null = null;

        const timer = setTimeout(() => {
          settle(() => reject(new AppError(
            `Codex side question did not complete within ${SIDE_QUESTION_TURN_TIMEOUT_MS}ms.`,
            { code: 'CODEX_SIDE_QUESTION_TIMEOUT', statusCode: 504 },
          )));
        }, SIDE_QUESTION_TURN_TIMEOUT_MS);

        const onAbort = () => {
          settle(() => reject(abortedError()));
        };
        // Attached before `config/read` and `thread/fork` go out, so a
        // dismiss while they are in flight is caught the same way as one
        // during the turn itself. A dismiss during `initialize`, before this
        // runs, is `withAppServer`'s: it kills the child.
        input.signal.addEventListener('abort', onAbort);

        function settle(action: () => void) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          input.signal.removeEventListener('abort', onAbort);
          removeNotificationListener?.();
          removeExitListener?.();
          action();
        }

        if (input.signal.aborted) {
          settle(() => reject(abortedError()));
          return;
        }

        let pluginIds: string[] = [];

        Promise.all([configOverridesOff(), pluginIdsOff()]).then(([{ mcpServers, apps }, ids]) => {
          pluginIds = ids;
          if (settled) {
            // Aborted, or already timed out, while config/read or
            // plugin/list was in flight.
            return;
          }
          return call('thread/fork', {
            threadId: input.threadId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.model ? { model: input.model } : {}),
            ephemeral: true,
            sandbox: 'read-only',
            approvalPolicy: 'never',
            developerInstructions: SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS,
            excludeTurns: true,
            config: {
              mcp_servers: mcpServers,
              web_search: 'disabled',
              apps,
              features: { plugins: false },
            },
          });
        }).then((forkResult) => {
          if (settled) {
            // Aborted, or already timed out, while the fork request was in flight.
            return;
          }

          const typedForkResult = forkResult as { thread?: { id?: unknown } } | undefined;
          const forkThreadId = typeof typedForkResult?.thread?.id === 'string' ? typedForkResult.thread.id : '';
          if (!forkThreadId) {
            settle(() => reject(new AppError('Codex reported a side-question fork without a thread id.', {
              code: 'FORK_FAILED',
              statusCode: 502,
            })));
            return;
          }

          // From here on the turn waiter sits on a notification, not a
          // pending `call()`, so a child that exits mid-turn would otherwise
          // only be noticed once `SIDE_QUESTION_TURN_TIMEOUT_MS` elapses.
          removeExitListener = onExit((reason) => {
            settle(() => reject(new AppError(
              `Codex exited before the side-question turn finished (${reason}).`,
              { code: 'CODEX_SIDE_QUESTION_FAILED', statusCode: 502 },
            )));
          });

          removeNotificationListener = onNotification((method, params) => {
            const notificationParams = params as {
              threadId?: unknown;
              itemId?: unknown;
              delta?: unknown;
              item?: { type?: unknown; id?: unknown; text?: unknown };
              turn?: { status?: unknown; error?: { message?: unknown } };
            } | undefined;
            // Another thread's deltas (e.g. the one this fork was copied from)
            // arrive on the same connection; only this fork's own notifications
            // belong to this question.
            if (notificationParams?.threadId !== forkThreadId) {
              return;
            }

            if (method === 'item/agentMessage/delta') {
              const delta = typeof notificationParams.delta === 'string' ? notificationParams.delta : '';
              if (delta) {
                const itemId = typeof notificationParams.itemId === 'string' ? notificationParams.itemId : null;
                if (itemId !== null) {
                  streamedItemIds.add(itemId);
                }
                appendAgentText(itemId, delta);
              }
              return;
            }

            if (method === 'item/completed') {
              const item = notificationParams.item;
              if (
                item?.type === 'agentMessage'
                && typeof item.text === 'string' && item.text
                && !(typeof item.id === 'string' && streamedItemIds.has(item.id))
              ) {
                appendAgentText(typeof item.id === 'string' ? item.id : null, item.text);
              }
              return;
            }

            if (method === 'turn/completed') {
              const status = notificationParams.turn?.status;
              if (status === 'completed') {
                settle(() => resolve(text));
                return;
              }
              const message = typeof notificationParams.turn?.error?.message === 'string'
                ? notificationParams.turn.error.message
                : `Codex side-question turn ${String(status)}.`;
              settle(() => reject(new AppError(message, { code: 'CODEX_SIDE_QUESTION_FAILED', statusCode: 502 })));
            }
          });

          if (settled) {
            return;
          }

          call('turn/start', {
            threadId: forkThreadId,
            disabledPluginIds: pluginIds,
            input: [
              { type: 'text', text: SIDE_CONVERSATION_BOUNDARY_PROMPT, text_elements: [] },
              { type: 'text', text: input.question, text_elements: [] },
            ],
          }).catch((error) => {
            settle(() => reject(error));
          });
        }).catch((error) => {
          settle(() => reject(error));
        });
      });
    }, input.signal).catch((error: unknown) => {
      // A dismiss during `initialize` surfaces as the killed child's exit;
      // report it as the abort it was.
      throw input.signal.aborted ? abortedError() : error;
    });
  },
};
