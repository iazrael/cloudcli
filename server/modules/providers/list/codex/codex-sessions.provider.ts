import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { getCodexHome } from '@/shared/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { codexBackgroundWork } from '@/modules/providers/list/codex/codex-background-work.js';
import {
  buildCodexSubagentAgentRow,
  codexThreadItemToRows,
  readCodexItemText,
  readCodexProposedPlan,
  readCodexRolloutItem,
} from '@/modules/providers/list/codex/codex-thread-items.js';
import {
  codexTurnFailureRowId,
  readCodexFailureMessage,
} from '@/modules/providers/list/codex/codex-turn-error.js';
import { parseFilesInputTag, toImageAttachments } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import { prepareTranscriptMessages } from '@/shared/message-unification.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  MemoryCitation,
    NormalizedMessage,
    ProviderSessionUsageInput,
    ProviderTokenUsageResult,
    SubagentActivity,
    SubagentInfo,
} from '@/shared/types.js';
import {
  ProviderDisplayAssetError,
  readJsonlRecords,
  parseProviderJson,
  AppError,
  createCompactionMessage,
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  readUsageNumber,
  removePathIfExists,
  sliceTailPage,
  MAX_TRANSMITTED_SUBAGENT_ACTIVITIES,
  truncateSubagentActivity,
} from '@/shared/utils.js';

const PROVIDER = 'codex';

/**
 * How far up the `~/.codex/sessions/<year>/<month>/<day>` tree a subagent
 * rollout is searched for when it is not next to its parent. Spawned agents
 * are written seconds after the parent, so one directory level up (the month)
 * already covers a run that crosses midnight.
 */
const SUBAGENT_LOOKUP_PARENT_LEVELS = 2;

type CodexHistoryResult = {
  messages: AnyRecord[];
  total?: number;
  hasMore?: boolean;
  offset?: number;
  limit?: number | null;
  tokenUsage?: unknown;
};

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Follows which turn a Codex rollout is inside as its rows stream past.
 *
 * A turn id is the address an edit cuts at: `thread/fork` takes a
 * `lastTurnId`, and that is what makes "edit this message" and "fork from
 * here" possible for Codex at all. Turns are bracketed by rows that carry
 * `turn_id` — `task_started` opens one, `turn_context` restates it,
 * `task_complete` closes it — and the prompt is written between them.
 *
 * `thread_rolled_back` retires the last N turns in place: the rows stay in
 * the file, but the turns are no longer part of the thread and the fork
 * endpoint refuses to cut at one. They are tracked here so a retired turn is
 * never offered as an anchor, rather than discovered when the fork fails.
 */
function createCodexTurnTracker() {
  /** Turn ids still part of the conversation, oldest first. */
  const liveTurnIds: string[] = [];
  const seenTurnIds = new Set<string>();
  const rolledBackTurnIds = new Set<string>();
  let currentTurnId: string | undefined;

  return {
    /** Feeds one rollout row in. */
    observe(entryType: unknown, payload: AnyRecord): void {
      if (entryType === 'event_msg' && payload.type === 'thread_rolled_back') {
        const retiredTurns = Number(payload.num_turns);
        for (let retired = 0; retired < retiredTurns && liveTurnIds.length > 0; retired++) {
          rolledBackTurnIds.add(liveTurnIds.pop() as string);
        }
        currentTurnId = undefined;
        return;
      }

      const turnId = readNonEmptyString(payload.turn_id);
      if (!turnId) {
        return;
      }
      currentTurnId = turnId;
      if (!seenTurnIds.has(turnId)) {
        seenTurnIds.add(turnId);
        liveTurnIds.push(turnId);
      }
    },
    /** The turn the rows being read belong to, or undefined outside one. */
    getCurrentTurnId(): string | undefined {
      return currentTurnId;
    },
    getLiveTurnIds(): string[] {
      return liveTurnIds;
    },
    isRolledBack(turnId: string): boolean {
      return rolledBackTurnIds.has(turnId);
    },
  };
}

/**
 * Reads the turns a Codex rollout still contains, oldest first.
 *
 * A separate pass rather than a by-product of the transcript reader: this runs
 * once when a message is edited, while the reader runs on every history fetch,
 * and both share the one rule for what a live turn is.
 */
