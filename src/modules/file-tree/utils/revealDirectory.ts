// A reference written inside a chat message carries neither a canonical
// separator nor a canonical shape, so trailing slashes, `./` prefixes and
// Windows separators are levelled before anything is compared.
const normalizePath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

const isAbsolutePath = (value: string): boolean => /^(\/|[A-Za-z]:\/)/.test(value);

/**
 * The project-relative folders to list and open, root first, so `reference`
 * becomes visible in the file tree; empty when the reference is not inside the
 * project. Each entry is a path the directory endpoint accepts, e.g.
 * `src/modules/` yields `['src', 'src/modules']`.
 */
export function revealRequestPaths(projectPath: string, reference: string): string[] {
  const root = normalizePath(projectPath);
  const target = normalizePath(reference);

  let relative = target;
  if (isAbsolutePath(target)) {
    if (!root || !target.startsWith(`${root}/`)) {
      // Either the project root itself (nothing to open) or a path outside
      // it — `/workspace/apple` must not be read as a child of `/workspace/app`.
      return [];
    }
    relative = target.slice(root.length + 1);
  }

  const segments = relative.split('/').filter((segment) => segment && segment !== '.');
  if (segments.includes('..')) {
    return [];
  }
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}
