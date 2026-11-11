/**
 * ZCode Runtime Unit Tests
 *
 * Drives the runtime against a stub app-server engine (injected via
 * CLOUDCLI_ZCODE_ENGINE) that mirrors the bidirectional protocol: while
 * handling session/create it issues a server-initiated
 * session/requestRuntimePreferences request and only completes the create once
 * the client answers — the exact flow that deadlocked against engine 0.16.3
 * (-32022 after the engine's 15s window). The create-fail mode verifies that
 * session/create failures reach the chat stream as error messages instead of
 * dying silently before the run's error reporting.
 */

import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

import { protocolClient } from '../list/zcode/zcode-protocol.client.js';
import { ZCODE_CANCELLED_NOTICE, ZCODE_CANCELLED_NOTICE_KEY } from '../list/zcode/zcode-live-event-normalizer.js';
import { ZCodeRuntimeProvider, zcodeRuntimePermissions } from '../list/zcode/zcode-runtime.provider.js';
import { ZCodeSessionsProvider } from '../list/zcode/zcode-sessions.provider.js';

const stubDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'zcode-stub-'));
const stubPath = path.join(stubDir, 'zcode-stub.cjs');
const modeFilePath = path.join(stubDir, 'mode.txt');
const logFilePath = path.join(stubDir, 'stub-log.jsonl');

