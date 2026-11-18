import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import {
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
 * Returns directory entries or an empty list when the folder is missing.
 */
async function listDirectoryEntriesSafe(
  directoryPath: string
): Promise<import('node:fs').Dirent[]> {
  try {
    return await fsp.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Session indexer for Cursor transcript artifacts.
 */
export class CursorSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'cursor' as const;
  private readonly cursorHome = path.join(os.homedir(), '.cursor');

  /**
   * Declares the watched artifact layout: the projects directory holding the
   * chat JSONL files.
   */
  getSessionWatchTarget(): ProviderSessionWatchTarget {
    return {
      rootPath: path.join(this.cursorHome, 'projects'),
      isTargetFile: (filePath: string) => filePath.endsWith('.jsonl'),
    };
  }

  /**
   * Scans Cursor chats and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const projectsDir = path.join(this.cursorHome, 'projects');

    let processed = 0;

    const files = await findFilesRecursivelyCreatedAfter(projectsDir, '.jsonl', since ?? null);

    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath);
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
   * Parses and upserts one Cursor session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const parsed = await this.processSessionFile(filePath);
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
   * Extracts project path from Cursor worker.log.
   */
  private async extractProjectPathFromWorkerLog(filePath: string): Promise<string | null> {
    try {
      const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of lineReader) {
        const match = line.match(/workspacePath=(.*)$/);
        const projectPath = match?.[1]?.trim();
        if (projectPath) {
          lineReader.close();
          fileStream.close();
          return projectPath;
        }
      }
    } catch {
      // Missing worker logs are valid for partial or incomplete session data.
    }

    return null;
  }

  /**
   * Extracts session metadata from one Cursor JSONL session file.
   */
  private async processSessionFile(filePath: string): Promise<ParsedSession | null> {
    const sessionId = path.basename(filePath, '.jsonl');
    const grandparentDir = path.dirname(path.dirname(path.dirname(filePath)));
    const workerLogPath = path.join(grandparentDir, 'worker.log');
    const projectPath = await this.extractProjectPathFromWorkerLog(workerLogPath);

    if (!projectPath) {
      return null;
    }

    // An engine that canonicalizes its cwd records a filesystem equivalent of
    // the project the user opened; file the session under the registered
    // project instead of splitting a twin into the sidebar.
    const canonicalProjectPath = canonicalizeSessionProjectPath(projectPath);

    // A workspace that is engine infrastructure, or a sandbox directory the
    // system has since reaped, is not a project.
    if (!admitsWorkspacePath(canonicalProjectPath)) {
      return null;
    }

    return extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, any>;
      if (data.role !== 'user') {
        return null;
      }

      const text = typeof data.message?.content?.[0]?.text === 'string' ? data.message.content[0].text : '';
      // Drop Cursor's `<timestamp>…</timestamp>` prefix and `<user_query>` tags
      // so the session name comes from the actual first line the user typed.
      const firstLine = text
        .replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')
        .replace(/<\/?user_query>/g, '')
        .trim()
        .split('\n')[0];

      // Cursor generates no title of its own: the first line is a placeholder
      // that fills a nameless row and never overwrites a synced or locked name.
      const existingSession = sessionsDb.getSessionByProviderSessionId(sessionId)
        ?? sessionsDb.getSessionById(sessionId);
      const resolvedName = resolveSessionTitle({
        nameLocked: existingSession?.name_locked === 1,
        existingName: existingSession?.custom_name,
        fallbackTitle: 'Untitled Cursor Session',
        derived: { name: firstLine || null, generated: false },
      });

      return {
        sessionId,
        projectPath: canonicalProjectPath,
        sessionName: normalizeSessionName(resolvedName ?? undefined, 'Untitled Cursor Session'),
      };
    });
  }
}
