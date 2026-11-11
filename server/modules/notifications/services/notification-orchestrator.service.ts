import webPush from 'web-push';
import { webhookNotificationsService } from '@/modules/notifications/services/webhook-notifications.service.js';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '@/modules/database/index.js';
import { sendDesktopNotification as sendDesktopNotificationToClients } from '@/modules/notifications/services/desktop-notification-clients.service.js';

//----------------- NOTIFICATION ORCHESTRATOR TYPES ------------

/** The snapshot `notificationPreferencesDb.getPreferences` resolves for a user. */
type NotificationPreferencesSnapshot = ReturnType<typeof notificationPreferencesDb.getPreferences>;

/** The push payload a channel delivers to the user's devices. */
type NotificationPayload = {
  title: string;
  body: string;
  data: {
    sessionId: string | null;
    code: string;
    provider: string | null;
    sessionName: string | null;
    tag: string;
  };
};

/** One normalized notification event as providers and the gateway create it. */
export type NotificationEvent = {
  provider: string;
  sessionId: string | null;
  kind: 'info' | 'stop' | 'error' | 'action_required';
  code: string;
  meta: Record<string, unknown>;
  severity: 'info' | 'warning' | 'error';
  requiresUserAction: boolean;
  dedupeKey: string | null;
  createdAt: string;
};

/** One delivery channel (web push, desktop relay, outbound webhook) with its preference gate. */
type NotificationChannel = {
  id: string;
  isEnabled: (preferences: NotificationPreferencesSnapshot) => boolean;
  /** Webhook 等自带开关的通道：去重窗口不适用于它们（接收方按事件 id 去重）。 */
  bypassesDedupe?: boolean;
  send: (input: { userId: string | number; event: NotificationEvent; payload: NotificationPayload }) => unknown;
};

/**
 * The event shape the payload builder accepts: a full event, or the partial
 * records tests and internal callers construct.
 */
type NotificationEventInput = Omit<NotificationEvent, 'severity' | 'requiresUserAction' | 'dedupeKey' | 'createdAt'>
  & Partial<Pick<NotificationEvent, 'severity' | 'requiresUserAction' | 'dedupeKey' | 'createdAt'>>;

/** Who a notification is for. Callers pass the runtime writer's user id, so numbers happen. */
type NotificationTarget = {
  userId?: string | number | null;
  provider: string;
  sessionId?: string | null;
  sessionName?: string | null;
};

//----------------- DEDUPE AND PREFERENCE MAPS ------------

const KIND_TO_PREF_KEY: Partial<Record<string, keyof NotificationPreferencesSnapshot['events']>> = {
  action_required: 'actionRequired',
  stop: 'stop',
  error: 'error'
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  system: 'System'
};

const recentEventKeys = new Map<string, number>();
const DEDUPE_WINDOW_MS = 20000;

const cleanupOldEventKeys = () => {
  const now = Date.now();
  for (const [key, timestamp] of recentEventKeys.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
};

function isNotificationEventEnabled(
  preferences: NotificationPreferencesSnapshot | null | undefined,
  event: NotificationEventInput,
): boolean {
  const prefEventKey = KIND_TO_PREF_KEY[event.kind];
  const eventEnabled = prefEventKey ? Boolean(preferences?.events?.[prefEventKey]) : true;

  return eventEnabled;
}

function isDuplicate(event: NotificationEventInput): boolean {
  cleanupOldEventKeys();
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  if (recentEventKeys.has(key)) {
    return true;
  }
  recentEventKeys.set(key, Date.now());
  return false;
}

//----------------- EVENT AND PAYLOAD BUILDING ------------

/** Used by provider runtimes and Settings to create normalized notification events. */
export function createNotificationEvent({
  provider,
  sessionId = null,
  kind = 'info',
  code = 'generic.info',
  meta = {},
  severity = 'info',
  dedupeKey = null,
  requiresUserAction = false
}: {
  provider: string;
  sessionId?: string | null;
  kind?: NotificationEvent['kind'];
  code?: string;
  meta?: Record<string, unknown>;
  severity?: NotificationEvent['severity'];
  dedupeKey?: string | null;
  requiresUserAction?: boolean;
}): NotificationEvent {
  return {
    provider,
    sessionId,
    kind,
    code,
    meta,
    severity,
    requiresUserAction,
    dedupeKey,
    createdAt: new Date().toISOString()
  };
}

function normalizeErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  if (error == null) {
    return 'Unknown error';
  }

  return String(error);
}

