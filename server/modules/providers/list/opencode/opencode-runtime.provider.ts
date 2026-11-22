/**
 * OpenCode Runtime Provider
 *
 * Thin orchestration over the opencode module's building blocks: the
 * service supervisor (`opencode-service.ts`), the event stream
 * (`opencode-event-stream.ts`), the interaction bridge
 * (`opencode-interaction-bridge.ts`), the run registry
 * (`opencode-run-registry.ts`), session settings
 * (`opencode-session-settings.ts`) and prompt attachments
 * (`opencode-prompt-attachments.ts`).
 *
 * One `run()` = ensure the service → create/reuse the provider session
 * anchored to the project directory → apply the permission mode → switch
 * the model (variant = reasoning effort) → POST the prompt → forward
 * translated events until an execution terminal. `abort()` POSTs interrupt
 * and retracts pending cards; the gateway owns the aborted `complete`, so
 * none is sent here. The `permissions` facet answers permission/question
 * cards and replays them after a reload.
 *
 * Work the engine moved to the background outlives the run: the registry
 * keeps the conversation and routes its frames to the session channel until
 * the work and the engine's report turn are over, and the background facets
 * (`listBackgroundWork`, `backgroundTasks`, `getSessionActivity`,
 * `hasSessionWork`, `stopBackgroundTask`) answer from that state.
 *
 * @module opencode-runtime.provider
 */

import { notifyBackgroundWorkCompleted, notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SessionBackgroundWork,
  SideQuestionRequest,
  SideQuestionSink,
} from '@/shared/types.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  generateMessageId,
  readCompactCommand,
  readObjectRecord,
  readOptionalString,
  resolveModelEffort,
} from '@/shared/utils.js';

import type { BackgroundWorkRegistry } from '../../shared/background-work/background-work-registry.js';
import { LOCAL_AGENT_TASK_TYPE } from '../../shared/background-work/task-status.js';

import {
  OpenCodeApiClient,
  OpenCodeApiError,
  parseOpenCodeModelRef,
  type OpenCodeServiceEndpoint,
} from './opencode-api.client.js';
import { askOpenCodeSideQuestion } from './opencode-side-question.js';
import {
  opencodeBackgroundWork,
  readBackgroundNotice,
  type OpenCodeBackgroundNotice,
} from './opencode-background-work.js';
import { openOpenCodeDatabase, readOpenCodeSyntheticNoticeMetadata } from './opencode-data-root.js';
import { OpenCodeEventStream, type OpenCodeEventEnvelope } from './opencode-event-stream.js';
import {
  applyEngineRename as applyEngineRenameToApp,
  noteEngineSessionEvent,
} from './opencode-engine-renames.js';
import { OpenCodeInteractionBridge } from './opencode-interaction-bridge.js';
import { buildOpenCodePromptFiles, buildOpenCodePromptText } from './opencode-prompt-attachments.js';
import { OpenCodeRunRegistry, toOpenCodeTokenBudget } from './opencode-run-registry.js';
import { DEFAULT_OPENCODE_CONTEXT_WINDOW, readOpenCodeModelContextLimit } from './opencode-models.provider.js';
import { OpenCodeServiceError, OpenCodeServiceSupervisor } from './opencode-service.js';
import {
  OpenCodeSessionSettingsApplier,
  resolveOpenCodeSessionSettings,
} from './opencode-session-settings.js';

export { resolveOpenCodeSessionSettings } from './opencode-session-settings.js';

const PROVIDER = 'opencode' as const;

type RuntimeDependencies = {
  supervisor?: Pick<OpenCodeServiceSupervisor, 'ensureEndpoint' | 'onExit' | 'currentEndpoint'>;
  createClient?: (endpoint: OpenCodeServiceEndpoint) => OpenCodeApiClient;
  /** Grace period before an interrupt is assumed to have landed; default 5s. */
  abortSettleGraceMs?: number;
  /** Where background work is recorded; default the process-wide `opencodeBackgroundWork`. */
  backgroundWork?: BackgroundWorkRegistry;
  /** The notices the engine persisted for a session; default read from `opencode.db`. */
  readPersistedNotices?: (providerSessionId: string) => OpenCodeBackgroundNotice[];
};

