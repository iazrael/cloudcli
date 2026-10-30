// Read the trailing `:line` / `:line:col` suffix so the editor can reveal it.
// Both this and stripLineSuffix are anchored at the end, so callers pass an
// already-trimmed reference.

/** 聊天 Markdown 的文件引用识别与打开共用：从引用末尾读出行号。 */
export const lineFromRef = (value: string): number | null => {
  const match = value.match(/:(\d+)(?::\d+)?$/);
  return match ? Number(match[1]) : null;
};

/** 去掉引用末尾的 `:line` / `:line:col` 后缀（如 `src/foo.ts:130`）。 */
export const stripLineSuffix = (value: string): string => value.replace(/:\d+(?::\d+)?$/, '');

// A usable file path contains a separator or a filename with an extension.

/** 判断引用是否像一个本地文件路径：含路径分隔符，或文件名带扩展名。 */
export const looksLikeFilePath = (value?: string): value is string => {
  if (!value) {
    return false;
  }
  const cleaned = stripLineSuffix(value.trim());
  if (!cleaned || cleaned === '#') {
    return false;
  }
  return /[\\/]/.test(cleaned) || /\.[a-z0-9]+$/i.test(cleaned);
};
