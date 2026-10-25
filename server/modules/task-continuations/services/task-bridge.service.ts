/**
 * The bridge between a resident Codex process and the host's task routes.
 *
 * A resident app-server keeps one process for many rounds, so the per-round
 * capability cannot live in its environment: the process would keep the
 * first round's authority for as long as it lives. The process instead
 * carries a narrow session credential, and every call it makes is matched
 * against the engine call the host observed.
 *
 * The credential alone can do nothing. It names a session, not a run: the
 * authority for a call comes from the observed engine call, which carries
 * the round that made it. A call that the engine never made — or one that
 * belongs to a round that is over — is refused.
 */

import crypto from 'node:crypto';

import { hashToken } from '@/modules/task-continuations/services/task-token.service.js';
import { AppError, canonicalizeJson, readObjectRecord, sha256Hex } from '@/shared/utils.js';
import type { TaskBridgeCredentialContext, TaskBridgeEngineCall } from '@/shared/types.js';
import { resolveTaskRunCapability } from '@/modules/task-continuations/services/task-run-context.service.js';
import { areTaskContinuationsEnabled } from '@/modules/task-continuations/task-continuations.config.js';

/** How long a bridge credential stays valid. */
const TASK_BRIDGE_CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1000;

/** How many sessions may hold a bridge credential at the same time. */
const MAX_ACTIVE_TASK_BRIDGE_CREDENTIALS = 64;

/** How many observed engine calls are remembered. */
const MAX_OBSERVED_TASK_BRIDGE_CALLS = 512;

/** How long an observed call stays matchable. */
const OBSERVED_TASK_BRIDGE_CALL_TTL_MS = 60 * 60 * 1000;

/** How long a bridge call waits for the engine's own event to arrive. */
const BRIDGE_CALL_MATCH_TIMEOUT_MS = 5_000;

/** Private snapshot: retain a digest rather than caller-mutable arguments. */
type ObservedTaskBridgeCall = Omit<TaskBridgeEngineCall, 'arguments'> & {
  argumentsDigest: string;
  observedAt: number;
};

type ActiveTaskBridgeCredential = {
  context: TaskBridgeCredentialContext;
  expiresAt: number;
};

const activeCredentials = new Map<string, ActiveTaskBridgeCredential>();
const observedCalls = new Map<string, ObservedTaskBridgeCall>();

/** The key an observed call is stored under. */
function callKey(appSessionId: string, callId: string, generation: number): string {
  return JSON.stringify([appSessionId, generation, callId]);
}

function pruneExpiredCredentials(now = Date.now()): void {
  for (const [hash, credential] of activeCredentials) {
    if (credential.expiresAt <= now) {
      activeCredentials.delete(hash);
    }
  }
}

function pruneExpiredCalls(now = Date.now()): void {
  for (const [key, call] of observedCalls) {
    if (call.observedAt + OBSERVED_TASK_BRIDGE_CALL_TTL_MS <= now) {
      observedCalls.delete(key);
    }
  }
}

/**
 * Issues the narrow credential a resident process carries.
 *
 * The raw token is returned once for the app-server's isolated MCP
 * environment; only its digest stays in the host process.
 */
