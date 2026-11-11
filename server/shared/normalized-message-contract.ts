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

import { isValidReplaySeq, isValidStreamEpoch } from '../../shared/protocol/frameNarrowing.js';
import { isVolatileMessageId, TRANSCRIPT_ROW_KINDS } from '../../shared/protocol/messageKinds.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

const TRANSCRIPT_ROW_KIND_SET: ReadonlySet<string> = new Set(TRANSCRIPT_ROW_KINDS);

/**
 * Every field the wire contract declares.
 *
 * The `satisfies` clause plus the exhaustiveness assertion below make this
 * list impossible to forget: adding a field to `NormalizedMessage` without
 * listing it here fails to compile, so this cannot become the kind of stale
 * mirror it exists to prevent.
 */
const NORMALIZED_MESSAGE_KEYS = [
  'activityState',
  'backgroundWorkPending',
  'backgroundWorkQueuesInput',
  'aborted',
  'agents',
  'actualSessionId',
  'anchorId',
  'backgroundTasks',
  'canInterrupt',
  'commandArgs',
  'compact',
  'commandMessage',
  'commandName',
  'content',
  'contentCompleteness',
  'context',
  'description',
  'displayText',
  'event',
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
  'model',
  'newSessionId',
  'outputFile',
  'parentToolUseId',
  'provider',
  'providerRowKey',
  'reason',
  'requestId',
  'resumed',
  'role',
  'rowid',
  'seq',
  'streamEpoch',
  'sequence',
  'sessionId',
  'status',
  'subagent',
  'subagentTools',
  'success',
  'summary',
  'summaryKey',
  'taskId',
  'taskType',
  'text',
  'timestamp',
  'tokenBudget',
  'tokens',
  'toolId',
  'toolInput',
  'toolName',
  'toolResult',
  'toolUseId',
  'toolUseResult',
  'transcriptAnchorId',
  'usage',
  'workflow',
  'workflowName',
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
  | { ok: true; message: NormalizedMessage; strippedKeys: string[]; contractViolations: string[] }
  | { ok: false; reason: string };

/**
 * Faults that are worth naming but not worth dropping a message over.
 *
 * A transcript row whose id was invented at emit time is a real defect — the
 * client cannot match it against the persisted copy, which is how the same
 * message ends up rendered twice — but withholding the row would turn a
 * duplicate into a missing reply. So it travels, and it is named.
 */
function collectContractViolations(record: Record<string, unknown>): string[] {
  const violations: string[] = [];
  const kind = String(record.kind);
  const id = typeof record.id === 'string' ? record.id : '';

  if (TRANSCRIPT_ROW_KIND_SET.has(kind)) {
    if (!id) {
      violations.push(`a ${kind} row carries no id; it must be derived from the engine's own record`);
    } else if (isVolatileMessageId(id)) {
      violations.push(
        `a ${kind} row carries a generated id (${id}); a persisted row must reuse the engine's own `
        + 'identifier so the live copy and the history copy match',
      );
    }
  }

  return violations;
}

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
  if ('seq' in record && !isValidReplaySeq(record.seq)) {
    return { ok: false, reason: 'invalid `seq`' };
  }
  if ('streamEpoch' in record && !isValidStreamEpoch(record.streamEpoch)) {
    return { ok: false, reason: 'invalid `streamEpoch`' };
  }

  const contractViolations = collectContractViolations(record);
  const strippedKeys = Object.keys(record).filter((key) => !KNOWN_KEYS.has(key));
  if (strippedKeys.length === 0) {
    return { ok: true, message: record as NormalizedMessage, strippedKeys, contractViolations };
  }

  const message = { ...record };
  for (const key of strippedKeys) {
    delete message[key];
  }
  return { ok: true, message: message as NormalizedMessage, strippedKeys, contractViolations };
}
