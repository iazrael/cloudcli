/**
 * Session Timeline Store
 *
 * Framework-free owner of one app's chat timelines: for every session it
 * holds the persisted rows (server pages), the live rows (websocket frames),
 * the merged view, pagination metadata, the stream-segment buffers, and the
 * reconnect resume seq. React attaches as a thin adapter (`useSessionStore`)
 * that instantiates one store per app mount and re-renders on the active
 * session's notify; nothing in here imports React.
 *
 * Two hard invariants keep the scroll geometry stable — they are contracts
 * with the transcript renderer, not implementation details, and every method
 * must preserve them:
 *
 * 1. Prepending an older page (or replacing the tail) must reuse the cached
 *    row objects for unchanged content: byte-equal rows keep their identity,
 *    so React memo, the conversion cache, and the DOM stay anchored.
 * 2. A row update is either an in-place upsert (thinking / tool_use /
 *    streaming rows, keyed by message id or toolId) or a whole-array replace
 *    that preserves equivalent rows' identities. There is no third way.
 *
 * Ordering contracts that live INSIDE this module (each was a past bug):
 * - `pruneRealtimeSupersededByServer` runs before the content-level bail-out
 *   of a latest refresh, or a delayed ws replay row survives forever.
 * - A drifting tail-relative offset during an older-page fetch is realigned
 *   by one bounded latest-page refresh before the retry.
 * - The streaming row's timestamp anchors at segment start and never
 *   refreshes, so the finalized text sorts ahead of the turn's later tool
 *   calls.
 *
 * Consumer: `useSessionStore` (the React adapter) is the only production
 * consumer; `sessionTimelineStore.test.ts` and the hook-level
 * `sessionTimelineSequences.test.ts` drive it with scripted pages.
 */

import { authenticatedFetch } from '@/shared/api';
import type { LLMProvider, NormalizedMessage } from '@/shared/types';
import { removeOptimisticUserEchoes, upsertToolUseRow } from '@/modules/chat/utils/sessionMessageReconciliation';
import { isThinkingRowEchoOnServer, upsertThinkingRow } from '@/modules/chat/utils/sessionThinkingRows';
import {
  buildSessionMessagesUrl,
  hasReachedCachedTailTimeBoundary,
  mergeLatestServerPage,
  mergeOlderServerPage,
  normalizedRowsEquivalent,
  planLatestPageBridge,
  resolveLatestPagePagination,
  SESSION_MESSAGES_PAGE_SIZE,
} from '@/modules/chat/utils/sessionMessagePagination';
import type { SessionMessagesRequestOptions } from '@/modules/chat/utils/sessionMessagePagination';
import {
  compareMessagesChronologically,
  isAssistantTextEchoedInSameTurnOnServer,
  isAssistantTextMatch,
  readMessageTime,
} from '@/modules/chat/utils/sessionMessageTurnDedupe';

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export type SessionSlot = {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  /**
   * @internal Serializes history reads for this session so an older-page
   * request calculates its offset after any latest-page refresh completes.
   */
  _historyMutationQueue: Promise<void>;
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
}

const EMPTY: NormalizedMessage[] = [];
const SESSION_HISTORY_REQUEST_TIMEOUT_MS = 30_000;

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    _historyMutationQueue: Promise.resolve(),
  };
}

export type SessionHistoryPage = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  tokenUsage?: unknown;
};

/**
 * History-page transport. The production default goes through
 * `authenticatedFetch`; tests inject scripted pages so timeline sequences run
 * without a server.
 */
export type SessionPageFetcher = (
  sessionId: string,
  options: SessionMessagesRequestOptions,
) => Promise<SessionHistoryPage>;

/**
 * The default transport: one bounded page from the provider sessions
 * endpoint (the standard `{ success, data }` envelope).
 */
