import type { NormalizedMessage } from '@/shared/types';


type UserTurnFingerprint = {
  text: string;
  imageCount: number;
  fileCount: number;
};

function userTurnFingerprint(message: NormalizedMessage): UserTurnFingerprint | null {
  if (message.kind !== 'text' || message.role !== 'user') return null;

  const text = (message.content || '').trim();
  const imageCount = Array.isArray(message.images) ? message.images.length : 0;
  const fileCount = Array.isArray(message.files) ? message.files.length : 0;
  if (!text && imageCount === 0 && fileCount === 0) return null;

  return { text, imageCount, fileCount };
}

function userTurnFingerprintsMatch(
  local: UserTurnFingerprint,
  server: UserTurnFingerprint,
): boolean {
  return (
    local.text === server.text
    && local.imageCount === server.imageCount
    && local.fileCount === server.fileCount
  );
}

function findServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  claimedServerIds: Set<string>,
): NormalizedMessage | null {
  const localFingerprint = userTurnFingerprint(localMessage);
  if (!localFingerprint) {
    return null;
  }

  // Only a row that appeared after this prompt was sent can be its persisted
  // copy. `replacesAfterRowCount` records how much transcript was on screen at
  // that moment, which settles it without comparing two machines' clocks — the
  // engine stamps its copy, the browser stamps this one, and a difference
  // between them is not evidence of anything.
  const firstEligibleIndex = localMessage.replacesAfterRowCount ?? 0;

  for (let index = firstEligibleIndex; index < serverMessages.length; index++) {
    const serverMessage = serverMessages[index];
    if (claimedServerIds.has(serverMessage.id)) {
      continue;
    }

    const serverFingerprint = userTurnFingerprint(serverMessage);
    if (!serverFingerprint || !userTurnFingerprintsMatch(localFingerprint, serverFingerprint)) {
      continue;
    }

    // The earliest eligible match wins: repeated sends of the same prompt pair
    // in order, so the nth echo retires against the nth persisted turn.
    return serverMessage;
  }

  return null;
}

/**
 * The result of retiring optimistic user rows against the persisted transcript.
 *
 * `retiredAnchors` is the pairing the filter had to compute anyway: which
 * persisted turn took over from which optimistic row. It is what lets the
 * merge keep a live reply below the user turn that caused it after the
 * optimistic row is gone, so it is returned rather than discarded.
 */
export type OptimisticUserEchoReconciliation = {
  messages: NormalizedMessage[];
  retiredAnchors: Map<string, string>;
};

/**
 * Retires local optimistic user rows once a corresponding persisted turn is
 * available, reporting which persisted row claimed each one. Matches are
 * one-to-one so repeated sends cannot claim one row.
 */
export function reconcileOptimisticUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): OptimisticUserEchoReconciliation {
  const claimedServerIds = new Set<string>();
  const retiredAnchors = new Map<string, string>();

  const messages = realtimeMessages.filter((message) => {
    if (!message.id.startsWith('local_')) {
      return true;
    }

    const serverEcho = findServerEchoForLocalUser(message, serverMessages, claimedServerIds);
    if (!serverEcho) {
      return true;
    }

    claimedServerIds.add(serverEcho.id);
    retiredAnchors.set(message.id, serverEcho.id);
    return false;
  });

  return { messages, retiredAnchors };
}

/**
 * Merges a realtime tool_use frame into the session's realtime rows.
 *
 * Frames sharing one toolId are successive snapshots of the same call (zcode
 * streams tool arguments into the already-announced card), so the existing row
 * is updated in place and keeps its first-frame identity for stable React
 * keys; a frame with an unseen toolId is appended. Providers whose tool ids
 * are unique per call only ever hit the append path, so this is safe for every
 * provider.
 */
/**
 * Whether a frame's toolInput carries usable arguments. An empty object is
 * treated as "not provided": engines re-announce already-streamed calls with
 * blank arguments (zcode's post-stream `scheduled` frame), and letting that
 * overwrite a populated card is exactly the blank-card bug.
 */
function hasUsableToolInput(frame: NormalizedMessage): boolean {
  const input = frame.toolInput;
  return !!input && typeof input === 'object' && Object.keys(input).length > 0;
}

export function upsertToolUseRow(rows: NormalizedMessage[], frame: NormalizedMessage): NormalizedMessage[] {
  if (!frame.toolId) {
    return [...rows, frame];
  }

  const index = rows.findIndex((row) => row.kind === 'tool_use' && row.toolId === frame.toolId);
  if (index < 0) {
    return [...rows, frame];
  }

  const next = [...rows];
  next[index] = {
    ...next[index],
    toolName: frame.toolName || next[index].toolName,
    toolInput: hasUsableToolInput(frame) ? frame.toolInput : next[index].toolInput,
    content: frame.content || next[index].content,
  };
  return next;
}