async function readCodexLiveTurnIds(filePath: string): Promise<string[]> {
  const turns = createCodexTurnTracker();
  for await (const line of readCodexRolloutLines(filePath)) {
    if (!line.trim()) {
      continue;
    }
    let entry: AnyRecord;
    try {
      entry = JSON.parse(line) as AnyRecord;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    const payload = readObjectRecord(entry.payload);
    if (payload) {
      turns.observe(entry.type, payload);
    }
  }

  return turns.getLiveTurnIds();
}

/** Resolve reference-backed history without requiring the source to remain indexed. */
async function findCodexHistorySource(filePath: string, threadId: string): Promise<string | null> {
  const indexed = sessionsDb.getSessionByProviderSessionId(threadId);
  if (indexed?.provider === PROVIDER && indexed.jsonl_path) {
    try {
      if ((await fsp.stat(indexed.jsonl_path)).isFile()) {
        return indexed.jsonl_path;
      }
    } catch {
      // The native CLI can archive a rollout without updating the app row.
    }
  }

  let directory = path.dirname(filePath);
  while (path.dirname(directory) !== directory) {
    if (path.basename(directory) === 'sessions' || path.basename(directory) === 'archived_sessions') {
      const home = path.dirname(directory);
      for (const storage of ['sessions', 'archived_sessions']) {
        const found = await findFileWithSuffix(path.join(home, storage), `-${threadId}.jsonl`, 3);
        if (found) return found;
      }
      break;
    }
    directory = path.dirname(directory);
  }
  return null;
}

/**
 * Codex 0.160 paginated forks keep a frozen prefix in `history_base` instead
 * of copying it. Read each ancestor only through its recorded byte boundary,
 * then the child's own rows. `forked_from_id` alone also appears on copied
 * legacy rollouts and must never cause history to be included twice.
 */
async function* readCodexRolloutLines(
  filePath: string,
  endByteOffset?: number,
  ancestors = new Set<string>(),
): AsyncGenerator<string> {
  const canonicalPath = await fsp.realpath(filePath);
  if (ancestors.has(canonicalPath) || ancestors.size >= 128) {
    throw new AppError('Codex fork history contains a cyclic or excessively deep source chain.', {
      code: 'CODEX_HISTORY_SOURCE_INVALID', statusCode: 502,
    });
  }
  if (endByteOffset !== undefined) {
    if ((await fsp.stat(canonicalPath)).size < endByteOffset) {
      throw new AppError('The source transcript is shorter than the Codex fork snapshot.', {
        code: 'CODEX_HISTORY_SOURCE_INVALID', statusCode: 502,
      });
    }
    if (endByteOffset === 0) return;
  }
  const nextAncestors = new Set(ancestors).add(canonicalPath);
  const stream = fsSync.createReadStream(canonicalPath, {
    ...(endByteOffset !== undefined ? { end: endByteOffset - 1 } : {}),
  });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let readMetadata = false;
  try {
    for await (const line of lines) {
      let entry: AnyRecord | undefined;
      if (!readMetadata) {
        try { entry = readObjectRecord(JSON.parse(line)) ?? undefined; } catch { /* Skip malformed rows. */ }
      }
      if (entry?.type === 'session_meta') {
        readMetadata = true;
        const payload = readObjectRecord(entry.payload);
        if (payload?.history_base != null) {
          const base = readObjectRecord(payload.history_base);
          const threadId = readNonEmptyString(base?.thread_id);
          const offset = base?.end_byte_offset;
          if (!threadId || !/^[a-zA-Z0-9-]+$/.test(threadId)
            || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
            throw new AppError('Codex fork history has an invalid source boundary.', {
              code: 'CODEX_HISTORY_SOURCE_INVALID', statusCode: 502,
            });
          }
          const sourcePath = await findCodexHistorySource(canonicalPath, threadId);
          if (!sourcePath) {
            throw new AppError('The source transcript referenced by this Codex fork is unavailable.', {
              code: 'CODEX_HISTORY_SOURCE_UNAVAILABLE', statusCode: 502,
            });
          }
          yield* readCodexRolloutLines(sourcePath, offset, nextAncestors);
        }
      }
      yield line;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Reads the image attachments Codex records on `user_message` events.
 * Turns sent with `local_image` input items land in `local_images` as file
 * paths (verified against real rollout JSONL); the `images` array can carry
 * base64 data URLs, which are passed through as inline `data` attachments so
 * the UI can preview them without a file lookup.
 *
 * Exported for tests.
 */
export function extractCodexUserImages(
  payload: AnyRecord | null | undefined,
): Array<{ path?: string; data?: string }> | undefined {
  if (!payload) {
    return undefined;
  }

  const candidates = [
    ...(Array.isArray(payload.local_images) ? payload.local_images : []),
    ...(Array.isArray(payload.images) ? payload.images : []),
  ];

  const attachments: Array<{ path?: string; data?: string }> = [];
  for (const entry of candidates) {
    if (typeof entry !== 'string' || !entry.trim()) {
      continue;
    }
    if (entry.startsWith('data:')) {
      attachments.push({ data: entry });
    } else {
      attachments.push(...toImageAttachments([entry]));
    }
  }

  return attachments.length > 0 ? attachments : undefined;
}

function extractCodexTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as AnyRecord;
      if (
        (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text')
        && typeof record.text === 'string'
      ) {
        return record.text;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Reads image inputs from a typed UserMessage item. */
function extractCodexTypedUserImages(
  content: unknown,
): Array<{ path?: string; data?: string }> | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const attachments: Array<{ path?: string; data?: string }> = [];
  for (const rawEntry of content) {
    const entry = readObjectRecord(rawEntry);
    if (!entry) {
      continue;
    }

    const value = entry.type === 'local_image'
      ? readNonEmptyString(entry.path)
      : entry.type === 'image'
        ? readNonEmptyString(entry.image_url)
        : undefined;
    if (!value) {
      continue;
    }
    if (value.startsWith('data:')) {
      attachments.push({ data: value });
    } else {
      attachments.push(...toImageAttachments([value]));
    }
  }

  return attachments.length > 0 ? attachments : undefined;
}

/**
 * Reads the markdown out of Codex's `<proposed_plan>` envelope.
 *
 * Codex delivers a plan as a wrapped assistant message while Claude delivers
 * one as an `ExitPlanMode` call. Recognizing the envelope here lets both end up
 * on the same plan card instead of one provider showing a card and the other
 * showing prose with a stray tag in it. The closing tag is optional because a
 * streamed plan exposes the opening tag first.
 *
/**
 * The block Codex appends to a reply that leaned on its memory files. It is
 * always the last thing in the message and is meant for programmatic parsing,
 * so it reads as raw XML when left in the prose.
 */
const CODEX_MEMORY_CITATION_BLOCK = /<oai-mem-citation>([\s\S]*?)<\/oai-mem-citation>\s*$/i;

/**
 * Lifts Codex's memory citations out of an assistant reply.
 *
 * The block names the memory files and line ranges the answer drew on, which is
 * worth showing — but as a footnote under the reply, not as markup inside it.
 * The trailing `<rollout_ids>` list is dropped: those are handles to earlier
 * rollouts that the transcript view has no way to open.
 *
 * Exported for tests.
 */
export function readCodexMemoryCitations(text: string): { text: string; memoryCitations?: MemoryCitation[] } {
  const block = CODEX_MEMORY_CITATION_BLOCK.exec(text);
  if (!block) {
    return { text };
  }

  const entries = /<citation_entries>([\s\S]*?)<\/citation_entries>/i.exec(block[1])?.[1] ?? '';
  const memoryCitations: MemoryCitation[] = [];
  for (const line of entries.split('\n')) {
    const entry = line.trim();
    if (!entry) {
      continue;
    }

    const noteMarker = entry.indexOf('|note=');
    const source = (noteMarker === -1 ? entry : entry.slice(0, noteMarker)).trim();
    if (!source) {
      continue;
    }

    const note = noteMarker === -1
      ? ''
      : entry.slice(noteMarker + '|note='.length).trim().replace(/^\[/, '').replace(/\]$/, '').trim();
    memoryCitations.push(note ? { source, note } : { source });
  }

  const prose = text.slice(0, block.index).trimEnd();
  return memoryCitations.length > 0 ? { text: prose, memoryCitations } : { text: prose };
}

function extractCodexToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  if (!Array.isArray(output)) {
    return output == null ? '' : JSON.stringify(output);
  }

  return output
    .map((item) => {
      const record = readObjectRecord(item);
      return typeof record?.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('');
}

// ─── Codex "code mode" exec scripts ─────────────────────────────────────────
// Newer Codex builds (and every Sol-family model) stop calling shell/patch
// tools directly. Instead they emit one `exec` custom tool call whose input is
// a small JavaScript program that awaits `tools.<name>({...})`. Persisting that
// program verbatim is what makes the transcript read as raw machinery, so it is
// parsed back into the operations it performs.

type CodexExecOperation =
  | { kind: 'shell'; command: string; justification?: string }
  | { kind: 'stdin'; chars: string }
  | { kind: 'patch'; patch: string }
  | { kind: 'search'; queries: string[] }
  | { kind: 'plan'; todos: CodexPlanTodo[] };

/** One step of a checklist, in the shape the shared todo renderer consumes. */
type CodexPlanTodo = { content: string; status: string };

/**
 * Decodes one JavaScript string literal (single, double or backtick quoted).
 *
 * Template literals with `${}` interpolation are returned with the expression
 * text intact — the transcript has no bindings to evaluate, and showing the
 * raw template is still far more readable than the surrounding program.
 */
function decodeJavaScriptStringLiteral(literal: string): string {
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal) as string;
    } catch {
      return literal.slice(1, -1);
    }
  }

  return literal
    .slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([\\'`])/g, '$1');
}

/**
 * Returns the source of the argument list of the call that opens at
 * `openParenIndex`, skipping over parens that appear inside string literals.
 *
 * A plain regex cannot be used here: shell commands routinely embed `(`/`)`
 * and quotes, so the argument object has to be found by balancing.
 */
function readCallArguments(source: string, openParenIndex: number): string | null {
  let depth = 0;
  let quote: string | null = null;

  for (let index = openParenIndex; index < source.length; index += 1) {
    const character = source[index];

    if (quote) {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }

    if (character === '(') {
      depth += 1;
      continue;
    }

    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openParenIndex + 1, index);
      }
    }
  }

  return null;
}

/** Reads `key: "value"` / `"key": "value"` out of an object-literal source. */
function readStringProperty(objectSource: string, key: string): string | undefined {
  const pattern = new RegExp(
    `(?:["']${key}["']|\\b${key})\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)`,
    's',
  );
  const match = pattern.exec(objectSource);
  return match ? decodeJavaScriptStringLiteral(match[1]) : undefined;
}

/** Reads every `q: "..."` entry out of a `web__run` search-query array. */
function readSearchQueries(objectSource: string): string[] {
  const pattern = /(?:["']q["']|\bq)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs;
  return Array.from(objectSource.matchAll(pattern), (match) => decodeJavaScriptStringLiteral(match[1]));
}

/**
 * Finds the patch body an `apply_patch` call is given.
 *
 * The program almost always assigns it to a local first
 * (`const patch = "*** Begin Patch..."; tools.apply_patch(patch)`), so the
 * argument itself is usually an identifier. Scanning the whole script for the
 * literal that carries the patch header covers both forms.
 */
function readPatchLiteral(source: string): string | undefined {
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs;
  for (const match of source.matchAll(pattern)) {
    const decoded = decodeJavaScriptStringLiteral(match[1]);
    if (decoded.includes('*** Begin Patch')) {
      return decoded;
    }
  }
  return undefined;
}

/**
 * Reads the steps of an `update_plan` call made from an exec script.
 *
 * The script writes its argument as a JavaScript object literal with unquoted
 * keys, so it is not JSON — each `{step, status}` entry is matched directly.
 */
function readPlanSteps(objectSource: string): CodexPlanTodo[] {
  const todos: CodexPlanTodo[] = [];
  for (const entry of objectSource.matchAll(/\{([^{}]*)\}/g)) {
    const content = readStringProperty(entry[1], 'step') ?? readStringProperty(entry[1], 'content');
    if (content) {
      todos.push({ content, status: readStringProperty(entry[1], 'status') ?? 'pending' });
    }
  }

  return todos;
}

/**
 * Recovers commands a script keeps in a local array and maps over, which is how
 * Codex batches several shell calls:
 *   `const cmds = ["a", "b"]; await Promise.all(cmds.map(command => tools.shell_command({ command })))`
 * The call site then passes `{ command }` shorthand, so there is no literal to
 * read at the call itself.
 */
function readMappedCommandCandidates(source: string): string[] {
  const commands: string[] = [];
  const arrayPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]*?)\]\s*;/g;
  const stringPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs;

  for (const arrayMatch of source.matchAll(arrayPattern)) {
    if (!new RegExp(`\\b${arrayMatch[1]}\\.map\\s*\\(`).test(source)) {
      continue;
    }
    for (const stringMatch of arrayMatch[2].matchAll(stringPattern)) {
      commands.push(decodeJavaScriptStringLiteral(stringMatch[1]));
    }
  }

  return commands;
}

/**
 * Turns one Codex `exec` script into the operations it performs, in source
 * order. An empty result means the script did nothing recognizable and the
 * caller should fall back to showing it as code.
 *
 * Exported for tests.
 */
export function parseCodexExecScript(input: unknown): CodexExecOperation[] {
  const source = typeof input === 'string' ? input : String(input ?? '');
  if (!source.includes('tools.')) {
    return [];
  }

  const operations: CodexExecOperation[] = [];
  const callPattern = /tools\.([A-Za-z_0-9]+)\s*\(/g;
  /** Filled in lazily, and only once, for shorthand-argument shell calls. */
  let mappedCommands: string[] | null = null;

  for (const match of source.matchAll(callPattern)) {
    const toolName = match[1];
    const openParenIndex = match.index + match[0].length - 1;
    const argumentSource = readCallArguments(source, openParenIndex) ?? '';

    switch (toolName) {
      case 'shell_command':
      case 'exec_command': {
        const command = readStringProperty(argumentSource, 'command')
          ?? readStringProperty(argumentSource, 'cmd');
        if (command) {
          operations.push({
            kind: 'shell',
            command,
            justification: readStringProperty(argumentSource, 'justification'),
          });
          break;
        }

        if (mappedCommands === null) {
          mappedCommands = readMappedCommandCandidates(source);
          for (const mappedCommand of mappedCommands) {
            operations.push({ kind: 'shell', command: mappedCommand });
          }
        }
        break;
      }
      case 'write_stdin': {
        operations.push({ kind: 'stdin', chars: readStringProperty(argumentSource, 'chars') ?? '' });
        break;
      }
      case 'apply_patch': {
        const patch = readPatchLiteral(argumentSource) ?? readPatchLiteral(source);
        if (patch) {
          operations.push({ kind: 'patch', patch });
        }
        break;
      }
      case 'web__run':
      case 'web_search': {
        const queries = readSearchQueries(argumentSource);
        if (queries.length > 0) {
          operations.push({ kind: 'search', queries });
        }
        break;
      }
      case 'update_plan': {
        const todos = readPlanSteps(argumentSource);
        if (todos.length > 0) {
          operations.push({ kind: 'plan', todos });
        }
        break;
      }
      default:
        break;
    }
  }

  return operations;
}

// ─── Codex shell output ─────────────────────────────────────────────────────

type CodexShellOutput = {
  output: string;
  /** Set when the command has exited; `undefined` while it is still running. */
  exitCode?: number;
  /** Present while the command runs in the background under this cell id. */
  runningCellId?: string;
  truncated: boolean;
};

/**
 * Strips the two nested envelopes Codex wraps shell output in.
 *
 * The outer one reports on the sandbox *script* (`Script completed`, its wall
 * time, and `Output:`); the inner one reports on the *command* (`Exit code`,
 * its own wall time, an optional line count). Neither is useful in a chat
 * transcript, but the exit code decides whether the row is shown as failed, so
 * it is lifted out before the text is discarded.
 *
 * Exported for tests.
 */
export function cleanCodexShellOutput(rawOutput: string): CodexShellOutput {
  let output = rawOutput;
  let exitCode: number | undefined;
  let runningCellId: string | undefined;
  let truncated = false;

  const runningMatch = /^Script running with cell ID\s+(\S+)[^\n]*\n?/i.exec(output);
  if (runningMatch) {
    runningCellId = runningMatch[1];
    output = output.slice(runningMatch[0].length);
  } else {
    output = output.replace(/^Script (?:completed|failed)[^\n]*\n?/i, '');
  }

  output = output.replace(/^Wall time[^\n]*\n?/i, '');
  output = output.replace(/^Output:\s*\n?/i, '');
  output = output.replace(/^Script error:\s*\n?/i, '');

  const truncationMatch = /^Warning: truncated output[^\n]*\n(?:Total output lines:[^\n]*\n)?\n?/i.exec(output);
  if (truncationMatch) {
    truncated = true;
    output = output.slice(truncationMatch[0].length);
    output = output.replace(/^Script error:\s*\n?/i, '');
  }

  const exitCodeMatch = /^Exit code:\s*(-?\d+)[^\n]*\n?/i.exec(output);
  if (exitCodeMatch) {
    exitCode = Number.parseInt(exitCodeMatch[1], 10);
    output = output.slice(exitCodeMatch[0].length);
    output = output.replace(/^Wall time:[^\n]*\n?/i, '');
    output = output.replace(/^Total output lines:[^\n]*\n?/i, '');
    output = output.replace(/^Output:\s*\n?/i, '');
  }

  return { output, exitCode, runningCellId, truncated };
}

/**
 * `write_stdin` answers with a JSON envelope rather than plain text. Only its
 * `output` and `exit_code` matter to a reader.
 */
function readCodexStdinOutput(rawOutput: string): CodexShellOutput | null {
  const trimmed = rawOutput.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart === -1) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as AnyRecord;
    if (typeof parsed.output !== 'string') {
      return null;
    }
    return {
      output: parsed.output,
      exitCode: typeof parsed.exit_code === 'number' ? parsed.exit_code : undefined,
      truncated: false,
    };
  } catch {
    return null;
  }
}