// The engine's behavior mode is read from a file per session/create so both
// test cases can share one long-lived app-server subprocess.
const stubScript = `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');

const modeFile = process.env.ZCODE_STUB_MODE_FILE;
const logFile = process.env.ZCODE_STUB_LOG;
// Resume-driven runs address a different engine session id than create does,
// and every emitted event carries this id — so it must follow the id the
// client resumed with or the runtime filters the turn events out.
let sessionId = 'sess_stub_1';
// Mirrors engine 0.17.1: a created session's row is written only when its
// first input arrives through the legacy session/send; a sendText command on
// a session never written fails its foreign key. A resumed session comes
// from the database — unless this engine created it and it was never
// written, in which case resume just reattaches the in-memory session.
const createdSessions = new Set();
const writtenSessions = new Set();

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const log = (name, value) => {
  try { fs.appendFileSync(logFile, JSON.stringify({ name, value }) + '\\n'); } catch {}
};
// The stub log outlives the test run; never write the API key that the send
// params carry in modelExecution.requestAuth.
const redactSendParams = (params) => {
  const { modelExecution, ...rest } = params ?? {};
  return modelExecution
    ? { ...rest, modelExecution: { ...modelExecution, requestAuth: '<redacted>' } }
    : rest;
};
const readMode = () => {
  try { return fs.readFileSync(modeFile, 'utf8').trim(); } catch { return 'ok'; }
};

let pendingCreateId = null;
const finishCreate = () => {
  if (pendingCreateId === null) return;
  send({ id: pendingCreateId, result: { sessionId } });
  pendingCreateId = null;
};

// mode "abort-ok": streams until a session/stop arrives, which both answers
// and ends the turn — mirroring an engine that honors a delivered stop.
let abortTicker = null;
// The input id of the turn abort-ok is streaming, so its cancellation can be
// reported under the same id, as the real engine does.
let abortInputId = null;

// mode "cancel-echo": like abort-ok, but after confirming the stop the engine
// echoes the cancelled model request as a turn.failed — what real engines do.
let cancelEchoTicker = null;

// The serialized cancelled-request failure real adapter errors carry
// (name + data.message/code/turnResult), as a live turn.failed.
const cancelledTurnFailed = {
  method: 'session/event',
  params: {
    sessionId,
    type: 'turn.failed',
    payload: {
      error: {
        name: 'AiSdkModelAdapterError',
        data: {
          message: 'Model request was cancelled.',
          code: 'model_request_cancelled',
          turnResult: 'cancelled',
        },
      },
    },
  },
};

// mode "perm-bridge": after session/send, mirrors the engine's blocking
// permission flow — one interaction/requestPermission server request whose
// answer releases the turn. The second announcement with a fresh protocol id
// but the same requestId mirrors the engine's periodic re-announce.
let permPending = 0;

const e2ePermissionParams = {
  requestId: 'perm_e2e_1',
  sessionId,
  toolCallId: 'call_e2e_1',
  toolName: 'Bash',
  input: { command: 'rm /tmp/y' },
  reason: 'Tool Bash requires approval',
  riskLevel: 'high',
};

// A REUSED requestId whose call content differs — the decision cache must not
// answer it with the recorded decision from the earlier request.
const conflictParamsA = {
  requestId: 'perm_conflict_1',
  sessionId,
  toolCallId: 'call_conflict_a',
  toolName: 'Bash',
  input: { command: 'rm /tmp/a' },
  reason: 'Tool Bash requires approval',
  riskLevel: 'high',
};
const conflictParamsB = {
  ...conflictParamsA,
  toolCallId: 'call_conflict_b',
  input: { command: 'rm /tmp/b' },
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // The runtime drives turns through v4 commands. Translate the two it uses
  // into the legacy handlers below so every mode serves both shapes; the
  // command envelope rides along for the acknowledgement. A raw legacy
  // send or stop is logged so tests can prove the runtime no longer uses it.
  if (msg.method === 'v4/command') {
    const envelope = msg.params ?? {};
    log('v4_command', { ...envelope, payload: redactSendParams(envelope.payload) });
    if (envelope.type === 'sendText') {
      msg = { id: msg.id, method: 'session/send', v4: envelope, params: { sessionId: envelope.sessionId, ...(envelope.payload ?? {}) } };
    } else if (envelope.type === 'stop') {
      msg = { id: msg.id, method: 'session/stop', v4: envelope, params: { sessionId: envelope.sessionId } };
    }
  } else if (msg.method === 'session/send' || msg.method === 'session/stop') {
    log('legacy_' + msg.method.slice('session/'.length), msg.params);
  }

  // Responses to our server-initiated requests carry no method.
  if (msg.method === undefined) {
    if (msg.id === 'server-1') {
      log('prefs_response', msg);
      finishCreate();
    }
    if ((msg.id === 'server-perm' || msg.id === 'server-perm2') && permPending > 0) {
      log('perm_answer', msg);
      permPending -= 1;
      if (permPending === 0) {
        send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'ran it' } } });
        send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
      }
    }
    if (msg.id === 'server-perm-bg') {
      log('perm_answer', msg);
      send({ method: 'session/event', params: { sessionId, type: 'subagent_stopped', payload: { agentId: 'agent_bg_1', agentType: 'general-purpose', background: true, childSessionId: 'sess_subagent_agent_bg_1', parentToolCallId: 'call_agent_bg', status: 'completed', totalDurationMs: 10, totalToolUseCount: 1, totalTokens: 5 } } });
    }
    if (msg.id === 'server-perm-e2e') {
      log('perm_answer', msg);
      // Late re-announcement of the SAME business requestId under a fresh
      // protocol id, racing the just-recorded decision — mirrors the engine's
      // periodic re-announce. The turn completes right after so the runtime's
      // run-scoped writer is still installed when it arrives.
      send({ id: 'server-perm-e2e-late', method: 'interaction/requestPermission', params: e2ePermissionParams });
      send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'e2e done' } } });
      send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
    }
    if (msg.id === 'server-perm-e2e-late') {
      log('perm_answer', msg);
    }
    if (msg.id === 'server-perm-conflict') {
      log('perm_answer', msg);
      // Same requestId, different call content: a genuinely new request that
      // must be surfaced and decided on its own.
      send({ id: 'server-perm-conflict-b', method: 'interaction/requestPermission', params: conflictParamsB });
      send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'conflict done' } } });
      send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
    }
    if (msg.id === 'server-perm-conflict-b') {
      log('perm_answer', msg);
    }
    return;
  }

  // mode "handover-window": answers session/subscribe only after emitting a
  // text delta and the stop of the background agent an earlier turn left
  // running, so both land while the runtime is still setting a new run up —
  // between its start and the moment it sends the prompt.
  // mode "slow-subscribe": the run is still setting up when the user stops.
  if (msg.method === 'session/subscribe' && readMode() === 'slow-subscribe') {
    setTimeout(() => send({ id: msg.id, result: {} }), 300);
    return;
  }

  if (msg.method === 'session/subscribe' && readMode() === 'handover-window') {
    const ev = (type, payload) => send({ method: 'session/event', params: { sessionId, type, payload } });
    ev('model_streaming', { kind: 'text_delta', delta: 'window text' });
    ev('subagent_stopped', { agentId: 'agent_bg_1', agentType: 'general-purpose', background: true, childSessionId: 'sess_subagent_agent_bg_1', parentToolCallId: 'call_agent_bg', status: 'completed', totalDurationMs: 1500, totalToolUseCount: 2, totalTokens: 300 });
    // A turn-ending event of the earlier turn, straggling in.
    ev('turn_complete', { usage: { inputTokens: 1, outputTokens: 1 } });
    send({ id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/create') {
    // A create always starts a fresh engine session: reset the event session
    // id a previous resume-driven test may have changed.
    sessionId = 'sess_stub_1';
    createdSessions.add(sessionId);
    writtenSessions.delete(sessionId);
    // ZCode 0.16.9 validates create params strictly and no longer accepts the
    // runtimeModel catalog here. Keep this boundary aligned with the real
    // engine so a provider upgrade cannot silently reintroduce the breakage.
    for (const key of Object.keys(msg.params ?? {})) {
      if (key !== 'workspace') {
        send({ id: msg.id, error: { code: -32602, message: 'Invalid params — (root): Unrecognized key: "' + key + '"' } });
        return;
      }
    }
    log('session_create', msg.params);
    if (readMode() === 'create-fail') {
      send({ id: msg.id, error: { code: -32022, message: 'Client request timed out: session/requestRuntimePreferences', data: { timeoutMs: 15000 } } });
      return;
    }
    // Mirror the real engine: ask the client for runtime preferences while
    // the create is still pending, and only finish once it answers.
    pendingCreateId = msg.id;
    send({ id: 'server-1', method: 'session/requestRuntimePreferences', params: { sessionId, scope: 'runtime-materialization' } });
    return;
  }

  if (msg.method === 'session/send') {
    log('session_send_attempt', redactSendParams(msg.params));
    // Mirror the engine's strict schemas: unknown keys are rejected. The
    // legacy send carries content, the sendText payload carries text.
    const allowedKeys = msg.v4
      ? ['sessionId', 'text', 'attachments', 'modelSelection', 'modelExecution', 'requestedDelivery', 'heldQueueDisposition']
      : ['sessionId', 'content', 'inputId', 'attachments', 'modelSelection', 'modelExecution'];
    for (const key of Object.keys(msg.params ?? {})) {
      if (!allowedKeys.includes(key)) {
        send({ id: msg.id, error: { code: -32602, message: 'Invalid params — (root): Unrecognized key: "' + key + '"' } });
        return;
      }
    }
    const commandId = msg.v4 ? msg.v4.commandId : undefined;
    if (!msg.v4 && readMode() === 'legacy-send-fail') {
      send({ id: msg.id, error: { code: -32010, message: 'legacy send refused' } });
      return;
    }
    if (msg.v4 && !writtenSessions.has(sessionId)) {
      send({ id: msg.id, result: { commandId, status: 'failed', message: 'FOREIGN KEY constraint failed', revisionAtDecision: 0 } });
      return;
    }
    writtenSessions.add(sessionId);
    log('session_send', redactSendParams(msg.params));
    // The id the engine copies onto the turn it starts for this input.
    const inputId = msg.v4 ? commandId : msg.params.inputId;
    const acceptSend = () => send({ id: msg.id, result: msg.v4
      ? { commandId, status: 'accepted', revisionAtDecision: 1, result: { type: 'inputAccepted', delivery: 'startNow', inputId: commandId } }
      : {} });
    if (readMode() === 'send-rejected') {
      // The engine refuses the input outright; no turn starts.
      send({ id: msg.id, result: { commandId, status: 'rejected', reasonCode: 'fault.command.inputRejected', message: 'input rejected by engine', revisionAtDecision: 1 } });
      return;
    }
    if (readMode() === 'slow-ack') {
      // The engine is still winding a preempted turn down: the send is only
      // acknowledged a moment later, and the prompt's turn starts after that.
      setTimeout(() => {
        log('send_acked', inputId);
        acceptSend();
        abortInputId = inputId;
        send({ method: 'session/event', params: { sessionId, turnId: 'turn_abort', type: 'turn.started', payload: { inputId } } });
        abortTicker = setInterval(() => {
          send({ method: 'session/event', params: { sessionId, turnId: 'turn_abort', type: 'model.streaming', payload: { kind: 'text_delta', delta: 'streaming' } } });
        }, 100);
      }, 300);
      return;
    }
    if (readMode() === 'early-fail') {
      // The turn fails before announcing itself: its failure names the turn
      // but carries no input id.
      acceptSend();
      send({ method: 'session/event', params: { sessionId, turnId: 'turn_early', type: 'turn.failed', payload: { error: { message: 'model config missing' } } } });
      return;
    }
    if (readMode() === 'preempt') {
      // The engine is running a turn it started itself from a queued
      // background notification. startNow cancels it first — its terminal
      // events reach the stream before the send is even acknowledged — and
      // only then starts the user's turn, tagged with the command id.
      const ev = (type, turnId, payload) => send({ method: 'session/event', params: { sessionId, turnId, type, payload } });
      ev('model.streaming', 'turn_bg', { kind: 'text_delta', delta: 'notification work' });
      ev('turn.failed', 'turn_bg', { error: { name: 'AiSdkModelAdapterError', data: { message: 'Model request was cancelled.', code: 'model_request_cancelled', turnResult: 'cancelled' } } });
      ev('turn.completed', 'turn_bg', { resultType: 'cancelled', inputId: 'bg_input_1' });
      ev('turn.started', 'turn_user', { inputId });
      acceptSend();
      setTimeout(() => {
        ev('model.streaming', 'turn_user', { kind: 'text_delta', delta: 'user reply' });
        ev('turn.completed', 'turn_user', { resultType: 'success', inputId, usage: { inputTokens: 3, outputTokens: 4 } });
      }, 150);
      return;
    }
    acceptSend();
    if (readMode() === 'tool-results') {
      const notify = (payload) => send({ method: 'session/event', params: { sessionId, type: 'tool.updated', payload } });
      notify({ kind: 'scheduled', toolCallId: 'call_live_bash', toolName: 'Bash', input: { command: 'ls' } });
      notify({ kind: 'scheduled', toolCallId: 'call_live_read', toolName: 'Read', input: { path: 'missing.txt' } });
      // Results can arrive in reverse call order, and after the result event
      // the next model segment starts before the turn finally completes.
      notify({ kind: 'error', toolCallId: 'call_live_read', error: 'File not found' });
      notify({ kind: 'result', toolCallId: 'call_live_bash', result: { success: true, content: 'a.txt' } });
      send({ method: 'session/event', params: { sessionId, type: 'model.streaming', payload: { kind: 'text_delta', delta: 'done' } } });
      send({ method: 'session/event', params: { sessionId, type: 'turn.completed', payload: {} } });
      return;
    }
    if (readMode() === 'send-fail') {
      send({ method: 'session/event', params: { sessionId, type: 'turn.failed', payload: { error: { message: 'provider auth failed', attribution: { statusCode: 401, reason: 'auth_failed' } } } } });
      return;
    }
    if (readMode() === 'subagent-run-crash') {
      // The engine dies while a turn is still in flight with an agent running.
      const ev = (type, payload) => send({ method: 'session/event', params: { sessionId, type, payload } });
      const agent = { agentId: 'agent_run_1', agentType: 'general-purpose', background: false, childSessionId: 'sess_subagent_agent_run_1', parentToolCallId: 'call_agent_run' };
      ev('model_streaming', { kind: 'tool_call', toolCallId: 'call_agent_run', toolName: 'Agent', input: { description: 'Audit', prompt: 'look', subagent_type: 'general-purpose' } });
      ev('subagent_spawned', { ...agent, description: 'Audit', prompt: 'look', status: 'running' });
      setTimeout(() => process.exit(1), 100);
      return;
    }
    if (readMode() === 'handover-window') {
      send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'hi there' } } });
      send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
      return;
    }
    if (readMode() === 'subagent-bg' || readMode() === 'subagent-bg-crash' || readMode() === 'subagent-bg-permission' || readMode().startsWith('subagent-bg-permission-orphan')) {
      // A background agent: the engine announces the Agent call, reports the
      // spawn on the parent session once the child is ready, returns the
      // launch acknowledgement as the tool result and ends the turn. The
      // agent keeps working and reports its stop well after the turn settled
      // — or, in the crash variant, the engine dies with the agent still
      // running and never reports.
      const crash = readMode() === 'subagent-bg-crash';
      const asksPermission = readMode() === 'subagent-bg-permission' || readMode().startsWith('subagent-bg-permission-orphan');
      const orphansPermission = readMode().startsWith('subagent-bg-permission-orphan');
      // A resumed agent's requests name the SendMessage call that woke it,
      // not the Agent call its stop is reported on.
      const askingCallId = readMode() === 'subagent-bg-permission-orphan-resumed' ? 'call_send_resume' : 'call_agent_bg';
      const ev = (type, payload) => send({ method: 'session/event', params: { sessionId, type, payload } });
      const agent = { agentId: 'agent_bg_1', agentType: 'general-purpose', background: true, childSessionId: 'sess_subagent_agent_bg_1', parentToolCallId: 'call_agent_bg' };
      ev('model_streaming', { kind: 'tool_call', toolCallId: 'call_agent_bg', toolName: 'Agent', input: { description: 'Review the fix', prompt: 'look', run_in_background: true, subagent_type: 'general-purpose' } });
      ev('subagent_spawned', { ...agent, description: 'Review the fix', prompt: 'look', status: 'running' });
      ev('model_streaming', { kind: 'tool_result', toolCallId: 'call_agent_bg', result: { success: true, content: 'Async agent launched successfully.\\nagentId: agent_bg_1' } });
      ev('turn_complete', { usage: { inputTokens: 3, outputTokens: 4 } });
      setTimeout(() => {
        if (crash) {
          process.exit(1);
        }
        if (asksPermission) {
          // The engine rewrites a subagent's request to the PARENT session id
          // and tags it with the subagent as its origin; the parent turn is
          // over by now.
          send({ id: 'server-perm-bg', method: 'interaction/requestPermission', params: {
            requestId: readMode() === 'subagent-bg-permission-orphan-resumed' ? 'perm_bg_resumed' : orphansPermission ? 'perm_bg_orphan' : 'perm_bg_1', sessionId, toolCallId: 'call_child_bash', toolName: 'Bash',
            input: { command: 'touch /tmp/bg' }, reason: 'Tool Bash requires approval', riskLevel: 'medium',
            origin: { kind: 'subagent', agentId: 'agent_bg_1', agentType: 'general-purpose', description: 'Review the fix', childSessionId: 'sess_subagent_agent_bg_1', parentSessionId: sessionId, parentToolCallId: askingCallId },
          } });
          if (orphansPermission) {
            // The agent ends while its request is still unanswered.
            setTimeout(() => ev('subagent_stopped', { ...agent, status: 'stopped', totalDurationMs: 10 }), 200);
          }
          return;
        }
        ev('subagent_stopped', { ...agent, status: 'completed', totalDurationMs: 1500, totalToolUseCount: 2, totalTokens: 300 });
      }, 400);
      return;
    }
    if (readMode() === 'perm-bridge') {
      // The turn blocks on a permission server request until answered.
      permPending = 2;
      const permissionParams = {
        requestId: 'perm_test_1',
        sessionId,
        toolCallId: 'call_perm_1',
        toolName: 'Bash',
        input: { command: 'touch /tmp/x' },
        reason: 'Tool Bash requires approval',
        riskLevel: 'medium',
      };
      send({ id: 'server-perm', method: 'interaction/requestPermission', params: permissionParams });
      send({ id: 'server-perm2', method: 'interaction/requestPermission', params: permissionParams });
      return;
    }
    if (readMode() === 'perm-e2e') {
      send({ id: 'server-perm-e2e', method: 'interaction/requestPermission', params: e2ePermissionParams });
      return;
    }
    if (readMode() === 'perm-e2e-conflict') {
      send({ id: 'server-perm-conflict', method: 'interaction/requestPermission', params: conflictParamsA });
      return;
    }
    if (readMode() === 'silent') {
      send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'going quiet' } } });
      // Wakes well after the runtime's silence window handed the run to the
      // background watcher, proving late output still streams to the client.
      setTimeout(() => {
        send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'late wake' } } });
        send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
      }, 1600);
      return;
    }
    if (readMode() === 'steady') {
      // Continuous activity: every delta must reset the silence window so the
      // run survives several windows' worth of wall-clock time and completes
      // normally instead of tripping the watchdog.
      let ticks = 0;
      const ticker = setInterval(() => {
        ticks += 1;
        send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'tick ' + ticks } } });
        if (ticks >= 6) {
          clearInterval(ticker);
          send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
        }
      }, 400);
      return;
    }
    if (readMode() === 'abort-ok') {
      // Streams until a session/stop arrives (see the stop handler above),
      // mirroring an engine that honors a delivered stop.
      abortInputId = inputId;
      send({ method: 'session/event', params: { sessionId, turnId: 'turn_abort', type: 'turn.started', payload: { inputId } } });
      abortTicker = setInterval(() => {
        send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'streaming' } } });
      }, 200);
      return;
    }
    if (readMode() === 'cancel-echo') {
      // Streams until a session/stop arrives (see the stop handler above),
      // then echoes the cancelled-turn failure the way real engines do.
      cancelEchoTicker = setInterval(() => {
        send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'streaming' } } });
      }, 200);
      return;
    }
    if (readMode() === 'cancel-unprompted') {
      // The engine cancels the turn on its own — no stop was ever requested.
      send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'starting' } } });
      setTimeout(() => send(cancelledTurnFailed), 200);
      return;
    }
    if (readMode() === 'stop-fail') {
      // Keeps streaming through the refused stop attempts so the run stays
      // alive; the turn only completes when the engine's own work is done.
      let ticks = 0;
      const ticker = setInterval(() => {
        ticks += 1;
        send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'tick ' + ticks } } });
        if (ticks >= 12) {
          clearInterval(ticker);
          // Something other than the refused stop cancels the turn in the
          // end (another client, the engine itself).
          send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { resultType: 'cancelled', usage: { inputTokens: 3, outputTokens: 4 } } } });
        }
      }, 300);
      return;
    }
    if (readMode() === 'crash') {
      // Mirrors an engine process death mid-turn: acknowledge the send, emit
      // one live delta, then die. The supervisor must synthesize
      // zcode:session/lost so the run fails fast instead of timing out.
      send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'about to die' } } });
      setTimeout(() => process.exit(1), 100);
      return;
    }
    send({ method: 'session/event', params: { sessionId, type: 'model_streaming', payload: { kind: 'text_delta', delta: 'hi there' } } });
    send({ method: 'session/event', params: { sessionId, type: 'turn_complete', payload: { usage: { inputTokens: 3, outputTokens: 4 } } } });
    return;
  }

  if (msg.method === 'session/resume') {
    if (readMode() === 'resume-fail') {
      send({ id: msg.id, error: { code: -32004, message: 'Session is not active: ' + (msg.params?.sessionId ?? '') } });
      return;
    }
    // Real resume responses carry settings.model; "current" is present exactly
    // when the engine kept a usable session model selection after its restore
    // validation. The resume-no-selection modes mirror a session whose stored
    // selection was silently dropped (cross-registry resume).
    const noSelection = readMode() === 'resume-no-selection' || readMode() === 'resume-no-selection-setmodel-fail';
    sessionId = (msg.params && msg.params.sessionId) || sessionId;
    if (!createdSessions.has(sessionId)) writtenSessions.add(sessionId);
    send({
      id: msg.id,
      result: {
        messages: [],
        settings: {
          model: {
            available: [],
            ...(noSelection ? {} : { current: { providerId: 'bigmodel-coding-plan', modelId: readMode() === 'resume-matching-selection' ? 'GLM-5.3' : 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } } }),
          },
        },
      },
    });
    return;
  }

  if (msg.method === 'session/stop') {
    log('stop', msg.params);
    if (abortTicker) { clearInterval(abortTicker); abortTicker = null; }
    if (cancelEchoTicker) { clearInterval(cancelEchoTicker); cancelEchoTicker = null; }
    const stopCommandId = msg.v4 ? msg.v4.commandId : undefined;
    if (readMode() === 'stop-fail') {
      send({ id: msg.id, result: { commandId: stopCommandId, status: 'rejected', reasonCode: 'guard.stopTargetChanged', message: 'stop refused', revisionAtDecision: 1 } });
      return;
    }
    if ((readMode() === 'abort-ok' || readMode() === 'slow-ack') && abortInputId) {
      // The real engine stops the turn synchronously: the cancelled turn's
      // completion reaches the stream before the stop is acknowledged.
      send({ method: 'session/event', params: { sessionId, turnId: 'turn_abort', type: 'turn.completed', payload: { resultType: 'cancelled', inputId: abortInputId } } });
      abortInputId = null;
    }
    send({ id: msg.id, result: msg.v4 ? { commandId: stopCommandId, status: 'accepted', revisionAtDecision: 1 } : {} });
    if (readMode() === 'cancel-echo') {
      // Delayed so the runtime records the delivered stop before the failure
      // echo arrives, the way separate engine messages do in production.
      setTimeout(() => send(cancelledTurnFailed), 100);
    }
    return;
  }

  if (msg.method === 'session/setModel') {
    log('setModel', msg.params);
    if (readMode() === 'resume-no-selection-setmodel-fail') {
      send({ id: msg.id, error: { code: -32603, message: 'setModel refused' } });
      return;
    }
    send({ id: msg.id, result: {} });
    return;
  }

  // subscribe / setMode / stop / anything else: empty success.
  send({ id: msg.id, result: {} });
});
`;

