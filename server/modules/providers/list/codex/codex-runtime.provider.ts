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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  codexAppServer,
  codexAppServerTransport,
  type CodexAppServerConnection,
} from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CODEX_BACKGROUND_TASK_TYPE, codexBackgroundWork } from '@/modules/providers/list/codex/codex-background-work.js';
import {
  acquireCodexResidentSession,
  closeCodexResidentSessionAdmission,
  completeCodexResidentRound,
  isCodexResidentSessionAdmissionClosed,
  isCodexResidentSessionBusy,
  listCodexReportingOnlySessions,
  readCodexResidentSessionActivity,
  openCodexResidentSessionAdmission,
  releaseCodexResidentSession,
  releaseCodexResidentSessionResources,
  stopCodexResidentRound,
  submitCodexResidentRound,
  type CodexResidentSession,
} from '@/modules/providers/list/codex/codex-session-manager.js';
import {
  buildCodexSubagentAgentRow,
  codexThreadItemToRows,
  readCodexAppServerItem,
  readCodexCommandLine,
  readCodexSubagentLabel,
  type CodexThreadItem,
} from '@/modules/providers/list/codex/codex-thread-items.js';
import {
  codexTurnFailureRowId,
  readCodexFailureMessage,
  readCodexReportedTurnId,
} from '@/modules/providers/list/codex/codex-turn-error.js';
import { createBackgroundTasksStatusMessage, createTaskStatusMessage } from '@/modules/providers/shared/background-work/task-status.js';
import { codexSessionTitleService } from '@/modules/providers/services/codex-session-title.service.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  buildCodexInputItems,
  normalizeImageDescriptors,
  createCompleteMessage,
  createNormalizedMessage,
  resolveCodexExecutionPolicy,
  resolveModelEffort,
  readCompactCommand,
  AppError,
  readObjectRecord,
  CODEX_TASK_MCP_NAME,
  CODEX_HOST_CREDENTIAL_ENV_NAMES,
} from '@/shared/index.js';
import type {
  AnyRecord,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/index.js';
import type { BackgroundTaskSummary, NormalizedMessage, SessionBackgroundWork } from '@/shared/types.js';

const TASK_MCP_NAME = CODEX_TASK_MCP_NAME;
const TASK_API_URL_ENV = 'CLOUDCLI_TASK_API_URL';
const TASK_API_KEY_ENV = 'CLOUDCLI_TASK_API_KEY';
const TASK_RUN_CONTEXT_ENV = 'CLOUDCLI_TASK_RUN_CONTEXT';
const TASK_BRIDGE_ENV = 'CLOUDCLI_TASK_BRIDGE';

function getTaskMcpCommand(): { command: string; args: string[] } {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const compiledEntrypoint = path.resolve(moduleDirectory, '../../../task-continuations/cli/task-continuations-mcp.js');
  if (existsSync(compiledEntrypoint)) {
    return { command: process.execPath, args: [compiledEntrypoint] };
  }

  const repositoryRoot = path.resolve(moduleDirectory, '../../../../../');
  const sourceEntrypoint = path.join(repositoryRoot, 'server', 'modules', 'task-continuations', 'cli', 'task-continuations-mcp.ts');
  return {
    command: path.join(repositoryRoot, 'node_modules', '.bin', 'tsx'),
    args: ['--tsconfig', path.join(repositoryRoot, 'server', 'tsconfig.json'), sourceEntrypoint],
  };
}

/**
 * The task MCP server's configuration and environment.
 *
 * A short-lived process carries the round's own capability and the global API
 * key. A resident process cannot: it outlives the round that started it, so
 * it carries a narrow bridge credential instead, and the host matches every
 * call against the engine call it observed.
 */
function getTaskMcpRuntimeOptions(input: {
  token?: string;
  bridgeToken?: string;
}): { config: Record<string, unknown>; env: NodeJS.ProcessEnv } {
  const apiUrl = process.env.CLOUDCLI_API_URL
    || `http://127.0.0.1:${process.env.SERVER_PORT || process.env.PORT || '3001'}`;
  const env: NodeJS.ProcessEnv = { [TASK_API_URL_ENV]: apiUrl.replace(/\/$/, '') };
  const envVars = [TASK_API_URL_ENV];
  if (input.bridgeToken) {
    env[TASK_BRIDGE_ENV] = input.bridgeToken;
    envVars.push(TASK_BRIDGE_ENV);
  } else {
    env[TASK_API_KEY_ENV] = process.env.API_KEY ?? '';
    env[TASK_RUN_CONTEXT_ENV] = input.token ?? '';
    envVars.push(TASK_API_KEY_ENV, TASK_RUN_CONTEXT_ENV);
  }
  return {
    config: {
      [`mcp_servers.${TASK_MCP_NAME}`]: {
        ...getTaskMcpCommand(),
        env_vars: envVars,
      },
    },
    env,
  };
}

async function readEffectiveShellEnvironmentExcludes(
  connection: CodexAppServerConnection,
  cwd: string,
): Promise<string[]> {
  const response = readObjectRecord(await connection.call('config/read', { includeLayers: false, cwd }));
  const config = readObjectRecord(response?.config);
  const policy = readObjectRecord(config?.shell_environment_policy);
  return Array.isArray(policy?.exclude)
    ? policy.exclude.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

type ActiveCodexSession = {
  /**
   * Ends the round: it interrupts a turn that already runs, or removes the
   * input that is still waiting in the engine's queue.
   */
  /** Ends the round. Resolves once the engine confirmed what it did. */
  stop: () => Promise<unknown>;
  /** Set once the server reports the turn; `turn/interrupt` needs it. */
  threadId: string | null;
  turnId: string | null;
  status: 'running' | 'aborted' | 'completed';
  startedAt: string;
};

const activeCodexSessions = new Map<string, ActiveCodexSession>();

/**
 * Whether a Codex conversation keeps its process alive between rounds.
 *
 * The resident path is what lets the engine report in the background while
 * the next message waits for its own turn, so it is off until the whole
 * delivery — background reports, task credentials, reclaim — is accepted.
 */
const isResidentSessionsEnabled = (): boolean => process.env.CLOUDCLI_CODEX_RESIDENT !== '0';

const DETACHED_COMMAND_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'USER', 'LOGNAME', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
] as const;
const TASK_CREDENTIAL_ENV_NAMES = CODEX_HOST_CREDENTIAL_ENV_NAMES;
const DETACHED_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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
  'contextCompaction',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'collabAgentToolCall',
]);

/** Default context window reported when the server has not said otherwise. */
const DEFAULT_CODEX_CONTEXT_WINDOW = 200000;

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
const TASK_MCP_ELICITATION_METHOD = 'mcpServer/elicitation/request';

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

function resolveCodexTerminalStatus(
  status: 'completed' | 'failed' | 'interrupted' | 'unknown',
  hasTerminalFailure: boolean,
): 'completed' | 'failed' | 'interrupted' | 'unknown' {
  return hasTerminalFailure && status === 'completed' ? 'failed' : status;
}

