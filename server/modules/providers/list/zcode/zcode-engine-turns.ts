/**
 * ZCode Engine Turn Presence
 *
 * Tracks which sessions the ZCode engine is running a turn on, whoever started
 * that turn. The chat-run registry only knows the turns CloudCLI drives itself:
 * a turn a background task's notification wakes after the run that launched it
 * ended — and a turn the engine keeps working on after its CloudCLI run failed —
 * touches nothing there, so the session looked idle on the page while its
 * transcript kept growing.
 *
 * Fed by the protocol router's session-event observer, which sees every
 * `session/event` the engine sends for a session, whether or not a run still
 * listens to it. Read by `zcode-runtime.provider`'s `listEngineTurns()`, which
 * `sessions.service` folds into the running-sessions poll.
 *
 * @module zcode-engine-turns
 */

import type { AnyRecord, ActiveEngineTurn } from '@/shared/types.js';

import { SESSION_LOST_METHOD } from './zcode-codec.js';
import { readZCodeSessionEvent } from './zcode-live-event-normalizer.js';

/**
 * How long a session's turn survives without any engine event before it is
 * treated as finished anyway. A missed `turn.completed` / `turn.failed` (a
 * dropped notification) would otherwise leave the session busy for ever —
 * which, unlike the idle state this registry fixes, also holds the composer's
 * next message back. Every event for the session refreshes the clock, so a
 * turn that keeps working never expires; this bounds silence only.
 */
const ENGINE_TURN_LIVENESS_MS = 2 * 60 * 60 * 1000;

/** One open turn: the engine's id for it, when it started, and when it was last heard from. */
type OpenEngineTurn = {
  turnId: string | null;
  startedAt: number;
  lastSeenAt: number;
};

/** The engine turns this process believes are running, by engine session id. */
const openTurns = new Map<string, OpenEngineTurn>();

/**
 * Reads the event time as epoch milliseconds. The engine stamps every event, so
 * the indicator counts from when the turn really started instead of when this
 * server happened to see it.
 */
function readEventTimeMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Applies one engine notification to the registry: a `turn.started` opens the
 * session's turn, a terminal event closes it, any other event for the session
 * proves it is still alive, and an engine that lost the session closes it too.
 *
 * A terminal event only closes the turn it names: a preempted turn's late
 * `turn.completed` arrives after the turn that replaced it started, and closing
 * on it would report the newer turn as finished while it is still running.
 *
 * Consumer: `zcode-runtime.provider`, installed once on the protocol router as
 * its session-event observer.
 */
export function observeZCodeEngineTurn(notification: AnyRecord): void {
  if (notification.method === SESSION_LOST_METHOD) {
    const params = notification.params as Record<string, unknown> | undefined;
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null;
    // No session id means the engine process itself is gone (the router says so
    // once per crash), which ends every session's turn with it.
    if (!sessionId) {
      openTurns.clear();
      return;
    }
    openTurns.delete(sessionId);
    return;
  }

  const event = readZCodeSessionEvent(notification.params ?? notification, null);
  if (!event?.sessionId) {
    return;
  }

  const { sessionId } = event;
  const existing = openTurns.get(sessionId);
  const eventAt = readEventTimeMs(event.timestamp);

  if (event.type === 'turn.started') {
    // The same turn re-announced keeps its original clock, so the elapsed time
    // the page shows does not jump back on a repeat.
    if (existing && event.turnId && existing.turnId === event.turnId) {
      existing.lastSeenAt = Math.max(existing.lastSeenAt, eventAt);
      return;
    }
    openTurns.set(sessionId, { turnId: event.turnId ?? null, startedAt: eventAt, lastSeenAt: eventAt });
    return;
  }

  if (event.type === 'turn_complete' || event.type === 'turn.failed') {
    if (!existing) {
      return;
    }
    if (event.turnId && existing.turnId && event.turnId !== existing.turnId) {
      return;
    }
    openTurns.delete(sessionId);
    return;
  }

  if (event.type === 'session.closed') {
    openTurns.delete(sessionId);
    return;
  }

  if (existing) {
    existing.lastSeenAt = Math.max(existing.lastSeenAt, eventAt);
  }
}

/**
 * The engine turns still open, oldest first, for the running-sessions poll.
 * Entries with no engine event for {@link ENGINE_TURN_LIVENESS_MS} are dropped
 * instead of reported.
 *
 * Consumer: `zcode-runtime.provider`'s `listEngineTurns()`.
 */
export function listZCodeEngineTurns(): ActiveEngineTurn[] {
  const now = Date.now();
  const turns: ActiveEngineTurn[] = [];
  for (const [engineSessionId, turn] of openTurns) {
    if (now - turn.lastSeenAt > ENGINE_TURN_LIVENESS_MS) {
      openTurns.delete(engineSessionId);
      continue;
    }
    turns.push({ engineSessionId, startedAt: turn.startedAt });
  }
  return turns.sort((left, right) => left.startedAt - right.startedAt);
}

/** Forgets every open turn; used by tests and when the engine process dies. */
export function clearZCodeEngineTurns(): void {
  openTurns.clear();
}
