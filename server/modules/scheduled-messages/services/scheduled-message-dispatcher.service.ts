import { scheduledMessagesDb, sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { broadcastQueuedMessageDispatched, chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
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

type StoredQueuedMessage = {
  content: string;
  options: Record<string, unknown>;
  attachments: unknown[];
};

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

function readQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images)
      ? record.images
      : [];
  if (!content.trim() && attachments.length === 0) {
    return null;
  }
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  return { content, options, attachments };
}

/**
 * Starts one claimed queued message as a turn and resolves as soon as the turn
 * has started (or failed to). The turn itself runs on: a pass that waited for
 * it would hold every other queued message back for as long as it lasts.
 */
async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  const message = readQueuedMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
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
        onRunStarted: () => {
          queuedRetryAt.delete(candidate.sessionId);
          broadcastQueuedMessageDispatched(candidate.sessionId);
          settle();
        },
      },
      { runtime },
    )
      .then((result) => {
        if (result.started) {
          return;
        }
        // Never started, so nothing was sent: put the message back. A run that
        // won the gap between the busy check and the claim is retried on the
        // next pass; anything else (an unavailable provider, a deleted
        // session) waits a while, so a lasting failure does not repeat on
        // every pass.
        sessionDraftsDb.restoreQueuedMessage(candidate);
        if (!result.busy) {
          queuedRetryAt.set(candidate.sessionId, Date.now() + QUEUED_RETRY_DELAY_MS);
          console.error('[QueuedMessages] Queued message could not start; kept for retry', {
            sessionId: candidate.sessionId,
            error: result.error,
          });
        }
      })
      .catch((error: unknown) => {
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
 * replace that process and stop the work, so the message waits for it too —
 * unless the provider takes the next turn alongside that work (Claude's held
 * process), in which case sending at once disturbs nothing.
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
  return runtime.backgroundWorkQueuesInput(provider as LLMProvider, sessionId);
}

/** Sends every persisted queued turn whose session is currently idle. */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages();
  let claimed = 0;
  const now = Date.now();

  await Promise.all(candidates.map(async (candidate) => {
    if ((queuedRetryAt.get(candidate.sessionId) ?? 0) > now) {
      return;
    }
    if (isSessionBusy(candidate.sessionId, runtime)) {
      return;
    }
    if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
      return;
    }
    claimed += 1;
    await sendClaimedQueuedMessage(candidate, runtime);
  }));

  return claimed;
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        interruptActiveRun: true,
      },
      { runtime },
    );

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider) or started and then failed.
    // Silently dropping a message the user scheduled is worse than telling
    // them it did not go.
    if (!result.started || result.error) {
      scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduledMessagesDb.markFailed(row.id, message);
  }
}

/**
 * Sends every message whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now);
  if (due.length === 0) {
    return 0;
  }

  // Sequentially: a session can only have one run at a time, and two due
  // messages for the same session must not race each other into it.
  for (const row of due) {
    await sendClaimedMessage(row, runtime);
  }

  return due.length;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
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

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (queuedPollTimer) {
    clearInterval(queuedPollTimer);
    queuedPollTimer = null;
  }
}