// ─── Unified patches ────────────────────────────────────────────────────────

type CodexFileChange = {
  filePath: string;
  /** `add` and `delete` are rendered as a whole-file write/removal. */
  changeType: 'add' | 'update' | 'delete';
  oldText: string;
  newText: string;
};

/**
 * Rebuilds the before/after text of one unified diff.
 *
 * Only the hunks are available — never the whole file — so the reconstruction
 * keeps context lines in both sides and drops hunk headers. Feeding that pair
 * to the frontend's line differ reproduces exactly the additions, removals and
 * surrounding context the patch described, which is what Claude's `Edit` rows
 * already show.
 *
 * Exported for tests.
 */
export function unifiedDiffToTexts(unifiedDiff: string): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\ No newline')) {
      continue;
    }
    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
      continue;
    }
    const contextLine = line.startsWith(' ') ? line.slice(1) : line;
    oldLines.push(contextLine);
    newLines.push(contextLine);
  }

  // A unified diff ends with a newline, which would otherwise reconstruct as a
  // phantom trailing blank line on both sides.
  if (oldLines[oldLines.length - 1] === '' && newLines[newLines.length - 1] === '') {
    oldLines.pop();
    newLines.pop();
  }

  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

/**
 * Splits a `*** Begin Patch` body into one change per file.
 *
 * Exported for tests.
 */
