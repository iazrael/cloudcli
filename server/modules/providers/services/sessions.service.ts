import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { broadcastSessionRemoved, broadcastSessionUpserted, chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import { listBusyClaudeCliSessions } from '@/modules/providers/services/claude-cli-liveness.service.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import type {
  BackgroundTaskSummary,
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
  WorkflowAgentActivity,
} from '@/shared/types.js';
import {
  AppError,
  normalizeProjectPath,
  removePathIfExists,
  sliceTailPage,
} from '@/shared/utils.js';

/**
 * One session the running-sessions poll reports as busy.
 *
 * A chat run in progress is listed as before. A session whose turn has ended
 * but whose engine still works in it — background tasks, or a report turn the
 * engine started on its own — is listed with `background: true`: the composer
 * stays usable (the runtime accepts a new turn while the work runs). There is
 * no run to abort, so `canInterrupt` is what the runtime's
 * `backgroundTasks.canInterrupt` says `chat.abort` can still stop (false when
 * the runtime does not say); a task is stopped by id through `chat.stop-task`.
 * `tasks` rides along on both kinds whenever the session has any.
 *
 * A turn driven outside CloudCLI — the Claude CLI in the Shell view, or a
 * terminal the user opened themselves — is listed the same way, with
 * `canInterrupt: false` because there is no run here to abort, and a
 * `statusText` saying where the work is happening.
 */
type RunningSessionEntry = {
  sessionId: string;
  provider: LLMProvider;
  startedAt: number;
  lastSeq: number;
  background?: true;
  canInterrupt?: boolean;
  statusText?: string;
  tasks?: BackgroundTaskSummary[];
  /**
   * The round was submitted and the engine has not started its turn yet, so
   * the conversation is waiting for the engine rather than working.
   */
  queued?: boolean;
  /** The engine is running a turn of its own, such as a background report. */
  reporting?: boolean;
};

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
  sessionName: string;
};

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

type RecentSessionListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity'
> & {
  /** True when the user pinned the session; the feed already lists pinned rows first. */
  isPinned: boolean;
};

type RecentSessionsPage = {
  conversations: RecentSessionListItem[];
  total: number;
  hasMore: boolean;
};

type SessionDetails = {
  /** Canonical app-facing session id (may differ from the looked-up id when a provider-native id was given). */
  sessionId: string;
  provider: LLMProvider;
  summary: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isArchived: boolean;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
    isArchived: boolean;
  } | null;
};

const MAX_CLOUDCLI_SESSION_NAME_CHARS = 40;

/**
 * How long a `clientRequestId` keeps pointing at the session it allocated.
 *
 * Long enough to absorb every duplicate that a single user action can produce
 * (double click, retried fetch, a second tab replaying the same submit), short
 * enough that the map stays a handful of entries.
 */
const CREATE_SESSION_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

/**
 * Sessions already allocated for a `clientRequestId`, keyed by that id.
 *
 * The composer cannot allocate a session id itself (the id must be
 * database-backed before the first `chat.send`), so a send that is submitted
 * twice would otherwise open two conversations for one message. The client
 * stamps one id per submit attempt and this map turns every repeat of that
 * attempt into the same answer.
 */
const createdSessionsByClientRequestId = new Map<string, { result: CreateAppSessionResult; expiresAt: number }>();

function readIdempotentSession(clientRequestId: string, now: number): CreateAppSessionResult | null {
  const recorded = createdSessionsByClientRequestId.get(clientRequestId);
  if (!recorded) {
    return null;
  }
  if (recorded.expiresAt <= now) {
    createdSessionsByClientRequestId.delete(clientRequestId);
    return null;
  }
  // The recorded session can be deleted inside the TTL window; replaying a row
  // that no longer exists would send the user to a dead conversation, so the
  // request falls through and allocates a fresh one.
  if (!sessionsDb.getSessionById(recorded.result.sessionId)) {
    createdSessionsByClientRequestId.delete(clientRequestId);
    return null;
  }
  return recorded.result;
}

