/**
 * Turn-level echo dedupe for the session message store.
 *
 * Pure functions only — this module must stay free of Vite/environment
 * dependencies so it is importable from node:test, mirroring
 * sessionMessagePagination.ts / sessionMessageReconciliation.ts.
 */

import type { NormalizedMessage } from '@/shared/types';

export function readMessageTime(m: NormalizedMessage): number | null {
  const time = Date.parse(m.timestamp);
  return Number.isFinite(time) ? time : null;
}

export function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

/**
 * Match assistant texts with tolerance for streaming whitespace differences,
 * token concatenation boundary anomalies, and minor formatting discrepancies.
 */
export function isAssistantTextMatch(candidate: string, target: string): boolean {
  const a = (candidate || '').trim();
  const b = (target || '').trim();
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }

  // 1. Match with all whitespace stripped (handles lost spaces from token boundary or line breaks)
  const compactA = a.replace(/\s+/g, '');
  const compactB = b.replace(/\s+/g, '');
  if (compactA === compactB) {
    return true;
  }

  // 2. Match streaming progressive prefix (where one is an in-progress prefix of the other)
  const minLen = Math.min(compactA.length, compactB.length);
  const maxLen = Math.max(compactA.length, compactB.length);
  if (minLen >= 20 && (compactA.startsWith(compactB) || compactB.startsWith(compactA))) {
    if (minLen / maxLen >= 0.75 || minLen >= 100) {
      return true;
    }
  }

  return false;
}

type ProviderRowTextReconciliation = {
  winner: 'server' | 'realtime' | 'distinct';
  serverMessageId?: string;
};

/**
 * Chooses which transport owns a uniquely keyed provider row. The provider
 * identity is the proof; body text is never normalized or compared. A complete
 * history row wins, while a complete realtime body may replace an explicitly
 * truncated history body. Ambiguous keys remain visible.
 */
export function reconcileProviderRowText(
  realtimeMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): ProviderRowTextReconciliation {
  if (!realtimeMessage.providerRowKey) {
    return { winner: 'distinct' };
  }

  const keyedServerRows = serverMessages.filter((serverMessage) =>
    serverMessage.provider === realtimeMessage.provider
    && serverMessage.kind === 'text'
    && serverMessage.role === 'assistant'
    && Boolean(serverMessage.providerRowKey),
  );
  if (keyedServerRows.length === 0) {
    return { winner: 'distinct' };
  }

  const matchingRows = keyedServerRows.filter(
    (serverMessage) => serverMessage.providerRowKey === realtimeMessage.providerRowKey,
  );
  if (matchingRows.length !== 1) {
    return { winner: 'distinct' };
  }

  const serverMessage = matchingRows[0];
  const result = (winner: 'server' | 'realtime'): ProviderRowTextReconciliation => ({
    winner,
    serverMessageId: serverMessage.id,
  });

  const serverCompleteness = serverMessage.contentCompleteness ?? 'complete';
  const realtimeCompleteness = realtimeMessage.contentCompleteness ?? 'complete';
  if (serverCompleteness === 'complete') {
    return result('server');
  }
  if (realtimeCompleteness === 'complete') {
    return result('realtime');
  }
  return (serverMessage.content || '').length >= (realtimeMessage.content || '').length
    ? result('server')
    : result('realtime');
}

/** The user row that opened this live row's turn, by arrival order alone. */
function findTurnUserRowByArrival(
  message: NormalizedMessage,
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage | null {
  const index = realtimeMessages.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) {
    return null;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = realtimeMessages[i];
    if (candidate.kind === 'text' && candidate.role === 'user') {
      return candidate;
    }
  }
  return null;
}

type ServerTurnRange = { start: number; end: number };

function turnRangeFrom(serverMessages: NormalizedMessage[], start: number): ServerTurnRange {
  const end = serverMessages.findIndex(
    (candidate, index) => index > start && candidate.kind === 'text' && candidate.role === 'user',
  );
  return { start, end: end < 0 ? serverMessages.length : end };
}

function findNewestServerTurnRange(serverMessages: NormalizedMessage[]): ServerTurnRange | null {
  for (let i = serverMessages.length - 1; i >= 0; i -= 1) {
    const candidate = serverMessages[i];
    if (candidate.kind === 'text' && candidate.role === 'user') {
      return turnRangeFrom(serverMessages, i);
    }
  }
  return null;
}

function findServerTurnRangeByAnchor(
  serverMessages: NormalizedMessage[],
  anchorId: string,
): ServerTurnRange | null {
  const start = serverMessages.findIndex(
    (candidate) => candidate.kind === 'text'
      && candidate.role === 'user'
      && candidate.transcriptAnchorId === anchorId,
  );
  return start < 0 ? null : turnRangeFrom(serverMessages, start);
}

function findLatestServerTurnRangeByUserContent(
  serverMessages: NormalizedMessage[],
  userContent: string,
): ServerTurnRange | null {
  for (let i = serverMessages.length - 1; i >= 0; i -= 1) {
    const candidate = serverMessages[i];
    if (
      candidate.kind === 'text'
      && candidate.role === 'user'
      && (candidate.content || '').trim() === userContent
    ) {
      return turnRangeFrom(serverMessages, i);
    }
  }
  return null;
}

