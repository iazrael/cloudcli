import crypto from 'node:crypto';
import path from 'node:path';

import { taskContinuationDb } from '@/modules/database/index.js';
import {
  generateTaskCallbackToken,
  hashToken,
  verifyTaskCallbackToken,
} from '@/modules/task-continuations/services/task-token.service.js';
import { notifyTaskActivity } from '@/modules/task-continuations/services/task-host-cards.service.js';
import { normalizeTaskResult } from '@/modules/task-continuations/services/task-result.service.js';
import type { AsyncTaskRecord, TaskAccessScope } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

export type TaskRegisterInput = {
  userId: number;
  sessionId: string;
  runId?: string | null;
  providerThreadId?: string | null;
  sessionProjectPath?: string | null;
  workingDirectory?: string | null;
  sandboxPolicyType?: 'workspaceWrite' | 'dangerFullAccess' | null;
  networkAccess?: boolean | null;
  approvalPolicy?: 'never' | 'on-request' | null;
  title: string;
  command?: string | null;
  registrationKey?: string | null;
  autoNotify?: boolean;
};

export type TaskRegisterResult = {
  taskId: string;
  taskToken: string | null;
  title: string;
  created: boolean;
};

export type TaskFinishInput = {
  taskId: string;
  taskToken: string;
  status: unknown;
  exitCode?: unknown;
  resultDigest?: string;
  resultPath?: string | null;
  resultSummary?: unknown;
  resultJson?: unknown;
};

export type TaskFinishResult = {
  success: boolean;
  taskId: string;
  eventId: string | null;
  isDuplicate: boolean;
};

function assertTaskAccess(task: AsyncTaskRecord, scope: TaskAccessScope): void {
  if (task.user_id !== scope.userId || (scope.sessionId !== undefined && task.session_id !== scope.sessionId)) {
    throw new AppError(`Task ${task.task_id} was not found`, {
      code: 'TASK_NOT_FOUND',
      statusCode: 404,
    });
  }
}

/**
 * Validates that a user-supplied result file path does not attempt path traversal outside allowed boundaries.
 */
function assertSafeResultPath(filePath: string | null | undefined): void {
  if (!filePath) {
    return;
  }
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized) && normalized.includes('/../')) {
    throw new AppError(`Unsafe task result path: "${filePath}"`, {
      code: 'UNSAFE_RESULT_PATH',
      statusCode: 400,
    });
  }
}

/**
 * Handles registering a new async task.
 *
 * Consumed by task registration API route and chat execution hooks.
 */
export async function handleTaskRegisterRequest(input: TaskRegisterInput): Promise<TaskRegisterResult> {
  if (!input.title || typeof input.title !== 'string' || !input.title.trim()) {
    throw new AppError('Task title is required', {
      code: 'INVALID_TASK_TITLE',
      statusCode: 400,
    });
  }

  const registrationKey = input.registrationKey?.trim() || null;
  if (registrationKey) {
    const existing = taskContinuationDb.getTaskByRegistrationKey(registrationKey);
    if (existing) {
      if (existing.user_id !== input.userId || existing.session_id !== input.sessionId || existing.run_id !== (input.runId ?? null)
        || existing.title !== input.title.trim()
        || existing.command !== (input.command ?? null)
        || existing.auto_notify !== ((input.autoNotify ?? true) ? 1 : 0)) {
        throw new AppError('Task request identity is already bound to another task.', {
          code: 'TASK_REGISTRATION_IDENTITY_CONFLICT',
          statusCode: 409,
        });
      }
      return { taskId: existing.task_id, taskToken: null, title: existing.title, created: false };
    }
  }

  const taskId = `task_${crypto.randomUUID()}`;
  const taskToken = generateTaskCallbackToken(taskId);
  const tokenHash = hashToken(taskToken);

  taskContinuationDb.registerAsyncTask({
    taskId,
    userId: input.userId,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    providerThreadId: input.providerThreadId ?? null,
    sessionProjectPath: input.sessionProjectPath ?? null,
    workingDirectory: input.workingDirectory ?? null,
    sandboxPolicyType: input.sandboxPolicyType ?? null,
    networkAccess: input.networkAccess ?? null,
    approvalPolicy: input.approvalPolicy ?? null,
    title: input.title.trim(),
    command: input.command ?? null,
    registrationKey,
    autoNotify: input.autoNotify ?? true,
    tokenHash,
    tokenExpiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  });

  return {
    taskId,
    taskToken,
    title: input.title.trim(),
    created: true,
  };
}

/**
 * Handles task finish callback, verifies token, validates path, and writes to transactional outbox.
 *
 * Consumed by task finish API route and local runner.
 */
