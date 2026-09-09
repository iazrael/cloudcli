import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import type { ClaudeSettings, LLMProvider, PermissionMode } from '@/shared/types';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

import { safeLocalStorage } from '@/shared/utils';

export { safeLocalStorage };


/**
 * Claude's tool-permission settings, stored in auth.db so the allow-list a user
 * builds up on one machine applies on the next. The default permission mode is
 * the mode new sessions start in; the old skip-permissions checkbox is retired
 * and its stored flag is deliberately not surfaced.
 *
 * `projectSortOrder` is a separate preference now, but stays on the returned
 * object because ClaudeSettings still describes the whole legacy blob.
 */
export function getClaudeSettings(): ClaudeSettings {
  const stored = readUserPreference<Partial<ClaudeSettings>>('claudePermissions', {});

  return {
    permissionMode: toClaudePermissionMode(stored.permissionMode),
    allowedTools: Array.isArray(stored.allowedTools) ? stored.allowedTools : [],
    disallowedTools: Array.isArray(stored.disallowedTools) ? stored.disallowedTools : [],
    projectSortOrder: readUserPreference<ClaudeSettings['projectSortOrder']>('projectSortOrder', 'name'),
  };
}

/** Coerces an untrusted stored value into a valid Claude permission mode; anything unrecognized falls back to 'default'. Used by the storage reader and the settings controller. */
export function toClaudePermissionMode(value: unknown): PermissionMode {
  return value === 'acceptEdits' || value === 'auto' || value === 'bypassPermissions' || value === 'plan'
    ? value
    : 'default';
}

/**
 * Persists Claude's tool permissions after the user grants one from the chat.
 * The grant only carries the tool lists, so the stored default permission mode
 * is carried over untouched — a write that dropped it would reset the default
 * configured in the settings dialog.
 */
export function saveClaudePermissions(permissions: {
  allowedTools: string[];
  disallowedTools: string[];
}): void {
  const stored = readUserPreference<Partial<ClaudeSettings>>('claudePermissions', {});
  writeUserPreference('claudePermissions', {
    permissionMode: stored.permissionMode,
    ...permissions,
  });
}

/**
 * Reads a provider's tool-permission settings for `chat.send` from the one
 * store every writer shares — the settings dialog and in-chat grants both
 * write these keys — so what goes out matches what the user configured, on
 * any device. An unset provider comes back empty; callers apply their own
 * fallback shape.
 */
export function readProviderToolsSettings(provider: LLMProvider): Record<string, unknown> {
  return readUserPreference<Record<string, unknown>>(
    PROVIDER_PERMISSION_PREFERENCE_KEYS[provider],
    {},
  );
}

export type StoredQueuedMessage = {
  content: string;
  options?: QueuedSendOptions;
  /** Legacy image-only descriptors retained for queued draft compatibility. */
  images?: unknown[];
  /**
   * JSON-safe descriptors returned by POST /api/assets/files. Unlike browser
   * File objects, they can follow a queued message across session switches.
   */
  attachments?: unknown[];
}

export function readQueuedMessage(sessionId: string): StoredQueuedMessage | null {
  const raw = safeLocalStorage.getItem(queuedMessageKey(sessionId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as StoredQueuedMessage).content === 'string') {
      const { content, options, images, attachments } = parsed as StoredQueuedMessage;
      const normalizedAttachments = Array.isArray(attachments)
        ? attachments
        : Array.isArray(images)
          ? images
          : [];
      return content.trim() || normalizedAttachments.length > 0
        ? { content, options, attachments: normalizedAttachments }
        : null;
    }
  } catch {
    // Legacy format: the raw draft text itself.
  }

  return raw.trim() ? { content: raw } : null;
}

export function writeQueuedMessage(sessionId: string, message: StoredQueuedMessage): void {
  safeLocalStorage.setItem(queuedMessageKey(sessionId), JSON.stringify(message));
}

export function clearQueuedMessage(sessionId: string): void {
  safeLocalStorage.removeItem(queuedMessageKey(sessionId));
}

export type QueuedSendOptions = Record<string, unknown>;

export const queuedMessageKey = (sessionId: string) => `queued_message_${sessionId}`;