/** Reads the context budget out of a `thread/tokenUsage/updated` notification. */
function readCodexTokenBudget(params: AnyRecord) {
  const usage = readObjectRecord(params.tokenUsage);
  // `last` is the turn that just ran — what the context window holds.
  // `total` is the session's cumulative spend; using it as `used` made the
  // live percentage climb every turn until a reload re-read the rollout.
  const last = readObjectRecord(usage?.last);
  const cumulative = readObjectRecord(usage?.total);
  const current = last ?? cumulative;
  if (!current) {
    return null;
  }

  const inputTokens = Number(current.inputTokens) || 0;
  const outputTokens = Number(current.outputTokens) || 0;
  const cumulativeInputTokens = Number(cumulative?.inputTokens) || 0;
  const cumulativeOutputTokens = Number(cumulative?.outputTokens) || 0;
  return {
    used: Number(current.totalTokens) || inputTokens + outputTokens,
    total: Number(usage?.modelContextWindow) || DEFAULT_CODEX_CONTEXT_WINDOW,
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
    ...(cumulative
      ? {
          cumulative: {
            used: Number(cumulative.totalTokens) || cumulativeInputTokens + cumulativeOutputTokens,
            inputTokens: cumulativeInputTokens,
            outputTokens: cumulativeOutputTokens,
          },
        }
      : {}),
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
 * Where one set of Codex events goes.
 *
 * A foreground round delivers through the run's writer, so the gateway stamps
 * the run's sequence numbers and ends the run on its terminal event. A turn
 * the engine started by itself delivers through the session's publish entry:
 * that event belongs to the session, and it must not end a round nobody
 * started.
 */
type CodexEventTarget = {
  /** The app session the events belong to. */
  appSessionId: string | null;
  /** The native thread the conversation runs in. */
  threadId: () => string | null;
  /** Normalizes one provider row into the app's rows. */
  normalize: (raw: unknown, sessionId: string | null) => NormalizedMessage[];
  /** Delivers one row to the client. */
  deliver: (message: NormalizedMessage) => void;
  /** The tool each announced item needs, so an approval card can name it. */
  approvalSubjects: Map<string, { toolName: string; input: unknown }>;
  /**
   * Records one MCP tool call the engine made.
   *
   * A resident process outlives the round that started it, so the host takes
   * the authority for a call from the engine call it observed rather than
   * from a secret the process carries.
   */
  registerToolCall?: (call: { callId: string; server: string; tool: string; arguments: Record<string, unknown> }) => void;
};

/** One `task_status` frame for a collab agent, folded by the client onto the card of `toolUseId`. */
function codexTaskStatus(
  messageSessionId: string | null,
  taskId: string,
  toolUseId: string,
  fields: Parameters<typeof createTaskStatusMessage>[1],
) {
  return createTaskStatusMessage(
    { provider: 'codex', sessionId: messageSessionId, taskId, toolUseId, taskType: CODEX_BACKGROUND_TASK_TYPE },
    fields,
  );
}

/**
 * Re-sends the composer strip's list for a session; called after every change
 * to the agents tracked under `backgroundWorkKey`. The turn is in flight for
 * as long as an agent is tracked, so the work is always stoppable through the
 * turn.
 */
function broadcastCodexBackgroundTasks(target: CodexEventTarget, backgroundWorkKey: string): void {
  target.deliver(createBackgroundTasksStatusMessage(
    { provider: 'codex', sessionId: target.threadId() || target.appSessionId || null },
    codexBackgroundWork.listStripTasks(backgroundWorkKey),
    true,
  ));
}

/**
 * Draws and settles the Agent card of an agent announced only through its
 * activity record (the shape real engines use; see
 * `buildCodexSubagentAgentRow`). `started` opens the card, marks it running
 * and tracks the agent as background work under its thread id; `completed`
 * and `interrupted` settle the card they started — found through that
 * thread id, since the item id differs between the two — and retire the
 * entry. An end with no tracked start (the server restarted while the
 * agent ran) has no card to settle and is dropped. `interacted` is the
 * agents talking among themselves and draws nothing.
 */
function emitCodexSubagentActivity(
  target: CodexEventTarget,
  item: Extract<CodexThreadItem, { kind: 'subagent_activity' }>,
  timestamp: string,
  backgroundWorkKey: string | null | undefined,
): void {
  const messageSessionId = target.threadId() || target.appSessionId || null;
  if (item.activity === 'started') {
    const taskId = item.agentThreadId ?? item.id;
    if (backgroundWorkKey && codexBackgroundWork.get(backgroundWorkKey, taskId)) {
      return;
    }
    for (const message of target.normalize(buildCodexSubagentAgentRow(item, timestamp), messageSessionId)) {
      target.deliver(message);
    }
    const description = readCodexSubagentLabel(item);
    if (backgroundWorkKey) {
      codexBackgroundWork.start(backgroundWorkKey, {
        taskId,
        toolUseId: item.id,
        taskType: CODEX_BACKGROUND_TASK_TYPE,
        description,
      });
      broadcastCodexBackgroundTasks(target, backgroundWorkKey);
    }
    target.deliver(codexTaskStatus(messageSessionId, taskId, item.id, { event: 'started', description }));
    // An agent that fails at once (the usage limit, say) can end its turn
    // before the parent records the spawn.
    const ended = codexAgentTurns.get(taskId)?.ended;
    if (backgroundWorkKey && ended?.sessionKey === backgroundWorkKey) {
      settleCodexAgentTurn(target, backgroundWorkKey, taskId, ended);
    }
    return;
  }

  if (item.activity !== 'completed' && item.activity !== 'interrupted') {
    return;
  }
  const tracked = backgroundWorkKey && item.agentThreadId
    ? codexBackgroundWork.end(backgroundWorkKey, item.agentThreadId)
    : undefined;
  if (!backgroundWorkKey || !tracked) {
    return;
  }
  retireCodexAgent(backgroundWorkKey, tracked);
  broadcastCodexBackgroundTasks(target, backgroundWorkKey);
  target.deliver(codexTaskStatus(messageSessionId, tracked.taskId, tracked.toolUseId, {
    event: 'notification',
    status: item.activity === 'completed' ? 'completed' : 'stopped',
  }));
}

/** How an agent's last turn ended, as its card shows it. */
type CodexAgentTurnEnd = { status: 'completed' | 'failed' | 'stopped'; summary?: string };

/**
 * What each agent thread's own turns last did, keyed by agent thread id.
 *
 * An agent works in turns on its own thread, and the parent can wake it for
 * another turn after the last one ended. `ended` is the outcome of the
 * agent's last turn, cleared when its next turn starts; `retired` is the card
 * of an agent that is idle, kept so a woken agent runs on the card it was
 * spawned with. The parent's spawn record often arrives after the agent's
 * own turn already ended (a resident session holds the parent's events until
 * it knows their round, and an agent's events go out at once), so a spawn
 * record that finds `ended` settles the card at once. When the parent records
 * a wake before the agent's turn starts, the card settles and runs again at
 * the turn's start. One slot per thread is enough: an agent thread belongs
 * to the parent thread that spawned it, and so to one conversation. Bounded,
 * because nothing reports that an agent is gone for good.
 */
const codexAgentTurns = new Map<string, {
  ended?: CodexAgentTurnEnd & { sessionKey: string };
  retired?: { sessionKey: string; task: BackgroundTaskSummary };
}>();
const MAX_TRACKED_CODEX_AGENT_THREADS = 500;

function rememberCodexAgentTurn(agentThreadId: string, state: NonNullable<ReturnType<typeof codexAgentTurns.get>>): void {
  codexAgentTurns.delete(agentThreadId);
  codexAgentTurns.set(agentThreadId, state);
  if (codexAgentTurns.size > MAX_TRACKED_CODEX_AGENT_THREADS) {
    const oldest = codexAgentTurns.keys().next().value;
    if (oldest !== undefined) codexAgentTurns.delete(oldest);
  }
}

/** Keeps the card of an agent that went idle, so waking it can revive the card. */
function retireCodexAgent(sessionKey: string, task: BackgroundTaskSummary): void {
  rememberCodexAgentTurn(task.taskId, { ...codexAgentTurns.get(task.taskId), retired: { sessionKey, task } });
}

/** Ends a tracked agent whose own turn ended, and settles its card with that outcome. */
function settleCodexAgentTurn(
  target: CodexEventTarget,
  backgroundWorkKey: string,
  agentThreadId: string,
  ended: CodexAgentTurnEnd,
): void {
  const tracked = codexBackgroundWork.end(backgroundWorkKey, agentThreadId);
  if (!tracked) {
    return;
  }
  retireCodexAgent(backgroundWorkKey, tracked);
  broadcastCodexBackgroundTasks(target, backgroundWorkKey);
  target.deliver(codexTaskStatus(target.threadId() || target.appSessionId || null, tracked.taskId, tracked.toolUseId, {
    event: 'notification',
    status: ended.status,
    ...(ended.summary ? { summary: ended.summary } : {}),
  }));
}

/**
 * Follows the turns an agent runs on its own thread.
 *
 * The engine reports an agent's end only in the parent's records, written when
 * the parent waits on it; a parent turn that fails first (the usage limit, for
 * one) never writes them, and the agent would show as running forever. The
 * agent's own turn is what says whether it runs: the end of the turn settles
 * the card with the turn's outcome, and a later turn of the same agent runs
 * on that card again.
 */
function trackCodexAgentTurn(
  target: CodexEventTarget,
  method: string,
  params: AnyRecord,
  agentThreadId: string,
  backgroundWorkKey: string | null | undefined,
): void {
  if (method !== 'turn/started' && method !== 'turn/completed') {
    return;
  }
  const turn = readObjectRecord(params.turn);
  if (method === 'turn/completed') {
    const status = turn?.status === 'failed' ? 'failed' : turn?.status === 'interrupted' ? 'stopped' : 'completed';
    const summary = readNonEmptyString(readObjectRecord(turn?.error)?.message);
    console.log(`[Codex] Agent thread ${agentThreadId} ended a turn (${String(turn?.status ?? 'unknown')}).`);
    const ended: CodexAgentTurnEnd = { status, ...(summary ? { summary } : {}) };
    if (!backgroundWorkKey) {
      return;
    }
    rememberCodexAgentTurn(agentThreadId, {
      ...codexAgentTurns.get(agentThreadId),
      ended: { ...ended, sessionKey: backgroundWorkKey },
    });
    const owner = codexBackgroundWork.find(agentThreadId);
    if (owner?.sessionKey === backgroundWorkKey) {
      settleCodexAgentTurn(target, backgroundWorkKey, agentThreadId, ended);
    }
    return;
  }

  console.log(`[Codex] Agent thread ${agentThreadId} started a turn.`);
  const state = codexAgentTurns.get(agentThreadId);
  if (!state) {
    return;
  }
  const retired = state.retired;
  // A new turn makes the end of the last one stale.
  rememberCodexAgentTurn(agentThreadId, retired ? { retired } : {});
  if (!retired || !backgroundWorkKey || retired.sessionKey !== backgroundWorkKey
    || codexBackgroundWork.get(backgroundWorkKey, agentThreadId)) {
    return;
  }
  codexAgentTurns.delete(agentThreadId);
  const { taskId, toolUseId, taskType, description } = retired.task;
  codexBackgroundWork.start(backgroundWorkKey, { taskId, toolUseId, taskType, description });
  broadcastCodexBackgroundTasks(target, backgroundWorkKey);
  target.deliver(codexTaskStatus(target.threadId() || target.appSessionId || null, taskId, toolUseId, {
    event: 'started',
    description,
  }));
}

/**
 * Announces one engine item as the app's rows.
 *
 * A collab agent's lifecycle feeds the background-work tracker, so the
 * running-sessions poll and the composer's strip name the agents the turn
 * in flight is waiting on. Which event announced the item — not the item's
 * own status field, which `started` events may omit — decides between tracked
 * and retired: an unrecognized status parses as `completed`, and trusting it
 * on `started` would drop the agent before its first tick.
 */
function emitCodexItem(
  target: CodexEventTarget,
  rawItem: unknown,
  timestamp: string,
  source: 'started' | 'completed',
  backgroundWorkKey: string | null | undefined,
): void {
  const item = readCodexAppServerItem(rawItem);
  if (!item) {
    return;
  }
  if (item.kind === 'collab_spawn' && backgroundWorkKey) {
    if (source === 'started') {
      codexBackgroundWork.start(backgroundWorkKey, {
        taskId: item.id,
        toolUseId: item.id,
        taskType: CODEX_BACKGROUND_TASK_TYPE,
        description: item.prompt ? `${item.label}: ${item.prompt}` : item.label,
      });
      broadcastCodexBackgroundTasks(target, backgroundWorkKey);
    } else if (codexBackgroundWork.end(backgroundWorkKey, item.id)) {
      broadcastCodexBackgroundTasks(target, backgroundWorkKey);
    }
  }
  if (item.kind === 'mcp_tool_call') {
    const args = readObjectRecord(item.toolArguments);
    if (args) target.registerToolCall?.({ callId: item.id, server: item.server, tool: item.tool, arguments: args });
  }
  if (item.kind === 'subagent_activity') {
    emitCodexSubagentActivity(target, item, timestamp, backgroundWorkKey);
    return;
  }
  for (const itemRow of codexThreadItemToRows(item, timestamp)) {
    // A compaction that has started but not finished is the running row its
    // completion replaces (same id).
    const row = source === 'started' && itemRow.type === 'compaction' ? { ...itemRow, phase: 'running' } : itemRow;
    if (row.type === 'tool_use' && !target.approvalSubjects.has(item.id)) {
      target.approvalSubjects.set(item.id, { toolName: String(row.toolName), input: row.toolInput });
    }
    for (const message of target.normalize(row, target.threadId() || target.appSessionId || null)) {
      target.deliver(message);
    }
  }
}

/**
 * A running agent's own finished item, as a row tied to its card. Agents
 * work on their own thread of this connection; the thread id is how the
 * registry finds the card. The agent's prompt (the card's task) and its
 * lifecycle items are left out, the same as when history rebuilds the
 * timeline from the agent's rollout, so the card reads alike either way.
 * Threads this session did not spawn are ignored.
 */
function emitCodexAgentItem(
  target: CodexEventTarget,
  agentThreadId: string,
  rawItem: unknown,
  timestamp: string,
  backgroundWorkKey: string | null | undefined,
): void {
  const owner = codexBackgroundWork.find(agentThreadId);
  const item = readCodexAppServerItem(rawItem);
  if (!owner || owner.sessionKey !== backgroundWorkKey || !item || item.kind === 'user_message' || item.kind === 'subagent_activity') {
    return;
  }
  for (const row of codexThreadItemToRows(item, timestamp)) {
    for (const message of target.normalize(row, target.threadId() || target.appSessionId || null)) {
      target.deliver({ ...message, parentToolUseId: owner.task.toolUseId });
    }
  }
}

/**
 * The events of a turn the engine started on its own.
 *
 * The engine starts a turn to deliver a background result, and that turn
 * belongs to the session rather than to the round the user is waiting for.
 * Its events are published to the session, so they reach the tabs watching
 * the conversation without ending a round.
 *
 * The handler is bound to the session, not to a round: a resident process
 * reports after the round that started it is gone, so nothing here may
 * depend on that round's writer.
 */
function handleCodexSessionEvent(
  target: CodexEventTarget,
  method: string,
  params: AnyRecord,
): void {
  const backgroundWorkKey = target.appSessionId;
  const eventThreadId = readNonEmptyString(params.threadId) ?? readNonEmptyString(params.thread_id);
  if (eventThreadId && target.threadId() && eventThreadId !== target.threadId()) {
    // A subagent reports on the same connection, and its card still belongs
    // to the conversation the user is looking at.
    if (method === 'item/completed') {
      emitCodexAgentItem(target, eventThreadId, params.item, new Date().toISOString(), backgroundWorkKey);
    }
    trackCodexAgentTurn(target, method, params, eventThreadId, backgroundWorkKey);
    return;
  }

  const sessionId = target.threadId() || target.appSessionId || null;
  switch (method) {
    case 'turn/started': {
      console.log(`[Codex] The engine started a turn of its own on thread ${target.threadId() ?? 'unknown'}.`);
      return;
    }

    case 'item/started': {
      const startedType = readObjectRecord(params.item)?.type;
      if (typeof startedType === 'string' && PROGRESSIVE_CODEX_ITEM_TYPES.has(startedType)) {
        emitCodexItem(target, params.item, new Date().toISOString(), 'started', backgroundWorkKey);
      }
      return;
    }

    case 'item/completed': {
      emitCodexItem(target, params.item, new Date().toISOString(), 'completed', backgroundWorkKey);
      return;
    }

    case 'item/agentMessage/delta': {
      if (typeof params.delta === 'string' && params.delta) {
        target.deliver(createNormalizedMessage({
          kind: 'stream_delta',
          role: 'assistant',
          content: params.delta,
          sessionId,
          provider: 'codex',
        }));
      }
      return;
    }

    case 'thread/tokenUsage/updated': {
      const tokenBudget = readCodexTokenBudget(params);
      if (tokenBudget) {
        target.deliver(createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget,
          sessionId,
          provider: 'codex',
        }));
      }
      return;
    }

    case 'error': {
      const message = readCodexFailureMessage({ error: params.error, message: params.message });
      const turnId = readCodexReportedTurnId(params);
      if (params.willRetry === true) {
        // A recoverable error is progress, not a failed turn — the engine is
        // still trying. The round's handler says the same about the round's
        // own notifications, and a row here would outlive the retry.
        console.warn('[Codex] Retrying turn:', message);
        return;
      }
      if (message) {
        target.deliver(createNormalizedMessage({
          // The turn id names the failure on both transports, so the row the
          // history read returns replaces this one.
          ...(turnId ? { id: codexTurnFailureRowId(turnId) } : {}),
          kind: 'error',
          content: message,
          sessionId,
          provider: 'codex',
        }));
      }
      return;
    }

    default:
      return;
  }
}

