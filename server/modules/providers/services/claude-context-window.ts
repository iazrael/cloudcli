import { sessionsDb } from '@/modules/database/index.js';

/**
 * Persistence for the context window a Claude session actually runs against.
 *
 * A Claude transcript records the *resolved* model id for every turn
 * (`claude-opus-5`), never the context-window variant the run was started with
 * (`claude-opus-5[1m]`), so no amount of reading the transcript can tell a 1M
 * session apart from a 200k one. The SDK does know — `getContextUsage()`
 * reports it — but only while a query is live. These two helpers carry that
 * measurement from the run that observed it to every later reader.
 *
 * Kept apart from `claude-usage.ts` so the usage math stays free of database
 * access: this module is the only place the window touches storage.
 */

/**
 * Records the context window one Claude session runs against.
 *
 * Consumer: the Claude runtime provider, at the end of every turn, with the
 * window the SDK reported for that run. Accepts either the app session id or
 * the provider-native one, because a freshly created session is known by the
 * id the SDK announced before the app row adopts it.
 *
 * Silently does nothing when no row matches yet or the database is
 * unavailable: the window is re-reported at the end of the next turn, and
 * losing a badge refinement must never fail a run.
 */
export function recordClaudeSessionContextWindow(
  sessionId: string | null | undefined,
  contextWindow: number,
): void {
  if (!sessionId || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return;
  }

  try {
    const row = sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!row || row.context_window === Math.round(contextWindow)) {
      return;
    }

    sessionsDb.setSessionContextWindow(row.session_id, Math.round(contextWindow));
  } catch {
    // No database context (unit tests, early startup) or a row that vanished
    // mid-run. The next turn records the window again.
  }
}

/**
 * What one session row knows about its own context window.
 *
 * Both fields come from the same row, so they are read together rather than
 * through two lookups.
 */
export type ClaudeSessionWindowSources = {
  /** Window the SDK reported for this session, or null if it never ran here. */
  recorded: number | null;
  /**
   * Model variant the app recorded for the session (`opus[1m]`, `sonnet[1m]`,
   * `claude-opus-5`, ...). Unlike the transcript's resolved model id, this is
   * the selection the user made, so it still carries the `[1m]` window tag —
   * which is what lets a 1M session reopened before its first turn on this
   * build show 1M instead of 200k.
   */
  selectedModel: string | null;
};

/**
 * Reads what one Claude session row knows about its window. Everything is null
 * when the app has never run the session (or cannot reach the database).
 *
 * Consumers: the Claude sessions provider, which feeds it to the usage
 * resolver for both `/token-usage` and every history page, and the Claude
 * runtime provider, so the per-assistant frames of a resumed session already
 * report the real window instead of waiting for the turn to end.
 */
export function readClaudeSessionWindowSources(
  sessionId: string | null | undefined,
): ClaudeSessionWindowSources {
  if (!sessionId) {
    return { recorded: null, selectedModel: null };
  }

  try {
    const row = sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    const recorded = row?.context_window ?? null;
    return {
      recorded: typeof recorded === 'number' && Number.isFinite(recorded) && recorded > 0
        ? recorded
        : null,
      selectedModel: row?.model ?? null,
    };
  } catch {
    return { recorded: null, selectedModel: null };
  }
}