export function parseCodexPatch(patch: string): CodexFileChange[] {
  const changes: CodexFileChange[] = [];
  const lines = patch.split('\n');
  let current: { filePath: string; changeType: CodexFileChange['changeType']; body: string[] } | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    const { oldText, newText } = unifiedDiffToTexts(current.body.join('\n'));
    changes.push({
      filePath: current.filePath,
      changeType: current.changeType,
      oldText: current.changeType === 'add' ? '' : oldText,
      newText: current.changeType === 'delete' ? '' : newText,
    });
    current = null;
  };

  for (const line of lines) {
    const fileHeader = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(line);
    if (fileHeader) {
      flush();
      const changeType = fileHeader[1].toLowerCase() as CodexFileChange['changeType'];
      current = { filePath: fileHeader[2].trim(), changeType, body: [] };
      continue;
    }

    if (line.startsWith('*** ')) {
      // `*** Begin Patch`, `*** End Patch`, `*** Move to:` — never diff content.
      continue;
    }

    current?.body.push(line);
  }

  flush();
  return changes;
}

/** Converts a `patch_apply_end` change map into the same per-file shape. */
function readPatchApplyChanges(changes: unknown): CodexFileChange[] {
  const record = readObjectRecord(changes);
  if (!record) {
    return [];
  }

  const parsed: CodexFileChange[] = [];
  for (const [filePath, rawChange] of Object.entries(record)) {
    const change = readObjectRecord(rawChange);
    if (!change) {
      continue;
    }
    const changeType = change.type === 'add' || change.type === 'delete' ? change.type : 'update';
    const { oldText, newText } = unifiedDiffToTexts(
      typeof change.unified_diff === 'string' ? change.unified_diff : '',
    );
    parsed.push({
      filePath,
      changeType,
      oldText: changeType === 'add' ? '' : oldText,
      newText: changeType === 'delete' ? '' : newText,
    });
  }

  return parsed;
}

/** Maps a file change onto the tool the frontend already renders diffs for. */
function fileChangeToToolMessage(change: CodexFileChange, timestamp: string, toolCallId: string): AnyRecord {
  const toolName = change.changeType === 'add' ? 'Write' : 'Edit';
  return {
    type: 'tool_use',
    timestamp,
    toolName,
    toolInput: JSON.stringify({
      file_path: change.filePath,
      old_string: change.oldText,
      new_string: change.newText,
      ...(change.changeType === 'delete' ? { deleted: true } : {}),
    }),
    toolCallId,
  };
}

/** Reads the `file_path` back out of a rendered file-change row. */
function readRowFilePath(row: AnyRecord): string {
  try {
    return String((JSON.parse(String(row.toolInput ?? '{}')) as AnyRecord).file_path ?? '');
  } catch {
    return '';
  }
}

/**
 * Rewrites the rows reconstructed from a patch call's input with the
 * authoritative diffs Codex reports once the patch has been applied.
 *
 * Rows are matched by path, never by position: `patch_apply_end` reports the
 * touched files in map order, which does not follow the order they appeared in
 * the patch body. Rows whose file the report does not mention are dropped
 * rather than left behind claiming an edit that never happened.
 */
function rewritePatchRows(
  rows: AnyRecord[],
  changes: CodexFileChange[],
  callId: string,
  messages: AnyRecord[],
): void {
  const rowsByPath = new Map<string, AnyRecord>();
  for (const row of rows) {
    rowsByPath.set(readRowFilePath(row), row);
  }

  const keptRows: AnyRecord[] = [];
  for (const [index, change] of changes.entries()) {
    const replacement = fileChangeToToolMessage(change, String(rows[0]?.timestamp ?? ''), `${callId}#${index}`);
    const existing = rowsByPath.get(change.filePath);
    if (existing) {
      existing.toolName = replacement.toolName;
      existing.toolInput = replacement.toolInput;
      keptRows.push(existing);
      rowsByPath.delete(change.filePath);
      continue;
    }

    replacement.timestamp = rows[0]?.timestamp ?? replacement.timestamp;
    keptRows.push(replacement);
    messages.push(replacement);
  }

  for (const surplus of rowsByPath.values()) {
    const position = messages.indexOf(surplus);
    if (position !== -1) {
      messages.splice(position, 1);
    }
  }

  rows.splice(0, rows.length, ...keptRows);
}

// ─── Subagents ──────────────────────────────────────────────────────────────

type CodexSubagentRecord = {
  toolCallId: string;
  message: AnyRecord;
  agentPath?: string;
  agentThreadId?: string;
  isComplete: boolean;
  /** Closed by an interruption or abort rather than by a final answer: it ended with no result. */
  wasStopped?: boolean;
  /**
   * The engine's `completed` activity is on record. Its FINAL_ANSWER can be
   * missing or unreadable (real rollouts carry encrypted reports), so this
   * alone settles the card as completed — the word live settles it on.
   */
  reportedComplete?: boolean;
};

