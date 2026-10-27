import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  ActiveBackgroundTask,
  TaskBridgeEngineCall,
  AnyRecord,
  LLMProvider,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRunFunction,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveTranscriptPath(sessionId: string): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveTranscriptPath: (sessionId) => sessionsService.resolveTranscriptPath(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
};

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  /**
   * The entry that publishes an event to a session outside any run.
   *
   * The gateway owns it, and the composition root installs it after both
   * modules exist. Until it is installed a runtime has no way to reach a
   * session that has no round in flight.
   */
  let sessionEventPublisher: ((appSessionId: string, message: NormalizedMessage) => void) | undefined;

  /**
   * The entry that issues and revokes the narrow credential a resident
   * process carries.
   *
   * The composition root installs it with the task bridge, so the providers
   * module never imports the task-continuations module.
   */
  let bridgeCredentialIssuer: ((input: {
    userId: string;
    appSessionId: string;
    generation: number;
  }) => { token: string } | null) | undefined;
  let bridgeCredentialRevoker: ((token: string) => void) | undefined;

  /**
   * The entry that records an MCP tool call the engine made.
   *
   * The composition root installs it with the task bridge's registry.
   */
  let engineToolCallRegistrar: ((call: TaskBridgeEngineCall) => void) | undefined;

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveTranscriptPath: dependencies.resolveTranscriptPath,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    publishSessionEvent: (appSessionId, message) => {
      sessionEventPublisher?.(appSessionId, message);
    },
    createBridgeCredential: (input) => bridgeCredentialIssuer?.(input) ?? null,
    revokeBridgeCredential: (token) => {
      bridgeCredentialRevoker?.(token);
    },
    registerEngineToolCall: (call) => {
      engineToolCallRegistrar?.(call);
    },
    resetLiveMessageState: provider.sessions.resetLiveMessageState
      ? (sessionId) => provider.sessions.resetLiveMessageState?.(sessionId)
      : undefined,
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  const run = (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    return provider.runtime.run(command, options, writer, createRuntimeContext(provider));
  };

  // Only runtimes that broadcast `background_tasks` can later clear this on the
  // client, so the others never report it.
  const isBackgroundWorkPending = (sessionId: string): boolean => dependencies.listProviders()
    .some((provider) => Boolean(provider.runtime.backgroundTasks?.isPending?.(sessionId)));

  return {
    run,

    /** 供排队调度器判断能否安全尝试续轮，避免替换仍有后台任务的进程。 */
    supportsInputAcceptance(providerName: LLMProvider): boolean {
      return dependencies.resolveProvider(providerName).runtime.supportsInputAcceptance === true;
    },

    /**
     * Installs the entry that publishes an event to a session outside any
     * run. The composition root calls it with the gateway's publisher, so the
     * providers module never imports the websocket module.
     */
    setSessionEventPublisher(publisher: (appSessionId: string, message: NormalizedMessage) => void): void {
      sessionEventPublisher = publisher;
    },

    /**
     * Installs the entry that records an MCP tool call the engine made. The
     * composition root calls it with the task bridge's registry.
     */
    setBridgeCredentialIssuer(issuer: (input: {
      userId: string;
      appSessionId: string;
      generation: number;
    }) => { token: string } | null): void {
      bridgeCredentialIssuer = issuer;
    },

    /**
     * Installs the entry that revokes a bridge credential, for example when
     * the process that carried it is gone.
     */
    setBridgeCredentialRevoker(revoker: (token: string) => void): void {
      bridgeCredentialRevoker = revoker;
    },

    /** Used by server composition to connect observed native calls to task authorization. */
    setEngineToolCallRegistrar(registrar: (call: TaskBridgeEngineCall) => void): void {
      engineToolCallRegistrar = registrar;
    },

    /** execution 模块按注册表发现可派发引擎，安装探测失败时保留可追踪的诊断。 */
    async listExecutionProviders(): Promise<{ provider: LLMProvider; installed: boolean; supportsTaskExecution: boolean }[]> {
      return Promise.all(dependencies.listProviders().map(async (provider) => {
        try {
          return { provider: provider.id, installed: Boolean(provider.runtime && (await provider.auth.getStatus()).installed), supportsTaskExecution: provider.runtime.supportsTaskExecution === true };
        } catch (error) {
          console.warn(`[ProviderRuntime] ${provider.id} 安装探测失败`, error);
          return { provider: provider.id, installed: false, supportsTaskExecution: false };
        }
      }));
    },

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    /**
     * What the engines report about the session's round.
     */
    getSessionActivity(sessionId: string): { queued: boolean; reporting: boolean } | null {
      for (const provider of dependencies.listProviders()) {
        const activity = provider.runtime.getSessionActivity?.(sessionId);
        if (activity) {
          return activity;
        }
      }
      return null;
    },

    /**
     * Whether any engine still has work in the session.
     */
    hasSessionWork(sessionId: string): boolean {
      return dependencies.listProviders()
        .some((provider) => provider.runtime.hasSessionWork?.(sessionId) === true);
    },

    /**
     * Stops new work from starting in the session, so a caller can look at
     * its state and act on it without a run slipping in.
     */
    closeSessionAdmission(sessionId: string): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.closeSessionAdmission?.(sessionId);
      }
    },

    /**
     * Releases the resources the session holds in every engine.
     */
    releaseSession(sessionId: string): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.releaseSession?.(sessionId);
      }
    },

    /**
     * Opens the session's admission again in every engine.
     */
    openSessionAdmission(sessionId: string): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.openSessionAdmission?.(sessionId);
      }
    },

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      return Boolean(await dependencies.resolveProvider(providerName).runtime.abort(sessionId));
    },

    async stopBackgroundTask(providerName: LLMProvider, sessionId: string, taskId: string): Promise<boolean> {
      // A runtime that never holds background work has no task to stop.
      const { runtime } = dependencies.resolveProvider(providerName);
      return Boolean(await runtime.stopBackgroundTask?.(sessionId, taskId));
    },

    isBackgroundWorkPending,

    hasBackgroundWork(sessionId: string): boolean {
      return isBackgroundWorkPending(sessionId) || dependencies.listProviders().some((provider) =>
        (provider.runtime.listBackgroundWork?.() ?? []).some((entry) => entry.sessionId === sessionId));
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },

    backgroundWorkQueuesInput(providerName: LLMProvider, sessionId: string): boolean {
      return dependencies.resolveProvider(providerName).runtime.backgroundTasks?.queuesInput?.(sessionId) ?? true;
    },

    canInterruptBackgroundWork(sessionId: string): boolean {
      return dependencies.listProviders()
        .every((provider) => provider.runtime.backgroundTasks?.canInterrupt?.(sessionId) !== false);
    },

    getBackgroundTasksForSession(sessionId: string): ActiveBackgroundTask[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.backgroundTasks?.list(sessionId) ?? [],
      );
    },
  };
}

export const providerRuntimeService = createProviderRuntimeService();
