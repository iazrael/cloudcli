import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { MessageInputForKind, VolatileMessageId } from '../../shared/protocol/messageKinds.js';
import { VOLATILE_MESSAGE_ID_PREFIX } from '../../shared/protocol/messageKinds.js';
import { SUBAGENT_TOOL_NAME } from '../../shared/protocol/subagent.js';

import { parseFrontMatter } from './frontmatter.js';
import { getGlobalImageAssetsDir } from './image-attachments.js';
import type {
  AnyRecord,
  ApiSuccessShape,
  AppErrorOptions,
  MessageKind,
  NormalizedMessage,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderQuotaResetCredit,
  ProviderSkillSource,
  QueuedChatMessage,
  SubagentActivity,
  WorkspacePathValidationResult,
} from './types.js';

/** Returns the lowercase SHA-256 hex digest for opaque tokens and content. */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

//----------------- CLAUDE CONVERSATION RECORDS ------------
/**
 * Used by provider history, subagent activity and conversation search to accept
 * actual Claude conversation records only. API request diagnostics also embed
 * `message.role` and content, but are copies rather than conversation events.
 * This deliberately does not require a UUID: record identity and supported
 * realtime control events are validated by their respective consumers.
 */
export function isClaudeConversationRecord(value: unknown): value is AnyRecord & { type: 'user' | 'assistant'; message: AnyRecord } {
  const record = readObjectRecord(value);
  return Boolean(record && (record.type === 'user' || record.type === 'assistant')
    && readObjectRecord(record.message)?.role === record.type);
}

// ---------------------------
//----------------- PROVIDER DISPLAY PAYLOADS ------------
const INLINE_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg',
};

/** Provider history readers propagate display-storage failures rather than treating them as malformed JSON. */
export class ProviderDisplayAssetError extends Error {
  constructor(cause: unknown) {
    super(`Provider display asset failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ProviderDisplayAssetError';
  }
}

function storeDisplayAsset(bytes: Buffer | string, filename: string): void {
  const directory = getGlobalImageAssetsDir();
  fs.mkdirSync(directory, { recursive: true });
  const assetPath = path.join(directory, filename);
  const expectedSize = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  try {
    const existing = fs.lstatSync(assetPath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Invalid stored display asset');
    if (existing.size === expectedSize) return;
    // A previous interrupted write may have left a short final file.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporaryPath = `${assetPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, assetPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'Display asset write and cleanup failed');
      }
    }
    throw error;
  }
}

function storeInlineImage(mimeType: string, encoded: string): string {
  const extension = INLINE_IMAGE_EXTENSIONS[mimeType.toLowerCase()];
  if (!extension) throw new Error(`Unsupported inline image type: ${mimeType}`);
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Invalid inline image base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('Invalid inline image base64');
  }
  const filename = `inline-${sha256Hex(bytes)}.${extension}`;
  // Exclusive creation never follows a pre-existing symlink. Identical
  // results from live/history reuse the same file without a heap cache.
  storeDisplayAsset(bytes, filename);
  return `/api/assets/images/${filename}`;
}

/**
 * Blank-check for engine display text. Zero-width format characters
 * (U+200B-U+200D, U+2060, U+FEFF) render as nothing in the transcript, yet
 * JavaScript `.trim()` treats them as content, so an engine that emits one as
 * a whole text part would surface as a transcript row carrying only its copy
 * control. Consumers: the opencode live translator and history reader, which
 * must agree on what counts as an empty segment.
 */
const INVISIBLE_TEXT_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

export function hasVisibleText(text: string): boolean {
  return text.replace(INVISIBLE_TEXT_RE, '').trim().length > 0;
}

/**
 * Providers and the websocket gateway compact display copies before retaining
 * or serializing them. Recognized inline images become content-addressed,
 * authenticated asset references; engine-owned inputs are never mutated.
 * JSON strings are inspected only when they contain an image marker. The
 * operation is idempotent and intentionally has no in-memory image cache.
 * Invalid base64 and storage failures propagate to the caller.
 */
export function compactProviderPayload<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  function visit(input: unknown, field = '', previewText = true): unknown {
    if (typeof input === 'string') {
      // User text is also the source for edit/resend and copy. Compact image
      // descriptors in that turn, but never replace the prompt with a preview.
      if (!previewText && /^(content|text|message)$/.test(field)) return input;
      if (input.startsWith('data:image/')) {
        const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(input);
        if (!match) throw new Error('Invalid inline image base64 URI');
        return storeInlineImage(match[1], match[2]);
      }
      if ((input.startsWith('{') || input.startsWith('['))
        && (input.includes('"image"') || input.includes('data:image/'))) {
        let parsed: unknown;
        try { parsed = JSON.parse(input); } catch { /* Non-JSON tool logs still need a bounded preview below. */ }
        if (parsed !== undefined) {
          const compact = visit(parsed, field, previewText);
          if (compact !== parsed) return JSON.stringify(compact);
        }
      }
      if (previewText && input.length > 256 * 1024 && /^(content|output|result|text|stdout|stderr)$/.test(field)) {
        const filename = `output-${sha256Hex(input)}.txt`;
        storeDisplayAsset(input, filename);
        return `${input.slice(0, 64 * 1024)}\n\n/api/assets/files/${filename}`;
      }
      return input;
    }
    if (!input || typeof input !== 'object' || Buffer.isBuffer(input)) return input;
    if (seen.has(input)) return seen.get(input);
    // Provider payloads are JSON records; leave runtime instances untouched.
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype) return input;
    const record = input as Record<string, unknown>;
    const userTurn = record.role === 'user' || readObjectRecord(record.message)?.role === 'user'
      || ['UserMessage', 'userMessage', 'user_message', 'USER_INPUT'].includes(String(record.type))
      || record.source === 'USER_EXPLICIT';
    const toolResult = record.type === 'tool_result' || record.type === 'tool-result' || record.role === 'tool';
    const childPreviewText = toolResult || (previewText && !userTurn);
    if (record.type === 'base64' && typeof record.media_type === 'string'
      && record.media_type.startsWith('image/') && typeof record.data === 'string') {
      const result = { type: 'url', url: storeInlineImage(record.media_type, record.data) };
      seen.set(input, result);
      return result;
    }
    if (record.type === 'image' && typeof record.data === 'string'
      && typeof (record.mimeType ?? record.mime_type) === 'string') {
      const { data, ...rest } = record;
      const result = { ...rest, uri: storeInlineImage(String(record.mimeType ?? record.mime_type), data) };
      seen.set(input, result);
      return result;
    }
    seen.set(input, input);
    let result: unknown = input;
    for (const [key, child] of Object.entries(input)) {
      const compact = visit(child, key, childPreviewText);
      if (compact !== child) {
        if (result === input) result = Array.isArray(input) ? [...input] : { ...record };
        (result as Record<string, unknown>)[key] = compact;
      }
    }
    seen.set(input, result);
    return result;
  }
  try { return visit(value) as T; } catch (error) {
    if (error instanceof ProviderDisplayAssetError) throw error;
    throw new ProviderDisplayAssetError(error);
  }
}

/**
 * Provider history readers use this after parsing each record, before storing
 * it in branch/pairing indexes. This avoids retaining inline media from the
 * whole transcript while preserving every provider's native row identity.
 */
export function parseProviderJson(text: string): AnyRecord {
  return compactProviderPayload(JSON.parse(text) as AnyRecord);
}

/**
 * Provider history, usage and synchronization readers scan JSONL records one
 * line at a time. Blank, primitive and incomplete JSON records are skipped;
 * filesystem errors propagate. Closing the iterator closes its file stream.
 * This reader does not materialize media: callers choose which display rows
 * need compaction, while usage/indexing paths only inspect their metadata.
 */
export async function* readJsonlRecords(filename: string): AsyncGenerator<AnyRecord> {
  const input = fs.createReadStream(filename);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) yield entry as AnyRecord;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

//----------------- ENVIRONMENT UTILITIES ------------
/**
 * Indicates whether the backend is running in hosted Platform mode rather than
 * self-hosted OSS mode. The server bootstrap, Agent, Auth, and Browser Use
 * modules use this shared flag to keep environment-dependent behavior aligned.
 * Environment variables must be loaded before this module is evaluated.
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

// ---------------------------
//----------------- NORMALIZED MESSAGE HELPER INPUT TYPES ------------
/**
 * Input payload accepted by `createNormalizedMessage`.
 *
 * Callers provide provider-specific fields plus the required `kind/provider`
 * pair; this helper fills missing envelope fields (`id`, `sessionId`,
 * `timestamp`) in a consistent way.
 */


// ---------------------------
//----------------- HTTP HANDLER UTILITIES ------------
/**
 * Wraps arbitrary data in the standard API success envelope.
 *
 * Use this helper in route handlers to keep successful JSON responses consistent
 * across endpoints.
 */
export function createApiSuccessResponse<TData>(
  data: TData,
): ApiSuccessShape<TData> {
  return {
    success: true,
    data,
  };
}

