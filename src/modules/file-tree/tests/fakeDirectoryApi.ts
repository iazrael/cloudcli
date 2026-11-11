import type { FileTreeNode } from '@/shared/types';

/**
 * In-memory stand-in for the batched directory endpoint, shared by the file
 * tree's hook and component tests. `directories` maps a project-relative
 * folder ('' is the root) to its entries, with a trailing `/` marking
 * subfolders; a folder missing from it answers like the server's 404, and one
 * listed in `refused` answers with a permission error.
 */
export function createFakeDirectoryApi(root: string, directories: Record<string, string[]>) {
  const refused = new Set<string>();
  const calls: string[][] = [];

  const toRelative = (request: string) => (request.startsWith(`${root}/`) ? request.slice(root.length + 1) : request === root ? '' : request);
  const toAbsolute = (relative: string) => (relative ? `${root}/${relative}` : root);

  async function listDirectories(_projectId: string, paths: string[]): Promise<Response> {
    calls.push(paths);
    const listings = paths.map((request) => {
      const relative = toRelative(request);
      if (refused.has(relative)) {
        return { request, error: { code: 'FILE_TREE_PERMISSION_DENIED', message: 'Permission denied' } };
      }
      const entries = directories[relative];
      if (!entries) {
        return { request, error: { code: 'FILE_TREE_PATH_NOT_FOUND', message: 'Directory not found' } };
      }
      return {
        request,
        path: toAbsolute(relative),
        truncated: false,
        entries: entries.map((entry): FileTreeNode => {
          const name = entry.replace(/\/$/, '');
          return {
            name,
            type: entry.endsWith('/') ? 'directory' : 'file',
            path: toAbsolute(relative ? `${relative}/${name}` : name),
          };
        }),
      };
    });
    return new Response(JSON.stringify({ directories: listings }), { status: 200 });
  }

  return { directories, refused, calls, listDirectories };
}
