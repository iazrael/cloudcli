/**
 * Antigravity ACP Client
 *
 * Thin JSON-RPC peer over `agy acp`'s newline-delimited stdio transport.
 * Knows the framing and the request/response bookkeeping; knows nothing about
 * Antigravity's business semantics — the runtime subscribes to notifications
 * and registers handlers for the server->client requests it can answer
 * (`session/request_permission` and, if a future engine starts sending it,
 * elicitation).
 *
 * Unknown server->client requests are answered with an empty result rather
 * than an error: the engine keeps running (verified against agy 1.5.14),
 * while an error reply could abort the engine's turn.
 *
 * @module antigravity-acp-client
 */

import type { ChildProcess } from 'node:child_process';

import crossSpawn from 'cross-spawn';

import type { AcpNotification } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

/**
 * A JSON-RPC message as it crosses the ACP stdio boundary. agy only ever
 * sends string-free JSON, and the client only ever sends numeric ids.
 */
type AcpFrame = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** A request the engine sent to the client (`id` is always present here). */
type AcpServerRequest = { id: number | string; method: string; params: unknown };

/**
 * Handler the runtime registers for one server->client method. Returns the
 * result frame payload; a thrown error becomes a JSON-RPC error reply so the
 * engine is never left waiting.
 */
type AcpServerRequestHandler = (request: AcpServerRequest) => unknown | Promise<unknown>;

type AcpClientOptions = {
  /** Absolute path of the engine executable (resolved by antigravity-engine-path). */
  enginePath: string;
  /** Subcommand and flags, e.g. `['acp', '--add-dir', cwd]`. */
  args: string[];
  /** Working directory the engine is spawned in. */
  cwd: string;
  /** Complete child environment. Omit it to inherit the parent's. */
  env?: NodeJS.ProcessEnv;
  /** Diagnostics (engine stderr lines, unparseable stdout) for callers that log. */
  onDiagnostic?: (line: string) => void;
};

/** Error rejected into pending requests when the engine process dies. */
export class AcpConnectionClosedError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = 'AcpConnectionClosedError';
    this.code = code;
  }
}

/**
 * A live `agy acp` connection. One instance per engine process; the runtime
 * and session manager keep one per resident antigravity session.
 */