fsSync.writeFileSync(stubPath, stubScript);
fsSync.writeFileSync(modeFilePath, 'ok\n');
fsSync.writeFileSync(logFilePath, '');

const cliConfigDir = path.join(stubDir, 'cli');
fsSync.mkdirSync(cliConfigDir, { recursive: true });
fsSync.writeFileSync(path.join(cliConfigDir, 'config.json'), JSON.stringify({
  provider: {
    'bigmodel-coding-plan': {
      kind: 'anthropic',
      options: {
        apiKey: 'test-api-key',
        baseURL: 'https://example.invalid/api/anthropic',
      },
      models: {
        'GLM-5.3': {
          reasoning: { enabled: true, levels: ['low', 'high', 'max'], defaultLevel: 'max' },
        },
      },
    },
  },
  model: 'bigmodel-coding-plan/GLM-5.3',
}));

process.env.CLOUDCLI_ZCODE_ENGINE = stubPath;
process.env.ZCODE_STUB_MODE_FILE = modeFilePath;
process.env.ZCODE_STUB_LOG = logFilePath;
process.env.ZCODE_STORAGE_DIR = stubDir;

// The runtime reads the session row (model/effort) via sessionsDb during a
// run, so the tests need a migrated app database. Without this the lazy
// connection falls back to the legacy working-directory shell database,
// which has no tables and fails every run with SQLITE_ERROR.
const runtimeTestDbPath = path.join(stubDir, 'auth.db');
fsSync.writeFileSync(runtimeTestDbPath, '');
process.env.DATABASE_PATH = runtimeTestDbPath;

before(async () => {
  await initializeDatabase();
});

const sessionsProvider = new ZCodeSessionsProvider();

const context: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'GLM-5.3' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

// A session the app already maps to an engine session: the run resumes it,
// so its prompt goes out as a sendText command.
const resumedContext: ProviderRuntimeContext = {
  ...context,
  resolveProviderSessionId: () => 'sess_stub_1',
};

const createWriter = (): { messages: NormalizedMessage[]; writer: ProviderRuntimeWriter } => {
  const messages: NormalizedMessage[] = [];
  const writer: ProviderRuntimeWriter = {
    userId: null,
    send: (data: unknown) => messages.push(data as NormalizedMessage),
    setSessionId: () => undefined,
  };
  return { messages, writer };
};

const readStubLog = (): Array<{ name: string; value: unknown }> =>
  fsSync.readFileSync(logFilePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { name: string; value: unknown });

after(async () => {
  closeConnection();
  await protocolClient.shutdown();
});

