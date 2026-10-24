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
 * translated events until an execution terminal. `compact()` rides the same
 * plumbing: the service admits a synthetic compaction message and runs the
 * summarization as a turn of its own, whose execution terminal ends the run.
 * `abort()` POSTs interrupt and retracts pending cards; the gateway owns the
 * aborted `complete`, so none is sent here. The `permissions` facet answers
 * permission/question cards and replays them after a reload.
 *
 * Executions the engine starts on its own are adopted instead of ignored: a
 * background subagent completing makes the service enqueue a synthetic
 * message and resume the parent session with no client prompt behind it, and
 * without adoption those frames, interaction cards and the terminal `complete`
 * would never reach the gateway (a question the model asks mid-resume stayed
 * invisible and unanswerable). When an event that can only occur inside a live
 * execution arrives for a session with no run of ours, the installed adopter
 * opens a gateway run and the execution rides the normal pipeline from there.
 *
 * Because the engine's event feed is volatile (a dropped connection loses its
 * events for good), the `permissions` facet can also re-read the service's
 * pending set (`reconcilePending`): asks raised while the feed was down are
 * re-announced, so a model waiting on a question can still be answered.
 *
 * @module opencode-runtime.provider
 */

import Database from 'better-sqlite3';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
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

import {
  OpenCodeApiClient,
  OpenCodeApiError,
  parseOpenCodeModelRef,
  type OpenCodeServiceEndpoint,
} from './opencode-api.client.js';
import { readOpenCodeContextUsage } from './opencode-context-usage.js';
import { getOpenCodeDatabasePath } from './opencode-data-root.js';
import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';
import { OpenCodeEventStream } from './opencode-event-stream.js';
import { OpenCodeInteractionBridge } from './opencode-interaction-bridge.js';
import { buildOpenCodePromptFiles, buildOpenCodePromptText } from './opencode-prompt-attachments.js';
import { OpenCodeRunRegistry, OpenCodeTokenBudgetTracker, type OpenCodeActiveRun, type OpenCodeRunSettlement } from './opencode-run-registry.js';
import { OpenCodeServiceError, OpenCodeServiceSupervisor } from './opencode-service.js';
import {
  OpenCodeSessionSettingsApplier,
  resolveOpenCodeSessionSettings,
} from './opencode-session-settings.js';

export { resolveOpenCodeSessionSettings } from './opencode-session-settings.js';

const PROVIDER = 'opencode' as const;

/**
 * What the gateway hands back when it adopts an execution the engine started
 * on its own: the app session its frames belong to, and the writer that
 * remaps ids, assigns `seq`, buffers for replay and reaches the sockets.
 */
export type OpenCodeAdoptedRun = {
  appSessionId: string;
  writer: ProviderRuntimeWriter;
};

/**
 * Opens a gateway run for an engine-initiated execution, or returns null when
 * there is nothing to adopt (no app session maps to the provider session, the
 * row is archived, or a run is already in flight).
 */
export type OpenCodeExternalRunAdopter = (input: { providerSessionId: string }) => OpenCodeAdoptedRun | null;

/**
 * Installed once by the composition root (`server/index.ts`), mirroring
 * `chatRunRegistry.setRetentionGuard`: this module cannot import the websocket
 * module (the gateway already depends on this one), so the adopter arrives as
 * a callback. Tests pass their own through `createOpenCodeRuntime`.
 */
let externalRunAdopter: OpenCodeExternalRunAdopter | null = null;

/** Installs (or clears, with null) the adopter used for engine-initiated runs. */
export function configureOpenCodeExternalRunAdoption(adopter: OpenCodeExternalRunAdopter | null): void {
  externalRunAdopter = adopter;
}

