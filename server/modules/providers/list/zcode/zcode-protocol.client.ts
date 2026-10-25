/**
 * ZCode Protocol Client (facade)
 *
 * Manages communication with the ZCode app-server subprocess. This facade
 * composes the three protocol modules and preserves the original singleton
 * consumption surface:
 * - `zcode-codec.ts`: pure protocol envelopes, parsing, and encoding
 * - `zcode-engine-supervisor.ts`: subprocess lifecycle (startup, crash
 *   detection, restart circuit breaker, graceful shutdown)
 * - `zcode-request-router.ts`: request correlation, engine-callback policy,
 *   and session event routing
 *
 * Lifecycle rules:
 * - Construction is side-effect free: the engine path is resolved lazily on
 *   the first request, so importing this module never fails on machines
 *   without ZCode installed (integration plan §3.2.4).
 * - Shutdown is driven exclusively by the server's shutdown flow
 *   (`shutdownZCodeRuntime`); the client never installs its own signal
 *   handlers or calls `process.exit`.
 * - When the engine crashes, in-flight requests fail and every registered
 *   session listener receives a synthetic `zcode:session/lost` notification
 *   so waiting runs can fail fast instead of timing out.
 *
 * @module zcode-protocol.client
 */

import type { ProtocolServerRequest, SessionEventListener } from './zcode-codec.js';
import type { ServerRequestAnswer } from './zcode-request-router.js';
import { EngineSupervisor } from './zcode-engine-supervisor.js';
import { RequestRouter } from './zcode-request-router.js';
import {
  buildZCodeAccountSyncPayload,
  findActiveZCodeBuiltinConfig,
} from './zcode-provider-config.js';

export {
  parseProtocolLine,
  SESSION_LOST_METHOD,
  type ProtocolMessage,
  type ProtocolNotification,
  type ProtocolRequest,
  type ProtocolResponse,
  type ProtocolServerRequest,
  type SessionEventListener,
} from './zcode-codec.js';

type ProtocolClientDeps = {
  findActiveBuiltinConfig?: typeof findActiveZCodeBuiltinConfig;
  buildZCodeAccountSyncPayload?: typeof buildZCodeAccountSyncPayload;
};

/**
 * ZCode Protocol Client - singleton facade over the supervisor and router.
 *
 * Consumers: zcode runtime provider (sendRequest + session listeners) and
 * `shutdownZCodeRuntime` in the zcode provider (shutdown).
 */
export class ZCodeProtocolClient {
  /** Singleton instance */
  private static instance: ZCodeProtocolClient | null = null;

  private readonly supervisor: EngineSupervisor;
  private readonly router: RequestRouter;
  private readonly findActiveBuiltinConfigFn: typeof findActiveZCodeBuiltinConfig;
  private readonly buildAccountSyncPayloadFn: typeof buildZCodeAccountSyncPayload;

  private syncedProcessId: number | null = null;
  private syncAccountPromise: Promise<void> | null = null;

  /**
   * Gets the singleton protocol client instance. Construction performs no
   * filesystem access and never throws.
   */
  static getInstance(): ZCodeProtocolClient {
    if (!ZCodeProtocolClient.instance) {
      ZCodeProtocolClient.instance = new ZCodeProtocolClient();
    }
    return ZCodeProtocolClient.instance;
  }

  constructor(
    supervisor?: EngineSupervisor,
    router?: RequestRouter,
    deps?: ProtocolClientDeps,
  ) {
    this.supervisor = supervisor ?? new EngineSupervisor();
    this.router = router ?? new RequestRouter({
      ensureRunning: () => this.supervisor.ensureRunning(),
      writeLine: (line: string) => this.supervisor.writeLine(line),
    });
    this.findActiveBuiltinConfigFn = deps?.findActiveBuiltinConfig ?? findActiveZCodeBuiltinConfig;
    this.buildAccountSyncPayloadFn = deps?.buildZCodeAccountSyncPayload ?? buildZCodeAccountSyncPayload;

    this.supervisor.onLine((line) => this.router.handleLine(line));

    // Engine crash: fail in-flight requests and tell every waiting session
    // that its engine-side session is gone. The stderr tail is the only
    // explanation the engine ever gave, so it rides on every failure.
    this.supervisor.onCrash(({ code, signal, stderrTail }) => {
      this.syncedProcessId = null;
      const tail = stderrTail.trim();
      this.router.failAllPending(new Error(
        'ZCode process terminated unexpectedly' + (tail ? `\nstderr:\n${tail}` : ''),
      ));
      this.router.notifySessionLost(code, signal, tail);
    });
  }

