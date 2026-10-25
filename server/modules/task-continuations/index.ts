/**
 * Task Continuations Module.
 *
 * Provides transactional outbox task continuation, background task status handling,
 * and automated turn resumption for long-running detached tasks.
 */

export {
  dispatchTaskContinuationEvent,
  pollAndDispatchNextEvent,
  startTaskContinuationWorker,
} from '@/modules/task-continuations/services/task-continuation-dispatcher.service.js';
export type {
  TaskContinuationRunner,
  TaskContinuationRunnerResult,
} from '@/modules/task-continuations/services/task-continuation-dispatcher.service.js';

export {
  generateTaskCallbackToken,
  hashToken,
  verifyTaskCallbackToken,
} from '@/modules/task-continuations/services/task-token.service.js';

export { normalizeTaskResult } from '@/modules/task-continuations/services/task-result.service.js';
export type { NormalizedTaskResult } from '@/modules/task-continuations/services/task-result.service.js';

export {
  createTaskBridgeCredential,
  registerTaskBridgeCall,
  resolveTaskBridgeCall,
  resolveTaskBridgeCredential,
  revokeTaskBridgeCredential,
  waitForTaskBridgeCall,
} from '@/modules/task-continuations/services/task-bridge.service.js';
export type {
  TaskBridgeCredentialContext,
} from '@/shared/types.js';

export {
  createTaskRunCapability,
  resolveTaskRunCapability,
  revokeTaskRunCapability,
  setTaskRunProviderThreadId,
} from '@/modules/task-continuations/services/task-run-context.service.js';
export type { TaskRunCapabilityContext, TaskAccessScope, TaskContinuationHistoryCheck, TaskHistoryChecker } from '@/shared/types.js';

export {
  handleCancelTaskNotification,
  handleGetTaskStatus,
  handleManualRetryTaskNotification,
  handleTaskFinishRequest,
  handleTaskRegisterRequest,
} from '@/modules/task-continuations/task-continuations.service.js';
export type {
  TaskFinishInput,
  TaskFinishResult,
  TaskRegisterInput,
  TaskRegisterResult,
} from '@/modules/task-continuations/task-continuations.service.js';

export {
  reconcileIncompleteContinuationEvents,
  scanAndRecoverTaskResultsFromDisk,
} from '@/modules/task-continuations/services/task-continuation-recovery.service.js';
export { createCodexTaskHistoryChecker } from '@/modules/task-continuations/services/task-continuation-history.service.js';
export { startTaskContinuationRuntime } from '@/modules/task-continuations/services/task-continuation-runtime.service.js';
export {
  areTaskContinuationsEnabled,
  setTaskContinuationsEnabled,
  TASK_CONTINUATIONS_ENABLED_CONFIG_KEY,
} from '@/modules/task-continuations/task-continuations.config.js';
export {
  taskBridgeRouter,
  taskContinuationsRouter,
} from '@/modules/task-continuations/task-continuations.routes.js';

export {
  listRunningHostTasks,
  requestHostTaskStop,
  setTaskActivityListener,
} from '@/modules/task-continuations/services/task-host-cards.service.js';

export {
  handleTaskRegisterForRun,
  readTaskOutputForScope,
  registerAndStartTaskFromRun,
} from '@/modules/task-continuations/services/task-continuation-worker-manager.service.js';
