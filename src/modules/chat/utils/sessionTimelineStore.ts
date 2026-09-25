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
 * - `applyServerEvent` flushes the buffered stream segment before applying any
 *   content-bearing frame (the routing table owns the gate), or a whole
 *   turn's text landed in one streaming bubble.
 * - `pruneRealtimeSupersededByServer` runs before the content-level bail-out
 *   of a latest refresh, or a delayed ws replay row survives forever.
 * - A drifting tail-relative offset during an older-page fetch is realigned
 *   by one bounded latest-page refresh before the retry.
 * - The streaming row's timestamp anchors at segment start and never
 *   refreshes, so the finalized text sorts ahead of the turn's later tool
 *   calls.
 * - Server history and realtime rows are stable-merged: each source keeps its
 *   own order because their wall clocks are not a shared causal clock.
 *
 * Consumer: `useSessionStore` (the React adapter) is the only production
 * consumer; `sessionTimelineStore.test.ts` and the hook-level
 * `sessionTimelineSequences.test.ts` drive it with scripted pages — frames go
 * through `applyServerEvent`, history through the fetch methods.
 */

import { isVolatileMessageId } from '@shared/protocol/messageKinds';
import { authenticatedFetch } from '@/shared/api';
import type { LLMProvider, NormalizedMessage, ServerEvent } from '@/shared/types';
import {
  isChatSubscribedEvent,
  isNormalizedMessageEvent,
  isProtocolErrorEvent,
  readFrameSeq,
  readFrameSessionId,
} from '@shared/protocol/frameNarrowing';
import {
  isOptimisticPromptRow,
  reconcileOptimisticPrompts,
  upsertToolUseRow,
} from '@/modules/chat/utils/sessionMessageReconciliation';
import type { PendingPrompt } from '@/modules/chat/utils/sessionMessageReconciliation';
import { isThinkingRowEchoOnServer, upsertThinkingRow } from '@/modules/chat/utils/sessionThinkingRows';
import {
  claimExactServerToolCall,
  claimMatchingServerToolCall,
  collectServerToolCalls,
} from '@/modules/chat/utils/toolIdentity';
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
  readMessageTime,
  reconcileProviderRowText,
} from '@/modules/chat/utils/sessionMessageTurnDedupe';

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export type SessionSlot = {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  /**
   * What the transcript held when each optimistic prompt was sent, so the
   * prompt can be paired with its persisted copy without consulting a clock,
   * an array length or the prompt's own text. Entries are dropped with the
   * row they describe.
   */
  pendingPrompts: Map<string, PendingPrompt>;
  /**
   * Remembers which persisted user row took over each optimistic prompt. The
   * pairing outlives paginated server windows so a session reload cannot
   * revive already-retired prompts when their server rows fall outside the
   * latest page; the retained local row still anchors unfinished live work.
   */
  retiredOptimisticUserAnchors: Map<string, string>;
  /**
   * The placeholder row holding streamed text that no engine row has claimed
   * yet, or `null`. Every engine follows a streamed segment with a real row
   * carrying its own id; until that row arrives the placeholder is all the
   * reply the transcript has.
   */
  streamingPlaceholderId: string | null;
  /** Counts streamed segments so their placeholders get distinct ids. */
  streamedSegmentCount: number;
  /**
   * Whether this session's run has finished. A finished run is the deadline
   * for every placeholder: once the transcript has been refreshed after it,
   * anything still unmatched is retired rather than left on screen forever.
   */
  runEnded: boolean;
  /**
   * For each realtime row, the id of the last server row that was already
   * present when the row first arrived — everything the transcript held by
   * then necessarily happened before it. Recorded once per row and never
   * revised, this is the arrival half of the merge's causal ordering; the
   * empty string means the transcript was empty and the row has no floor.
   */
  realtimeArrivalAnchors: Map<string, string>;
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
    pendingPrompts: new Map(),
    retiredOptimisticUserAnchors: new Map(),
    streamingPlaceholderId: null,
    streamedSegmentCount: 0,
    runEnded: false,
    realtimeArrivalAnchors: new Map(),
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
 * The id of the row that holds a streamed segment's text until the engine's
 * own row for that segment arrives.
 *
 * Streaming deltas carry no id of their own — they are fragments of a row
 * that does not exist yet — so the text has to live somewhere addressable
 * while it arrives. Every engine follows the segment with a real row that
 * has an engine-derived id, and `adoptStreamedSegment` swaps it in; the
 * placeholder is what the transcript shows in between.
 */
function buildStreamedTextPlaceholderId(sessionId: string, segment: number): string {
  return `__streamed_${sessionId}_${segment}`;
}

/** Whether a row is streamed text still waiting for the engine's own row. */
function isStreamedTextPlaceholder(message: NormalizedMessage): boolean {
  return message.id.startsWith('__streamed_');
}

/**
 * After a server refresh, drop the realtime rows the persisted transcript
 * already owns.
 *
 * Every engine derives a transcript row's id from its own record, so a live
 * row and its persisted copy arrive under the same id and this is a set
 * membership test — no text comparison, no turn reconstruction, no array
 * arithmetic. Rows not yet on disk (common right after `complete`, while
 * indexing lags) stay, so the pane never flashes the empty state.
 *
 * Three kinds of row have no engine id to be matched on, and each has a
 * bounded way out rather than an open-ended guess:
 *
 * - the optimistic prompt, retired against the persisted user row that
 *   appeared after the transcript position recorded at send time;
 * - the streamed-text placeholder, retired once the engine's own row for the
 *   segment arrives or a persisted row reconciles with it by
 *   `providerRowKey`;
 * - the synthetic settle row, which leaves with the card it settles.
 */
function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  slot: Pick<SessionSlot, 'pendingPrompts' | 'retiredOptimisticUserAnchors' | 'runEnded'>,
): NormalizedMessage[] {
  if (realtimeMessages.length === 0) {
    return realtimeMessages;
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  const claimedServerRowIds = new Set<string>();
  const allServerTools = collectServerToolCalls(serverMessages);

  // Optimistic prompts are kept in `realtimeMessages` even once retired: they
  // are what records where each turn begins, which the merge needs to place a
  // live reply below its own prompt. Hiding them is the merge's job.
  const { retiredAnchors, provenAnchors } = reconcileOptimisticPrompts(
    serverMessages,
    realtimeMessages,
    slot.pendingPrompts,
    slot.runEnded,
  );
  for (const [localId, serverId] of retiredAnchors) {
    slot.retiredOptimisticUserAnchors.set(localId, serverId);
  }

  /**
   * The persisted rows of the turn a live row belongs to, or an empty list
   * when that turn cannot be proven.
   *
   * The turn is named by the nearest user row above the live row, and the
   * pairing computed above says which persisted row that prompt became.
   * Proof comes from that pairing or from a transcript anchor — never from
   * what the prompt says, which is how an identical prompt from an earlier
   * turn used to be accepted as proof.
   */
  const serverTurnForRealtimeRow = (message: NormalizedMessage): NormalizedMessage[] => {
    const realtimeIndex = realtimeMessages.findIndex((candidate) => candidate.id === message.id);
    if (realtimeIndex < 0) return [];

    let turnStart = -1;
    let namedByLivePrompt = false;
    for (let index = realtimeIndex - 1; index >= 0; index -= 1) {
      const candidate = realtimeMessages[index];
      if (candidate.kind !== 'text' || candidate.role !== 'user') {
        continue;
      }
      namedByLivePrompt = true;
      // Only a proven pairing may name the turn. A prompt paired on the
      // permissive path — sent before any history was loaded — can point at
      // an older turn that merely happens to be the newest one in the
      // window, and fingerprinting against it would hide a real card.
      const pairedServerId = provenAnchors.get(candidate.id)
        ?? (candidate.id.startsWith('local_') ? null : candidate.id);
      turnStart = pairedServerId === null
        ? -1
        : serverMessages.findIndex((row) => row.id === pairedServerId);
      if (turnStart < 0 && candidate.transcriptAnchorId) {
        turnStart = serverMessages.findIndex((row) => row.transcriptAnchorId === candidate.transcriptAnchorId);
      }
      break;
    }

    // A live prompt that cannot be placed leaves the turn unproven; falling
    // back to the newest persisted turn would be a guess about which turn
    // this row belongs to, and a wrong one hides a card the user ran.
    if (turnStart < 0 && namedByLivePrompt) {
      return [];
    }

    if (turnStart < 0) {
      // No live prompt names this turn (a tab that did not send, a session
      // resumed mid-run). A live row cannot precede a turn already on disk,
      // so it belongs to the newest persisted one.
      for (let index = serverMessages.length - 1; index >= 0; index -= 1) {
        const candidate = serverMessages[index];
        if (candidate.kind === 'text' && candidate.role === 'user') {
          turnStart = index;
          break;
        }
      }
    }
    if (turnStart < 0) return [];

    const turnEnd = serverMessages.findIndex(
      (candidate, index) => index > turnStart && candidate.kind === 'text' && candidate.role === 'user',
    );
    return serverMessages.slice(turnStart, turnEnd < 0 ? undefined : turnEnd);
  };

  const retained = realtimeMessages.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }

    if (isOptimisticPromptRow(message)) {
      return true;
    }

    if (isStreamedTextPlaceholder(message)) {
      // Only a row that provably holds the same text may retire it: the
      // engine's own row (handled by the id test above and by
      // `adoptStreamedSegment`), or a persisted row the provider reconciles
      // by key and that the provider says is the more complete of the two.
      // Retiring it on a timer or at the end of the run would delete output
      // that exists nowhere else — several engines print text they never
      // persist.
      return !(
        message.providerRowKey
        && reconcileProviderRowText(message, serverMessages).winner === 'server'
      );
    }

    if (message.kind === 'tool_use' && message.toolId) {
      // An engine that names a call the same way on both transports is
      // already handled by the id test above; this catches the ones whose row
      // ids differ but whose native call id does not.
      if (claimExactServerToolCall(message, allServerTools, claimedServerRowIds)) {
        return false;
      }
      // Codex has no shared identity for a tool call at all: the rollout
      // records it as `ctc_…`/`call_…` while the live stream announces
      // `exec-…`, and nothing links the two but the command itself. Matching
      // by argument fingerprint is the only way to recognise the card, so it
      // is confined to the one persisted turn the prompt pairing proves —
      // never across turns, where an identical command is a real second call.
      const serverTools = collectServerToolCalls(serverTurnForRealtimeRow(message));
      if (claimMatchingServerToolCall(message, serverTools, claimedServerRowIds)) {
        return false;
      }
    }

    return true;
  });

  // A synthesized finalize row exists to settle one unpaired live card. Once
  // that card is gone (pruned as an echo above), the synthetic matches no
  // prune branch and no server id, so it would survive forever.
  const retainedToolUseIds = new Set(
    retained
      .filter((message) => message.kind === 'tool_use' && message.toolId)
      .map((message) => message.toolId as string),
  );
  return retained.filter((message) => {
    if (message.kind === 'tool_result' && message.id.startsWith('__finalized_')) {
      return message.toolId !== undefined && retainedToolUseIds.has(message.toolId);
    }
    return true;
  });
}