function rememberIdempotentSession(clientRequestId: string, result: CreateAppSessionResult, now: number): void {
  // Expired entries are dropped on write so the map never outgrows the
  // requests actually in flight; there is no separate sweep timer.
  for (const [key, recorded] of createdSessionsByClientRequestId) {
    if (recorded.expiresAt <= now) {
      createdSessionsByClientRequestId.delete(key);
    }
  }
  createdSessionsByClientRequestId.set(clientRequestId, {
    result,
    expiresAt: now + CREATE_SESSION_IDEMPOTENCY_TTL_MS,
  });
}

/**
 * Derives the initial session name from the first message: the first sentence
 * (first line when it has no terminator), capped in length. Word-splitting is
 * not usable here — Chinese text has no spaces, so the old word-based rule
 * turned a whole message into the title.
 */
function buildCloudCliSessionName(initialMessage: string): string {
  const firstLine = initialMessage
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  // Leading terminators describe nothing ("？？？为什么崩" is about the crash),
  // and would otherwise cut the first sentence to nothing. The Latin period is
  // left out on purpose: "1." and "e.g." would otherwise gut the name.
  const stripped = firstLine.replace(/^[。？！；?!;\s]+/, '');
  const [firstSentence] = (stripped || firstLine).split(/[。？！；?!;]/);
  return (firstSentence ?? '').trim().slice(0, MAX_CLOUDCLI_SESSION_NAME_CHARS)
    || 'Untitled Session';
}

/**
 * Removes provider-native files and storage records when a session is hard-deleted.
 */
async function cleanupProviderNativeSession(session: {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  jsonl_path: string | null;
  project_path: string | null;
}): Promise<boolean> {
  let removed = false;
  const nativeSessionId = session.provider_session_id || session.session_id;

  try {
    const provider = providerRegistry.resolveProvider(session.provider);
    if (provider.sessions.cleanupSession) {
      removed = await provider.sessions.cleanupSession(nativeSessionId, session.jsonl_path);
    } else if (session.jsonl_path) {
      removed = await removePathIfExists(session.jsonl_path);
    }
  } catch {
    if (session.jsonl_path) {
      removed = await removePathIfExists(session.jsonl_path);
    }
  }

  return removed;
}

/**
 * Cleans up provider-native storage (transcripts, brain directories, summary DB rows)
 * for an entire project path when a project is permanently deleted.
 */