/** Notices persisted as `synthetic` session messages; none when the database cannot be read. */
const readPersistedNoticesFromDatabase = (providerSessionId: string): OpenCodeBackgroundNotice[] => {
  let db: ReturnType<typeof openOpenCodeDatabase> = null;
  try {
    db = openOpenCodeDatabase();
    if (!db) {
      return [];
    }
    return readOpenCodeSyntheticNoticeMetadata(db, providerSessionId)
      .flatMap(({ metadata, createdAt }) => {
        const notice = readBackgroundNotice(metadata);
        return notice ? [{ ...notice, ...(createdAt === null ? {} : { at: createdAt }) }] : [];
      });
  } catch (error) {
    console.warn('[OpenCode] failed to read the background notices the engine persisted:', error);
    return [];
  } finally {
    db?.close();
  }
};

/**
 * Builds the runtime wired to the production supervisor and event stream.
 *
 * Consumers: `opencode.provider.ts` (module-level singleton via
 * `opencodeRuntime`) and the runtime tests (own supervisor + fake service).
 */
/**
 * A live OpenCode service client for callers outside a chat run, or null when
 * the production runtime has not produced one yet. Set by the singleton
 * factory below (test-built runtimes never touch it) and read by the fork
 * facet, which must reuse the running service rather than start a second one.
 */
let productionClientGetter: (() => OpenCodeApiClient | null) | null = null;
let productionEndpointEnsurer: (() => Promise<OpenCodeServiceEndpoint>) | null = null;
let productionClientFactory: ((endpoint: OpenCodeServiceEndpoint) => OpenCodeApiClient) | null = null;

/**
 * Returns the production runtime's service client, booting the service for it
 * if no run has created one yet.
 *
 * Consumer: the opencode fork facet (the only non-run caller of the service).
 */
export async function ensureOpenCodeClient(): Promise<OpenCodeApiClient> {
  const existing = productionClientGetter?.();
  if (existing) {
    return existing;
  }
  if (!productionEndpointEnsurer || !productionClientFactory) {
    throw new Error('OpenCode service is not available');
  }
  return productionClientFactory(await productionEndpointEnsurer());
}

