import fsSync from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

import crossSpawn from 'cross-spawn';
import Database from 'better-sqlite3';

import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors
} from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  flattenPromptForWindowsShell,
  readObjectRecord,
  readOptionalString,
  resolveModelEffort
} from '@/shared/utils.js';

import { readOpenCodeContextUsage } from './opencode-context-usage.js';
import { getOpenCodeDatabasePath } from './opencode-data-root.js';
import { openCodeFetch } from './opencode-http.client.js';
import {
  abortOpenCodeSession as abortOpenCodeServerSession,
  acquireOpenCodeServer,
  createOpenCodeSession,
  getOpenCodeSessionStatus,
  releaseOpenCodeServer,
  resolveOpenCodeAgent,
  sendOpenCodeMessage,
  subscribeOpenCodeEvents,
  waitForOpenCodeSessionIdle,
} from './opencode-server.client.js';
import {
  announceOpenCodePermission,
  announceOpenCodeQuestion,
  openCodePermissions,
  registerOpenCodeRun,
  settleOpenCodeEvent,
  unregisterOpenCodeRun,
} from './opencode-permissions.provider.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

/**
 * Active runs keyed by both the app session id and the provider-native session
 * id, so `chat.abort` (which addresses the app id) always finds the run.
 */
const activeRuns = new Map();

/**
 * Shortest gap between two mid-turn context-usage reads.
 *
 * OpenCode only reports usage when the whole run ends, so a long tool-heavy
 * turn needs the runtime to publish it mid-turn (see `publishLiveTokenBudget`).
 * Each read opens `opencode.db` and walks the session's message rows, so it
 * must not run on every streamed message update.
 */
const LIVE_CONTEXT_MIN_INTERVAL_MS = 1_500;

/**
 * Kills a spawned CLI process and everything it started.
 *
 * `cross-spawn` resolves `opencode` through the Windows `.cmd` shim, so the
 * handle it hands back is cmd.exe: killing that leaves the real opencode.exe
 * (and any server it hosts) running, holding the port and the project
 * instance. `taskkill /T` walks the whole tree; POSIX children take the
 * signal directly.
 */
