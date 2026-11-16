import { isValidReplaySeq, isValidStreamEpoch } from '@shared/protocol/frameNarrowing';
import { CHAT_REPLAY_LIMITS } from '@shared/protocol/frames';
import type { ChatSubscribedEvent, ServerEvent } from '@shared/protocol/frames';

// These records belong only to the transport ledger, never the visible rows.
type BufferedEvent = { event: ServerEvent; bytes: number };
type ReplayState = {
  epoch?: string;
  ready: boolean;
  cursor: number;
  watermark: number;
  pending: Map<string, BufferedEvent>;
  bytes: number;
  replayRequested: boolean;
  needsRecovery: boolean;
  recovery?: { id: number; baseline: number; failed: boolean };
};

/** Store-private transport ledger; SessionTimelineStore supplies state/effect execution. */
export class SessionEventReplay {
  // Keep one contiguous cursor per session, rather than retaining every applied fragment.
  private readonly sessions = new Map<string, ReplayState>();
  // The total budget also bounds pre-ack traffic spread across many sessions.
  private bufferedBytes = 0;
  private recoveryCounter = 0;

  private state(sessionId: string): ReplayState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { ready: false, cursor: 0, watermark: 0, pending: new Map(), bytes: 0, replayRequested: false, needsRecovery: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  sessionIds(): string[] { return [...this.sessions.keys()]; }

  cursor(sessionId: string): number { return this.sessions.get(sessionId)?.cursor ?? 0; }
  epoch(sessionId: string): string | undefined { return this.sessions.get(sessionId)?.epoch; }

  beginConnection(): void {
    for (const state of this.sessions.values()) {
      this.invalidateAcknowledgement(state);
      // A reconnect needs a fresh ack before either old or new epochs can act.
    }
  }

  private invalidateAcknowledgement(state: ReplayState): void {
    state.ready = false;
    state.replayRequested = false;
    if (state.recovery) {
      state.needsRecovery = true;
      state.recovery = undefined;
    }
  }

  private remove(state: ReplayState, key: string): void {
    const entry = state.pending.get(key);
    if (!entry) return;
    state.pending.delete(key);
    state.bytes -= entry.bytes;
    this.bufferedBytes -= entry.bytes;
  }

  private request(state: ReplayState, replay: () => void): void {
    if (state.replayRequested) return;
    state.replayRequested = true;
    replay();
  }

  private collectEffectFailure(execute: () => void, failures: unknown[]): void {
    try { execute(); } catch (error) { failures.push(error); }
  }

  private rethrowFailures(failures: unknown[]): void {
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw Object.assign(new Error('Multiple event observers failed'), { errors: failures });
    }
  }

  private drain(state: ReplayState, apply: (event: ServerEvent) => (() => void), replay: () => void): void {
    if (!state.ready || state.recovery) return;
    const failures: unknown[] = [];
    for (;;) {
      const key = `${state.epoch}:${state.cursor + 1}`;
      const entry = state.pending.get(key);
      if (!entry) break;
      // Only successful state application advances the contiguous cursor.
      // Execute this event's directive before applying the next queued state.
      let executeDirective: () => void;
      try {
        executeDirective = apply(entry.event);
      } catch (error) {
        this.rethrowFailures([...failures, error]);
        throw error;
      }
      state.cursor += 1;
      this.remove(state, key);
      this.collectEffectFailure(executeDirective, failures);
    }
    if (state.pending.size > 0) this.request(state, replay);
    this.rethrowFailures(failures);
  }