function parseCodexSubagentMessage(payload: AnyRecord): {
  author: string;
  messageType: string;
  result: string;
} | null {
  const text = readCodexItemText(payload.content);
  const header = /Message Type:\s*([^\r\n]+)[\s\S]*?Sender:\s*([^\r\n]+)[\s\S]*?Payload:\s*\r?\n([\s\S]*)/i.exec(text);
  const author = readNonEmptyString(payload.author) || header?.[2]?.trim();
  if (!author) {
    return null;
  }

  return {
    author,
    messageType: header?.[1]?.trim().toUpperCase() || 'MESSAGE',
    result: header?.[3]?.trim() || '',
  };
}

/**
 * Codex names a spawned agent's rollout file `rollout-<timestamp>-<threadId>`
 * and writes it next to the parent's. Look there first, then widen to the
 * enclosing day/month directories so a run that crosses midnight still
 * resolves, and give up rather than walking the whole archive.
 */
async function findCodexSubagentRollout(
  parentFilePath: string,
  agentThreadId: string,
): Promise<string | null> {
  const suffix = `-${agentThreadId}.jsonl`;
  let directory = path.dirname(parentFilePath);

  for (let level = 0; level <= SUBAGENT_LOOKUP_PARENT_LEVELS; level += 1) {
    const match = await findFileWithSuffix(directory, suffix, level === 0 ? 0 : level);
    if (match) {
      return match;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return null;
}

/** Depth-limited search for a file whose name ends with `suffix`. */
async function findFileWithSuffix(directory: string, suffix: string, depth: number): Promise<string | null> {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  const subdirectories: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      subdirectories.push(path.join(directory, entry.name));
      continue;
    }
    if (entry.name.endsWith(suffix)) {
      return path.join(directory, entry.name);
    }
  }

  if (depth <= 0) {
    return null;
  }

  for (const subdirectory of subdirectories) {
    const match = await findFileWithSuffix(subdirectory, suffix, depth - 1);
    if (match) {
      return match;
    }
  }

  return null;
}

type CodexSubagentTranscript = {
  activity: SubagentActivity[];
  nickname?: string;
  agentPath?: string;
  model?: string;
  /** How the agent's last turn ended; absent while that turn has no end. */
  lastTurnEnd?: 'completed' | 'failed' | 'stopped';
};

/**
 * Flattens a spawned agent's own rollout into the shared activity timeline.
 *
 * A subagent's rollout is the same format as the parent's, so it is read the
 * same way: through the assembled `item_completed` stream and the one row
 * renderer. The rows are then folded into the panel's activity shape, which
 * pairs each tool call with its result.
 */
async function readCodexSubagentTranscript(filePath: string): Promise<CodexSubagentTranscript> {
  const activity: SubagentActivity[] = [];
  const transcript: CodexSubagentTranscript = { activity };
  /** Tool activities still waiting for the result row that settles them. */
  const pendingResults = new Map<string, SubagentActivity>();

  let fileStream;
  try {
    fileStream = fsSync.createReadStream(filePath);
  } catch {
    return transcript;
  }

  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    let entry: AnyRecord;
    try {
      entry = parseProviderJson(line) as AnyRecord;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }

    const payload = readObjectRecord(entry.payload);
    if (!payload) {
      continue;
    }

    if (entry.type === 'session_meta') {
      // A resumed rollout writes a second, sparser session_meta; assigning
      // unconditionally would erase the identity the first one carried.
      transcript.nickname = readNonEmptyString(payload.agent_nickname) ?? transcript.nickname;
      transcript.agentPath = readNonEmptyString(payload.agent_path) ?? transcript.agentPath;
      continue;
    }

    if (entry.type === 'turn_context') {
      transcript.model = readNonEmptyString(payload.model) ?? transcript.model;
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'task_started') {
      transcript.lastTurnEnd = undefined;
      continue;
    }
    if (entry.type === 'event_msg' && payload.type === 'task_complete') {
      transcript.lastTurnEnd = readObjectRecord(payload.error) ? 'failed' : 'completed';
      continue;
    }
    if (entry.type === 'event_msg' && payload.type === 'turn_aborted') {
      transcript.lastTurnEnd = 'stopped';
      continue;
    }

    if (entry.type !== 'event_msg' || payload.type !== 'item_completed') {
      continue;
    }

    const item = readCodexRolloutItem(payload.item);
    // The agent's own prompt is the task it was given, which the parent's
    // `Agent` card already states; its lifecycle events belong to the parent.
    if (!item || item.kind === 'user_message' || item.kind === 'subagent_activity') {
      continue;
    }

    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
    for (const row of codexThreadItemToRows(item, timestamp ?? '')) {
      if (row.type === 'assistant' || row.type === 'thinking') {
        const content = String(row.message?.content ?? '').trim();
        if (content) {
          activity.push({ kind: row.type === 'thinking' ? 'thinking' : 'text', content, timestamp });
        }
        continue;
      }

      if (row.type === 'tool_use') {
        const record: SubagentActivity = {
          kind: 'tool',
          timestamp,
          toolId: String(row.toolCallId ?? ''),
          toolName: String(row.toolName ?? 'tool'),
          toolInput: row.toolInput,
        };
        activity.push(record);
        pendingResults.set(record.toolId as string, record);
        continue;
      }

      if (row.type === 'tool_result') {
        const target = pendingResults.get(String(row.toolCallId ?? ''));
        if (target) {
          target.toolResult = { content: String(row.output ?? ''), isError: Boolean(row.isError) };
        }
      }
    }
  }

  return transcript;
}

// ─── Transcript reader ──────────────────────────────────────────────────────

/**
 * Locates a Codex rollout JSONL by its session id under `~/.codex/sessions`.
 *
 * Codex partitions rollout files into date folders, so the lookup recurses;
 * the app row's indexed `jsonl_path` wins when it still exists (see
 * `getTokenUsage`). An unreadable branch is simply not a match.
 */
async function findCodexSessionFile(
  directoryPath: string,
  providerSessionId: string,
): Promise<string | null> {
  let entries;
  try {
    entries = await fsp.readdir(directoryPath, { withFileTypes: true });
  } catch {
    // Codex session folders are date-partitioned and can disappear while a
    // cleanup is running. An unreadable branch is simply not a match.
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = await findCodexSessionFile(entryPath, providerSessionId);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
      return entryPath;
    }
  }

  return null;
}

/**
 * Reads the latest `token_count` snapshot from a Codex rollout JSONL.
 *
 * Codex appends cumulative totals over time, so the scan walks from the end
 * and stops at the first readable token_count entry.
 */
