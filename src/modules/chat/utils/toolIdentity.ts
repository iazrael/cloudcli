import type { NormalizedMessage } from '@/shared/types';

/**
 * Identity matching for tool_use rows across the realtime and persisted paths.
 *
 * The two paths derive a call's `toolId` independently — engine live payloads
 * versus transcript parses, each with their own fallbacks — so the same
 * logical call can legitimately carry different ids: zcode's live fallback is
 * an event id while history falls back to the transcript part id, codex lives
 * in the SDK's item-id namespace while history uses rollout call_ids, and
 * antigravity synthesizes two different formulas. Matching by exact toolId
 * alone let both cards render (the "Write x2" shadow card).
 *
 * A live card is the echo of a persisted row when the exact toolId matches,
 * or when the full call fingerprint matches (provider + tool + complete
 * input) and the persisted row has not already been claimed by another live
 * card. Claims are one-to-one and consumed in realtime array order, so
 * repeated identical calls ("npm test" twice) pair nth-to-nth instead of
 * collapsing into one card. No time window is applied on fingerprint claims:
 * a lingering live card must still retire no matter how late the next refresh
 * arrives, and a false pair requires an identical provider+tool+full-input
 * call whose visual outcome is one card per real call either way.
 *
 * Consumer: `sessionTimelineStore.ts` — the only production caller (prune);
 * `toolIdentity.test.ts` pins the matching contract.
 */

type ServerToolCallIndex = {
  byToolId: Map<string, NormalizedMessage>;
  byFingerprint: Map<string, NormalizedMessage[]>;
};

/** Sort-stable shape of a call's input, so key order never changes identity. */
function stableInput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableInput);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source).sort().reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = stableInput(source[key]);
      return sorted;
    }, {});
  }
  return value;
}

/**
 * Full-call fingerprint: tool + complete input (the owning session already
 * implies the provider). Two rows with the same fingerprint are treated as
 * the same logical call — safe because a model repeating a call verbatim
 * pairs 1:1 through the claim set, and unsafe inputs (a path, a URL) are
 * exactly what makes the fingerprint discriminative for the shadow-card
 * engines (Write/Edit/Bash payloads).
 */
function toolCallFingerprint(message: NormalizedMessage): string | null {
  if (message.kind !== 'tool_use' || !message.toolName) {
    return null;
  }
  const input = typeof message.toolInput === 'string'
    ? stableInput(safeParse(message.toolInput) ?? message.toolInput)
    : stableInput(message.toolInput);
  return JSON.stringify([message.toolName, input]);
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Indexes the persisted tool calls a refresh brought into the slot. */
export function collectServerToolCalls(serverMessages: NormalizedMessage[]): ServerToolCallIndex {
  const byToolId = new Map<string, NormalizedMessage>();
  const byFingerprint = new Map<string, NormalizedMessage[]>();
  for (const message of serverMessages) {
    if (message.kind !== 'tool_use') {
      continue;
    }
    if (message.toolId) {
      byToolId.set(message.toolId, message);
    }
    const fingerprint = toolCallFingerprint(message);
    if (fingerprint) {
      const bucket = byFingerprint.get(fingerprint);
      if (bucket) {
        bucket.push(message);
      } else {
        byFingerprint.set(fingerprint, [message]);
      }
    }
  }
  return { byToolId, byFingerprint };
}

/**
 * Returns true and marks the persisted row claimed when `live` is the echo of
 * a server tool call. `claimedServerRowIds` enforces one-to-one pairing and
 * must be scoped to a single prune pass.
 */
export function claimMatchingServerToolCall(
  live: NormalizedMessage,
  index: ServerToolCallIndex,
  claimedServerRowIds: Set<string>,
): boolean {
  if (live.kind !== 'tool_use') {
    return false;
  }

  if (live.toolId) {
    const exact = index.byToolId.get(live.toolId);
    if (exact && !claimedServerRowIds.has(exact.id)) {
      claimedServerRowIds.add(exact.id);
      return true;
    }
  }

  const fingerprint = toolCallFingerprint(live);
  if (!fingerprint) {
    return false;
  }
  const candidates = index.byFingerprint.get(fingerprint);
  if (!candidates) {
    return false;
  }
  const unclaimed = candidates.find((row) => !claimedServerRowIds.has(row.id));
  if (!unclaimed) {
    return false;
  }
  claimedServerRowIds.add(unclaimed.id);
  return true;
}