async function cleanupProviderProjectStorage(projectPath: string): Promise<void> {
  const normalizedPath = normalizeProjectPath(projectPath);
  if (!normalizedPath || normalizedPath === path.parse(normalizedPath).root) {
    return;
  }

  const providers = providerRegistry.listProviders();
  for (const provider of providers) {
    try {
      if (provider.sessions.cleanupProjectStorage) {
        await provider.sessions.cleanupProjectStorage(normalizedPath);
      }
    } catch (err) {
      console.warn(`[SessionsService] Failed to clean up ${provider.id} project storage:`, err);
    }
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Archives or permanently deletes a session whose work is over.
 *
 * The caller has already closed the admission and checked that nothing is
 * running, so this only performs the action and reports it.
 */
async function archiveOrDeleteResolvedSession(
  session: {
    session_id: string;
    provider: string;
    provider_session_id: string | null;
    jsonl_path: string | null;
    project_path: string | null;
  },
  resolvedSessionId: string,
  options: { force?: boolean; deletedFromDisk?: boolean },
): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
  if (!options.force) {
    sessionsDb.updateSessionIsArchived(resolvedSessionId, true);
    // The initiating client cleans up its own list; the broadcast is for the
    // other connected clients (idempotent for the initiator).
    broadcastSessionRemoved([resolvedSessionId]);
    return {
      sessionId: resolvedSessionId,
      action: 'archived',
      deletedFromDisk: false,
    };
  }

  let removedFromDisk = false;
  if (options.deletedFromDisk) {
    removedFromDisk = await cleanupProviderNativeSession(session);
    // Every file the conversation has lived in, not just the one the row
    // points at now: editing a message on a provider that rewinds by
    // branching moves the session onto a copy and leaves the earlier
    // transcript behind. Deleting only the current one would leave the
    // replaced turns on disk, and unreachable through the app.
    const transcripts = [
      ...(session.jsonl_path ? [session.jsonl_path] : []),
      ...sessionsDb.getSupersededTranscriptPaths(resolvedSessionId),
    ];
    for (const transcript of transcripts) {
      removedFromDisk = (await removePathIfExists(transcript)) || removedFromDisk;
    }
  }

  sessionsDb.clearSupersededProviderSessions(resolvedSessionId);
  const deleted = sessionsDb.deleteSessionById(resolvedSessionId);
  if (!deleted) {
    throw new AppError(`Session "${resolvedSessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }

  broadcastSessionRemoved([resolvedSessionId]);
  return {
    sessionId: resolvedSessionId,
    action: 'deleted',
    deletedFromDisk: removedFromDisk,
  };
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing,
   * plus every session whose background work outlived its turn.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  async listRunningSessions(): Promise<RunningSessionEntry[]> {
    const entries: RunningSessionEntry[] = chatRunRegistry.listRunningRuns();
    const runningById = new Map(entries.map((entry) => [entry.sessionId, entry]));

    for (const provider of providerRegistry.listProviders()) {
      for (const { sessionId, tasks, startedAt } of provider.runtime.listBackgroundWork?.() ?? []) {
        const running = runningById.get(sessionId);
        if (running) {
          running.tasks = tasks;
          continue;
        }
        entries.push({
          sessionId,
          provider: provider.id,
          startedAt: tasks.length ? Math.min(...tasks.map((task) => task.startedAt))
            : startedAt ?? chatRunRegistry.getRun(sessionId)?.startedAt ?? Date.now(),
          // The completed run stays in the registry for a while, and a client
          // that subscribes with its lastSeq replays the tail it missed.
          lastSeq: chatRunRegistry.getRun(sessionId)?.lastSeq ?? 0,
          background: true,
          // Only the runtime knows whether `abort` can still reach this work
          // (an OpenCode report turn can be stopped, a lone command cannot).
          canInterrupt: provider.runtime.backgroundTasks?.canInterrupt?.(sessionId) ?? false,
          tasks,
        });
      }
    }

    // The chat-run registry only knows about turns CloudCLI drives itself, so
    // without this a session working under the Claude CLI — including one
    // CloudCLI spawned for its own Shell view — looks idle. A session already
    // listed above keeps its richer entry.
    for (const live of await listBusyClaudeCliSessions()) {
      const session = sessionsDb.getSessionByProviderSessionId(live.providerSessionId);
      if (!session || runningById.has(session.session_id)) {
        continue;
      }

      entries.push({
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        startedAt: live.startedAt,
        lastSeq: chatRunRegistry.getRun(session.session_id)?.lastSeq ?? 0,
        // There is no run here to abort: the turn belongs to a CLI process
        // CloudCLI does not own, so it can be reported but not interrupted.
        canInterrupt: false,
        statusText: 'Running in the Claude CLI',
      });
      runningById.set(session.session_id, entries[entries.length - 1]);
    }

    // The engine is the only one that knows whether it picked a queued input
    // up, so the entry says whether the conversation is waiting for the engine
    // or working on the round.
    return entries.map((entry) => {
      const activity = providerRuntimeService.getSessionActivity(entry.sessionId);
      if (!activity) {
        return entry;
      }
      return { ...entry, queued: activity.queued, reporting: activity.reporting };
    });
  },

  /**
   * Returns the active conversation feed in true global activity order.
   */
  listRecentSessions(limit: number, offset: number): RecentSessionsPage {
    const page = sessionsDb.getRecentSessionsPage(limit, offset);
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    const conversations = page.sessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isPinned: Boolean(session.isPinned),
      };
    });

    return {
      conversations,
      total: page.total,
      hasMore: offset + conversations.length < page.total,
    };
  },

  /**
   * Resolves the provider-native session id a runtime needs for resume.
   *
   * Callers hand provider runtimes the stable app session id; the provider
   * CLIs/SDKs only understand their own native id, which lives on the session
   * row. Ids without a row are assumed to be provider-native already (direct
   * API callers that reference sessions the watcher has not indexed yet).
   */
  resolveProviderSessionId(sessionId: string | null | undefined): string | null {
    if (!sessionId) {
      return null;
    }

    const session = sessionsDb.getSessionById(sessionId);
    return session ? session.provider_session_id : sessionId;
  },

  /**
   * The engine transcript recorded for an app session, or null before the
   * session synchronizer has indexed it.
   */
  resolveTranscriptPath(sessionId: string): string | null {
    return sessionsDb.getSessionById(sessionId)?.jsonl_path ?? null;
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run. Its title
   * comes directly from the first visible CloudCLI message — its first
   * sentence, capped — and stays followable: once the engine generates its own
   * title, a later synchronizer pass replaces this one (unless the user
   * renames the session).
   */
  createAppSession(
    provider: LLMProvider,
    projectPath: string,
    initialMessage: string,
    options: { clientRequestId?: string | null } = {},
  ): CreateAppSessionResult {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    // One submit attempt may reach this route several times (double click,
    // fetch retry, a duplicate frame from another tab). Replaying the first
    // answer is what keeps one message from opening several conversations.
    const clientRequestId = options.clientRequestId?.trim() || null;
    const now = Date.now();
    if (clientRequestId) {
      const alreadyCreated = readIdempotentSession(clientRequestId, now);
      if (alreadyCreated) {
        return alreadyCreated;
      }
    }

    const sessionId = randomUUID();
    const sessionName = buildCloudCliSessionName(initialMessage);
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath, sessionName);

    const result: CreateAppSessionResult = {
      sessionId,
      provider,
      projectPath: normalizedProjectPath,
      sessionName,
    };

    if (clientRequestId) {
      rememberIdempotentSession(clientRequestId, result, now);
    }

    return result;
  },

  /**
   * Branches a session into an independent one containing its conversation up
   * to `upToAnchorId` (the whole thing when omitted).
   *
   * The source is left completely untouched — this is the "try two approaches"
   * action, not a destructive one.
   */
  async forkSessionById(
    sessionId: string,
    options: { upToAnchorId?: string; title?: string } = {},
  ): Promise<CreateAppSessionResult> {
    const source = sessionsDb.getSessionById(sessionId);
    if (!source) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const provider = source.provider as LLMProvider;
    const fork = providerRegistry.resolveProvider(provider).fork;
    if (!fork) {
      throw new AppError(`Sessions cannot be forked for provider "${provider}".`, {
        code: 'FORK_NOT_SUPPORTED',
        statusCode: 409,
      });
    }

    // A session that has never run has no transcript to copy, so there is
    // nothing a fork of it could resume from.
    if (!source.provider_session_id || !source.jsonl_path) {
      throw new AppError('This session has not produced a transcript yet.', {
        code: 'FORK_SOURCE_NOT_READY',
        statusCode: 409,
      });
    }

    const sessionName = options.title?.trim()
      || `${source.custom_name?.trim() || 'Session'} (fork)`;

    const forked = await fork.forkSession({
      providerSessionId: source.provider_session_id,
      jsonlPath: source.jsonl_path,
      projectPath: source.project_path ?? '',
      upToAnchorId: options.upToAnchorId,
      title: sessionName,
    });

    const forkSessionId = randomUUID();
    sessionsDb.createForkedSession({
      sessionId: forkSessionId,
      provider,
      projectPath: source.project_path ?? '',
      customName: sessionName,
      // A typed fork title is user intent; the auto-derived "(fork)" name
      // stays followable so the engine can replace it with its own.
      nameLocked: Boolean(options.title?.trim()),
      providerSessionId: forked.providerSessionId,
      jsonlPath: forked.jsonlPath,
      forkedFromSessionId: sessionId,
      // A fork that silently dropped to the catalog default would answer
      // differently from the conversation it was branched from.
      model: source.model,
      effort: source.effort,
    });

    await broadcastSessionUpserted(forkSessionId);

    return {
      sessionId: forkSessionId,
      provider,
      projectPath: source.project_path ?? '',
      sessionName,
    };
  },

  /**
   * Resolves the provider-native id only for an explicit user copy action.
   * Normal session payloads continue to expose only the stable app id.
   */
  getProviderSessionId(sessionId: string): string {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!session.provider_session_id) {
      throw new AppError('This session ID is not available yet.', {
        code: 'PROVIDER_SESSION_ID_NOT_AVAILABLE',
        statusCode: 409,
      });
    }

    return session.provider_session_id;
  },

  /**
   * Fetches persisted history by app session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * provider-native session id (the one written into transcripts on disk),
   * and every returned message is remapped back to the app session id so
   * provider ids never reach the frontend.
   */
  /**
   * Resolves where a conversation must resume from so that one already-sent
   * message, and everything after it, is replaced.
   *
   * Returns `null` when the provider cannot do this at all, which is how the
   * chat gateway knows to refuse the request rather than silently sending the
   * edit as a new message at the end of the conversation.
   */
  async resolveEditAnchor(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null } | null> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessions = providerRegistry.resolveProvider(session.provider as LLMProvider).sessions;
    if (!sessions.resolveEditAnchor) {
      return null;
    }

    return sessions.resolveEditAnchor(sessionId, anchorId);
  },

  /**
   * Whether editing a message on this session's provider means rewinding it on
   * disk first, rather than handing the anchor to the runtime as a resume
   * option.
   *
   * Answering this without doing anything is the point: the rewind moves the
   * session onto a different provider transcript and cannot be undone, so the
   * gateway has to know which shape the run takes before it commits to one.
   */
  providerRewindsForEdit(sessionId: string): boolean {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return Boolean(providerRegistry.resolveProvider(session.provider as LLMProvider).sessions.rewindSession);
  },

  /**
   * Rewinds a session on disk so `keepThroughId` is the last row it holds.
   *
   * Only call this once the run is admitted — see `providerRewindsForEdit`.
   */
  async rewindSessionForEdit(sessionId: string, keepThroughId: string | null): Promise<void> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessions = providerRegistry.resolveProvider(session.provider as LLMProvider).sessions;
    await sessions.rewindSession?.(sessionId, keepThroughId);
  },

  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history.
    if (!session.provider_session_id) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const provider = session.provider as LLMProvider;
    const providerSessions = providerRegistry.resolveProvider(provider).sessions;
    const providerSessionId = session.provider_session_id;
    const projectPath = session.project_path ?? '';
    const requestedLimit = options.limit ?? null;
    const requestedOffset = options.offset ?? 0;

    // Claude and Codex history readers parse `jsonl_path` itself, so a page
    // can be sliced from the stat-validated full-transcript cache instead of
    // re-parsing the whole file per request. Cursor and OpenCode read their
    // messages from elsewhere (store.db / shared SQLite), so that file's stat
    // says nothing about their history — they stay on the direct path.
    const transcriptPath = provider === 'claude' || provider === 'codex'
      ? session.jsonl_path
      : null;
    const fullHistory = await sessionHistoryCache.getFullHistory({
      sessionId,
      transcriptPath,
      loadFull: () => providerSessions.fetchHistory(sessionId, {
        limit: null,
        offset: 0,
        projectPath,
        providerSessionId,
      }),
    });

    let result: FetchHistoryResult;
    if (fullHistory) {
      // Providers slice with this same helper, so a cached page is identical
      // to what a direct `(limit, offset)` read would have returned.
      const { page, hasMore } = sliceTailPage(fullHistory.messages, requestedLimit, Math.max(0, requestedOffset));
      result = {
        ...fullHistory,
        messages: page,
        hasMore,
        offset: requestedOffset,
        limit: requestedLimit,
      };
    } else {
      result = await providerSessions.fetchHistory(sessionId, {
        limit: requestedLimit,
        offset: requestedOffset,
        projectPath,
        providerSessionId,
      });
    }

    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        sessionId,
      })),
    };
  },

  /**
   * Reads what one agent of a workflow run did, for the card that opened it.
   *
   * Not found covers both a provider that spawns no workflow agents and a run
   * that left no transcript for this agent: either way there is nothing to
   * show, and the card says so in one line.
   */
  async readWorkflowAgentActivity(sessionId: string, runId: string, agentId: string): Promise<WorkflowAgentActivity> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessions = providerRegistry.resolveProvider(session.provider as LLMProvider).sessions;
    const activity = await sessions.readWorkflowAgentActivity?.(sessionId, runId, agentId);
    if (!activity) {
      throw new AppError(`Workflow agent "${agentId}" was not found.`, {
        code: 'WORKFLOW_AGENT_NOT_FOUND',
        statusCode: 404,
      });
    }

    return activity;
  },

  /**
   * Resolves one session (by app id, falling back to the provider-native id)
   * to its metadata plus the owning project.
   *
   * This backs deep links like `/session/:sessionId`: the frontend's paginated
   * project payloads only carry each project's first session page, so a
   * session opened directly by URL may not be present client-side at all —
   * this lookup is the authoritative way to learn which project owns it.
   */
  getSessionDetailsById(sessionId: string): SessionDetails {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const projectPath = session.project_path?.trim() ? session.project_path : null;
    const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;

    return {
      sessionId: session.session_id,
      provider: session.provider as LLMProvider,
      summary: session.custom_name?.trim() || '',
      createdAt: session.created_at ?? null,
      updatedAt: session.updated_at ?? null,
      lastActivity: session.updated_at ?? session.created_at ?? null,
      isArchived: Boolean(session.isArchived),
      project: project && projectPath
        ? {
            projectId: project.project_id,
            path: projectPath,
            fullPath: projectPath,
            displayName: resolveProjectDisplayName(projectPath, project.custom_project_name),
            isStarred: Boolean(project.isStarred),
            isArchived: Boolean(project.isArchived),
          }
        : null,
    };
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const resolvedSessionId = session.session_id;

    // A conversation with work in flight cannot be archived away: the work
    // would keep running against a session the user can no longer see. The
    // admission closes first, so no run starts between the check and the
    // action.
    providerRuntimeService.closeSessionAdmission(resolvedSessionId);
    let keepAdmissionClosed = false;
    try {
      if (providerRuntimeService.hasSessionWork(resolvedSessionId)) {
        throw new AppError(
          'This conversation still has work running — a background task or a report the engine is still making. '
          + 'Wait for it to finish, or stop it, before archiving the conversation.',
          { code: 'SESSION_HAS_ACTIVE_WORK', statusCode: 409 },
        );
      }
      // An idle resident process is closed with the conversation, so the
      // engine does not keep working for a session that is gone. The
      // admission stays closed until the action is done.
      providerRuntimeService.releaseSession(resolvedSessionId);

      const result = await archiveOrDeleteResolvedSession(session, resolvedSessionId, options);
      // A deleted conversation is gone for good; an archived one opens again
      // when it is restored.
      keepAdmissionClosed = result.action === 'deleted';
      return result;
    } finally {
      if (!keepAdmissionClosed) {
        providerRuntimeService.openSessionAdmission(resolvedSessionId);
      }
    }
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(session.session_id, false);
    return { sessionId: session.session_id, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   *
   * A user rename locks the name: engine-generated titles never overwrite it.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(session.session_id, summary, { lockName: true });
    return { sessionId: session.session_id, summary };
  },

  /**
   * Pins or unpins one session by id. Sets the flag rather than toggling it,
   * so a retried request cannot flip it back.
   */
  setSessionPinnedById(sessionId: string, isPinned: boolean): { sessionId: string; isPinned: boolean } {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsPinned(session.session_id, isPinned);
    return { sessionId: session.session_id, isPinned };
  },

  /**
   * Cleans up provider-native storage (transcripts, brain directories, summary DB rows)
   * for an entire project path when a project is permanently deleted.
   */
  async deleteProviderProjectStorage(projectPath: string): Promise<void> {
    await cleanupProviderProjectStorage(projectPath);
  },
};