function killProcessTree(child) {
  if (!child) {
    return;
  }

  if (process.platform === 'win32' && child.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch {
      // Fall through to the plain kill.
    }
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
}

function readEventSessionId(event) {
  return readOptionalString(event.properties.sessionID);
}

function readEventToolCallId(event) {
  return readOptionalString(readObjectRecord(event.properties.tool)?.callID);
}

/**
 * Splits the catalog's `<providerID>/<modelID>` value into the two halves the
 * OpenCode server expects. The model id may itself contain slashes (e.g.
 * `openrouter/anthropic/claude-3`), so only the first separator is consumed.
 */
function splitProviderModel(resolvedModel) {
  if (!resolvedModel || typeof resolvedModel !== 'string') {
    return null;
  }

  const separator = resolvedModel.indexOf('/');
  if (separator <= 0 || separator === resolvedModel.length - 1) {
    return null;
  }

  return {
    providerId: resolvedModel.slice(0, separator),
    modelId: resolvedModel.slice(separator + 1),
  };
}

function readOpenCodeTokenUsage(sessionId) {
  const dbPath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return readOpenCodeContextUsage(db, sessionId) || null;
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * Decides whether a dropped prompt request should fail the run or keep waiting.
 *
 * The blocking `POST /session/:id/message` holds a socket for the whole turn and
 * can lose it (idle timeout, proxy, process hiccup) while the engine keeps
 * executing. When the session is still busy/retrying, wait for it to go idle so
 * the run finishes normally instead of surfacing a spurious transport error.
 * Returns false when the server is unreachable or the session is already done,
 * so the caller can fail the run for real. Consumers: `spawnOpenCode`'s
 * send-failure path.
 */
async function resumeOpenCodeRun(run, workingDir) {
  if (!run.providerSessionId) {
    return false;
  }

  try {
    const status = await getOpenCodeSessionStatus(run.handle, workingDir, run.providerSessionId);
    if (status !== 'busy' && status !== 'retry') {
      return false;
    }
    await waitForOpenCodeSessionIdle(run.handle, workingDir, run.providerSessionId);
    return true;
  } catch (error) {
    console.warn('[OpenCode] Could not confirm the dropped turn is still running:', error);
    return false;
  }
}

/**
 * Runs one OpenCode turn against the shared `opencode serve` instance.
 *
 * The CLI's `run` mode cannot surface tool approvals (it auto-rejects every
 * `ask` rule), so the runtime drives the server's own session/message API and
 * consumes its event stream instead. Live output is normalized through the same
 * `sessions` provider as history, and `permission.asked`/`question.asked`
 * events become approval cards through the permissions bridge.
 */
async function spawnOpenCode(command, options = {}, ws, context) {
  const {
    sessionId,
    projectPath,
    cwd,
    model,
    effort,
    sessionSummary,
    images,
    files,
    permissionMode
  } = options;
  // Callers pass the stable app session id; the server resumes with the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  const workingDir = cwd || projectPath || process.cwd();
  const runId = sessionId || `opencode-${Date.now()}`;

  let effortModels = null;
  try {
    effortModels = await context.getProviderModels();
  } catch (error) {
    console.warn('[OpenCode] Unable to load provider models for effort validation:', error);
  }

  const resolvedModel = await context.resolveResumeModel(sessionId, model);
  const resolvedEffort = resolveModelEffort(resolvedModel, effort, effortModels);
  const parsedModel = splitProviderModel(resolvedModel);
  const agent = resolveOpenCodeAgent(permissionMode);

  const handle = await acquireOpenCodeServer();

  const run = {
    runId,
    appSessionId: sessionId || null,
    providerSessionId: providerSessionId || '',
    directory: workingDir,
    handle,
    writer: ws,
    permissionMode,
    aborted: false,
    completeSent: false,
    terminalNotified: false,
    /** Timestamp of the last mid-turn context read, and the occupancy it published. */
    contextPublishedAt: 0,
    publishedContextUsed: null,
    userMessageIds: new Set(),
    assistantMessageIds: new Set(),
    partTypes: new Map(),
    deltaPartIds: new Set(),
  };

  const indexRun = () => {
    activeRuns.set(runId, run);
    if (run.providerSessionId) {
      activeRuns.set(run.providerSessionId, run);
    }
  };
  indexRun();
  registerOpenCodeRun(run);

  const notifyTerminalState = ({ error = null } = {}) => {
    if (run.terminalNotified) {
      return;
    }
    run.terminalNotified = true;

    const finalSessionId = run.appSessionId || run.providerSessionId || runId;
    if (!error) {
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'opencode',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        stopReason: 'completed',
      });
      return;
    }

    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'opencode',
      sessionId: finalSessionId,
      sessionName: sessionSummary,
      error,
    });
  };

  const sendError = (content) => {
    ws.send(createNormalizedMessage({
      kind: 'error',
      content,
      sessionId: run.providerSessionId || run.appSessionId || null,
      provider: 'opencode',
    }));
  };

  const sendTokenBudget = (tokenBudget) => {
    ws.send(createNormalizedMessage({
      kind: 'status',
      text: 'token_budget',
      tokenBudget,
      sessionId: run.appSessionId || run.providerSessionId || runId,
      provider: 'opencode',
    }));
  };

  /**
   * Publishes the session's context occupancy while the turn is still running.
   *
   * OpenCode only reports usage when the whole run ends, so without this the
   * composer's context badge stayed frozen for the entire tool loop. Message
   * updates arrive as each step closes and its usage is persisted, so each one
   * re-reads opencode.db — rate-limited, and skipped when the occupancy has
   * not moved since the last frame. The payload is what `/token-usage`
   * returns, so the live badge and a reloaded transcript cannot disagree.
   */
  const publishLiveTokenBudget = () => {
    if (run.aborted || run.completeSent || !run.providerSessionId) {
      return;
    }

    const now = Date.now();
    if (now - run.contextPublishedAt < LIVE_CONTEXT_MIN_INTERVAL_MS) {
      return;
    }
    run.contextPublishedAt = now;

    const tokenBudget = readOpenCodeTokenUsage(run.providerSessionId);
    const used = Number(tokenBudget?.used ?? 0);
    if (!tokenBudget || used <= 0 || used === run.publishedContextUsed) {
      return;
    }

    run.publishedContextUsed = used;
    sendTokenBudget(tokenBudget);
  };

  const registerProviderSession = (nextSessionId) => {
    if (!nextSessionId || run.providerSessionId === nextSessionId) {
      return;
    }

    run.providerSessionId = nextSessionId;
    activeRuns.set(nextSessionId, run);

    if (ws.setSessionId && typeof ws.setSessionId === 'function') {
      ws.setSessionId(nextSessionId);
    }

    if (!providerSessionId) {
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: nextSessionId,
        sessionId: nextSessionId,
        provider: 'opencode',
      }));
    }
  };

  const emitNormalized = (raw) => {
    let normalized;
    try {
      normalized = context.normalizeMessage(raw, run.providerSessionId || run.appSessionId || null);
    } catch (error) {
      console.error('[OpenCode] Failed to normalize server event:', error);
      return;
    }

    for (const message of normalized) {
      ws.send(message);
    }
  };

  const handlePartUpdated = (event) => {
    const part = readObjectRecord(event.properties.part);
    if (!part) {
      return;
    }

    const partId = readOptionalString(part.id);
    const partType = readOptionalString(part.type);
    const messageId = readOptionalString(part.messageID);

    if (partId && partType) {
      run.partTypes.set(partId, partType);
    }

    if (messageId && run.userMessageIds.has(messageId)) {
      return;
    }

    // Text and reasoning only stream for the assistant message; tool and
    // step-finish parts are assistant-only by construction.
    const isContentPart = partType === 'text' || partType === 'reasoning';
    if (isContentPart && messageId && !run.assistantMessageIds.has(messageId)) {
      return;
    }

    if (partType === 'tool') {
      emitNormalized({ type: 'tool_use', id: partId, sessionID: run.providerSessionId, part });
      return;
    }

    if (partType === 'step-finish') {
      emitNormalized({ type: 'step_finish', id: partId, sessionID: run.providerSessionId });
      // A step closing is the earliest point its usage can be read back, so
      // the composer's badge moves with the tool loop instead of at `complete`.
      publishLiveTokenBudget();
      return;
    }

    // Some turns deliver no `message.part.delta` for a text/reasoning part; fall
    // back to the completed part's full text so nothing is silently dropped.
    if ((partType === 'text' || partType === 'reasoning') && partId) {
      const time = readObjectRecord(part.time) ?? {};
      const completed = time.end !== undefined && time.end !== null;
      if (completed && !run.deltaPartIds.has(partId) && typeof part.text === 'string' && part.text.trim()) {
        emitNormalized({ type: partType, id: partId, partID: partId, sessionID: run.providerSessionId, text: part.text, messageID: messageId });
      }
    }
  };

  const handlePartDelta = (event) => {
    const partId = readOptionalString(event.properties.partID);
    const messageId = readOptionalString(event.properties.messageID);
    const field = readOptionalString(event.properties.field);
    const delta = typeof event.properties.delta === 'string' ? event.properties.delta : '';

    if (!partId || !delta || field !== 'text') {
      return;
    }

    if (messageId && run.userMessageIds.has(messageId)) {
      return;
    }
    if (messageId && !run.assistantMessageIds.has(messageId)) {
      return;
    }

    run.deltaPartIds.add(partId);
    const kind = run.partTypes.get(partId) === 'reasoning' ? 'reasoning' : 'text';
    // `partID` is what the persisted row is reconciled through: the streamed
    // text has no row id of its own, so the part is the identity both paths
    // share (see buildOpenCodeTextRowKey).
    emitNormalized({ type: kind, id: partId, partID: partId, sessionID: run.providerSessionId, text: delta, messageID: messageId });
  };

  const handleMessageUpdated = (event) => {
    const info = readObjectRecord(event.properties.info);
    const role = readOptionalString(info?.role);
    const id = readOptionalString(info?.id);
    if (!id) {
      return;
    }
    if (role === 'user') {
      run.userMessageIds.add(id);
    } else if (role === 'assistant') {
      run.assistantMessageIds.add(id);
      // Each step's usage lands with its message update; refresh the badge
      // without waiting for the whole run to finish.
      publishLiveTokenBudget();
    }
  };

  const handleRunEvent = (event) => {
    switch (event.type) {
      case 'permission.asked':
        announceOpenCodePermission(run, event);
        return;
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected':
        settleOpenCodeEvent(event);
        return;
      case 'question.asked':
        announceOpenCodeQuestion(run, event);
        return;
      case 'message.part.updated':
        handlePartUpdated(event);
        return;
      case 'message.part.delta':
        handlePartDelta(event);
        return;
      case 'message.updated':
        handleMessageUpdated(event);
        return;
      case 'session.error': {
        const errorRecord = readObjectRecord(event.properties.error) ?? {};
        const message = readOptionalString(readObjectRecord(errorRecord.data)?.message)
          ?? readOptionalString(errorRecord.message)
          ?? readOptionalString(errorRecord.name)
          ?? 'OpenCode reported an error';
        sendError(message);
        return;
      }
      default:
        return;
    }
  };

  const unsubscribe = subscribeOpenCodeEvents((event) => {
    if (!run.providerSessionId) {
      return;
    }
    if (readEventSessionId(event) !== run.providerSessionId) {
      return;
    }
    try {
      handleRunEvent(event);
    } catch (error) {
      console.error('[OpenCode] Failed to handle server event:', error);
    }
  });

  let failure = null;

  try {
    if (!run.providerSessionId) {
      const createdSessionId = await createOpenCodeSession(handle, workingDir, parsedModel, agent);
      registerProviderSession(createdSessionId);
    }

    const hasAttachments =
      normalizeAttachmentDescriptors(images).length > 0
      || normalizeAttachmentDescriptors(files).length > 0;
    // Image attachments ride along as an <images_input> path list appended to the
    // prompt; the session history reader strips the tag back out. The server's
    // text part must stay newline-free-free for the Windows shim.
    const prompt = (command && command.trim()) || hasAttachments
      ? appendFilesInputTag(appendImagesInputTag(command?.trim() || '', images), files)
      : '';

    await sendOpenCodeMessage(handle, workingDir, run.providerSessionId, {
      text: flattenPromptForWindowsShell(prompt),
      model: parsedModel,
      agent,
      variant: resolvedEffort || undefined,
    });
  } catch (error) {
    if (!run.aborted) {
      // A dropped prompt socket does not mean the turn died: the engine often
      // keeps going. Only fail the run when it truly is not running anymore.
      const resumed = await resumeOpenCodeRun(run, workingDir);
      if (!resumed) {
        failure = error;
        const installed = await context.isProviderInstalled();
        const content = !installed
          ? 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/'
          : (error instanceof Error ? error.message : String(error));
        sendError(content);
      }
    }
  } finally {
    unsubscribe();
    unregisterOpenCodeRun(runId);
    activeRuns.delete(runId);
    if (run.providerSessionId) {
      activeRuns.delete(run.providerSessionId);
    }
    releaseOpenCodeServer();

    if (!run.aborted && !run.completeSent) {
      run.completeSent = true;
      const tokenBudget = readOpenCodeTokenUsage(run.providerSessionId);
      if (tokenBudget) {
        sendTokenBudget(tokenBudget);
      }

      ws.send(createCompleteMessage({
        provider: 'opencode',
        sessionId: run.appSessionId || run.providerSessionId || runId,
        actualSessionId: run.providerSessionId || undefined,
        exitCode: failure ? 1 : 0,
      }));
      notifyTerminalState({ error: failure });
    }
  }

  if (failure) {
    throw failure;
  }
}