/**
 * Resolves, for each realtime row, the lowest server index it may be placed
 * after.
 *
 * A realtime row belongs to the turn opened by the nearest optimistic user row
 * above it — `realtimeMessages` is append-ordered, so that relationship is
 * already recorded by position and needs no extra field. Once the persisted
 * copy of that user turn retires the optimistic row, the pair is split across
 * the two sources; `retiredAnchors` says which server row took over, and that
 * row's index becomes the floor its turn's live rows may not sort above.
 *
 * Rows whose turn has no persisted counterpart yet get no floor and fall back
 * to timestamp placement.
 */
function resolveRealtimeFloors(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  retiredAnchors: Map<string, string>,
  arrivalAnchors: Map<string, string>,
): Map<string, number> {
  const serverIndexById = new Map(serverMessages.map((message, index) => [message.id, index]));
  const floors = new Map<string, number>();
  let turnFloor: number | null = null;

  for (const message of realtimeMessages) {
    if (message.kind === 'text' && message.role === 'user') {
      // A live user row opens a turn. Its floor is the persisted copy of that
      // prompt — the row an optimistic stand-in was retired against, or the
      // engine's own row once the transcript holds it. A prompt with no
      // persisted copy yet ends the previous turn without opening a floored
      // one: its rows cannot be placed relative to a server row that does not
      // exist.
      const anchorServerId = retiredAnchors.get(message.id) ?? message.id;
      const anchorIndex = serverIndexById.get(anchorServerId);
      turnFloor = anchorIndex === undefined ? null : anchorIndex;
      continue;
    }

    const arrivalAnchorId = arrivalAnchors.get(message.id);
    const arrivalFloor = arrivalAnchorId ? serverIndexById.get(arrivalAnchorId) : undefined;

    // Both floors are statements about the same row, so the later one wins:
    // the turn anchor knows which user turn caused it, the arrival anchor
    // knows what the transcript already held when it appeared.
    const floor = turnFloor !== null && arrivalFloor !== undefined
      ? Math.max(turnFloor, arrivalFloor)
      : turnFloor ?? arrivalFloor;

    if (floor !== undefined && floor !== null) {
      floors.set(message.id, floor);
    }
  }

  return floors;
}

