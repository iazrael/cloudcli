/**
 * Antigravity ACP Pending Card Bridge
 *
 * The registry that turns agy's two user-interrupts — a
 * `session/request_permission` frame and a parked `ask_question` — into the
 * same pending-card flow the other providers use: a `permission_request`
 * writer frame shows the card, `permissions.listPending` replays it after a
 * reload, and the chat gateway's `resolveToolApproval` fans decisions into
 * {@link AntigravityAcpCardBridge.resolve}. Frames are probe-verified against
 * agy 1.5.14, which waits indefinitely for a permission answer (no timeout,
 * no re-announcement), so the TTL below is a zombie guard, not a deadline.
 *
 * The card shape mirrors zcode's `PendingPermissionView` (that type is
 * zcode-local, and cross-provider imports only go through barrels that do not
 * expose it), because the chat gateway renders both through the same panel
 * registry keyed by `toolName`.
 *
 * @module antigravity-acp-bridge
 */

import type { ProviderPermissionDecision, ProviderRuntimeWriter } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId } from '@/shared/utils.js';

/** How long a pending card stays answerable without any engine activity. */
export const PENDING_CARD_TTL_MS = 30 * 60 * 1000;

/** What settling a card means, decided by whoever woke it. */
export type AcpCardOutcome = ProviderPermissionDecision & {
  /** Marks an abort-driven denial so the parked run settles as aborted. */
  aborted?: boolean;
  /** Marks a TTL expiry so the parked run settles without an answer. */
  expired?: boolean;
};

export type AcpPendingCard = {
  requestId: string;
  /** `permission` answers the engine's parked JSON-RPC request; `question` parks a run. */
  kind: 'permission' | 'question';
  /** The app session key the gateway addresses cards by. */
  sessionId: string;
  /** The engine-side conversation id the run's writer frames carry. */
  frameSessionId: string | null;
  toolName: string;
  toolId: string;
  input: unknown;
  context?: unknown;
  receivedAt: Date;
  /** The run's writer, so retraction frames reach the session's channel. */
  writer: ProviderRuntimeWriter;
  settle: (outcome: AcpCardOutcome) => void;
};

export class AntigravityAcpCardBridge {
  private readonly cards = new Map<string, AcpPendingCard>();

  add(card: AcpPendingCard): void {
    this.cards.set(card.requestId, card);
  }

  get(requestId: string): AcpPendingCard | null {
    this.sweepExpired();
    return this.cards.get(requestId) ?? null;
  }

  /**
   * Fans one gateway decision into a card: settle wakes whoever parked on it,
   * and the card leaves the replay list. Returns false for a stale response
   * (answered elsewhere, or the run died holding it).
   */
  resolve(requestId: string, decision: ProviderPermissionDecision): boolean {
    this.sweepExpired();
    const card = this.cards.get(requestId);
    if (!card) return false;
    this.cards.delete(requestId);
    retractCard(card);
    card.settle(decision);
    return true;
  }

  /** The pending cards for one app session, in the gateway's replay shape. */
  listForSession(sessionId: string): Array<{
    requestId: string;
    toolName: string;
    toolId: string;
    input: unknown;
    context: unknown;
    sessionId: string;
    receivedAt: Date;
  }> {
    this.sweepExpired();
    const pending: Array<{
      requestId: string;
      toolName: string;
      toolId: string;
      input: unknown;
      context: unknown;
      sessionId: string;
      receivedAt: Date;
    }> = [];
    for (const card of this.cards.values()) {
      if (card.sessionId !== sessionId) continue;
      pending.push({
        requestId: card.requestId,
        toolName: card.toolName,
        toolId: card.toolId,
        input: card.input,
        context: card.context,
        sessionId: card.sessionId,
        receivedAt: card.receivedAt,
      });
    }
    return pending;
  }

  /** Whether the session still holds any answerable card. */
  hasForSession(sessionId: string): boolean {
    this.sweepExpired();
    for (const card of this.cards.values()) {
      if (card.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Settles every card of a session from outside the gateway (an abort, a
   * dead run): each card retracts and its parked waiter wakes with an
   * `aborted` denial. Returns the request ids that were alive.
   */
  retractAllForSession(sessionId: string, outcome: AcpCardOutcome): string[] {
    this.sweepExpired();
    const settled: string[] = [];
    for (const card of [...this.cards.values()]) {
      if (card.sessionId !== sessionId) continue;
      this.cards.delete(card.requestId);
      retractCard(card);
      card.settle(outcome);
      settled.push(card.requestId);
    }
    return settled;
  }

  /** Drops cards nobody could answer anymore, retracting each one. */
  sweepExpired(): void {
    const now = Date.now();
    for (const card of [...this.cards.values()]) {
      if (now - card.receivedAt.getTime() <= PENDING_CARD_TTL_MS) continue;
      this.cards.delete(card.requestId);
      retractCard(card);
      card.settle({ allow: false, expired: true });
    }
  }

  /** Live card count, for tests. */
  get size(): number {
    return this.cards.size;
  }
}

/** Retraction through the showing run's writer, so live cards come down. */
function retractCard(card: AcpPendingCard): void {
  card.writer.send(createNormalizedMessage({
    id: generateMessageId('antigravity'),
    kind: 'permission_cancelled',
    requestId: card.requestId,
    sessionId: card.frameSessionId ?? card.sessionId,
    provider: 'antigravity',
  }));
}

export const antigravityAcpCards = new AntigravityAcpCardBridge();

/**
 * Formats the structured answers the AskUserQuestion panel submits
 * (`updatedInput.answers`, keyed by question text) into the free text the
 * answer turn carries, mirroring the acknowledgement prose other engines
 * write into their tool results.
 */
export function formatQuestionAnswers(answers: unknown): string {
  const record = answers && typeof answers === 'object' && !Array.isArray(answers)
    ? answers as Record<string, unknown>
    : null;
  const entries = record ? Object.entries(record) : [];
  const answered = entries
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([question, value]) => `Q: ${question}\nA: ${String(value).trim()}`);
  if (answered.length === 0) {
    return 'The user did not provide answers to these questions. Continue using your best judgment.';
  }
  return `User has answered your questions:\n${answered.join('\n')}`;
}
