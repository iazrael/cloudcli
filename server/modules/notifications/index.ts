export {
  // Used by notification tests and delivery workflows to create channel payloads.
  buildNotificationPayload,
  // Used by provider runtimes and Settings to create normalized notification events.
  createNotificationEvent,
  // Used by provider runtimes and Settings to deliver events through enabled channels.
  notifyUserIfEnabled,
  // Used by provider runtimes to report failed agent runs.
  notifyRunFailed,
  // Used by provider runtimes to report stopped or completed agent runs.
  notifyRunStopped,
  // Used by provider runtimes to report background work that finished after its turn ended.
  notifyBackgroundWorkCompleted,
  // Used by the chat gateway to report an approval card from any engine.
  notifyPermissionRequired,
} from '@/modules/notifications/services/notification-orchestrator.service.js';
// The event type settings re-publishes through its boundary.
export type { NotificationEvent } from '@/modules/notifications/services/notification-orchestrator.service.js';
// Reply preview registry: the chat session writer records each run's last assistant text here, and notification payloads spend it as the push body.
export {
  clearSessionReplyPreview,
  getSessionReplyPreview,
  rememberSessionReplyPreview,
} from '@/modules/notifications/services/run-notification-content.service.js';
export {
  registerDesktopNotificationClient,
  sendDesktopNotification,
  unregisterDesktopNotificationClient,
} from '@/modules/notifications/services/desktop-notification-clients.service.js';
export { handleDesktopNotificationsConnection } from '@/modules/notifications/websocket/desktop-notifications-websocket.service.js';
// getPublicKey: used by Settings to expose the Web Push subscription key.
export { getPublicKey } from './vapid-keys.service.js';
// configureWebPush: used by the server entrypoint during notification startup.
export { configureWebPush } from './vapid-keys.service.js';