async function readCodexTokenUsage(filename: string): Promise<ProviderTokenUsageResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let contextWindow = 200_000;

  for await (const entry of readJsonlRecords(filename)) {
      const tokenInfo = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
        ? entry.payload.info
        : null;
      if (!tokenInfo) {
        continue;
      }

      inputTokens = 0;
      outputTokens = 0;
      totalTokens = 0;
      if (tokenInfo.total_token_usage) {
        inputTokens = readUsageNumber(tokenInfo.total_token_usage.input_tokens);
        outputTokens = readUsageNumber(tokenInfo.total_token_usage.output_tokens);
        totalTokens = readUsageNumber(tokenInfo.total_token_usage.total_tokens)
          || inputTokens + outputTokens;
      }
      contextWindow = readUsageNumber(tokenInfo.model_context_window) || 200_000;
  }

  return {
    used: totalTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

/**
 * Reads one Codex rollout file and produces the compact per-message records
 * `normalizeHistoryEntry` turns into `NormalizedMessage`s.
 *
 * Only the rollout's assembled view is read — the `event_msg` →
 * `item_completed` entries — never the raw `response_item` records beside
 * them. Both describe the same work, but only the items carry the id Codex
 * also puts on the live `app-server` notification, and the live run reads
 * those through the same `codexThreadItemToRows`. A row therefore has one
 * identity and one shape no matter which side produced it, which is what
 * stops a reply rendering once live and once again from history.
 *
 * Three records are read outside the item stream because nothing in it carries
 * them: `token_count` (the context budget) and a spawned agent's
 * `agent_message`, whose FINAL_ANSWER never becomes an item and is folded
 * into the result of the `Agent` row that started the agent, and the
 * `task_complete` that closes a failed turn with the cause the engine
 * reports.
 */
async function getCodexSessionMessages(sessionId: string): Promise<CodexHistoryResult> {
  const sessionFilePath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

  if (!sessionFilePath) {
    console.warn(`Codex session file not found for session ${sessionId}`);
    return { messages: [], total: 0, hasMore: false };
  }

  const messages: AnyRecord[] = [];
  let tokenUsage: AnyRecord | null = null;

  const turns = createCodexTurnTracker();
  /** Turns whose prompt already carries the anchor, so only the first does. */
  const anchoredTurnIds = new Set<string>();
  /** The failure rows already written, so one failure is one row. */
  const failureRowIds = new Set<string>();

  /**
   * Every spawned agent's `Agent` row, indexed by each handle it can later be
   * addressed by: the lifecycle event's own id, the agent's path, and the
   * thread id its transcript lives under.
   */
  const subagentsByCallId = new Map<string, CodexSubagentRecord>();
  const subagentsByPath = new Map<string, CodexSubagentRecord>();
  const subagentsByThread = new Map<string, CodexSubagentRecord>();

  const indexSubagent = (record: CodexSubagentRecord): void => {
    subagentsByCallId.set(record.toolCallId, record);
    if (record.agentPath) {
      subagentsByPath.set(record.agentPath, record);
    }
    if (record.agentThreadId) {
      subagentsByThread.set(record.agentThreadId, record);
    }
  };

  /** Settles a `Agent` row; without a result the card renders as running forever. */
  const closeSubagent = (
    record: CodexSubagentRecord,
    timestamp: string,
    output: string,
    isError: boolean,
    stopped = false,
  ): void => {
    if (record.isComplete) {
      return;
    }
    record.isComplete = true;
    record.wasStopped = stopped;
    messages.push({
      uuid: `${record.toolCallId}_result`,
      type: 'tool_result',
      timestamp,
      toolCallId: record.toolCallId,
      output,
      isError,
    });
  };

  for await (const line of readCodexRolloutLines(sessionFilePath)) {
    if (!line.trim()) {
      continue;
    }

    let entry: AnyRecord;
    try {
      entry = parseProviderJson(line) as AnyRecord;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }

    const payload = readObjectRecord(entry.payload);
    if (!payload) {
      continue;
    }
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString();

    // A turn is opened and closed by rows that produce no transcript entry of
    // their own, so the tracker sees every row before the branches below.
    turns.observe(entry.type, payload);

    if (entry.type === 'response_item') {
      // A spawned agent reports back as an `agent_message` addressed from its
      // path. The FINAL_ANSWER is the only part of a sub-agent's work that
      // never becomes an item, so it is read here and nowhere else.
      if (payload.type === 'agent_message') {
        const message = parseCodexSubagentMessage(payload);
        if (message?.messageType === 'FINAL_ANSWER' && message.result) {
          const record = subagentsByPath.get(message.author);
          if (record) {
            closeSubagent(record, timestamp, message.result, false);
          }
        }
      }
      continue;
    }

    if (entry.type !== 'event_msg') {
      continue;
    }

    if (payload.type === 'token_count' && payload.info) {
      const info = payload.info as AnyRecord;
      if (info.total_token_usage) {
        const usage = info.total_token_usage as AnyRecord;
        tokenUsage = { used: usage.total_tokens || 0, total: info.model_context_window || 200000 };
      }
      continue;
    }

    if (payload.type === 'turn_aborted') {
      // An abort ends the whole agent tree — a spawned agent that never
      // reported back will receive no FINAL_ANSWER later in the file, so it
      // is settled here or its Agent card renders as running forever. The
      // result is an error row: the agent did not finish its work.
      for (const record of subagentsByCallId.values()) {
        if (!record.reportedComplete) {
          closeSubagent(record, timestamp, 'Subagent ended when the turn was interrupted.', true, true);
        }
      }
      messages.push({
        // No item is written for an abort, so the row is named after the
        // append-only position the file itself records: reproducible across
        // reads, which is all a history-only row needs.
        uuid: typeof entry.ordinal === 'number' ? `ord_${entry.ordinal}` : `line_${messages.length}`,
        type: 'status_note',
        timestamp,
        content: payload.reason === 'interrupted'
          ? 'Turn interrupted'
          : `Turn aborted (${String(payload.reason ?? 'unknown')})`,
      });
      continue;
    }

    if (payload.type === 'task_complete') {
      // A turn that failed records its cause here and nowhere else: the engine
      // writes no item for it, so nothing in the item stream carries it. Read
      // it, or the transcript keeps a prompt with no answer and no reason and
      // the failure the live stream reported is gone after the next read.
      const message = readCodexFailureMessage({ error: payload.error });
      if (message) {
        const turnId = readNonEmptyString(payload.turn_id);
        // The turn id is the engine's own name for the turn, and the live
        // error row carries the same one: the persisted copy replaces the
        // live copy instead of the transcript showing the failure twice. A
        // record without one still shows the reason — the file's own
        // position names that row, the way an aborted turn's note is named.
        const uuid = turnId
          ? codexTurnFailureRowId(turnId)
          : typeof entry.ordinal === 'number' ? `ord_${entry.ordinal}` : `line_${messages.length}`;
        if (!failureRowIds.has(uuid)) {
          failureRowIds.add(uuid);
          messages.push({
            uuid,
            type: 'error',
            timestamp,
            content: message,
          });
        }
      }
      continue;
    }

    if (payload.type !== 'item_completed') {
      continue;
    }

    const item = readCodexRolloutItem(payload.item);
    if (!item) {
      continue;
    }

    if (item.kind === 'subagent_activity') {
      const existing = (item.agentThreadId ? subagentsByThread.get(item.agentThreadId) : undefined)
        ?? (item.agentPath ? subagentsByPath.get(item.agentPath) : undefined)
        ?? subagentsByCallId.get(item.id);

      if (item.activity === 'started' && !existing) {
        // The spawn itself reaches the item stream only as this lifecycle
        // event, so the `Agent` row is built from it and keeps its id.
        const taskMessage = buildCodexSubagentAgentRow(item, timestamp);
        messages.push(taskMessage);
        indexSubagent({
          toolCallId: item.id,
          message: taskMessage,
          agentPath: item.agentPath,
          agentThreadId: item.agentThreadId,
          isComplete: false,
        });
        continue;
      }

      if (!existing) {
        continue;
      }
      // Later events fill in the handles the first one did not carry.
      existing.agentPath = existing.agentPath ?? item.agentPath;
      existing.agentThreadId = existing.agentThreadId ?? item.agentThreadId;
      indexSubagent(existing);

      if (item.activity === 'completed') {
        existing.reportedComplete = true;
      } else if (item.activity === 'interrupted' && !existing.reportedComplete) {
        closeSubagent(existing, timestamp, 'Subagent was interrupted before returning a final answer.', false, true);
      }
      continue;
    }

    const rows = codexThreadItemToRows(item, timestamp);

    if (item.kind === 'user_message') {
      // Only the first prompt of a turn is anchored. A turn can hold more than
      // one — a follow-up queued while the turn was running is written into it
      // — and the edit cut is per turn, so anchoring the second would quietly
      // take the first with it.
      const turnId = turns.getCurrentTurnId();
      if (turnId && !anchoredTurnIds.has(turnId) && rows.length > 0) {
        anchoredTurnIds.add(turnId);
        rows[0].turnId = turnId;
      }
    }

    if (item.kind === 'collab_spawn' && rows.length > 0) {
      const receivers = item.receiverThreadIds?.length ? item.receiverThreadIds : [undefined];
      for (const agentThreadId of receivers) {
        const toolCallId = receivers.length > 1 ? `${item.id}:${agentThreadId}` : item.id;
        const existing = agentThreadId ? subagentsByThread.get(agentThreadId) : undefined;
        if (existing && existing.toolCallId !== toolCallId) {
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i].toolCallId === toolCallId) rows.splice(i, 1);
          continue;
        }
        const message = rows.find((row) => row.type === 'tool_use' && row.toolCallId === toolCallId);
        if (message) indexSubagent({ toolCallId, message, agentThreadId, isComplete: item.status === 'failed' || item.status === 'interrupted' });
      }
    }

    messages.push(...rows);
  }

  await attachCodexSubagentTranscripts(sessionFilePath, subagentsByCallId);

  // A rollback is recorded after the turns it retires, so a prompt can be
  // anchored and then retired later in the same file. Its rows still render —
  // they are what the conversation looked like — but the turn is gone from the
  // thread, so the anchor goes with it and the message loses its pencil.
  for (const message of messages) {
    if (typeof message.turnId === 'string' && turns.isRolledBack(message.turnId)) {
      delete message.turnId;
    }
  }

  messages.sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
  return { messages, tokenUsage: tokenUsage ?? undefined };
}