export const requestSessionHistoryPage: SessionPageFetcher = async (sessionId, options) => {
  const response = await authenticatedFetch(buildSessionMessagesUrl(sessionId, options), {
    signal: AbortSignal.timeout(SESSION_HISTORY_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = await response.json();
  const data = body?.data ?? body;
  const messages: NormalizedMessage[] = Array.isArray(data.messages) ? data.messages : [];

  return {
    messages,
    total: typeof data.total === 'number' ? data.total : messages.length,
    hasMore: Boolean(data.hasMore),
    ...(
      data && typeof data === 'object' && 'tokenUsage' in data
        ? { tokenUsage: data.tokenUsage }
        : {}
    ),
  };
};

type LatestHistoryRefreshResult = {
  applied: boolean;
  changed: boolean;
  deferred: boolean;
};

export type CanRequestHistory = () => boolean;

// Token usage is JSON response data, so compare its serialized value instead
// of treating each freshly parsed response object as a state change.
function hasEquivalentTokenUsage(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function enqueueHistoryMutation<T>(
  slot: SessionSlot,
  operation: () => Promise<T>,
): Promise<T> {
  const result = slot._historyMutationQueue.then(operation);
  slot._historyMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Collapses duplicate assistant replies and replaces live streaming bubbles
 * with persisted text. Turn-aware so identical assistant text within the same turn
 * is collapsed even when separated by tool_use or status events.
 */
function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  const seenAssistantTexts = new Map<string, number>();
  let currentTurnAssistantTexts = new Set<string>();

  for (const m of merged) {
    if (m.kind === 'text' && m.role === 'user') {
      currentTurnAssistantTexts = new Set<string>();
      seenAssistantTexts.clear();
      out.push(m);
      continue;
    }

    if (m.kind === 'stream_delta') {
      const prev = out[out.length - 1];
      if (prev && prev.kind === 'text' && prev.role === 'assistant') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && isAssistantTextMatch(ps, ms)) {
          continue;
        }
      }
    }

    if (m.kind === 'text' && m.role === 'assistant') {
      const text = (m.content || '').trim();
      const compactKey = text.replace(/\s+/g, '');
      if (compactKey.length > 0) {
        // If immediately preceded by matching stream_delta, promote delta to final text
        const lastIdx = out.length - 1;
        if (lastIdx >= 0 && out[lastIdx].kind === 'stream_delta') {
          const deltaText = (out[lastIdx].content || '').trim();
          if (isAssistantTextMatch(deltaText, text)) {
            out[lastIdx] = m;
            currentTurnAssistantTexts.add(compactKey);
            seenAssistantTexts.set(compactKey, lastIdx);
            continue;
          }
        }

        // Check if duplicate in current turn or duplicate reply across the list
        const isDuplicateInTurn = currentTurnAssistantTexts.has(compactKey);
        const previousIndex = seenAssistantTexts.get(compactKey);

        if (isDuplicateInTurn || previousIndex !== undefined) {
          const targetIndex = previousIndex ?? out.findIndex(
            (item) => item.kind === 'text' && item.role === 'assistant' && isAssistantTextMatch(item.content || '', text),
          );
          if (targetIndex >= 0) {
            // Prefer persisted message over synthetic realtime message
            if (out[targetIndex].id.startsWith('text_') && !m.id.startsWith('text_')) {
              out[targetIndex] = m;
            }
          }
          continue;
        }

        currentTurnAssistantTexts.add(compactKey);
        seenAssistantTexts.set(compactKey, out.length);
      }
    }

    out.push(m);
  }
  return out;
}

/**
 * After a server refresh, drop only the realtime rows the persisted transcript
 * already owns. Anything not yet on disk (common right after `complete`, while
 * JSONL indexing lags) stays in `realtimeMessages` so the chat pane never
 * flashes the empty "Continue your conversation" state.
 */
function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  if (realtimeMessages.length === 0) {
    return realtimeMessages;
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  const reconciledRealtimeMessages = removeOptimisticUserEchoes(serverMessages, realtimeMessages);

  return reconciledRealtimeMessages.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }

    if (message.kind === 'stream_delta' || message.id === `__streaming_${message.sessionId}`) {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'thinking' && isThinkingRowEchoOnServer(message, serverMessages)) {
      return false;
    }

    if (message.kind === 'text' && message.role === 'assistant') {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'user') {
      return true;
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    return true;
  });
}

