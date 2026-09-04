/**
 * Row-level merging for realtime `thinking` frames.
 *
 * Providers stream one reasoning block as several frames sharing one stable
 * message id (zcode allocates the id per thinking segment server-side; claude
 * and codex emit one frame per block with the block's own id). Both pure
 * functions here are provider-agnostic: frames that share an id belong to the
 * same transcript entry, and a finished realtime row whose content the
 * persisted transcript already owns is an echo.
 *
 * Pure functions only — this module must stay free of Vite/environment
 * dependencies so it is importable from vitest, mirroring
 * sessionMessageTurnDedupe.ts.
 */

import type { NormalizedMessage } from '@/shared/types';

/**
 * Merges an incoming realtime `thinking` frame into the session's realtime
 * rows: a frame whose id matches an existing thinking row appends its content
 * to that row (one transcript entry per reasoning block), any other frame is
 * appended as a new row. Returns a new array; the input is not mutated.
 *
 * Used by the chat session store's realtime ingestion and safe to skip for
 * frames of other kinds.
 */
export function upsertThinkingRow(rows: NormalizedMessage[], frame: NormalizedMessage): NormalizedMessage[] {
  const index = rows.findIndex((row) => row.kind === 'thinking' && row.id === frame.id);
  if (index < 0) {
    return [...rows, frame];
  }

  const next = [...rows];
  next[index] = { ...next[index], content: (next[index].content || '') + (frame.content || '') };
  return next;
}

/**
 * Tests whether a realtime `thinking` row is already owned by the persisted
 * transcript: the server carries a thinking row with the same whitespace-
 * collapsed content. Exact content equality (no prefix or substring
 * tolerance) keeps in-flight rows — whose content is still a prefix of the
 * persisted block — untouched until the run finishes and the refresh carries
 * the full block.
 */
export function isThinkingRowEchoOnServer(row: NormalizedMessage, serverMessages: NormalizedMessage[]): boolean {
  if (row.kind !== 'thinking') {
    return false;
  }
  const content = (row.content || '').replace(/\s+/g, '');
  if (!content) {
    return false;
  }

  return serverMessages.some(
    (serverMessage) => serverMessage.kind === 'thinking' && (serverMessage.content || '').replace(/\s+/g, '') === content,
  );
}