/**
 * Loads each spawned agent's own rollout and hangs its timeline off the
 * `Agent` row that started it.
 */
async function attachCodexSubagentTranscripts(
  parentFilePath: string,
  subagentsByCallId: Map<string, CodexSubagentRecord>,
): Promise<void> {
  for (const record of subagentsByCallId.values()) {
    let parsedInput: AnyRecord = {};
    try {
      parsedInput = JSON.parse(String(record.message.toolInput || '{}')) as AnyRecord;
    } catch {
      parsedInput = {};
    }

    const agentName = record.agentPath?.split('/').filter(Boolean).pop();
    // Codex has no agent-type concept the way Claude does, so `type` is left
    // unset rather than filled with the provider's own name; the panel falls
    // back to a neutral label.
    const subagent: SubagentInfo = {
      id: record.agentThreadId ?? record.toolCallId,
      description: readNonEmptyString(parsedInput.description as string | undefined) ?? agentName,
      status: record.isComplete
        ? (record.wasStopped ? 'stopped' : 'completed')
        : record.reportedComplete
          ? 'completed'
          : codexBackgroundWork.has(record.agentThreadId ?? record.toolCallId) ? 'running' : 'stopped',
    };
    // An agent with no end record in the parent's rollout is running only
    // while the runtime tracks it. Otherwise its own last turn says how it
    // ended, the same turn the live card settled from; with no ended turn the
    // app-server that ran it is gone and it can never report, so the card
    // must not spin forever.
    const readsOwnLastTurn = subagent.status === 'stopped' && !record.isComplete;

    if (record.agentThreadId) {
      const rolloutPath = await findCodexSubagentRollout(parentFilePath, record.agentThreadId);
      if (rolloutPath) {
        const transcript = await readCodexSubagentTranscript(rolloutPath);
        if (readsOwnLastTurn && transcript.lastTurnEnd) {
          subagent.status = transcript.lastTurnEnd;
        }
        if (transcript.activity.length > 0) {
          record.message.subagentTools = transcript.activity
            .slice(0, MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)
            .map(truncateSubagentActivity);
          subagent.activityCount = transcript.activity.length;
        }
        subagent.name = transcript.nickname ?? agentName;
        subagent.model = transcript.model;
      }
    }

    subagent.name = subagent.name ?? agentName;
    record.message.subagent = subagent;
  }
}

/** The provider registry uses this reader for session history and message edits. */
export class CodexSessionsProvider implements IProviderSessions {
  /**
   * Resolves the last turn to keep when the turn `anchorId` names is replaced.
   *
   * `thread/fork`'s `lastTurnId` is inclusive of the turn it names, which is
   * the same thing this contract's `resumeThroughId` means, so the answer is
   * simply the turn before the edited one. Editing the first prompt leaves
   * nothing to keep, and `null` is how that is reported.
   */
  async resolveEditAnchor(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null }> {
    const session = sessionsDb.getSessionById(sessionId);
    const jsonlPath = session?.jsonl_path;
    if (!jsonlPath || !session?.provider_session_id) {
      return { found: false, resumeThroughId: null };
    }

    const liveTurnIds = await readCodexLiveTurnIds(jsonlPath);
    const anchorIndex = liveTurnIds.indexOf(anchorId);
    if (anchorIndex < 0) {
      return { found: false, resumeThroughId: null };
    }

    return {
      found: true,
      resumeThroughId: anchorIndex === 0 ? null : liveTurnIds[anchorIndex - 1],
    };
  }

