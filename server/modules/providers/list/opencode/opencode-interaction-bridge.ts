/**
 * OpenCode Interaction Bridge
 *
 * Turns the service's two interactive requests into the chat's one card
 * protocol and routes the answers back:
 *
 * - `permission.asked` (a tool needs approval) → `permission_request` frame
 *   labelled with the tool call it guards; the reply maps Allow/Remember/
 *   Deny onto the service's `once`/`always`/`reject`.
 * - `form.created` with `metadata.kind: "question"` (the question tool) →
 *   `permission_request` frame with `toolName: 'AskUserQuestion'` so the
 *   existing question panel renders it; the panel's answers (keyed by
 *   question text, multi-select joined with ", ") are mapped back onto the
 *   form's field keys. Skip/Deny dismiss the form with a message so the
 *   model continues instead of the step dying.
 *
 * The bridge keeps every pending card so `chat.subscribe` can replay it
 * after a reload, retracts cards the moment they are answered (here or in
 * another opencode client), and expires forgotten ones.
 *
 * @module opencode-interaction-bridge
 */

import type { ProviderPermissionDecision, ProviderRuntimeWriter } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import type { OpenCodeApiClient, OpenCodeFormAnswer } from './opencode-api.client.js';
import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';
import type { OpenCodeToolCall } from './opencode-event-translator.js';
import { MULTI_SELECT_JOINER, QUESTION_CARD_TOOL_NAME } from './opencode-question.js';

const PROVIDER = 'opencode' as const;
const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;
const SKIPPED_FORM_MESSAGE = 'The user skipped these questions. Continue without the answers; make reasonable assumptions and state them.';
const DECLINED_PERMISSION_MESSAGE = 'The user declined this action.';
const EXPIRED_MESSAGE = 'The request expired without an answer.';

//----------------- SESSION ATTACHMENT ------------

/**
 * What the bridge needs from an active run to surface its cards.
 *
 * Consumer: opencode runtime (attaches on run start, detaches at the end).
 */
export type OpenCodeInteractionSession = {
  appSessionId: string;
  providerSessionId: string;
  writer: ProviderRuntimeWriter;
  /** Tool call lookup for labelling permission cards (translator-backed). */
  resolveToolCall: (callId: string) => OpenCodeToolCall | null;
  /** For a subagent's session: the `Agent` card its requests belong to. Absent on the root session. */
  resolveOrigin?: () => { toolUseId: string; description?: string } | null;
};

/** Replay shape for `chat.subscribe`; mirrors zcode's PendingPermissionView. */
export type OpenCodePendingInteractionView = {
  requestId: string;
  toolName: string;
  toolId?: string;
  input: unknown;
  context: unknown;
  sessionId: string;
  receivedAt: Date;
};

// ---------------------------

type FormField = {
  key: string;
  title?: string;
  description?: string;
  type?: string;
  options?: Array<{ value?: string; label?: string; description?: string }>;
};

type PendingInteraction = {
  requestId: string;
  kind: 'permission' | 'form';
  appSessionId: string;
  providerSessionId: string;
  toolName: string;
  toolId?: string;
  input: unknown;
  context: unknown;
  receivedAt: Date;
  formFields: FormField[];
  writer: ProviderRuntimeWriter;
};

/** The three calls the bridge makes; the runtime hands over the live client lazily. */
type ReplyClient = Pick<OpenCodeApiClient, 'replyPermission' | 'replyForm' | 'cancelForm'>;

type BridgeDependencies = {
  getClient: () => ReplyClient | null;
  /**
   * Who owns a session the engine created for a subagent: the root run's
   * provider session and the child's own tool-call lookup. Its requests carry
   * the child's id, so without this they match no attached run.
   */
  resolveChild?: (providerSessionId: string) => {
    rootProviderSessionId: string;
    resolveToolCall: (callId: string) => OpenCodeToolCall | null;
    resolveOrigin: () => { toolUseId: string; description?: string } | null;
  } | null;
  now?: () => number;
  pendingTtlMs?: number;
};

