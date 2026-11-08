import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { FileTreeNode, Project } from '@/shared/types';
import { revealRequestPaths } from '@/modules/file-tree/utils/revealDirectory';

/** One answer from the batched directory endpoint, in request order. */
type DirectoryListing =
  | { request: string; path: string; entries: FileTreeNode[]; truncated: boolean }
  | { request: string; error: { code: string; message: string } };

/** What the tree knows about one folder it has asked the server for. */
type DirectoryState = {
  status: 'loading' | 'loaded' | 'error';
  entries: FileTreeNode[];
  truncated: boolean;
  error: string | null;
  // Read before the last refresh and not re-read since, because the folder was
  // collapsed at the time; it is fetched again the next time it is opened.
  stale: boolean;
};

type UseLazyFileTreeResult = {
  /** The project root's entries, with `children` attached to open folders. */
  items: FileTreeNode[];
  /** True until the project root has been listed once. */
  loading: boolean;
  /** Why the project root could not be listed, if it could not. */
  error: string | null;
  expandedDirs: Set<string>;
  toggleDirectory: (path: string) => void;
  retryDirectory: (path: string) => void;
  collapseAll: () => void;
  /** Re-reads the root and every open folder; collapsed folders re-read when next opened. */
  refresh: () => void;
  /** Lists and opens every folder between the project root and `reference`, stopping at the first one the tree does not show; resolves to the deepest folder opened, or null. */
  revealDirectory: (reference: string) => Promise<string | null>;
};

// The root is keyed by the empty request path because its absolute path is
// only known once the server has answered.
const ROOT_KEY = '';
// The endpoint's batch limit.
const MAXIMUM_DIRECTORIES_PER_REQUEST = 50;
const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