  /**
   * Synchronizes account-plan entitlements to the running ZCode engine subprocess.
   *
   * ZCode engine's app-server mode starts in a fail-closed state where all
   * `zhipu-account` providers are marked
   * as `entitled: false`, excluding them from the active provider registry.
   * This method issues `provider/updateAccountConfig` once per engine process
   * lifecycle whenever a supported account-plan credential is detected.
   */
  private async syncAccountConfigIfNeeded(): Promise<void> {
    const currentPid = this.supervisor.getProcessId();
    if (currentPid !== null && this.syncedProcessId === currentPid) {
      return;
    }

    if (this.syncAccountPromise) {
      return this.syncAccountPromise;
    }

    this.syncAccountPromise = (async () => {
      try {
        await this.supervisor.ensureRunning();
        const pid = this.supervisor.getProcessId();
        if (pid !== null && this.syncedProcessId === pid) {
          return;
        }

        const enginePath = this.supervisor.getEnginePath();
        const builtinConfigPath = enginePath ? this.findActiveBuiltinConfigFn(enginePath) : null;
        if (!builtinConfigPath) {
          if (pid !== null) this.syncedProcessId = pid;
          return;
        }

        const syncPayload = this.buildAccountSyncPayloadFn(builtinConfigPath);
        if (!syncPayload) {
          if (pid !== null) this.syncedProcessId = pid;
          return;
        }

        await this.router.request('provider/updateAccountConfig', syncPayload, 5000);
        if (pid !== null) this.syncedProcessId = pid;
      } catch (error) {
        console.warn('[ZCode Protocol] Failed to sync account config to ZCode engine:', error);
      } finally {
        this.syncAccountPromise = null;
      }
    })();

    return this.syncAccountPromise;
  }

  /**
   * Sends a protocol request and returns the response.
   *
   * @param method - Protocol method name
   * @param params - Method parameters
   * @param timeout - Request timeout in milliseconds (0 for no timeout: use
   *   for `session/send`, whose result arrives on the event stream)
   */
  async sendRequest<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeout?: number,
  ): Promise<T> {
    if (method !== 'provider/updateAccountConfig') {
      await this.syncAccountConfigIfNeeded();
    }
    return this.router.request<T>(method, params, timeout);
  }

  /**
   * Registers a listener for one ZCode session's events.
   */
  addSessionListener(sessionId: string, listener: SessionEventListener): void {
    this.router.addSessionListener(sessionId, listener);
  }

  /**
   * Removes one listener registration (same function identity).
   */
  removeSessionListener(sessionId: string, listener: SessionEventListener): void {
    this.router.removeSessionListener(sessionId, listener);
  }

  /**
   * Replaces the engine-callback policy (server-initiated requests).
   *
   * Consumers: the zcode runtime provider, which wraps the default policy to
   * bridge `interaction/requestPermission` through to the chat stream.
   */
  setServerRequestHandler(handler: (request: ProtocolServerRequest) => ServerRequestAnswer | Promise<ServerRequestAnswer>): void {
    this.router.setServerRequestHandler(handler);
  }

  /**
   * Graceful shutdown orchestrated by the server shutdown flow. Cancels any
   * scheduled restart, fails in-flight requests, and stops the engine.
   */
  async shutdown(): Promise<void> {
    this.syncedProcessId = null;
    this.router.failAllPending(new Error('Client is shutting down'));
    await this.supervisor.shutdown();
  }
}

/**
 * Singleton protocol client shared by every ZCode session.
 * Consumers: zcode runtime provider and `shutdownZCodeRuntime` in the zcode
 * provider barrel.
 */
export const protocolClient = ZCodeProtocolClient.getInstance();