export function createTaskBridgeCredential(context: TaskBridgeCredentialContext): {
  token: string;
  expiresAt: number;
} {
  if ((typeof context.userId !== 'string' && !Number.isSafeInteger(context.userId))
    || String(context.userId ?? '').trim() === ''
    || !context.appSessionId.trim()
    || !Number.isSafeInteger(context.generation) || context.generation < 0) {
    throw new AppError('Task bridge context is invalid.', { code: 'INVALID_TASK_BRIDGE_CONTEXT', statusCode: 400 });
  }
  pruneExpiredCredentials();
  if (activeCredentials.size >= MAX_ACTIVE_TASK_BRIDGE_CREDENTIALS) {
    throw new AppError('Too many active task bridge credentials.', {
      code: 'TASK_BRIDGE_CAPACITY',
      statusCode: 503,
    });
  }

  const token = `tbc_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = Date.now() + TASK_BRIDGE_CREDENTIAL_TTL_MS;
  activeCredentials.set(hashToken(token), {
    context: Object.freeze({ ...context }),
    expiresAt,
  });
  return { token, expiresAt };
}

/** Resolves an active bridge credential without disclosing it on failure. */
export function resolveTaskBridgeCredential(token: string): TaskBridgeCredentialContext | null {
  if (!token) {
    return null;
  }
  pruneExpiredCredentials();
  const entry = activeCredentials.get(hashToken(token));
  return entry ? { ...entry.context } : null;
}

/** Revokes a bridge credential, for example when its process is replaced. */
export function revokeTaskBridgeCredential(token: string): boolean {
  if (!token) {
    return false;
  }
  return activeCredentials.delete(hashToken(token));
}

/**
 * Records one MCP tool call the engine made.
 *
 * The host learns about a call from the engine's own item stream, which
 * carries the call's id. A bridge call that arrives before this record does
 * waits for it, because the two travel on different channels.
 */
export function registerTaskBridgeCall(call: TaskBridgeEngineCall): void {
  if (!call.appSessionId.trim() || !call.threadId.trim() || !call.callId.trim()
    || !call.server.trim() || !call.tool.trim() || !call.runToken.trim()) {
    throw new AppError('Engine call identity is invalid.', { code: 'INVALID_TASK_BRIDGE_CALL', statusCode: 400 });
  }
  if (!Number.isSafeInteger(call.generation) || call.generation < 1 || !readObjectRecord(call.arguments)) {
    throw new AppError('Engine call snapshot is invalid.', { code: 'INVALID_TASK_BRIDGE_CALL', statusCode: 400 });
  }
  pruneExpiredCalls();
  if (!observedCalls.has(callKey(call.appSessionId, call.callId, call.generation))
    && observedCalls.size >= MAX_OBSERVED_TASK_BRIDGE_CALLS) {
    const oldest = [...observedCalls.entries()].sort((a, b) => a[1].observedAt - b[1].observedAt)[0];
    if (oldest) {
      observedCalls.delete(oldest[0]);
    }
  }
  const { arguments: args, ...identity } = call;
  const key = callKey(call.appSessionId, call.callId, call.generation);
  const snapshot = { ...identity, argumentsDigest: sha256Hex(JSON.stringify(canonicalizeJson(args))), observedAt: Date.now() };
  const previous = observedCalls.get(key);
  if (previous) {
    if (previous.generation !== snapshot.generation || previous.threadId !== snapshot.threadId
      || previous.turnId !== snapshot.turnId || previous.server !== snapshot.server
      || previous.tool !== snapshot.tool || previous.runToken !== snapshot.runToken
      || previous.argumentsDigest !== snapshot.argumentsDigest) {
      throw new AppError('Engine call identity was reused with a different snapshot.', { code: 'TASK_BRIDGE_CALL_MISMATCH', statusCode: 403 });
    }
    return;
  }
  observedCalls.set(key, snapshot);
}

/** The observed call a bridge call names, when the engine made it. */
export function resolveTaskBridgeCall(
  appSessionId: string,
  callId: string,
  generation: number,
): ObservedTaskBridgeCall | null {
  pruneExpiredCalls();
  return observedCalls.get(callKey(appSessionId, callId, generation)) ?? null;
}

/**
 * Waits for the engine's own record of a call.
 *
 * The bridge call travels over HTTP and the engine's item over the
 * app-server's stdout, so the bridge call can arrive first. The wait is
 * bounded: a call the engine never announced is refused.
 */
export async function waitForTaskBridgeCall(
  appSessionId: string,
  callId: string,
  generation: number,
  timeoutMs = BRIDGE_CALL_MATCH_TIMEOUT_MS,
): Promise<ObservedTaskBridgeCall | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const call = resolveTaskBridgeCall(appSessionId, callId, generation);
    if (call) {
      return call;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Drops the observed calls of a session, for example when it is deleted. */
export function clearTaskBridgeCalls(appSessionId: string): void {
  for (const [key, call] of observedCalls) {
    if (call.appSessionId === appSessionId) {
      observedCalls.delete(key);
    }
  }
}

/** Used by the bridge route to verify the native snapshot before any task operation. */
export async function authorizeTaskBridgeCall(input: {
  credential: TaskBridgeCredentialContext;
  identity: { callId: string; threadId: string; turnId: string };
  tool: string;
  arguments: Record<string, unknown>;
}) {
  const { credential, identity } = input;
  // With the switch off no round carries a run token, so the engine's calls
  // are never recorded: waiting for one would only end in a refusal that
  // hides the real reason.
  if (!areTaskContinuationsEnabled()) {
    throw new AppError('Asynchronous task tools are disabled by the CloudCLI continuation setting.', {
      code: 'TASK_CONTINUATIONS_DISABLED',
      statusCode: 409,
    });
  }
  const observed = await waitForTaskBridgeCall(credential.appSessionId, identity.callId, credential.generation);
  if (!observed) throw new AppError('The engine did not announce this call.', { code: 'TASK_BRIDGE_CALL_UNKNOWN', statusCode: 403 });
  if (observed.generation !== credential.generation || observed.threadId !== identity.threadId
    || observed.turnId !== identity.turnId || observed.tool !== input.tool
    || observed.server !== 'cloudcli_task_continuations'
    || observed.argumentsDigest !== sha256Hex(JSON.stringify(canonicalizeJson(input.arguments)))) {
    throw new AppError('The call does not match the engine call that was announced.', { code: 'TASK_BRIDGE_CALL_MISMATCH', statusCode: 403 });
  }
  const context = resolveTaskRunCapability(observed.runToken);
  if (!context) throw new AppError('The run that made this call is over.', { code: 'TASK_RUN_CONTEXT_INVALID', statusCode: 401 });
  if (String(context.userId) !== String(credential.userId) || context.sessionId !== credential.appSessionId
    || context.providerThreadId !== observed.threadId) {
    throw new AppError('The call does not belong to this session.', { code: 'TASK_BRIDGE_CALL_MISMATCH', statusCode: 403 });
  }
  const requestId = `bridge:${sha256Hex(JSON.stringify([
    credential.appSessionId, observed.generation, observed.threadId, observed.turnId, observed.callId,
  ]))}`;
  return { context, capabilityToken: observed.runToken, requestId };
}
