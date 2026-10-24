/**
 * OpenCode Event Stream
 *
 * One `GET /api/event` server-sent-events connection per cloudcli process,
 * fanned out to subscribers. The stream is global on the server side (every
 * session, every directory), so consumers filter by `data.sessionID`.
 *
 * The connection loop re-resolves the endpoint on every (re)connect, which
 * is what lets it follow the supervisor to a respawned server on a new port.
 * Drops reconnect with exponential backoff and are logged once per streak —
 * the gap's events are lost, so a silent reconnect would hide the reason a
 * frame never arrived. `onReconnect` lets the runtime reconcile runs whose
 * terminal event may have been missed in the gap, and re-read the asks raised
 * inside it.
 *
 * Parsing is hand-rolled (a few dozen lines) rather than a dependency: the
 * server emits `data: <json>` frames separated by blank lines plus
 * `: heartbeat` comments, nothing else.
 *
 * @module opencode-event-stream
 */

import type { OpenCodeServiceEndpoint } from './opencode-api.client.js';

/**
 * One parsed `/api/event` frame. `data` carries the typed payload (session
 * events have `data.sessionID`); `location` names the directory scope for
 * directory-bound events.
 *
 * Consumers: opencode event translator, opencode interaction bridge,
 * opencode runtime.
 */
export type OpenCodeEventEnvelope = {
  id?: string;
  type: string;
  created?: number;
  location?: { directory?: string };
  data?: unknown;
};

type EventListener = (event: OpenCodeEventEnvelope) => void;

type StreamDependencies = {
  fetch?: typeof fetch;
  /** Base delay for reconnect backoff; default 500ms. Tests shrink it. */
  backoffBaseMs?: number;
  /** Ceiling for reconnect backoff; default 10s. */
  backoffMaxMs?: number;
};

export type OpenCodeEventStreamState = 'idle' | 'connecting' | 'open' | 'stopped';

/**
 * Parses a buffered SSE text chunk into complete frames, returning the
 * leftover partial frame. Exported for the stream's unit tests.
 *
 * Consumer: opencode event stream (and its tests).
 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames: string[] = [];
  let rest = normalized;
  let separator: number;
  while ((separator = rest.indexOf('\n\n')) >= 0) {
    frames.push(rest.slice(0, separator));
    rest = rest.slice(separator + 2);
  }
  return { frames, rest };
}

/**
 * Reads the `data:` payload of one frame as an event envelope; comments,
 * `event:`/`id:`/`retry:` fields, and non-JSON payloads yield null.
 */
function parseSseFrame(frame: string): OpenCodeEventEnvelope | null {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as { type?: unknown };
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed as OpenCodeEventEnvelope;
  } catch {
    return null;
  }
}

/**
 * Long-lived subscriber to the service's event feed.
 *
 * Consumer: opencode runtime (module-level singleton); tests construct their
 * own against a fake SSE server.
 */
export class OpenCodeEventStream {
  private readonly fetchImpl: typeof fetch;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly listeners = new Set<EventListener>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly openWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private controller: AbortController | null = null;
  private wakeSleep: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private stopped = false;
  private stateValue: OpenCodeEventStreamState = 'idle';

  constructor(
    private readonly resolveEndpoint: () => Promise<OpenCodeServiceEndpoint>,
    dependencies: StreamDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.backoffBaseMs = dependencies.backoffBaseMs ?? 500;
    this.backoffMaxMs = dependencies.backoffMaxMs ?? 10_000;
  }

  get state(): OpenCodeEventStreamState {
    return this.stateValue;
  }

  /** Starts the connect loop; later calls are no-ops while it runs. */
  start(): void {
    if (this.loop) {
      return;
    }
    this.stopped = false;
    this.loop = this.runLoop().finally(() => {
      this.loop = null;
    });
  }

  /** Aborts the live connection and stops reconnecting. */
  stop(): void {
    this.stopped = true;
    this.stateValue = 'stopped';
    this.controller?.abort();
    this.controller = null;
    this.wakeSleep?.();
    const stoppedError = new Error('event stream is stopped');
    for (const waiter of this.openWaiters) {
      waiter.reject(stoppedError);
    }
    this.openWaiters.clear();
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fires once per successful connection that follows a drop (never on the first connect). */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /**
   * Resolves once the stream is open — immediately when it already is.
   * Senders await this before posting a prompt so the feed cannot miss the
   * first events of a run. Waiters are released unresolved-free on stop
   * (callers fail on their own timeouts instead of hanging here).
   */
  connected(): Promise<void> {
    if (this.stateValue === 'open') {
      return Promise.resolve();
    }
    if (this.stopped) {
      return Promise.reject(new Error('event stream is stopped'));
    }
    return new Promise<void>((resolve, reject) => {
      this.openWaiters.add({ resolve, reject });
    });
  }

  private async runLoop(): Promise<void> {
    let attempts = 0;
    let hadConnection = false;
    // One warning per failure streak: a service that keeps dropping must not
    // flood the log, but a silent reconnect is worse — the events that
    // happened during the gap are gone, and nothing else reports them.
    let warnedThisStreak = false;
    while (!this.stopped) {
      this.stateValue = 'connecting';
      const controller = new AbortController();
      this.controller = controller;
      try {
        const endpoint = await this.resolveEndpoint();
        if (this.stopped) {
          break;
        }
        const response = await this.fetchImpl(`${endpoint.url}/api/event`, {
          headers: { authorization: endpoint.authorization, accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`event stream responded with ${response.status}`);
        }
        this.stateValue = 'open';
        attempts = 0;
        warnedThisStreak = false;
        for (const waiter of this.openWaiters) {
          waiter.resolve();
        }
        this.openWaiters.clear();
        if (hadConnection) {
          for (const listener of this.reconnectListeners) {
            try {
              listener();
            } catch (error) {
              console.warn('[OpenCode] event stream reconnect listener failed:', error);
            }
          }
        }
        hadConnection = true;
        await this.consume(response.body);
        // A clean end carries no error: the service dropped the subscription
        // (its own subscriber capacity, a restart, a network cut), and every
        // event in the gap is lost. Say so, then reconnect below.
        if (!this.stopped && !controller.signal.aborted && !warnedThisStreak) {
          warnedThisStreak = true;
          console.warn('[OpenCode] event stream closed by the service; events during the gap are lost');
        }
      } catch (error) {
        // Warn once per failure streak: a service that stays down must not
        // flood the log on every backoff retry.
        if (!this.stopped && !controller.signal.aborted && !warnedThisStreak) {
          warnedThisStreak = true;
          console.warn('[OpenCode] event stream dropped:', error instanceof Error ? error.message : error);
        }
      } finally {
        if (this.controller === controller) {
          this.controller = null;
        }
      }
      if (this.stopped) {
        break;
      }
      attempts += 1;
      await this.sleep(Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (attempts - 1)));
    }
    this.stateValue = 'stopped';
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = splitSseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          const event = parseSseFrame(frame);
          if (event) {
            this.dispatch(event);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private dispatch(event: OpenCodeEventEnvelope): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn(`[OpenCode] event listener failed on ${event.type}:`, error);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeSleep = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.wakeSleep = () => {
        clearTimeout(timer);
        this.wakeSleep = null;
        resolve();
      };
    });
  }
}
