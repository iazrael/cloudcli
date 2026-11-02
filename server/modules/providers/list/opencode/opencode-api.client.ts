/**
 * OpenCode Service API Client
 *
 * Thin typed wrapper over the handful of `opencode serve` HTTP endpoints the
 * runtime drives (verified against v2.0.31 with live probes; compaction
 * against v2.0.32): session creation, model/agent/permission switches,
 * prompting, compaction, interruption, the permission/form replies that
 * answer the interactive cards, and the revert/fork cuts behind message
 * editing and "fork from here".
 *
 * Every call authenticates with HTTP Basic (`opencode:<password>`) — the
 * scheme the CLI's own standalone server uses — and surfaces non-2xx answers
 * as `OpenCodeApiError` so callers can tell "session gone" from "service down".
 *
 * @module opencode-api.client
 */

//----------------- ENDPOINT & MODEL REFERENCES ------------

/** Ceiling for one API round trip; prompt/interrupt calls are short by design. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * One reachable `opencode serve` instance plus the credential to talk to it.
 *
 * Consumers: opencode service supervisor (producer), api client, event
 * stream (both consume `url` + `authorization`).
 */
export type OpenCodeServiceEndpoint = {
  /** Base URL, e.g. `http://127.0.0.1:57596`. */
  url: string;
  /** Full `Authorization` header value (Basic). */
  authorization: string;
};

/**
 * Model reference in the service API's object form. `variant` carries what
 * the UI calls reasoning effort (`low`/`high`/`max`/…); omitted = provider
 * default.
 *
 * Consumers: opencode runtime (per-message model switch), api client.
 */
export type OpenCodeModelRef = {
  providerID: string;
  id: string;
  variant?: string;
};

/**
 * Parses the `provider/model` or `provider/model#variant` string the UI and
 * catalog use into the object the service API requires (a plain string is
 * rejected with "Expected Model.Ref").
 *
 * Consumer: opencode runtime.
 */
export function parseOpenCodeModelRef(model: string, variant?: string | null): OpenCodeModelRef | null {
  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }
  const [withoutVariant, inlineVariant] = trimmed.split('#', 2);
  const slash = withoutVariant.indexOf('/');
  if (slash <= 0 || slash === withoutVariant.length - 1) {
    return null;
  }
  const ref: OpenCodeModelRef = {
    providerID: withoutVariant.slice(0, slash),
    id: withoutVariant.slice(slash + 1),
  };
  const resolvedVariant = (variant ?? inlineVariant ?? '').trim();
  if (resolvedVariant) {
    ref.variant = resolvedVariant;
  }
  return ref;
}

// ---------------------------

//----------------- REQUEST / RESPONSE SHAPES ------------

/** Session permission rule as the service stores it (`PATCH /api/session/:id`). */
export type OpenCodePermissionRule = {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
};

/** One attachment on a prompt; `uri` is a `data:` or `file:` URI. */
export type OpenCodePromptFile = {
  uri: string;
  filename: string;
  mime: string;
};

/** Reply to a `permission.asked` request. */
export type OpenCodePermissionReply = {
  decision: 'once' | 'always' | 'reject';
  message?: string;
};

/** Form answers keyed by field key (`q0`, `q1`, …); multiselect values are arrays. */
export type OpenCodeFormAnswer = Record<string, string | string[]>;

/**
 * What `GET /api/shell/:id` tells the runtime about one backgrounded command
 * (verified against v2.0.32): `running` while the job goes, `timeout` or
 * `killed` once the engine ended it, and the process exit code for a job that
 * ran to completion.
 *
 * Consumer: opencode run registry (background-work deadline re-check).
 */
export type OpenCodeShellSnapshot = {
  /** The engine's word on the job; null when the response carried none. */
  status: string | null;
  /** Process exit code; null when the job never ran to completion. */
  exitCode: number | null;
};

/** What `GET /api/session/:id` tells the runtime (verified against v2.0.31). */
export type OpenCodeSessionSnapshot = {
  /** `succeeded` / `failed` / `interrupted` once a run finished; null while running or before any run. */
  outcome: string | null;
  /** Epoch ms when the session last went idle; null while a run is in flight. */
  idleAt: number | null;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } | null;
};

// ---------------------------

/**
 * A non-2xx answer from the service.
 *
 * Consumer: opencode runtime and interaction bridge (map 404 on a session to
 * "session gone", everything else to a surfaced error).
 */