/**
 * Settles the agents of a session whose process is gone.
 *
 * A process that is closed takes its agents with it, so their cards would
 * spin forever.
 */
function settleCodexSessionAgents(
  appSessionId: string,
  deliver: (message: NormalizedMessage) => void,
): void {
  const outstanding = codexBackgroundWork.clearSession(appSessionId);
  if (outstanding.length === 0) {
    return;
  }
  for (const task of outstanding) retireCodexAgent(appSessionId, task);
  deliver(createBackgroundTasksStatusMessage(
    { provider: 'codex', sessionId: appSessionId },
    codexBackgroundWork.listStripTasks(appSessionId),
    true,
  ));
  for (const task of outstanding) {
    deliver(codexTaskStatus(appSessionId, task.taskId, task.toolUseId, {
      event: 'notification',
      status: 'stopped',
    }));
  }
}

/**
 * The tool each announced item needs, per session.
 *
 * A resident session can be asked for an approval while no round is in
 * flight, and the card has to name the tool that waits.
 */
const sessionApprovalSubjects = new Map<string, Map<string, { toolName: string; input: unknown }>>();
/** Session approvals outlive any one borrower's round and are retracted on disposal. */
const sessionApprovalIds = new Map<string, Set<string>>();

/** The approval subjects of a session, created on first use. */
function readSessionApprovalSubjects(appSessionId: string | null): Map<string, { toolName: string; input: unknown }> {
  const key = appSessionId ?? '';
  const existing = sessionApprovalSubjects.get(key);
  if (existing) {
    return existing;
  }
  const created = new Map<string, { toolName: string; input: unknown }>();
  sessionApprovalSubjects.set(key, created);
  return created;
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
  const taskContinuationTarget = readObjectRecord(options.taskContinuationTarget);
  const pinnedProviderThreadId = typeof taskContinuationTarget?.providerThreadId === 'string'
    ? taskContinuationTarget.providerThreadId
    : null;
  const providerSessionId = pinnedProviderThreadId ?? context.resolveProviderSessionId(sessionId);
  const resolvedModel = await context.resolveResumeModel(sessionId, model);
  const workingDirectory = typeof taskContinuationTarget?.workingDirectory === 'string'
    ? taskContinuationTarget.workingDirectory
    : cwd || projectPath || process.cwd();
  const taskSandboxPolicyType = taskContinuationTarget?.sandboxPolicyType;
  const taskApprovalPolicy = taskContinuationTarget?.approvalPolicy;
  const targetPermissionMode = taskSandboxPolicyType === 'dangerFullAccess'
    ? 'bypassPermissions'
    : taskApprovalPolicy === 'never' ? 'acceptEdits' : permissionMode;
  const { sandbox, approvalPolicy, sandboxPolicy } = resolveCodexExecutionPolicy(targetPermissionMode);
  const toolOutputParam = options.toolOutput ?? (options.taskContinuation ? {
      name: 'cloudcli_task_result',
      output: typeof options.taskContinuation === 'string'
        ? options.taskContinuation
        : JSON.stringify(options.taskContinuation),
    } : null);
  const taskExecutionContext = readObjectRecord(options.taskExecutionContext);
  const taskContinuationLifecycle = readObjectRecord(options.taskContinuationLifecycle);
  const onEngineTurnStarted = typeof taskContinuationLifecycle?.onEngineTurnStarted === 'function'
    ? taskContinuationLifecycle.onEngineTurnStarted as (engineTurnId: string) => unknown
    : null;
  const onNativeThreadResolved = typeof taskContinuationLifecycle?.onNativeThreadResolved === 'function'
    ? taskContinuationLifecycle.onNativeThreadResolved as (threadId: string) => unknown
    : null;
  const taskRunToken = typeof taskExecutionContext?.token === 'string'
    ? taskExecutionContext.token
    : '';
  const taskMcpOptions = taskRunToken
    ? getTaskMcpRuntimeOptions({ token: taskRunToken })
    : null;
  /**
   * The task MCP options of a resident process.
   *
   * A resident process carries a narrow bridge credential instead of the
   * round's capability, because it outlives the round that started it. The
   * credential is bound to the process generation, so it is created when the
   * manager starts the process.
   */
  let residentTaskMcpOptions: { config: Record<string, unknown>; env: NodeJS.ProcessEnv } | null = null;
  const createResidentTaskMcpOptions = (generation: number) => {
    if (!normalizedUserId) {
      console.warn('[Codex] The conversation has no trusted user; the task tools are not available.');
      residentTaskMcpOptions = null;
      return null;
    }
    const bridge = context.createBridgeCredential?.({
      userId: normalizedUserId,
      appSessionId: residentKey,
      generation,
    });
    if (!bridge) {
      // Without a bridge credential the process gets no task tools at all:
      // a per-round capability would outlive the round it belongs to.
      residentTaskMcpOptions = null;
      return null;
    }
    residentTaskMcpOptions = getTaskMcpRuntimeOptions({ bridgeToken: bridge.token });
    return { env: residentTaskMcpOptions.env, credentialToken: bridge.token };
  };

  /** Publishes one event to the session, outside any round. */
  const publishSessionMessage = (message: NormalizedMessage): void => {
    context.publishSessionEvent?.(residentKey, message);
  };
  const catalog = await context.getProviderModels();
  const resolvedEffort = resolveModelEffort(resolvedModel, effort, catalog);

  let capturedSessionId: string | null = providerSessionId ?? null;
  let runSession: ActiveCodexSession | null = null;
  let sessionCreatedSent = false;
  let terminalFailure: { message: string } | null = null;
  let errorSurfaced = false;
  let connection: CodexAppServerConnection | null = null;
  let engineTurnId: string | null = null;
  let terminalStatus: 'completed' | 'failed' | 'interrupted' | 'unknown' = 'unknown';
  let acceptanceUnknown = false;
  let acceptedTurnCallbackSent = false;

  const recordStartedTurn = (turnId: string | null): void => {
    if (!turnId) return;
    if (engineTurnId && engineTurnId !== turnId) {
      terminalFailure = { message: 'Codex reported different turn ids for one continuation.' };
      terminalStatus = 'unknown';
      return;
    }
    engineTurnId = turnId;
    if (!acceptedTurnCallbackSent) {
      acceptedTurnCallbackSent = true;
      onEngineTurnStarted?.(turnId);
    }
  };

  /** Session-map key: the app session id, else the thread id once captured. */
  const sessionKey = () => sessionId || capturedSessionId || null;
  // Keep this run's identity. A newer run can replace the map entry while an
  // aborted connection is still settling; the older run must not observe or
  // mutate the newer run's state.
  const currentSession = () => runSession;

  // Both `error` and `turn/completed` can report the same terminal cause.
  const surfaceFailure = (message: string, turnId?: string | null): void => {
    if (errorSurfaced && terminalFailure?.message === message) {
      return;
    }
    terminalFailure = { message };
    errorSurfaced = true;
    sendMessage(ws, createNormalizedMessage({
      // A failure belongs to a turn, and the engine names that turn. The row
      // id is derived from it so the copy the history read returns replaces
      // this one instead of the transcript showing the failure twice.
      ...(turnId ? { id: codexTurnFailureRowId(turnId) } : {}),
      kind: 'error',
      content: message,
      sessionId: capturedSessionId || sessionId || null,
      provider: 'codex',
    }));
  };

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

  /**
   * The events of this round, delivered through the run's writer.
   *
   * The gateway stamps the round's sequence numbers and ends the round on its
   * terminal event, so a round's own events never travel the session's
   * publish entry.
   */
  let residentGeneration: number | null = null;
  let knownNativeName: string | null = null;
  let residentRoundId: string | null = null;
  const roundTarget: CodexEventTarget = {
    appSessionId: sessionId || null,
    threadId: () => capturedSessionId,
    normalize: (raw, nativeSessionId) => context.normalizeMessage(raw, nativeSessionId),
    deliver: (message) => sendMessage(ws, message),
    approvalSubjects,
    registerToolCall: (call) => {
      if (!taskRunToken || !capturedSessionId || residentGeneration === null) {
        return;
      }
      context.registerEngineToolCall?.({
        appSessionId: sessionId || capturedSessionId,
        generation: residentGeneration,
        arguments: call.arguments,
        threadId: capturedSessionId,
        turnId: engineTurnId,
        callId: call.callId,
        server: call.server,
        tool: call.tool,
        runToken: taskRunToken,
      });
    },
  };

  /**
   * Re-sends the composer strip's list for this run's session; called after
   * every change to the agents tracked under `backgroundWorkKey`. The turn is
   * in flight for as long as an agent is tracked (the turn's end clears the
   * rest), so the work is always stoppable through the turn.
   */
  const broadcastBackgroundTasks = (backgroundWorkKey: string): void => {
    broadcastCodexBackgroundTasks(roundTarget, backgroundWorkKey);
  };

  /**
   * Settles every agent this run still tracks as `stopped`. The app-server is
   * a child process that `connection.close()` kills when the turn ends, and
   * the agents it ran die with it, so an agent still registered here will
   * never report: its card would spin forever. Called before the terminal
   * `complete` so the page never sees a finished turn with a running card;
   * a second call finds the registry already empty.
   */
  const settleOutstandingAgents = (): void => {
    const backgroundWorkKey = sessionId || capturedSessionId;
    if (!backgroundWorkKey) {
      return;
    }
    const outstanding = codexBackgroundWork.clearSession(backgroundWorkKey);
    if (outstanding.length === 0) {
      return;
    }
    for (const task of outstanding) retireCodexAgent(backgroundWorkKey, task);
    broadcastBackgroundTasks(backgroundWorkKey);
    for (const task of outstanding) {
      sendMessage(ws, codexTaskStatus(capturedSessionId || sessionId || null, task.taskId, task.toolUseId, {
        event: 'notification',
        status: 'stopped',
      }));
    }
  };

  const emitItem = (rawItem: unknown, timestamp: string, source: 'started' | 'completed'): void => {
    emitCodexItem(roundTarget, rawItem, timestamp, source, sessionId || capturedSessionId);
  };

  /**
   * A running agent's own finished item, as a row tied to its card. Agents
   * work on their own thread of this connection; the thread id is how the
   * registry finds the card. The agent's prompt (the card's task) and its
   * lifecycle items are left out, the same as when history rebuilds the
   * timeline from the agent's rollout, so the card reads alike either way.
   * Threads this run did not spawn are ignored.
   */
  const emitAgentItem = (agentThreadId: string, rawItem: unknown, timestamp: string): void => {
    emitCodexAgentItem(roundTarget, agentThreadId, rawItem, timestamp, sessionId || capturedSessionId);
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
  const requestApproval = (
    method: string,
    params: AnyRecord,
    deliver: (message: NormalizedMessage) => void = (message) => sendMessage(ws, message),
    subjects: Map<string, { toolName: string; input: unknown }> = approvalSubjects,
    ownedApprovalIds: Set<string> = openApprovalIds,
  ): Promise<ProviderPermissionDecision | null> => {
    const itemId = readNonEmptyString(params.itemId) ?? randomUUID();
    const requestId = randomUUID();
    // A command approval is asked *before* the item is announced and carries
    // the command itself; everything else is asked about an item the user has
    // already seen announced, so the card is rebuilt from that row.
    const command = readNonEmptyString(params.command);
    const subject = command
      ? { toolName: 'Bash', input: JSON.stringify({ command: readCodexCommandLine(command) }) }
      : subjects.get(itemId);
    const reason = readNonEmptyString(params.reason);
    // An approval for a running agent's thread names the agent's card.
    const askingThread = readNonEmptyString(params.threadId);
    const owner = askingThread && askingThread !== capturedSessionId ? codexBackgroundWork.find(askingThread) : undefined;
    const subagent = owner && owner.sessionKey === (sessionId || capturedSessionId)
      ? { toolUseId: owner.task.toolUseId, description: owner.task.description }
      : undefined;

    return new Promise<ProviderPermissionDecision | null>((resolve) => {
      let settled = false;
      const settleOnce = (decision: ProviderPermissionDecision | null) => {
        if (settled) {
          return;
        }
        settled = true;
        pendingCodexApprovals.delete(requestId);
        ownedApprovalIds.delete(requestId);
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
      ownedApprovalIds.add(requestId);

      deliver(createNormalizedMessage({
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
          ...(subagent ? { subagent } : {}),
        },
        canInterrupt: true,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
      }));
    }).then((decision) => {
      // Every attached tab drops the prompt, including one that reconnects
      // mid-run and replays the request frame.
      deliver(createNormalizedMessage({
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

  /**
   * Retracts the approvals the session opened for the engine's own requests.
   *
   * They belong to the session rather than to a round: a round that ends must
   * not retract the approval the engine is still waiting for.
   */
  const cancelSessionApprovals = (appSessionId: string | null, reason: string): void => {
    const key = appSessionId || capturedSessionId || '';
    const ids = sessionApprovalIds.get(key);
    if (!ids) {
      return;
    }
    sessionApprovalIds.delete(key);
    for (const requestId of [...ids]) {
      publishSessionMessage(createNormalizedMessage({
        kind: 'permission_cancelled',
        requestId,
        reason,
        sessionId: capturedSessionId || sessionId || null,
        provider: 'codex',
      }));
      pendingCodexApprovals.get(requestId)?.settle(null);
    }
  };

  /** Set when the process of this round died, which kills its agents with it. */
  let residentProcessExited = false;

  /**
   * Settles the agents of this round when nothing can be running any more.
   *
   * A resident process keeps the agents alive past the end of the round, so
   * they are only settled when the process itself is gone.
   */
  const settleAgentsWhenProcessIsGone = (): void => {
    if (residentGeneration === null || residentProcessExited) {
      settleOutstandingAgents();
    }
  };

  /**
   * The process died, so the round can never reach a terminal state.
   */
  const handleProcessExit = (reason: string): void => {
    residentProcessExited = true;
    if (currentSession()?.status !== 'aborted' && !terminalFailure) {
      terminalFailure = { message: reason };
    }
    settle();
  };

  /**
   * Answers the server-to-client requests the round has to handle.
   *
   * An approval waits for the user, so the answer must reach the request
   * that is still open.
   */
  const handleRoundRequest = async (method: string, params: AnyRecord) => {
    if (method === TASK_MCP_ELICITATION_METHOD) {
      if (!taskMcpOptions || params.serverName !== TASK_MCP_NAME) {
        return undefined;
      }
      // CloudCLI's current permission card cannot collect form answers or complete URL handshakes.
      return { action: 'decline', content: null };
    }
    if (!CODEX_APPROVAL_METHODS.has(method)) {
      return undefined;
    }
    const decision = await requestApproval(method, params);
    return toCodexApprovalResponse(method, params, decision);

  };

  /**
   * The events of the round's own turn.
   *
   * The events of a turn the engine started on its own never reach this
   * handler: a background report must not end the user's round.
   */
  /**
   * Announces what the engine is doing with the round.
   *
   * The page learns it from this frame instead of waiting for the next poll,
   * so a round that waits for the engine says so at once.
   */
  const announceActivityState = (): void => {
    const activity = readCodexResidentSessionActivity(residentKey);
    if (!activity) {
      return;
    }
    sendMessage(ws, createNormalizedMessage({
      kind: 'status',
      text: 'activity_state',
      activityState: { queued: activity.queued, reporting: activity.reporting },
      sessionId: capturedSessionId || sessionId || null,
      provider: 'codex',
    }));
  };

  const handleRoundEvent = (method: string, params: AnyRecord): void => {
    const session = currentSession();
    // A stop the user asked for silences the events that follow it, but the
    // terminal event still has to arrive: the round waits for it, and a
    // resident process keeps running after the stop, so nothing else would
    // ever settle the round.
    if (session?.status === 'aborted' && method !== 'turn/completed') {
      return;
    }

    const notificationRecord = readObjectRecord(params);
    const turnRecord = readObjectRecord(notificationRecord?.turn);
    const itemRecord = readObjectRecord(notificationRecord?.item);
    const eventThreadId =
      readNonEmptyString(notificationRecord?.threadId) ??
      readNonEmptyString(notificationRecord?.thread_id) ??
      readNonEmptyString(turnRecord?.threadId) ??
      readNonEmptyString(turnRecord?.thread_id) ??
      readNonEmptyString(itemRecord?.threadId) ??
      readNonEmptyString(itemRecord?.thread_id) ??
      null;

    // Subagents in multi-agent mode emit their own lifecycle events on the same
    // app-server connection. Only events for the target thread (the parent session)
    // drive this turn's terminal state, live transcript, and token updates.
    if (eventThreadId && capturedSessionId && eventThreadId !== capturedSessionId) {
      if (method === 'item/completed') {
        emitAgentItem(eventThreadId, params.item, new Date().toISOString());
      }
      trackCodexAgentTurn(roundTarget, method, params, eventThreadId, sessionId || capturedSessionId);
      return;
    }

    switch (method) {
      case 'turn/started': {
        const turn = readObjectRecord(params.turn);
        const turnId = typeof turn?.id === 'string' ? turn.id : null;
        if (turnId) {
          recordStartedTurn(turnId);
        }
        const active = currentSession();
        if (active) {
          active.turnId = turnId;
        }
        // The engine took the round; it is not waiting any more.
        announceActivityState();
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
          emitItem(params.item, new Date().toISOString(), 'started');
        }
        return;
      }

      case 'item/completed':
        emitItem(params.item, new Date().toISOString(), 'completed');
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
        const message = readCodexFailureMessage({ error: params.error, message: params.message })
          || 'Codex reported an error.';
        // A recoverable stream error is progress, not a failed turn. Keep
        // its cause in logs without adding a permanent chat error row.
        if (params.willRetry === true) {
          console.warn('[Codex] Retrying turn:', message);
          return;
        }
        surfaceFailure(message, readCodexReportedTurnId(params));
        return;
      }

      case 'turn/completed': {
        const turn = readObjectRecord(params.turn);
        if (typeof turn?.id === 'string') engineTurnId = turn.id;
        terminalStatus = turn?.status === 'completed'
          ? 'completed'
          : turn?.status === 'failed'
            ? 'failed'
            : turn?.status === 'interrupted'
              ? 'interrupted'
              : 'unknown';
        if (turn?.status === 'failed') {
          const message = readCodexFailureMessage({ error: turn.error }) || terminalFailure?.message || 'Turn failed';
          surfaceFailure(message, readCodexReportedTurnId(params) ?? engineTurnId);
          notifyRunFailed({
            userId: normalizedUserId,
            provider: 'codex',
            sessionId: appSessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            error: terminalFailure,
          });
        }
        if (turn?.status === 'interrupted' && currentSession()?.status !== 'aborted') {
          // Codex ends a usage-limit, shutdown, or engine-internal interrupt
          // here rather than at `failed` — on codex 0.155 a spawned agent
          // finishing mid-turn aborted the whole agent tree as `interrupted`
          // (fixed upstream in 0.156/#45549 and 0.157/#47340). Treating the
          // status as a normal completion sent the client a clean `complete`
          // while the rollout recorded `turn_aborted`, so the abort was
          // invisible until history re-read it and diagnostics logged the run
          // as a success. A stop the user asked for (`abort` already flagged
          // the session) arrives as the same status and must stay silent.
          const message = terminalFailure?.message ?? 'Codex interrupted this turn before it finished. This can mean an account usage limit, or the engine stopping the turn itself. Sending a message continues from where it stopped.';
          // No turn id here: an interrupted turn is recorded as an abort, and
          // an abort carries no cause for a failure row to be named after — a
          // row named after it would claim a join the transcript cannot make.
          surfaceFailure(message);
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

  };

  /**
   * The resident key is the app session id, so the next round of the same
   * conversation finds the process that is already running.
   */
  const residentKey = appSessionId ?? `codex-unbound-${randomUUID()}`;

  try {
    // A conversation that is being archived or deleted must not start a
    // round while that action is in flight.
    if (appSessionId && isCodexResidentSessionAdmissionClosed(appSessionId)) {
      throw new Error('The Codex conversation is being closed and cannot take another message.');
    }

    /**
     * Ends the round.
     *
     * A resident session interrupts the turn it started, or removes the input
     * that is still waiting in the engine's queue. A short connection is torn
     * down behind the interrupt.
     */
    const stopRound = (): Promise<unknown> => {
      if (residentGeneration !== null) {
        // The confirmation matters: the engine may already have run the input,
        // and the user must not see a success before that is known.
        return stopCodexResidentRound(residentKey);
      }
      const session = currentSession();
      if (session?.threadId && session.turnId) {
        connection?.call('turn/interrupt', { threadId: session.threadId, turnId: session.turnId })
          .catch((error: unknown) => {
            console.warn(`[Codex] Interrupt for session ${residentKey} was not accepted:`, error);
          });
      }
      // The connection is torn down on the next tick so the interrupt has a
      // chance to leave the process before its pipes close.
      setTimeout(() => connection?.close(), 250).unref?.();
      return Promise.resolve('interrupted');
    };

    const registerSession = (id: string | null) => {
      if (!id) {
        return;
      }
      runSession = {
        stop: stopRound,
        threadId: capturedSessionId,
        turnId: null,
        status: 'running',
        startedAt: new Date().toISOString(),
      };
      activeCodexSessions.set(id, runSession);
    };

    /** Records the native thread the conversation runs in. */
    const adoptNativeThread = (discoveredSessionId: string) => {
      onNativeThreadResolved?.(discoveredSessionId);
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
    };

    if (sessionKey()) {
      registerSession(sessionKey());
    }

    let resident: CodexResidentSession | null = null;
    if (isResidentSessionsEnabled()) {
      try {
        resident = await acquireCodexResidentSession({
        appSessionId: residentKey,
        lifetime: toolOutputParam ? 'turn' : 'session',
        reserveForRound: true,
        userId: normalizedUserId,
        nativeThreadId: providerSessionId,
        workingDirectory,
        env: (generation) => createResidentTaskMcpOptions(generation),
        config: async (openConnection) => {
          const excludes = residentTaskMcpOptions
            ? await readEffectiveShellEnvironmentExcludes(openConnection, workingDirectory)
            : [];
          return {
            'features.defer_mailbox_preemption': true,
            ...(residentTaskMcpOptions?.config ?? {}),
            ...(residentTaskMcpOptions ? {
              'shell_environment_policy.exclude': [...new Set([
                ...excludes,
                TASK_BRIDGE_ENV,
              ])],
            } : {}),
          };
        },
        approvalPolicy,
        sandbox,
        sandboxPolicy,
        onEngineEvent: (method, params, threadId) => handleCodexSessionEvent({
          appSessionId: residentKey,
          threadId: () => threadId,
          normalize: (raw, nativeSessionId) => context.normalizeMessage(raw, nativeSessionId),
          deliver: (message) => {
            context.publishSessionEvent?.(residentKey, message);
          },
          approvalSubjects: readSessionApprovalSubjects(residentKey),
        }, method, params),
        onSessionExit: handleProcessExit,
        onSessionRequest: async (method, params) => {
          if (!CODEX_APPROVAL_METHODS.has(method)) return undefined;
          let ids = sessionApprovalIds.get(residentKey);
          if (!ids) {
            ids = new Set<string>();
            sessionApprovalIds.set(residentKey, ids);
          }
          const decision = await requestApproval(method, params, publishSessionMessage,
            readSessionApprovalSubjects(residentKey), ids);
          return toCodexApprovalResponse(method, params, decision);
        },
        onRoundEnded: (reason, cause) => {
          // The round cannot wait for an event that will never come: the
          // input was withdrawn, or the turn could not be identified.
          if (reason === 'cancelled') {
            terminalStatus = 'interrupted';
          } else {
            terminalStatus = 'unknown';
            acceptanceUnknown = true;
            surfaceFailure(cause === 'interrupt'
              ? 'Codex could not confirm that this turn stopped. Its conversation process and background agents were force-stopped. Check the results before retrying; independent tasks may still be running.'
              : cause === 'stop'
              ? 'Codex could not confirm whether the queued message ran. Its conversation process and background agents were force-stopped. Check the results before retrying; independent tasks may still be running.'
              : 'Codex could not tell which turn answered this message.');
          }
          settle();
        },
        revokeCredential: (token: string) => {
          context.revokeBridgeCredential?.(token);
        },
        onSessionDisposed: () => {
          // The agents of a closed process cannot report any more, so their
          // cards are settled.
          settleCodexSessionAgents(residentKey, publishSessionMessage);
          cancelSessionApprovals(residentKey, 'The conversation process closed before this was answered.');
          sessionApprovalSubjects.delete(residentKey);
        },
        isBusy: () => codexBackgroundWork.hasSession(residentKey),
      });
      } catch (error) {
        // Every resident process is busy. The short connection still works, so
        // the message goes out instead of failing to send.
        if (!(error instanceof AppError) || error.code !== 'CODEX_RESIDENT_CAPACITY') {
          throw error;
        }
        console.warn(`[Codex] ${error.message} This round runs on a short connection.`);
        resident = null;
      }
    }

    if (resident) {
      connection = resident.connection;
      residentGeneration = resident.generation;
      knownNativeName = resident.nativeName;
      adoptNativeThread(resident.threadId);
    } else {
      connection = await codexAppServerTransport.open({
        onExit: handleProcessExit,
        onRequest: handleRoundRequest,
        onNotification: handleRoundEvent,
      }, taskMcpOptions ? { env: taskMcpOptions.env } : undefined);

      const effectiveShellExcludes = taskMcpOptions
        ? await readEffectiveShellEnvironmentExcludes(connection, workingDirectory)
        : [];

      // `config` carries the settings the protocol has no field of its own for.
      const threadSettings: AnyRecord = {
        cwd: workingDirectory,
        sandbox,
        approvalPolicy,
        config: {
          'features.defer_mailbox_preemption': true,
          ...(taskMcpOptions?.config ?? {}),
          ...(taskMcpOptions ? {
            'shell_environment_policy.exclude': [...new Set([
              ...effectiveShellExcludes,
              TASK_API_KEY_ENV,
              TASK_RUN_CONTEXT_ENV,
            ])],
          } : {}),
        },
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
        adoptNativeThread(discoveredSessionId);
      }
    }

    // Turns with image attachments send structured input items so Codex reads
    // the images from their local asset paths. The CLI requires non-empty
    // prompt text even when images carry the whole message, so an
    // attachment-only turn gets a small text instruction.
    const promptWithFiles = appendFilesInputTag(command, files);
    const normalizedImages = normalizeImageDescriptors(images);
    const promptForTurn = !promptWithFiles.trim() && normalizedImages.length > 0
      ? 'Please analyze the attached image(s).'
      : promptWithFiles;
    const inputItems = normalizedImages.length > 0
      ? buildCodexInputItems(promptForTurn, images, workingDirectory)
      : [{ type: 'text', text: promptForTurn }];

    if (!capturedSessionId) {
      throw new Error('Codex app-server opened no thread to run the turn in.');
    }

    // `/compact` is not text for the model: the engine compacts only through
    // its own call, which runs as a turn and reports a context-compaction item.
    const compactCommand = toolOutputParam ? null : readCompactCommand(command);
    if (compactCommand?.instructions) {
      throw new Error('Codex compacts without instructions. Send /compact on its own.');
    }



    if (residentGeneration !== null) {
      // The engine's queue is the admission gate: the input waits while the
      // thread is busy and becomes a turn of its own once it is idle.
      const submitted = await submitCodexResidentRound({
        appSessionId: residentKey,
        generation: residentGeneration ?? undefined,
        input: toolOutputParam || compactCommand ? [] : toAppServerInput(inputItems as AnyRecord[]),
        ...(toolOutputParam ? { toolOutput: toolOutputParam } : {}),
        ...(compactCommand ? { compact: true } : {}),
        model: resolvedModel ?? undefined,
        effort: resolvedEffort ?? undefined,
        workingDirectory,
        approvalPolicy,
        sandbox,
        sandboxPolicy,
        onEvent: handleRoundEvent,
        onRequest: handleRoundRequest,
      });
      residentRoundId = submitted.clientUserMessageId;
      // The engine has the input but has not started its turn yet.
      announceActivityState();
    } else if (compactCommand) {
      // The answer names no turn; the `turn/started` event records it.
      await connection.call('thread/compact/start', { threadId: capturedSessionId });
    } else {
      const startResult = readObjectRecord(await connection.call('turn/start', {
        threadId: capturedSessionId,
        input: toolOutputParam ? [] : toAppServerInput(inputItems as AnyRecord[]),
        ...(toolOutputParam ? { toolOutput: toolOutputParam } : {}),
        ...(resolvedEffort ? { effort: resolvedEffort } : {}),
      }));
      const startedTurn = readObjectRecord(startResult?.turn);
      recordStartedTurn(typeof startedTurn?.id === 'string' ? startedTurn.id : null);
    }

    await turnSettled;
    if (toolOutputParam && residentGeneration !== null) {
      releaseCodexResidentSession(residentKey, { dispose: true, generation: residentGeneration });
    }
    settleAgentsWhenProcessIsGone();

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runAborted = currentSession()?.status === 'aborted';
    if (runAborted && !acceptanceUnknown) {
      terminalStatus = 'interrupted';
    }
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
    if (toolOutputParam && error instanceof AppError && error.code === 'CODEX_SESSION_BUSY') {
      return { engineTurnId: null, terminalStatus: 'unknown' as const, busy: true };
    }
    settleAgentsWhenProcessIsGone();
    const wasAborted =
      currentSession()?.status === 'aborted' ||
      runError.name === 'AbortError' ||
      runError.message.toLowerCase().includes('aborted');

    if (!wasAborted) {
      if (!acceptanceUnknown) terminalStatus = 'failed';
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
    } else if (!acceptanceUnknown) {
      terminalStatus = 'interrupted';
    }

  } finally {
    cancelOpenApprovals('The run ended before this was answered.');
    settleAgentsWhenProcessIsGone();
    const session = currentSession();
    if (session) {
      session.status = session.status === 'aborted' ? 'aborted' : 'completed';
    }
    if (residentGeneration !== null) {
      // The process stays alive: the next round continues in the same thread.
      if (residentGeneration !== null && residentRoundId) {
        completeCodexResidentRound(residentKey, { generation: residentGeneration, clientUserMessageId: residentRoundId });
      }
      if (toolOutputParam && residentGeneration !== null) {
        releaseCodexResidentSession(residentKey, { dispose: true, generation: residentGeneration });
      } else if (!appSessionId && residentGeneration !== null) {
        // A run without an app session has no conversation to stay resident
        // for, so its process is closed with the round. Its agents are
        // tracked under the native thread id, which the disposal does not
        // clear, so they are settled here.
        settleOutstandingAgents();
        releaseCodexResidentSession(residentKey, { dispose: true, generation: residentGeneration });
      } else if (residentGeneration !== null) {
        releaseCodexResidentSession(residentKey, { generation: residentGeneration });
      }
    } else {
      connection?.close();
    }
  }

  const finalStatus = resolveCodexTerminalStatus(terminalStatus, Boolean(terminalFailure));
  if (finalStatus === 'completed' && !terminalFailure && !toolOutputParam
    && currentSession()?.status !== 'aborted' && appSessionId && capturedSessionId) {
    void codexSessionTitleService.enqueue({
      appSessionId, nativeThreadId: capturedSessionId, generation: residentGeneration ?? 0,
      workingDirectory, model: resolvedModel ?? catalog.DEFAULT, models: catalog,
      ...(!providerSessionId ? { initialPrompt: command } : {}),
    }, knownNativeName).catch(() => {
      console.warn(`[CodexTitle] ${appSessionId} ${capturedSessionId} enqueue_failed`);
    });
  }

  return {
    engineTurnId,
    terminalStatus: finalStatus,
  };
}

/**
 * Stops the work a conversation still runs after its round ended.
 *
 * The engine names no agent it could stop, and it never reports the end of
 * an agent whose parent turn failed, so the process is closed: closing it
 * settles the agents as stopped through the session's disposal. The next
 * message resumes the thread in a new process.
 */
function stopCodexBackgroundWork(sessionId: string): boolean {
  const activity = readCodexResidentSessionActivity(sessionId);
  // Without a live process there is nothing to close; a short connection
  // settles its agents when its round ends.
  if (!activity || (!activity.reporting && !codexBackgroundWork.hasSession(sessionId))) {
    return false;
  }
  console.log(`[Codex] Stopping the background work of session ${sessionId} by closing its process.`);
  // The same release as an archive, so a helper process of the conversation
  // cannot keep holding its thread.
  releaseCodexResidentSessionResources(sessionId);
  return true;
}

/**
 * Cancels an active Codex session.
 *
 * `turn/interrupt` is the graceful stop — it lets the server close the turn
 * out in the rollout — and the connection is closed behind it so a server
 * that ignores the interrupt cannot keep the run alive.
 */
async function abortCodexSession(sessionId: string): Promise<boolean> {
  const session = activeCodexSessions.get(sessionId);

  // A session whose round is over has no turn to interrupt, but its resident
  // process may still run agents or a report of its own; that is stopped
  // instead. Otherwise there is nothing to stop, and a stop must not report
  // success for a round that already ended.
  if (!session || session.status === 'completed') {
    return stopCodexBackgroundWork(sessionId);
  }
  // A stop already waits for the engine to confirm the interrupt; a repeated
  // press must not cut that short by closing the process.
  if (session.status !== 'running') {
    return false;
  }

  session.status = 'aborted';
  console.log(
    `[Codex] Aborting session ${sessionId} (thread ${session.threadId ?? 'unknown'}, `
    + `turn ${session.turnId ?? 'none'}) — started ${session.startedAt}`,
  );
  // The stop waits for the engine's confirmation. A queued input the engine
  // already ran cannot be taken back, and the user must not see a success
  // before that is known; the manager reports the unknown case itself.
  await session.stop();

  return true;
}

/**
 * Used by the providers module's CodexProvider to run and abort turns, and to
 * answer the approvals a run is blocked on.
 *
 * Declaring `permissions` is also what turns `supportsPermissionRequests` on
 * for Codex in the capability catalog.
 */
export const codexRuntime = {
  run: queryCodex,
  abort: abortCodexSession,
  /**
   * Compacts the thread through the app-server primitive the Codex IDE clients
   * use: `thread/compact/start`, waited out until the summary lands.
   */
  async compact(
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
  },
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
  /**
   * Sessions with collab agents still running, for the running-sessions poll,
   * plus resident sessions whose engine reports in a turn of its own after
   * the last agent ended (listed with no tasks, so the page shows them
   * working). A short-connection app-server dies with the turn, so its agents
   * are those of turns still in flight; the turn's end settles the rest.
   */
  listBackgroundWork(): SessionBackgroundWork[] {
    const work = codexBackgroundWork.list();
    const reporting = listCodexReportingOnlySessions()
      .filter((sessionId) => !codexBackgroundWork.hasSession(sessionId))
      .map((sessionId) => ({ sessionId, tasks: [] }));
    return [...work, ...reporting];
  },
  /**
   * What the engine is doing with the conversation's round.
   *
   * The engine is the only one that knows whether it picked the queued input
   * up, so the page asks the engine instead of guessing.
   */
  getSessionActivity(sessionId: string): { queued: boolean; reporting: boolean } | null {
    return readCodexResidentSessionActivity(sessionId);
  },
  /**
   * Whether the conversation still has work that must not be reclaimed.
   */
  hasSessionWork(sessionId: string): boolean {
    return isCodexResidentSessionBusy(sessionId);
  },
  /**
   * Stops new rounds from starting in the conversation, so an archive or a
   * delete can look at its state and act on it.
   */
  closeSessionAdmission(sessionId: string): void {
    closeCodexResidentSessionAdmission(sessionId);
  },
  /**
   * Releases the process the conversation kept alive between rounds.
   */
  releaseSession(sessionId: string): void {
    releaseCodexResidentSessionResources(sessionId);
  },
  /**
   * Opens the conversation's admission again.
   */
  openSessionAdmission(sessionId: string): void {
    openCodexResidentSessionAdmission(sessionId);
  },
  /** What the composer's strip shows for a session that subscribes mid-turn. */
  backgroundTasks: {
    list: (sessionId: string) => codexBackgroundWork.listStripTasks(sessionId),
  },
};

/**
 * Runs argv through an independent Codex app-server `command/exec` call.
 * Consumed by task-continuations worker; the server process environment is
 * reduced to local runtime paths, and task/auth credentials are explicitly
 * removed from the command environment.
 */
export async function executeCodexSandboxCommand(input: {
  command: string[];
  cwd: string;
  sandboxPolicy: { type: 'workspaceWrite' | 'dangerFullAccess'; networkAccess: boolean };
  onStarted?: () => void;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!input.command.length || input.command.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
    || !path.isAbsolute(input.cwd)) {
    throw new Error('Codex sandbox command input is invalid.');
  }

  const workerEnv: NodeJS.ProcessEnv = {};
  for (const name of DETACHED_COMMAND_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) {
      workerEnv[name] = process.env[name];
    }
  }

  const connection = await codexAppServerTransport.open({}, { inheritEnv: false, env: workerEnv });
  try {
    input.onStarted?.();
    const response = readObjectRecord(await connection.call('command/exec', {
      command: input.command,
      cwd: input.cwd,
      sandboxPolicy: input.sandboxPolicy,
      env: Object.fromEntries(TASK_CREDENTIAL_ENV_NAMES.map((name) => [name, null])),
      timeoutMs: DETACHED_COMMAND_TIMEOUT_MS,
    }, { timeoutMs: DETACHED_COMMAND_TIMEOUT_MS }));
    const exitCode = response?.exitCode;
    if (!Number.isSafeInteger(exitCode)) {
      throw new Error('Codex command/exec returned no valid exit code.');
    }
    return {
      exitCode: exitCode as number,
      stdout: typeof response?.stdout === 'string' ? response.stdout : '',
      stderr: typeof response?.stderr === 'string' ? response.stderr : '',
    };
  } finally {
    connection.close();
  }
}

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
        // A run settles its own agents when its turn ends; this only drops
        // entries a run that never reached its end left behind.
        codexBackgroundWork.clearSession(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

// Runtime cleanup should not keep focused tests or one-off scripts alive after
// their provider work has completed.
completedSessionCleanupTimer.unref?.();