function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }
  if (server.length === 0) {
    return dedupeAdjacentAssistantEchoes(realtime);
  }

  const serverIds = new Set(server.map((message) => message.id));
  const reconciledRealtime = removeOptimisticUserEchoes(server, realtime);
  const extra = reconciledRealtime.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }
    if (message.kind === 'thinking' && isThinkingRowEchoOnServer(message, server)) {
      return false;
    }
    if (
      (message.kind === 'text' && message.role === 'assistant')
      || message.kind === 'stream_delta'
      || message.id === `__streaming_${message.sessionId}`
    ) {
      if (isAssistantTextEchoedInSameTurnOnServer(message, server, realtime)) {
        return false;
      }
    }
    return true;
  });

  if (extra.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }

  // Interleave by timestamp so live rows stay with their turn instead of
  // piling up at the bottom after every refresh.
  return dedupeAdjacentAssistantEchoes(
    [...server, ...extra].sort(compareMessagesChronologically),
  );
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

function olderPagePrecedesCachedHistory(
  olderMessages: NormalizedMessage[],
  cachedMessages: NormalizedMessage[],
): boolean {
  const olderNewest = olderMessages[olderMessages.length - 1];
  const cachedOldest = cachedMessages[0];
  if (!olderNewest || !cachedOldest) return true;

  const olderTime = readMessageTime(olderNewest);
  const cachedTime = readMessageTime(cachedOldest);
  return olderTime === null || cachedTime === null || olderTime <= cachedTime;
}

// ─── The store ───────────────────────────────────────────────────────────────

export type SessionTimelineStoreOptions = {
  /** History-page transport; defaults to the authenticated HTTP transport. */
  fetchPage?: SessionPageFetcher;
  /**
   * Re-render signal for the active session. Called only when the changed
   * session is the active one; the React adapter passes its tick setter.
   */
  notify?: (sessionId: string) => void;
};

export class SessionTimelineStore {
  /** Live slots by session id. Session switch = pointer change, no clearing. */
  private readonly slots = new Map<string, SessionSlot>();
  private activeSessionId: string | null = null;
  private readonly fetchPage: SessionPageFetcher;
  private readonly notifyListener: (sessionId: string) => void;

  // Per-session stream-segment buffers with their 100ms throttle timers, and
  // the per-session reconnect resume seq. Timeline state, store-owned.
  private readonly streamTimers = new Map<string, number>();
  private readonly accumulatedStreams = new Map<string, string>();
  private readonly resumeSeqs = new Map<string, number>();

  constructor(options: SessionTimelineStoreOptions = {}) {
    this.fetchPage = options.fetchPage ?? requestSessionHistoryPage;
    this.notifyListener = options.notify ?? (() => undefined);
  }

  private notify(sessionId: string): void {
    if (sessionId === this.activeSessionId) {
      this.notifyListener(sessionId);
    }
  }

  /** Points the active-session pointer; notify only fires for it afterwards. */
  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  getSlot(sessionId: string): SessionSlot {
    const slot = this.slots.get(sessionId);
    if (slot) {
      return slot;
    }
    const created = createEmptySlot();
    this.slots.set(sessionId, created);
    return created;
  }

  has(sessionId: string): boolean {
    return this.slots.has(sessionId);
  }