export function createOpenCodeRuntime(dependencies: RuntimeDependencies = {}): IProviderRuntime {
  const supervisor = dependencies.supervisor ?? new OpenCodeServiceSupervisor();
  const createClient = dependencies.createClient ?? ((endpoint) => new OpenCodeApiClient(endpoint));
  const abortSettleGraceMs = dependencies.abortSettleGraceMs ?? 5_000;
  const backgroundWork = dependencies.backgroundWork ?? opencodeBackgroundWork;
  const readPersistedNotices = dependencies.readPersistedNotices ?? readPersistedNoticesFromDatabase;
  // Only the singleton runtime publishes its client; test-built runtimes with
  // injected supervisors and fake services must not leak into it.
  const isProductionRuntime = !dependencies.supervisor && !dependencies.createClient;
  if (isProductionRuntime) {
    productionClientGetter = () => client;
    productionEndpointEnsurer = () => supervisor.ensureEndpoint();
    productionClientFactory = createClient;
  }

  // Reconnects only boot the service while a run is in flight (runs create
  // their registry entry before awaiting the stream); with nobody chatting a
  // broken engine must not be resurrected forever.
  const eventStream = new OpenCodeEventStream(async () => {
    const endpoint = supervisor.currentEndpoint();
    if (endpoint) {
      return endpoint;
    }
    if (runs.all().length === 0) {
      throw new Error('OpenCode service is not running');
    }
    return supervisor.ensureEndpoint();
  });
  let client: OpenCodeApiClient | null = null;

  const bridge = new OpenCodeInteractionBridge({
    getClient: () => client,
    resolveChild: (providerSessionId) => runs.childOwner(providerSessionId),
  });
  const runs = new OpenCodeRunRegistry({
    backgroundWork,
    hooks: {
      // The run is over but a background agent may still ask for approval:
      // its cards now reach the page through the session channel.
      detached: (conversation) => {
        bridge.attach({
          appSessionId: conversation.appSessionId,
          providerSessionId: conversation.providerSessionId,
          writer: conversation.writer,
          resolveToolCall: (callId) => conversation.translator.getToolCall(callId),
        });
        bridge.rebind(conversation.appSessionId, conversation.writer);
      },
      // Nothing runs in the conversation any more, so no card can be answered.
      dropped: (conversation) => {
        bridge.cancelSession(conversation.appSessionId, 'Nothing is running in the session any more.');
        bridge.detach(conversation.providerSessionId);
      },
      // The run's own end was announced when it ended; this is when the
      // work it left running and the engine's report on it are over.
      workFinished: (conversation) => {
        notifyBackgroundWorkCompleted({
          userId: conversation.owner.userId,
          provider: PROVIDER,
          sessionId: conversation.appSessionId,
          sessionName: conversation.owner.sessionName ?? null,
        });
      },
    },
  });

  /** The cards of background agents' sessions, which outlive a run that ends. */
  const backgroundCardSessions = (sessionId: string): Set<string> => {
    const conversation = runs.conversation(sessionId);
    return conversation ? runs.backgroundChildSessions(conversation) : new Set();
  };
  const settings = new OpenCodeSessionSettingsApplier();

  /**
   * Applies the name OpenCode generated for one of its sessions.
   *
   * The engine names a session on its own and announces the name on the event
   * stream, in its own time — often after the reply is already on screen. The
   * name is written into the app row here, and announced as a name-only
   * update, so the client takes the new title without re-reading the
   * transcript, marking the session as needing attention or re-ordering the
   * list.
   */
  const applyEngineRename = async (event: OpenCodeEventEnvelope): Promise<void> => {
    if (event.type !== 'session.renamed') {
      return;
    }
    const data = readObjectRecord(event.data) ?? {};
    const providerSessionId = readOptionalString(data.sessionID);
    const title = readOptionalString(data.title);
    if (!providerSessionId || !title) {
      return;
    }
    // The engine stamps the rename with the event's own creation time, which
    // is the value its session row carries from then on.
    const engineUpdatedAtMs = typeof event.created === 'number' && Number.isFinite(event.created)
      ? event.created
      : Date.now();
    const { applied } = applyEngineRenameToApp({ providerSessionId, title, engineUpdatedAtMs });
    if (!applied) {
      // The user renamed the session, so their name is final.
      return;
    }
    // The websocket module pulls the providers module in, so it is loaded on
    // demand: a static import here would close a cycle that starts at the
    // provider registry, and loading it lazily keeps the websocket module
    // out of the startup path of a process that never names a session.
    const { broadcastSessionUpserted } = await import('@/modules/websocket/index.js');
    await broadcastSessionUpserted(providerSessionId, { metadataOnly: true });
  };

  eventStream.subscribe((event) => {
    bridge.handleEvent(event);
    runs.dispatch(event);
    const data = readObjectRecord(event.data) ?? {};
    const sessionId = readOptionalString(data.sessionID);
    const created = typeof event.created === 'number' && Number.isFinite(event.created) ? event.created : null;
    if (sessionId && created !== null && event.type !== 'session.renamed') {
      noteEngineSessionEvent(sessionId, created);
    }
    // The engine's event feed is the runtime's lifeline, so a failure to
    // apply one event must not take the process down with it.
    void applyEngineRename(event).catch((error: unknown) => {
      console.warn('[OpenCode] failed to apply the name the engine generated:', error);
    });
  });
  eventStream.onReconnect(() => {
    // A notice that fell into the gap is persisted all the same; settle the
    // work first, so the service is then asked whether a report turn runs.
    runs.reconcileBackground(readPersistedNotices);
    void runs.reconcile({ getSession: (sessionId) => client?.getSession(sessionId)
      ?? Promise.reject(new OpenCodeApiError('GET', '/api/session', 503, 'OpenCode service is not running')) });
  });
  supervisor.onExit(() => {
    settings.reset();
    runs.settleAll({ outcome: 'lost', error: 'The OpenCode service exited while the run was in progress.' });
  });

  const sendTokenBudget = async (
    appSessionId: string,
    providerSessionId: string,
    writer: ProviderRuntimeWriter,
    sessionModelRef: { providerID: string; id: string } | null,
  ): Promise<void> => {
    if (!client) {
      return;
    }
    try {
      const snapshot = await client.getSession(providerSessionId);
      const contextWindow = sessionModelRef
        ? readOpenCodeModelContextLimit(sessionModelRef) ?? DEFAULT_OPENCODE_CONTEXT_WINDOW
        : DEFAULT_OPENCODE_CONTEXT_WINDOW;
      const budget = snapshot.tokens ? toOpenCodeTokenBudget(snapshot.tokens, contextWindow) : null;
      if (budget) {
        writer.send(createNormalizedMessage({
          id: generateMessageId(PROVIDER),
          sessionId: appSessionId,
          provider: PROVIDER,
          kind: 'status',
          text: 'token_budget',
          tokenBudget: budget,
        }));
      }
    } catch (error) {
      console.warn('[OpenCode] failed to read the token budget:', error);
    }
  };

  const run = async (
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<void> => {
    const appSessionId = readOptionalString(options.sessionId);
    if (!appSessionId) {
      throw new Error('OpenCode runtime requires the app session id');
    }
    const workingDir = readOptionalString(options.cwd) ?? readOptionalString(options.projectPath) ?? process.cwd();
    const sessionSummary = readOptionalString(options.sessionSummary);
    const userId = writer.userId === undefined || writer.userId === null ? null : String(writer.userId);

    const describeError = (error: unknown): string => (
      error instanceof OpenCodeServiceError || error instanceof OpenCodeApiError
        ? error.message
        : error instanceof Error ? error.message : String(error)
    );
    const failRun = (message: string): never => {
      writer.send(createNormalizedMessage({
        id: generateMessageId(PROVIDER),
        sessionId: appSessionId,
        provider: PROVIDER,
        kind: 'error',
        content: message,
        isError: true,
      }));
      writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: appSessionId, exitCode: 1 }));
      notifyRunFailed({ userId, provider: PROVIDER, sessionId: appSessionId, sessionName: sessionSummary, error: message });
      throw new Error(message);
    };

    let endpoint: OpenCodeServiceEndpoint;
    try {
      endpoint = await supervisor.ensureEndpoint();
    } catch (error) {
      return failRun(describeError(error));
    }
    eventStream.start();
    const activeClient = createClient(endpoint);
    client = activeClient;

    let providerSessionId = context.resolveProviderSessionId(appSessionId);
    // The session's model reference feeds the token budget's context window;
    // resolved inside the try, read again after the run settles.
    let sessionModelRef: ReturnType<typeof parseOpenCodeModelRef> = null;
    try {
      if (!providerSessionId) {
        // No title on purpose: the engine names a session it has not named
        // yet, and it only does so while the session still carries the
        // placeholder it falls back to. A title handed in here would occupy
        // that placeholder and the session would keep the first message as
        // its name forever.
        const created = await activeClient.createSession({ directory: workingDir });
        providerSessionId = created.id;
        // The writer swallows session_created and persists the provider id.
        writer.setSessionId?.(providerSessionId);
        writer.send(createNormalizedMessage({
          kind: 'session_created',
          provider: PROVIDER,
          sessionId: appSessionId,
          newSessionId: providerSessionId,
        }));
      }
      await settings.apply(activeClient, providerSessionId, resolveOpenCodeSessionSettings(options.permissionMode));

      const resolvedModel = await context.resolveResumeModel(appSessionId, readOptionalString(options.model));
      if (resolvedModel) {
        let effortModels = null;
        try {
          effortModels = await context.getProviderModels();
        } catch (error) {
          console.warn('[OpenCode] unable to load provider models for effort validation:', error);
        }
        const effort = resolveModelEffort(resolvedModel, options.effort, effortModels);
        sessionModelRef = parseOpenCodeModelRef(resolvedModel, effort);
        if (sessionModelRef) {
          await settings.applyModel(activeClient, providerSessionId, sessionModelRef);
        } else {
          console.warn(`[OpenCode] cannot parse model reference "${resolvedModel}"; the session keeps its previous model`);
        }
      }
    } catch (error) {
      return failRun(describeError(error));
    }

    // `/compact` is not text for the model: the service compacts only through
    // its own endpoint, which runs as an execution of its own.
    const compactCommand = readCompactCommand(command);
    if (compactCommand?.instructions) {
      return failRun('OpenCode compacts without instructions. Send /compact on its own.');
    }
    const text = compactCommand ? '' : buildOpenCodePromptText(command, options);
    const files = compactCommand ? [] : await buildOpenCodePromptFiles(options, workingDir);
    if (!compactCommand && !text.trim() && files.length === 0) {
      return failRun('Nothing to send: the message is empty.');
    }

    const publishSessionEvent = context.publishSessionEvent;
    const channel: ProviderRuntimeWriter | null = publishSessionEvent
      ? { send: (data) => publishSessionEvent(appSessionId, data as NormalizedMessage), userId: writer.userId }
      : null;
    const activeRun = runs.create(appSessionId, providerSessionId, writer, channel, {
      userId,
      ...(sessionSummary ? { sessionName: sessionSummary } : {}),
    });
    bridge.attach({
      appSessionId,
      providerSessionId,
      writer,
      resolveToolCall: (callId) => activeRun.translator.getToolCall(callId),
    });

    // The feed must be live before the prompt: events emitted between the
    // prompt POST and the stream connecting would be lost for good.
    await eventStream.connected();

    try {
      if (compactCommand) {
        await activeClient.compact(providerSessionId);
      } else {
        await activeClient.prompt(providerSessionId, { text, files });
      }
      activeRun.promptAccepted = true;
    } catch (error) {
      bridge.cancelSession(appSessionId, 'The message was rejected by the OpenCode service.', backgroundCardSessions(appSessionId));
      runs.release(activeRun);
      return failRun(`OpenCode rejected the message: ${describeError(error)}`);
    }

    const settlement = await activeRun.settled;
    // Read before release forgets the children: calls they never resolved.
    const childSettleFrames = runs.settleChildren(activeRun);
    // Retract any cards still pending except a running background agent's.
    // Releasing then either moves the bridge attachment to the session channel
    // (the engine still works in the conversation) or retracts the rest and
    // detaches, so finished sessions do not pin memory forever (the
    // registry's hooks).
    bridge.cancelSession(appSessionId, 'The run ended with cards still pending.', backgroundCardSessions(appSessionId));
    runs.release(activeRun);
    // A spawn call the run never resolved would spin on its card forever.
    for (const frame of [...activeRun.translator.settleOpenSubagents(), ...childSettleFrames]) {
      writer.send(frame);
    }

    await sendTokenBudget(appSessionId, providerSessionId, writer, sessionModelRef);

    if (activeRun.aborted) {
      // The user stopped this run: the gateway's abort handler already
      // emitted the aborted complete, and a racing terminal event must not
      // paint a second, contradictory outcome over it.
      return;
    }
    if (settlement.outcome === 'succeeded') {
      writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: appSessionId, exitCode: 0 }));
      notifyRunStopped({
        userId, provider: PROVIDER, sessionId: appSessionId, sessionName: sessionSummary, stopReason: 'completed',
      });
      return;
    }
    if (settlement.outcome === 'interrupted') {
      writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: appSessionId, exitCode: 0, aborted: true }));
      notifyRunStopped({
        userId, provider: PROVIDER, sessionId: appSessionId, sessionName: sessionSummary, stopReason: 'aborted',
      });
      return;
    }
    writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: appSessionId, exitCode: 1 }));
    notifyRunFailed({
      userId, provider: PROVIDER, sessionId: appSessionId, sessionName: sessionSummary, error: settlement.error,
    });
    throw new Error(settlement.error);
  };

  /**
   * Stops what the engine still does in a conversation with no run: the
   * report turn and every background agent. A backgrounded command has no
   * request that stops it and keeps running.
   */
  const abortBackground = (sessionId: string): false | Promise<boolean> => {
    const conversation = runs.conversation(sessionId);
    if (!conversation || !client) {
      return false;
    }
    const activeClient = client;
    const targets = backgroundWork.list()
      .filter((entry) => entry.sessionId === conversation.appSessionId)
      .flatMap((entry) => entry.tasks)
      .filter((task) => task.taskType === LOCAL_AGENT_TASK_TYPE)
      .map((task) => task.taskId);
    if (conversation.engineTurn) {
      targets.push(conversation.providerSessionId);
    }
    if (targets.length === 0) {
      return false;
    }
    return Promise.allSettled(targets.map((target) => activeClient.interrupt(target))).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn('[OpenCode] failed to stop background work:', result.reason);
        }
      }
      // `false` from the service: that session was not running any more.
      return results.some((result) => result.status === 'fulfilled' && result.value);
    });
  };

  const abort = (sessionId: string): boolean | Promise<boolean> => {
    const activeRun = runs.get(sessionId);
    if (!activeRun) {
      return abortBackground(sessionId);
    }
    if (!activeRun.aborted) {
      activeRun.aborted = true;
      bridge.cancelSession(activeRun.appSessionId, 'The run was stopped.', backgroundCardSessions(sessionId));
      if (!client) {
        activeRun.settle({ outcome: 'interrupted', reason: 'user' });
      } else {
        client.interrupt(activeRun.providerSessionId)
          .then((interrupted) => {
            // `false` = nothing was running; the terminal already fired
            // (likely during a stream gap) and must not be waited for.
            if (!interrupted) {
              activeRun.settle({ outcome: 'interrupted', reason: 'user' });
            }
          })
          .catch((error) => {
            console.warn('[OpenCode] interrupt request failed:', error);
            activeRun.settle({ outcome: 'interrupted', reason: 'user' });
          });
      }
      // Safety net: a dropped `execution.interrupted` event must not wedge the
      // session in "processing"; the settlement contract ignores later calls.
      const timer = setTimeout(() => {
        activeRun.settle({ outcome: 'interrupted', reason: 'user' });
      }, abortSettleGraceMs);
      timer.unref?.();
    }
    return true;
  };

  /** Stops one background agent by interrupting its own session. */
  const stopBackgroundTask = async (sessionId: string, taskId: string): Promise<boolean> => {
    const appSessionId = runs.conversation(sessionId)?.appSessionId ?? sessionId;
    const task = backgroundWork.get(appSessionId, taskId);
    if (!task || task.taskType !== LOCAL_AGENT_TASK_TYPE || !client) {
      return false;
    }
    try {
      const interrupted = await client.interrupt(taskId);
      if (!interrupted) {
        // The agent's session was not running any more: its notice was
        // missed, and the engine persisted it all the same.
        runs.reconcileBackground(readPersistedNotices);
      }
      return interrupted;
    } catch (error) {
      console.warn('[OpenCode] failed to stop a background agent:', error);
      return false;
    }
  };

  return {
    run,
    abort,
    stopBackgroundTask,
    /**
     * Answers one side question on an ephemeral, read-only fork of the
     * session (see `opencode-side-question.ts`). Never rejects; a session
     * that has never run resolves as an error outcome.
     */
    askSideQuestion: (request: SideQuestionRequest, sink: SideQuestionSink) =>
      askOpenCodeSideQuestion(request, sink),
    listBackgroundWork(): SessionBackgroundWork[] {
      return [
        ...backgroundWork.list(),
        ...runs.listReportingOnly().map((entry) => ({ ...entry, tasks: [] })),
      ];
    },
    /**
     * Said outright while the conversation is known, `reporting: false`
     * included: the page keeps the last value a poll reported, so a report
     * that ended while a command still runs must be cleared.
     */
    getSessionActivity(sessionId: string) {
      return runs.conversation(sessionId) ? { queued: false, reporting: runs.isReporting(sessionId) } : null;
    },
    hasSessionWork(sessionId: string): boolean {
      const conversation = runs.conversation(sessionId);
      return Boolean(conversation?.run) || runs.isReporting(sessionId)
        || backgroundWork.hasSession(conversation?.appSessionId ?? sessionId);
    },
    backgroundTasks: {
      list: (sessionId: string) => runs.listStripTasks(runs.conversation(sessionId)?.appSessionId ?? sessionId),
      canInterrupt: (sessionId: string) => runs.canInterrupt(sessionId),
      // The engine files a new message into its inbox; background work goes on.
      queuesInput: () => false,
    },
    permissions: {
      resolve(requestId: string, decision: ProviderPermissionDecision): void {
        bridge.resolve(requestId, decision);
      },
      listPending(sessionId: string): unknown[] {
        return bridge.listPending(sessionId);
      },
    },
  };
}

/**
 * The production singleton: one service supervisor, event stream and run
 * registry per cloudcli process, shared by every opencode chat run.
 *
 * Consumer: `opencode.provider.ts`.
 */
export const opencodeRuntime: IProviderRuntime = createOpenCodeRuntime();
