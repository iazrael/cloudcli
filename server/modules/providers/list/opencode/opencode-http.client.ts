import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Transport for every request against a local `opencode serve` process.
 *
 * Node's global `fetch` runs on undici with a five-minute `headersTimeout` and
 * `bodyTimeout`, and those caps fire independently of any `AbortSignal` a
 * caller passes. The blocking `POST /session/:id/message` only receives its
 * response headers when the whole assistant turn finishes — routinely longer
 * than five minutes for agentic runs — so the default cap used to kill healthy
 * turns with `UND_ERR_HEADERS_TIMEOUT` and report them as "could not reach the
 * local OpenCode server". The same default `bodyTimeout` also drops the idle
 * `/global/event` stream whenever the engine goes quiet for five minutes,
 * silently losing every event emitted during the gap.
 *
 * This module owns one undici agent whose transport timeouts sit above every
 * request deadline the provider sets, and exposes the only fetch the provider
 * may use against `opencode serve`.
 */

/**
 * Longest a blocking request may wait for its response headers before the
 * caller aborts it. One full assistant turn is the slowest such request, and
 * agentic turns routinely run past an hour.
 *
 * Consumers: `opencode-server.client.ts` (default deadline for `requestJson`)
 * and the transport-timeout invariant below.
 */
export const OPENCODE_SERVER_RESPONSE_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * Transport-level `headersTimeout`/`bodyTimeout` for the shared agent.
 *
 * Must stay above `OPENCODE_SERVER_RESPONSE_TIMEOUT_MS`, or undici would kill a
 * request the provider still considers alive — the exact failure this module
 * exists to prevent. It also bounds how long the event stream may stay silent
 * before undici drops it for the reconnect loop.
 *
 * Consumers: the shared agent below and the transport regression test.
 */
export const OPENCODE_SERVER_TRANSPORT_TIMEOUT_MS = OPENCODE_SERVER_RESPONSE_TIMEOUT_MS + 30 * 60_000;

/**
 * The agent every provider request runs on. One instance pools connections for
 * both the shared server and the short-lived compact server; undici keeps one
 * pool per origin, so their ports never interfere.
 */
const dispatcher = new Agent({
  headersTimeout: OPENCODE_SERVER_TRANSPORT_TIMEOUT_MS,
  bodyTimeout: OPENCODE_SERVER_TRANSPORT_TIMEOUT_MS,
});

/** The request shape the provider actually sends to `opencode serve`. */
type OpenCodeFetchInit = {
  method?: 'GET' | 'POST';
  headers?: Readonly<Record<string, string>>;
  body?: string;
  signal?: AbortSignal;
};

/**
 * `fetch` bound to the shared agent.
 *
 * The provider must use this instead of the global `fetch`: only a request
 * carrying this dispatcher escapes undici's default five-minute transport
 * timeouts.
 *
 * Consumers: `opencode-server.client.ts` (every shared-server call) and
 * `opencode-runtime.provider.js` (compact server readiness probe and
 * summarize request).
 */
export function openCodeFetch(url: string, init: OpenCodeFetchInit = {}): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher });
}
