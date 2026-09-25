import type { NormalizedMessage } from '@/shared/types';

/**
 * What the transcript looked like when a prompt was sent.
 *
 * The client writes the user's prompt into the timeline immediately, before
 * the engine has persisted anything, so that row exists only here. Retiring
 * it later needs one question answered: which persisted user row is its copy?
 *
 * `afterRowId` is the id of the last persisted row at send time. Every row
 * that appears after it is newer than the prompt, so the first user row past
 * that point is the prompt's persisted copy. An id survives what an index
 * does not — pages prepended above it, the whole array replaced by a refresh —
 * which is exactly where the previous row-count stamp silently stopped
 * matching and left the prompt rendered twice for the rest of the session.
 *
 * `null` means nothing was loaded yet, so any user row qualifies.
 */
export type PendingPrompt = {
  afterRowId: string | null;
};

/** Whether a row is a client-side optimistic prompt awaiting its copy. */
export function isOptimisticPromptRow(message: NormalizedMessage): boolean {
  return message.id.startsWith('local_') && message.kind === 'text' && message.role === 'user';
}

function isPersistedUserRow(message: NormalizedMessage): boolean {
  return message.kind === 'text' && message.role === 'user';
}

/**
 * The outcome of pairing optimistic prompts against the transcript.
 *
 * `retiredAnchors` is every pairing: it decides which prompt stops being
 * rendered, where a permissive answer is the right one — an unpaired prompt
 * shows next to its own persisted copy, the duplicate this all exists to
 * stop.
 *
 * `provenAnchors` is the subset whose prompt had a real anchor, so the
 * pairing is a fact rather than the best available reading. Only those may be
 * used to prove which persisted turn a live row belongs to: a prompt sent
 * before any history was loaded can be paired with the newest turn for
 * display and still be the wrong turn to fingerprint a tool call against.
 */
export type OptimisticPromptReconciliation = {
  retiredAnchors: Map<string, string>;
  provenAnchors: Map<string, string>;
};

/**
 * Pairs each optimistic prompt with the persisted user row that replaced it.
 *
 * Pairing is positional and one-to-one: the nth prompt still waiting takes
 * the nth qualifying user row. Nothing here reads message text, timestamps or
 * array lengths — sending the same words twice pairs each send with its own
 * turn because the second send's anchor sits after the first send's copy.
 *
 * `runEnded` is the escape hatch for the one case an anchor cannot answer: a
 * transcript rewritten under the prompt (a fork, a truncation) can drop the
 * anchor row out of the window entirely. Rather than keep an unmatched prompt
 * on screen forever — the failure this whole mechanism exists to prevent —
 * a finished run lets the prompt pair with any user row it has not claimed.
 */
export function reconcileOptimisticPrompts(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  pendingPrompts: ReadonlyMap<string, PendingPrompt>,
  runEnded: boolean,
): OptimisticPromptReconciliation {
  const retiredAnchors = new Map<string, string>();
  const provenAnchors = new Map<string, string>();
  if (serverMessages.length === 0) {
    return { retiredAnchors, provenAnchors };
  }

  const claimedServerIds = new Set<string>();

  for (const message of realtimeMessages) {
    if (!isOptimisticPromptRow(message)) {
      continue;
    }

    const anchorRowId = pendingPrompts.get(message.id)?.afterRowId ?? null;
    let firstEligibleIndex = 0;
    // A prompt sent with nothing loaded has no anchor to be right about. Its
    // pairing is the best available reading until the run ends — by then the
    // transcript certainly holds this turn, so the newest unclaimed user row
    // is it.
    let anchored = runEnded;
    if (anchorRowId !== null) {
      const anchorIndex = serverMessages.findIndex((candidate) => candidate.id === anchorRowId);
      if (anchorIndex < 0 && !runEnded) {
        continue;
      }
      anchored = anchorIndex >= 0;
      firstEligibleIndex = anchorIndex + 1;
    }

    for (let index = firstEligibleIndex; index < serverMessages.length; index++) {
      const candidate = serverMessages[index];
      if (claimedServerIds.has(candidate.id) || !isPersistedUserRow(candidate)) {
        continue;
      }
      claimedServerIds.add(candidate.id);
      retiredAnchors.set(message.id, candidate.id);
      if (anchored) {
        provenAnchors.set(message.id, candidate.id);
      }
      break;
    }
  }

  return { retiredAnchors, provenAnchors };
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
    // Completion is another snapshot of the same call: opencode re-announces
    // the toolId with the outcome attached. Dropping these fields left every
    // finished card spinning until the turn's finalize pass.
    toolResult: frame.toolResult ?? next[index].toolResult,
    status: frame.status ?? next[index].status,
  };
  return next;
}
