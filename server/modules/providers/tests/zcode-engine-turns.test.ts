/**
 * ZCode Engine Turn Presence Tests
 *
 * Drives the observer with the notification shapes the engine sends on
 * `session/event` — no engine process. The sequences mirror the real fault the
 * registry exists for: a turn whose run ended while the engine kept working,
 * a report turn a background task's notification woke, and a preempted turn's
 * terminal event arriving after its successor started.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearZCodeEngineTurns,
  listZCodeEngineTurns,
  observeZCodeEngineTurn,
} from '../list/zcode/zcode-engine-turns.js';
import { SESSION_LOST_METHOD } from '../list/zcode/zcode-codec.js';

const SESSION = 'sess_engine_turn_1';

const sessionEvent = (
  type: string,
  options: { turnId?: string; timestamp?: string; payload?: Record<string, unknown> } = {},
): Record<string, unknown> => ({
  jsonrpc: '2.0',
  method: 'session/event',
  params: {
    type,
    sessionId: SESSION,
    ...(options.turnId ? { turnId: options.turnId } : {}),
    // The engine's envelope field; `readZCodeSessionEvent` folds it into the
    // event's ISO timestamp.
    timestamp: options.timestamp ?? new Date('2026-11-23T13:44:34.000Z').toISOString(),
    payload: options.payload ?? {},
  },
});

test('a turn the engine starts on its own is listed with its own start time', () => {
  clearZCodeEngineTurns();

  observeZCodeEngineTurn(sessionEvent('turn.started', {
    turnId: 'turn_1',
    timestamp: new Date('2026-11-23T14:22:09.000Z').toISOString(),
    payload: { backgroundSource: 'subagent', turnNumber: 4 },
  }));

  assert.deepEqual(listZCodeEngineTurns(), [{
    engineSessionId: SESSION,
    startedAt: Date.parse('2026-11-23T14:22:09.000Z'),
  }]);
});

test('the turn disappears from the list once the engine reports its terminal event', () => {
  clearZCodeEngineTurns();
  observeZCodeEngineTurn(sessionEvent('turn.started', { turnId: 'turn_1' }));

  observeZCodeEngineTurn(sessionEvent('turn.completed', { turnId: 'turn_1' }));
  assert.deepEqual(listZCodeEngineTurns(), []);

  observeZCodeEngineTurn(sessionEvent('turn.started', { turnId: 'turn_2' }));
  observeZCodeEngineTurn(sessionEvent('turn.failed', { turnId: 'turn_2' }));
  assert.deepEqual(listZCodeEngineTurns(), []);
});

test('a repeated turn.started for the same turn keeps the original clock', () => {
  clearZCodeEngineTurns();
  observeZCodeEngineTurn(sessionEvent('turn.started', {
    turnId: 'turn_1',
    timestamp: new Date('2026-11-23T14:00:00.000Z').toISOString(),
  }));
  observeZCodeEngineTurn(sessionEvent('turn.started', {
    turnId: 'turn_1',
    timestamp: new Date('2026-11-23T14:05:00.000Z').toISOString(),
  }));

  assert.deepEqual(listZCodeEngineTurns(), [{
    engineSessionId: SESSION,
    startedAt: Date.parse('2026-11-23T14:00:00.000Z'),
  }]);
});

test('a preempted turn\'s late terminal event does not close the turn that replaced it', () => {
  clearZCodeEngineTurns();
  observeZCodeEngineTurn(sessionEvent('turn.started', {
    turnId: 'turn_engine_own',
    timestamp: new Date('2026-11-23T14:00:00.000Z').toISOString(),
  }));
  // The prompt preempts the engine's own turn and starts this one.
  observeZCodeEngineTurn(sessionEvent('turn.started', {
    turnId: 'turn_prompt',
    timestamp: new Date('2026-11-23T14:01:00.000Z').toISOString(),
  }));

  observeZCodeEngineTurn(sessionEvent('turn.completed', { turnId: 'turn_engine_own' }));

  assert.deepEqual(listZCodeEngineTurns(), [{
    engineSessionId: SESSION,
    startedAt: Date.parse('2026-11-23T14:01:00.000Z'),
  }]);
});

test('losing the engine session drops its turn', () => {
  clearZCodeEngineTurns();
  observeZCodeEngineTurn(sessionEvent('turn.started', { turnId: 'turn_1' }));

  observeZCodeEngineTurn({
    method: SESSION_LOST_METHOD,
    params: { sessionId: SESSION, code: 1, signal: null, stderrTail: '' },
  });

  assert.deepEqual(listZCodeEngineTurns(), []);
});

test('an engine crash with no session named drops every turn', () => {
  clearZCodeEngineTurns();
  observeZCodeEngineTurn(sessionEvent('turn.started', { turnId: 'turn_1' }));
  observeZCodeEngineTurn({
    ...sessionEvent('turn.started', { turnId: 'turn_2' }),
    params: { type: 'turn.started', sessionId: 'sess_engine_turn_2', turnId: 'turn_2', payload: {} },
  });
  assert.equal(listZCodeEngineTurns().length, 2);

  observeZCodeEngineTurn({
    method: SESSION_LOST_METHOD,
    params: { sessionId: null, code: 1, signal: null, stderrTail: '' },
  });

  assert.deepEqual(listZCodeEngineTurns(), []);
});

test('a closed session drops its turn', () => {
  clearZCodeEngineTurns();
  observeZCodeEngineTurn(sessionEvent('turn.started', { turnId: 'turn_1' }));

  observeZCodeEngineTurn(sessionEvent('session.closed'));

  assert.deepEqual(listZCodeEngineTurns(), []);
});

test('a turn with no engine event for two hours is dropped', () => {
  clearZCodeEngineTurns();
  observeZCodeEngineTurn(sessionEvent('turn.started', {
    turnId: 'turn_1',
    timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  }));

  assert.deepEqual(listZCodeEngineTurns(), [], 'a missed terminal event must not mark the session busy for ever');
});

test('an event on the session keeps a long-running turn alive', () => {
  clearZCodeEngineTurns();
  observeZCodeEngineTurn(sessionEvent('turn.started', {
    turnId: 'turn_1',
    timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  }));
  // A tool call's progress or a streamed delta: silence is what expires a turn,
  // not its age.
  observeZCodeEngineTurn(sessionEvent('tool.updated', {
    turnId: 'turn_1',
    timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
  }));

  assert.deepEqual(listZCodeEngineTurns(), [{
    engineSessionId: SESSION,
    startedAt: Date.parse(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()),
  }]);
});
