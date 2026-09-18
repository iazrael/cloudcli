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

/** The payload accepted when constructing a message of one specific kind. */
export type MessageInputForKind<K extends MessageKind> =
  Omit<NormalizedMessageEnvelope, 'kind' | 'id' | 'sessionId' | 'timestamp'>
  & {
    kind: K;
    id?: string | null;
    sessionId?: string | null;
    timestamp?: string | null;
  }
  & MessageFieldsByKind[K];