  receive(
    sessionId: string,
    event: ServerEvent,
    callbacks: {
      apply: (event: ServerEvent) => (() => void);
      replay: () => void;
      recover: (id: number) => void;
      resetStream: () => void;
    },
  ): boolean {
    const record = event as unknown as Record<string, unknown>;
    const state = this.state(sessionId);
    if (event.kind === 'chat_subscribed') {
      if (!('streamEpoch' in record)) {
        if (state.ready && state.epoch) {
          this.request(state, callbacks.replay);
          throw new Error('epoch disappeared from subscription acknowledgement');
        }
        for (const key of state.pending.keys()) this.remove(state, key);
        state.epoch = undefined;
        state.recovery = undefined;
        state.ready = true;
        return false;
      }
      const ack = event as ChatSubscribedEvent;
      if (!isValidStreamEpoch(ack.streamEpoch)
        || !isValidReplaySeq(ack.lastSeq, true)
        || !isValidReplaySeq(ack.replayFromSeq) || ack.replayFromSeq! > ack.lastSeq + 1
        || (ack.replayAfterSeq !== undefined && (!isValidReplaySeq(ack.replayAfterSeq, true)
          || ack.replayAfterSeq > ack.lastSeq || ack.replayAfterSeq >= ack.replayFromSeq!))) {
        this.request(state, callbacks.replay);
        throw new Error('invalid subscription replay metadata');
      }
      if (state.ready && state.epoch && state.epoch !== ack.streamEpoch) {
        this.request(state, callbacks.replay);
        throw new Error('gateway epoch changed on the same connection');
      }
      const initialSubscription = state.epoch === undefined && state.cursor === 0 && !state.needsRecovery;
      const changed = state.epoch !== undefined && state.epoch !== ack.streamEpoch;
      if (state.epoch !== ack.streamEpoch) {
        state.cursor = 0;
        state.recovery = undefined;
        callbacks.resetStream();
      }
      // Only a fresh page can skip completed turns. Reconnects retain their
      // proven cursor, and gateway changes still require history recovery.
      if (initialSubscription && ack.replayAfterSeq !== undefined) {
        state.cursor = ack.replayAfterSeq;
      }
      state.epoch = ack.streamEpoch;
      state.ready = true;
      state.watermark = ack.lastSeq;
      state.replayRequested = false;
      for (const [key, entry] of state.pending) {
        const pending = entry.event as unknown as Record<string, unknown>;
        if (pending.streamEpoch !== state.epoch || Number(pending.seq) <= state.cursor) this.remove(state, key);
      }
      callbacks.apply(event)();
      if (changed || ack.stale || state.recovery?.failed || state.needsRecovery || state.cursor < ack.replayFromSeq! - 1 || state.cursor > ack.lastSeq) {
        if (!state.recovery || state.recovery.failed) {
          state.recovery = { id: ++this.recoveryCounter, baseline: ack.lastSeq, failed: false };
          callbacks.resetStream();
          callbacks.recover(state.recovery.id);
        }
      } else {
        this.drain(state, callbacks.apply, callbacks.replay);
      }
      return true;
    }

    if (!('streamEpoch' in record)) {
      if (state.ready && state.epoch && 'seq' in record) {
        this.request(state, callbacks.replay);
        throw new Error('sequenced event is missing its gateway epoch');
      }
      return false;
    }
    const { streamEpoch, seq } = record;
    if (!isValidStreamEpoch(streamEpoch) || !isValidReplaySeq(seq)) {
      this.request(state, callbacks.replay);
      throw new Error('invalid event replay identity');
    }
    if (state.ready && state.epoch !== streamEpoch) {
      this.request(state, callbacks.replay);
      throw new Error('event epoch does not match subscription acknowledgement');
    }
    if (state.ready && Number(seq) <= state.cursor) return true;
    const key = `${streamEpoch}:${seq}`;
    if (state.ready && !state.recovery && seq === state.cursor + 1) {
      // An in-order event needs no gap-buffer allocation. In particular a
      // large live result must not be discarded merely because it is not replayable.
      const executeDirective = callbacks.apply(event);
      state.cursor += 1;
      this.remove(state, key);
      const failures: unknown[] = [];
      this.collectEffectFailure(executeDirective, failures);
      this.collectEffectFailure(() => this.drain(state, callbacks.apply, callbacks.replay), failures);
      this.rethrowFailures(failures);
      return true;
    }
    if (state.pending.has(key)) {
      this.drain(state, callbacks.apply, callbacks.replay);
      return true;
    }
    const bytes = new Blob([JSON.stringify(event)]).size;
    if (bytes > CHAT_REPLAY_LIMITS.eventBytes || state.pending.size >= CHAT_REPLAY_LIMITS.events
      || state.bytes + bytes > CHAT_REPLAY_LIMITS.sessionBytes || this.bufferedBytes + bytes > CHAT_REPLAY_LIMITS.totalBytes) {
      for (const existing of state.pending.keys()) this.remove(state, existing);
      state.needsRecovery = true;
      this.invalidateAcknowledgement(state);
      this.request(state, callbacks.replay);
      return true;
    }
    state.pending.set(key, { event, bytes });
    state.bytes += bytes;
    this.bufferedBytes += bytes;
    if (!state.ready) this.request(state, callbacks.replay);
    this.drain(state, callbacks.apply, callbacks.replay);
    return true;
  }

  recovery(sessionId: string, id: number): boolean {
    return this.sessions.get(sessionId)?.recovery?.id === id;
  }

  finishRecovery(sessionId: string, id: number, apply: (event: ServerEvent) => (() => void), replay: () => void): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.recovery?.id !== id || !state.ready) return;
    state.cursor = state.recovery.baseline;
    state.recovery = undefined;
    state.needsRecovery = false;
    state.replayRequested = false;
    for (const [key, entry] of state.pending) {
      if (Number((entry.event as unknown as Record<string, unknown>).seq) <= state.cursor) this.remove(state, key);
    }
    this.drain(state, apply, replay);
  }

  failRecovery(sessionId: string, id: number): void {
    const recovery = this.sessions.get(sessionId)?.recovery;
    if (recovery?.id === id) recovery.failed = true;
  }
}