export async function handleTaskFinishRequest(input: TaskFinishInput): Promise<TaskFinishResult> {
  const task = taskContinuationDb.getTaskById(input.taskId);
  if (!task) {
    throw new AppError(`Task ${input.taskId} was not found`, {
      code: 'TASK_NOT_FOUND',
      statusCode: 404,
    });
  }

  // 校验任务回调凭证
  const tokenValid = verifyTaskCallbackToken(input.taskToken, task.token_hash);
  if (!tokenValid) {
    throw new AppError('Invalid task callback token', {
      code: 'INVALID_TASK_TOKEN',
      statusCode: 401,
    });
  }

  const tokenExpiresAt = task.token_expires_at ? Date.parse(task.token_expires_at) : Number.NaN;
  if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= Date.now()) {
    throw new AppError('Task callback token has expired', {
      code: 'TASK_TOKEN_EXPIRED',
      statusCode: 401,
    });
  }

  // 校验路径安全
  assertSafeResultPath(input.resultPath);

  const normalizedResult = normalizeTaskResult({
    taskId: input.taskId,
    status: input.status,
    exitCode: input.exitCode,
    resultSummary: input.resultSummary,
    resultJson: input.resultJson,
  });

  const outboxResult = taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
    taskId: input.taskId,
    status: normalizedResult.status,
    exitCode: normalizedResult.exitCode,
    resultDigest: normalizedResult.resultDigest,
    resultPath: input.resultPath,
    resultSummary: normalizedResult.resultSummary,
    resultJson: normalizedResult.resultJson,
  });
  // The task is over, so its card goes.
  notifyTaskActivity(task.session_id);

  return {
    success: true,
    taskId: outboxResult.taskId,
    eventId: outboxResult.eventId,
    isDuplicate: outboxResult.isDuplicate,
  };
}

/**
 * Retrieves a task record and its continuation event if available.
 *
 * Consumed by task status API route and local CLI runner status check.
 */
export async function handleGetTaskStatus(taskId: string, scope: TaskAccessScope): Promise<{
  task: AsyncTaskRecord;
  continuationEvent: ReturnType<typeof taskContinuationDb.getEventByTaskId>;
}> {
  const task = taskContinuationDb.getTaskById(taskId);
  if (!task) {
    throw new AppError(`Task ${taskId} was not found`, {
      code: 'TASK_NOT_FOUND',
      statusCode: 404,
    });
  }
  assertTaskAccess(task, scope);
  const continuationEvent = taskContinuationDb.getEventByTaskId(taskId);
  return { task, continuationEvent };
}

/**
 * Cancels a pending continuation notification for a task.
 *
 * Consumed by cancel-notification API route and CLI runner.
 */
export async function handleCancelTaskNotification(
  taskId: string,
  scope: TaskAccessScope,
  reason?: string,
): Promise<boolean> {
  const task = taskContinuationDb.getTaskById(taskId);
  if (!task) {
    throw new AppError(`Task ${taskId} was not found`, {
      code: 'TASK_NOT_FOUND',
      statusCode: 404,
    });
  }
  assertTaskAccess(task, scope);
  const result = taskContinuationDb.cancelNotificationForTask(taskId, reason || 'Cancelled by user');
  if (result === 'not_found') {
    throw new AppError(`Task ${taskId} was not found`, { code: 'TASK_NOT_FOUND', statusCode: 404 });
  }
  if (result === 'already_sending') {
    throw new AppError('The notification turn is already sending or accepted. Stop that turn from the chat if needed.', {
      code: 'TASK_NOTIFICATION_ALREADY_SENDING', statusCode: 409,
    });
  }
  if (result === 'already_terminal') {
    throw new AppError('The notification is already terminal and cannot be cancelled.', {
      code: 'TASK_NOTIFICATION_ALREADY_TERMINAL', statusCode: 409,
    });
  }
  return result === 'cancelled';
}

/** Requeues only after the owner records an explicit duplicate-risk decision. */
export async function handleManualRetryTaskNotification(
  taskId: string,
  scope: TaskAccessScope,
  reason: string,
): Promise<boolean> {
  const task = taskContinuationDb.getTaskById(taskId);
  if (!task) {
    throw new AppError(`Task ${taskId} was not found`, { code: 'TASK_NOT_FOUND', statusCode: 404 });
  }
  assertTaskAccess(task, scope);
  const event = taskContinuationDb.getEventByTaskId(taskId);
  if (!event) {
    throw new AppError(`No continuation event found for task ${taskId}`, { code: 'EVENT_NOT_FOUND', statusCode: 404 });
  }
  if (event.status !== 'needs_review') {
    throw new AppError('Only notifications marked needs_review can be manually retried.', {
      code: 'TASK_NOTIFICATION_NOT_REVIEWABLE', statusCode: 409,
    });
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason || normalizedReason.length > 500) {
    throw new AppError('A reason of 1 to 500 characters is required.', {
      code: 'INVALID_MANUAL_RETRY_REASON', statusCode: 400,
    });
  }
  return taskContinuationDb.manuallyRequeueEvent({ eventId: event.event_id, userId: scope.userId, reason: normalizedReason });
}