function normalizeSessionName(sessionName: unknown): string | null {
  if (typeof sessionName !== 'string') {
    return null;
  }

  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

//----------------- SESSION RESOLUTION ------------

function rowMatchesProvider(
  row: NonNullable<ReturnType<typeof sessionsDb.getSessionById>> | null,
  provider: string,
): row is NonNullable<ReturnType<typeof sessionsDb.getSessionById>> {
  return row !== null && (!provider || row.provider === provider);
}

function resolveSessionRow(
  sessionId: string,
  provider: string,
): NonNullable<ReturnType<typeof sessionsDb.getSessionById>> | null {
  if (!sessionId) {
    return null;
  }

  const appSessionRow = sessionsDb.getSessionById(sessionId);
  if (rowMatchesProvider(appSessionRow, provider)) {
    return appSessionRow;
  }

  const providerSessionRow = sessionsDb.getSessionByProviderSessionId(sessionId);
  if (rowMatchesProvider(providerSessionRow, provider)) {
    return providerSessionRow;
  }

  return null;
}

function normalizeNotificationSession<T extends NotificationEventInput>(event: T): T {
  if (!event?.sessionId || !event.provider || event.provider === 'system') {
    return event;
  }

  const row = resolveSessionRow(event.sessionId, event.provider);
  if (!row || row.session_id === event.sessionId) {
    return event;
  }

  return {
    ...event,
    sessionId: row.session_id
  };
}

function resolveSessionName(event: NotificationEventInput): string | null {
  const explicitSessionName = normalizeSessionName(event.meta?.sessionName);
  if (explicitSessionName) {
    return explicitSessionName;
  }

  if (!event.sessionId || !event.provider) {
    return null;
  }

  return normalizeSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

/** Used by notification tests and delivery workflows to create channel payloads. */
export function buildNotificationPayload(event: NotificationEventInput): NotificationPayload {
  const normalizedEvent = normalizeNotificationSession(event);
  const CODE_MAP: Record<string, string> = {
    'permission.required': normalizedEvent.meta?.toolName
      ? `Action Required: Tool "${String(normalizedEvent.meta.toolName)}" needs approval`
      : 'Action Required: A tool needs your approval',
    'run.stopped': (normalizedEvent.meta?.stopReason || 'Run Stopped: The run has stopped') as string,
    'run.background_completed': 'Background work finished',
    'run.failed': normalizedEvent.meta?.error
      ? `Run Failed: ${String(normalizedEvent.meta.error)}`
      : 'Run Failed: The run encountered an error',
    'agent.notification': normalizedEvent.meta?.message
      ? String(normalizedEvent.meta.message)
      : 'You have a new notification',
    'push.enabled': 'Push notifications are now enabled!'
  };
  const providerLabel = PROVIDER_LABELS[normalizedEvent.provider] || 'Assistant';
  const sessionName = resolveSessionName(normalizedEvent);
  const message = CODE_MAP[normalizedEvent.code] || 'You have a new notification';

  return {
    title: sessionName || 'CloudCLI',
    body: `${providerLabel}: ${message}`,
    data: {
      sessionId: normalizedEvent.sessionId || null,
      code: normalizedEvent.code,
      provider: normalizedEvent.provider || null,
      sessionName,
      tag: `${normalizedEvent.provider || 'assistant'}:${normalizedEvent.sessionId || 'none'}:${normalizedEvent.code}`
    }
  };
}

//----------------- DELIVERY ------------

function sendWebPushPayload(userId: string | number, payload: NotificationPayload): Promise<unknown> {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(userId);
  if (!subscriptions.length) return Promise.resolve();

  const serializedPayload = JSON.stringify(payload);
  return Promise.allSettled(
    subscriptions.map((sub) =>
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth
          }
        },
        serializedPayload
      )
    )
  ).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const statusCode = (result.reason as { statusCode?: unknown } | undefined)?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          pushSubscriptionsDb.removeSubscription(subscriptions[index].endpoint);
        }
      }
    });
  });
}

