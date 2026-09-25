/**
 * Codex conversation runtime
 * ==========================
 *
 * Runs one Codex turn over `codex app-server` and forwards what it reports to
 * the client.
 *
 * ## Why app-server and not `@openai/codex-sdk`
 *
 * The SDK wraps `codex exec`, whose JSON stream numbers items per process:
 * the first item of every turn is `item_0`, and a resumed thread starts the
 * count over. The rollout the same turn writes records Codex's real item ids
 * (`msg_…`, `rs_…`, `exec-<uuid>`), so the live frame and the row a later
 * history read returns had no id in common and the client rendered each reply
 * twice. `app-server` streams the same items *with those ids*, which is what
 * makes one row one row. It also reports the real turn id, streams assistant
 * text as it is written, and is the transport `thread/fork` already needed.
 *
 * ## Usage
 *
 * - codexRuntime.run(command, options, writer, context) — execute a streamed prompt
 * - codexRuntime.abort(sessionId) — cancel an active session
 */

import { randomUUID } from 'node:crypto';

import {
  codexAppServer,
  codexAppServerTransport,
  type CodexAppServerConnection,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import {
  codexThreadItemToRows,
  readCodexAppServerItem,
  readCodexCommandLine,
} from '@/modules/providers/list/codex/codex-thread-items.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  buildCodexInputItems,
  normalizeImageDescriptors,
  createCompleteMessage,
  createNormalizedMessage,
  resolveModelEffort,
} from '@/shared/index.js';
import type {
  AnyRecord,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/index.js';
import { readObjectRecord } from '@/shared/utils.js';

type ActiveCodexSession = {
  connection: CodexAppServerConnection;
  /** Set once the server reports the turn; `turn/interrupt` needs it. */
  threadId: string | null;
  turnId: string | null;
  status: 'running' | 'aborted' | 'completed';
  startedAt: string;
};

const activeCodexSessions = new Map<string, ActiveCodexSession>();

/**
 * One approval Codex is blocked on, waiting for a human.
 *
 * `app-server` asks for sandbox escalations as JSON-RPC *requests*, and the
 * turn stops until one is answered. The answer comes back over a different
 * connection entirely — the chat gateway's `chat.permission-response` — so the
 * two are joined here by the request id the `permission_request` frame
 * carried. Keyed module-wide because `permissions.resolve` is called from
 * outside any run.
 */
type PendingCodexApproval = {
  /** Answers the JSON-RPC request Codex is waiting on. */
  settle: (decision: ProviderPermissionDecision | null) => void;
  /** App session id, for `listPending`. */
  sessionId: string | null;
  toolName: string;
  toolId: string;
  input: unknown;
  receivedAt: Date;
};

const pendingCodexApprovals = new Map<string, PendingCodexApproval>();

/**
 * Item types whose in-flight state is worth showing before they finish.
 *
 * These are the ones a user waits on — a shell command, an MCP call, a patch
 * being applied, a spawned agent. Everything else either starts empty (text,
 * reasoning) or is already complete when announced.
 */
const PROGRESSIVE_CODEX_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'collabAgentToolCall',
]);

/** Default context window reported when the server has not said otherwise. */
const DEFAULT_CODEX_CONTEXT_WINDOW = 200000;

/**
 * Maps a permission mode onto the two knobs `thread/start` takes.
 *
 * Unchanged from the `codex exec` mapping this replaced, so a mode decides
 * exactly what it decided before — except that `on-request` now means what it
 * says: the escalation reaches the user's approval card instead of dying in a
 * transport with nobody to ask.
 *
 * Who reviews an approval is deliberately not set here: Codex's own
 * `approvals_reviewer` config decides whether a request is auto-reviewed
 * before it ever reaches a client, and overriding that would quietly undo a
 * setting the user made.
 */
