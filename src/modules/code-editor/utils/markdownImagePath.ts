import type { MarkdownImageContext } from '@/shared/types';
import { filePathFromFileUrl } from '@/shared/utils';

/**
 * Resolves where a rendered Markdown document's image references have to be
 * loaded from.
 *
 * A bare `<img src="docs/a.png">` cannot work for a workspace file: the browser
 * resolves it against the page URL (a 404 for anything the app's static assets
 * do not happen to contain), and the files routes that can serve it require the
 * auth header an `<img>` cannot carry. Markdown paths are also relative to the
 * document that references them, not to the project root the files route
 * resolves against by default, so the caller passes the document's directory.
 */

/** Where one markdown image source should be loaded from. */
type MarkdownImageTarget =
  // The browser can load it on its own: http(s), data and blob sources.
  | { kind: 'browser'; src: string }
  // A workspace file, read through the project files route (`external: false`)
  // or the external read-only route (`external: true`).
  | { kind: 'file'; path: string; external: boolean }
  // Nothing loadable: an empty source, or no context to resolve it against.
  | { kind: 'unresolved' };

const BROWSER_IMAGE_SRC = /^(https?:|data:|blob:)/i;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:\//i;
const WINDOWS_UNC_PATH = /^\/\//;

// react-markdown escapes the URLs it hands to renderers, so `my imágenes/x.png`
// arrives as `my%20im%C3%A1genes/x.png` and has to be decoded before it can be
// used as a filesystem path. A literal `%` that is not valid encoding is kept.
const decodeSrc = (src: string): string => {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
};

// An absolute path belongs to whichever route owns the document: a document
// inside the project reaches project files, an external document reaches the
// read-only allowlist. A path that leaves its document's own world is rare
// enough to show as the alternative text instead.
const absoluteTarget = (filePath: string, context: MarkdownImageContext): MarkdownImageTarget => {
  if (context.isExternal) {
    return { kind: 'file', path: filePath, external: true };
  }
  return context.projectId
    ? { kind: 'file', path: filePath, external: false }
    : { kind: 'unresolved' };
};

/**
 * Joins a document directory with a Markdown-relative image path and collapses
 * `.`/`..` segments, so `../public/a.png` from `/repo/docs` becomes
 * `/repo/public/a.png`. A leading `/` in `relativePath` makes the result
 * absolute on its own; `..` segments above a root are dropped.
 */
export function resolveDocumentRelativePath(baseDir: string, relativePath: string): string {
  const joined = relativePath.startsWith('/') ? relativePath : `${baseDir}/${relativePath}`;
  const isAbsolute = joined.startsWith('/');
  const segments: string[] = [];

  for (const segment of joined.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return (isAbsolute ? '/' : '') + segments.join('/');
}

/**
 * The directory a Markdown document's relative image paths resolve against,
 * taken from the document's absolute path. Undefined when the path carries no
 * directory, which leaves the files route resolving against the project root.
 */
export function imageBaseDirFromFilePath(filePath: string): string | undefined {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const separatorIndex = normalizedPath.lastIndexOf('/');
  if (separatorIndex < 0) {
    return undefined;
  }
  return separatorIndex === 0 ? '/' : normalizedPath.slice(0, separatorIndex);
}

/**
 * Classifies one `img` source for the code editor's Markdown preview. Used by
 * MarkdownPreviewImage; every other module renders markdown through chat's own
 * renderer, which resolves paths against the project root instead.
 */
export function resolveMarkdownImageTarget(src: string, context: MarkdownImageContext): MarkdownImageTarget {
  const trimmed = src.trim();
  if (!trimmed) {
    return { kind: 'unresolved' };
  }
  if (BROWSER_IMAGE_SRC.test(trimmed)) {
    return { kind: 'browser', src: trimmed };
  }

  const fileUrlPath = filePathFromFileUrl(trimmed);
  if (fileUrlPath !== undefined) {
    return absoluteTarget(fileUrlPath, context);
  }

  const filePath = decodeSrc(trimmed).replace(/\\/g, '/');
  if (filePath.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(filePath) || WINDOWS_UNC_PATH.test(filePath)) {
    return absoluteTarget(filePath, context);
  }

  const relativePath = filePath.replace(/^\.\//, '');

  if (context.isExternal) {
    return context.baseDir
      ? { kind: 'file', path: resolveDocumentRelativePath(context.baseDir, relativePath), external: true }
      : { kind: 'unresolved' };
  }

  if (!context.projectId) {
    return { kind: 'unresolved' };
  }

  // Without a document directory (older callers) the path goes through as
  // written: the files route then resolves it against the project root, the
  // same fallback chat markdown uses.
  return {
    kind: 'file',
    path: context.baseDir
      ? resolveDocumentRelativePath(context.baseDir, relativePath)
      : relativePath,
    external: false,
  };
}