test('runtime completes a run when the engine asks for runtime preferences mid-create', async () => {
  fsSync.writeFileSync(modeFilePath, 'ok\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const result = await runtime.run('hello', { sessionId: 'app-sess-ok', cwd: stubDir }, writer, context);

  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  // The engine's server-initiated request was answered, unblocking create.
  const prefsResponse = readStubLog().find((entry) => entry.name === 'prefs_response');
  assert.ok(prefsResponse, 'engine must receive a response to its runtime preferences request');
  assert.deepEqual(prefsResponse.value, {
    id: 'server-1',
    result: { nativeSearchEnhancementsEnabled: false },
  });

  assert.equal(messages.filter((msg) => msg.kind === 'session_created').length, 1);
  const delta = messages.find((msg) => msg.kind === 'stream_delta');
  assert.equal(delta?.content, 'hi there');
  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.equal(complete?.tokens, 7);
});

test('runtime surfaces session/create failures as error messages', async () => {
  fsSync.writeFileSync(modeFilePath, 'create-fail\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  await assert.rejects(
    runtime.run('hello', { sessionId: 'app-sess-fail', cwd: stubDir }, writer, context),
    /Failed to create ZCode session/
  );

  const error = messages.find((msg) => msg.kind === 'error');
  assert.ok(error, 'session/create failure must reach the chat stream');
  assert.match(error.text ?? '', /Failed to create ZCode session/);
});

test('runtime reports turn.failed as an error and completes with a failing exit code', async () => {
  fsSync.writeFileSync(modeFilePath, 'send-fail\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  // Resolves (rather than throwing): the failure is carried by the error
  // message plus a complete with exitCode 1, matching the claude pattern.
  await runtime.run('hello', { sessionId: 'app-sess-sendfail', cwd: stubDir }, writer, context);

  const error = messages.find((msg) => msg.kind === 'error');
  assert.ok(error, 'turn.failed must surface as an error message');
  assert.equal(error.text, 'provider auth failed');
  assert.equal(error.content, 'provider auth failed');
  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.ok(complete, 'run must still terminate with a complete event');
  assert.equal(complete.exitCode, 1);
});

test('runtime configures model and reasoning effort variant', async () => {
  fsSync.writeFileSync(modeFilePath, 'ok\n');
  const runtime = new ZCodeRuntimeProvider();
  const { writer } = createWriter();

  await runtime.run('hello', {
    sessionId: 'app-sess-effort',
    model: 'GLM-5.3',
    effort: 'high',
    cwd: stubDir,
  }, writer, context);

  const setModelEntry = readStubLog().find((entry) => entry.name === 'setModel');
  assert.equal(setModelEntry, undefined, '0.16.9 selects the model on session/send, not session/setModel');

  const createEntry = readStubLog().filter((entry) => entry.name === 'session_create').at(-1);
  assert.deepEqual(createEntry?.value, {
    workspace: {
      workspacePath: stubDir,
      workspaceKey: stubDir,
    },
  });

  const sendAttempts = readStubLog().filter((entry) => entry.name === 'session_send_attempt');
  const latestSendAttempt = sendAttempts.at(-1)?.value as {
    runtimeModel?: unknown;
    modelSelection?: unknown;
    modelExecution?: unknown;
  } | undefined;
  assert.ok(latestSendAttempt, 'session/send must reach the engine');
  assert.equal(latestSendAttempt.runtimeModel, undefined);
  assert.deepEqual(latestSendAttempt.modelSelection, {
    providerId: 'bigmodel-coding-plan',
    modelId: 'GLM-5.3',
    options: { reasoningLevel: 'high' },
  });
  assert.deepEqual(latestSendAttempt.modelExecution, {
    selectionScope: 'execution',
    requestAuth: '<redacted>',
  });

  const acceptedSend = readStubLog().filter((entry) => entry.name === 'session_send').at(-1);
  const acceptedSendPayload = acceptedSend?.value as { modelSelection?: unknown } | undefined;
  assert.ok(acceptedSendPayload, 'strict-schema session/send must be accepted');
  assert.deepEqual(acceptedSendPayload.modelSelection, latestSendAttempt.modelSelection);
});

test('a new session\'s first prompt goes out through session/send, tagged with an input id', async () => {
  fsSync.writeFileSync(modeFilePath, 'preempt\n');
  fsSync.writeFileSync(logFilePath, '');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  // The engine writes a created session's row only on its first legacy send;
  // a sendText there would fail its foreign key.
  const result = await runtime.run('hello', { sessionId: 'app-sess-first', cwd: stubDir }, writer, context);
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  const legacySend = readStubLog().find((entry) => entry.name === 'legacy_send')?.value as
    { content?: unknown; inputId?: unknown } | undefined;
  assert.equal(legacySend?.content, 'hello');
  assert.equal(typeof legacySend?.inputId, 'string', 'the input id lets the run claim its turn');
  assert.equal(readStubLog().filter((entry) => entry.name === 'v4_command').length, 0);
  // The input id ties the turn to the run on this channel too.
  assert.ok(messages.some((msg) => msg.kind === 'stream_delta' && msg.content === 'user reply'));
  assert.equal(messages.find((msg) => msg.kind === 'complete')?.tokens, 7);
});

test('the prompt on an existing session goes out as a v4 sendText that takes over from engine-started turns', async () => {
  fsSync.writeFileSync(modeFilePath, 'ok\n');
  fsSync.writeFileSync(logFilePath, '');
  const runtime = new ZCodeRuntimeProvider();
  const { writer } = createWriter();

  await runtime.run('hello', { sessionId: 'app-sess-v4send', cwd: stubDir }, writer, resumedContext);

  const command = readStubLog().filter((entry) => entry.name === 'v4_command').at(-1)?.value as {
    type?: string;
    commandId?: unknown;
    clientId?: unknown;
    sessionId?: unknown;
    issuedAt?: unknown;
    payload?: Record<string, unknown>;
  } | undefined;
  assert.equal(command?.type, 'sendText');
  assert.equal(typeof command?.commandId, 'string');
  assert.equal(command?.clientId, 'cloudcli');
  assert.equal(command?.sessionId, 'sess_stub_1');
  assert.equal(typeof command?.issuedAt, 'number');
  assert.equal(command?.payload?.text, 'hello');
  // startNow cancels a turn the engine started from a queued background
  // notification instead of folding the prompt into it (where the legacy
  // send lost it); the notifications stay queued for later.
  assert.equal(command?.payload?.requestedDelivery, 'startNow');
  assert.equal(command?.payload?.heldQueueDisposition, 'keepQueueAndSend');
  assert.equal(readStubLog().filter((entry) => entry.name === 'legacy_send').length, 0, 'the legacy session/send must not be used');
});

test('a created session whose first prompt never went out keeps using session/send on the next run', async () => {
  fsSync.writeFileSync(modeFilePath, 'legacy-send-fail\n');
  const runtime = new ZCodeRuntimeProvider();

  await assert.rejects(
    runtime.run('hello', { sessionId: 'app-sess-unwritten', cwd: stubDir }, createWriter().writer, context),
    /legacy send refused/,
  );

  // The app now maps to the engine session, so the next run resumes it — but
  // the engine never wrote it, and a sendText there would fail its foreign key.
  fsSync.writeFileSync(modeFilePath, 'ok\n');
  fsSync.writeFileSync(logFilePath, '');
  const result = await runtime.run('hello again', { sessionId: 'app-sess-unwritten', cwd: stubDir }, createWriter().writer, resumedContext);
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });
  assert.equal(readStubLog().filter((entry) => entry.name === 'legacy_send').length, 1);
  assert.equal(readStubLog().filter((entry) => entry.name === 'v4_command').length, 0);

  // Once written, the session's prompts take the sendText channel.
  fsSync.writeFileSync(logFilePath, '');
  await runtime.run('third', { sessionId: 'app-sess-unwritten', cwd: stubDir }, createWriter().writer, resumedContext);
  assert.equal(readStubLog().filter((entry) => entry.name === 'legacy_send').length, 0);
});

test('a turn that fails before announcing itself still ends the run with its error', async () => {
  fsSync.writeFileSync(modeFilePath, 'early-fail\n');
  process.env.CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS = '1500';
  try {
    const runtime = new ZCodeRuntimeProvider();
    const { messages, writer } = createWriter();
    await runtime.run('hello', { sessionId: 'app-sess-earlyfail', cwd: stubDir }, writer, resumedContext);

    const error = messages.find((msg) => msg.kind === 'error');
    assert.equal(error?.text, 'model config missing', 'the failure must not be dropped as another turn\'s');
    assert.equal(messages.find((msg) => msg.kind === 'complete')?.exitCode, 1);
  } finally {
    delete process.env.CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS;
  }
});

test('a stop pressed while the prompt is still being admitted stops the prompt\'s own turn', async () => {
  fsSync.writeFileSync(modeFilePath, 'slow-ack\n');
  fsSync.writeFileSync(logFilePath, '');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const runPromise = runtime.run('hello', { sessionId: 'app-sess-slowack', cwd: stubDir }, writer, resumedContext);
  // Abort lands while the engine is still preempting and has not acknowledged.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await runtime.abort('app-sess-slowack'), true);

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: false });
  const names = readStubLog().map((entry) => entry.name);
  assert.ok(names.indexOf('send_acked') >= 0 && names.indexOf('send_acked') < names.lastIndexOf('stop'),
    'the stop must go out after the prompt was admitted, so it hits the prompt\'s turn');
  assert.equal(messages.find((msg) => msg.kind === 'complete')?.exitCode, 0);
});

test('a stop pressed while the run is still setting up keeps its prompt from ever being sent', async () => {
  fsSync.writeFileSync(modeFilePath, 'slow-subscribe\n');
  fsSync.writeFileSync(logFilePath, '');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const runPromise = runtime.run('hello', { sessionId: 'app-sess-setupstop', cwd: stubDir }, writer, resumedContext);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await runtime.abort('app-sess-setupstop'), true);

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: false });
  assert.equal(readStubLog().filter((entry) => entry.name === 'session_send_attempt').length, 0,
    'a prompt sent after the stop would start a turn nothing stops');
  assert.equal(messages.find((msg) => msg.kind === 'complete')?.exitCode, 0);
});

test('an engine-rejected prompt fails the run visibly instead of vanishing', async () => {
  fsSync.writeFileSync(modeFilePath, 'send-rejected\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  await assert.rejects(
    runtime.run('hello', { sessionId: 'app-sess-rejected', cwd: stubDir }, writer, resumedContext),
    /input rejected by engine/,
  );

  const error = messages.find((msg) => msg.kind === 'error');
  assert.ok(error, 'the rejection must reach the chat stream');
  assert.match(error.text ?? '', /input rejected by engine/);
});