export class OpenCodeApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(method: string, path: string, status: number, body: unknown) {
    const detail = typeof body === 'object' && body !== null && 'message' in body
      ? String((body as { message: unknown }).message)
      : typeof body === 'string' && body.trim()
        ? body.trim().slice(0, 200)
        : '';
    super(`OpenCode API ${method} ${path} failed with ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'OpenCodeApiError';
    this.status = status;
    this.body = body;
  }
}

type FetchLike = typeof fetch;

/**
 * Typed client bound to one endpoint.
 *
 * Consumers: opencode runtime (session/prompt/interrupt), opencode
 * interaction bridge (permission/form replies), opencode sessions and fork
 * providers (revert/fork). Tests inject `fetch`.
 */
export class OpenCodeApiClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    readonly endpoint: OpenCodeServiceEndpoint,
    dependencies: { fetch?: FetchLike } = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? fetch;
  }

  /** `POST /api/session` — anchored to `directory`; returns the new session id. */
  async createSession(input: { directory: string; title?: string }): Promise<{ id: string }> {
    const body: Record<string, unknown> = { location: { directory: input.directory } };
    if (input.title) {
      body.title = input.title;
    }
    const result = await this.request<{ data?: { id?: unknown } }>('POST', '/api/session', body);
    const id = result?.data?.id;
    if (typeof id !== 'string' || !id) {
      throw new OpenCodeApiError('POST', '/api/session', 200, 'response carried no session id');
    }
    return { id };
  }

  /** `POST /api/session/:id/model` — persists the model (+ variant) for later prompts. */
  async switchModel(sessionId: string, model: OpenCodeModelRef): Promise<void> {
    await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/model`, { model });
  }

  /** `POST /api/session/:id/agent` — `plan` (read-only) or `build`. */
  async switchAgent(sessionId: string, agent: string): Promise<void> {
    await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/agent`, { agent });
  }

  /** `PATCH /api/session/:id` — replaces the session's permission rule list. */
  async setPermissions(sessionId: string, permissions: OpenCodePermissionRule[]): Promise<void> {
    await this.request('PATCH', `/api/session/${encodeURIComponent(sessionId)}`, { permissions });
  }

  /** `POST /api/session/:id/prompt` — enqueues the user turn; events report progress. */
  async prompt(sessionId: string, input: { text: string; files?: OpenCodePromptFile[] }): Promise<{ messageId: string | null }> {
    const body: Record<string, unknown> = { text: input.text };
    if (input.files && input.files.length > 0) {
      body.files = input.files;
    }
    const result = await this.request<{ data?: { id?: unknown } }>(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      body,
    );
    const messageId = result?.data?.id;
    return { messageId: typeof messageId === 'string' ? messageId : null };
  }

  /**
   * `POST /api/session/:id/compact` — admits a synthetic `compaction` message
   * into the session's queue (verified against v2.0.32), which the engine then
   * runs as a turn of its own: the summary streams over the service's
   * `session.compaction.*` events and the turn ends with the usual
   * `session.execution.*` terminal. The response only reports the admitted
   * message, so the run's outcome comes from the event feed — not from here.
   */
  async compactSession(sessionId: string): Promise<{ messageId: string | null }> {
    const result = await this.request<{ data?: { id?: unknown } }>(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/compact`,
      {},
    );
    const messageId = result?.data?.id;
    return { messageId: typeof messageId === 'string' ? messageId : null };
  }

  /**
   * `POST /api/session/:id/fork` — copies the conversation into a new
   * top-level session and returns its id. The cut is **exclusive**: only the
   * messages strictly before `before` are copied, and the whole conversation
   * when it is null (verified against v2.1.4; the copy gets fresh message ids
   * and no `parent_id`, so it indexes as an ordinary session).
   *
   * Consumer: opencode fork provider.
   */
  async forkSession(sessionId: string, before: string | null): Promise<{ id: string }> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/fork`;
    const result = await this.request<{ data?: { id?: unknown } }>('POST', path, before ? { before } : {});
    const id = result?.data?.id;
    if (typeof id !== 'string' || !id) {
      throw new OpenCodeApiError('POST', path, 200, 'response carried no session id');
    }
    return { id };
  }

  /**
   * Drops `messageId` and everything after it from the session: stages the
   * revert boundary (`POST /revert/stage`, restoring the files those turns
   * changed when `files` is set) and commits it (`POST /revert/commit`), which
   * deletes the rows (verified against v2.1.4). A commit that fails clears the
   * staged boundary again so the session is not left half-reverted.
   *
   * Consumer: opencode sessions provider (message editing).
   */
  async revertSession(sessionId: string, messageId: string, options: { files: boolean }): Promise<void> {
    const base = `/api/session/${encodeURIComponent(sessionId)}/revert`;
    await this.request('POST', `${base}/stage`, { messageID: messageId, files: options.files });
    try {
      await this.request('POST', `${base}/commit`);
    } catch (error) {
      await this.request('DELETE', base).catch(() => undefined);
      throw error;
    }
  }

  /** `POST /api/session/:id/interrupt` — true when a run was actually stopped. */
  async interrupt(sessionId: string): Promise<boolean> {
    const result = await this.request<{ interrupted?: unknown }>(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
    );
    return result?.interrupted === true;
  }

  /**
   * `GET /api/shell/:id` — one backgrounded command as the engine holds it.
   * `directory` scopes the read to the session's instance, which matters when
   * one serve drives several projects.
   *
   * Consumer: opencode run registry (deadline re-check) — a command has no
   * session row to poll, so this is its only re-readable verdict.
   */
  async getShell(shellId: string, directory?: string): Promise<OpenCodeShellSnapshot> {
    const result = await this.request<{ data?: Record<string, unknown> }>(
      'GET',
      this.shellPath(shellId, directory),
    );
    const data = result?.data ?? {};
    return {
      status: typeof data.status === 'string' ? data.status : null,
      exitCode: typeof data.exit === 'number' ? data.exit : null,
    };
  }

  /**
   * `DELETE /api/shell/:id` — stops one backgrounded command (the same request
   * the CLI's own "kill shell command" uses). The engine answers 204; a handle
   * it no longer holds throws `OpenCodeApiError` with status 404, which the
   * caller judges (a stale record is already over, not a failure).
   *
   * Consumer: opencode runtime (`chat.stop-task` for a command's strip row).
   */
  async removeShell(shellId: string, directory?: string): Promise<void> {
    await this.request('DELETE', this.shellPath(shellId, directory));
  }

  private shellPath(shellId: string, directory?: string): string {
    const shellPath = `/api/shell/${encodeURIComponent(shellId)}`;
    if (!directory) {
      return shellPath;
    }
    return `${shellPath}?${new URLSearchParams({ 'location[directory]': directory }).toString()}`;
  }

  /** `POST /api/session/:id/permission/:requestId/reply`. */
  async replyPermission(sessionId: string, requestId: string, reply: OpenCodePermissionReply): Promise<void> {
    await this.request(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      reply,
    );
  }

  /** `POST /api/session/:id/form/:formId/reply`. */
  async replyForm(sessionId: string, formId: string, answer: OpenCodeFormAnswer): Promise<void> {
    await this.request(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
      { answer },
    );
  }

  /**
   * `DELETE /api/session/:id/form/:formId[?message=…]` — dismisses the form.
   * A message (query string, per the server handler) turns the dismissal into
   * model-facing feedback so the model continues; without one the question
   * tool treats it as a hard cancel.
   */
  async cancelForm(sessionId: string, formId: string, message?: string): Promise<void> {
    const query = message ? `?message=${encodeURIComponent(message)}` : '';
    await this.request(
      'DELETE',
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}${query}`,
    );
  }

  /**
   * `GET /api/session/:id/form` — the forms the service still holds for the
   * session, in the same shape `form.created` carries (verified against
   * v2.0.32: a pending question is listed until it is answered or cancelled).
   *
   * Consumer: opencode interaction bridge (reconcile) — a `form.created` event
   * lost while the event feed was down leaves no trace anywhere else, so the
   * card can only be rebuilt from this list.
   */
  async listForms(sessionId: string): Promise<unknown[]> {
    const result = await this.request<{ data?: unknown }>(
      'GET',
      `/api/session/${encodeURIComponent(sessionId)}/form`,
    );
    return Array.isArray(result?.data) ? result.data : [];
  }

  /**
   * `GET /api/session/:id/permission` — the permission requests the service
   * still holds for the session. Same recover-from-a-gap role as `listForms`.
   */
  async listPermissionRequests(sessionId: string): Promise<unknown[]> {
    const result = await this.request<{ data?: unknown }>(
      'GET',
      `/api/session/${encodeURIComponent(sessionId)}/permission`,
    );
    return Array.isArray(result?.data) ? result.data : [];
  }

  /**
   * `GET /api/session/:id` — the session row. `outcome` and `time.idle` are
   * set once a run has finished (the runtime uses them to reconcile a run
   * whose terminal event was missed during a stream drop); `tokens` are the
   * session's running totals.
   */
  async getSession(sessionId: string): Promise<OpenCodeSessionSnapshot> {
    const result = await this.request<{ data?: Record<string, unknown> }>(
      'GET',
      `/api/session/${encodeURIComponent(sessionId)}`,
    );
    const data = result?.data ?? {};
    const time = (data.time ?? {}) as Record<string, unknown>;
    const tokens = (data.tokens ?? null) as Record<string, unknown> | null;
    const cache = (tokens?.cache ?? {}) as Record<string, unknown>;
    const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    return {
      outcome: typeof data.outcome === 'string' ? data.outcome : null,
      idleAt: typeof time.idle === 'number' ? time.idle : null,
      tokens: tokens
        ? {
          input: num(tokens.input),
          output: num(tokens.output),
          reasoning: num(tokens.reasoning),
          cacheRead: num(cache.read),
          cacheWrite: num(cache.write),
        }
        : null,
    };
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.endpoint.url}${path}`, {
      method,
      headers: {
        authorization: this.endpoint.authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A half-dead service must not hold a chat send for the network stack's
      // default (~5 min) timeout; every call here is a short API round trip.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      throw new OpenCodeApiError(method, path, response.status, parsed);
    }
    return (text ? parsed : undefined) as T;
  }
}
