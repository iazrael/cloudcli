import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { getConnection, taskContinuationDb } from '@/modules/database/index.js';
import { notifyTaskActivity, suppressReportOfStoppedTask } from '@/modules/task-continuations/services/task-host-cards.service.js';
import { readAndNormalizeTaskResultFromDisk } from '@/modules/task-continuations/services/task-result.service.js';
import { getTaskContinuationTasksRoot } from '@/modules/task-continuations/services/task-storage.service.js';
import type { TaskHistoryChecker } from '@/shared/types.js';

/**
 * Scans task output directories on disk and recovers completed results that were not yet submitted via HTTP.
 *
 * Consumed by server startup initialization routines and recovery managers.
 */
export async function scanAndRecoverTaskResultsFromDisk(tasksRootDir?: string): Promise<number> {
  const rootDir = tasksRootDir || getTaskContinuationTasksRoot();

  try {
    const rootStat = await stat(rootDir);
    if (!rootStat.isDirectory()) {
      throw new Error(`Task result root must be a directory: ${rootDir}`);
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }

  let recoveredCount = 0;
  const entries = await readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const taskId = entry.name;
    const task = taskContinuationDb.getTaskById(taskId);
    // 只补录数据库已登记但尚未有终态的任务
    if (!task || (task.status !== 'registered' && task.status !== 'running')) {
      continue;
    }

    const taskDirectoryPath = path.join(rootDir, taskId);
    const resultFilePath = path.join(taskDirectoryPath, 'result.json');
    try {
      const result = await readAndNormalizeTaskResultFromDisk({
        taskId,
        tasksRootDir: rootDir,
        resultFilePath: resultFilePath,
      });

      suppressReportOfStoppedTask(taskId, result.status);
      taskContinuationDb.recordTaskCompletionAndCreateContinuationEvent({
        taskId,
        status: result.status,
        exitCode: result.exitCode,
        resultDigest: result.resultDigest,
        resultPath: resultFilePath,
        resultSummary: result.resultSummary,
        resultJson: result.resultJson,
      });
      notifyTaskActivity(task.session_id);

      recoveredCount++;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      taskContinuationDb.updateTaskRecoveryError({
        taskId,
        error: `Result recovery failed: ${message}`.slice(0, 4000),
      });
      console.error(`[TaskContinuation] Could not recover result for task ${taskId}:`, error);
    }
  }

  return recoveredCount;
}

/**
 * Reconciles lingering 'sending' or 'accepted' events after a server restart or crash.
 *
 * If a history checker confirms the engine already accepted the turn, the event is advanced
 * to delivered/reply_failed without duplicate submission. If the history checker fails,
 * the event is safely marked as needs_review rather than risking double execution.
 *
 * Consumed by server startup reconciliation routines.
 */
export async function reconcileIncompleteContinuationEvents(options?: {
  historyChecker?: TaskHistoryChecker;
  includeSending?: boolean;
  excludedEventIds?: ReadonlySet<string>;
}): Promise<void> {
  // 查询所有尚未确认对话终态的事件。
  const sendingEvents = getConnection().prepare(`
    SELECT * FROM task_continuation_events
    WHERE status IN ('accepted'${options?.includeSending === false ? '' : ", 'sending'"})
  `).all() as any[];

  for (const event of sendingEvents) {
    if (options?.excludedEventIds?.has(event.event_id)) continue;
    const expectedStatus = event.status as 'sending' | 'accepted';
    if (options?.historyChecker) {
      try {
        const check = await options.historyChecker(event.event_id);
        if (expectedStatus === 'accepted' && ((!check.found && check.status === 'inProgress')
          || check.status === 'paused')) {
          continue;
        }
        if (check.found && check.engineTurnId) {
          if (expectedStatus === 'sending') {
            const accepted = taskContinuationDb.updateEventAccepted({
              eventId: event.event_id,
              engineTurnId: check.engineTurnId,
              hostRunId: event.host_run_id,
            });
            if (!accepted) continue;
          } else if (event.engine_turn_id !== check.engineTurnId) {
            taskContinuationDb.updateEventFailed({
              eventId: event.event_id,
              error: 'History found a different engine turn than the accepted turn.',
              terminalStatus: 'needs_review',
              expectedStatus: 'accepted',
              engineTurnId: event.engine_turn_id,
            });
            continue;
          }
          if (check.status === 'failed' || check.status === 'interrupted') {
            taskContinuationDb.updateEventFailed({
              eventId: event.event_id,
              error: `Engine turn ${check.status} before the continuation completed.`,
              terminalStatus: 'reply_failed',
              expectedStatus: 'accepted',
              engineTurnId: check.engineTurnId,
            });
          } else if (check.status === 'completed') {
            taskContinuationDb.updateEventDelivered({
              eventId: event.event_id,
              engineTurnId: check.engineTurnId,
            });
          }
          // inProgress is confirmed accepted but has no terminal outcome yet.
          continue;
        }

        taskContinuationDb.updateEventFailed({
          eventId: event.event_id,
          error: check.found
            ? 'History found the event but could not confirm its turn.'
            : 'History did not prove whether the event was sent.',
          terminalStatus: 'needs_review',
          expectedStatus,
          hostRunId: event.host_run_id,
          engineTurnId: event.engine_turn_id,
        });
      } catch (err: any) {
        // 历史检查接口失败或无法确定：标记为 needs_review，禁止盲目重发！
        const errorMessage = err instanceof Error ? err.message : String(err);
        taskContinuationDb.updateEventFailed({
          eventId: event.event_id,
          error: `History check uncertain: ${errorMessage}`,
          terminalStatus: 'needs_review',
          expectedStatus,
          hostRunId: event.host_run_id,
          engineTurnId: event.engine_turn_id,
        });
        continue;
      }
    } else {
      // 无历史检查器：保守标记为 needs_review
      taskContinuationDb.updateEventFailed({
        eventId: event.event_id,
        error: 'Host restarted mid-sending without history verification',
        terminalStatus: 'needs_review',
        expectedStatus,
        hostRunId: event.host_run_id,
        engineTurnId: event.engine_turn_id,
      });
    }
  }
}
