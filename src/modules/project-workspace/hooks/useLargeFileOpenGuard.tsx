import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';

import { LargeFileOpenDialog } from '@/modules/file-tree';
import { api, readExternalFileContent } from '@/shared/api';
import { LARGE_FILE_OPEN_BYTES } from '@/shared/constants';
import type { Project } from '@/shared/types';
import { isWorkspaceExternalPath, saveOrShareBlob } from '@/shared/utils';

// `diffInfo` is intentionally `any`, matching the editor handlers this wraps
// and the resolver chain that feeds them.
type OpenGuardHandler = (filePath: string, diffInfo?: any, line?: number | null) => boolean;

type OpenGuardDecision = 'open' | 'download' | 'cancel';

/** The oversized file waiting on its confirmation, with the resolver that turns the dialog click into the awaited decision. */
type PendingLargeFile = {
  path: string;
  name: string;
  size: number;
  resolve: (decision: OpenGuardDecision) => void;
};

export type UseLargeFileOpenGuardResult = {
  /**
   * Opens a file like `handleFileOpen`, but probes the server for the size
   * first and asks before loading anything above the open threshold. Diff
   * opens carry their own payloads and skip the probe.
   */
  openWithGuard: (filePath: string, diffInfo?: unknown, line?: number | null) => Promise<boolean>;
  /** The confirmation dialog when one is pending; render it next to the workspace. */
  guardDialog: ReactNode;
};

/**
 * Used by WorkspaceMain so files opened from chat messages, the git panel and
 * the command palette — paths that carry no size, unlike file-tree nodes —
 * get the same large-file confirmation the tree shows.
 */
export function useLargeFileOpenGuard(
  selectedProject: Project | null,
  handleFileOpen: OpenGuardHandler,
): UseLargeFileOpenGuardResult {
  const projectId = selectedProject?.projectId;
  // Derived outside the callback so the memoizer's inferred dependency matches
  // the dependency list exactly.
  const projectPath = selectedProject?.path || selectedProject?.fullPath;
  // The file awaiting its confirmation; null when nothing is being asked.
  const [pendingFile, setPendingFile] = useState<PendingLargeFile | null>(null);
  // Tracks the streaming download kicked off from the dialog so its button can show progress.
  const [downloading, setDownloading] = useState(false);

  const openWithGuard = useCallback(async (
    filePath: string,
    diffInfo?: unknown,
    line: number | null = null,
  ): Promise<boolean> => {
    // Diff opens embed old/new payloads and never read the file from disk, so
    // there is nothing large to guard.
    if (diffInfo || !projectId) {
      return handleFileOpen(filePath, diffInfo, line);
    }

    let size: number | null = null;
    try {
      const response = await api.fileStat(projectId, filePath);
      if (response.ok) {
        size = ((await response.json()) as { size: number }).size;
      }
    } catch (error) {
      console.error(`Failed to stat "${filePath}" before opening:`, error);
    }

    // Unreachable or unreadable paths open as before; the editor reports its
    // own load error, and the guard must not change that failure path.
    if (size === null || size <= LARGE_FILE_OPEN_BYTES) {
      return handleFileOpen(filePath, diffInfo, line);
    }

    const decision = await new Promise<OpenGuardDecision>((resolve) => {
      setPendingFile({
        path: filePath,
        name: filePath.split(/[\\/]/).pop() || filePath,
        size,
        resolve,
      });
    });

    if (decision === 'open') {
      return handleFileOpen(filePath, diffInfo, line);
    }
    if (decision === 'download') {
      setDownloading(true);
      try {
        // Absolute paths outside the project live behind the read-only
        // external stream; project paths use the raw-byte project stream.
        const response = isWorkspaceExternalPath(filePath, projectPath)
          ? await readExternalFileContent(filePath, undefined, projectId)
          : await api.readFileBlob(projectId, filePath);
        if (!response.ok) {
          throw new Error(`Failed to download file: ${response.status}`);
        }
        await saveOrShareBlob(await response.blob(), filePath.split(/[\\/]/).pop() || filePath);
      } catch (error) {
        console.error(`Failed to download "${filePath}":`, error);
      } finally {
        setDownloading(false);
      }
    }
    return false;
  }, [handleFileOpen, projectId, projectPath]);

  const guardDialog = pendingFile
    ? (
      <LargeFileOpenDialog
        name={pendingFile.name}
        size={pendingFile.size}
        downloading={downloading}
        onOpen={() => {
          pendingFile.resolve('open');
          setPendingFile(null);
        }}
        onDownload={() => {
          pendingFile.resolve('download');
          setPendingFile(null);
        }}
        onCancel={() => {
          pendingFile.resolve('cancel');
          setPendingFile(null);
        }}
      />
    )
    : null;

  return { openWithGuard, guardDialog };
}
