import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { useApiSource } from '@/modules/command-palette/hooks/useApiSource';
import type { FileTreeSearchResponse } from '@/shared/types';

export type FileResult = {
  path: string;
  name: string;
};

const SEARCH_LIMIT = 50;
// Waits for a pause in typing so each keystroke does not cost a request.
const SEARCH_DEBOUNCE_MS = 150;

/**
 * Project files matching the palette's search text, ranked by the server so
 * every file of a large project is reachable. Empty text lists the first files
 * in path order.
 */
export function useFilesSource(projectId: string | undefined, enabled: boolean, query: string) {
  // The search text once typing pauses; requests follow this, not every keystroke.
  const [settledQuery, setSettledQuery] = useState(query.trim());
  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return useApiSource<FileResult, FileTreeSearchResponse>({
    enabled: enabled && !!projectId,
    deps: [projectId, settledQuery],
    fetcher: (signal) => api.searchFiles(projectId!, { query: settledQuery, limit: SEARCH_LIMIT, type: 'file' }, { signal }),
    parse: (data) => (Array.isArray(data?.results) ? data.results : []).map((match) => ({ path: match.path, name: match.name })),
  });
}