const notificationChannels: NotificationChannel[] = [
  {
    id: 'webPush',
    // TODO: Web push still uses push_subscriptions. Do not remove that table until
    // browser push subscriptions are migrated into notification_channel_endpoints.
    isEnabled: (preferences) => Boolean(preferences?.channels?.webPush),
    send: ({ userId, payload }) => sendWebPushPayload(userId, payload)
  },
  {
    id: 'desktop',
    isEnabled: (preferences) => Boolean(preferences?.channels?.desktop),
    send: ({ userId, payload }) => sendDesktopNotificationToClients(userId, payload)
  },
  {
    id: 'webhook',
    // Gated by the webhook endpoint row's own `enabled` flag instead of
    // preferences.channels, which the Settings client rewrites with only its
    // known keys. The channel sends run lifecycle events only.
    isEnabled: () => true,
    bypassesDedupe: true,
    send: ({ userId, event }) => {
      if (typeof userId !== 'number') {
        return null;
      }
      return webhookNotificationsService.sendForEvent({ userId, event });
    }
  }
];

/** Used by provider runtimes and the chat gateway to deliver events through enabled channels. */
export function notifyUserIfEnabled({
  userId,
  event
}: {
  userId?: string | number | null;
  event: NotificationEvent;
}): void {
  if (!userId || !event) {
    return;
  }

  const normalizedEvent = normalizeNotificationSession(event);
  const preferences = notificationPreferencesDb.getPreferences(userId);
  if (!isNotificationEventEnabled(preferences, normalizedEvent)) {
    return;
  }
  const duplicate = isDuplicate(normalizedEvent);

  const payload = buildNotificationPayload(normalizedEvent);
  for (const channel of notificationChannels) {
    if (duplicate && !channel.bypassesDedupe) {
      continue;
    }
    if (!channel.isEnabled(preferences)) {
      continue;
    }
    Promise.resolve(channel.send({ userId, event: normalizedEvent, payload })).catch((err) => {
      console.error(`Notification channel "${channel.id}" send error:`, err);
    });
  }
}

//----------------- RUN OUTCOMES ------------

/** Used by provider runtimes to report stopped or completed agent runs. */
export function notifyRunStopped({
  userId,
  provider,
  sessionId = null,
  stopReason = 'completed',
  sessionName = null
}: NotificationTarget & { stopReason?: string }): void {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason, sessionName },
      severity: 'info',
      dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}`
    })
  });
}

/**
 * Tells the user a tool or question is waiting for their answer. One place
 * serves every engine: the chat gateway calls it for any approval card a
 * provider raises, so an engine cannot forget to.
 */
export function notifyPermissionRequired({
  userId,
  provider,
  sessionId = null,
  toolName = null,
  requestId,
  sessionName = null
}: NotificationTarget & {
  toolName?: string | null;
  requestId: string;
}): void {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'action_required',
      code: 'permission.required',
      meta: { toolName, sessionName },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `${provider}:permission:${sessionId || 'none'}:${requestId}`
    })
  });
}

/**
 * Reports background work that finished after its turn had already completed.
 *
 * Uses the `stop` kind so it rides the existing "run stopped" preference rather
 * than needing a new opt-in that would default to off. No explicit dedupeKey, so
 * the default composite key collapses repeats inside the dedupe window.
 *
 * Used by provider runtimes to report background work that finished after its
 * turn ended.
 */
export function notifyBackgroundWorkCompleted({
  userId,
  provider,
  sessionId = null,
  sessionName = null
}: NotificationTarget): void {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.background_completed',
      meta: { sessionName },
      severity: 'info'
    })
  });
}

/** Used by provider runtimes to report failed agent runs. */
export function notifyRunFailed({
  userId,
  provider,
  sessionId = null,
  error,
  sessionName = null
}: NotificationTarget & { error: unknown }): void {
  const errorMessage = normalizeErrorMessage(error);

  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'error',
      code: 'run.failed',
      meta: { error: errorMessage, sessionName },
      severity: 'error',
      dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${errorMessage}`
    })
  });
}
