import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';
import type { FileTreeNode, FileTreeSearchResponse } from '@/shared/types';
import { buildSearchTree } from '@/modules/file-tree/utils/fileTreeUtils';

type UseFileTreeSearchResult = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  /** True while the box holds text, which switches the tree to search results. */
  isSearchActive: boolean;
  /** True until the server has answered for the current text. */
  searching: boolean;
  searchError: string | null;
  searchItems: FileTreeNode[];
  /** Every folder in the results, shown open without touching the browsing tree. */
  searchExpandedDirs: Set<string>;
  searchTruncated: boolean;
  searchIndexIncomplete: boolean;
  refreshSearch: () => void;
};

// Waits for a pause in typing so each keystroke does not cost a request.
const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_RESULT_LIMIT = 200;
const SEARCH_ERROR = 'Search failed';

/** Server-side search for the file tree's search box; results come back as a partial tree. */
export function useFileTreeSearch(projectId: string | undefined): UseFileTreeSearchResult {
  // The text in the search box.
  const [searchQuery, setSearchQuery] = useState('');
  // The latest answer and the exact query/project it answers, so a stale answer
  // is never shown as the result for newer text.
  const [answer, setAnswer] = useState<{ key: string; response: FileTreeSearchResponse } | null>(null);
  // Why the latest search failed, tagged like `answer`.
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  // Bumped to re-run the current search after the tree changed files.
  const [refreshCount, setRefreshCount] = useState(0);

  const trimmedQuery = searchQuery.trim();
  const searchKey = `${projectId ?? ''}\n${trimmedQuery}`;

  useEffect(() => {
    if (!projectId || !trimmedQuery) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await api.searchFiles(
            projectId,
            { query: trimmedQuery, limit: SEARCH_RESULT_LIMIT, type: 'any' },
            { signal: controller.signal },
          );
          if (!response.ok) throw new Error(SEARCH_ERROR);
          const body = (await response.json()) as FileTreeSearchResponse;
          setAnswer({ key: searchKey, response: body });
          setFailure(null);
        } catch (error) {
          if (controller.signal.aborted) return;
          setFailure({ key: searchKey, message: error instanceof Error ? error.message : SEARCH_ERROR });
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, trimmedQuery, searchKey, refreshCount]);

  const current = answer?.key === searchKey ? answer.response : null;
  const searchError = failure?.key === searchKey ? failure.message : null;
  const tree = useMemo(() => buildSearchTree(current?.results ?? []), [current]);
  const refreshSearch = useCallback(() => setRefreshCount((count) => count + 1), []);

  return {
    searchQuery,
    setSearchQuery,
    isSearchActive: Boolean(trimmedQuery),
    searching: Boolean(trimmedQuery) && !current && !searchError,
    searchError,
    searchItems: tree.items,
    searchExpandedDirs: tree.directoryPaths,
    searchTruncated: current?.truncated ?? false,
    searchIndexIncomplete: current?.indexIncomplete ?? false,
    refreshSearch,
  };
}