/**
 * Converts an async Express handler into a standard `RequestHandler` and routes
 * rejected promises to Express error middleware.
 *
 * Use this to avoid repeating `try/catch(next)` in every async route.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// ---------------------------
//----------------- SHARED ERROR UTILITIES ------------
/**
 * Shared application error with HTTP status and machine-readable code metadata.
 *
 * Throw this from service/route layers when the caller should receive a
 * controlled error response rather than a generic 500.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
  }
}

/**
 * Normalizes an unknown thrown value into an HTTP status code: `AppError`
 * instances contribute their own status; anything else is read as an optional
 * `statusCode` field (raw fs errors, wrapped route failures) and falls back
 * to 500.
 *
 * Used by the media and file-tree failure paths to map per-item batch errors
 * onto batch response statuses.
 */
export function errorStatusCode(error: unknown): number {
  return error instanceof AppError ? error.statusCode : Number((error as { statusCode?: number }).statusCode) || 500;
}

/**
 * Flattens a failed `git` invocation into one searchable string: the error
 * message followed by whatever stderr/stdout the process runner attached.
 *
 * Used by the Git routes and the branch compare service to classify git
 * failures (e.g. "not a git repository", "unknown revision") and to surface
 * git's own explanation as error `details`. Accepts any thrown value; missing
 * fields contribute nothing, so the result may be empty.
 */
export function getGitErrorDetails(error: unknown): string {
  const details = error as { message?: string; stderr?: string; stdout?: string } | null;
  return `${details?.message ?? ''} ${details?.stderr ?? ''} ${details?.stdout ?? ''}`.trim();
}

// ---------------------------
//----------------- WORKSPACE PATH VALIDATION UTILITIES ------------
/**
 * Root directory that all workspace/project paths must stay under.
 *
 * This is resolved from `WORKSPACES_ROOT` when configured; otherwise it falls
 * back to the current user's home directory.
 */
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || os.homedir();

/**
 * System-critical paths that must never be used as workspace roots.
 *
 * The validation helper blocks these values directly and also blocks paths
 * nested under them (with explicit allow-list exceptions where necessary).
 */
export const FORBIDDEN_WORKSPACE_PATHS = [
  // Unix
  '/',
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/dev',
  '/proc',
  '/sys',
  '/var',
  '/boot',
  '/root',
  '/lib',
  '/lib64',
  '/opt',
  '/tmp',
  '/run',
  // Windows
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System Volume Information',
  'C:\\$Recycle.Bin',
];

/**
 * Roots the file browser and viewer may read from even though they are outside
 * every project.
 *
 * Claude writes a background agent's output file and a background command's log
 * under the system temp directory, and a transcript quotes those paths
 * verbatim, so the file browser and the file viewer have to be able to follow
 * them. `/tmp` is listed literally as well as via `os.tmpdir()` because the two
 * differ on macOS, where the temp directory is under `/var/folders`.
 *
 * A background agent's `.output` file is only a symlink to the agent's
 * transcript, `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`.
 * Symlinks are resolved before the root comparison, so following it needs the
 * Claude projects directory to be a root as well. Those are the user's own
 * transcripts, which the sessions API already serves; the directory is located
 * the same way the session watcher and synchronizer locate it.
 *
 * Being a read-only root grants reads only: the file-tree write paths resolve
 * against the project root alone, so nothing under these can be changed
 * through the file API. Whether one may become a workspace is decided
 * separately by `validateWorkspacePath` — the temp directories are on
 * `FORBIDDEN_WORKSPACE_PATHS`; the Claude projects directory is not, it is
 * simply wherever `WORKSPACES_ROOT` puts it.
 */
const READ_ONLY_ROOTS = [...new Set([
  '/tmp',
  os.tmpdir(),
  path.join(os.homedir(), '.claude', 'projects'),
])];

/**
 * Resolves `targetPath` when it lives under one of `roots`, or `null` when it
 * does not.
 *
 * Symlinks are resolved before the comparison, so a link planted under a root
 * cannot be used to read somewhere else through it. Each root is resolved on
 * its own, so one that does not exist on this machine — `/tmp` on Windows — is
 * skipped and the roots after it are still checked.
 */
export async function resolvePathUnderRoots(targetPath: string, roots: string[]): Promise<string | null> {
  const normalizedTarget = normalizeProjectPath(targetPath);
  if (!normalizedTarget || !path.isAbsolute(normalizedTarget)) {
    return null;
  }

  let resolvedPath: string;
  try {
    resolvedPath = normalizeProjectPath(await realpath(path.resolve(normalizedTarget)));
  } catch {
    // A path that cannot be resolved is not readable through here either.
    return null;
  }

  for (const root of roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = normalizeProjectPath(await realpath(root));
    } catch {
      continue;
    }

    if (resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
      return resolvedPath;
    }
  }

  return null;
}

/**
 * Resolves a path that is readable because it lives under a read-only root,
 * or `null` when it does not.
 */
export function resolveReadOnlyRootPath(targetPath: string): Promise<string | null> {
  return resolvePathUnderRoots(targetPath, READ_ONLY_ROOTS);
}

