import type { TFunction } from 'i18next';

import type { FileTreeNode, FileTreeSearchMatch } from '@/shared/types';

const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
]);

type SearchBranch = { node: FileTreeNode; children: Map<string, SearchBranch> };

/**
 * Folds flat search matches into a tree so results render with the same rows,
 * menus and actions as the browsing tree. Ancestors that did not match
 * themselves become plain folder nodes; every folder in the result is returned
 * in `directoryPaths` so the caller can show it open.
 */
export function buildSearchTree(matches: FileTreeSearchMatch[]): {
  items: FileTreeNode[];
  directoryPaths: Set<string>;
} {
  const roots = new Map<string, SearchBranch>();

  for (const match of matches) {
    const segments = match.relativePath.split('/');
    // The absolute path ends with the relative path, so what precedes it is the
    // project root and the character between them is the server's separator.
    const projectRoot = match.path.slice(0, match.path.length - match.relativePath.length - 1);
    const separator = match.path.charAt(projectRoot.length) || '/';

    let level = roots;
    segments.forEach((segment, index) => {
      const isMatch = index === segments.length - 1;
      let branch = level.get(segment);
      if (!branch) {
        const node: FileTreeNode = isMatch
          ? { ...match }
          : {
              name: segment,
              type: 'directory',
              path: `${projectRoot}${separator}${segments.slice(0, index + 1).join(separator)}`,
            };
        branch = { node, children: new Map() };
        level.set(segment, branch);
      } else if (isMatch) {
        // A folder first created as an ancestor gets its real metadata.
        branch.node = { ...match };
      }
      level = branch.children;
    });
  }

  const directoryPaths = new Set<string>();
  const toNodes = (level: Map<string, SearchBranch>): FileTreeNode[] => [...level.values()]
    .map(({ node, children }) => {
      if (node.type !== 'directory') return node;
      directoryPaths.add(node.path);
      const childNodes = toNodes(children);
      // A matched folder whose contents did not match shows no children,
      // rather than claiming to be empty.
      return childNodes.length > 0 ? { ...node, children: childNodes } : node;
    })
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  return { items: toNodes(roots), directoryPaths };
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes === 0) {
    return '0 B';
  }

  const base = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(base));

  return `${(bytes / Math.pow(base, index)).toFixed(1).replace(/\.0$/, '')} ${sizes[index]}`;
}

export function formatRelativeTime(date: string | undefined, t: TFunction): string {
  if (!date) {
    return '-';
  }

  const now = new Date();
  const past = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return t('fileTree.justNow');
  }

  if (diffInSeconds < 3600) {
    return t('fileTree.minAgo', { count: Math.floor(diffInSeconds / 60) });
  }

  if (diffInSeconds < 86400) {
    return t('fileTree.hoursAgo', { count: Math.floor(diffInSeconds / 3600) });
  }

  if (diffInSeconds < 2592000) {
    return t('fileTree.daysAgo', { count: Math.floor(diffInSeconds / 86400) });
  }

  return past.toLocaleDateString();
}

export function isImageFile(filename: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase();
  return Boolean(extension && IMAGE_FILE_EXTENSIONS.has(extension));
}

