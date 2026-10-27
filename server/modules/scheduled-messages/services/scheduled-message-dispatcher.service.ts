import { createHash } from 'node:crypto';

import { scheduledMessagesDb, sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { broadcastQueuedMessageDispatched, chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { readQueuedChatMessage } from '@/shared/utils.js';
import type { LLMProvider } from '@/shared/types.js';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;

/**
 * How often queued messages are looked for.
 *
 * A queued message goes "when this turn finishes", so this poll is the delay
 * the user sees between the reply ending and their next message starting. It
 * is one query over a table that holds a row per waiting message.
 */
const QUEUED_POLL_INTERVAL_MS = 2_000;

/** How long a queued message whose turn could not start waits before it is tried again. */
const QUEUED_RETRY_DELAY_MS = 60_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let queuedPollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchInFlight = false;
let queuedDispatchInFlight = false;

/** Sessions whose queued turn failed to start, and when they may be tried again. */
const queuedRetryAt = new Map<string, number>();

/** 正在准备排队消息的会话；最终领取前，消息仍在数据库中且允许编辑。 */
const queuedSessionsInFlight = new Set<string>();

/** Sessions currently running a scheduled message turn, so same-session schedules run one by one without blocking other sessions. */
const scheduledSessionsInFlight = new Set<string>();

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Starts one claimed queued message as a turn and resolves as soon as the turn
 * has started (or failed to). The turn itself runs on: a pass that waited for
 * it would hold every other queued message back for as long as it lasts.
 */
async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
  claimOnAcceptance = false,
): Promise<void> {
  let claimed = !claimOnAcceptance;
  const message = readQueuedChatMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let started = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
        resolve();
      }
    };

    void runDetachedChatTurn(
      {
        sessionId: candidate.sessionId,
        userId: candidate.userId,
        content: message.content,
        options: { ...message.options, attachments: message.attachments },
        ...(claimOnAcceptance ? { onBeforeInputAccepted: () => {
          claimed = sessionDraftsDb.claimQueuedMessage(candidate);
          return claimed;
        } } : {}),
        onRunStarted: () => {
          sessionDraftsDb.completeQueuedMessage(candidate);
          started = true;
          queuedRetryAt.delete(candidate.sessionId);
          const fingerprint = createHash('sha256')
            .update(JSON.stringify({ content: message.content, attachments: message.attachments }))
            .digest('hex');
          try {
            broadcastQueuedMessageDispatched(candidate.sessionId, fingerprint);
          } finally { settle(); }
        },
      },
      { runtime },
    )
      .then((result) => {
        if (started) {
          return;
        }
        // Never started, so nothing was sent: put the message back. A run that
        // won the gap between the busy check and the claim is retried on the
        // next pass; anything else (an unavailable provider, a deleted
        // session) waits a while, so a lasting failure does not repeat on
        // every pass.
        if (claimed) sessionDraftsDb.restoreQueuedMessage(candidate);
        if (!result.busy) {
          queuedRetryAt.set(candidate.sessionId, Date.now() + QUEUED_RETRY_DELAY_MS);
          console.error('[QueuedMessages] Queued message could not start; kept for retry', {
            sessionId: candidate.sessionId,
            error: result.error,
          });
        }
      })
      .catch((error: unknown) => {
        // Only failures before registration are safe to restore. Once started,
        // retrying could duplicate provider work even if delivery later fails.
        if (claimed && !started) {
          sessionDraftsDb.restoreQueuedMessage(candidate);
          queuedRetryAt.set(candidate.sessionId, Date.now() + QUEUED_RETRY_DELAY_MS);
        }
        console.error('[QueuedMessages] Queued turn failed', {
          sessionId: candidate.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(settle);
  });
}

/**
 * Whether a queued turn has to keep waiting for the session — the same rule the
 * composer uses to decide whether a message is queued at all.
 *
 * A reply in flight always holds it. A turn that ends with background work
 * still going (a backgrounded command, agent or workflow) is marked completed,
 * but its process stays open so that work can report back; a new turn would
 * replace that process and stop the work. A runtime with input acceptance
 * reporting may try its held process while the queued card stays visible;
 * if it cannot preserve that work, it must defer the input.
 */
function isSessionBusy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  if (chatRunRegistry.isProcessing(sessionId)) {
    return true;
  }
  if (!runtime.hasBackgroundWork(sessionId)) {
    return false;
  }
  const provider = sessionsDb.getSessionById(sessionId)?.provider;
  if (!provider || !runtime.backgroundWorkQueuesInput) {
    return true;
  }
  // 运行时尝试在原进程续轮时，页面继续保留排队卡；
  // 无法安全续轮时，消息继续等待。
  if (runtime.supportsInputAcceptance?.(provider as LLMProvider)) return false;
  return runtime.backgroundWorkQueuesInput(provider as LLMProvider, sessionId);
}