/**
 * Interleaves two already ordered sources without reordering either source.
 *
 * Each source's own order is authoritative — server rows follow the transcript,
 * realtime rows follow arrival. Only the interleave has to be decided, and the
 * two sources' timestamps come from different machines, so a causal anchor
 * decides it wherever one exists: a realtime row is held back until every
 * server row up to and including its turn's anchor has been emitted.
 * Timestamps place only the rows no anchor covers.
 */
function stableMergeMessageSources(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  realtimeTurnFloors: Map<string, number> = new Map(),
): NormalizedMessage[] {
  const merged: NormalizedMessage[] = [];
  let serverIndex = 0;
  let realtimeIndex = 0;

  while (serverIndex < serverMessages.length && realtimeIndex < realtimeMessages.length) {
    const realtimeMessage = realtimeMessages[realtimeIndex];
    const floor = realtimeTurnFloors.get(realtimeMessage.id);
    const heldBackByAnchor = floor !== undefined && serverIndex <= floor;

    if (
      heldBackByAnchor
      || compareMessagesChronologically(serverMessages[serverIndex], realtimeMessage) <= 0
    ) {
      merged.push(serverMessages[serverIndex]);
      serverIndex++;
    } else {
      merged.push(realtimeMessage);
      realtimeIndex++;
    }
  }

  merged.push(
    ...serverMessages.slice(serverIndex),
    ...realtimeMessages.slice(realtimeIndex),
  );
  return merged;
}

