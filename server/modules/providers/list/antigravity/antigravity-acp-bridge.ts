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
 * no re-announcement). The bridge denies and retracts unanswered cards at expiry.
 *
 * The card shape mirrors zcode's `PendingPermissionView` (that type is
 * zcode-local, and cross-provider imports only go through barrels that do not
 * expose it), because the chat gateway renders both through the same panel
 * registry keyed by `toolName`.
 *
 * @module antigravity-acp-bridge
 */

import type { AcpCardOutcome, NormalizedMessage, ProviderPermissionDecision } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId } from '@/shared/utils.js';

const PENDING_CARD_TTL_MS = 30 * 60 * 1000;

type AcpPendingCard = {
  requestId: string;
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
  writer: { send: (message: NormalizedMessage) => void };
  settle: (outcome: AcpCardOutcome) => void;
};

type TimedCard = AcpPendingCard & { timer: NodeJS.Timeout };

/** Owns pending-card deadlines and settlement for the runtime and its gateway tests. */
export class AntigravityAcpCardBridge {
  private readonly cards = new Map<string, TimedCard>();

  constructor(private readonly ttlMs = PENDING_CARD_TTL_MS) {}

  add(card: AcpPendingCard): void {
    if (this.cards.has(card.requestId)) throw new Error('Duplicate ACP card request ID');
    const delay = Math.max(0, card.receivedAt.getTime() + this.ttlMs - Date.now());
    const timer = setTimeout(() => this.finish(card.requestId, { allow: false, expired: true }), delay);
    timer.unref();
    this.cards.set(card.requestId, { ...card, timer });
  }

  /** Resolves a live card once. A response at or after the deadline expires it. */
  resolve(requestId: string, decision: ProviderPermissionDecision): boolean {
    const card = this.cards.get(requestId);
    if (!card) return false;
    if (Date.now() >= card.receivedAt.getTime() + this.ttlMs) {
      this.finish(requestId, { allow: false, expired: true });
      return false;
    }
    return this.finish(requestId, decision);
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
    for (const card of this.cards.values()) {
      if (card.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Settles every card of a session from outside the gateway (an abort, a
   * dead run). Returns the ids of the cards whose waiters were settled.
   */
  retractAllForSession(sessionId: string, outcome: AcpCardOutcome): string[] {
    const settled: string[] = [];
    for (const card of [...this.cards.values()]) {
      if (card.sessionId !== sessionId) continue;
      this.finish(card.requestId, outcome);
      settled.push(card.requestId);
    }
    return settled;
  }

  private finish(requestId: string, outcome: AcpCardOutcome): boolean {
    const card = this.cards.get(requestId);
    if (!card) return false;
    this.cards.delete(requestId);
    clearTimeout(card.timer);
    try {
      retractCard(card);
    } finally {
      card.settle(outcome);
    }
    return true;
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

/** Shared by Antigravity runtime turns and the gateway's approval handlers. */
export const antigravityAcpCards = new AntigravityAcpCardBridge();

/**
 * Formats the structured answers the AskUserQuestion panel submits
 * (`updatedInput.answers`, keyed by question text) into the free text the
 * answer turn carries, mirroring the acknowledgement prose other engines
 * write into their tool results. Used by the Antigravity ACP runtime.
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
