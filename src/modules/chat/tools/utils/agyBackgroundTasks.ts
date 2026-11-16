/**
 * Parser for agy `manage_task` Action=list answers — the "Task / list" row's
 * result. The engine replies with a `Created At/Completed At` receipt header
 * followed by either a compact JSON array or one pretty-printed object per
 * running background command; an idle session answers with a plain sentence.
 * Shapes captured verbatim from local engine transcripts; see
 * docs/design/agy后台任务清单卡.md.
 */
export type AgyBackgroundTask = {
  taskId?: string;
  toolName?: string;
  /** toolSummary, falling back to the description's first line, then the taskId. */
  summary: string;
  description?: string;
  startTime?: string;
};

export type AgyBackgroundTaskList =
  | { kind: 'tasks'; tasks: AgyBackgroundTask[] }
  | { kind: 'empty' }
  /** The marker was there but no task payload parsed; keep the original text. */
  | { kind: 'raw'; text: string };

const RUNNING_MARKER = /You have \d+ background task\(s\) currently running:/i;
const IDLE_MARKER = /No background tasks are currently running/i;

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeTask(entry: unknown): AgyBackgroundTask | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const taskId = toOptionalString(record.taskId);
  const description = toOptionalString(record.description);
  const summary = toOptionalString(record.toolSummary)
    ?? description?.split('\n').map((line) => line.trim()).find(Boolean)
    ?? taskId;
  if (!summary) return null;
  return {
    taskId,
    toolName: toOptionalString(record.toolName),
    summary,
    description,
    startTime: toOptionalString(record.startTime),
  };
}

/** Parses a balanced `{...}` object out of the text starting at `start`. */
function extractObjectAt(text: string, start: number): { json: string; end: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { json: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * agy occasionally writes raw control characters inside JSON string literals
 * (a description's real newlines go in unescaped), which strict JSON.parse
 * rejects. Escaping control characters inside string literals is
 * semantics-preserving — those bytes are illegal in valid JSON anyway — so
 * this only repairs the engine's malformed output, never rewrites valid JSON.
 */
function escapeControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      } else {
        const code = ch.charCodeAt(0);
        if (code < 0x20) {
          out += code === 0x0a ? '\\n'
            : code === 0x0d ? '\\r'
              : code === 0x09 ? '\\t'
                : `\\u${code.toString(16).padStart(4, '0')}`;
          continue;
        }
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function parseJsonLenient(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // Retry once with control characters repaired.
  }
  try {
    return { ok: true, value: JSON.parse(escapeControlCharsInStrings(text)) };
  } catch {
    return { ok: false };
  }
}

function parsePayload(text: string): AgyBackgroundTask[] {
  const tasks: AgyBackgroundTask[] = [];
  const trimmed = text.trim();

  if (trimmed.startsWith('[')) {
    const parsed = parseJsonLenient(trimmed);
    if (parsed.ok && Array.isArray(parsed.value)) {
      for (const entry of parsed.value) {
        const task = normalizeTask(entry);
        if (task) tasks.push(task);
      }
      return tasks;
    }
  }

  // Pretty-printed answers put each task in its own `{...}` block.
  let cursor = trimmed.indexOf('{');
  while (cursor !== -1) {
    const found = extractObjectAt(trimmed, cursor);
    if (!found) break;
    const parsed = parseJsonLenient(found.json);
    if (parsed.ok) {
      const task = normalizeTask(parsed.value);
      if (task) tasks.push(task);
    }
    cursor = trimmed.indexOf('{', found.end);
  }
  return tasks;
}

/**
 * Turns a `manage_task` list answer into its tasks, or null when the content
 * is not a background-task answer at all (other actions' receipts, cleanup
 * noise) so callers can fall back to plain text.
 */
export function parseAgyBackgroundTaskList(content: string): AgyBackgroundTaskList | null {
  if (!content) return null;

  if (IDLE_MARKER.test(content)) {
    return { kind: 'empty' };
  }

  if (RUNNING_MARKER.test(content)) {
    const afterMarker = content.split(RUNNING_MARKER).pop() ?? '';
    const tasks = parsePayload(afterMarker);
    if (tasks.length > 0) {
      return { kind: 'tasks', tasks };
    }
    return { kind: 'raw', text: content };
  }

  // No receipt banner — accept a bare task array but nothing else, so other
  // actions' receipts ("Command exited with code 1") still stay null.
  const tasks = parsePayload(content);
  if (tasks.length > 0) {
    return { kind: 'tasks', tasks };
  }
  return null;
}