  /**
   * Fetch one history page from the provider sessions endpoint and apply it
   * as the slot's whole server view (initial load, search jump, load-all).
   */
  async fetchFromServer(
    sessionId: string,
    opts: {
      limit?: number | null;
      offset?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ): Promise<SessionSlot | null> {
    const slot = this.getSlot(sessionId);
    slot.status = 'loading';
    this.notify(sessionId);

    return enqueueHistoryMutation(slot, async () => {
      const { canRequest = () => true, ...requestOptions } = opts;
      if (!canRequest()) {
        slot.status = 'idle';
        this.notify(sessionId);
        return null;
      }

      try {
        const data = await this.fetchPage(sessionId, requestOptions);
        slot.serverMessages = data.messages;
        slot.total = data.total;
        slot.hasMore = data.hasMore;
        slot.offset = (requestOptions.offset ?? 0) + data.messages.length;
        slot.fetchedAt = Date.now();
        slot.status = 'idle';
        slot.realtimeMessages = pruneRealtimeSupersededByServer(
          slot.serverMessages,
          slot.realtimeMessages,
        );
        recomputeMergedIfNeeded(slot);
        if (data.tokenUsage !== undefined) {
          slot.tokenUsage = data.tokenUsage;
        }

        this.notify(sessionId);
        return slot;
      } catch (error) {
        console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
        slot.status = 'error';
        this.notify(sessionId);
        return slot;
      }
    });
  }

  /**
   * Load one older page and prepend it to the server view. A tail-relative
   * offset can shift while the transcript is still growing, so one bounded
   * latest-page reconciliation realigns the cache before the single retry.
   */
  async fetchMore(
    sessionId: string,
    opts: {
      limit?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ): Promise<{ slot: SessionSlot; prependedCount: number }> {
    const slot = this.getSlot(sessionId);
    return enqueueHistoryMutation(slot, async () => {
      let prependedCount = 0;
      let changed = false;
      const canRequest = opts.canRequest ?? (() => true);
      if (!slot.hasMore || !canRequest()) return { slot, prependedCount };

      try {
        for (let attempt = 0; attempt < 2 && slot.hasMore; attempt++) {
          if (!canRequest()) break;

          const cachedMessages = slot.serverMessages;
          const expectedTotal = slot.total;
          const data = await this.fetchPage(sessionId, {
            limit: opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
            offset: slot.offset,
          });
          const olderMerge = mergeOlderServerPage(cachedMessages, data.messages);
          const shiftedWhileFetching = (
            data.total !== expectedTotal
            || olderMerge.overlapLength > 0
            || !olderPagePrecedesCachedHistory(data.messages, cachedMessages)
          );

          if (shiftedWhileFetching) {
            if (attempt > 0 || !canRequest()) break;
            const latestResult = await this.refreshLatestSlotFromServer(
              sessionId,
              slot,
              SESSION_MESSAGES_PAGE_SIZE,
              canRequest,
            );
            changed = changed || latestResult.changed;
            if (!latestResult.applied) break;
            continue;
          }

          slot.serverMessages = olderMerge.messages;
          slot.hasMore = data.hasMore;
          slot.total = data.total;
          slot.offset = slot.serverMessages.length;
          prependedCount = olderMerge.prependedCount;
          if (data.tokenUsage !== undefined) {
            slot.tokenUsage = data.tokenUsage;
          }
          recomputeMergedIfNeeded(slot);
          changed = true;
          break;
        }

        if (changed) this.notify(sessionId);
        return { slot, prependedCount };
      } catch (error) {
        console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
        if (changed) this.notify(sessionId);
        return { slot, prependedCount };
      }
    });
  }

  /**
   * Refreshes only the persisted tail and stitches it onto the contiguous
   * cached suffix. Large turns request a small offset bridge rather than the
   * whole transcript, and the final state is applied atomically.
   */
  async refreshLatestFromServer(
    sessionId: string,
    opts: {
      limit?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ): Promise<{ slot: SessionSlot } & LatestHistoryRefreshResult> {
    const slot = this.getSlot(sessionId);

    return enqueueHistoryMutation(slot, async () => {
      try {
        const result = await this.refreshLatestSlotFromServer(
          sessionId,
          slot,
          opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
          opts.canRequest,
        );
        if (result.changed) this.notify(sessionId);
        return { slot, ...result };
      } catch (error) {
        console.error(`[SessionStore] latest refresh failed for ${sessionId}:`, error);
        return { slot, applied: false, changed: false, deferred: false };
      }
    });
  }

  /**
   * The bounded tail reconciliation behind `refreshLatestFromServer`. Every
   * request is finite; Claude/Codex bridge discovery may use more than one
   * bounded chunk because their response `total` omits paginated tool results.
   */
  private async refreshLatestSlotFromServer(
    sessionId: string,
    slot: SessionSlot,
    limit: number,
    canRequest: CanRequestHistory = () => true,
  ): Promise<LatestHistoryRefreshResult> {
    if (!canRequest()) {
      return { applied: false, changed: false, deferred: true };
    }

    const previousServerMessages = slot.serverMessages;
    const previousTotal = slot.total;
    const previousHasMore = slot.hasMore;
    const latestPage = await this.fetchPage(sessionId, {
      limit,
      offset: 0,
    });

    let nextServerMessages: NormalizedMessage[] | null = null;
    let nextHasMore = previousHasMore;

    // A page with no older rows is the complete authoritative transcript. This
    // also removes cached rows after a provider-side truncation.
    if (!latestPage.hasMore) {
      nextServerMessages = latestPage.messages;
      nextHasMore = false;
    } else if (previousServerMessages.length === 0) {
      nextServerMessages = latestPage.messages;
      nextHasMore = true;
    } else {
      let fetchedWindow = latestPage.messages;
      let oldestFetchedPage = latestPage;
      let bridgeRowsFetched = 0;
      let reachedStartOfHistory = false;
      let mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

      while (
        mergedPage.overlapLength === 0
        && !hasReachedCachedTailTimeBoundary(previousServerMessages, fetchedWindow)
      ) {
        const bridgeRequest = planLatestPageBridge(
          previousServerMessages,
          latestPage.messages,
          previousTotal,
          latestPage.total,
          bridgeRowsFetched,
        );
        if (!bridgeRequest) break;
        if (!canRequest()) {
          return { applied: false, changed: false, deferred: true };
        }

        const bridgePage = await this.fetchPage(sessionId, bridgeRequest);
        if (bridgePage.total !== latestPage.total) {
          console.warn(`[SessionStore] History changed while bridging ${sessionId}; retaining cached suffix.`);
          return { applied: false, changed: false, deferred: false };
        }
        if (bridgePage.messages.length === 0) break;

        const bridgeMerge = mergeOlderServerPage(fetchedWindow, bridgePage.messages);
        if (
          bridgeMerge.overlapLength > 0
          || !olderPagePrecedesCachedHistory(bridgePage.messages, fetchedWindow)
        ) {
          console.warn(`[SessionStore] History shifted while bridging ${sessionId}; retaining cached suffix.`);
          return { applied: false, changed: false, deferred: false };
        }

        fetchedWindow = bridgeMerge.messages;
        oldestFetchedPage = bridgePage;
        bridgeRowsFetched += bridgePage.messages.length;
        mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

        if (!bridgePage.hasMore) {
          reachedStartOfHistory = true;
          break;
        }
      }

      if (reachedStartOfHistory) {
        nextServerMessages = fetchedWindow;
        nextHasMore = false;
      } else if (mergedPage.overlapLength > 0) {
        nextServerMessages = mergedPage.messages;
        nextHasMore = resolveLatestPagePagination(
          previousServerMessages.length,
          nextServerMessages.length,
          previousHasMore,
          oldestFetchedPage.hasMore,
        ).hasMore;
      }
    }

    let changed = false;
    if (
      latestPage.tokenUsage !== undefined
      && !hasEquivalentTokenUsage(latestPage.tokenUsage, slot.tokenUsage)
    ) {
      slot.tokenUsage = latestPage.tokenUsage;
      changed = true;
    }

    if (!nextServerMessages) {
      console.warn(`[SessionStore] Could not bridge latest history for ${sessionId}; retaining cached suffix.`);
      return { applied: false, changed, deferred: false };
    }

    // Content-level bail-out: an identical refresh (byte-equal rows, same
    // pagination metadata, no realtime rows to prune) keeps the cached array
    // identity so the merged recompute and consumer re-renders are skipped.
    // Trailing `session_upserted` frames after a finished run used to trigger
    // several of these no-op refreshes in a row. The prune is computed first:
    // realtime rows that a delayed ws replay appended after the server already
    // persisted them must still be superseded here.
    const prunedRealtimeMessages = pruneRealtimeSupersededByServer(
      nextServerMessages,
      slot.realtimeMessages,
    );
    if (
      nextServerMessages.length === previousServerMessages.length
      && latestPage.total === previousTotal
      && nextHasMore === previousHasMore
      && prunedRealtimeMessages.length === slot.realtimeMessages.length
      && nextServerMessages.every((row, index) => normalizedRowsEquivalent(previousServerMessages[index], row))
    ) {
      slot.fetchedAt = Date.now();
      return { applied: true, changed, deferred: false };
    }

    slot.serverMessages = nextServerMessages;
    slot.total = latestPage.total;
    slot.offset = nextServerMessages.length;
    slot.hasMore = nextHasMore;
    slot.fetchedAt = Date.now();
    slot.realtimeMessages = prunedRealtimeMessages;
    recomputeMergedIfNeeded(slot);

    return { applied: true, changed: true, deferred: false };
  }

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  appendRealtime(sessionId: string, msg: NormalizedMessage): void {
    const slot = this.getSlot(sessionId);
    const normalizedMessage =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };
    let updated = [...slot.realtimeMessages, normalizedMessage];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    this.notify(sessionId);
  }

  /** Append multiple realtime messages at once (batch). */
  appendRealtimeBatch(sessionId: string, msgs: NormalizedMessage[]): void {
    if (msgs.length === 0) return;
    const slot = this.getSlot(sessionId);
    const normalizedMessages = msgs.map((msg) =>
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId },
    );
    let updated = [...slot.realtimeMessages, ...normalizedMessages];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    this.notify(sessionId);
  }

  /**
   * Ingest a realtime `thinking` frame. Frames sharing one message id belong
   * to the same reasoning block (zcode emits per-delta frames with a stable
   * block id; other providers emit one frame per block), so a matching row
   * receives the frame's content instead of the frame becoming its own
   * transcript entry.
   */
  upsertThinkingDelta(sessionId: string, msg: NormalizedMessage): void {
    const slot = this.getSlot(sessionId);
    const normalizedMessage =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };
    slot.realtimeMessages = upsertThinkingRow(slot.realtimeMessages, normalizedMessage);
    recomputeMergedIfNeeded(slot);
    this.notify(sessionId);
  }