function mapPermissionModeToCodexOptions(permissionMode: string): { sandbox: string; approvalPolicy: string } {
  switch (permissionMode) {
    case 'acceptEdits':
      return { sandbox: 'workspace-write', approvalPolicy: 'never' };
    case 'bypassPermissions':
      return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
    case 'default':
    default:
      // Codex 0.153 removed `untrusted`; `on-request` keeps a live approval
      // gate in front of sandbox escalations.
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
  }
}

/**
 * The server-to-client requests that are an approval the user can answer.
 *
 * Anything else app-server may ask for (MCP elicitations, tool-side user
 * input) is answered as unimplemented rather than guessed at.
 */
const CODEX_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

/**
 * Builds the reply one approval request expects.
 *
 * The command and file-change requests share a four-value decision; the
 * permission request instead answers with the profile it is granted, so
 * refusing it means granting nothing.
 *
 * A null decision is a request nobody answered — a timeout, or the run ending
 * underneath it — and is refused, never approved.
 */
function toCodexApprovalResponse(
  method: string,
  params: AnyRecord,
  decision: ProviderPermissionDecision | null,
): AnyRecord {
  if (method === 'item/permissions/requestApproval') {
    const requested = readObjectRecord(params.permissions) ?? {};
    return decision?.allow
      ? {
        permissions: {
          ...(requested.network ? { network: requested.network } : {}),
          ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
        },
        scope: decision.rememberEntry ? 'session' : 'turn',
      }
      : { permissions: {}, scope: 'turn' };
  }

  if (!decision?.allow) {
    return { decision: 'decline' };
  }
  // "Remember this" is a session-scoped approval on Codex's side.
  return { decision: decision.rememberEntry ? 'acceptForSession' : 'accept' };
}

