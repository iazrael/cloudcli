import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import type { ClaudeSettings, LLMProvider, PermissionMode, QueuedSendOptions } from '@/shared/types';
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


//----------------- QUEUED COMPACTION ------------

/**
 * A `/compact` the user asked for while the session was still generating.
 * Compaction starts its own run, and the gateway refuses one while a run holds
 * the session, so the request is parked here and dispatched when that run ends.
 */
export type StoredQueuedCompact = {
  /** Composer preferences snapshotted at request time, replayed with the frame. */
  options?: QueuedSendOptions;
};

/** Stable localStorage key for a session's parked compaction request. */
export const queuedCompactKey = (sessionId: string) => `queued_compact_${sessionId}`;

/** Reads the parked compaction request for a session; null when none is parked. */
export function readQueuedCompact(sessionId: string): StoredQueuedCompact | null {
  const raw = safeLocalStorage.getItem(queuedCompactKey(sessionId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object'
      ? { options: (parsed as StoredQueuedCompact).options }
      : {};
  } catch {
    // A marker written by an older build carries no options, only the request.
    return {};
  }
}

/** Parks a compaction request for the session that asked for it. */
export function writeQueuedCompact(sessionId: string, compact: StoredQueuedCompact = {}): void {
  safeLocalStorage.setItem(queuedCompactKey(sessionId), JSON.stringify(compact));
}

/** Removes a parked compaction request once it is dispatched or cancelled. */
export function clearQueuedCompact(sessionId: string): void {
  safeLocalStorage.removeItem(queuedCompactKey(sessionId));
}
