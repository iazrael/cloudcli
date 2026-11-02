import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  ProviderSessionIdReplacement,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { notifyPermissionRequired } from '@/modules/notifications/index.js';
import { enforceNormalizedMessageContract } from '@/shared/normalized-message-contract.js';
import {
  createCompleteMessage,
  compactProviderPayload,
} from '@/shared/utils.js';

type ChatSessionWriterOptions = {
  connection: RealtimeClientConnection | null;
  /**
   * The audience to deliver to, when the session's channel owns it.
   *
   * The channel keeps one audience per session, so a run's writer and the
   * session's publish entry reach the same sockets. A writer without one keeps
   * a private audience, which is what the tests use.
   */
  audience?: Set<RealtimeClientConnection>;
  userId: string | number | null;
  provider: LLMProvider;
  /** Provider-native id when resuming an existing session, otherwise null. */
  providerSessionId: string | null;
  /**
   * Invoked the moment the provider runtime reveals its native session id
   * (either via `setSessionId` or a `session_created` event). The registry
   * persists the app-id-to-provider-id mapping from this callback. A
   * replacement descriptor means the engine abandoned the session the run
   * started on, so the registry repoints the row instead of only mapping it.
   */
  onProviderSessionId: (
    providerSessionId: string,
    replacement?: ProviderSessionIdReplacement,
  ) => void;
  /**
   * Remaps/sequences/buffers one outbound live event. Implemented by the chat
   * run registry; the writer never forwards a provider event untouched.
   * Returns `null` when the event must be dropped (duplicate terminal
   * `complete` after an abort already completed the run).
   */
  decorateOutboundEvent: (message: NormalizedMessage) => NormalizedMessage | null;
  /**
   * What the user calls this session, for notification titles. A brand-new
   * session has no stored name yet, so the run's creator passes what it knows.
   */
  sessionName?: string | null;
  /**
   * Raises the push notification for an approval card. Defaults to the
   * notification service; tests inject their own.
   */
  notifyPermissionRequest?: (info: {
    userId: string | number | null;
    provider: LLMProvider;
    sessionId: string | null;
    toolName?: string;
    requestId: string;
    sessionName?: string | null;
  }) => void;
};

/**
 * Gateway writer handed to provider runtimes instead of a raw websocket writer.
 *
 * It exposes the exact same surface as `WebSocketWriter` (`send`,
 * `setSessionId`, `getSessionId`, `updateWebSocket`, `userId`,
 * `isWebSocketWriter`) so the provider runtime adapters need zero changes —
 * but everything that flows through
 * it is translated from the provider's world into the app's protocol:
 *
 * - `session_created` events are swallowed and turned into a provider-id
 *   mapping; the frontend never learns provider-native ids.
 * - every other event gets `sessionId` remapped to the app session id and a
 *   per-run `seq` assigned before being forwarded.
 * - `setSessionId(...)` calls (used by runtimes to label captured ids) are
 *   intercepted and recorded as the provider-id mapping as well. A call that
 *   carries a replacement descriptor (the engine abandoned the run's session)
 *   also repoints the app row onto the new transcript.
 */
export class ChatSessionWriter {
  userId: string | number | null;
  /**
   * Some runtimes feature-detect their writer with this flag; keep it so the
   * gateway writer is a drop-in replacement for `WebSocketWriter`.
   */
  isWebSocketWriter = true;

  private readonly options: ChatSessionWriterOptions;
  /**
   * Every socket currently watching this run, not just the one that started
   * it. A session can legitimately be open in more than one place — a second
   * browser tab, a phone alongside a laptop, the desktop app beside the web
   * app — and each of those subscribes through `attachConnection`.
   *
   * Holding a single connection here meant the newest subscriber took the
   * stream away from everyone before it, so a second tab silently froze
   * mid-run and only caught up on the next REST history refresh.
   */
  private readonly connections: Set<RealtimeClientConnection>;
  /**
   * The provider-native session id as the runtime knows it. Kept locally
   * (besides the registry) because runtimes read it back via `getSessionId()`
   * to label their own outgoing events — those labels are remapped on send
   * anyway, but the runtime-visible value must stay provider-native.
   */
  private providerSessionId: string | null;

