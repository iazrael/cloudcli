import path from 'node:path';


import { getCodexHome } from '@/shared/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import {
  readJsonlRecords,
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { ProviderSessionWatchTarget } from '@/shared/types.js';

import { admitsWorkspacePath } from '../../shared/sessions/workspace-admission.js';
import { applySessionWorktreePlacement } from '../../shared/sessions/session-worktree-placement.js';
import { canonicalizeSessionProjectPath } from '../../shared/sessions/session-project-path-canonicalization.js';
import { resolveSessionTitle } from '../../shared/sessions/session-title-resolution.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private get codexHome(): string { return getCodexHome(); }

  /**
   * Declares the watched artifact layout: the sessions directory holding the
   * rollout JSONL files.
   */
  getSessionWatchTarget(): ProviderSessionWatchTarget {
    return {
      rootPath: path.join(this.codexHome, 'sessions'),
      isTargetFile: (filePath: string) => filePath.endsWith('.jsonl'),
    };
  }


  /**
   * Scans ~/.codex/sessions and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    // Codex appends a new record to the index whenever it (re)names a thread,
    // so the last record per id is the engine's current title.
    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name', 'last');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.codexHome, 'sessions'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      const placement = await applySessionWorktreePlacement(parsed.projectPath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        placement.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath,
        placement.worktree
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Codex session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name', 'last');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    const placement = await applySessionWorktreePlacement(parsed.projectPath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      placement.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
      placement.worktree
    );
  }

  /**
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
        isSubagent: payload ? this.isSubagentSessionMeta(payload) : false,
      };
    });

    if (!parsed || parsed.isSubagent) {
      return null;
    }

    // An engine that canonicalizes its cwd records a filesystem equivalent of
    // the project the user opened; file the session under the registered
    // project instead of splitting a twin into the sidebar.
    parsed.projectPath = canonicalizeSessionProjectPath(parsed.projectPath);

    // A transcript whose cwd is engine infrastructure, or a sandbox directory
    // the system has since reaped, is not a project.
    if (!admitsWorkspacePath(parsed.projectPath)) {
      return null;
    }

    // A thread a session was edited off is left on disk on purpose, but it is
    // nobody's conversation any more. Re-indexing it would add a sidebar entry
    // for the version the user edited away from — and for a session that was
    // itself discovered from disk, whose app id is its original thread id, it
    // would hand the row back to that thread.
    if (sessionsDb.isProviderSessionSuperseded(parsed.sessionId, this.provider)) {
      return null;
    }

    // `thread_name` in the index is Codex's own (re)name for the thread and is
    // followed on every rescan; the trailing agent message is only a
    // content-derived placeholder that fills a nameless row.
    const threadName = nameMap.get(parsed.sessionId);
    let sessionName = threadName;
    if (!sessionName) {
      sessionName = await this.extractLastAgentMessageFromEnd(filePath);
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const resolvedName = resolveSessionTitle({
      nameLocked: existingSession?.name_locked === 1,
      existingName: existingSession?.custom_name,
      fallbackTitle: 'Untitled Codex Session',
      derived: { name: sessionName ?? null, generated: Boolean(threadName) },
    });

    return {
      ...parsed,
      sessionName: normalizeSessionName(resolvedName ?? undefined, 'Untitled Codex Session'),
    };
  }

  /**
   * Returns true when a session_meta payload belongs to a Codex sub-agent
   * thread (Codex >=0.144 collaboration spawn_agent, review, compact, etc.).
   * Sub-agent rollouts live in the same sessions tree as user sessions, so
   * they must be skipped here to stay out of the sidebar — the Codex
   * equivalent of the Claude synchronizer's subagent transcript skip.
   * Top-level sessions carry thread_source "user" and a string source
   * ("exec"/"cli"); sub-agents carry thread_source "subagent" and an object
   * source keyed by "subagent".
   */
  private isSubagentSessionMeta(payload: Record<string, unknown>): boolean {
    if (payload.thread_source === 'subagent') {
      return true;
    }

    const source = payload.source;
    return typeof source === 'object' && source !== null && 'subagent' in source;
  }

  private async extractLastAgentMessageFromEnd(filePath: string): Promise<string | undefined> {
    let latest: string | undefined;
    try {
      for await (const data of readJsonlRecords(filePath)) {
        const payload = data.payload as Record<string, unknown> | undefined;
        if (data.type === 'event_msg' && payload?.type === 'task_complete'
          && typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()) {
          latest = payload.last_agent_message;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[Codex] Failed to read session title:', error);
    }
    return latest;
  }
}