  /**
   * Ingest a realtime tool_use frame. Frames sharing one toolId are snapshots
   * of the same call (zcode streams arguments into the announced card), so the
   * matching row is updated in place; see upsertToolUseRow.
   */
  upsertToolUse(sessionId: string, msg: NormalizedMessage): void {
    const slot = this.getSlot(sessionId);
    const normalizedMessage =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };
    slot.realtimeMessages = upsertToolUseRow(slot.realtimeMessages, normalizedMessage);
    recomputeMergedIfNeeded(slot);
    this.notify(sessionId);
  }

  /** Update session status. */
  setStatus(sessionId: string, status: SessionStatus): void {
    const slot = this.getSlot(sessionId);
    slot.status = status;
    this.notify(sessionId);
  }

  /** Whether the session's data is stale (older than the threshold). */
  isStale(sessionId: string): boolean {
    const slot = this.slots.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }

  /**
   * Update or create the session's streaming message (accumulated text so
   * far) under a well-known id, so subsequent calls replace the same row.
   *
   * The row's timestamp anchors to when the segment *started* streaming and
   * never refreshes afterwards: the finalized text must sort ahead of the
   * tool calls the model makes after writing it, not drift to the last
   * update and get pushed below them.
   */
  updateStreaming(sessionId: string, accumulatedText: string, msgProvider: LLMProvider): void {
    const slot = this.getSlot(sessionId);
    const streamId = `__streaming_${sessionId}`;
    const existing = slot.realtimeMessages.find((m) => m.id === streamId);
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId,
      timestamp: existing?.timestamp ?? new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = msg;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    this.notify(sessionId);
  }

  /**
   * Finalize streaming: convert the streaming message to a regular text
   * message. The well-known streaming ID is replaced with a unique `text_`
   * message ID (the prefix the adjacent-echo dedupe treats as "persisted
   * wins"). A no-op when no streaming row exists.
   */
  finalizeStreaming(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    const streamId = `__streaming_${sessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'text',
        role: 'assistant',
      };
      recomputeMergedIfNeeded(slot);
      this.notify(sessionId);
    }
  }

  /**
   * Buffers one `stream_delta` text fragment and (re)arms the session's 100ms
   * throttle that pushes the accumulated text into its `__streaming_` row.
   * Consumer: the realtime handler's stream_delta route.
   */
  appendStreamDelta(sessionId: string, text: string, msgProvider: LLMProvider): void {
    this.accumulatedStreams.set(sessionId, (this.accumulatedStreams.get(sessionId) ?? '') + text);
    if (!this.streamTimers.has(sessionId)) {
      const timer = window.setTimeout(() => {
        this.streamTimers.delete(sessionId);
        this.updateStreaming(sessionId, this.accumulatedStreams.get(sessionId) ?? '', msgProvider);
      }, 100);
      this.streamTimers.set(sessionId, timer);
    }
  }

  /**
   * Drains the session's buffered stream text into its `__streaming_` row and
   * finalizes that row as a regular assistant text message. A no-op when
   * nothing was buffered (the timer, if armed, is still cancelled). Consumer:
   * the realtime handler's content-frame flush gate and the complete frame.
   */
  flushStream(sessionId: string, msgProvider: LLMProvider): void {
    const timer = this.streamTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.streamTimers.delete(sessionId);
    }
    const buffer = this.accumulatedStreams.get(sessionId);
    if (buffer) {
      this.accumulatedStreams.delete(sessionId);
      this.updateStreaming(sessionId, buffer, msgProvider);
      this.finalizeStreaming(sessionId);
    }
  }

  /**
   * Records the highest live `seq` observed for the session. Consumers: the
   * realtime handler writes it on every sequenced frame; `chat.subscribe`
   * sends `getResumeSeq` as `lastSeq` so the server replays only the events
   * this client actually missed.
   */
  noteSeq(sessionId: string, seq: number): void {
    const known = this.resumeSeqs.get(sessionId) ?? 0;
    if (seq > known) {
      this.resumeSeqs.set(sessionId, seq);
    }
  }

  /** The `lastSeq` a `chat.subscribe` for this session should resume from. */
  getResumeSeq(sessionId: string): number {
    return this.resumeSeqs.get(sessionId) ?? 0;
  }

  /**
   * Drops every session's pending stream buffer and cancels its throttle
   * timer. Consumer: ChatInterface's teardown (unmount / New Session / no
   * session selected) — a fresh view must not inherit stale fragments.
   */
  resetStreamingState(): void {
    for (const timer of this.streamTimers.values()) {
      clearTimeout(timer);
    }
    this.streamTimers.clear();
    this.accumulatedStreams.clear();
  }

  /**
   * Drops every persisted row from `anchorId` onwards after an edit replaced
   * an already-sent message, plus the live rows that belonged to the replaced
   * turn. The optimistic replacement echo survives — it is stamped with the
   * surviving row count so the transcript renderer can tell it apart from the
   * turns it now sits after.
   */
  truncateAt(sessionId: string, anchorId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;

    const cutIndex = slot.serverMessages.findIndex(
      (message) => message.transcriptAnchorId === anchorId,
    );
    if (cutIndex < 0) return;

    slot.serverMessages = slot.serverMessages.slice(0, cutIndex);
    const replacements = slot.realtimeMessages.filter(
      (message) => message.replacesAnchorId === anchorId,
    );
    slot.realtimeMessages = replacements.length > 0
      ? [{ ...replacements[replacements.length - 1], replacesAfterRowCount: cutIndex }]
      : [];
    slot.total = slot.serverMessages.length;
    slot.offset = slot.serverMessages.length;
    recomputeMergedIfNeeded(slot);
    this.notify(sessionId);
  }

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  clearRealtime(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (slot) {
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      this.notify(sessionId);
    }
  }

  /** Merged messages for a session (for rendering). */
  getMessages(sessionId: string): NormalizedMessage[] {
    return this.slots.get(sessionId)?.merged ?? [];
  }

  /** Session slot (for status, pagination info, etc.). */
  getSessionSlot(sessionId: string): SessionSlot | undefined {
    return this.slots.get(sessionId);
  }
}