/**
 * Event types that can only occur inside a live execution.
 *
 * One of these for a session with no run of ours is proof the engine started
 * (or is continuing) an execution by itself — the service resumes an idle
 * session from its inbox the moment a background subagent completes, and
 * those events are the only announcement cloudcli gets. Lifecycle chatter
 * (`session.created`, `*.selected`, `instructions.updated`,
 * `session.inbox.enqueued`, …) is deliberately absent: it fires outside
 * executions too, and adopting one would pin a phantom "running" entry on an
 * idle session that never receives a terminal.
 */
const ADOPTABLE_EVENT_TYPES = new Set<string>([
  'session.execution.started',
  'session.inbox.delivered',
  'session.step.started',
  'session.step.streamed',
  'session.step.failed',
  'session.step.ended',
  'session.text.started',
  'session.text.delta',
  'session.text.ended',
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.tool.input.started',
  'session.tool.input.ended',
  'session.tool.called',
  'session.tool.success',
  'session.tool.failed',
  'session.compaction.started',
  'session.compaction.delta',
  'session.compaction.ended',
  'session.compaction.failed',
  'form.created',
  'permission.asked',
]);

type RuntimeDependencies = {
  supervisor?: Pick<OpenCodeServiceSupervisor, 'ensureEndpoint' | 'onExit' | 'currentEndpoint'>;
  createClient?: (endpoint: OpenCodeServiceEndpoint) => OpenCodeApiClient;
  /** Gateway adoption for engine-initiated executions; defaults to the installed adopter. */
  adoptExternalRun?: OpenCodeExternalRunAdopter;
  /** Grace period before an interrupt is assumed to have landed; default 5s. */
  abortSettleGraceMs?: number;
};

/**
 * Builds the runtime wired to the production supervisor and event stream.
 *
 * Consumers: `opencode.provider.ts` (module-level singleton via
 * `opencodeRuntime`) and the runtime tests (own supervisor + fake service).
 */