function computeMerged(
  server: NormalizedMessage[],
  realtime: NormalizedMessage[],
  arrivalAnchors: Map<string, string>,
  slot: Pick<SessionSlot, 'pendingPrompts' | 'retiredOptimisticUserAnchors' | 'runEnded'>,
): NormalizedMessage[] {
  if (realtime.length === 0) {
    return server;
  }

  const serverIds = new Set(server.map((message) => message.id));
  const { retiredAnchors } = reconcileOptimisticPrompts(
    server,
    realtime,
    slot.pendingPrompts,
    slot.runEnded,
  );
  for (const [localId, serverId] of retiredAnchors) {
    slot.retiredOptimisticUserAnchors.set(localId, serverId);
  }
  // Retired prompts stay in `realtime` as turn boundaries; the merge is where
  // they stop being rendered.
  const reconciledRealtime = realtime.filter(
    (message) => !slot.retiredOptimisticUserAnchors.has(message.id),
  );
  if (server.length === 0) {
    return reconciledRealtime;
  }
  const providerRowReconciliations = new Map<string, ReturnType<typeof reconcileProviderRowText>>();
  const reconcileRealtimeProviderRow = (message: NormalizedMessage) => {
    const cached = providerRowReconciliations.get(message.id);
    if (cached) {
      return cached;
    }
    const reconciliation = reconcileProviderRowText(message, server);
    providerRowReconciliations.set(message.id, reconciliation);
    return reconciliation;
  };
  const serverRowsSupersededByRealtime = new Set(
    reconciledRealtime.flatMap((message) => {
      if (
        !message.providerRowKey
        || !((message.kind === 'text' && message.role === 'assistant') || message.kind === 'stream_delta')
      ) {
        return [];
      }
      const reconciliation = reconcileRealtimeProviderRow(message);
      return reconciliation.winner === 'realtime' && reconciliation.serverMessageId
        ? [reconciliation.serverMessageId]
        : [];
    }),
  );
  const extra = reconciledRealtime.filter((message) => {
    // The id is the join. Everything below covers only the rows that have no
    // engine id yet: streamed text still waiting for its row, and the rows
    // whose engines reconcile through `providerRowKey` instead.
    if (serverIds.has(message.id)) {
      return false;
    }
    if (message.kind === 'thinking' && isThinkingRowEchoOnServer(message, server)) {
      return false;
    }
    if (
      (message.kind === 'text' && message.role === 'assistant')
      || message.kind === 'stream_delta'
    ) {
      if (reconcileRealtimeProviderRow(message).winner === 'server') {
        return false;
      }
    }
    return true;
  });

  const prunedServer = server.filter((message) => !serverRowsSupersededByRealtime.has(message.id));

  if (extra.length === 0) {
    return prunedServer;
  }

  // Interleave the two sources without reordering either one. Placement
  // follows each live row's causal anchor where one exists; the clocks only
  // place rows no anchor covers.
  return stableMergeMessageSources(
    prunedServer,
    extra,
    resolveRealtimeFloors(
      prunedServer,
      realtime,
      slot.retiredOptimisticUserAnchors,
      arrivalAnchors,
    ),
  );
}

/**
 * Stamps every realtime row that does not have one yet with the transcript
 * tail as it stands right now.
 *
 * This runs on the same pass that rebuilds the merged view, which happens
 * after every slot mutation, so a row is stamped on the recompute triggered by
 * its own arrival. An existing stamp is never revised — the point is what the
 * transcript held *then*, not now.
 */
