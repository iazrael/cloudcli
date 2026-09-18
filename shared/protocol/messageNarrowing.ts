/**
 * Narrowing a flat message down to one kind.
 *
 * Construction is already kind-checked (`messageKinds.ts`), but reading is
 * not: `NormalizedMessage` stays flat so the hundreds of existing consumers
 * keep compiling. These predicates are how a consumer opts into the same
 * discipline one call site at a time — after `isToolUseMessage(message)` the
 * compiler knows `toolName` is available and, just as usefully, that
 * `newSessionId` is not.
 *
 * Migrating a consumer means replacing `message.kind === 'tool_use'` with
 * `isToolUseMessage(message)`; nothing has to move in one go.
 *
 * They are written out one per kind rather than generated from a generic
 * helper because a generic `K` defeats the narrowing: TypeScript cannot prove
 * `MessageOfKind<K>` is assignable to `NormalizedMessage` for an unresolved
 * `K`, so the predicate silently degrades to telling the compiler nothing.
 */

import type { MessageFieldsByKind, NormalizedMessageEnvelope } from './messageKinds.js';
import type { MessageKind, NormalizedMessage } from './chatEvents.js';

/** One message narrowed to a single kind: the envelope plus that kind's fields. */
export type MessageOfKind<K extends MessageKind> =
  Omit<NormalizedMessageEnvelope, 'kind'> & { kind: K } & MessageFieldsByKind[K];

export function isTextMessage(m: NormalizedMessage): m is MessageOfKind<'text'> {
  return m.kind === 'text';
}

export function isThinkingMessage(m: NormalizedMessage): m is MessageOfKind<'thinking'> {
  return m.kind === 'thinking';
}

export function isStreamDeltaMessage(m: NormalizedMessage): m is MessageOfKind<'stream_delta'> {
  return m.kind === 'stream_delta';
}

export function isStreamEndMessage(m: NormalizedMessage): m is MessageOfKind<'stream_end'> {
  return m.kind === 'stream_end';
}

export function isToolUseMessage(m: NormalizedMessage): m is MessageOfKind<'tool_use'> {
  return m.kind === 'tool_use';
}

export function isToolResultMessage(m: NormalizedMessage): m is MessageOfKind<'tool_result'> {
  return m.kind === 'tool_result';
}

export function isErrorMessage(m: NormalizedMessage): m is MessageOfKind<'error'> {
  return m.kind === 'error';
}

export function isCompleteMessage(m: NormalizedMessage): m is MessageOfKind<'complete'> {
  return m.kind === 'complete';
}

export function isStatusMessage(m: NormalizedMessage): m is MessageOfKind<'status'> {
  return m.kind === 'status';
}

export function isPermissionRequestMessage(m: NormalizedMessage): m is MessageOfKind<'permission_request'> {
  return m.kind === 'permission_request';
}

export function isPermissionResolvedMessage(m: NormalizedMessage): m is MessageOfKind<'permission_resolved'> {
  return m.kind === 'permission_resolved';
}

export function isPermissionCancelledMessage(m: NormalizedMessage): m is MessageOfKind<'permission_cancelled'> {
  return m.kind === 'permission_cancelled';
}

export function isSessionCreatedMessage(m: NormalizedMessage): m is MessageOfKind<'session_created'> {
  return m.kind === 'session_created';
}

export function isHistoryTruncatedMessage(m: NormalizedMessage): m is MessageOfKind<'history_truncated'> {
  return m.kind === 'history_truncated';
}

export function isTaskNotificationMessage(m: NormalizedMessage): m is MessageOfKind<'task_notification'> {
  return m.kind === 'task_notification';
}