const readFormFields = (value: unknown): FormField[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const fields: FormField[] = [];
  for (const entry of value) {
    const record = readObjectRecord(entry);
    const key = readOptionalString(record?.key);
    if (!record || !key) {
      continue;
    }
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
        const optionRecord = readObjectRecord(option);
        return optionRecord
          ? [{
            value: readOptionalString(optionRecord.value),
            label: readOptionalString(optionRecord.label),
            description: readOptionalString(optionRecord.description),
          }]
          : [];
      })
      : [];
    fields.push({
      key,
      title: readOptionalString(record.title),
      description: readOptionalString(record.description),
      type: readOptionalString(record.type),
      options,
    });
  }
  return fields;
};

/** The question panel's `Question` shape (`multiSelect`, not the service's `multiple`). */
const toPanelQuestion = (field: FormField) => ({
  question: field.description ?? field.title ?? '',
  header: field.title,
  options: (field.options ?? []).map((option) => ({
    label: option.label ?? option.value ?? '',
    ...(option.description ? { description: option.description } : {}),
  })),
  multiSelect: field.type === 'multiselect',
});

/**
 * Bridges opencode's permission and question requests to the chat cards.
 *
 * Consumer: opencode runtime (module-level singleton, exposed as the
 * provider's `permissions` facet).
 */
export class OpenCodeInteractionBridge {
  private readonly getClient: () => ReplyClient | null;
  private readonly resolveChild: NonNullable<BridgeDependencies['resolveChild']>;
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly sessions = new Map<string, OpenCodeInteractionSession>();
  private readonly pending = new Map<string, PendingInteraction>();

  constructor(dependencies: BridgeDependencies) {
    this.getClient = dependencies.getClient;
    this.resolveChild = dependencies.resolveChild ?? (() => null);
    this.now = dependencies.now ?? Date.now;
    this.pendingTtlMs = dependencies.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  }

  /**
   * The run a request belongs to: the attached run itself, or the root run of
   * a subagent's session. For a child the card is shown under the root's app
   * session while the reply goes to the child's own provider session.
   */
  private sessionFor(providerSessionId: string): OpenCodeInteractionSession | undefined {
    const direct = this.sessions.get(providerSessionId);
    if (direct) {
      return direct;
    }
    const child = this.resolveChild(providerSessionId);
    const root = child ? this.sessions.get(child.rootProviderSessionId) : undefined;
    return child && root
      ? { ...root, providerSessionId, resolveToolCall: child.resolveToolCall, resolveOrigin: child.resolveOrigin }
      : undefined;
  }

  attach(session: OpenCodeInteractionSession): void {
    this.sessions.set(session.providerSessionId, session);
  }

  detach(providerSessionId: string): void {
    this.sessions.delete(providerSessionId);
  }

  /** Feeds one service event; non-interaction events and foreign sessions are ignored. */
  handleEvent(event: OpenCodeEventEnvelope): void {
    const data = readObjectRecord(event.data);
    if (!data) {
      return;
    }
    switch (event.type) {
      case 'permission.asked':
        this.onPermissionAsked(data);
        return;
      case 'permission.replied':
        this.settleExternally(readOptionalString(data.requestID), 'resolved');
        return;
      case 'form.created':
        this.onFormCreated(readObjectRecord(data.form) ?? data);
        return;
      case 'form.replied':
        this.settleExternally(readOptionalString(data.id), 'resolved');
        return;
      case 'form.cancelled':
        this.settleExternally(readOptionalString(data.id), 'cancelled');
        return;
      default:
        return;
    }
  }

