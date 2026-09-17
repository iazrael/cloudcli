import fsSync from 'node:fs';

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

import { getOpenCodeDatabasePath } from './opencode-data-root.js';
import {
  abortOpenCodeSession as abortOpenCodeServerSession,
  acquireOpenCodeServer,
  createOpenCodeSession,
  releaseOpenCodeServer,
  resolveOpenCodeAgent,
  sendOpenCodeMessage,
  subscribeOpenCodeEvents,
} from './opencode-server.client.js';
import {
  announceOpenCodePermission,
  announceOpenCodeQuestion,
  openCodePermissions,
  registerOpenCodeRun,
  settleOpenCodeEvent,
  unregisterOpenCodeRun,
} from './opencode-permissions.provider.js';

/**
 * Active runs keyed by both the app session id and the provider-native session
 * id, so `chat.abort` (which addresses the app id) always finds the run.
 */
const activeRuns = new Map();

function readEventSessionId(event) {
  return readOptionalString(event.properties.sessionID);
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
    const columns = db.prepare('PRAGMA table_info(session)').all();
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return null;
    }

    const row = db.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(sessionId);

    if (!row) {
      return null;
    }

    const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
    const outputTokens = Number(row.outputTokens || 0);
    const used = Number(row.inputTokens || 0)
      + outputTokens
      + Number(row.reasoningTokens || 0)
      + Number(row.cacheReadTokens || 0)
      + Number(row.cacheWriteTokens || 0);
    if (used <= 0) {
      return null;
    }

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * Runs one OpenCode turn against the shared `opencode serve` instance.
 *
 * The CLI's `run` mode cannot surface tool approvals: in non-interactive mode
 * it rejects every `ask` rule itself, so a permission request can never reach
 * the chat. The runtime therefore drives the server's own session/message API
 * and consumes its event stream instead. Live output is normalized through the
 * same `sessions` provider as history, and `permission.asked`/`question.asked`
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
    userMessageIds: new Set(),
    assistantMessageIds: new Set(),
    partTypes: new Map(),
    deltaPartIds: new Set(),
  };

  activeRuns.set(runId, run);
  if (run.providerSessionId) {
    activeRuns.set(run.providerSessionId, run);
  }
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

    if (partType === 'tool') {
      // Flat envelope: the sessions normalizer reads tool calls off the event
      // itself, so no provider-specific `part` nesting is needed.
      const state = readObjectRecord(part.state) ?? {};
      emitNormalized({
        type: 'tool_use',
        id: partId,
        sessionID: run.providerSessionId,
        tool: readOptionalString(part.tool) ?? 'Tool',
        callID: readOptionalString(part.callID),
        input: state.input ?? part.input ?? {},
        output: state.output ?? part.output,
        error: state.error ?? part.error,
      });
      return;
    }

    if (partType === 'step-finish') {
      emitNormalized({ type: 'step_finish', id: partId, sessionID: run.providerSessionId });
      return;
    }

    // Text and reasoning only stream for the assistant message; tool and
    // step-finish parts are assistant-only by construction.
    const isContentPart = partType === 'text' || partType === 'reasoning';
    if (!isContentPart) {
      return;
    }
    if (messageId && !run.assistantMessageIds.has(messageId)) {
      return;
    }

    // Some turns deliver no `message.part.delta` for a text/reasoning part; fall
    // back to the completed part's full text so nothing is silently dropped.
    if (partId) {
      const time = readObjectRecord(part.time) ?? {};
      const completed = time.end !== undefined && time.end !== null;
      if (completed && !run.deltaPartIds.has(partId) && typeof part.text === 'string' && part.text.trim()) {
        emitNormalized({ type: partType, id: partId, sessionID: run.providerSessionId, text: part.text });
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
    if (messageId && (!run.assistantMessageIds.has(messageId) || run.userMessageIds.has(messageId))) {
      return;
    }

    run.deltaPartIds.add(partId);
    const kind = run.partTypes.get(partId) === 'reasoning' ? 'reasoning' : 'text';
    emitNormalized({ type: kind, id: partId, sessionID: run.providerSessionId, text: delta });
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
    // text part must stay newline-free for the Windows shim.
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
      failure = error;
      const installed = await context.isProviderInstalled();
      const content = !installed
        ? 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/'
        : (error instanceof Error ? error.message : String(error));
      sendError(content);
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

      // OpenCode's own database is keyed by the provider-native id.
      const tokenBudget = readOpenCodeTokenUsage(run.providerSessionId);
      if (tokenBudget) {
        ws.send(createNormalizedMessage({
          kind: 'status',
          text: 'token_budget',
          tokenBudget,
          sessionId: run.appSessionId || run.providerSessionId || runId,
          provider: 'opencode',
        }));
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

export const opencodeRuntime = {
  run: spawnOpenCode,
  abort: abortOpenCodeSession,
  permissions: openCodePermissions,
};

export {
  spawnOpenCode,
  abortOpenCodeSession,
  isOpenCodeSessionActive,
  getActiveOpenCodeSessions,
};