function recordRealtimeArrivalAnchors(slot: SessionSlot): void {
  const anchors = slot.realtimeArrivalAnchors;
  const serverTailId = slot.serverMessages.length > 0
    ? slot.serverMessages[slot.serverMessages.length - 1].id
    : '';

  for (const message of slot.realtimeMessages) {
    if (!anchors.has(message.id)) {
      anchors.set(message.id, serverTailId);
    }
  }

  // Rows retired by a prune or a replacement leave their stamps behind; drop
  // them so a long-lived session's map stays proportional to its live rows.
  if (
    anchors.size > slot.realtimeMessages.length
    || slot.retiredOptimisticUserAnchors.size > slot.realtimeMessages.length
  ) {
    const liveIds = new Set(slot.realtimeMessages.map((message) => message.id));
    for (const id of anchors.keys()) {
      if (!liveIds.has(id)) {
        anchors.delete(id);
      }
    }
    for (const id of slot.retiredOptimisticUserAnchors.keys()) {
      if (!liveIds.has(id)) {
        slot.retiredOptimisticUserAnchors.delete(id);
      }
    }
  }
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
  recordRealtimeArrivalAnchors(slot);
  slot.merged = computeMerged(
    slot.serverMessages,
    slot.realtimeMessages,
    slot.realtimeArrivalAnchors,
    slot,
  );
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

/**
 * What one server event kind means to the timeline. This table is the single
 * authority on realtime protocol routing — the flush gate, the persistence
 * decision and the state action all come from here, so adding a kind is one
 * row instead of a sweep across handler tables.
 */
const SERVER_EVENT_ROUTES: Record<string, { flushesStream: boolean; action: ServerEventAction }> = {
  // Provider timeline rows.
  text: { flushesStream: true, action: 'append' },
  tool_result: { flushesStream: true, action: 'append' },
  error: { flushesStream: true, action: 'append' },
  interactive_prompt: { flushesStream: true, action: 'append' },
  task_notification: { flushesStream: true, action: 'append' },
  session_created: { flushesStream: true, action: 'append' },
  // Preserved quirk: this frame persists a row that nothing renders. Kept so
  // the timeline stays a lossless record until a decision retires it.
  permission_resolved: { flushesStream: true, action: 'append' },
  thinking: { flushesStream: true, action: 'thinking' },
  tool_use: { flushesStream: true, action: 'toolUse' },
  stream_delta: { flushesStream: false, action: 'streamDelta' },
  stream_end: { flushesStream: false, action: 'streamEnd' },
  complete: { flushesStream: true, action: 'complete' },
  // Control frames the gateway owns.
  history_truncated: { flushesStream: false, action: 'truncate' },
  protocol_error: { flushesStream: false, action: 'protocolError' },
  chat_subscribed: { flushesStream: false, action: 'ack' },
  status: { flushesStream: false, action: 'status' },
  permission_request: { flushesStream: false, action: 'permissionRequest' },
  permission_cancelled: { flushesStream: false, action: 'permissionCancelled' },
  // Sidebar/global events — owned by useProjectsState. `session_removed` is a
  // batch frame with no id/sessionId; without this row the unknown-kind
  // fallback appended it to the viewed session's timeline.
  session_upserted: { flushesStream: false, action: 'none' },
  session_removed: { flushesStream: false, action: 'none' },
  // Owned by useScheduledJobs; a job-list signal, never a timeline row.
  scheduled_jobs_changed: { flushesStream: false, action: 'none' },
  loading_progress: { flushesStream: false, action: 'none' },
};

/**
 * Unknown kinds flush and append like any content row: the timeline stays a
 * lossless record of frames it does not yet understand, exactly as it did
 * before this table existed.
 */
const UNKNOWN_EVENT_ROUTE: { flushesStream: boolean; action: ServerEventAction } = {
  flushesStream: true,
  action: 'append',
};

type ServerEventAction =
  | 'append'
  | 'thinking'
  | 'toolUse'
  | 'streamDelta'
  | 'streamEnd'
  | 'complete'
  | 'truncate'
  | 'protocolError'
  | 'ack'
  | 'status'
  | 'permissionRequest'
  | 'permissionCancelled'
  | 'none';

/**
 * The side effects one frame requires from the handler, extracted by
 * `applyServerEvent`. The store owns what a frame *means*; the handler owns
 * how the app *reacts* (sounds, permission lists, refreshes) — this union is
 * the seam between the two.
 */
export type ServerEventDirective =
  | {
      effect: 'chat_subscribed';
      sessionId: string;
      stale: boolean;
      isProcessing: boolean;
      pendingPermissions: unknown[] | null;
    }
  | { effect: 'protocol_error'; sessionId: string; code: unknown; error: unknown }
  | { effect: 'complete'; sessionId: string | null; success: boolean; aborted: boolean }
  | {
      effect: 'status';
      sessionId: string | null;
      text: string | null;
      canInterrupt: boolean;
      tokenBudget: unknown;
    }
  | {
      effect: 'permission_request';
      sessionId: string | null;
      requestId: string | null;
      toolName: string;
      input: unknown;
      context: unknown;
    }
  | { effect: 'permission_cancelled'; sessionId: string | null; requestId: string | null };

export type ApplyServerEventOptions = {
  /** Where frames without a sessionId attach (the actively viewed session). */
  fallbackSessionId?: string | null;
  /**
   * Authoritative provider identity for rows the store synthesizes (the
   * streaming row, protocol-error rows).
   */
  provider?: LLMProvider;
};

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
  /** Retains the open text segment's body and cross-transport identity until it is finalized. */
  private readonly accumulatedStreams = new Map<string, {
    content: string;
    provider: LLMProvider;
    providerRowKey?: string;
  }>();
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

  private getSlot(sessionId: string): SessionSlot {
    const slot = this.slots.get(sessionId);
    if (slot) {
      return slot;
    }
    const created = createEmptySlot();
    this.slots.set(sessionId, created);
    return created;
  }

  /**
   * The one entry point for server frames. Applies the frame's timeline state
   * — flush gate, upserts, appends, truncation, stream lifecycle, resume seq,
   * in the order this module's contracts require — and returns the side
   * effects the handler owes the rest of the app. Frame ordering is the
   * caller's responsibility: frames must arrive in server order.
   */
  applyServerEvent(
    msg: ServerEvent,
    options: ApplyServerEventOptions = {},
  ): ServerEventDirective | null {
    const sid = readFrameSessionId(msg) || options.fallbackSessionId || null;
    const provider = options.provider ?? 'claude';

    // Replay progress first — before any routing (order-sensitive contract).
    const frameSeq = readFrameSeq(msg);
    if (sid && frameSeq !== null) {
      this.noteSeq(sid, frameSeq);
    }

    const route = SERVER_EVENT_ROUTES[msg.kind] ?? UNKNOWN_EVENT_ROUTE;
    // Everything the route table dispatches beyond the gateway's own frames is
    // a provider message; narrowing once here is what lets those branches read
    // message fields at all.
    const message = isNormalizedMessageEvent(msg) ? msg : null;
    if (sid && route.flushesStream) {
      // Any content-bearing frame ends the current text segment: once the
      // model moves from prose to a tool call or its next thinking block, the
      // buffered text must finalize as its own message instead of absorbing
      // whatever comes after it. zcode's engine never emits text-boundary
      // events, so without this flush a whole turn's text landed in one
      // streaming bubble.
      this.flushStream(sid);
    }

    switch (route.action) {
      case 'none':
        return null;

      case 'truncate': {
        // An already-sent message was replaced. Every client watching this
        // session drops the superseded turns before the replacement streams
        // in, so a second tab does not end up showing the question twice.
        if (sid && message && typeof message.anchorId === 'string') {
          this.truncateAt(sid, message.anchorId);
        }
        return null;
      }

      case 'protocolError': {
        if (!sid || !isProtocolErrorEvent(msg)) return null;
        // Surface the failure in the conversation — the run never started (or
        // was rejected), so no `complete` follows.
        this.appendRealtime(sid, {
          id: `protocol_error_${Date.now()}`,
          sessionId: sid,
          timestamp: new Date().toISOString(),
          provider,
          kind: 'error',
          content: String(msg.error || 'Request failed'),
        });
        return { effect: 'protocol_error', sessionId: sid, code: msg.code, error: msg.error };
      }

      case 'ack': {
        if (!sid || !isChatSubscribedEvent(msg)) return null;
        // The ack's `lastSeq` is the server's per-session watermark (max-
        // merged in, so the client's replay cursor can only move forward).
        if (msg.lastSeq > 0) {
          this.noteSeq(sid, msg.lastSeq);
        }
        return {
          effect: 'chat_subscribed',
          sessionId: sid,
          stale: msg.stale,
          isProcessing: msg.isProcessing,
          pendingPermissions: Array.isArray(msg.pendingPermissions)
            ? msg.pendingPermissions
            : null,
        };
      }

      case 'streamDelta': {
        const text = message?.content || '';
        if (!text || !sid || !message) return null;
        this.appendStreamDelta(sid, message, provider);
        return null;
      }

      case 'streamEnd': {
        if (!sid) return null;
        // Flushes the buffered text (finalizing its row when any existed),
        // then closes the synthetic streaming row even when nothing was
        // buffered — finalizeStreaming is a no-op when none exists.
        this.flushStream(sid);
        this.finalizeStreaming(sid);
        return null;
      }

      case 'thinking': {
        if (!sid) return null;
        this.upsertThinkingDelta(sid, msg as NormalizedMessage);
        return null;
      }

      case 'toolUse': {
        if (!sid) return null;
        this.upsertToolUse(sid, msg as NormalizedMessage);
        return null;
      }

      case 'complete': {
        // Terminal state: settle tool cards whose result frame never arrived,
        // so a lost frame cannot leave a card running forever.
        if (sid) {
          this.finalizeRunningTools(sid);
          // The run is the deadline for rows that never got an engine id. The
          // refresh that follows this event is the last chance for a
          // persisted copy to show up; after it, anything still unmatched is
          // retired rather than left duplicating the transcript forever.
          this.getSlot(sid).runEnded = true;
        }
        return {
          effect: 'complete',
          sessionId: sid,
          success: message?.success !== false,
          aborted: message?.aborted === true,
        };
      }

      case 'status':
        return {
          effect: 'status',
          sessionId: sid,
          text: message?.text || null,
          canInterrupt: message?.canInterrupt !== false,
          tokenBudget: message?.tokenBudget,
        };

      case 'permissionRequest':
        return {
          effect: 'permission_request',
          sessionId: sid,
          requestId: message?.requestId || null,
          toolName: message?.toolName || 'UnknownTool',
          input: message?.input,
          context: message?.context,
        };

      case 'permissionCancelled':
        return {
          effect: 'permission_cancelled',
          sessionId: sid,
          requestId: message?.requestId || null,
        };

      case 'append':
      default:
        if (sid) {
          this.appendRealtime(sid, msg as NormalizedMessage);
        }
        return null;
    }
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
        const realtimeBeforePrune = slot.realtimeMessages;
        slot.realtimeMessages = pruneRealtimeSupersededByServer(
          slot.serverMessages,
          slot.realtimeMessages,
          slot,
        );
        this.discardStreamBufferIfPruned(sessionId, realtimeBeforePrune, slot.realtimeMessages);
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
      slot,
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
    this.discardStreamBufferIfPruned(sessionId, slot.realtimeMessages, prunedRealtimeMessages);
    slot.realtimeMessages = prunedRealtimeMessages;
    recomputeMergedIfNeeded(slot);

    return { applied: true, changed: true, deferred: false };
  }

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  appendRealtime(sessionId: string, msg: NormalizedMessage): void {
    // A frame with no id is not a renderable timeline row — gateway frames
    // such as `session_removed` carry only their own payload. Admitting one
    // used to crash every later recompute of the merged view.
    if (typeof msg.id !== 'string' || msg.id.length === 0) {
      return;
    }
    const slot = this.getSlot(sessionId);
    const message =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };

    // An optimistic prompt records the transcript's last row at send time.
    // Everything persisted after that row is newer than the prompt, so the
    // first user row past it is the prompt's own copy — settled without a
    // clock, a row count, or a look at what the prompt says.
    if (isOptimisticPromptRow(message) && !slot.pendingPrompts.has(message.id)) {
      slot.pendingPrompts.set(message.id, {
        afterRowId: slot.serverMessages.length > 0
          ? slot.serverMessages[slot.serverMessages.length - 1].id
          : null,
      });
      slot.runEnded = false;
    }

    let updated = this.replaceRealtimeRowById(slot, message)
      ?? this.adoptEngineRow(slot, message)
      ?? [...slot.realtimeMessages, message];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    this.notify(sessionId);
  }

  /**
   * Replaces a realtime row an engine has already named, or returns null when
   * this row is new.
   *
   * A transcript row's id is derived from the engine's own record, so two
   * frames carrying one id are one row — the second is the first grown or
   * corrected. Realtime frames were previously only reconciled against
   * *history* by id and appended against each other, so an engine that
   * reported one reply as it was written put every partial in the transcript
   * as its own message. Ids minted per frame (`vol_…`) are excluded: they
   * promise nothing across frames.
   *
   * The original timestamp is kept, because it is where the row belongs
   * relative to the tools around it — a later frame must not reorder it.
   */
  private replaceRealtimeRowById(
    slot: SessionSlot,
    message: NormalizedMessage,
  ): NormalizedMessage[] | null {
    if (isVolatileMessageId(message.id)) {
      return null;
    }
    const index = slot.realtimeMessages.findIndex((row) => row.id === message.id);
    if (index < 0) {
      return null;
    }
    const next = [...slot.realtimeMessages];
    next[index] = { ...message, timestamp: slot.realtimeMessages[index].timestamp };
    return next;
  }

  /**
   * Lets an arriving engine row take the place of the client-side stand-in it
   * makes obsolete, or returns null when it replaces nothing.
   *
   * Two rows in the timeline are written by the client because the engine has
   * not named them yet: the text of a segment still streaming, and the prompt
   * the user just sent. Both are stand-ins for a row the engine will name.
   * When that row arrives it is swapped in, keeping the stand-in's position
   * and start time, so the transcript carries the engine's identity from then
   * on. Without the swap the stand-in and the persisted copy are two rows
   * that only a text comparison could relate — which is how a message came to
   * be rendered twice.
   */
  private adoptEngineRow(
    slot: SessionSlot,
    message: NormalizedMessage,
  ): NormalizedMessage[] | null {
    if (message.kind !== 'text') {
      return null;
    }

    if (message.role === 'assistant' && slot.streamingPlaceholderId !== null) {
      const index = slot.realtimeMessages.findIndex(
        (row) => row.id === slot.streamingPlaceholderId,
      );
      slot.streamingPlaceholderId = null;
      if (index < 0) {
        return null;
      }
      const next = [...slot.realtimeMessages];
      // The placeholder's timestamp is when the segment started streaming,
      // which is where the reply belongs relative to the tools that followed.
      next[index] = { ...message, timestamp: slot.realtimeMessages[index].timestamp };
      return next;
    }

    // Some engines echo the prompt back on the live stream (codex does, claude
    // does not). The echo is the engine's own row for the send the optimistic
    // prompt stands in for, so it takes that row's place rather than being
    // appended beside it.
    if (message.role === 'user' && !message.id.startsWith('local_')) {
      const index = slot.realtimeMessages.findIndex(
        (row) => isOptimisticPromptRow(row) && !slot.retiredOptimisticUserAnchors.has(row.id),
      );
      if (index < 0) {
        return null;
      }
      const standIn = slot.realtimeMessages[index];
      const next = [...slot.realtimeMessages];
      next[index] = { ...message, timestamp: standIn.timestamp };
      slot.pendingPrompts.delete(standIn.id);
      return next;
    }

    return null;
  }

  /**
   * Ingest a realtime `thinking` frame. Frames sharing one message id belong
   * to the same reasoning block (zcode emits per-delta frames with a stable
   * block id; other providers emit one frame per block), so a matching row
   * receives the frame's content instead of the frame becoming its own
   * transcript entry.
   */
  private upsertThinkingDelta(sessionId: string, msg: NormalizedMessage): void {
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
  private upsertToolUse(sessionId: string, msg: NormalizedMessage): void {
    const slot = this.getSlot(sessionId);
    const normalizedMessage =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };
    slot.realtimeMessages = upsertToolUseRow(slot.realtimeMessages, normalizedMessage);
    recomputeMergedIfNeeded(slot);
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
  private updateStreaming(
    sessionId: string,
    accumulatedStream: { content: string; provider: LLMProvider; providerRowKey?: string },
  ): void {
    const slot = this.getSlot(sessionId);
    const streamId = `__streaming_${sessionId}`;
    const existing = slot.realtimeMessages.find((m) => m.id === streamId);
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId,
      timestamp: existing?.timestamp ?? new Date().toISOString(),
      provider: accumulatedStream.provider,
      kind: 'stream_delta',
      content: accumulatedStream.content,
      providerRowKey: accumulatedStream.providerRowKey,
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
   * Closes the streamed segment: the accumulating `__streaming_` row becomes
   * a placeholder assistant row that holds the text until the engine's own
   * row for that segment arrives and takes its place. A no-op when no
   * streaming row exists.
   */
  private finalizeStreaming(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    const streamId = `__streaming_${sessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.streamedSegmentCount += 1;
      const placeholderId = buildStreamedTextPlaceholderId(sessionId, slot.streamedSegmentCount);
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: placeholderId,
        kind: 'text',
        role: 'assistant',
      };
      slot.streamingPlaceholderId = placeholderId;
      recomputeMergedIfNeeded(slot);
      this.notify(sessionId);
    }
  }

  /**
   * Settles every tool_use row whose `tool_result` frame never arrived.
   *
   * A run's `complete` frame is the terminal state — by then every tool call
   * has been resolved engine-side, so a still-unpaired card can only mean the
   * result frame was lost or the engine settles its tools in one batch at
   * step end (zcode's parallel steps do exactly that). Without this, such a
   * card renders as "running" forever.
   *
   * Each unpaired card gets a synthetic `tool_result` row appended, which the
   * renderer's per-toolId attachment treats like any result. A genuine late
   * result frame is ordered after the synthetic row, so the attachment map's
   * last-write-wins keeps the real content.
   */
  private finalizeRunningTools(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;

    const settledToolIds = new Set(
      slot.realtimeMessages
        .filter((m) => m.kind === 'tool_result')
        .map((m) => m.toolId ?? ''),
    );
    const unpaired = new Map<string, NormalizedMessage>();
    for (const row of slot.realtimeMessages) {
      if (row.kind !== 'tool_use' || !row.toolId || settledToolIds.has(row.toolId)) {
        continue;
      }
      unpaired.set(row.toolId, row);
    }
    if (unpaired.size === 0) {
      return;
    }

    const synthetic: NormalizedMessage[] = [...unpaired.entries()].map(([toolId, row]) => ({
      id: `__finalized_${toolId}`,
      sessionId: row.sessionId,
      timestamp: new Date().toISOString(),
      provider: row.provider,
      kind: 'tool_result',
      toolId,
      content: '',
      toolResult: { content: '', isError: false },
    }));
    slot.realtimeMessages = [...slot.realtimeMessages, ...synthetic];
    recomputeMergedIfNeeded(slot);
    this.notify(sessionId);
  }

  /**
   * Buffers one `stream_delta` text fragment and (re)arms the session's 100ms
   * throttle that pushes the accumulated text into its `__streaming_` row.
   * Consumer: `applyServerEvent`'s stream_delta route.
   */
  private appendStreamDelta(
    sessionId: string,
    message: NormalizedMessage,
    fallbackProvider: LLMProvider,
  ): void {
    const text = message.content || '';
    const existing = this.accumulatedStreams.get(sessionId);
    if (
      existing
      && existing.providerRowKey !== message.providerRowKey
      && Boolean(existing.providerRowKey || message.providerRowKey)
    ) {
      // A stable identity must cover the whole buffered segment. Close the
      // current segment when the provider changes keys or crosses between a
      // keyed row and an unkeyed stdout/notice frame; otherwise unrelated text
      // inherits a key and prevents the persisted answer from reconciling.
      this.flushStream(sessionId);
    }

    const current = this.accumulatedStreams.get(sessionId);
    this.accumulatedStreams.set(sessionId, {
      content: (current?.content ?? '') + text,
      provider: message.provider ?? current?.provider ?? fallbackProvider,
      providerRowKey: message.providerRowKey ?? current?.providerRowKey,
    });
    if (!this.streamTimers.has(sessionId)) {
      const timer = window.setTimeout(() => {
        this.streamTimers.delete(sessionId);
        const accumulatedStream = this.accumulatedStreams.get(sessionId);
        if (accumulatedStream) {
          this.updateStreaming(sessionId, accumulatedStream);
        }
      }, 100);
      this.streamTimers.set(sessionId, timer);
    }
  }

  /**
   * Drops the session's pending stream buffer and throttle timer when a
   * refresh pruned the streaming row as a transcript echo. The server now owns
   * that text, so the buffer must die with its row: a later flush (replayed
   * `stream_end`, a content frame) would otherwise re-append the stale
   * accumulated text as a brand-new bubble — the duplicate reply seen after
   * leaving the PWA mid-stream and coming back.
   */
  private discardStreamBufferIfPruned(
    sessionId: string,
    realtimeBefore: NormalizedMessage[],
    realtimeAfter: NormalizedMessage[],
  ): void {
    const streamId = `__streaming_${sessionId}`;
    if (!realtimeBefore.some((message) => message.id === streamId)) {
      return;
    }
    if (realtimeAfter.some((message) => message.id === streamId)) {
      return;
    }
    const timer = this.streamTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.streamTimers.delete(sessionId);
    }
    this.accumulatedStreams.delete(sessionId);
  }

  /**
   * Drains the session's buffered stream text into its `__streaming_` row and
   * finalizes that row as a regular assistant text message. A no-op when
   * nothing was buffered (the timer, if armed, is still cancelled). Consumer:
   * `applyServerEvent`'s flush gate, stream_end and complete routes.
   */
  private flushStream(sessionId: string): void {
    const timer = this.streamTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.streamTimers.delete(sessionId);
    }
    const accumulatedStream = this.accumulatedStreams.get(sessionId);
    if (accumulatedStream?.content) {
      this.accumulatedStreams.delete(sessionId);
      this.updateStreaming(sessionId, accumulatedStream);
      this.finalizeStreaming(sessionId);
    }
  }

  /**
   * Records the highest live `seq` observed for the session. Consumers:
   * `applyServerEvent` writes it on every sequenced frame and merges the
   * `chat_subscribed` ack's authoritative watermark; `chat.subscribe` sends
   * `getResumeSeq` as `lastSeq` so the server replays only the events this
   * client actually missed.
   */
  private noteSeq(sessionId: string, seq: number): void {
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
   * turn. The optimistic replacement echo survives, re-anchored on the last
   * surviving persisted row so it retires against its own copy and not one of
   * the turns the edit removed.
   */
  private truncateAt(sessionId: string, anchorId: string): void {
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
    const survivingTail = slot.serverMessages[slot.serverMessages.length - 1];
    slot.pendingPrompts.clear();
    slot.retiredOptimisticUserAnchors.clear();
    slot.realtimeMessages = replacements.length > 0
      ? [replacements[replacements.length - 1]]
      : [];
    // The replacement prompt is newer than everything the cut left behind, so
    // it anchors on the surviving tail rather than the row it replaced.
    const replacement = slot.realtimeMessages[0];
    if (replacement && isOptimisticPromptRow(replacement)) {
      slot.pendingPrompts.set(replacement.id, { afterRowId: survivingTail?.id ?? null });
    }
    slot.total = slot.serverMessages.length;
    slot.offset = slot.serverMessages.length;
    recomputeMergedIfNeeded(slot);
    this.notify(sessionId);
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