/**
 * Cancels the run for one session. The chat gateway emits the terminal
 * `complete` on the aborted run's behalf, so this only stops the engine.
 */
async function abortOpenCodeSession(sessionId) {
  const run = activeRuns.get(sessionId);
  if (!run) {
    return false;
  }

  run.aborted = true;
  if (run.providerSessionId) {
    await abortOpenCodeServerSession(run.handle, run.directory, run.providerSessionId);
  }
  return true;
}

function isOpenCodeSessionActive(sessionId) {
  return activeRuns.has(sessionId);
}

function getActiveOpenCodeSessions() {
  return Array.from(new Set(Array.from(activeRuns.values()).map((run) => run.runId)));
}

/**
 * Compacts a stored OpenCode conversation in place.
 *
 * The shared server exposes the primitive the TUI itself uses:
 * `POST /session/:id/summarize`. This spawns a short-lived headless server,
 * calls that endpoint with the session's own model, and tears the server down.
 * The endpoint runs OpenCode's whole compaction loop, so the next history
 * refresh shows the summary.
 */
function readOpenCodeSessionModel(sessionId) {
  const dbPath = getOpenCodeDatabasePath();
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT model FROM session WHERE id = ?').get(sessionId);
    if (!row || typeof row.model !== 'string') {
      return null;
    }

    const parsed = JSON.parse(row.model);
    const providerId = typeof parsed?.providerID === 'string' ? parsed.providerID : null;
    const modelId = typeof parsed?.id === 'string' ? parsed.id : null;
    return providerId && modelId ? { providerId, modelId } : null;
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/** Picks a free loopback port for the short-lived compaction server. */
function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
          return;
        }
        reject(new Error('Could not reserve a loopback port for OpenCode compaction.'));
      });
    });
  });
}