  /**
   * Branches the conversation at `keepThroughId` and moves the session onto
   * the branch.
   *
   * Codex threads are append-only — the SDK resumes one at its tip and nothing
   * shortens it — so rewinding means copying the part being kept into a new
   * thread. The pre-edit thread stays on disk in full and is recorded as
   * superseded so the session indexer does not hand it back later.
   */
  async rewindSession(sessionId: string, keepThroughId: string | null): Promise<void> {
    const session = sessionsDb.getSessionById(sessionId);
    const supersededThreadId = session?.provider_session_id;
    if (!session || !supersededThreadId) {
      throw new AppError('This session has not produced a transcript yet.', {
        code: 'EDIT_SOURCE_NOT_READY',
        statusCode: 409,
      });
    }

    // Nothing of the conversation survives an edit to its first prompt, and
    // there is no such thing as a fork of no turns, so the session is simply
    // detached and the next run opens a new thread.
    if (keepThroughId === null) {
      sessionsDb.markProviderSessionSuperseded({
        providerSessionId: supersededThreadId,
        provider: PROVIDER,
        sessionId,
        jsonlPath: session.jsonl_path ?? null,
      });
      sessionsDb.detachProviderSession(sessionId);
      return;
    }

    const fork = await codexAppServer.forkThread({
      threadId: supersededThreadId,
      lastTurnId: keepThroughId,
      cwd: session.project_path ?? '',
    });

    sessionsDb.markProviderSessionSuperseded({
      providerSessionId: supersededThreadId,
      provider: PROVIDER,
      sessionId,
      jsonlPath: session.jsonl_path ?? null,
    });
    sessionsDb.repointSessionToProviderSession(sessionId, {
      providerSessionId: fork.threadId,
      jsonlPath: fork.path,
    });
  }

  /**
   * Normalizes a persisted Codex JSONL entry.
   *
   * Live Codex SDK events are transformed before they reach normalizeMessage(),
   * while history entries already use the compact message/tool shape produced
   * by getCodexSessionMessages().
   */
  private normalizeHistoryEntry(raw: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'compaction') {
      return [createCompactionMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        phase: raw.phase === 'running' ? 'running' : 'done',
      })];
    }

    if (raw.type === 'status_note' && typeof raw.content === 'string') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'task_notification',
        summary: raw.content,
        status: 'info',
      })];
    }

    if (raw.type === 'error') {
      // A turn that failed. The engine's own words are the whole row: they
      // say what went wrong (an exhausted quota, a rejected request), and the
      // live stream showed the same text.
      const content = typeof raw.content === 'string' ? raw.content : '';
      if (!content.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'error',
        content,
      })];
    }

    if (raw.type === 'thinking' || raw.isReasoning) {
      const thinkingContent = typeof raw.message?.content === 'string' ? raw.message.content : '';
      if (!thinkingContent.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: thinkingContent,
      })];
    }

    if (raw.message?.role === 'user') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
            .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
            .filter(Boolean)
            .join('\n')
          : String(raw.message.content || '');
      const parsedFiles = parseFilesInputTag(content);
      const rawImages = Array.isArray(raw.images) && raw.images.length > 0 ? raw.images : undefined;
      const files = parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined;
      if (!parsedFiles.text.trim() && !rawImages && !files) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content: parsedFiles.text,
        images: rawImages,
        files,
        // The enclosing turn, when the reader could name one. The row's own
        // id addresses the message; the turn is what an edit cuts at, and
        // only the reader knows which prompt opened one.
        transcriptAnchorId: readNonEmptyString(raw.turnId),
      })];
    }

    if (raw.message?.role === 'assistant') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
            .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
            .filter(Boolean)
            .join('\n')
          : '';
      if (!content.trim()) {
        return [];
      }
      // A proposed plan is a plan card, not an assistant paragraph that
      // happens to open with a tag. Leaving it to the client is what put a
      // provider-specific branch in a renderer shared by every provider.
      const proposedPlan = readCodexProposedPlan(content);
      if (proposedPlan) {
        return [createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'tool_use',
          toolName: 'ExitPlanMode',
          toolInput: { plan: proposedPlan },
          toolId: baseId,
          memoryCitations: raw.memoryCitations,
        })];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content,
        memoryCitations: raw.memoryCitations,
      })];
    }

    if (raw.type === 'tool_use' || raw.toolName) {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName || 'Unknown',
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
        // A live row arrives while the call is still running; the client
        // renders the spinner off this and the completed row replaces it.
        status: raw.status,
        subagentTools: raw.subagentTools,
        subagent: raw.subagent,
        memoryCitations: raw.memoryCitations,
      })];
    }

    if (raw.type === 'tool_result') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: Boolean(raw.isError),
        toolUseResult: raw.toolUseResult,
      })];
    }

    return [];
  }

  /**
   * Normalizes one Codex transcript row.
   *
   * Live frames and history rows arrive in the same vocabulary — both sides
   * build their rows with `codexThreadItemToRows` — so there is one branch
   * here, not one per transport. That is the property that keeps a row's
   * identity and shape the same whether it came off the wire or off disk.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'turn_complete') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'complete',
      })];
    }
    if (raw.type === 'turn_failed') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'error',
        content: raw.error?.message || 'Turn failed',
      })];
    }

    return this.normalizeHistoryEntry(raw, sessionId);
  }

  /**
   * Loads Codex JSONL history and keeps token usage metadata when the
   * transcript reported it.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    let result: CodexHistoryResult;
    try {
      result = await getCodexSessionMessages(sessionId);
    } catch (error) {
      if (error instanceof ProviderDisplayAssetError) throw error;
      // A broken inherited snapshot must not masquerade as an empty thread.
      if (error instanceof AppError && error.code.startsWith('CODEX_HISTORY_SOURCE_')) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodexProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of result.messages) {
      normalized.push(...this.normalizeHistoryEntry(raw, sessionId));
    }

    const toolResultMap = new Map<string, NormalizedMessage>();
    for (const msg of normalized) {
      if (msg.kind === 'tool_result' && msg.toolId) {
        toolResultMap.set(msg.toolId, msg);
      }
    }
    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (toolResult) {
          msg.toolResult = { content: toolResult.content, isError: toolResult.isError, toolUseResult: toolResult.toolUseResult };
        }
      }
    }

    // Everything the transcript draws, and nothing else — so a page of N rows
    // is N rows the user sees, and `total` counts the same thing.
    const transcript = prepareTranscriptMessages(normalized);
    const total = transcript.length;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(transcript, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      tokenUsage: result.tokenUsage,
    };
  }

  /**
   * Reads the token usage recorded in one Codex rollout JSONL.
   *
   * Consumer: the provider token-usage service. The app row's indexed
   * `jsonl_path` wins when it still exists; otherwise the rollout is located
   * by its provider-native session id under `~/.codex/sessions`. No readable
   * rollout is a 404.
   */
  async getTokenUsage(input: ProviderSessionUsageInput): Promise<ProviderTokenUsageResult> {
    const indexedFilePath = input.jsonlPath && fsSync.existsSync(input.jsonlPath)
      ? input.jsonlPath
      : null;
    const sessionFilePath = indexedFilePath ?? await findCodexSessionFile(
      path.join(getCodexHome(), 'sessions'),
      input.nativeSessionId,
    );

    if (!sessionFilePath) {
      throw new AppError(`Codex session file for "${input.appSessionId}" was not found.`, {
        code: 'CODEX_SESSION_FILE_NOT_FOUND',
        statusCode: 404,
      });
    }

    return readCodexTokenUsage(sessionFilePath);
  }

  /**
   * Cleans up Codex native storage (JSONL file).
   */
  async cleanupSession(_nativeSessionId: string, jsonlPath?: string | null): Promise<boolean> {
    let removed = false;
    if (jsonlPath) {
      if (await removePathIfExists(jsonlPath)) {
        removed = true;
      }
    }
    return removed;
  }
}
