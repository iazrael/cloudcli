/**
 * Per-session reply snippets for run-lifecycle push notifications.
 *
 * A completed-run push used to read "Codex: completed" with no content, while
 * the timeline held the full reply. The chat session writer — the one choke
 * point every engine's outbound frames cross — records the last assistant
 * text of its run here, and the payload builder spends it as the push body.
 * In-memory by design: the notification itself outlives a restart on the
 * device, so the registry only has to bridge the seconds between the last
 * streamed frame and the run's terminal notification.
 *
 * @module run-notification-content
 */

import { hasVisibleText } from '@/shared/utils.js';

/** Stored snippets are pre-truncated so a full reply never lingers in memory. */
const MAX_SNIPPET_LENGTH = 300;

/**
 * Upper bound on remembered sessions. Sessions far outnumber live runs, but a
 * snippet is a few hundred bytes — the cap exists so a long-running server
 * still cannot accumulate unbounded state.
 */
export const PREVIEW_REGISTRY_CAPACITY = 256;

const replyPreviews = new Map<string, string>();

/**
 * Records the session's latest assistant text, overwriting any earlier one.
 * Used by the chat session writer; the app session id is what the payload
 * builder later looks the snippet up by.
 */
export function rememberSessionReplyPreview(appSessionId: string, text: string): void {
  if (!appSessionId || !hasVisibleText(text)) {
    return;
  }

  // Delete-then-set refreshes Map recency so eviction always drops the
  // least recently talked-to session rather than a random one.
  replyPreviews.delete(appSessionId);
  const snippet = text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH)}` : text;
  replyPreviews.set(appSessionId, snippet);
  while (replyPreviews.size > PREVIEW_REGISTRY_CAPACITY) {
    const oldestKey = replyPreviews.keys().next().value;
    if (oldestKey === undefined) break;
    replyPreviews.delete(oldestKey);
  }
}

/** Returns the session's remembered reply snippet, or null when none. */
export function getSessionReplyPreview(appSessionId: string | null | undefined): string | null {
  if (!appSessionId) {
    return null;
  }
  return replyPreviews.get(appSessionId) ?? null;
}

/** Forgets the session's snippet. The writer clears it when a run starts. */
export function clearSessionReplyPreview(appSessionId: string): void {
  replyPreviews.delete(appSessionId);
}