/** Basic-auth header for `opencode serve` when the user secured it. */
function openCodeServerAuthHeaders() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) {
    return {};
  }

  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  };
}

const COMPACT_SERVER_READY_TIMEOUT_MS = 20_000;
// A summarize of a large context can outlive undici's default five-minute
// transport cap; the shared openCodeFetch agent carries the request instead.
const COMPACT_REQUEST_TIMEOUT_MS = 30 * 60_000;

async function waitForOpenCodeServer(baseUrl, headers, serverProcess) {
  const deadline = Date.now() + COMPACT_SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`OpenCode server exited before it was ready (code ${serverProcess.exitCode}).`);
    }

    try {
      const response = await openCodeFetch(`${baseUrl}/config`, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('OpenCode server did not become ready in time.');
}

async function compactOpenCodeSession(options = {}, ws, context) {
  const { sessionId } = options;
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  if (!sessionId || !providerSessionId) {
    throw new Error('This OpenCode session has no stored conversation to compact yet.');
  }

  const model = readOpenCodeSessionModel(providerSessionId);
  if (!model) {
    throw new Error('OpenCode did not report a model for this session, so it cannot be compacted.');
  }

  const workingDir = options.cwd || options.projectPath || process.cwd();
  ws.send(createNormalizedMessage({
    kind: 'status',
    text: 'Compacting context…',
    canInterrupt: false,
    sessionId,
    provider: 'opencode',
  }));

  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', ...openCodeServerAuthHeaders() };
  const serverProcess = spawnFunction('opencode', ['serve', '--port', String(port)], {
    cwd: workingDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  });

  let stderrTail = '';
  serverProcess.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-1000);
  });
  // The server's stdout is noise for this one request; drain it so the pipe
  // never back-pressures the child.
  serverProcess.stdout?.on('data', () => {});

  try {
    await waitForOpenCodeServer(baseUrl, headers, serverProcess);

    const response = await openCodeFetch(`${baseUrl}/session/${encodeURIComponent(providerSessionId)}/summarize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerID: model.providerId, modelID: model.modelId, auto: false }),
      signal: AbortSignal.timeout(COMPACT_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const suffix = detail.trim() ? `: ${detail.trim().slice(0, 300)}` : '';
      throw new Error(`OpenCode refused to compact this session (HTTP ${response.status})${suffix}`);
    }

    return true;
  } catch (error) {
    if (stderrTail.trim()) {
      console.warn(`[OpenCode] Compaction server stderr: ${stderrTail.trim().split('\n').slice(-1)[0]}`);
    }
    throw error;
  } finally {
    killProcessTree(serverProcess);
  }
}

export const opencodeRuntime = {
  run: spawnOpenCode,
  abort: abortOpenCodeSession,
  compact: compactOpenCodeSession,
  permissions: openCodePermissions,
};

export {
  spawnOpenCode,
  abortOpenCodeSession,
  compactOpenCodeSession,
  isOpenCodeSessionActive,
  getActiveOpenCodeSessions,
};