// The API reports refusals as { error: message }. Surfacing that message tells
// the user why the tree is missing instead of leaving it unexplained.
async function readResponseErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    const message = typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : DEFAULT_LOAD_ERROR;
  } catch {
    return DEFAULT_LOAD_ERROR;
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

// Attaches loaded children to open folders, recursively, so the renderer only
// walks what is visible.
function buildVisibleTree(
  key: string,
  directories: Map<string, DirectoryState>,
  expandedDirs: Set<string>,
): FileTreeNode[] {
  const state = directories.get(key);
  if (!state) return [];

  return state.entries.map((entry) => {
    if (entry.type !== 'directory' || !expandedDirs.has(entry.path)) return entry;
    const child = directories.get(entry.path);
    if (!child) return entry;
    if (child.status === 'error') {
      return { ...entry, childrenStatus: 'error', childrenError: child.error ?? DEFAULT_LOAD_ERROR };
    }
    // A refresh keeps showing the previous entries instead of a spinner.
    if (child.status === 'loading' && child.entries.length === 0) {
      return { ...entry, childrenStatus: 'loading' };
    }
    return {
      ...entry,
      children: buildVisibleTree(entry.path, directories, expandedDirs),
      childrenTruncated: child.truncated,
    };
  });
}

/**
 * Lazily loaded file tree for one project: the root is listed when the project
 * opens and every other folder when it is first expanded, so the cost follows
 * what the user looks at rather than the size of the project.
 */
export function useLazyFileTree(selectedProject: Project | null): UseLazyFileTreeResult {
  const projectId = selectedProject?.projectId;
  // Every folder fetched for the current project, keyed by absolute path (the
  // root by ROOT_KEY). The visible tree is derived from it.
  const [directories, setDirectories] = useState<Map<string, DirectoryState>>(() => new Map());
  // Folders the user has opened. They stay open across refreshes and searches.
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  // The project the two states above describe; a different project starts empty.
  const [stateProjectId, setStateProjectId] = useState(projectId);
  if (stateProjectId !== projectId) {
    setStateProjectId(projectId);
    setDirectories(new Map());
    setExpandedDirs(new Set());
  }

  // The latest committed state, for event handlers that decide what to fetch.
  const latestRef = useRef({ directories, expandedDirs });
  useEffect(() => {
    latestRef.current = { directories, expandedDirs };
  }, [directories, expandedDirs]);

  // Requests belong to one project session; switching projects aborts them and
  // a late answer from an earlier session is dropped.
  const sessionRef = useRef({ generation: 0, controller: new AbortController() });

  const fetchDirectories = useCallback(async (
    requests: string[],
    options: { markLoading: boolean },
  ): Promise<DirectoryListing[]> => {
    if (!projectId || requests.length === 0) return [];
    const { generation, controller } = sessionRef.current;
    const isCurrent = () => sessionRef.current.generation === generation && !controller.signal.aborted;

    if (options.markLoading) {
      setDirectories((previous) => {
        const next = new Map(previous);
        for (const request of requests) {
          const existing = next.get(request);
          next.set(request, {
            status: 'loading',
            entries: existing?.entries ?? [],
            truncated: existing?.truncated ?? false,
            error: null,
            stale: false,
          });
        }
        return next;
      });
    }

    let listings: DirectoryListing[];
    try {
      const batches = await Promise.all(chunk(requests, MAXIMUM_DIRECTORIES_PER_REQUEST).map(async (batch) => {
        const response = await api.listDirectories(projectId, batch, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(await readResponseErrorMessage(response));
        }
        return ((await response.json()) as { directories: DirectoryListing[] }).directories;
      }));
      listings = batches.flat();
    } catch (error) {
      if (!isCurrent()) return [];
      const message = error instanceof Error && error.message ? error.message : DEFAULT_LOAD_ERROR;
      // The root always records its failure, or the tree would wait forever.
      const failed = requests.filter((request) => options.markLoading || request === ROOT_KEY);
      if (failed.length > 0) {
        setDirectories((previous) => {
          const next = new Map(previous);
          for (const request of failed) {
            const existing = next.get(request);
            next.set(request, {
              status: 'error',
              entries: existing?.entries ?? [],
              truncated: existing?.truncated ?? false,
              error: message,
              stale: false,
            });
          }
          return next;
        });
      }
      return [];
    }
    if (!isCurrent()) return [];

    // A folder that disappeared since it was opened is dropped rather than
    // shown as an error, so a refresh after a delete or rename stays quiet.
    const vanished = listings
      .filter((listing) => 'error' in listing
        && listing.request !== ROOT_KEY
        && listing.error.code === 'FILE_TREE_PATH_NOT_FOUND')
      .map((listing) => listing.request);

    setDirectories((previous) => {
      const next = new Map(previous);
      for (const listing of listings) {
        if ('entries' in listing) {
          const key = listing.request === ROOT_KEY ? ROOT_KEY : listing.path;
          next.set(key, {
            status: 'loaded',
            entries: listing.entries,
            truncated: listing.truncated,
            error: null,
            stale: false,
          });
        } else if (vanished.includes(listing.request)) {
          next.delete(listing.request);
        } else if (options.markLoading || listing.request === ROOT_KEY) {
          const existing = next.get(listing.request);
          next.set(listing.request, {
            status: 'error',
            entries: existing?.entries ?? [],
            truncated: existing?.truncated ?? false,
            error: listing.error.message,
            stale: false,
          });
        }
      }
      return next;
    });
    if (vanished.length > 0) {
      setExpandedDirs((previous) => {
        const next = new Set(previous);
        vanished.forEach((path) => next.delete(path));
        return next;
      });
    }
    return listings;
  }, [projectId]);

  useEffect(() => {
    const session = { generation: sessionRef.current.generation + 1, controller: new AbortController() };
    sessionRef.current = session;
    if (projectId) {
      // No root state yet already reads as loading.
      void fetchDirectories([ROOT_KEY], { markLoading: false });
    }
    return () => session.controller.abort();
  }, [projectId, fetchDirectories]);

  const toggleDirectory = useCallback((path: string) => {
    const { directories: known, expandedDirs: open } = latestRef.current;
    if (open.has(path)) {
      setExpandedDirs((previous) => {
        const next = new Set(previous);
        next.delete(path);
        return next;
      });
      return;
    }

    setExpandedDirs((previous) => new Set(previous).add(path));
    const state = known.get(path);
    if (!state || state.stale || state.status === 'error') {
      void fetchDirectories([path], { markLoading: true });
    }
  }, [fetchDirectories]);

  const retryDirectory = useCallback((path: string) => {
    void fetchDirectories([path], { markLoading: true });
  }, [fetchDirectories]);

  const collapseAll = useCallback(() => {
    setExpandedDirs(new Set());
  }, []);

  const refresh = useCallback(() => {
    const { directories: known, expandedDirs: open } = latestRef.current;
    const visible = new Set<string>([ROOT_KEY]);
    const visit = (key: string) => {
      for (const entry of known.get(key)?.entries ?? []) {
        if (entry.type === 'directory' && open.has(entry.path) && known.has(entry.path)) {
          visible.add(entry.path);
          visit(entry.path);
        }
      }
    };
    visit(ROOT_KEY);

    setDirectories((previous) => {
      const next = new Map(previous);
      for (const [key, state] of next) {
        if (!visible.has(key)) next.set(key, { ...state, stale: true });
      }
      return next;
    });
    void fetchDirectories([...visible], { markLoading: true });
  }, [fetchDirectories]);

  const projectRoot = selectedProject?.path || selectedProject?.fullPath || '';
  const revealDirectory = useCallback(async (reference: string): Promise<string | null> => {
    const requests = revealRequestPaths(projectRoot, reference);
    if (requests.length === 0) return null;

    // Read in one batch; keys come from the server's answer since a reference
    // may be relative while the tree is keyed by absolute paths.
    const listings = await fetchDirectories(requests, { markLoading: false });
    const reveal: string[] = [];
    let parentEntries = latestRef.current.directories.get(ROOT_KEY)?.entries ?? [];
    for (const [index, listing] of listings.entries()) {
      if (!('entries' in listing)) break;
      const name = requests[index]?.split('/').pop();
      // Stop at the first level the tree does not show, such as a gitignored folder.
      const shown = parentEntries.some((entry) => entry.type === 'directory' && entry.name === name && entry.path === listing.path);
      if (!shown) break;
      reveal.push(listing.path);
      parentEntries = listing.entries;
    }
    if (reveal.length > 0) {
      setExpandedDirs((previous) => {
        const next = new Set(previous);
        reveal.forEach((path) => next.add(path));
        return next;
      });
    }
    return reveal.at(-1) ?? null;
  }, [fetchDirectories, projectRoot]);

  const items = useMemo(
    () => buildVisibleTree(ROOT_KEY, directories, expandedDirs),
    [directories, expandedDirs],
  );
  const rootState = directories.get(ROOT_KEY);

  return {
    items,
    loading: Boolean(projectId) && (!rootState || (rootState.status === 'loading' && rootState.entries.length === 0)),
    error: rootState?.status === 'error' ? rootState.error : null,
    expandedDirs,
    toggleDirectory,
    retryDirectory,
    collapseAll,
    refresh,
    revealDirectory,
  };
}