export function createOpenCodeRuntime(dependencies: RuntimeDependencies = {}): IProviderRuntime {
  const supervisor = dependencies.supervisor ?? new OpenCodeServiceSupervisor();
  const createClient = dependencies.createClient ?? ((endpoint) => new OpenCodeApiClient(endpoint));
  const abortSettleGraceMs = dependencies.abortSettleGraceMs ?? 5_000;

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

  const bridge = new OpenCodeInteractionBridge({ getClient: () => client });
  const runs = new OpenCodeRunRegistry({
    // The deadline re-check judges a tracked child by the same session row the
    // reconnect reconciliation reads for a run whose terminal was lost.
    readChildSnapshot: (childSessionId) => client?.getSession(childSessionId)
      ?? Promise.reject(new OpenCodeApiError('GET', '/api/session', 503, 'OpenCode service is not running')),
  });
  const settings = new OpenCodeSessionSettingsApplier();
  /** App sessions whose pending set is being re-read right now. */
  const reconcilingPending = new Set<string>();

  /**
   * Re-reads what the service still holds for a session's live runs and places
   * the cards the event feed never delivered.
   *
   * The feed is volatile by contract: a connection that drops loses the events
   * that happened while it was down, and a `form.created` or `permission.asked`
   * lost that way is invisible everywhere else — no later frame carries it, and
   * the model waits on an answer no card can collect. The service keeps those
   * pending sets in memory and its list routes read them back, so this is the
   * only way to recover one. Idempotent through the bridge's pending ids, so it
   * is safe to run after every reconnect and every session subscribe.
   *
   * Consumers: this runtime's permission facet (chat.subscribe) and its own
   * event-stream reconnect handler.
   */
  const reconcilePendingInteractions = async (appSessionId: string): Promise<void> => {
    const run = runs.get(appSessionId);
    const activeClient = client;
    if (!run || !activeClient || reconcilingPending.has(appSessionId)) {
      return;
    }
    reconcilingPending.add(appSessionId);
    try {
      // The run's own session plus the children still running: a question
      // asked inside a subagent is answered against the child session id but
      // surfaces as the parent's card. A task without an engine handle names
      // no session to ask.
      const sessionIds = [
        run.providerSessionId,
        ...runs.backgroundTasksFor(appSessionId)
          .map((task) => task.taskId)
          .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0),
      ];
      for (const providerSessionId of sessionIds) {
        let forms: unknown[];
        let permissions: unknown[];
        try {
          [forms, permissions] = await Promise.all([
            activeClient.listForms(providerSessionId),
            activeClient.listPermissionRequests(providerSessionId),
          ]);
        } catch (error) {
          // Best effort: the cards still in the bridge are unaffected, and the
          // next subscribe or reconnect tries again.
          console.warn(`[OpenCode] could not re-read pending interactions for ${providerSessionId}:`, error);
          continue;
        }
        if (forms.length > 0 || permissions.length > 0) {
          bridge.adoptPending(providerSessionId, { forms, permissions });
        }
      }
    } finally {
      reconcilingPending.delete(appSessionId);
    }
  };

  eventStream.subscribe((event) => {
    adoptExternalExecution(event);
    bridge.handleEvent(event);
    runs.dispatch(event);
  });
  eventStream.onReconnect(() => {
    void runs.reconcile({ getSession: (sessionId) => client?.getSession(sessionId)
      ?? Promise.reject(new OpenCodeApiError('GET', '/api/session', 503, 'OpenCode service is not running')) });
    // The gap swallowed more than the run terminals: any ask raised inside it
    // exists only in the service's pending set now.
    for (const run of runs.all()) {
      void reconcilePendingInteractions(run.appSessionId);
    }
  });
  supervisor.onExit(() => {
    settings.reset();
    runs.settleAll({ outcome: 'lost', error: 'The OpenCode service exited while the run was in progress.' });
  });

  /**
   * Publishes the authoritative end-of-run reading: the same reader the
   * `/token-usage` endpoint and history pages use, so the reload path and the
   * realtime path can never disagree — including the context window, which
   * the live step frames carry and must not be dropped by the final repaint.
   * A session whose database row cannot be read sends no frame; the
   * frontend's end-of-turn refresh covers it.
   */
  const sendFinalTokenBudget = (
    modelRef: { providerID: string; id: string } | null,
    appSessionId: string,
    providerSessionId: string,
    writer: ProviderRuntimeWriter,
  ): void => {
    try {
      const db = new Database(getOpenCodeDatabasePath(), { readonly: true, fileMustExist: true });
      try {
        const usage = readOpenCodeContextUsage(db, providerSessionId);
        // A session that just compacted has no occupancy to report yet. Its
        // `compacted` marker (plus the summary's size) still goes out: it is
        // what clears the composer's pre-compaction percentage.
        if (!usage || (usage.used <= 0 && usage.compacted !== true)) {
          return;
        }
        const tracker = new OpenCodeTokenBudgetTracker(modelRef?.providerID ?? null, modelRef?.id ?? null);
        tracker.emit(usage, writer, appSessionId);
      } finally {
        db.close();
      }
    } catch (error) {
      console.warn('[OpenCode] failed to read the token budget:', error);
    }
  };

  /**
   * One run's identifiers, as much as its failure path needs to address the
   * user with: the app session the frames belong to and the notifications.
   */
  type RunIdentity = {
    appSessionId: string;
    sessionSummary: string | undefined;
    userId: string | null;
  };

  const describeError = (error: unknown): string => (
    error instanceof OpenCodeServiceError || error instanceof OpenCodeApiError
      ? error.message
      : error instanceof Error ? error.message : String(error)
  );

  /**
   * Ends a run that never got going (or failed): one error frame, one failed
   * `complete`, a notification, and a rejection the gateway logs. Shared by
   * `run` and `compact` so both surfaces say failures the same way.
   */
  const failRun = (identity: RunIdentity, writer: ProviderRuntimeWriter, message: string): never => {
    writer.send(createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      sessionId: identity.appSessionId,
      provider: PROVIDER,
      kind: 'error',
      content: message,
      isError: true,
    }));
    writer.send(createCompleteMessage({ provider: PROVIDER, sessionId: identity.appSessionId, exitCode: 1 }));
    notifyRunFailed({
      userId: identity.userId,
      provider: PROVIDER,
      sessionId: identity.appSessionId,
      sessionName: identity.sessionSummary,
      error: message,
    });
    throw new Error(message);
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
    const identity: RunIdentity = { appSessionId, sessionSummary, userId };

    let endpoint: OpenCodeServiceEndpoint;
    try {
      endpoint = await supervisor.ensureEndpoint();
    } catch (error) {
      return failRun(identity, writer, describeError(error));
    }
    eventStream.start();
    const activeClient = createClient(endpoint);
    client = activeClient;

    let providerSessionId = context.resolveProviderSessionId(appSessionId);
    /** Model the run switched to, for the live budget frame's context window. */
    let budgetTrackerModel: { providerID: string; id: string } | null = null;
    try {
      if (!providerSessionId) {
        const created = await activeClient.createSession({ directory: workingDir, title: sessionSummary });
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
        const modelRef = parseOpenCodeModelRef(resolvedModel, effort);
        if (modelRef) {
          budgetTrackerModel = { providerID: modelRef.providerID, id: modelRef.id };
          await settings.applyModel(activeClient, providerSessionId, modelRef);
        } else {
          console.warn(`[OpenCode] cannot parse model reference "${resolvedModel}"; the session keeps its previous model`);
        }
      }
    } catch (error) {
      return failRun(identity, writer, describeError(error));
    }

    // `/compact` is not text for the model: the service compacts only through
    // its own endpoint, which runs as an execution of its own.
    const compactCommand = readCompactCommand(command);
    if (compactCommand?.instructions) {
      return failRun(identity, writer, 'OpenCode compacts without instructions. Send /compact on its own.');
    }
    const text = compactCommand ? '' : buildOpenCodePromptText(command, options);
    const files = compactCommand ? [] : await buildOpenCodePromptFiles(options, workingDir);
    if (!compactCommand && !text.trim() && files.length === 0) {
      return failRun(identity, writer, 'Nothing to send: the message is empty.');
    }

    // One tracker per run: the window comes from the model this run switched
    // to, and the throttle state must not leak across runs.
    const activeRun = runs.create(appSessionId, providerSessionId, writer);
    activeRun.budgetTracker = new OpenCodeTokenBudgetTracker(budgetTrackerModel?.providerID ?? null, budgetTrackerModel?.id ?? null);
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
        await activeClient.compactSession(providerSessionId);
      } else {
        await activeClient.prompt(providerSessionId, { text, files });
      }
      activeRun.promptAccepted = true;
    } catch (error) {
      runs.release(activeRun);
      bridge.cancelSession(appSessionId, 'The message was rejected by the OpenCode service.');
      bridge.detach(providerSessionId);
      return failRun(identity, writer, `OpenCode rejected the message: ${describeError(error)}`);
    }

    const settlement = await activeRun.settled;
    sendFinalTokenBudget(budgetTrackerModel, appSessionId, providerSessionId, writer);

    // The parent turn ends now (its `complete` must not wait on a subagent),
    // but the run's writer and the bridge stay attached while child sessions
    // still run: their frames, permission cards and the composer's background
    // pill all flow through this run until the last child settles.
    let failure: unknown = null;
    try {
      finishRun(identity, writer, settlement, activeRun.aborted);
    } catch (error) {
      failure = error;
    }
    if (runs.isBackgroundWorkPending(appSessionId)) {
      await runs.whenBackgroundWorkClears(appSessionId);
    }
    runs.release(activeRun);
    // Retract any cards still pending, then drop the run's writer from the
    // bridge so finished sessions do not pin memory forever.
    bridge.cancelSession(appSessionId, 'The run ended with cards still pending.');
    bridge.detach(providerSessionId);
    if (failure) {
      throw failure;
    }
  };

  /**
   * Ends a settled run: the abort hand-off, or exactly one terminal `complete`
   * plus the notification that outcome deserves. A failure is rethrown so the
   * gateway logs it and the caller sees a rejected promise.
   *
   * Shared by `run` and `compact` so both end the same way.
   */
  const finishRun = (
    identity: RunIdentity,
    writer: ProviderRuntimeWriter,
    settlement: OpenCodeRunSettlement,
    aborted: boolean,
  ): void => {
    if (aborted) {
      // The user stopped this run: the gateway's abort handler already
      // emitted the aborted complete, and a racing terminal event must not
      // paint a second, contradictory outcome over it.
      return;
    }
    const { appSessionId, sessionSummary, userId } = identity;
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

  /** The adopter for this instance: tests override it, production wires it at boot. */
  const resolveAdopter = (): OpenCodeExternalRunAdopter | null => (
    dependencies.adoptExternalRun ?? externalRunAdopter
  );

  /**
   * Adopts an execution the engine started on its own.
   *
   * Called for every event before the bridge and the run registry see it. When
   * the event proves a live execution (see `ADOPTABLE_EVENT_TYPES`) and the
   * session has no run of ours, the adopter opens a gateway run and the
   * execution becomes indistinguishable from a dispatched one: frames reach
   * the writer, the bridge attaches so permission/question cards surface and
   * replay, and the first `session.execution.*` terminal settles it. Events
   * for sessions with an active run, for sessions no app session maps to
   * (subagent and CLI-created conversations), or arriving after the run
   * already settled pass through untouched.
   */
  const adoptExternalExecution = (event: OpenCodeEventEnvelope): void => {
    if (!ADOPTABLE_EVENT_TYPES.has(event.type)) {
      return;
    }
    const providerSessionId = readOptionalString(readObjectRecord(event.data)?.sessionID);
    if (!providerSessionId || runs.get(providerSessionId)) {
      return;
    }
    const adopter = resolveAdopter();
    if (!adopter) {
      return;
    }

    let adopted: OpenCodeAdoptedRun | null;
    try {
      adopted = adopter({ providerSessionId });
    } catch (error) {
      console.warn('[OpenCode] external run adoption failed:', error);
      return;
    }
    if (!adopted) {
      return;
    }

    const run = runs.create(adopted.appSessionId, providerSessionId, adopted.writer);
    // The engine accepted this execution long before we saw it; the run is
    // only a bookkeeping shell, so reconciliation may judge it right away.
    run.promptAccepted = true;
    bridge.attach({
      appSessionId: adopted.appSessionId,
      providerSessionId,
      writer: adopted.writer,
      resolveToolCall: (callId) => run.translator.getToolCall(callId),
    });
    void settleAdoptedRun(run);
  };

  /**
   * Ends an adopted run exactly the way `run()` ends a dispatched one:
   * release the registry slot, retract cards still pending, detach the bridge,
   * publish the authoritative end-of-run occupancy reading, and emit the
   * terminal `complete` plus its outcome notification. There is no awaiting
   * caller, so a failing settlement is logged here instead of rethrown.
   */
  const settleAdoptedRun = async (run: OpenCodeActiveRun): Promise<void> => {
    const settlement = await run.settled;
    sendFinalTokenBudget(null, run.appSessionId, run.providerSessionId, run.writer);
    try {
      finishRun(
        { appSessionId: run.appSessionId, sessionSummary: undefined, userId: null },
        run.writer,
        settlement,
        run.aborted,
      );
    } catch (error) {
      // finishRun rethrows failures so the gateway logs them; here nobody is
      // awaiting the run, so this is the only place left to report them.
      console.warn('[OpenCode] adopted run ended in failure:', error);
    }
    // Same hold as a dispatched run: a resumed turn can itself launch a
    // background subagent, whose frames and cards need this writer/bridge.
    if (runs.isBackgroundWorkPending(run.appSessionId)) {
      await runs.whenBackgroundWorkClears(run.appSessionId);
    }
    runs.release(run);
    bridge.cancelSession(run.appSessionId, 'The run ended with cards still pending.');
    bridge.detach(run.providerSessionId);
  };

  /**
   * Compacts a session's carried conversation into a summary the next turn
   * builds on (`/compact`).
   *
   * The service admits the request as a synthetic `compaction` message
   * (`POST /api/session/:id/compact`, v2.0.32) and then runs the
   * summarization as a turn of its own, so the run rides the same plumbing as
   * `run` — registry entry, event translation, one terminal `complete` —
   * rather than treating the POST's acknowledgement as the outcome. The
   * engine summarizes with whatever model the session already runs with, so no
   * model switch, permission mode or prompt content is applied; the summary
   * itself reaches the transcript through the history refresh the terminal
   * `complete` triggers.
   */
  const compact = async (
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<void> => {
    const appSessionId = readOptionalString(options.sessionId);
    if (!appSessionId) {
      throw new Error('OpenCode runtime requires the app session id');
    }
    const sessionSummary = readOptionalString(options.sessionSummary);
    const userId = writer.userId === undefined || writer.userId === null ? null : String(writer.userId);
    const identity: RunIdentity = { appSessionId, sessionSummary, userId };

    const providerSessionId = context.resolveProviderSessionId(appSessionId);
    if (!providerSessionId) {
      return failRun(identity, writer, 'This OpenCode session has no stored conversation to compact yet.');
    }

    let endpoint: OpenCodeServiceEndpoint;
    try {
      endpoint = await supervisor.ensureEndpoint();
    } catch (error) {
      return failRun(identity, writer, describeError(error));
    }
    eventStream.start();
    const activeClient = createClient(endpoint);
    client = activeClient;

    const activeRun = runs.create(appSessionId, providerSessionId, writer, 'compact');

    // The feed must be live before the request: the compaction turn runs on
    // the service, and the events that report it (start, deltas, terminal)
    // would otherwise be missed for good.
    try {
      await eventStream.connected();
      await activeClient.compactSession(providerSessionId);
      activeRun.promptAccepted = true;
    } catch (error) {
      runs.release(activeRun);
      return failRun(identity, writer, `OpenCode refused to compact this session: ${describeError(error)}`);
    }

    const settlement = await activeRun.settled;
    runs.release(activeRun);

    // The reading after a compaction: the session row cannot report the new
    // occupancy yet (only the next turn can), which is exactly what the
    // `compacted` payload says — the composer then shows the summary size.
    sendFinalTokenBudget(null, appSessionId, providerSessionId, writer);
    finishRun(identity, writer, settlement, activeRun.aborted);
  };

  const abort = (sessionId: string): boolean => {
    const activeRun = runs.get(sessionId);
    if (!activeRun) {
      return false;
    }
    if (!activeRun.aborted) {
      activeRun.aborted = true;
      bridge.cancelSession(activeRun.appSessionId, 'The run was stopped.');
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

  return {
    run,
    abort,
    compact,
    permissions: {
      resolve(requestId: string, decision: ProviderPermissionDecision): void {
        bridge.resolve(requestId, decision);
      },
      listPending(sessionId: string): unknown[] {
        return bridge.listPending(sessionId);
      },
      reconcilePending(sessionId: string): void {
        void reconcilePendingInteractions(sessionId);
      },
    },
    backgroundTasks: {
      list(sessionId: string) {
        return runs.backgroundTasksFor(sessionId);
      },
      isPending(sessionId: string): boolean {
        return runs.isBackgroundWorkPending(sessionId);
      },
    },
    listBackgroundWork() {
      return runs.listBackgroundWork();
    },
    async stopBackgroundTask(_sessionId: string, taskId: string): Promise<boolean> {
      if (!client) {
        return false;
      }
      try {
        return await client.interrupt(taskId);
      } catch (error) {
        console.warn('[OpenCode] failed to stop background task:', error);
        return false;
      }
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
