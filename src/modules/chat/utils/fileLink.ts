import { defaultUrlTransform } from 'react-markdown';

// Providers such as Antigravity link workspace-external documents (plan files
// under their brain directory) with `file://` URLs. The default URL transform
// strips the `file:` scheme, which destroys the absolute path, so those links
// are kept verbatim and converted back to a filesystem path when clicked.
export const isFileUrl = (url?: string): boolean => /^file:\/\//i.test(url ?? '');

export const isWindowsAbsolutePath = (url?: string): boolean =>
  /^[a-zA-Z]:([/\\]|%5[cC])/i.test(url ?? '');

// react-markdown `urlTransform` hook: keep `file://` URLs and Windows absolute paths
// intact and delegate every other URL to the library's default sanitization.
export const markdownUrlTransform = (url: string): string =>
  isFileUrl(url) || isWindowsAbsolutePath(url) ? url : defaultUrlTransform(url);

// Converts a `file://` URL back into an absolute filesystem path, decoding
// percent-escapes so paths with spaces or non-ASCII characters survive.
// Returns undefined for anything that is not a local `file://` URL (remote
// hosts such as `file://server/share` are not local paths).
export const filePathFromFileUrl = (href?: string): string | undefined => {
  if (!isFileUrl(href)) {
    return undefined;
  }
  try {
    const url = new URL(href as string);
    if (url.host && url.host !== 'localhost') {
      return undefined;
    }
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
};

// react-markdown percent-escapes non-ASCII characters and spaces before it
// hands an href to custom renderers. Decode filesystem references back to the
// path the editor can read, while leaving web and other non-file schemes alone.
export const fileReferenceFromMarkdownHref = (href?: string): string | undefined => {
  if (!href) {
    return undefined;
  }

  if (isFileUrl(href)) {
    return filePathFromFileUrl(href) ?? href;
  }

  if (!isWindowsAbsolutePath(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return href;
  }

  try {
    return decodeURIComponent(href);
  } catch {
    // A literal or incomplete percent escape may be part of a valid filename.
    return href;
  }
};