/** Turns the shared input items into the `UserInput` shape app-server accepts. */
function toAppServerInput(items: Array<AnyRecord>): AnyRecord[] {
  return items.map((item) => {
    if (item.type === 'local_image') {
      return { type: 'localImage', path: item.path };
    }
    return { type: 'text', text: String(item.text ?? ''), text_elements: [] };
  });
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the context budget out of a `thread/tokenUsage/updated` notification. */
function readCodexTokenBudget(params: AnyRecord) {
  const usage = readObjectRecord(params.tokenUsage);
  const total = readObjectRecord(usage?.total);
  if (!total) {
    return null;
  }

  const inputTokens = Number(total.inputTokens) || 0;
  const outputTokens = Number(total.outputTokens) || 0;
  return {
    used: Number(total.totalTokens) || inputTokens + outputTokens,
    total: Number(usage?.modelContextWindow) || DEFAULT_CODEX_CONTEXT_WINDOW,
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

/**
 * Sends one runtime message through the run's writer.
 *
 * `ProviderRuntimeWriter.send` already owns payload stringification, so — like
 * every other provider runtime — the adapter passes the object straight
 * through.
 */
function sendMessage(ws: ProviderRuntimeWriter, data: unknown) {
  try {
    ws.send(data);
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

/**
 * Executes one Codex turn and streams it to the client.
 */
async function queryCodex(
  command: string,
  options: AnyRecord = {},
  ws: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
) {
  const {
    sessionId,
    sessionSummary,
    cwd,
    projectPath,
    model,
    effort,
    images,
    files,
    permissionMode = 'default',
  } = options;
  const appSessionId = typeof sessionId === 'string' ? sessionId : null;
  // The websocket session id may be numeric; the notification helpers take a
  // string user id, so normalize once here (mirrors antigravity-runtime).
  const normalizedUserId = ws?.userId != null ? String(ws.userId) : null;

  // Callers pass the stable app session id; the thread is resumed with the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  const resolvedModel = await context.resolveResumeModel(sessionId, model);
  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandbox, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  const catalog = await context.getProviderModels();
  const resolvedEffort = resolveModelEffort(resolvedModel, effort, catalog);

  let capturedSessionId: string | null = providerSessionId ?? null;
  let sessionCreatedSent = false;
  let terminalFailure: { message: string } | null = null;
  let errorSurfaced = false;
  let connection: CodexAppServerConnection | null = null;

  /** Session-map key: the app session id, else the thread id once captured. */
  const sessionKey = () => sessionId || capturedSessionId || null;
  const currentSession = () => activeCodexSessions.get(sessionKey() || '');

  /** Resolves once the turn reaches a terminal state, or the child dies. */
  let settleTurn: (() => void) | null = null;
  const turnSettled = new Promise<void>((resolve) => {
    settleTurn = () => {
      settleTurn = null;
      resolve();
    };
  });
  const settle = () => settleTurn?.();

  /**
   * The tool row each item produced, by item id.
   *
   * An approval request names only the item it is about, so this is what lets
   * the prompt say *which* command or edit is waiting — Codex announces the
   * item before it asks.
   */
  const approvalSubjects = new Map<string, { toolName: string; input: unknown }>();

  const emitItem = (rawItem: unknown, timestamp: string): void => {
    const item = readCodexAppServerItem(rawItem);
    if (!item) {
      return;
    }
    for (const row of codexThreadItemToRows(item, timestamp)) {
      if (row.type === 'tool_use' && !approvalSubjects.has(item.id)) {
        approvalSubjects.set(item.id, { toolName: String(row.toolName), input: row.toolInput });
      }
      for (const message of context.normalizeMessage(row, capturedSessionId || sessionId || null)) {
        sendMessage(ws, message);
      }
    }
  };

  /** Approvals this run opened, so the run's end can retract them. */
  const openApprovalIds = new Set<string>();

  /**
   * Puts one approval in front of the user and waits for the answer.
   *
   * Codex is blocked on the JSON-RPC request until this resolves, so the wait
   * is unbounded on purpose: a prompt that times out on its own would deny an
   * action the user was still reading.
   */
  const requestApproval = (method: string, params: AnyRecord): Promise<ProviderPermissionDecision | null> => {
    const itemId = readNonEmptyString(params.itemId) ?? randomUUID();
    const requestId = randomUUID();
    // A command approval is asked *before* the item is announced and carries
    // the command itself; everything else is asked about an item the user has
    // already seen announced, so the card is rebuilt from that row.
    const command = readNonEmptyString(params.command);
    const subject = command
      ? { toolName: 'Bash', input: JSON.stringify({ command: readCodexCommandLine(command) }) }
      : approvalSubjects.get(itemId);
    const reason = readNonEmptyString(params.reason);

    return new Promise<ProviderPermissionDecision | null>((resolve) => {
      let settled = false;
      const settleOnce = (decision: ProviderPermissionDecision | null) => {
        if (settled) {
          return;
        }
        settled = true;
        pendingCodexApprovals.delete(requestId);
        openApprovalIds.delete(requestId);
        resolve(decision);
      };

      pendingCodexApprovals.set(requestId, {
        settle: settleOnce,
        sessionId: appSessionId || capturedSessionId || null,
        toolName: subject?.toolName ?? 'Codex',
        toolId: itemId,
        input: subject?.input,
        receivedAt: new Date(),
      });
      openApprovalIds.add(requestId);

      sendMessage(ws, createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName: subject?.toolName ?? 'Codex',
        toolId: itemId,
        input: subject?.input,
        context: {
          // What Codex is asking for beyond running the tool: network access,
          // a write outside the workspace, and so on.
          reason: reason ?? (method === 'item/fileChange/requestApproval'
            ? 'Codex wants to write outside its sandbox.'
            : 'Codex wants to step outside its sandbox.'),
        },
        canInterrupt: true,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
      }));
    }).then((decision) => {
      // Every attached tab drops the prompt, including one that reconnects
      // mid-run and replays the request frame.
      sendMessage(ws, createNormalizedMessage({
        kind: 'permission_resolved',
        requestId,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
      }));
      return decision;
    });
  };

  /** Retracts anything still waiting, so a finished run leaves no live prompt. */
  const cancelOpenApprovals = (reason: string): void => {
    for (const requestId of [...openApprovalIds]) {
      sendMessage(ws, createNormalizedMessage({
        kind: 'permission_cancelled',
        requestId,
        reason,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
      }));
      pendingCodexApprovals.get(requestId)?.settle(null);
    }
  };

  try {
    connection = await codexAppServerTransport.open({
      onExit: (reason) => {
        if (currentSession()?.status !== 'aborted' && !terminalFailure) {
          terminalFailure = { message: reason };
        }
        settle();
      },
      onRequest: async (method, params) => {
        if (!CODEX_APPROVAL_METHODS.has(method)) {
          return undefined;
        }
        const decision = await requestApproval(method, params);
        return toCodexApprovalResponse(method, params, decision);
      },
      onNotification: (method, params) => {
        const session = currentSession();
        if (session?.status === 'aborted') {
          return;
        }

        switch (method) {
          case 'turn/started': {
            const turn = readObjectRecord(params.turn);
            const turnId = typeof turn?.id === 'string' ? turn.id : null;
            const active = currentSession();
            if (active) {
              active.turnId = turnId;
            }
            return;
          }

          case 'item/started': {
            // Only work the user waits on is worth showing before it
            // finishes. Text and reasoning items start empty — their content
            // arrives as deltas — and a user message announced twice would be
            // appended twice, because a transcript row is appended on arrival
            // and only reconciled against *history* by id.
            const startedType = readObjectRecord(params.item)?.type;
            if (typeof startedType === 'string' && PROGRESSIVE_CODEX_ITEM_TYPES.has(startedType)) {
              emitItem(params.item, new Date().toISOString());
            }
            return;
          }

          case 'item/completed':
            emitItem(params.item, new Date().toISOString());
            return;

          case 'item/agentMessage/delta': {
            // Streamed prose has its own protocol frame: the client grows one
            // placeholder from the fragments and the completed item's row
            // then takes its place. Re-sending the whole text as a `text` row
            // per delta instead appends one row per fragment.
            if (typeof params.delta === 'string' && params.delta) {
              sendMessage(ws, createNormalizedMessage({
                kind: 'stream_delta',
                role: 'assistant',
                content: params.delta,
                sessionId: capturedSessionId || sessionId || null,
                provider: 'codex',
              }));
            }
            return;
          }

          case 'thread/tokenUsage/updated': {
            const tokenBudget = readCodexTokenBudget(params);
            if (tokenBudget) {
              sendMessage(ws, createNormalizedMessage({
                kind: 'status',
                text: 'token_budget',
                tokenBudget,
                sessionId: capturedSessionId || sessionId || null,
                provider: 'codex',
              }));
            }
            return;
          }

          case 'error': {
            errorSurfaced = true;
            const message = typeof params.message === 'string' ? params.message : 'Codex reported an error.';
            terminalFailure = terminalFailure ?? { message };
            sendMessage(ws, createNormalizedMessage({
              kind: 'error',
              content: message,
              sessionId: capturedSessionId || sessionId || null,
              provider: 'codex',
            }));
            return;
          }

          case 'turn/completed': {
            const turn = readObjectRecord(params.turn);
            if (turn?.status === 'failed') {
              const error = readObjectRecord(turn.error);
              const message = typeof error?.message === 'string' ? error.message : 'Turn failed';
              terminalFailure = { message };
              errorSurfaced = true;
              sendMessage(ws, createNormalizedMessage({
                kind: 'error',
                content: message,
                sessionId: capturedSessionId || sessionId || null,
                provider: 'codex',
              }));
              notifyRunFailed({
                userId: normalizedUserId,
                provider: 'codex',
                sessionId: appSessionId || capturedSessionId || null,
                sessionName: sessionSummary,
                error: terminalFailure,
              });
            }
            if (turn?.status === 'interrupted' && currentSession()?.status !== 'aborted') {
              // Codex ends a usage-limit or shutdown interrupt here rather than
              // at `failed`. Treating the status as a normal completion sent the
              // client a clean `complete` while the rollout recorded
              // `turn_aborted`, so the abort was invisible until history re-read
              // it and diagnostics logged the run as a success. A stop the user
              // asked for (`abort` already flagged the session) arrives as the
              // same status and must stay silent.
              const message = 'Codex interrupted this turn before it finished. This usually means the account hit a usage limit.';
              terminalFailure = terminalFailure ?? { message };
              errorSurfaced = true;
              sendMessage(ws, createNormalizedMessage({
                kind: 'error',
                content: message,
                sessionId: capturedSessionId || sessionId || null,
                provider: 'codex',
              }));
              notifyRunFailed({
                userId: normalizedUserId,
                provider: 'codex',
                sessionId: appSessionId || capturedSessionId || null,
                sessionName: sessionSummary,
                error: terminalFailure,
              });
            }
            settle();
            return;
          }

          default:
            return;
        }
      },
    });

    const registerSession = (id: string | null) => {
      if (!id || !connection) {
        return;
      }
      activeCodexSessions.set(id, {
        connection,
        threadId: capturedSessionId,
        turnId: null,
        status: 'running',
        startedAt: new Date().toISOString(),
      });
    };

    if (sessionKey()) {
      registerSession(sessionKey());
    }

    // `config` carries the settings the protocol has no field of its own for.
    const threadSettings: AnyRecord = {
      cwd: workingDirectory,
      sandbox,
      approvalPolicy,
      ...(resolvedModel ? { model: resolvedModel } : {}),
    };
    const thread = readObjectRecord(providerSessionId
      ? await connection.call('thread/resume', {
        threadId: providerSessionId,
        excludeTurns: true,
        ...threadSettings,
      })
      : await connection.call('thread/start', threadSettings));

    const threadRecord = readObjectRecord(thread?.thread);
    const discoveredSessionId = typeof threadRecord?.id === 'string' ? threadRecord.id : null;
    if (discoveredSessionId) {
      const isNewThread = !capturedSessionId;
      capturedSessionId = discoveredSessionId;
      const existing = currentSession();
      if (existing) {
        existing.threadId = capturedSessionId;
      } else {
        registerSession(sessionKey());
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }
      if (isNewThread && !sessionCreatedSent) {
        sessionCreatedSent = true;
        sendMessage(ws, createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'codex',
        }));
      }
    }

    // Turns with image attachments send structured input items so Codex reads
    // the images from their local asset paths.
    const promptWithFiles = appendFilesInputTag(command, files);
    const inputItems = normalizeImageDescriptors(images).length > 0
      ? buildCodexInputItems(promptWithFiles, images, workingDirectory)
      : [{ type: 'text', text: promptWithFiles }];

    if (!capturedSessionId) {
      throw new Error('Codex app-server opened no thread to run the turn in.');
    }

    await connection.call('turn/start', {
      threadId: capturedSessionId,
      input: toAppServerInput(inputItems as AnyRecord[]),
      ...(resolvedEffort ? { effort: resolvedEffort } : {}),
    });

    await turnSettled;

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runAborted = currentSession()?.status === 'aborted';
    if (!runAborted) {
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        actualSessionId: capturedSessionId || sessionId || null,
        exitCode: terminalFailure ? 1 : 0,
      }));
      if (!terminalFailure) {
        notifyRunStopped({
          userId: normalizedUserId,
          provider: 'codex',
          sessionId: appSessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
      }
    }

  } catch (error) {
    const runError = error instanceof Error ? error : new Error(String(error));
    const wasAborted =
      currentSession()?.status === 'aborted' ||
      runError.name === 'AbortError' ||
      runError.message.toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      if (!errorSurfaced) {
        const installed = await context.isProviderInstalled();
        const errorContent = !installed
          ? 'Codex CLI is not configured. Please set up authentication first.'
          : runError.message;

        sendMessage(ws, createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'codex',
        }));
      }
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        exitCode: 1,
      }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: normalizedUserId,
          provider: 'codex',
          sessionId: appSessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          error,
        });
      }
    }

  } finally {
    cancelOpenApprovals('The run ended before this was answered.');
    connection?.close();
    const session = currentSession();
    if (session) {
      session.status = session.status === 'aborted' ? 'aborted' : 'completed';
    }
  }
}