/** Whether one server turn already carries this assistant text. */
function turnCarriesText(
  serverMessages: NormalizedMessage[],
  range: ServerTurnRange,
  assistantText: string,
): boolean {
  const turnSegments = serverMessages
    .slice(range.start + 1, range.end)
    .filter((serverMessage) =>
      serverMessage.kind === 'text'
      && serverMessage.role === 'assistant'
      && (serverMessage.content || '').length > 0,
    );

  if (turnSegments.some((serverMessage) => isAssistantTextMatch(serverMessage.content || '', assistantText))) {
    return true;
  }
  // Segments are joined on their raw content so inter-segment whitespace
  // survives, matching how the live deltas concatenated.
  return isAssistantTextMatch(turnSegments.map((serverMessage) => serverMessage.content || '').join(''), assistantText);
}



/**
 * Tests whether a realtime assistant text row (a finalized streaming bubble)
 * is already persisted in the same conversation turn on the server.
 *
 * Two shapes match:
 * 1. The row equals one persisted text segment verbatim (the common case —
 *    providers that segment their live stream with `stream_end` produce one
 *    finalized row per persisted segment).
 * 2. The row equals the concatenation of the turn's persisted text segments.
 *    Providers without live segment markers stream a whole turn as one
 *    concatenated bubble, while the transcript stores each text segment as
 *    its own row; no single row can match, and without the joined comparison
 *    the turn would render twice.
 */
export function isAssistantTextEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): boolean {
  const assistantText = (message.content || '').trim();
  if (!assistantText) {
    return false;
  }

  // A provider row key is the only cross-transport identity that does not
  // depend on clocks or inferred turn position. Once both paths expose keyed
  // assistant rows, a different key is authoritative evidence that they are
  // different rows. Require one matching server row and compatible content so
  // a provider collision or partially written transcript cannot drop live text.
  if (message.providerRowKey) {
    const hasKeyedServerRow = serverMessages.some((serverMessage) =>
      serverMessage.provider === message.provider
      && serverMessage.kind === 'text'
      && serverMessage.role === 'assistant'
      && Boolean(serverMessage.providerRowKey),
    );
    if (hasKeyedServerRow) {
      return reconcileProviderRowText(message, serverMessages).winner === 'server';
    }
  }

  // 0. Precise turn anchor match when transcriptAnchorId is available
  if (message.transcriptAnchorId) {
    const anchorIndex = serverMessages.findIndex(
      (sm) => sm.kind === 'text' && sm.role === 'user' && sm.transcriptAnchorId === message.transcriptAnchorId,
    );
    if (anchorIndex >= 0) {
      let turnEnd = serverMessages.length;
      for (let j = anchorIndex + 1; j < serverMessages.length; j++) {
        if (serverMessages[j].kind === 'text' && serverMessages[j].role === 'user') {
          turnEnd = j;
          break;
        }
      }
      const turnSegments = serverMessages
        .slice(anchorIndex + 1, turnEnd)
        .filter((sm) => sm.kind === 'text' && sm.role === 'assistant' && (sm.content || '').length > 0);

      if (turnSegments.some((sm) => isAssistantTextMatch(sm.content || '', assistantText))) {
        return true;
      }
      const joinedText = turnSegments.map((sm) => sm.content || '').join('');
      return isAssistantTextMatch(joinedText, assistantText);
    }
  }

  // 1. Which turn this live row belongs to is a causal question. Arrival order
  //    inside `realtimeMessages` answers it without consulting a clock: the
  //    row belongs to the turn opened by the nearest user row above it. With
  //    no user row above it — a tab that did not send the message, a session
  //    resumed mid-run — the row belongs to the newest persisted turn, because
  //    a live row cannot precede a turn that is already on disk.
  const turnUserRow = findTurnUserRowByArrival(message, realtimeMessages);

  if (!turnUserRow) {
    const newestTurn = findNewestServerTurnRange(serverMessages);
    return newestTurn ? turnCarriesText(serverMessages, newestTurn, assistantText) : false;
  }

  const anchoredRange = turnUserRow.transcriptAnchorId
    ? findServerTurnRangeByAnchor(serverMessages, turnUserRow.transcriptAnchorId)
    : null;
  if (anchoredRange) {
    return turnCarriesText(serverMessages, anchoredRange, assistantText);
  }

  // The turn's own user row can be paginated out of `serverMessages` entirely.
  // When no user row is left there at all, every server row on hand belongs to
  // one turn — the newest — and that is the turn this live row is part of.
  // Without this the comparison has nothing to run against and the reply is
  // kept beside the persisted copy of itself: the duplicated answer seen after
  // a long tool-heavy turn pushes the prompt off the tail page.
  const serverHasUserRow = serverMessages.some(
    (candidate) => candidate.kind === 'text' && candidate.role === 'user',
  );
  if (!serverHasUserRow) {
    return turnCarriesText(serverMessages, { start: -1, end: serverMessages.length }, assistantText);
  }

  const precedingUserContent = (turnUserRow.content || '').trim();
  if (precedingUserContent) {
    const contentRange = findLatestServerTurnRangeByUserContent(serverMessages, precedingUserContent);
    if (contentRange) {
      return turnCarriesText(serverMessages, contentRange, assistantText);
    }
  }

  // The turn's user row is not in `serverMessages` — it sits beyond the tail
  // page. The live row still cannot belong to a turn older than the newest one
  // on disk, so that is the turn to compare against. This replaces a fallback
  // that counted turns in a clock-merged view of both sources, which is the
  // last place a wall clock decided anything here.
  const newestTurn = findNewestServerTurnRange(serverMessages);
  return newestTurn ? turnCarriesText(serverMessages, newestTurn, assistantText) : false;
}

