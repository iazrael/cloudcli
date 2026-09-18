/**
 * The runtime half of the wire contract.
 *
 * Types stop at the boundary of what the compiler can see, and two of this
 * repository's provider runtimes are `.js` files compiled with `checkJs:
 * false` — which is precisely how `parentToolUseId` reached the client for
 * years without ever being declared. This module re-states the contract as a
 * runtime check so an adapter the compiler never inspects cannot quietly widen
 * what the frontend receives.
 *
 * A violation never silently passes, and never kills a run either: an
 * undeclared field is stripped before the message leaves the backend, so no
 * renderer can come to depend on it, and the offending field is named in the
 * log so the adapter that invented it can be fixed.
 */

import type { NormalizedMessage } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

/**
 * Every field the wire contract declares.
 *
 * The `satisfies` clause plus the exhaustiveness assertion below make this
 * list impossible to forget: adding a field to `NormalizedMessage` without
 * listing it here fails to compile, so this cannot become the kind of stale
 * mirror it exists to prevent.
 */
const NORMALIZED_MESSAGE_KEYS = [
  'aborted',
  'actualSessionId',
  'anchorId',
  'canInterrupt',
  'commandArgs',
  'commandMessage',
  'commandName',
  'content',
  'contentCompleteness',
  'context',
  'displayText',
  'exitCode',
  'files',
  'id',
  'images',
  'input',
  'isCancelledError',
  'isCompactSummary',
  'isError',
  'isLocalCommand',
  'isLocalCommandStdout',
  'kind',
  'memoryCitations',
  'newSessionId',
  'parentToolUseId',
  'provider',
  'providerRowKey',
  'reason',
  'requestId',
  'role',
  'rowid',
  'seq',
  'sequence',
  'sessionId',
  'status',
  'subagent',
  'subagentTools',
  'success',
  'summary',
  'summaryKey',
  'text',
  'timestamp',
  'tokenBudget',
  'tokens',
  'toolId',
  'toolInput',
  'toolName',
  'toolResult',
  'toolUseResult',
  'transcriptAnchorId',
] as const satisfies readonly (keyof NormalizedMessage)[];

type UnlistedKey = Exclude<keyof NormalizedMessage, typeof NORMALIZED_MESSAGE_KEYS[number]>;

/**
 * Compile-time proof that the list above covers the contract. When a new field
 * is added to `NormalizedMessage`, this line stops compiling and names it.
 */
const _everyFieldIsListed: UnlistedKey extends never ? true : ['unlisted field', UnlistedKey] = true;
void _everyFieldIsListed;

const KNOWN_KEYS: ReadonlySet<string> = new Set(NORMALIZED_MESSAGE_KEYS);

/** Result of checking one outbound payload against the contract. */
export type NormalizedMessageContractResult =
  | { ok: true; message: NormalizedMessage; strippedKeys: string[] }
  | { ok: false; reason: string };

/**
 * Checks one outbound payload and returns the message that may leave the
 * backend.
 *
 * The envelope must be intact — a payload that is not an object, or whose
 * `kind` or `provider` is missing, is not a normalized message at all and is
 * rejected outright. Undeclared fields are a lesser fault: the message is
 * still a message, so it passes with those fields removed rather than the run
 * dying over a field nobody asked for.
 */
export function enforceNormalizedMessageContract(value: unknown): NormalizedMessageContractResult {
  const record = readObjectRecord(value);
  if (!record) {
    return { ok: false, reason: 'payload is not an object' };
  }
  if (typeof record.kind !== 'string' || !record.kind) {
    return { ok: false, reason: 'missing `kind`' };
  }
  if (typeof record.provider !== 'string' || !record.provider) {
    return { ok: false, reason: `missing \`provider\` on a ${record.kind} message` };
  }

  const strippedKeys = Object.keys(record).filter((key) => !KNOWN_KEYS.has(key));
  if (strippedKeys.length === 0) {
    return { ok: true, message: record as NormalizedMessage, strippedKeys };
  }

  const message = { ...record };
  for (const key of strippedKeys) {
    delete message[key];
  }
  return { ok: true, message: message as NormalizedMessage, strippedKeys };
}