test('the terminal events of a preempted engine-started turn do not end the user run', async () => {
  fsSync.writeFileSync(modeFilePath, 'preempt\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const result = await runtime.run('hello', { sessionId: 'app-sess-preempt', cwd: stubDir }, writer, resumedContext);
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  assert.ok(
    messages.some((msg) => msg.kind === 'stream_delta' && msg.content === 'user reply'),
    'the run must stay open until its own turn finished',
  );
  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.equal(complete?.tokens, 7, 'the run must settle on its own turn, not the cancelled one');
  assert.equal(complete?.exitCode, 0);
  assert.equal(messages.filter((msg) => msg.kind === 'error').length, 0, 'the other turn\'s cancellation is not this run\'s error');
  assert.equal(
    messages.filter((msg) => msg.kind === 'task_notification').length,
    0,
    'the other turn\'s cancellation is not this run\'s interruption',
  );
});

test('runtime repairs a missing engine-side model selection after resume so subagent spawns can resolve a model', async () => {
  fsSync.writeFileSync(modeFilePath, 'resume-no-selection\n');
  fsSync.writeFileSync(logFilePath, '');
  const runtime = new ZCodeRuntimeProvider();
  const { writer } = createWriter();
  // The stored provider mapping points at an engine session, so the run
  // resumes instead of creating.
  const resumeContext: ProviderRuntimeContext = {
    ...context,
    resolveProviderSessionId: () => 'sess_stub_resume',
  };

  const result = await runtime.run('hello', {
    sessionId: 'app-sess-repair',
    model: 'GLM-5.3',
    effort: 'high',
    cwd: stubDir,
  }, writer, resumeContext);

  assert.deepEqual(result, { sessionId: 'sess_stub_resume', success: true });

  const setModelEntries = readStubLog().filter((entry) => entry.name === 'setModel');
  assert.equal(setModelEntries.length, 1, 'a resume whose response lacks settings.model.current must be repaired via session/setModel');
  assert.deepEqual(setModelEntries[0].value, {
    sessionId: 'sess_stub_resume',
    model: { providerId: 'bigmodel-coding-plan', modelId: 'GLM-5.3', options: { reasoningLevel: 'high' } },
  });
});

test('runtime still completes a run when the post-resume model repair is refused', async () => {
  fsSync.writeFileSync(modeFilePath, 'resume-no-selection-setmodel-fail\n');
  fsSync.writeFileSync(logFilePath, '');
  const runtime = new ZCodeRuntimeProvider();
  const { writer } = createWriter();
  const resumeContext: ProviderRuntimeContext = {
    ...context,
    resolveProviderSessionId: () => 'sess_stub_resume',
  };

  // The repair is best-effort: a refused session/setModel must not fail the
  // send, whose per-turn modelSelection still drives the turn itself.
  const result = await runtime.run('hello', {
    sessionId: 'app-sess-repair-refused',
    model: 'GLM-5.3',
    effort: 'high',
    cwd: stubDir,
  }, writer, resumeContext);

  assert.deepEqual(result, { sessionId: 'sess_stub_resume', success: true });
  assert.equal(readStubLog().filter((entry) => entry.name === 'setModel').length, 1, 'the repair attempt must still have been made');
});

test('resume responses carrying the same selection do not trigger a model repair', async () => {
  fsSync.writeFileSync(modeFilePath, 'resume-matching-selection\n');
  fsSync.writeFileSync(logFilePath, '');
  const runtime = new ZCodeRuntimeProvider();
  const { writer } = createWriter();
  const resumeContext: ProviderRuntimeContext = {
    ...context,
    resolveProviderSessionId: () => 'sess_stub_resume',
  };

  const result = await runtime.run('hello', {
    sessionId: 'app-sess-healthy',
    model: 'GLM-5.3',
    cwd: stubDir,
  }, writer, resumeContext);

  assert.deepEqual(result, { sessionId: 'sess_stub_resume', success: true });
  const setModelEntry = readStubLog().find((entry) => entry.name === 'setModel');
  assert.equal(setModelEntry, undefined, 'a session with a usable selection must not be re-modeled');
});

test('resume replaces a legacy provider selection with the native individual plan', async () => {
  fsSync.writeFileSync(modeFilePath, 'ok\n');
  fsSync.writeFileSync(logFilePath, '');
  const credentialsDir = path.join(stubDir, 'v2');
  fsSync.mkdirSync(credentialsDir, { recursive: true });
  const credentialsPath = path.join(credentialsDir, 'credentials.json');
  fsSync.writeFileSync(credentialsPath, JSON.stringify({
    'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:123:api-key': 'fixture-personal-key',
  }));
  try {
    const resumeContext: ProviderRuntimeContext = {
      ...context,
      resolveProviderSessionId: () => 'sess_stub_resume',
    };
    const { writer } = createWriter();
    await new ZCodeRuntimeProvider().run('hello', {
      sessionId: 'app-sess-native-personal',
      model: 'bigmodel-coding-plan/GLM-5.3-Flash',
      cwd: stubDir,
    }, writer, resumeContext);

    const selection = { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } };
    assert.deepEqual(readStubLog().filter((entry) => entry.name === 'setModel').at(-1)?.value,
      { sessionId: 'sess_stub_resume', model: selection });
    assert.deepEqual((readStubLog().filter((entry) => entry.name === 'session_send').at(-1)?.value as { modelSelection?: unknown })?.modelSelection,
      selection);
  } finally {
    fsSync.rmSync(credentialsPath, { force: true });
  }
});