function stripWindowsLongPathPrefix(inputPath: string): string {
  if (inputPath.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${inputPath.slice('\\\\?\\UNC\\'.length)}`;
  }

  if (inputPath.startsWith('\\\\?\\')) {
    return inputPath.slice('\\\\?\\'.length);
  }

  return inputPath;
}

function shouldUseWindowsPathNormalization(inputPath: string): boolean {
  if (process.platform === 'win32') {
    return true;
  }

  return inputPath.startsWith('\\\\') || /^[a-zA-Z]:([\\/]|$)/.test(inputPath);
}

/**
 * Canonicalizes project/workspace paths for stable DB keys and comparisons.
 *
 * Normalization rules:
 * - trim whitespace
 * - strip Windows long-path prefixes (`\\?\` and `\\?\UNC\`)
 * - normalize path separators and dot segments
 * - trim trailing separators except for filesystem roots
 */
export function normalizeProjectPath(inputPath: string): string {
  if (typeof inputPath !== 'string') {
    return '';
  }

  const trimmed = inputPath.trim();
  if (!trimmed) {
    return '';
  }

  const withoutLongPrefix = stripWindowsLongPathPrefix(trimmed);
  const useWindowsPathRules = shouldUseWindowsPathNormalization(withoutLongPrefix);
  const normalized = useWindowsPathRules
    ? path.win32.normalize(withoutLongPrefix)
    : path.posix.normalize(withoutLongPrefix);

  if (!normalized) {
    return '';
  }

  const parser = useWindowsPathRules ? path.win32 : path.posix;
  const root = parser.parse(normalized).root;
  if (normalized === root) {
    return normalized;
  }

  return normalized.replace(/[\\/]+$/, '');
}

/**
 * A project display name is "default" when it equals the directory basename —
 * exactly what `ensureProjectPath`/`createProjectPath` store when they
 * auto-register a project for a session path. Anything else means a user (or
 * the open-worktree-as-project flow) deliberately named the project.
 *
 * Two consumers must agree on this predicate: the session worktree placement
 * policy keeps sessions under deliberately-named worktree projects, and the
 * sessions write layer archives only default-named shells after a session
 * moves away. Changing one side without the other breaks that pairing.
 */
export function isDefaultProjectDisplayName(
  customName: string | null | undefined,
  projectPath: string,
): boolean {
  const trimmedName = customName?.trim() ?? '';
  return trimmedName !== '' && trimmedName === path.basename(projectPath);
}

/**
 * Validates that a user-supplied workspace path is safe to use.
 *
 * Call this before any filesystem mutation that creates or registers projects.
 * The function resolves symlinks, enforces `WORKSPACES_ROOT` containment, and
 * blocks known system directories.
 */
export async function validateWorkspacePath(requestedPath: string): Promise<WorkspacePathValidationResult> {
  try {
    const normalizedRequestedPath = normalizeProjectPath(requestedPath);
    if (!normalizedRequestedPath) {
      return {
        valid: false,
        error: 'Workspace path is required',
      };
    }

    const absolutePath = path.resolve(normalizedRequestedPath);
    const normalizedPath = normalizeProjectPath(absolutePath);

    if (FORBIDDEN_WORKSPACE_PATHS.includes(normalizedPath) || normalizedPath === '/') {
      return {
        valid: false,
        error: 'Cannot use system-critical directories as workspace locations',
      };
    }

    for (const forbiddenPath of FORBIDDEN_WORKSPACE_PATHS) {
      const normalizedForbiddenPath = normalizeProjectPath(forbiddenPath);
      if (
        normalizedPath === normalizedForbiddenPath
        || normalizedPath.startsWith(`${normalizedForbiddenPath}${path.sep}`)
      ) {
        // Allow specific user-writable folders under /var.
        if (
          normalizedForbiddenPath === '/var'
          && (normalizedPath.startsWith('/var/tmp') || normalizedPath.startsWith('/var/folders'))
        ) {
          continue;
        }

        return {
          valid: false,
          error: `Cannot create workspace in system directory: ${forbiddenPath}`,
        };
      }
    }

    let resolvedPath = normalizeProjectPath(absolutePath);
    try {
      await access(absolutePath);
      resolvedPath = normalizeProjectPath(await realpath(absolutePath));
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'ENOENT') {
        throw fileError;
      }

      const parentPath = path.dirname(absolutePath);
      try {
        const parentRealPath = await realpath(parentPath);
        resolvedPath = normalizeProjectPath(path.join(parentRealPath, path.basename(absolutePath)));
      } catch (parentError) {
        const parentFileError = parentError as NodeJS.ErrnoException;
        if (parentFileError.code !== 'ENOENT') {
          throw parentFileError;
        }
      }
    }

    const resolvedWorkspaceRoot = normalizeProjectPath(await realpath(WORKSPACES_ROOT));
    if (
      !resolvedPath.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)
      && resolvedPath !== resolvedWorkspaceRoot
    ) {
      return {
        valid: false,
        error: `Workspace path must be within the allowed workspace root: ${WORKSPACES_ROOT}`,
      };
    }

    try {
      await access(absolutePath);
      const pathStats = await lstat(absolutePath);
      if (pathStats.isSymbolicLink()) {
        const symlinkTarget = await readlink(absolutePath);
        const resolvedSymlinkPath = path.resolve(path.dirname(absolutePath), symlinkTarget);
        const realSymlinkPath = await realpath(resolvedSymlinkPath);
        if (
          !realSymlinkPath.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)
          && realSymlinkPath !== resolvedWorkspaceRoot
        ) {
          return {
            valid: false,
            error: 'Symlink target is outside the allowed workspace root',
          };
        }
      }
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'ENOENT') {
        throw fileError;
      }
    }

    return {
      valid: true,
      resolvedPath,
    };
  } catch (error) {
    return {
      valid: false,
      error: `Path validation failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Validates that a target path stays strictly inside its intended root directory.
 * Throws a 400 AppError with PATH_SECURITY_VIOLATION if directory traversal is detected.
 *
 * Consumed by provider MCP implementations (Antigravity, ZCode) when writing
 * configuration files into user or workspace directories.
 */
export function validatePathSecurity(targetPath: string, rootPath: string): void {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootPath);

  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`) && resolvedTarget !== resolvedRoot) {
    throw new AppError('Path validation failed: potential directory traversal attempt.', {
      code: 'PATH_SECURITY_VIOLATION',
      statusCode: 400,
    });
  }
}

// ---------------------------
//----------------- NORMALIZED PROVIDER MESSAGE UTILITIES ------------
/**
 * Generates a throwaway id for a frame that exists only while a run is live.
 *
 * The result is branded and prefixed so it cannot be used as a transcript
 * row's id: those have to be derived from the engine's own record, or the
 * same persisted row comes back under a new id on every history read and the
 * client has nothing to match the live copy against.
 */
export function generateMessageId(prefix = 'msg'): VolatileMessageId {
  return `${VOLATILE_MESSAGE_ID_PREFIX}${prefix}_${randomUUID()}` as VolatileMessageId;
}

/**
 * Creates a normalized provider message and fills the shared envelope fields.
 *
 * Provider adapters and live SDK handlers pass through provider-specific fields,
 * while this helper guarantees every emitted event has an id, session id,
 * timestamp, and provider marker.
 */
export function createNormalizedMessage<K extends MessageKind>(
  fields: MessageInputForKind<K>,
): NormalizedMessage {
  const message: NormalizedMessage = {
    ...fields,
    id: fields.id || generateMessageId(fields.kind),
    sessionId: fields.sessionId || '',
    timestamp: fields.timestamp || new Date().toISOString(),
    provider: fields.provider,
  };
  return compactProviderPayload(message);
}

/**
 * Build the unified terminal `complete` lifecycle message.
 *
 * Contract: every provider run ends with exactly one `complete` (the
 * abort-session handler emits it on behalf of cancelled runs, so aborted runs
 * must NOT emit their own). The frontend treats `complete` as the only
 * terminal signal and never needs provider-specific handling:
 *
 * - `sessionId`     — the id the client knows this run by ('' if never discovered)
 * - `actualSessionId` — canonical id after the run; equals `sessionId` unless
 *                       the provider rewrote it mid-run
 * - `exitCode`      — 0 on success; a missing/null code (e.g. killed process)
 *                     is reported as failure
 * - `success`       — exitCode === 0 and not aborted
 * - `aborted`       — run was cancelled by the user
 */
export function createCompleteMessage(opts: {
  provider: NormalizedMessage['provider'];
  sessionId?: string | null;
  actualSessionId?: string | null;
  exitCode?: number | null;
  aborted?: boolean;
}): NormalizedMessage {
  const exitCode = typeof opts.exitCode === 'number' ? opts.exitCode : 1;
  const aborted = Boolean(opts.aborted);

  return createNormalizedMessage({
    kind: 'complete',
    provider: opts.provider,
    sessionId: opts.sessionId || null,
    actualSessionId: opts.actualSessionId || opts.sessionId || undefined,
    exitCode,
    success: exitCode === 0 && !aborted,
    aborted,
  });
}

// ---------------------------
//----------------- SUBAGENT TIMELINE UTILITIES ------------
/**
 * Longest tool output kept on one subagent activity.
 *
 * A subagent's timeline is nested inside a collapsed panel, so it is a preview
 * of what the agent did, never the primary place its output is read. Sending
 * every child command's full output made the history payload of an
 * agent-heavy session grow by megabytes for content almost nobody expands.
 */
const MAX_SUBAGENT_ACTIVITY_CONTENT = 4000;

/**
 * Most activities of one subagent sent with its card. A long-running agent can
 * record hundreds of tool calls, and the transcript only shows them behind a
 * collapsed header, so shipping the whole timeline on every load costs far more
 * than it shows. The card reports the full count (`SubagentInfo.activityCount`)
 * so the UI can say how many were left out.
 *
 * Consumers: the Claude, Codex and ZCode history readers.
 */
export const MAX_TRANSMITTED_SUBAGENT_ACTIVITIES = 200;

function truncateForPreview(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length <= MAX_SUBAGENT_ACTIVITY_CONTENT) {
    return value;
  }
  const omitted = value.length - MAX_SUBAGENT_ACTIVITY_CONTENT;
  return `${value.slice(0, MAX_SUBAGENT_ACTIVITY_CONTENT)}\n… ${omitted} more characters`;
}

/**
 * Trims one subagent activity down to what its nested preview can show.
 *
 * Used by both provider session adapters so a Claude agent's timeline and a
 * Codex agent's timeline cost the same to transport.
 */
export function truncateSubagentActivity(activity: SubagentActivity): SubagentActivity {
  const truncatedContent = truncateForPreview(activity.content);
  const truncatedResult = activity.toolResult
    ? { ...activity.toolResult, content: truncateForPreview(activity.toolResult.content) }
    : activity.toolResult;

  if (truncatedContent === activity.content && truncatedResult === activity.toolResult) {
    return activity;
  }

  return { ...activity, content: truncatedContent, toolResult: truncatedResult };
}

// ---------------------------
//----------------- SUBAGENT TOOL NAME UTILITIES ------------
export { SUBAGENT_TOOL_NAME };

/**
 * The tool name older Claude CLIs gave the subagent spawn call. Current CLIs
 * name it `Agent` and still resolve this name to `Agent` in permission rules.
 */
const LEGACY_CLAUDE_SUBAGENT_TOOL_NAME = 'Task';

/**
 * Translates Claude's legacy subagent tool name (`Task`) into the protocol's
 * `Agent`; every other name, including the task-list tools (`TaskCreate`,
 * `TaskUpdate`), passes through unchanged.
 *
 * Used by Claude's history reader and live normalizer (so old transcripts and
 * live calls draw the same card), its background-work tracker (so both names
 * count as a launch that outlives the turn) and its permission matcher (so a
 * rule saved as `Task` still allows `Agent`). Do not apply it to the name in a
 * `permission_request`: the client writes always-allow rules under the name the
 * CLI asked about.
 */
export function canonicalClaudeSubagentToolName(toolName: string): string {
  return toolName === LEGACY_CLAUDE_SUBAGENT_TOOL_NAME ? SUBAGENT_TOOL_NAME : toolName;
}

// ---------------------------
//----------------- CONVERSATION HISTORY PAGINATION UTILITIES ------------
/**
 * Slices one page from the END of a chronologically ordered message list.
 *
 * This is the single pagination contract for conversation history across all
 * providers: `offset = 0` returns the most recent `limit` items, increasing
 * offsets walk backwards in time (for "scroll up to load older" UIs), and a
 * `null` limit returns everything. Items must already be sorted oldest-first;
 * the returned page preserves that order.
 *
 * Every provider history reader must use this helper instead of slicing
 * manually so `offset`/`limit` query params behave identically regardless of
 * which provider produced the session.
 */
export function sliceTailPage<T>(
  items: T[],
  limit: number | null,
  offset: number,
): { page: T[]; hasMore: boolean } {
  const total = items.length;
  const normalizedOffset = Math.max(0, offset);

  if (limit === null) {
    // A null limit returns the full list; offset still trims newest entries
    // so "everything before the page I already have" stays expressible.
    const end = Math.max(0, total - normalizedOffset);
    return {
      page: items.slice(0, end),
      hasMore: false,
    };
  }

  const end = Math.max(0, total - normalizedOffset);
  const start = Math.max(0, end - Math.max(0, limit));
  return {
    page: items.slice(start, end),
    hasMore: start > 0,
  };
}

// ---------------------------
//----------------- MCP CONFIG PARSING UTILITIES ------------
/**
 * Safely narrows an unknown value to a plain object record.
 *
 * This deliberately rejects arrays, `null`, and primitive values so callers can
 * treat the returned value as a JSON-style object map without repeating the same
 * defensive shape checks at every config read site.
 */
export const readObjectRecord = (value: any): AnyRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as AnyRecord;
};

/**
 * Reads an optional string from unknown input and normalizes empty or whitespace-only
 * values to `undefined`.
 *
 * This is useful when parsing config files where a field may be missing, present
 * with the wrong type, or present as an empty string that should be treated as
 * "not configured".
 */
export const readOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

/**
 * Reads an optional string array from unknown input.
 *
 * Non-array values are ignored, and any array entries that are not strings are
 * filtered out. This lets provider config readers consume loosely shaped JSON/TOML
 * data without failing on incidental invalid members.
 */
export const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
};

/**
 * Reads an optional string-to-string map from unknown input.
 *
 * The function first ensures the source value is a plain object, then keeps only
 * keys whose values are strings. If no valid entries remain, it returns `undefined`
 * so callers can distinguish "no usable map" from an empty object that was
 * intentionally authored downstream.
 */
export const readStringRecord = (value: unknown): Record<string, string> | undefined => {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') {
      normalized[key] = entry;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

/**
 * Reads an optional string-to-string map from unknown input, trimming keys and
 * values and dropping entries where either side is empty after trimming.
 *
 * Used where the map feeds a strict downstream schema — the ZCode engine's
 * provider registry validates every header with min(1), so an untrimmed or
 * empty entry would make the whole registry file invalid. Returns `undefined`
 * when no usable entry remains.
 *
 * Consumers: the zcode provider-config materializer and the zcode send-model
 * builder.
 */
export const readTrimmedStringRecord = (value: unknown): Record<string, string> | undefined => {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const entries = Object.entries(record).flatMap(([key, entry]) => {
    const normalizedKey = key.trim();
    const normalizedValue = readOptionalString(entry);
    return normalizedKey && normalizedValue
      ? [[normalizedKey, normalizedValue] as [string, string]]
      : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

// ---------------------------
//----------------- INFRASTRUCTURE WORKSPACE FILTER ------------
/**
 * Detects workspace paths that are package-manager or runtime internals
 * rather than user projects.
 *
 * Sessions recording such directories must never surface as projects: every
 * `pnpm run deploy` creates a fresh pnpm virtual store directory for the
 * globally installed app, and a session created there (a spawn-cwd fallback)
 * would otherwise register a new empty project per deployment. The filters are
 * pnpm's `.pnpm` virtual store and any `node_modules` segment.
 *
 * A system temp root is **not** infrastructure. Working out of `/tmp` is
 * ordinary — a scratch clone, a bug repro — and rejecting it makes those
 * sessions vanish from the project list with no error to explain it. A
 * one-shot sandbox under a temp root is caught instead by the
 * directory-exists half of `admitsWorkspacePath`, which never touches a
 * directory the user can still open.
 *
 * Consumers: `admitsWorkspacePath` (the session-indexing gate every engine
 * goes through) and its tests.
 */
export const isInfrastructureWorkspacePath = (projectPath: string): boolean => {
  const normalized = projectPath.trim().replace(/\/+$/, '');
  if (!normalized) return true;
  const segments = normalized.split('/');
  return segments.includes('node_modules') || segments.includes('.pnpm');
};

/**
 * Identifies a workspace path inside a system temporary directory (the root
 * itself or anything nested below it), which is runtime staging space rather
 * than a user workspace. The session admission and project-list modules use
 * this check so engine sessions recorded inside `/tmp`, `$TMPDIR`, or — on
 * macOS — `/var/folders` never become sidebar projects.
 *
 * Each root is compared in both its literal and its symlink-resolved spelling:
 * macOS hands out `$TMPDIR` as `/var/folders/...` while engines record the
 * same directory as `/private/var/folders/...`, and a literal prefix compare
 * would miss the alias. Roots that do not exist on this machine contribute
 * only their literal spelling.
 */
export function isSystemTemporaryWorkspacePath(projectPath: string): boolean {
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  if (!normalizedProjectPath) {
    return false;
  }

  return systemTemporaryDirectoryRoots().some(
    (root) => normalizedProjectPath === root || normalizedProjectPath.startsWith(`${root}${path.sep}`),
  );
}

/**
 * Builds the root list for `isSystemTemporaryWorkspacePath`: the OS temporary
 * directory plus the well-known staging roots, each expanded with its real
 * path so `/var` and `/private/var` spellings both match. Evaluated per call
 * because tests may run with a different `TMPDIR`; the handful of `realpath`
 * syscalls is negligible next to the per-project I/O around the call sites.
 */
function systemTemporaryDirectoryRoots(): string[] {
  const candidates = process.platform === 'win32'
    ? [os.tmpdir()]
    : process.platform === 'darwin'
      ? [os.tmpdir(), '/var/folders', '/tmp', '/private/tmp']
      : [os.tmpdir(), '/tmp', '/private/tmp'];

  const roots = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeProjectPath(candidate);
    if (normalized) {
      roots.add(normalized);
    }

    try {
      const resolved = normalizeProjectPath(fs.realpathSync(candidate));
      if (resolved) {
        roots.add(resolved);
      }
    } catch {
      // A root absent from this machine only matches by its literal spelling.
    }
  }

  return [...roots];
}

// ---------------------------
//----------------- PROVIDER MODEL LOOKUP UTILITIES ------------
/**
 * Builds the standard "default current model" result used when a provider
 * cannot resolve a session-backed active model.
 *
 * Provider model adapters should call this after loading their supported model
 * catalog so the fallback stays aligned with the provider's current `DEFAULT`
 * selection instead of drifting to a hard-coded duplicate.
 */
export function buildDefaultProviderCurrentActiveModel(
  models: ProviderModelsDefinition,
): ProviderCurrentActiveModel {
  return {
    model: models.DEFAULT,
  };
}

/**
 * Validates a UI effort selection against the model's catalog-declared tiers.
 *
 * Claude/Codex/OpenCode runtime adapters use this before passing the choice to
 * their SDK/CLI: only non-`default` string values that the selected model
 * actually lists under `effort.values` survive; anything else (including an
 * unknown or missing catalog, so the lookup tolerates `null`) yields
 * `undefined`, letting the provider runtime fall back to its own default.
 */
export function resolveModelEffort(
  model: string | null | undefined,
  effort: unknown,
  modelsDefinition: ProviderModelsDefinition | null | undefined,
): string | undefined {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

/**
 * True for a model name a provider fabricated rather than actually ran.
 *
 * Claude Code stamps locally-synthesized transcript rows (API-error notices,
 * usage-limit messages) with `model: "<synthetic>"`. Angle-bracketed values are
 * placeholders, never real model ids, so neither the active-model lookup nor
 * the per-message model a reply is labelled with may adopt one.
 *
 * Used by the Claude models provider (which walks the transcript backwards for
 * the session's model) and by the Claude sessions provider (which stamps each
 * assistant message with the model that answered it).
 */
export function isPlaceholderProviderModel(model: string): boolean {
  return model.startsWith('<') && model.endsWith('>');
}

// ---------------------------
//----------------- WEBSOCKET PAYLOAD PARSING UTILITIES ------------
/**
 * Parses one websocket message payload into a plain JSON object record.
 *
 * Use this in realtime handlers that receive raw websocket payloads as `string`,
 * `Buffer`, `ArrayBuffer`, or chunk arrays. The helper converts supported
 * payload formats to UTF-8 text, parses JSON, and returns only object payloads.
 * Primitive/array/invalid payloads return `null` so callers can handle bad input
 * without throwing from deeply nested message handlers.
 */
export const parseIncomingJsonObject = (payload: unknown): AnyRecord | null => {
  let text: string | null = null;

  if (typeof payload === 'string') {
    text = payload;
  } else if (Buffer.isBuffer(payload)) {
    text = payload.toString('utf8');
  } else if (payload instanceof ArrayBuffer) {
    text = Buffer.from(payload).toString('utf8');
  } else if (Array.isArray(payload)) {
    const buffers = payload
      .map((entry) => {
        if (Buffer.isBuffer(entry)) {
          return entry;
        }

        if (entry instanceof ArrayBuffer) {
          return Buffer.from(entry);
        }

        if (ArrayBuffer.isView(entry)) {
          return Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength);
        }

        return null;
      })
      .filter((entry): entry is Buffer => entry !== null);

    if (buffers.length > 0) {
      text = Buffer.concat(buffers).toString('utf8');
    }
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return readObjectRecord(parsed);
  } catch {
    return null;
  }
};

/**
 * Reads a JSON config file and guarantees a plain object result.
 *
 * Missing files are treated as an empty config object so provider-specific MCP
 * readers can operate against first-run environments without special-case file
 * existence checks. If the file exists but contains invalid JSON, the parse error
 * is preserved and rethrown.
 */
export const readJsonConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }

    throw error;
  }
};

/**
 * Writes a JSON config file with stable, human-readable formatting.
 *
 * The parent directory is created automatically so callers can persist config into
 * provider-specific folders without pre-creating the directory tree. Output always
 * ends with a trailing newline to keep the file diff-friendly.
 */
export const writeJsonConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

// ---------------------------
//----------------- PROVIDER SKILL FILE UTILITIES ------------
async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    const gitMarkerStats = await stat(path.join(dirPath, '.git'));
    return gitMarkerStats.isDirectory() || gitMarkerStats.isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the highest git worktree root visible from a starting directory.
 *
 * Provider skill systems such as Codex and OpenCode walk upward through parent
 * folders when resolving repository/project skills. Use this helper when a
 * provider needs the topmost `.git` marker instead of only the nearest one, so
 * monorepos and nested package folders discover shared root-level skills once.
 */
export async function findTopmostGitRoot(startPath: string): Promise<string | null> {
  let currentPath = path.resolve(startPath);
  let topmostGitRoot: string | null = null;

  while (true) {
    if (await hasGitMarker(currentPath)) {
      topmostGitRoot = currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }

  return topmostGitRoot;
}

/**
 * Adds one provider skill source after normalizing and de-duplicating its root.
 *
 * Provider skill lookup rules often point at overlapping folders (for example a
 * workspace folder can also be the git root). Use this helper while building a
 * provider's `ProviderSkillSource[]` so the shared skills scanner reads each
 * physical root once and still preserves provider-specific scope/command data.
 */
export function addUniqueProviderSkillSource(
  sources: ProviderSkillSource[],
  seenRootDirs: Set<string>,
  source: ProviderSkillSource,
): void {
  const normalizedRootDir = path.resolve(source.rootDir);
  if (seenRootDirs.has(normalizedRootDir)) {
    return;
  }

  seenRootDirs.add(normalizedRootDir);
  sources.push({ ...source, rootDir: normalizedRootDir });
}

// ---------------------------
//----------------- PROVIDER SKILL MARKDOWN UTILITIES ------------
/**
 * Finds direct child skill markdown files under a provider skill root.
 *
 * Skill systems usually store one skill per child directory, so direct mode
 * scans only `<root>/<skill-name>/SKILL.md`. Recursive mode is reserved for
 * provider sources that can nest skills arbitrarily, and it returns every
 * descendant `SKILL.md`. Missing or unreadable roots return an empty list
 * because users may not have every provider installed or configured.
 */
export async function findProviderSkillMarkdownFiles(
  rootDir: string,
  options: { recursive?: boolean } = {},
): Promise<string[]> {
  const skillFiles: string[] = [];

  const collectRecursive = async (dirPath: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    try {
      const skillPath = path.join(dirPath, 'SKILL.md');
      const skillStats = await stat(skillPath);
      if (skillStats.isFile()) {
        skillFiles.push(skillPath);
      }
    } catch {
      // Directories without SKILL.md are expected while walking plugin trees.
    }

    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await collectRecursive(path.join(dirPath, entry.name));
      }
    }
  };

  if (options.recursive) {
    await collectRecursive(rootDir);
    return skillFiles.sort((left, right) => left.localeCompare(right));
  }

  try {
    const entries = await readdir(rootDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const skillPath = path.join(rootDir, entry.name, 'SKILL.md');
      try {
        const skillStats = await stat(skillPath);
        if (skillStats.isFile()) {
          skillFiles.push(skillPath);
        }
      } catch {
        // A partial skill directory should not block discovery of sibling skills.
      }
    }

    return skillFiles.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/**
 * Reads the `name` and `description` fields from a provider skill markdown file.
 *
 * The metadata is expected in markdown front matter. If a skill omits `name`, the
 * parent directory name is used as a stable fallback so providers can still
 * expose the skill. Missing descriptions are normalized to an empty string.
 */
export async function readProviderSkillMarkdownDefinition(
  skillPath: string,
): Promise<{ name: string; description: string }> {
  const content = await readFile(skillPath, 'utf8');
  return readProviderSkillMarkdownDefinitionFromContent(
    content,
    path.basename(path.dirname(skillPath)),
  );
}

/**
 * Reads the `name` and `description` fields from raw skill markdown content.
 *
 * This keeps filesystem discovery and newly uploaded skill creation aligned on
 * the same front matter parsing rules. `fallbackName` is used when the markdown
 * omits a `name` field so callers still get a stable, non-empty skill id.
 */
export function readProviderSkillMarkdownDefinitionFromContent(
  content: string,
  fallbackName: string,
): { name: string; description: string } {
  const parsed = parseFrontMatter(content);
  const data = readObjectRecord(parsed.data) ?? {};

  return {
    name: readOptionalString(data.name) ?? fallbackName,
    description: readOptionalString(data.description) ?? '',
  };
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER TITLE HELPERS ------------
/**
 * Produces a compact session title suitable for UI rendering and DB storage.
 *
 * Use this when converting provider-native names into a consistent title value.
 * The helper collapses repeated whitespace, trims the result, and truncates it
 * to 120 characters so every provider writes stable and bounded metadata.
 * If the normalized input is empty, it returns the supplied fallback title.
 */
export function normalizeSessionName(rawValue: string | undefined, fallback: string): string {
  const normalized = (rawValue ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 120);
}

// ---------------------------
//----------------- CONVERSATION COMPACTION COMMAND ------------
/**
 * Reads a chat prompt as the `/compact` command, or returns null when it is an
 * ordinary message.
 *
 * `/compact` asks the engine to summarize the conversation so far and free up
 * its context window. Claude, ZCode and Antigravity parse the command out of
 * the prompt text themselves; Codex and OpenCode only compact through a
 * dedicated protocol call, so their runtimes use this to recognize the command
 * and make that call instead of sending the text to the model.
 *
 * The command is the exact, case-sensitive word `/compact` after leading
 * whitespace, ended by whitespace or the end of the text. Whatever follows is
 * returned as `instructions`, trimmed, line breaks kept; a bare command yields
 * an empty string. `/compacted`, `/Compact` or text that merely mentions the
 * command are ordinary messages.
 */
export function readCompactCommand(command: unknown): { instructions: string } | null {
  if (typeof command !== 'string') {
    return null;
  }
  const match = command.trimStart().match(/^\/compact(?=\s|$)([\s\S]*)$/);
  return match ? { instructions: match[1].trim() } : null;
}

/** A token count the way the CLI writes one: `334k`, `1.2M`. */
const formatCompactionTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : `${tokens}`;
};

/** A duration the way the CLI writes one: `2m 22s`. */
const formatCompactionDuration = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/**
 * The one timeline row every provider draws a compaction as.
 *
 * A compaction is the most expensive thing a long session does on its own, so
 * every engine reports it the same way: an assistant `text` row whose
 * `content` says it in a sentence (`Compacted · manual · 334k → 19k tokens ·
 * 2m 20s`, `Compacting conversation…`, `Compaction failed: …`) and whose
 * `compact` field carries the numbers, so a client that knows nothing of
 * compaction still reads the sentence while one that does draws a row of its
 * own and folds the engine's summary (an `isCompactSummary` row) into it.
 *
 * The caller owns `id`: a running row and the row that ends it share one, and
 * the live stream and the history read must derive the same one, so a
 * persisted row replaces the live copy instead of sitting beside it.
 * Consumers: the Claude, Codex, OpenCode and ZCode session normalizers.
 */
export function createCompactionMessage(input: {
  id: string;
  sessionId: string | null;
  timestamp?: string;
  provider: NormalizedMessage['provider'];
  phase: 'running' | 'done' | 'failed';
  trigger?: 'manual' | 'auto';
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: string | null;
}): NormalizedMessage {
  const { phase, trigger, preTokens, postTokens, durationMs, error } = input;
  let content: string;
  if (phase === 'running') {
    content = 'Compacting conversation…';
  } else if (phase === 'failed') {
    content = `Compaction failed${error ? `: ${error}` : ''}`;
  } else {
    const said = ['Compacted'];
    if (trigger) said.push(trigger);
    if (preTokens) {
      said.push(postTokens
        ? `${formatCompactionTokenCount(preTokens)} → ${formatCompactionTokenCount(postTokens)} tokens`
        : `${formatCompactionTokenCount(preTokens)} tokens`);
    }
    if (durationMs) said.push(formatCompactionDuration(durationMs));
    content = said.join(' · ');
  }
  return createNormalizedMessage({
    id: input.id,
    sessionId: input.sessionId,
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    provider: input.provider,
    kind: 'text',
    role: 'assistant',
    content,
    compact: {
      phase,
      ...(trigger ? { trigger } : {}),
      ...(preTokens ? { preTokens } : {}),
      ...(postTokens ? { postTokens } : {}),
      ...(durationMs ? { durationMs } : {}),
      ...(phase === 'failed' && error !== undefined ? { error } : {}),
    },
  });
}

// ---------------------------
//----------------- PROVIDER SESSION VALUE NORMALIZATION UTILITIES ------------
/**
 * Converts provider-native timestamps into ISO strings.
 *
 * Provider CLIs commonly persist epoch timestamps as milliseconds, seconds, or
 * already-formatted date strings. Use this helper when normalizing session
 * metadata or transcript events so every provider writes the same ISO timestamp
 * shape to API responses and database rows.
 */
export function normalizeProviderTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return normalizeProviderTimestamp(parsed);
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}

/**
 * Parses a JSON string or narrows an existing object into a plain record.
 *
 * Use this when provider databases store structured JSON inside text columns.
 * Invalid JSON, arrays, and primitive values return `null` so callers can skip
 * malformed optional metadata without hiding the rest of a session transcript.
 */
export function readJsonRecord(value: unknown): AnyRecord | null {
  if (typeof value !== 'string') {
    return readObjectRecord(value);
  }

  try {
    return readObjectRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

// ---------------------------
//----------------- AUTH AND CREDENTIAL UTILITIES ------------
/**
 * Decodes a JWT token string without verification and extracts the user email.
 *
 * Consumed by provider auth adapters (Antigravity, Codex) when inspecting OAuth
 * `id_token` credentials to surface the authenticated account email.
 * Returns null if the token cannot be decoded or carries no email field.
 */
export function extractEmailFromJwt(jwtToken: string | null | undefined): string | null {
  if (!jwtToken || typeof jwtToken !== 'string') {
    return null;
  }

  try {
    const parts = jwtToken.split('.');
    if (parts.length >= 2 && parts[1]) {
      const payload = readObjectRecord(
        JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
      );
      return readOptionalString(payload?.email) ?? readOptionalString(payload?.user) ?? null;
    }
  } catch {
    // Unparseable JWT token
  }

  return null;
}

// ---------------------------
//----------------- TOKEN USAGE UTILITIES ------------
/**
 * Whether one reset card's coverage satisfies a consume request.
 *
 * An `all` card restores every window, so it covers any request; a card
 * naming one window covers only that exact window — spending a weekly card
 * to refill 5 hours would waste the weekly restore it also carries.
 */
export function resetCreditCovers(requestedResetType: string, creditResetType: string): boolean {
  return creditResetType === 'all' || creditResetType === requestedResetType;
}

/**
 * Picks the card to spend for a consume request: among available cards whose
 * coverage satisfies `resetType`, the soonest-expiring one — use-it-or-lose-it
 * before hoarding. Cards without an expiry sort last.
 *
 * Cards past their expiry are skipped even when the provider still marks them
 * available: the provider's flag can lag, and spending a dead card would
 * report a reset that never lands. Shared by the Codex and ZCode quota
 * adapters so both providers spend cards by the same rule; the caller never
 * sees card ids.
 */
export function pickAvailableResetCredit(
  credits: readonly ProviderQuotaResetCredit[],
  resetType: string,
  now = Date.now(),
): ProviderQuotaResetCredit | null {
  const covering = credits
    .filter((credit) => credit.available
      && resetCreditCovers(resetType, credit.resetType)
      && !(credit.expireTime && Date.parse(credit.expireTime) <= now))
    .sort((left, right) => {
      const leftTime = left.expireTime ? Date.parse(left.expireTime) : Number.POSITIVE_INFINITY;
      const rightTime = right.expireTime ? Date.parse(right.expireTime) : Number.POSITIVE_INFINITY;
      return leftTime - rightTime;
    });
  return covering[0] ?? null;
}

type ProviderQuotaCacheOptions = {
  forceRefresh?: boolean;
};

type ProviderQuotaCache<T> = {
  get(
    options: ProviderQuotaCacheOptions,
    loader: () => Promise<T | null>,
    now?: () => number,
  ): Promise<T | null>;
  reset(): void;
};

/**
 * Creates a short-lived nullable cache for provider account quota adapters.
 *
 * Antigravity and Codex use this to avoid repeatedly spawning their CLIs when
 * the Token Usage dialog is opened. Successful `null` reads are cached because
 * they represent a provider returning no account quota. Loader failures remain
 * rejected so routes can distinguish an unavailable provider from empty data.
 * Concurrent completions commit by request order, preventing an older read
 * from overwriting the result of a newer forced refresh.
 */
export function createProviderQuotaCache<T>(ttlMs: number): ProviderQuotaCache<T> {
  let cachedValue: T | null = null;
  let cachedTimestamp = 0;
  let inFlightPromise: Promise<T | null> | null = null;
  let inFlightRequestId = 0;
  let latestRequestId = 0;
  let latestCommittedRequestId = 0;

  return {
    async get(options, loader, now = Date.now): Promise<T | null> {
      const currentTime = now();
      if (
        !options.forceRefresh
        && cachedTimestamp > 0
        && currentTime - cachedTimestamp < ttlMs
      ) {
        return cachedValue;
      }

      if (!options.forceRefresh && inFlightPromise) {
        return inFlightPromise;
      }

      const requestId = ++latestRequestId;
      const loadPromise = (async () => {
        try {
          const loadedValue = await loader();
          if (requestId > latestCommittedRequestId) {
            cachedValue = loadedValue;
            cachedTimestamp = now();
            latestCommittedRequestId = requestId;
          }
          return loadedValue;
        } finally {
          if (inFlightRequestId === requestId) {
            inFlightPromise = null;
            inFlightRequestId = 0;
          }
        }
      })();

      if (!options.forceRefresh) {
        inFlightPromise = loadPromise;
        inFlightRequestId = requestId;
      }

      return loadPromise;
    },

    reset(): void {
      cachedValue = null;
      cachedTimestamp = 0;
      inFlightPromise = null;
      inFlightRequestId = 0;
      latestCommittedRequestId = ++latestRequestId;
    },
  };
}

/**
 * Coerces an unknown usage field into a finite number, defaulting to 0.
 *
 * Provider token-usage readers (Claude, Codex, Antigravity, OpenCode) sum
 * counters that may be absent, null, or malformed JSON numbers; every reader
 * must treat those cases as 0 rather than propagating NaN into totals.
 */
export function readUsageNumber(value: unknown): number {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

// ---------------------------

//----------------- STALE-WHILE-REFRESH VALUE ------------

/** Options for `createStaleWhileRefreshValue`. */
export type StaleWhileRefreshOptions<T> = {
  /** Produces a fresh value. May reject; see `failureRetryMs`. */
  load: () => Promise<T>;
  /** How long a loaded value stays fresh; may depend on the value (a fallback can expire sooner). */
  ttlMs: (value: T) => number;
  /** After a failed refresh, how long the previous value keeps serving before the next try. */
  failureRetryMs: number;
  /** Told about every failed refresh, including ones nobody was waiting on. */
  onRefreshError?: (error: unknown) => void;
  /** Clock override for tests. */
  now?: () => number;
};

/** A value that is read on hot paths but slow to produce. */
export type StaleWhileRefreshValue<T> = {
  get(): Promise<T>;
  /** Forgets the value; the next read loads again and waits for it. */
  clear(): void;
};

/**
 * Creates a value that callers never wait on once it has been loaded.
 *
 * Only the first read (and the first after `clear`) waits for `load`. After
 * that an expired value is returned at once while one shared refresh replaces
 * it behind the caller. Provider model catalogs use this: every turn reads the
 * catalog before starting the engine, and the CLI query behind it (`agy
 * models`, `opencode models`, Codex's app-server listing) can take seconds or
 * hang to its timeout, which must not be added to every turn.
 *
 * A failed refresh keeps serving the previous value and waits
 * `failureRetryMs` before trying again. A first read whose load fails rejects,
 * and the next read tries again.
 */
export function createStaleWhileRefreshValue<T>(
  options: StaleWhileRefreshOptions<T>,
): StaleWhileRefreshValue<T> {
  const now = options.now ?? Date.now;
  let current: { value: T } | null = null;
  let expiresAt = 0;
  let refreshing: Promise<T> | null = null;
  // Bumped by `clear`, so a load that was running across it is not kept.
  let generation = 0;

  const refresh = (): Promise<T> => {
    if (refreshing) {
      return refreshing;
    }
    const startedIn = generation;
    const pending = options.load()
      .then((value) => {
        if (startedIn === generation) {
          current = { value };
          expiresAt = now() + options.ttlMs(value);
        }
        return value;
      })
      .catch((error: unknown) => {
        options.onRefreshError?.(error);
        if (startedIn !== generation || !current) {
          throw error;
        }
        expiresAt = now() + options.failureRetryMs;
        return current.value;
      })
      .finally(() => {
        if (refreshing === pending) {
          refreshing = null;
        }
      });
    refreshing = pending;
    return pending;
  };

  return {
    async get(): Promise<T> {
      if (current && now() < expiresAt) {
        return current.value;
      }
      if (current) {
        // Nobody waits on this refresh; a failure was already reported.
        void refresh().catch(() => undefined);
        return current.value;
      }
      return refresh();
    },

    clear(): void {
      generation += 1;
      current = null;
      expiresAt = 0;
      refreshing = null;
    },
  };
}

// ---------------------------

/**
 * Decodes an OpenCode text payload that was persisted as a JSON string literal.
 *
 * OpenCode can store the first user prompt (and other text parts) as `"hello"`
 * instead of `hello`. Used by both the OpenCode session reader (transcript
 * history) and the OpenCode synchronizer (session titling) so a session name or
 * message body never surfaces with surrounding quote characters. Only fully
 * quoted, valid JSON string literals are unwrapped; ordinary prose that merely
 * happens to start/end with a quote is returned untouched.
 */
export function unwrapJsonStringLiteral(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return value;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

// ---------------------------
//----------------- SAFE DIRECTORY NAME UTILITIES ------------
/**
 * Validates that a user or provider supplied identifier can safely be treated
 * as one leaf directory name under an existing root folder.
 *
 * Use this before composing paths like `<root>/<session-id>/file.db>` to block
 * path traversal and accidental nested paths. The returned string is trimmed but
 * otherwise unchanged so callers can still match the provider's on-disk naming.
 */
export function sanitizeLeafDirectoryName(inputName: string, label = 'directory name'): string {
  const normalized = inputName.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  if (
    normalized.includes('..')
    || normalized.includes(path.posix.sep)
    || normalized.includes(path.win32.sep)
    || normalized !== path.basename(normalized)
  ) {
    throw new Error(`Invalid ${label} "${inputName}".`);
  }

  return normalized;
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER FILESYSTEM HELPERS ------------
/**
 * Removes one file or directory recursively if it exists.
 *
 * Used by provider session implementations and session cleanup services to
 * remove transcript files, subagents, and provider project folders safely.
 * Returns true if deletion succeeded, false if path was missing or failed.
 */
export async function removePathIfExists(targetPath: string): Promise<boolean> {
  try {
    await rm(targetPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively discovers files that match one extension, with optional incremental filtering.
 *
 * Provider synchronizers call this to find transcript artifacts under provider
 * home directories. Pass `lastScanAt` to include only files created after the
 * previous scan, or pass `null` to perform a full rescan. Missing directories
 * are treated as empty because not every provider exists on every machine.
 */
export async function findFilesRecursivelyCreatedAfter(
  rootDir: string,
  extension: string,
  lastScanAt: Date | null,
  fileList: string[] = []
): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);

      if (entry.isDirectory()) {
        await findFilesRecursivelyCreatedAfter(fullPath, extension, lastScanAt, fileList);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(extension)) {
        continue;
      }

      if (!lastScanAt) {
        fileList.push(fullPath);
        continue;
      }

      const fileStat = await stat(fullPath);
      if (fileStat.birthtime > lastScanAt) {
        fileList.push(fullPath);
      }
    }
  } catch {
    // Missing provider folders are expected in first-run or partial setups.
  }

  return fileList;
}

/**
 * Reads file creation/update timestamps and maps them to DB-friendly ISO strings.
 *
 * Session indexers use this to persist `created_at` and `updated_at` metadata
 * when upserting sessions. If the file cannot be read, an empty object is
 * returned so indexing can continue for other files.
 */
export async function readFileTimestamps(
  filePath: string
): Promise<{ createdAt?: string; updatedAt?: string }> {
  try {
    const fileStat = await stat(filePath);
    return {
      createdAt: fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
    };
  } catch {
    return {};
  }
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER JSONL PARSING HELPERS ------------
async function* readJsonlRows(filePath: string): AsyncGenerator<unknown> {
  const fileStream = fs.createReadStream(filePath);
  const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let streamError: Error | undefined;
  fileStream.on('error', (error) => {
    streamError = error;
    lineReader.close();
  });
  try {
    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(trimmed) as unknown; }
      catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      yield parsed;
    }
  } catch (error) {
    if (error !== streamError) throw error;
  } finally {
    lineReader.close();
    fileStream.destroy();
  }
}

/**
 * Builds the session synchronizers' key/value lookup from valid JSONL rows.
 * First values win by default; `last` keeps append-only Codex rename records current.
 * Malformed rows and unreadable files do not prevent later session scans.
 */
export async function buildLookupMap(
  filePath: string,
  keyField: string,
  valueField: string,
  prefer: 'first' | 'last' = 'first'
): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();

  for await (const row of readJsonlRows(filePath)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const parsed = row as Record<string, unknown>;
    const key = parsed[keyField];
    const value = parsed[valueField];

    if (typeof key === 'string' && typeof value === 'string' && (prefer === 'last' || !lookup.has(key))) {
      lookup.set(key, value);
    }
  }

  return lookup;
}

/**
 * Reads a JSONL file and returns the first extracted payload that matches caller criteria.
 *
 * The caller supplies an `extractor` that validates provider-specific row
 * shapes. This helper centralizes line-by-line parsing and lets indexers stop
 * scanning as soon as one valid row is found.
 */
export async function extractFirstValidJsonlData<T>(
  filePath: string,
  extractor: (parsedJson: unknown) => T | null | undefined
): Promise<T | null> {
  for await (const row of readJsonlRows(filePath)) {
    const extracted = extractor(row);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

// ---------------------------
//----------------- CLAUDE TRANSCRIPT ROW UTILITIES ------------
/**
 * True for a Claude session JSONL row that holds a `message` without being a
 * conversation turn.
 *
 * Only `user` and `assistant` rows are turns. The Claude CLI also logs the
 * requests it sends to the API as `api-request-blob` rows, and each one holds a
 * copy of a prompt, tool call or system block that is already recorded as its
 * own turn. Those copies have no timestamp. A reader that recognizes a turn by
 * `message.role` alone shows each copy a second time, stamped with the time the
 * transcript was read. Use this check to skip such rows before reading
 * `message`. A row with no `message` returns false, so callers keep their
 * other records, such as `queue-operation`, `system` and `last-prompt`.
 */
export function isClaudeNonTurnMessageRow(row: AnyRecord): boolean {
  return row.message != null && row.type !== 'user' && row.type !== 'assistant';
}

// ---------------------------
//----------------- CLI PROMPT ARGUMENT UTILITIES ------------
/**
 * Makes a prompt safe to pass as one CLI argument to `.cmd`-shimmed tools on
 * Windows (cursor-agent and opencode installed via npm-style shims).
 *
 * cmd.exe cannot carry newlines inside an argument: everything after the
 * first newline is silently dropped before the target CLI ever sees it, which
 * truncates multi-line prompts and any appended `<images_input>` block.
 * Collapsing newline runs to single spaces loses formatting but never loses
 * content, so runtimes should call this on win32 right before spawning.
 *
 * Used by the cursor and opencode spawn runtimes.
 */
export function flattenPromptForWindowsShell(prompt: string): string {
  if (process.platform !== 'win32' || typeof prompt !== 'string') {
    return prompt;
  }
  return prompt.replace(/\s*\r?\n\s*/g, ' ').trim();
}

// ---------------------------
//----------------- TERMINAL OUTPUT UTILITIES ------------
/**
 * Matches the escape sequences a CLI emits when it believes it is writing to a
 * terminal, in the three shapes those tools actually produce:
 * - OSC (`ESC ]` … terminated by BEL or ST), used for titles and hyperlinks.
 * - CSI (`ESC [`, or the 8-bit `\u009B` introducer that stands in for both
 *   bytes), used for SGR colors and cursor control.
 * - any other ECMA-48 escape sequence: `ESC`, optional intermediate bytes
 *   (`0x20`-`0x2F`), one final byte (`0x30`-`0x7E`), such as `ESC ( B`.
 *
 * OSC and CSI are listed first so their terminators are consumed by the
 * specific alternative rather than by the generic one.
 */
const ANSI_ESCAPE_SEQUENCE_REGEX =
  /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B[ -/]*[0-~]/g;

/**
 * Removes ANSI escape sequences from text captured off a CLI's stdout or
 * stderr. Provider runtimes, session readers, and the shell WebSocket share
 * this because every one of them forwards captured process output to a web
 * client that renders plain text: left in, the escapes show up verbatim
 * (`[93m[1m!`) instead of as styling.
 *
 * The result can be empty when the input was styling only, so callers that
 * forward the text should re-check for emptiness after cleaning.
 */
export function stripAnsiSequences(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '');
}

const ANSI_TERMINAL_STYLES = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
} as const;

/**
 * Applies the small, consistent ANSI style vocabulary used by backend
 * terminal output. The CLI and server bootstrap share these formatters so
 * status, warning, and startup messages use one implementation. Callers
 * should pass complete display strings and write the returned value directly
 * to stdout or stderr; the reset suffix prevents styling subsequent output.
 */
export const terminalTextStyles = {
  info: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.cyan}${text}${ANSI_TERMINAL_STYLES.reset}`,
  ok: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.green}${text}${ANSI_TERMINAL_STYLES.reset}`,
  warn: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.yellow}${text}${ANSI_TERMINAL_STYLES.reset}`,
  error: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.yellow}${text}${ANSI_TERMINAL_STYLES.reset}`,
  tip: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.blue}${text}${ANSI_TERMINAL_STYLES.reset}`,
  bright: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.bright}${text}${ANSI_TERMINAL_STYLES.reset}`,
  dim: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.dim}${text}${ANSI_TERMINAL_STYLES.reset}`,
};

// ---------------------------
//----------------- RUNTIME PATH RESOLUTION UTILITIES ------------
/**
 * Resolves the directory containing an ES module from `import.meta.url`.
 * Backend entrypoints and feature composition roots use this instead of
 * recreating CommonJS `__dirname` logic.
 */
export function getModuleDirectory(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/**
 * Walks upward to the nearest `server` directory in either source or compiled
 * output. Callers use this stable anchor for server-relative resources.
 */
export function findServerRoot(startDirectory: string): string {
  let currentDirectory = startDirectory;
  while (path.basename(currentDirectory) !== 'server') {
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error(`Could not resolve the backend server root from "${startDirectory}".`);
    }
    currentDirectory = parentDirectory;
  }
  return currentDirectory;
}

/**
 * Resolves the application root from a source or `dist-server/server` path so
 * package-level resources work identically before and after compilation.
 */
export function findApplicationRoot(startDirectory: string): string {
  const serverRoot = findServerRoot(startDirectory);
  const parentDirectory = path.dirname(serverRoot);
  return path.basename(parentDirectory) === 'dist-server'
    ? path.dirname(parentDirectory)
    : parentDirectory;
}


// ---------------------------
//----------------- ANTIGRAVITY WORKSPACE PARSER UTILITIES ------------
/**
 * Parses workspace directory from Antigravity workspace_uris JSON array or raw string.
 *
 * Antigravity stores workspace paths in conversation_summaries.db as JSON arrays of file URIs
 * like `["file:///path/to/project"]` or raw strings.
 */
export function parseAntigravityWorkspacePath(workspaceUris: string | null): string | null {
  if (!workspaceUris) return null;

  const tryParseUri = (uri: string): string => {
    if (uri.startsWith('file://')) {
      try {
        return fileURLToPath(uri);
      } catch {
        return decodeURIComponent(uri.slice(7));
      }
    }
    return uri;
  };

  try {
    const uris = JSON.parse(workspaceUris);
    if (Array.isArray(uris) && uris.length > 0) {
      const firstUri = uris[0];
      if (typeof firstUri === 'string') {
        return tryParseUri(firstUri);
      }
    }
  } catch {
    if (workspaceUris.startsWith('file://')) {
      return tryParseUri(workspaceUris);
    }
    if (workspaceUris.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(workspaceUris)) {
      return workspaceUris;
    }
  }

  return null;
}

// ---------------------------
//----------------- LOOPBACK HTTP FORWARDING UTILITIES ------------
/**
 * One inbound request restated as a call against a service listening on this
 * machine's loopback interface.
 *
 * `path` must be an absolute path and already carry its query string; the
 * forwarder does not rebuild it. `headers` fully replaces the caller's headers
 * so no client credentials leak into a local service by accident. `body` is
 * only written when present, which is why GET/HEAD callers simply omit it.
 * `transformResponseHeaders` is the last chance to strip or rewrite upstream
 * headers (`set-cookie`, `location`, CSP) before they reach the browser.
 */
export type LoopbackForwardRequest = {
  port: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  transformResponseHeaders?: (
    headers: http.IncomingHttpHeaders,
    statusCode: number,
  ) => http.OutgoingHttpHeaders;
};

/**
 * Pipes a request to `127.0.0.1:<port>` and streams the upstream response
 * straight back to the client without buffering it.
 *
 * Used by the plugins module (RPC calls into a plugin's own HTTP server) and by
 * the local-proxy module (serving server-side dev servers to a remote browser).
 * The target host is hardcoded to the loopback address: both callers exist to
 * reach services on this machine, and pinning the host keeps request forgery
 * confined to ports that are already local.
 *
 * `onError` receives connection failures; pass Express's `next` to route them
 * into the error middleware, or handle them inline to send a custom status.
 */
export function forwardToLoopbackService(
  request: LoopbackForwardRequest,
  res: Response,
  onError: (error: Error) => void,
): void {
  const upstreamRequest = http.request(
    {
      hostname: '127.0.0.1',
      port: request.port,
      path: request.path,
      method: request.method,
      headers: request.headers,
    },
    (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode ?? 502;
      const headers = request.transformResponseHeaders
        ? request.transformResponseHeaders(upstreamResponse.headers, statusCode)
        : upstreamResponse.headers;
      res.writeHead(statusCode, headers);
      upstreamResponse.pipe(res);
    },
  );

  upstreamRequest.on('error', onError);

  if (request.body !== undefined) {
    upstreamRequest.setHeader('content-length', Buffer.byteLength(request.body));
    upstreamRequest.write(request.body);
  }

  upstreamRequest.end();
}

/**
 * Codex title client/service bound waits to their shared abort deadline.
 * Rejecting stops the wait, not the underlying I/O; callers must guard later
 * writes and retain cleanup ownership. Source rejection is always observed.
 */
export function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Operation aborted.')); };
    signal.addEventListener('abort', abort, { once: true });
    operation.then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

//----------------- CODEX TITLE ISOLATION ------------
/** The runtime injects this server; the title client's config must explicitly disable it. */
export const CODEX_TASK_MCP_NAME = 'cloudcli_task_continuations';

/** Runtime sandbox commands and manager-owned title workers exclude host-only credentials. */
export const CODEX_HOST_CREDENTIAL_ENV_NAMES = [
  'API_KEY', 'CLOUDCLI_TASK_API_KEY', 'CLOUDCLI_TASK_RUN_CONTEXT', 'CLOUDCLI_TASK_BRIDGE',
  'CLOUDCLI_REGISTRATION_TOKEN', 'CLOUDCLI_TASK_TOKEN', 'JWT_SECRET',
] as const;

/**
 * Codex title client and the real protocol probe use the terminal's isolation
 * recipe. Input is config/read's effective config; an unreadable MCP table
 * fails closed. This does not replace checking thread/start's actual sandbox.
 */
export function buildCodexTitleIsolationConfig(effectiveConfig: unknown): Record<string, unknown> {
  const config = readObjectRecord(effectiveConfig);
  if (!config || (config.mcp_servers != null && !readObjectRecord(config.mcp_servers))) {
    throw new AppError('Codex title configuration could not be verified.', { code: 'CODEX_TITLE_ISOLATION', statusCode: 502 });
  }
  const features = [
    'apps', 'code_mode', 'code_mode_only', 'context_management', 'current_time_reminder',
    'deferred_executor', 'enable_fanout', 'goals', 'hooks', 'image_generation', 'memories',
    'multi_agent', 'multi_agent_v2', 'plugins', 'request_permissions_tool', 'shell_snapshot',
    'shell_tool', 'standalone_web_search', 'token_budget', 'tool_suggest', 'unified_exec', 'view_image',
  ];
  // Disable every configured server, including the host bridge when present.
  // Creating an absent entry with only enabled=false fails transport validation.
  const servers = Object.keys(readObjectRecord(config.mcp_servers) ?? {});
  return {
    ...Object.fromEntries(features.map((feature) => [`features.${feature}`, false])),
    'cloud.skills.enabled': false, 'skills.include_instructions': false,
    'tools.experimental_request_user_input.enabled': false, 'tools.update_plan.enabled': false,
    web_search: 'disabled', default_permissions: ':read-only',
    project_doc_max_bytes: 0, developer_instructions: '', instructions: '',
    mcp_servers: Object.fromEntries(servers.map((server) => [server, { enabled: false }])),
  };
}

// ---------------------------
/**
 * Resolves the permission mode for Codex's app-server turn and any detached
 * command that must inherit that same sandbox. The chat gateway and Codex
 * adapter both use this mapping so task registration cannot claim a broader
 * sandbox than the original turn received.
 */
export function resolveCodexExecutionPolicy(permissionMode: string): {
  sandbox: 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'never' | 'on-request';
  sandboxPolicy: {
    type: 'workspaceWrite' | 'dangerFullAccess';
    networkAccess: boolean;
  };
} {
  if (permissionMode === 'bypassPermissions') {
    return {
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess', networkAccess: true },
    };
  }

  if (permissionMode === 'acceptEdits') {
    return {
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    };
  }

  return {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
  };
}

//----------------- CANONICAL JSON ------------
/**
 * Recursively sorts object keys without changing arrays or JSON scalar values.
 * Task result digests and bridge argument digests use this on parsed JSON so
 * property insertion order cannot change equality. This is not a JSON validator.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalizeJson(record[key])]));
}

//----------------- CODEX CONFIGURATION ROOT ------------
/**
 * Codex auth, models, MCP, skills and history adapters use the same home as the
 * engine process. Read at call time so isolated workers and probes can select
 * CODEX_HOME without retaining another account's configuration. Workspace-local
 * .codex directories and the independent ~/.agents directory are unaffected.
 */
export function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// ---------------------------
//----------------- QUEUED CHAT MESSAGE UTILITIES ------------
/**
 * Reads a stored queued chat message (the parsed JSON of
 * `session_drafts.queued_message`), or returns null when it has nothing to
 * send: no text and no attachments.
 *
 * Used by the Database module's drafts repository, which appends a follow-up
 * to the waiting message, and by the Scheduled Messages dispatcher, which sends
 * it. Both must read a stored message the same way, or a merge could keep what
 * the dispatcher then ignores. Rows from before attachments existed hold
 * image-only descriptors in `images`; they are read as `attachments`.
 * `options` is kept only when it is a plain object.
 */
export function readQueuedChatMessage(value: unknown): QueuedChatMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images)
      ? record.images
      : [];
  if (!content.trim() && attachments.length === 0) {
    return null;
  }
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : undefined;
  return { content, ...(options ? { options } : {}), attachments };
}