/**
 * 会话空闲或运行时支持安全输入确认时，尝试提交已保存的排队消息。
 *
 * Consumer: `initializeScheduledMessageDispatcher` and `queued-messages.test.ts`.
 */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages();
  let claimed = 0;
  const now = Date.now();

  await Promise.all(candidates.map(async (candidate) => {
    if (queuedSessionsInFlight.has(candidate.sessionId) || (queuedRetryAt.get(candidate.sessionId) ?? 0) > now) {
      return;
    }
    if (isSessionBusy(candidate.sessionId, runtime)) {
      return;
    }
    const provider = sessionsDb.getSessionById(candidate.sessionId)?.provider;
    const claimOnAcceptance = Boolean(provider && runtime.supportsInputAcceptance?.(provider as LLMProvider));
    if (!claimOnAcceptance && !sessionDraftsDb.claimQueuedMessage(candidate)) return;
    queuedSessionsInFlight.add(candidate.sessionId);
    claimed += 1;
    try {
      await sendClaimedQueuedMessage(candidate, runtime, claimOnAcceptance);
    } finally {
      queuedSessionsInFlight.delete(candidate.sessionId);
    }
  }));

  return claimed;
}

/**
 * Starts one claimed scheduled message as a turn.
 *
 * - `dispatched` resolves as soon as the turn has entered `runtime.run` (or
 *   settled early without starting), so a long turn on one session never holds
 *   the poll pass open.
 * - `completed` resolves only after the provider turn has settled and any
 *   failure has been recorded on the row, so a second due message for the
 *   same session waits its turn.
 */
function startClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): { dispatched: Promise<void>; completed: Promise<void>; isCompleted: () => boolean; wasDeferred: () => boolean } {
  let done = false;
  let deferred = false;
  let settleDispatched!: () => void;
  let immediateHandle: ReturnType<typeof setImmediate> | null = null;

  const dispatched = new Promise<void>((resolve) => {
    let settled = false;
    settleDispatched = () => {
      if (!settled) {
        settled = true;
        if (immediateHandle) {
          clearImmediate(immediateHandle);
          immediateHandle = null;
        }
        resolve();
      }
    };
  });

  const completed = runDetachedChatTurn(
    {
      sessionId: row.session_id,
      userId: row.user_id,
      content: row.content,
      options: readOptions(row.options),
      // The user picked this time on purpose; a run that happens to be going
      // is aborted so the scheduled message lands when it was due, instead
      // of being recorded as "not sent — session was busy".
      interruptActiveRun: true,
      onRunStarted: () => {
        // Yield one immediate tick so `dispatchRun` steps past `beforeRun` and
        // enters `runtime.run` before the pass considers the turn dispatched.
        immediateHandle = setImmediate(settleDispatched);
      },
    },
    { runtime },
  )
    .then((result) => {
      // The engine deferred the turn to preserve live background work rather
      // than kill it. Nothing was sent, so the message goes back to `pending`
      // and the next pass retries — the same treatment queued messages get.
      // Recording it as failed here would silently drop a message the user
      // scheduled just because a background command happened to be running.
      if (result.busy && !result.started) {
        deferred = true;
        scheduledMessagesDb.releaseClaimed(row.id);
        return;
      }
      // Recorded rather than retried, and recorded whether the run never started
      // (deleted session, unavailable provider) or started and then failed.
      // Silently dropping a message the user scheduled is worse than telling
      // them it did not go.
      if (!result.started || result.error) {
        scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      scheduledMessagesDb.markFailed(row.id, message);
    })
    .finally(() => {
      done = true;
      settleDispatched();
    });

  return {
    dispatched,
    completed,
    isCompleted: () => done,
    wasDeferred: () => deferred,
  };
}

/**
 * Sends every message whose time has come, dispatching distinct sessions in
 * parallel while keeping same-session due messages sequential.
 *
 * Consumer: `initializeScheduledMessageDispatcher` and `scheduled-messages.test.ts`.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now?: Date,
): Promise<number> {
  const effectiveNow = () => now ?? new Date();
  const due = scheduledMessagesDb.claimDue(effectiveNow(), scheduledSessionsInFlight);
  if (due.length === 0) {
    return 0;
  }

  let dispatchedCount = due.length;

  await Promise.all(due.map(async (firstRow) => {
    const sessionId = firstRow.session_id;
    scheduledSessionsInFlight.add(sessionId);
    let handedOffToBackground = false;

    try {
      let currentRow: ScheduledMessageRow | null = firstRow;
      while (currentRow) {
        const turn = startClaimedMessage(currentRow, runtime);
        await turn.dispatched;

        if (!turn.isCompleted()) {
          handedOffToBackground = true;
          void (async () => {
            try {
              await turn.completed;
              // A deferred turn goes back to `pending`; claiming again right
              // here would loop on it until the background work ends. Leave
              // the rest to the next pass.
              if (!turn.wasDeferred()) {
                let nextRow = scheduledMessagesDb.claimNextDueForSession(sessionId, effectiveNow());
                while (nextRow) {
                  const nextTurn = startClaimedMessage(nextRow, runtime);
                  await nextTurn.completed;
                  if (nextTurn.wasDeferred()) {
                    break;
                  }
                  nextRow = scheduledMessagesDb.claimNextDueForSession(sessionId, effectiveNow());
                }
              }
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              console.error('[ScheduledMessages] Background session drain failed', { sessionId, error: message });
            } finally {
              scheduledSessionsInFlight.delete(sessionId);
            }
          })();
          return;
        }

        await turn.completed;
        // Same as above: a released message is still due, so claiming again
        // in this pass would spin on it.
        if (turn.wasDeferred()) {
          return;
        }
        currentRow = scheduledMessagesDb.claimNextDueForSession(sessionId, effectiveNow());
        if (currentRow) {
          dispatchedCount += 1;
        }
      }
    } finally {
      if (!handedOffToBackground) {
        scheduledSessionsInFlight.delete(sessionId);
      }
    }
  }));

  return dispatchedCount;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 *
 * Consumer: server startup (`server/index.ts`) via `@/modules/scheduled-messages/index.js`.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  const poll = () => {
    // A pass that overruns the interval must not be started again underneath
    // itself; the claim is transactional but the runs are not.
    if (dispatchInFlight) {
      return;
    }
    dispatchInFlight = true;
    void dispatchDueScheduledMessages(runtime)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  };

  // Queued messages poll on their own, faster timer: a scheduled message's
  // pass lasts as long as its run, which must not hold a queued one back.
  const pollQueued = () => {
    if (queuedDispatchInFlight) {
      return;
    }
    queuedDispatchInFlight = true;
    void dispatchQueuedMessages(runtime)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[QueuedMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        queuedDispatchInFlight = false;
      });
  };

  // Never keep the process alive just to poll.
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  queuedPollTimer = setInterval(pollQueued, QUEUED_POLL_INTERVAL_MS);
  queuedPollTimer.unref?.();

  // Catch up on anything that came due, or was queued, while the server was not running.
  poll();
  pollQueued();
}

/**
 * Stops the scheduled and queued message poll timers.
 *
 * Consumer: server shutdown (`server/index.ts`) via `@/modules/scheduled-messages/index.js`.
 */
export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (queuedPollTimer) {
    clearInterval(queuedPollTimer);
    queuedPollTimer = null;
  }
  scheduledSessionsInFlight.clear();
}