test('runtime bridges interaction/requestPermission to the chat stream and answers the engine', async () => {
  fsSync.writeFileSync(modeFilePath, 'perm-bridge\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  // The run parks on the permission until it is resolved.
  const runPromise = runtime.run('hello', { sessionId: 'app-sess-perm', cwd: stubDir }, writer, context);

  let permissionMessage: NormalizedMessage | undefined;
  for (let i = 0; i < 100 && !permissionMessage; i += 1) {
    permissionMessage = messages.find((msg) => msg.kind === 'permission_request');
    if (!permissionMessage) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  assert.ok(permissionMessage, 'the permission request must reach the chat stream');
  assert.equal(permissionMessage.requestId, 'perm_test_1');
  assert.equal(permissionMessage.toolName, 'Bash');
  assert.deepEqual(permissionMessage.input, { command: 'touch /tmp/x' });

  // Answering through the permissions facet unblocks the engine-side turn.
  // One decision must satisfy BOTH stacked announcements (the engine
  // re-announces pending permissions as fresh protocol requests).
  zcodeRuntimePermissions.resolve('perm_test_1', { allow: true });

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  const answers = readStubLog().filter((entry) => entry.name === 'perm_answer');
  assert.equal(answers.length, 2, 'both announcements must receive the decision');
  for (const answer of answers) {
    assert.deepEqual((answer.value as { result: { decision: string } }).result, { decision: 'allow' });
  }
  const delta = messages.find((msg) => msg.kind === 'stream_delta');
  assert.equal(delta?.content, 'ran it');
});

test('pending permissions survive a reconnect as answerable cards and do not resurrect', async () => {
  fsSync.writeFileSync(modeFilePath, 'perm-e2e\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const runPromise = runtime.run('hello', { sessionId: 'app-sess-perm-e2e', cwd: stubDir }, writer, context);

  let permissionMessage: NormalizedMessage | undefined;
  for (let i = 0; i < 100 && !permissionMessage; i += 1) {
    permissionMessage = messages.find((msg) => msg.kind === 'permission_request');
    if (!permissionMessage) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(permissionMessage, 'the permission request must reach the chat stream');

  // What chat.subscribe replays after a page reload must be a fully shaped
  // card — the UI renders toolName from it and answers with requestId. A bare
  // request-id string here renders a dead card (empty tool badge, clicks that
  // are silently dropped because requestId is undefined). The gateway looks
  // pending approvals up by the app-facing session id, which must win even
  // though the bridge keys its writer by the engine's native id.
  const pendingByAppId = zcodeRuntimePermissions.listPending('app-sess-perm-e2e');
  assert.equal(pendingByAppId.length, 1, 'the pending request must be found by app session id');
  const entry = pendingByAppId[0] as { requestId?: string; toolName?: string; sessionId?: string; input?: unknown };
  assert.equal(entry.requestId, 'perm_e2e_1');
  assert.equal(entry.toolName, 'Bash');
  assert.equal(entry.sessionId, 'app-sess-perm-e2e');
  assert.deepEqual(entry.input, { command: 'rm /tmp/y' });
  assert.equal(zcodeRuntimePermissions.listPending('sess_stub_1').length, 1, 'the native session id must also resolve');
  assert.deepEqual(zcodeRuntimePermissions.listPending('sess_other'), [], 'other sessions must not see this request');

  zcodeRuntimePermissions.resolve('perm_e2e_1', { allow: true });
  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  // The live client must learn the card is gone even though no `complete`
  // replay will ever clear it on reconnect.
  assert.ok(
    messages.some((msg) => msg.kind === 'permission_cancelled' && msg.requestId === 'perm_e2e_1'),
    'resolving a permission must retract the card via permission_cancelled'
  );
  // The late re-announcement (fresh protocol id, same requestId) must be
  // answered from the recorded decision instead of spawning a second card
  // that outlives the run as a zombie.
  assert.equal(messages.filter((msg) => msg.kind === 'permission_request').length, 1);
  const answers = readStubLog().filter((entry) => {
    if (entry.name !== 'perm_answer') return false;
    const id = (entry.value as { id?: string }).id;
    return id === 'server-perm-e2e' || id === 'server-perm-e2e-late';
  });
  assert.equal(answers.length, 2, 'both the original and the late announcement must receive the decision');
  assert.deepEqual(zcodeRuntimePermissions.listPending('app-sess-perm-e2e'), []);
});

test('a reused requestId with different call content is a fresh request, not a cached answer', async () => {
  fsSync.writeFileSync(modeFilePath, 'perm-e2e-conflict\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const runPromise = runtime.run('hello', { sessionId: 'app-sess-conflict', cwd: stubDir }, writer, context);

  const waitForCards = async (count: number): Promise<void> => {
    for (let i = 0; i < 100; i += 1) {
      if (messages.filter((msg) => msg.kind === 'permission_request').length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await waitForCards(1);
  zcodeRuntimePermissions.resolve('perm_conflict_1', { allow: true });

  // The second announcement reuses the requestId but carries a different
  // toolCallId/input — it must surface as its own card instead of silently
  // inheriting the recorded allow.
  await waitForCards(2);
  const secondCard = messages.filter((msg) => msg.kind === 'permission_request')[1];
  assert.equal(secondCard.toolId, 'call_conflict_b', 'the new card must be the reused-id request');
  assert.deepEqual(secondCard.input, { command: 'rm /tmp/b' });
  zcodeRuntimePermissions.resolve('perm_conflict_1', { allow: false, message: 'Denied by user' });

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  const answers = readStubLog().filter((entry) => {
    if (entry.name !== 'perm_answer') return false;
    const id = (entry.value as { id?: string }).id;
    return id === 'server-perm-conflict' || id === 'server-perm-conflict-b';
  });
  assert.equal(answers.length, 2, 'both the original and the reused-id request must reach the engine');
  assert.deepEqual((answers[0].value as { result: { decision: string } }).result, { decision: 'allow' });
  assert.match((answers[1].value as { result: { reason?: string } }).result.reason ?? '', /Denied by user/);
  const cancellations = messages.filter((msg) => msg.kind === 'permission_cancelled');
  assert.equal(cancellations.length, 2, 'both cards must be retracted as they are answered');
  assert.deepEqual(zcodeRuntimePermissions.listPending('app-sess-conflict'), []);
});

test('a silent engine hands the run to a background watcher that still streams the late completion', async () => {
  process.env.CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS = '1000';
  fsSync.writeFileSync(modeFilePath, 'silent\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  try {
    // Resolves (rather than rejecting): the stall is carried by the error
    // message, and the still-attached stream keeps running in the background
    // instead of being torn down the way the old wall-clock timeout did.
    const result = await runtime.run('hello', { sessionId: 'app-sess-silent', cwd: stubDir }, writer, context);
    assert.deepEqual(result, { sessionId: 'sess_stub_1', success: false });

    const stall = messages.find((msg) => msg.kind === 'error');
    assert.ok(stall, 'the silence stall must reach the chat stream');
    assert.match(stall.text ?? '', /silent/);
    assert.equal(
      messages.filter((msg) => msg.kind === 'complete').length, 0,
      'no complete may be sent while the engine may still be working'
    );

    // The engine wakes after the handoff: the late delta must stream and the
    // watcher must deliver the real completion.
    let complete: NormalizedMessage | undefined;
    for (let i = 0; i < 250 && !complete; i += 1) {
      complete = messages.find((msg) => msg.kind === 'complete');
      if (!complete) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(complete, 'the watcher must deliver the completion after the engine wakes');
    assert.equal(complete.tokens, 7);
    assert.ok(
      messages.some((msg) => msg.kind === 'stream_delta' && msg.content === 'late wake'),
      'late engine output must stream to the client'
    );
  } finally {
    delete process.env.CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS;
  }
});

test('steady engine activity keeps the run alive past the silence window', async () => {
  process.env.CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS = '600';
  fsSync.writeFileSync(modeFilePath, 'steady\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  try {
    // ~2.4s of continuous deltas against a 600ms silence window: the run must
    // complete normally instead of stalling out (the old wall-clock timeout
    // killed any run past its budget even while it was actively streaming).
    const result = await runtime.run('hello', { sessionId: 'app-sess-steady', cwd: stubDir }, writer, context);
    assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

    assert.ok(messages.filter((msg) => msg.kind === 'stream_delta').length >= 6);
    const complete = messages.find((msg) => msg.kind === 'complete');
    assert.ok(complete, 'the run must terminate with a complete event');
    assert.equal(complete.tokens, 7);
    assert.equal(messages.filter((msg) => msg.kind === 'error').length, 0, 'an active run must never surface the silence stall');
  } finally {
    delete process.env.CLOUDCLI_ZCODE_SILENCE_TIMEOUT_MS;
  }
});

test('a delivered session/stop settles the run as aborted with a complete frame', async () => {
  fsSync.writeFileSync(modeFilePath, 'abort-ok\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const runPromise = runtime.run('hello', { sessionId: 'app-sess-abort', cwd: stubDir }, writer, context);

  // Wait until the turn is streaming, then stop it.
  let streaming = false;
  for (let i = 0; i < 100 && !streaming; i += 1) {
    streaming = messages.some((msg) => msg.kind === 'stream_delta');
    if (!streaming) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(streaming, 'the stub must be streaming before the abort');

  const legacyStopsBefore = readStubLog().filter((entry) => entry.name === 'legacy_stop').length;
  assert.equal(await runtime.abort('app-sess-abort'), true, 'a delivered stop must report success');

  // The legacy session/stop only cancels turns that session/send started; a
  // turn the engine started from its own queue (a background notification)
  // survives it. The v4 stop command stops whatever turn is in the foreground.
  const stopCommand = readStubLog().filter((entry) => entry.name === 'v4_command').at(-1)?.value as
    { type?: string; sessionId?: string; payload?: unknown } | undefined;
  assert.equal(stopCommand?.type, 'stop');
  assert.equal(stopCommand?.sessionId, 'sess_stub_1');
  assert.deepEqual(stopCommand?.payload, {});
  assert.equal(readStubLog().filter((entry) => entry.name === 'legacy_stop').length, legacyStopsBefore, 'abort must not use the legacy stop');

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: false });

  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.ok(complete, 'an aborted run must still end with a complete frame');
  assert.equal(complete.exitCode, 0, 'an abort is not an engine failure');
  assert.equal(messages.filter((msg) => msg.kind === 'error').length, 0, 'an abort must not surface an error bubble');
});

test('a stop-echoed cancelled turn.failure is dropped instead of surfacing an error bubble', async () => {
  fsSync.writeFileSync(modeFilePath, 'cancel-echo\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const runPromise = runtime.run('hello', { sessionId: 'app-sess-cancelecho', cwd: stubDir }, writer, context);

  // Wait until the turn is streaming, then stop it.
  let streaming = false;
  for (let i = 0; i < 100 && !streaming; i += 1) {
    streaming = messages.some((msg) => msg.kind === 'stream_delta');
    if (!streaming) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(streaming, 'the stub must be streaming before the abort');

  assert.equal(await runtime.abort('app-sess-cancelecho'), true, 'a delivered stop must report success');

  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: false });

  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.ok(complete, 'the aborted run must still end with a complete frame');
  assert.equal(complete.exitCode, 0, 'the cancelled echo must not flip the run to failed');
  assert.equal(
    messages.filter((msg) => msg.kind === 'error').length,
    0,
    'the engine-cancelled echo of a user stop must be dropped, not rendered as an error'
  );
  assert.equal(
    messages.filter((msg) => msg.kind === 'task_notification').length,
    0,
    'a user-initiated stop stays fully silent — no notice either'
  );

  // The stub's cancelled echo fires 100ms after the stop confirmation, which
  // can land after this run settled. Let it drain here so it cannot leak into
  // the next test's run on the same shared engine session.
  await new Promise((resolve) => setTimeout(resolve, 300));
});

test('an engine-side cancellation degrades to a quiet notification instead of an error', async () => {
  fsSync.writeFileSync(modeFilePath, 'cancel-unprompted\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  // Resolves (rather than failing): the cancellation ends the turn without
  // marking the run failed.
  const result = await runtime.run('hello', { sessionId: 'app-sess-cancelself', cwd: stubDir }, writer, context);
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  assert.equal(
    messages.filter((msg) => msg.kind === 'error').length,
    0,
    'an engine-side cancellation is not a failure and must not surface an error bubble'
  );
  const notice = messages.find((msg) => msg.kind === 'task_notification');
  assert.ok(notice, 'the cancellation must degrade to a quiet transcript line');
  assert.equal(notice.summary, ZCODE_CANCELLED_NOTICE);
  assert.equal(notice.summaryKey, ZCODE_CANCELLED_NOTICE_KEY);
  assert.equal(notice.status, 'interrupted');
  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.ok(complete, 'the run must terminate with a complete event');
  assert.equal(complete.exitCode, 0, 'the run must not report a failure exit code');
});

// Last: the crash mode kills the shared stub subprocess; the supervisor's
// restart circuit breaker brings it back, but later tests should not have to
// race the restart.
test('attachments reach the engine in the shape of the channel carrying the prompt, not as app descriptors', async () => {
  fsSync.writeFileSync(modeFilePath, 'ok\n');
  const runtime = new ZCodeRuntimeProvider();
  const attachments = [
    { path: '/tmp/assets/1-abc/photo.png', name: 'photo.png', mimeType: 'image/png', size: 1024 },
    { path: '/tmp/assets/1-def/report.pdf', name: 'report.pdf', mimeType: 'application/pdf', size: 20480 },
    { path: '/tmp/assets/1-ghi/notes.txt', name: 'notes.txt', mimeType: 'text/plain', size: 33 },
    { path: '/tmp/assets/1-jkl/blob.bin', mimeType: 'application/octet-stream', size: 8 },
    { path: 'assets/relative/evil.txt', name: 'evil.txt', mimeType: 'text/plain', size: 3 },
    { path: '/tmp/assets/1-mno/unknown' },
  ];
  const lastAttachments = () => readStubLog()
    .filter((entry) => entry.name === 'session_send')
    .map((entry) => entry.value as { attachments?: unknown[] })
    .filter((params) => Array.isArray(params.attachments))
    .at(-1)?.attachments;

  // A new session's first prompt rides the legacy session/send, whose mapper
  // (0.16.5) reads kind/filename/mimeType/sizeBytes/localPath and silently
  // DROPS any item it cannot map.
  await runtime.run('summarize the files', { sessionId: 'app-sess-attach-new', cwd: stubDir, attachments }, createWriter().writer, context);
  assert.deepEqual(lastAttachments(), [
    { kind: 'image', filename: 'photo.png', localPath: '/tmp/assets/1-abc/photo.png', mimeType: 'image/png', sizeBytes: 1024 },
    { kind: 'pdf', filename: 'report.pdf', localPath: '/tmp/assets/1-def/report.pdf', mimeType: 'application/pdf', sizeBytes: 20480 },
    { kind: 'file', filename: 'notes.txt', localPath: '/tmp/assets/1-ghi/notes.txt', mimeType: 'text/plain', sizeBytes: 33 },
    { kind: 'file', filename: 'blob.bin', localPath: '/tmp/assets/1-jkl/blob.bin', mimeType: 'application/octet-stream', sizeBytes: 8 },
    { kind: 'file', filename: 'unknown', localPath: '/tmp/assets/1-mno/unknown' },
  ], 'descriptors must be mapped to the legacy item shape; relative paths must be dropped');

  await runtime.run('summarize the files', { sessionId: 'app-sess-attach', cwd: stubDir, attachments }, createWriter().writer, resumedContext);
  const sendEntry = { attachments: lastAttachments() };

  // The v4 sendText schema is strict ({ref, fileName, mime, bytes}); the
  // engine maps a non-URI ref to a local file of the type the MIME names, so
  // the app descriptor shape {path,name,mimeType,size} never reaches it.
  // Relative paths are refused: the engine would resolve them against the
  // session workspace. Unknown MIME and size fall back to a generic file.
  assert.deepEqual(sendEntry.attachments, [
    { ref: '/tmp/assets/1-abc/photo.png', fileName: 'photo.png', mime: 'image/png', bytes: 1024 },
    { ref: '/tmp/assets/1-def/report.pdf', fileName: 'report.pdf', mime: 'application/pdf', bytes: 20480 },
    { ref: '/tmp/assets/1-ghi/notes.txt', fileName: 'notes.txt', mime: 'text/plain', bytes: 33 },
    { ref: '/tmp/assets/1-jkl/blob.bin', fileName: 'blob.bin', mime: 'application/octet-stream', bytes: 8 },
    { ref: '/tmp/assets/1-mno/unknown', fileName: 'unknown', mime: 'application/octet-stream', bytes: 0 },
  ], 'descriptors must be mapped to the v4 attachment shape; relative paths must be dropped');
});

test('a failed session/stop keeps the run running to its true completion instead of reporting aborted', async () => {
  fsSync.writeFileSync(modeFilePath, 'stop-fail\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  const runPromise = runtime.run('hello', { sessionId: 'app-sess-stopfail', cwd: stubDir }, writer, context);

  // Let streaming start, then abort against an engine that refuses to stop.
  // Every stop attempt must be refused before abort gives up.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const stopsBefore = readStubLog().filter((entry) => entry.name === 'stop').length;
  assert.equal(await runtime.abort('app-sess-stopfail'), false, 'abort must report failure when every stop attempt is refused');
  assert.equal(readStubLog().filter((entry) => entry.name === 'stop').length - stopsBefore, 3, 'all three stop attempts must reach the engine');

  const stopError = messages.find((msg) => msg.kind === 'error' && /Failed to stop ZCode session/.test(msg.text ?? ''));
  assert.ok(stopError, 'the failed stop must be surfaced to the chat stream');

  // The engine never stopped, so the run continues to its real completion —
  // the old code marked the run completed at abort time and ended it while
  // the turn was in fact still running. The turn ends cancelled, but not by
  // the refused stop: it is a completion, not this run's abort.
  const result = await runPromise;
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });
  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.ok(complete, 'the run must terminate with a complete event');
  assert.equal(complete.tokens, 7, 'the real turn completion must be delivered, not an abort short-circuit');
});

test('an engine crash fails the run fast through session-lost instead of timing out', async () => {
  fsSync.writeFileSync(modeFilePath, 'crash\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  // Resolves (rather than hanging for the silence window): the synthetic
  // session-lost notification marks the run failed immediately.
  const result = await runtime.run('hello', { sessionId: 'app-sess-crash', cwd: stubDir }, writer, context);
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: false });

  const complete = messages.find((msg) => msg.kind === 'complete');
  assert.ok(complete, 'the run must still terminate with a complete event');
  assert.equal(complete.exitCode, 1, 'a lost connection must complete the run as failed');

  // The run's state is gone: a late abort finds nothing left to stop.
  assert.equal(await runtime.abort('app-sess-crash'), false);
});


test('runtime delivers native tool outputs before turn completion without fetching history', async () => {
  fsSync.writeFileSync(modeFilePath, 'tool-results\n');
  const { messages, writer } = createWriter();
  const result = await new ZCodeRuntimeProvider().run('list files', {sessionId:'app-sess-tools', cwd:stubDir}, writer, context);
  assert.deepEqual(result, {sessionId:'sess_stub_1', success:true});
  const results = messages.filter((message) => message.kind === 'tool_result');
  assert.deepEqual(results.map((message) => [message.toolId, message.toolResult]), [
    ['call_live_read', {content:'File not found', isError:true}],
    ['call_live_bash', {content:'a.txt', isError:false}],
  ]);
  const nextTextIndex = messages.findIndex((message) => message.kind === 'stream_delta');
  for (const message of results) assert.ok(messages.indexOf(message) < nextTextIndex);
  assert.equal(messages.at(-1)?.kind, 'complete');
});

test('a background agent shows as a running Agent card, is listed as background work, and settles after the turn', async () => {
  fsSync.writeFileSync(modeFilePath, 'subagent-bg\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();

  assert.deepEqual(runtime.listBackgroundWork(), []);

  const result = await runtime.run('review it', { sessionId: 'app-sess-subagent', cwd: stubDir }, writer, context);
  assert.deepEqual(result, { sessionId: 'sess_stub_1', success: true });

  // The launch renders through the shared subagent card: the engine's
  // `Agent` call reaches the client under that name, and the spawn event marks
  // it running on that very call.
  const launch = messages.find((message) => message.kind === 'tool_use');
  assert.equal(launch?.toolName, 'Agent');
  assert.equal(launch?.toolId, 'call_agent_bg');
  const started = messages.find((message) => message.kind === 'task_status' && message.event === 'started');
  assert.equal(started?.taskId, 'agent_bg_1');
  assert.equal(started?.toolUseId, 'call_agent_bg');
  assert.ok(messages.indexOf(started!) < messages.findIndex((message) => message.kind === 'complete'));

  // The turn is over but the agent is not: the running-sessions poll must
  // still see it.
  const listed = runtime.listBackgroundWork();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sessionId, 'app-sess-subagent');
  assert.deepEqual(listed[0].tasks.map((task) => [task.taskId, task.toolUseId, task.taskType, task.description]), [
    ['agent_bg_1', 'call_agent_bg', 'local_agent', 'Review the fix'],
  ]);

  // The stop lands after the run settled. The lifecycle watcher the run left
  // behind still forwards it, so the open page settles the card without a
  // reload, and the agent leaves the background-work list.
  const deadline = Date.now() + 3000;
  while (runtime.listBackgroundWork().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(runtime.listBackgroundWork(), [], 'the stopped agent is retired');
  const stopped = messages.find((message) => message.kind === 'task_status' && message.status === 'completed');
  assert.equal(stopped?.toolUseId, 'call_agent_bg');
  assert.deepEqual(stopped?.usage, { totalTokens: 300, toolUses: 2, durationMs: 1500 });
});

test('the composer strip lists a background agent past the turn, without a stop the runtime cannot honour', async () => {
  fsSync.writeFileSync(modeFilePath, 'subagent-bg\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();
  await runtime.run('review it', { sessionId: 'app-sess-strip', cwd: stubDir }, writer, context);

  // The agent outlives the turn: a page that subscribes now gets it back from
  // the runtime, and is told the session has no run left to stop.
  const stripTask = { id: 'call_agent_bg', toolName: 'Agent', command: 'Review the fix', description: 'Review the fix' };
  const withoutStart = (tasks: any[]) => tasks.map(({ startedAt: _startedAt, ...task }) => task);
  assert.deepEqual(withoutStart(runtime.backgroundTasks.list('app-sess-strip')), [stripTask]);
  assert.equal(runtime.backgroundTasks.canInterrupt('app-sess-strip'), false);

  const deadline = Date.now() + 3000;
  while (runtime.listBackgroundWork().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // Spawned mid-turn, the agent's work stops with the turn; once the turn
  // has ended there is no run to stop, which the strip must say before the
  // page sees the turn complete.
  const strips = messages.filter((message) => message.kind === 'status' && message.text === 'background_tasks');
  assert.deepEqual(
    strips.map((message) => [withoutStart(message.backgroundTasks ?? []), message.canInterrupt]),
    [[[stripTask], true], [[stripTask], false], [[], false]],
  );
  assert.ok(messages.indexOf(strips[1]) < messages.findIndex((message) => message.kind === 'complete'));
  assert.deepEqual(runtime.backgroundTasks.list('app-sess-strip'), []);
});

test('a new run takes the session over from the lifecycle watcher: a late stop is forwarded exactly once', async () => {
  fsSync.writeFileSync(modeFilePath, 'subagent-bg\n');
  const runtime = new ZCodeRuntimeProvider();
  const first = createWriter();
  await runtime.run('review it', { sessionId: 'app-sess-handover', cwd: stubDir }, first.writer, context);
  assert.equal(runtime.listBackgroundWork().length, 1, 'the agent outlives the first turn');
  const forwardedToFirstAtHandover = first.messages.filter((message) => message.kind === 'task_status').length;

  // The user sends again before the agent reports. The engine's stop lands
  // either during this run (its listener owns the stream) or after it (the
  // re-armed watcher does) — never through both, and never through the
  // writer of the turn that is over.
  fsSync.writeFileSync(modeFilePath, 'ok\n');
  const second = createWriter();
  await runtime.run('and again', { sessionId: 'app-sess-handover', cwd: stubDir }, second.writer, context);

  const deadline = Date.now() + 3000;
  while (runtime.listBackgroundWork().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(runtime.listBackgroundWork(), [], 'the stopped agent is retired');

  const settledInSecond = second.messages.filter((message) => message.kind === 'task_status' && message.status === 'completed');
  assert.equal(settledInSecond.length, 1, 'the stop reaches the live writer once');
  assert.equal(
    first.messages.filter((message) => message.kind === 'task_status').length,
    forwardedToFirstAtHandover,
    'the superseded turn\'s writer receives nothing after the handover',
  );
});

test('a stop landing while a new run is still setting up reaches only the new run, once', async () => {
  fsSync.writeFileSync(modeFilePath, 'subagent-bg\n');
  const runtime = new ZCodeRuntimeProvider();
  const first = createWriter();
  await runtime.run('review it', { sessionId: 'app-sess-window', cwd: stubDir }, first.writer, context);
  assert.equal(runtime.listBackgroundWork().length, 1, 'the agent outlives the first turn');
  const firstCount = first.messages.length;

  // The engine reports the stop while the next run is between its start and
  // its prompt; the first turn's watcher must not take it.
  fsSync.writeFileSync(modeFilePath, 'handover-window\n');
  const second = createWriter();
  await runtime.run('and again', { sessionId: 'app-sess-window', cwd: stubDir }, second.writer, context);

  assert.equal(first.messages.length, firstCount, 'the finished turn\'s writer hears nothing after the handover');
  // The straggling turn-end belongs to the earlier turn: the new run still
  // waits for its own, so its reply arrives before its completion.
  const replyAt = second.messages.findIndex((message) => message.content === 'hi there');
  const completeAt = second.messages.findIndex((message) => message.kind === 'complete');
  assert.ok(replyAt >= 0 && replyAt < completeAt, 'the new run completes on its own turn, not on the earlier one');
  const settled = second.messages.filter((message) => message.kind === 'task_status' && message.status === 'completed');
  assert.equal(settled.length, 1, 'the stop reaches the new run\'s writer exactly once');
  assert.deepEqual(runtime.listBackgroundWork(), []);
});

test('a superseded run forwards nothing from the stream once a newer run owns the session', async () => {
  fsSync.writeFileSync(modeFilePath, 'abort-ok\n');
  const runtime = new ZCodeRuntimeProvider();
  const first = createWriter();
  // The superseded run ends with an error; collect it where it happens.
  const firstRun = runtime.run('stream', { sessionId: 'app-sess-superseded', cwd: stubDir }, first.writer, context)
    .then(() => null, (error: unknown) => error);
  for (let i = 0; i < 100 && !first.messages.some((message) => message.kind === 'stream_delta'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(first.messages.some((message) => message.kind === 'stream_delta'), 'the first run must be streaming');

  fsSync.writeFileSync(modeFilePath, 'handover-window\n');
  const second = createWriter();
  await runtime.run('take over', { sessionId: 'app-sess-superseded', cwd: stubDir }, second.writer, context);
  assert.match(String(await firstRun), /superseded/);

  const windowText = (messages: NormalizedMessage[]) => messages.filter((message) => message.content === 'window text').length;
  assert.equal(windowText(second.messages), 1, 'the new run forwards what arrived during its setup');
  assert.equal(windowText(first.messages), 0, 'the superseded run must not forward a second copy');

  // Stops the stub's ticking stream so it does not outlive the test.
  await protocolClient.sendRequest('session/stop', { sessionId: 'sess_stub_1' });
});

test('a setup failure in a new run releases its listener and hands the session back to the watcher', async (t) => {
  fsSync.writeFileSync(modeFilePath, 'subagent-bg\n');
  const runtime = new ZCodeRuntimeProvider();
  const first = createWriter();
  await runtime.run('review it', { sessionId: 'app-sess-setup-fail', cwd: stubDir }, first.writer, context);
  assert.equal(runtime.listBackgroundWork().length, 1, 'the agent outlives the first turn');

  // Count the listeners attached to the engine session from here on.
  const attached = new Set<unknown>();
  const originalAdd = protocolClient.addSessionListener.bind(protocolClient);
  const originalRemove = protocolClient.removeSessionListener.bind(protocolClient);
  t.mock.method(protocolClient, 'addSessionListener', (sessionId: string, listener: unknown) => {
    attached.add(listener);
    return originalAdd(sessionId, listener as never);
  });
  t.mock.method(protocolClient, 'removeSessionListener', (sessionId: string, listener: unknown) => {
    attached.delete(listener);
    return originalRemove(sessionId, listener as never);
  });

  // The next run dies during setup (model catalog lookup), before any prompt.
  const failing: ProviderRuntimeContext = {
    ...context,
    getProviderModels: async () => { throw new Error('catalog unavailable'); },
  };
  const second = createWriter();
  await assert.rejects(
    runtime.run('and again', { sessionId: 'app-sess-setup-fail', cwd: stubDir }, second.writer, failing),
    /catalog unavailable/,
  );

  // The agent is still outstanding, so the watcher is back on the session and
  // delivers its stop once, to the writer of the run that handed it over.
  const deadline = Date.now() + 3000;
  while (runtime.listBackgroundWork().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(runtime.listBackgroundWork(), [], 'the stopped agent is retired');
  assert.equal(second.messages.filter((m) => m.kind === 'task_status' && m.status === 'completed').length, 1);

  // Once the watcher has stood down, nothing of the failed run still listens.
  assert.equal(attached.size, 0, 'the failed run leaked its session listener');
});

test('a background agent asking for approval after its turn ended still reaches the page, and the answer reaches the engine', async () => {
  fsSync.writeFileSync(modeFilePath, 'subagent-bg-permission\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();
  await runtime.run('review it', { sessionId: 'app-sess-bg-perm', cwd: stubDir }, writer, context);

  for (let i = 0; i < 100 && !messages.some((msg) => msg.kind === 'permission_request'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const card = messages.find((msg) => msg.kind === 'permission_request');
  assert.ok(card, 'the approval card must reach the page although no turn is running');
  assert.equal(card.requestId, 'perm_bg_1');
  assert.deepEqual((card.context as { subagent?: unknown }).subagent, { toolUseId: 'call_agent_bg', agentId: 'agent_bg_1', description: 'Review the fix' });
  assert.deepEqual((zcodeRuntimePermissions.listPending('app-sess-bg-perm') as Array<{ requestId: string }>).map((entry) => entry.requestId), ['perm_bg_1']);

  zcodeRuntimePermissions.resolve('perm_bg_1', { allow: true });
  const deadline = Date.now() + 3000;
  while (runtime.listBackgroundWork().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const answer = readStubLog().filter((entry) => entry.name === 'perm_answer' && (entry.value as { id?: string }).id === 'server-perm-bg');
  assert.equal(answer.length, 1);
  assert.deepEqual((answer[0].value as { result: unknown }).result, { decision: 'allow' });
  assert.equal(messages.filter((msg) => msg.kind === 'permission_cancelled').length, 1, 'retracted once when answered, not again when the agent stops');
});

test('an approval card is retracted when its agent stops before the user answered', async () => {
  fsSync.writeFileSync(modeFilePath, 'subagent-bg-permission-orphan\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();
  await runtime.run('review it', { sessionId: 'app-sess-orphan', cwd: stubDir }, writer, context);

  const deadline = Date.now() + 4000;
  while (!messages.some((msg) => msg.kind === 'permission_cancelled') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(messages.filter((msg) => msg.kind === 'permission_request').length, 1);
  assert.equal(messages.filter((msg) => msg.kind === 'permission_cancelled').length, 1, 'the dead agent\'s card is taken down');
  assert.deepEqual(zcodeRuntimePermissions.listPending('app-sess-orphan'), []);
  // A late answer to the retracted card changes nothing.
  zcodeRuntimePermissions.resolve('perm_bg_orphan', { allow: true });
  assert.equal(messages.filter((msg) => msg.kind === 'permission_cancelled').length, 1);
});

test('a resumed agent\'s approval card is retracted by the agent, whatever call its request names', async () => {
  fsSync.writeFileSync(modeFilePath, 'subagent-bg-permission-orphan-resumed\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();
  await runtime.run('review it', { sessionId: 'app-sess-orphan-resumed', cwd: stubDir }, writer, context);

  const deadline = Date.now() + 4000;
  while (!messages.some((msg) => msg.kind === 'permission_cancelled') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(messages.filter((msg) => msg.kind === 'permission_cancelled').length, 1, 'the stopped agent\'s card is taken down');
  assert.deepEqual(zcodeRuntimePermissions.listPending('app-sess-orphan-resumed'), []);
});

// Last: both crash modes kill the shared stub subprocess.
test('an engine crash settles the agents the watcher was waiting on as stopped, so no card spins', async () => {
  fsSync.writeFileSync(modeFilePath, 'subagent-bg-crash\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();
  await runtime.run('review it', { sessionId: 'app-sess-bg-crash', cwd: stubDir }, writer, context);
  assert.equal(runtime.listBackgroundWork().length, 1, 'the agent is tracked once the turn ends');

  // The engine dies with the agent still running. Nothing can report it any
  // more, so the page must be told it stopped and it must leave the list.
  const deadline = Date.now() + 4000;
  while (runtime.listBackgroundWork().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(runtime.listBackgroundWork(), [], 'the dead engine\'s agent is retired');
  const settled = messages.filter((message) => message.kind === 'task_status' && message.event === 'notification');
  assert.deepEqual(settled.map((message) => [message.toolUseId, message.taskId, message.status]), [
    ['call_agent_bg', 'agent_bg_1', 'stopped'],
  ]);
  assert.equal(settled[0].usage, undefined, 'no usage is invented for an agent that never reported');
  const lastStrip = messages.filter((message) => message.kind === 'status' && message.text === 'background_tasks').at(-1);
  assert.deepEqual(lastStrip?.backgroundTasks, [], 'the strip empties with the dead engine');
});

test('an engine crash mid-turn settles the agents the run was waiting on as stopped', async () => {
  fsSync.writeFileSync(modeFilePath, 'subagent-run-crash\n');
  const runtime = new ZCodeRuntimeProvider();
  const { messages, writer } = createWriter();
  const result = await runtime.run('audit it', { sessionId: 'app-sess-run-crash', cwd: stubDir }, writer, context);
  assert.equal((result as { success: boolean }).success, false);

  const settled = messages.filter((message) => message.kind === 'task_status' && message.event === 'notification');
  assert.deepEqual(settled.map((message) => [message.toolUseId, message.status]), [['call_agent_run', 'stopped']]);
  assert.ok(
    messages.indexOf(settled[0]) < messages.findIndex((message) => message.kind === 'complete'),
    'the card settles before the page sees the run complete',
  );
  assert.deepEqual(runtime.listBackgroundWork(), []);
});