export class AntigravityAcpClient {
  private readonly child: ChildProcess;
  private readonly onDiagnostic: ((line: string) => void) | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
  }>();
  private readonly requestHandlers = new Map<string, AcpServerRequestHandler>();
  private readonly notificationSubscribers = new Set<(notification: AcpNotification) => void>();
  private readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private resolveExit!: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private killTimer?: NodeJS.Timeout;
  private buffer = '';
  private closed = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(options: AcpClientOptions) {
    this.onDiagnostic = options.onDiagnostic;
    this.exit = new Promise((resolve) => { this.resolveExit = resolve; });
    this.child = crossSpawn(options.enginePath, options.args, {
      cwd: options.cwd,
      // A provided environment replaces wholesale, exactly like the print
      // path's crossSpawn call: callers pass buildAntigravitySubprocessEnv()
      // to strip the residual SSH variables that flip agy's token store, and
      // merging over process.env would quietly bring them back.
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // A write racing the engine's death surfaces as an EPIPE error event on
    // stdin; unhandled, it would crash the whole server. Like the print
    // path's stdin handling, the exit itself already settles the run.
    this.child.stdin!.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') return;
      this.onDiagnostic?.(`[agy acp] stdin error: ${error.message}`);
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.ingest(chunk));
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) this.onDiagnostic?.(`[agy acp stderr] ${trimmed}`);
      }
    });
    this.child.on('error', (error) => {
      // A spawn error means there is no child. A failed kill is not proof
      // of exit and must not authorize a replacement process.
      if (this.child.pid === undefined) this.handleExit(null, null, error);
      else this.onDiagnostic?.(`[agy acp] process error: ${error.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.handleExit(code, signal);
    });
  }

  /**
   * Resolves when the engine process exits (any reason). The runtime uses
   * this to fail the in-flight run; step 2 also uses it for crash handling.
   */
  whenExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exit;
  }

  /** Registers the handler for one server->client request method. */
  handleServerRequest(method: string, handler: AcpServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Subscribes to engine notifications (`session/update` and friends). */
  onNotification(subscriber: (notification: AcpNotification) => void): () => void {
    this.notificationSubscribers.add(subscriber);
    return () => this.notificationSubscribers.delete(subscriber);
  }

  /** Sends a client->server request and resolves with the result frame. */
  request(method: string, params: unknown, timeoutMs = method === 'session/prompt' ? undefined : 30_000): Promise<unknown> {
    if (this.closed || !this.child.stdin || this.exitInfo) {
      return Promise.reject(new AcpConnectionClosedError(`agy acp is not running (method: ${method})`, -32000));
    }
    const id = this.nextId++;
    const frame: AcpFrame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpConnectionClosedError(`agy acp ${method} timed out after ${timeoutMs}ms`, -32000));
        this.close();
      }, timeoutMs);
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(`${JSON.stringify(frame)}\n`, (writeError) => {
        if (writeError) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new AcpConnectionClosedError(`failed to write ${method} to agy acp: ${writeError.message}`, -32000));
        }
      });
    });
  }

  /** Sends a notification (no id, no reply). */
  notify(method: string, params: unknown): void {
    if (this.closed || !this.child.stdin || this.exitInfo) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** Kills the engine and fails every pending request. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new AcpConnectionClosedError('agy acp connection closed', -32000));
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    this.killTimer.unref();
  }

  /** True once close() ran or the engine process exited. */
  isClosed(): boolean {
    return this.closed || this.exitInfo !== null;
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let newlineAt = this.buffer.indexOf('\n');
    while (newlineAt >= 0) {
      const line = this.buffer.slice(0, newlineAt).trim();
      this.buffer = this.buffer.slice(newlineAt + 1);
      if (line) this.handleLine(line);
      newlineAt = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.onDiagnostic?.('[agy acp] unparseable stdout line');
      return;
    }
    const frame = readObjectRecord(value);
    if (frame?.jsonrpc !== '2.0') {
      this.onDiagnostic?.('[agy acp] Invalid JSON-RPC frame on stdout');
      return;
    }

    if (typeof frame.method === 'string' && frame.method) {
      if (typeof frame.id === 'string' || typeof frame.id === 'number') {
        this.dispatchServerRequest({ id: frame.id, method: frame.method, params: frame.params });
        return;
      }
      if (frame.id !== undefined) return;
      const notification: AcpNotification = { method: frame.method, params: frame.params };
      for (const subscriber of this.notificationSubscribers) {
        try {
          subscriber(notification);
        } catch (error) {
          this.onDiagnostic?.(`[agy acp] notification subscriber threw: ${String(error)}`);
        }
      }
      return;
    }

    if (typeof frame.id !== 'number') return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    const error = readObjectRecord(frame.error);
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (typeof error?.code === 'number' && typeof error.message === 'string') {
      pending.reject(new Error(`agy acp ${error.code}: ${error.message}`));
    } else if (Object.hasOwn(frame, 'result') && !Object.hasOwn(frame, 'error')) {
      pending.resolve(frame.result);
    } else {
      pending.reject(new Error('agy acp returned an invalid JSON-RPC response'));
      this.close();
    }
  }

  private dispatchServerRequest(request: AcpServerRequest): void {
    const handler = this.requestHandlers.get(request.method);
    if (!handler) {
      // Answering with an empty result keeps the engine moving; the shape of
      // unknown requests is the engine's business, not ours.
      this.replyToServer(request.id, {});
      return;
    }
    Promise.resolve()
      .then(() => handler(request))
      .then(
        (result) => this.replyToServer(request.id, result ?? {}),
        (error: Error) => this.replyToServer(request.id, undefined, {
          code: -32603,
          message: error?.message ?? 'handler failed',
        }),
      );
  }

  private replyToServer(id: number | string, result?: unknown, error?: { code: number; message: string }): void {
    if (this.closed || !this.child.stdin || this.exitInfo) return;
    const frame: AcpFrame = { jsonrpc: '2.0', id };
    if (error) frame.error = error;
    else frame.result = result;
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void {
    if (this.exitInfo) return;
    this.closed = true;
    this.exitInfo = { code, signal };
    clearTimeout(this.killTimer);
    const message = spawnError
      ? `agy acp failed to start: ${spawnError.message}`
      : `agy acp exited (code: ${code ?? 'signal ' + signal})`;
    this.rejectPending(new AcpConnectionClosedError(message, -32000));
    this.resolveExit(this.exitInfo);
    this.notificationSubscribers.clear();
    this.requestHandlers.clear();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
