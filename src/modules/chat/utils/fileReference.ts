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

// 本机绝对路径：POSIX 根、Windows 盘符或 UNC 写法。

/** 判断引用是否为本机绝对路径；`\\` 覆盖 Windows UNC 写法。 */
export const isLocalAbsolutePath = (value: string): boolean =>
  value.startsWith('/') || value.startsWith('\\\\') || /^[a-z]:[/\\]/i.test(value);

/** 拼接工作树根与相对引用，保留基准路径的分隔符风格。 */
export function joinWorktreePath(worktreePath: string, relative: string): string {
  const separator = worktreePath.includes('\\') ? '\\' : '/';
  const base = worktreePath.replace(/[/\\]+$/, '');
  return `${base}${separator}${relative.replace(/^[/\\]+/, '')}`;
}

/**
 * 相对引用的双候选探测路径：会话工作树拼接路径优先，项目根相对路径兜底；
 * 绝对路径只有自身一个候选。调用方仍需保证有项目或绝对路径才可解析。
 */
export function referenceProbeCandidates(
  reference: string,
  projectId: string | null,
  worktreePath: string | null,
): { primary: string | null; fallback: string | null } {
  if (isLocalAbsolutePath(reference) || !worktreePath) {
    return { primary: reference, fallback: null };
  }
  return { primary: joinWorktreePath(worktreePath, reference), fallback: reference };
}