/**
 * Cancels an active Codex session.
 *
 * `turn/interrupt` is the graceful stop — it lets the server close the turn
 * out in the rollout — and the connection is closed behind it so a server
 * that ignores the interrupt cannot keep the run alive.
 */
function abortCodexSession(sessionId: string) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  console.log(
    `[Codex] Aborting session ${sessionId} (thread ${session.threadId ?? 'unknown'}, `
    + `turn ${session.turnId ?? 'none'}) — started ${session.startedAt}`,
  );
  if (session.threadId && session.turnId) {
    session.connection
      .call('turn/interrupt', { threadId: session.threadId, turnId: session.turnId })
      .catch((error: unknown) => {
        console.warn(`[Codex] Interrupt for session ${sessionId} was not accepted:`, error);
      });
  }
  // The connection is torn down on the next tick so the interrupt has a
  // chance to leave the process before its pipes close.
  setTimeout(() => session.connection.close(), 250).unref?.();

  return true;
}

/**
 * Compacts a Codex thread's carried conversation into a summary.
 *
 * `thread/compact/start` is the app-server primitive the Codex IDE clients
 * use. Only a stored thread has something to compact; the run's synthetic
 * terminal `complete` is what makes the UI refresh the transcript and show
 * the summary.
 */
async function compactCodexSession(
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<unknown> {
  const appSessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
  const providerSessionId = context.resolveProviderSessionId(appSessionId);
  if (!providerSessionId) {
    throw new Error('This Codex session has no stored conversation to compact yet.');
  }

  sendMessage(writer, createNormalizedMessage({
    kind: 'status',
    text: 'Compacting context…',
    sessionId: appSessionId,
    provider: 'codex',
  }));

  await codexAppServer.compactThread({ threadId: providerSessionId });
  return undefined;
}

/**
 * Used by the providers module's CodexProvider to run, abort, and compact
 * turns, and to answer the approvals a run is blocked on.
 *
 * Declaring `permissions` is also what turns `supportsPermissionRequests` on
 * for Codex in the capability catalog.
 */
export const codexRuntime = {
  run: queryCodex,
  abort: abortCodexSession,
  compact: compactCodexSession,
  permissions: {
    /**
     * Answers one approval. The gateway fans a decision out to every
     * provider, so an id this runtime never issued is simply not ours.
     */
    resolve(requestId: string, decision: ProviderPermissionDecision): void {
      pendingCodexApprovals.get(requestId)?.settle(decision);
    },

    /** The approvals this provider is waiting on for one session. */
    listPending(sessionId: string): unknown[] {
      const pending: unknown[] = [];
      for (const [requestId, approval] of pendingCodexApprovals.entries()) {
        if (approval.sessionId === sessionId) {
          pending.push({
            requestId,
            toolName: approval.toolName,
            toolId: approval.toolId,
            input: approval.input,
            receivedAt: approval.receivedAt,
            provider: 'codex',
          });
        }
      }
      return pending;
    },
  },
};

/** Kept so `thread/fork` stays reachable through this module's usual import site. */
export { codexAppServer };

// Clean up old completed sessions periodically
const completedSessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

// Runtime cleanup should not keep focused tests or one-off scripts alive after
// their provider work has completed.
completedSessionCleanupTimer.unref?.();