  /** Answers a card; request ids the bridge never issued are ignored (other providers' facets own them). */
  resolve(requestId: string, decision: ProviderPermissionDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return;
    }
    this.pending.delete(requestId);
    const client = this.getClient();
    if (!client) {
      this.retract(entry, 'cancelled', 'OpenCode service is not running');
      return;
    }
    const submit = entry.kind === 'permission'
      ? client.replyPermission(entry.providerSessionId, requestId, {
        ...(decision.allow
          ? { decision: decision.rememberEntry ? 'always' as const : 'once' as const }
          : { decision: 'reject' as const, message: decision.message?.trim() || DECLINED_PERMISSION_MESSAGE }),
      })
      : this.submitFormDecision(client, entry, decision);
    void submit.then(
      () => this.retract(entry, 'resolved'),
      (error: unknown) => {
        console.warn(`[OpenCode] failed to deliver ${entry.kind} reply ${requestId}:`, error);
        this.retract(entry, 'cancelled', error instanceof Error ? error.message : String(error));
      },
    );
  }

  listPending(sessionId: string): OpenCodePendingInteractionView[] {
    this.sweepExpired();
    const views: OpenCodePendingInteractionView[] = [];
    for (const entry of this.pending.values()) {
      if (entry.appSessionId !== sessionId && entry.providerSessionId !== sessionId) {
        continue;
      }
      views.push({
        requestId: entry.requestId,
        toolName: entry.toolName,
        toolId: entry.toolId,
        input: entry.input,
        context: entry.context,
        sessionId: entry.appSessionId,
        receivedAt: entry.receivedAt,
      });
    }
    return views;
  }

  /**
   * Retracts every card of a session whose run is ending; the server settles
   * its own forms. Cards asked by a session in `keep` stay: a background
   * agent's session still waits for its answer after the run ends.
   */
  cancelSession(appSessionId: string, reason: string, keep: ReadonlySet<string> = new Set()): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.appSessionId !== appSessionId || keep.has(entry.providerSessionId)) {
        continue;
      }
      this.pending.delete(entry.requestId);
      this.retract(entry, 'cancelled', reason);
    }
  }

  /**
   * Points the session's pending cards at a new writer, so the answer and the
   * retraction of a card kept past its run reach the page through the
   * session channel instead of the finished run.
   */
  rebind(appSessionId: string, writer: ProviderRuntimeWriter): void {
    for (const entry of this.pending.values()) {
      if (entry.appSessionId === appSessionId) {
        entry.writer = writer;
      }
    }
  }

  private onPermissionAsked(data: Record<string, unknown>): void {
    const requestId = readOptionalString(data.id);
    const providerSessionId = readOptionalString(data.sessionID);
    if (!requestId || !providerSessionId || this.pending.has(requestId)) {
      return;
    }
    const session = this.sessionFor(providerSessionId);
    if (!session) {
      return;
    }
    const action = readOptionalString(data.action) ?? 'tool';
    const resources = Array.isArray(data.resources) ? data.resources.filter((item): item is string => typeof item === 'string') : [];
    const source = readObjectRecord(data.source);
    const toolId = readOptionalString(source?.id);
    const toolCall = toolId ? session.resolveToolCall(toolId) : null;
    this.announce(session, {
      requestId,
      kind: 'permission',
      appSessionId: session.appSessionId,
      providerSessionId,
      toolName: toolCall?.name ?? action,
      toolId,
      input: toolCall?.input ?? { resources },
      context: {
        action,
        resources,
        save: Array.isArray(data.save) ? data.save : undefined,
        reason: resources.length > 0 ? `${action}: ${resources.join(', ')}` : action,
        ...this.originOf(session),
      },
      receivedAt: new Date(this.now()),
      formFields: [],
      writer: session.writer,
    });
  }

  private onFormCreated(form: Record<string, unknown>): void {
    const requestId = readOptionalString(form.id);
    const providerSessionId = readOptionalString(form.sessionID);
    if (!requestId || !providerSessionId || this.pending.has(requestId)) {
      return;
    }
    const session = this.sessionFor(providerSessionId);
    if (!session) {
      return;
    }
    const metadata = readObjectRecord(form.metadata);
    const kind = readOptionalString(metadata?.kind);
    if (kind !== 'question') {
      // Only the question tool's form has the panel shape; anything else the
      // service adds later must not be rendered as an answerable survey.
      console.warn(`[OpenCode] ignoring form of unsupported kind "${kind ?? 'unknown'}"`);
      return;
    }
    const tool = readObjectRecord(metadata?.tool);
    const fields = readFormFields(form.fields);
    this.announce(session, {
      requestId,
      kind: 'form',
      appSessionId: session.appSessionId,
      providerSessionId,
      toolName: QUESTION_CARD_TOOL_NAME,
      toolId: readOptionalString(tool?.id),
      input: { questions: fields.map(toPanelQuestion) },
      context: { reason: readOptionalString(form.title) ?? 'Questions', kind: readOptionalString(metadata?.kind), ...this.originOf(session) },
      receivedAt: new Date(this.now()),
      formFields: fields,
      writer: session.writer,
    });
  }

  /** `{ subagent }` for a request from a subagent's session, else nothing. */
  private originOf(session: OpenCodeInteractionSession): { subagent?: { toolUseId: string; description?: string } } {
    const origin = session.resolveOrigin?.();
    return origin ? { subagent: origin } : {};
  }

  private announce(session: OpenCodeInteractionSession, entry: PendingInteraction): void {
    this.pending.set(entry.requestId, entry);
    session.writer.send(createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      sessionId: entry.appSessionId,
      provider: PROVIDER,
      kind: 'permission_request',
      requestId: entry.requestId,
      toolName: entry.toolName,
      toolId: entry.toolId,
      input: entry.input,
      context: entry.context,
      canInterrupt: true,
    }));
  }

  private submitFormDecision(client: ReplyClient, entry: PendingInteraction, decision: ProviderPermissionDecision): Promise<void> {
    const answers = readObjectRecord(readObjectRecord(decision.updatedInput)?.answers);
    const answer: OpenCodeFormAnswer = {};
    if (decision.allow && answers) {
      for (const field of entry.formFields) {
        const raw = answers[field.description ?? ''] ?? answers[field.key] ?? answers[field.title ?? ''];
        if (typeof raw !== 'string' || !raw.trim()) {
          continue;
        }
        // The shared panel joins multi-select picks with ", "; an option
        // label containing that sequence cannot be told apart here.
        answer[field.key] = field.type === 'multiselect'
          ? raw.split(MULTI_SELECT_JOINER).map((part) => part.trim()).filter(Boolean)
          : raw;
      }
    }
    if (Object.keys(answer).length === 0) {
      return client.cancelForm(entry.providerSessionId, entry.requestId, decision.message?.trim() || SKIPPED_FORM_MESSAGE);
    }
    return client.replyForm(entry.providerSessionId, entry.requestId, answer);
  }

  private settleExternally(requestId: string | undefined, outcome: 'resolved' | 'cancelled'): void {
    if (!requestId) {
      return;
    }
    const entry = this.pending.get(requestId);
    if (!entry) {
      return;
    }
    this.pending.delete(requestId);
    this.retract(entry, outcome);
  }

  private retract(entry: PendingInteraction, outcome: 'resolved' | 'cancelled', reason?: string): void {
    entry.writer.send(createNormalizedMessage({
      id: generateMessageId(PROVIDER),
      sessionId: entry.appSessionId,
      provider: PROVIDER,
      ...(outcome === 'resolved'
        ? { kind: 'permission_resolved' as const, requestId: entry.requestId }
        : { kind: 'permission_cancelled' as const, requestId: entry.requestId, reason }),
    }));
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const entry of [...this.pending.values()]) {
      if (now - entry.receivedAt.getTime() <= this.pendingTtlMs) {
        continue;
      }
      this.pending.delete(entry.requestId);
      const client = this.getClient();
      if (client) {
        const settle = entry.kind === 'permission'
          ? client.replyPermission(entry.providerSessionId, entry.requestId, { decision: 'reject', message: EXPIRED_MESSAGE })
          : client.cancelForm(entry.providerSessionId, entry.requestId, EXPIRED_MESSAGE);
        settle.catch(() => {
          // The run that owned the request is long gone; nothing to repair.
        });
      }
      this.retract(entry, 'cancelled', EXPIRED_MESSAGE);
    }
  }
}