  constructor(options: ChatSessionWriterOptions) {
    this.options = options;
    this.connections = options.audience ?? new Set<RealtimeClientConnection>();
    // A run started by a timer has no audience yet. Everything still goes
    // through `decorateOutboundEvent` into the run's replay buffer, so a
    // client that subscribes mid-run catches up from the beginning.
    if (options.connection) {
      this.connections.add(options.connection);
    }
    this.userId = options.userId;
    this.providerSessionId = options.providerSessionId;
  }

  send(data: unknown): void {
    // The wire contract is enforced here rather than trusted: two provider
    // runtimes are `.js` files the compiler never type-checks, so this is the
    // last place an undeclared field can be stopped before a renderer starts
    // depending on it.
    const checked = enforceNormalizedMessageContract(compactProviderPayload(data));
    if (!checked.ok) {
      console.error(
        `[ChatSessionWriter] Dropping outbound payload from ${this.options.provider}: ${checked.reason}`,
        data,
      );
      return;
    }
    if (checked.contractViolations.length > 0) {
      console.error(
        `[ChatSessionWriter] ${this.options.provider} broke the row-identity contract: `
        + `${checked.contractViolations.join('; ')}.`,
      );
    }
    if (checked.strippedKeys.length > 0) {
      console.error(
        `[ChatSessionWriter] ${this.options.provider} emitted fields the wire contract does not declare, `
        + `stripped before sending: ${checked.strippedKeys.join(', ')}. `
        + 'Declare them in shared/protocol/chatEvents.ts or stop emitting them.',
      );
    }

    const message = checked.message;

    if (message.kind === 'session_created') {
      const announcedId =
        typeof message.newSessionId === 'string' && message.newSessionId
          ? message.newSessionId
          : message.sessionId;
      if (announcedId) {
        this.captureProviderSessionId(announcedId);
      }
      // Swallowed on purpose: the frontend already has the stable app session
      // id, so there is no client-side handoff to perform anymore.
      return;
    }

    const outbound = this.options.decorateOutboundEvent(message);
    if (outbound) {
      this.forward(outbound);
      // Every engine's approval and question cards pass through here, so this
      // is the one place that tells the user something waits for them, whether
      // or not a page is open.
      if (outbound.kind === 'permission_request' && outbound.requestId) {
        (this.options.notifyPermissionRequest ?? notifyPermissionRequired)({
          userId: this.userId,
          provider: this.options.provider,
          sessionId: outbound.sessionId ?? null,
          toolName: outbound.toolName,
          requestId: outbound.requestId,
          sessionName: this.options.sessionName ?? null,
        });
      }
    }
  }

  /**
   * Emits the synthetic terminal `complete` for runs that ended without one
   * (runtime crash before completing, or user abort).
   */
  sendComplete(opts: { exitCode: number; aborted?: boolean }): void {
    const message = createCompleteMessage({
      provider: this.options.provider,
      sessionId: this.providerSessionId,
      exitCode: opts.exitCode,
      aborted: opts.aborted,
    });
    const outbound = this.options.decorateOutboundEvent(message);
    if (outbound) {
      this.forward(outbound);
    }
  }

  /**
   * Adds a socket to the run's live audience. Named for the `WebSocketWriter`
   * method it stands in for, so runtime adapters keep working unchanged —
   * but it adds rather than replaces.
   */
  updateWebSocket(newConnection: RealtimeClientConnection): void {
    this.connections.add(newConnection);
  }

  setSessionId(sessionId: string, replacement?: ProviderSessionIdReplacement): void {
    this.captureProviderSessionId(sessionId, replacement);
  }

  getSessionId(): string | null {
    return this.providerSessionId;
  }

  private captureProviderSessionId(
    providerSessionId: string,
    replacement?: ProviderSessionIdReplacement,
  ): void {
    if (!providerSessionId || this.providerSessionId === providerSessionId) {
      return;
    }

    this.providerSessionId = providerSessionId;
    this.options.onProviderSessionId(providerSessionId, replacement);
  }

  private forward(message: NormalizedMessage): void {
    const payload = JSON.stringify(message);

    // Sending is also when dead sockets get collected: a refreshed tab leaves
    // its old connection behind, and without dropping it here the set would
    // grow for the whole life of the run. Deleting during iteration is safe
    // for a Set — the removed entry is simply not revisited.
    for (const connection of this.connections) {
      if (connection.readyState === WS_OPEN_STATE) {
        connection.send(payload);
      } else {
        this.connections.delete(connection);
      }
    }
  }
}
