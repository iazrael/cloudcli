/**
 * Which fields each message kind may carry.
 *
 * `NormalizedMessage` stays flat on the reading side: hundreds of call sites
 * take one and ask it questions, and turning it into a hard union would be a
 * single breaking rewrite of all of them. The discipline is applied where it
 * costs nothing and catches the most — at construction. A `text` message
 * cannot be built with `toolName`, a `tool_use` cannot be built with
 * `newSessionId`, and the compiler says so at the line that did it.
 *
 * The envelope below is what every kind carries; the map adds each kind's own
 * fields. `NormalizedMessage` remains the union of all of them, so consumers
 * are unaffected and can be narrowed one at a time with the predicates in
 * `messageNarrowing.ts`.
 */

import type {
  LLMProvider,
  MemoryCitation,
  MessageKind,
  NormalizedMessage,
  SubagentActivity,
  SubagentInfo,
} from './chatEvents.js';

/** Fields every kind carries, independent of what it says. */
export type NormalizedMessageEnvelope = {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  seq?: number;
  /** Ordering hints some providers can supply for any row they persist. */
  sequence?: number;
  rowid?: number;
};

/**
 * Per-kind field sets.
 *
 * Deliberately permissive where a field genuinely spans kinds (`content` is
 * carried by most of them) and strict where it does not. Getting an entry
 * wrong is not a silent problem: the construction site stops compiling.
 */
export type MessageFieldsByKind = {
  text: {
    role?: 'user' | 'assistant';
    content?: string;
    displayText?: string;
    transcriptAnchorId?: string;
    providerRowKey?: string;
    contentCompleteness?: 'complete' | 'truncated';
    images?: NormalizedMessage['images'];
    files?: NormalizedMessage['files'];
    memoryCitations?: MemoryCitation[];
    parentToolUseId?: string;
    commandName?: string;
    commandMessage?: string;
    commandArgs?: string;
    isLocalCommand?: boolean;
    isLocalCommandStdout?: boolean;
    isCompactSummary?: boolean;
  };
  thinking: {
    content?: string;
    transcriptAnchorId?: string;
    parentToolUseId?: string;
  };
  stream_delta: {
    role?: 'user' | 'assistant';
    content?: string;
    transcriptAnchorId?: string;
    providerRowKey?: string;
  };
  /** Carries nothing of its own: it only says the current segment closed. */
  stream_end: object;
  tool_use: {
    toolName?: string;
    toolInput?: unknown;
    toolId?: string;
    content?: string;
    status?: string;
    transcriptAnchorId?: string;
    parentToolUseId?: string;
    subagent?: SubagentInfo;
    subagentTools?: SubagentActivity[];
    memoryCitations?: MemoryCitation[];
  };
  tool_result: {
    toolId?: string;
    toolResult?: NormalizedMessage['toolResult'];
    toolUseResult?: unknown;
    content?: string;
    isError?: boolean;
    parentToolUseId?: string;
  };
  error: {
    content?: string;
    text?: string;
    isError?: boolean;
    /** ZCode only: the engine called this a cancelled request, not a failure. */
    isCancelledError?: boolean;
  };
  complete: {
    actualSessionId?: string;
    exitCode?: number;
    success?: boolean;
    aborted?: boolean;
    tokens?: number;
  };
  status: {
    text?: string;
    status?: string;
    tokenBudget?: unknown;
  };
  permission_request: {
    requestId?: string;
    toolName?: string;
    toolId?: string;
    input?: unknown;
    context?: unknown;
    reason?: string;
    canInterrupt?: boolean;
  };
  permission_resolved: { requestId?: string };
  permission_cancelled: { requestId?: string; reason?: string };
  session_created: { newSessionId?: string; content?: string };
  history_truncated: { anchorId?: string };
  task_notification: {
    status?: string;
    summary?: string;
    summaryKey?: string;
  };
};

/**
 * Compile-time proof that every kind has an entry. Adding a `MessageKind`
 * without describing its fields stops this line from compiling and names it.
 */
type KindWithoutFields = Exclude<MessageKind, keyof MessageFieldsByKind>;
const _everyKindIsDescribed: KindWithoutFields extends never
  ? true
  : ['kind without a field set', KindWithoutFields] = true;
void _everyKindIsDescribed;

/**
 * Kinds that can appear in a stored transcript.
 *
 * These are the rows that exist twice — once as a live frame while the run is
 * in flight, once as a persisted row a later history read returns. The client
 * has to recognise the two as the same row, so their `id` must be derived
 * from something the engine itself stores: same record, same id, every read,
 * on both paths. Every other kind describes a run in flight and is never read
 * back, so a throwaway id is fine there.
 */
export const TRANSCRIPT_ROW_KINDS = [
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'task_notification',
] as const satisfies readonly MessageKind[];

/**
 * `error` is deliberately absent. Most error frames are produced by the
 * gateway or a runtime about a run in flight and are never read back, so
 * there is no engine record to derive an id from. zcode is the one engine
 * that persists error rows; its live and history paths derive the same id
 * from the engine's own event id, which is what the join needs — the
 * requirement just cannot be stated for the kind as a whole.
 */

/** A kind whose rows are persisted and therefore need a deterministic id. */
export type TranscriptRowKind = typeof TRANSCRIPT_ROW_KINDS[number];

/**
 * The marker every randomly generated message id starts with.
 *
 * A random id is legitimate on a frame that exists only while a run is in
 * flight, and never on a row a later history read has to match. Making the
 * two kinds of id tell themselves apart is what lets the contract gate catch
 * the mistake in the `.js` runtimes the compiler cannot inspect.
 */
export const VOLATILE_MESSAGE_ID_PREFIX = 'vol_';

/**
 * An id invented at emit time rather than derived from the engine's record.
 *
 * The brand exists to be rejected: `DeterministicRowId` below accepts any
 * plain string but not this one, so passing a generated id as a transcript
 * row's id stops compiling at the line that did it.
 */
export type VolatileMessageId = string & { readonly __volatile: unique symbol };

/**
 * An id a transcript row may carry: anything except a generated one.
 *
 * Plain strings — an engine uuid, a rollout ordinal, a database key — satisfy
 * this. `VolatileMessageId` does not.
 */
export type DeterministicRowId = string & { __volatile?: undefined };

/** Whether an id was invented at emit time. */
export function isVolatileMessageId(id: string): boolean {
  return id.startsWith(VOLATILE_MESSAGE_ID_PREFIX);
}

/**
 * The payload accepted when constructing a message of one specific kind.
 *
 * `id` is mandatory for transcript rows and optional for everything else:
 * omitting it there is what let adapters fall back to a random id, which made
 * the same persisted row arrive under a new id on every history read and left
 * the client with nothing to join the two sources on.
 */
export type MessageInputForKind<K extends MessageKind> =
  Omit<NormalizedMessageEnvelope, 'kind' | 'id' | 'sessionId' | 'timestamp'>
  & {
    kind: K;
    sessionId?: string | null;
    timestamp?: string | null;
  }
  & (K extends TranscriptRowKind ? { id: DeterministicRowId } : { id?: string | null })
  & MessageFieldsByKind[K];
