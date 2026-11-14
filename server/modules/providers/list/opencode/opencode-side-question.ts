import { SIDE_QUESTION_ANSWER_SEPARATOR, errorMessage, readObjectRecord, readOptionalString } from '@/shared/utils.js';
import type {
  ProviderRuntimeContext,
  SideQuestionOutcome,
  SideQuestionRequest,
  SideQuestionSink,
} from '@/shared/types.js';

import type { OpenCodeApiClient, OpenCodePermissionRule } from './opencode-api.client.js';
import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';
import { ensureOpenCodeClient } from './opencode-runtime.provider.js';

/**
 * Answers one side question on an ephemeral, read-only fork of an OpenCode
 * session (upstream #1673), over the v2 service API.
 *
 * The fork is a real copy (`POST /api/session/:id/fork`), so before anything
 * is asked the copy gets deny rules for every mutating action — measured on
 * 2.2.7: a denied action's tool simply vanishes from the fork's toolset,
 * which is this engine's read-only sandbox. The turn is prompted, streamed
 * over a private `/api/event` SSE connection filtered to the fork's session
 * id, and the fork is deleted once the answer is in, so the engine store
 * never keeps a copy of the conversation.
 *
 * Never rejects: every failure comes back as an `error` outcome, as
 * `SideQuestionRuntime` requires.
 */

/** Actions a side question denies on its fork; the mirror of claude's Read/Grep/Glob. */
const SIDE_QUESTION_DENY_RULES: OpenCodePermissionRule[] = ['shell', 'edit', 'write', 'patch']
  .map((action) => ({ action, resource: '*', effect: 'deny' as const }));

/** A short preamble so the fork answers the side question, not the conversation. */
const SIDE_QUESTION_PREAMBLE =
  'This is a side question asked apart from the ongoing conversation, on a read-only '
  + 'copy of it. Do not use any tool that changes anything. Answer briefly, in the '
  + 'language the question was asked in.';

/** One streamed text segment of the fork's turn. */
type TextSegment = { deltas: string; endedText: string | null };

/** The execution events that end a turn; `started` begins one and is ignored. */
const TERMINAL_EXECUTION_EVENTS = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
]);

function buildSideQuestionPrompt(question: string): string {
  return `${SIDE_QUESTION_PREAMBLE}\n\n${question}`;
}

/**
 * Reads one `data:` frame's JSON payload; comments (heartbeats) and broken
 * frames are skipped, matching the service's SSE shape (`data: <json>` frames
 * separated by blank lines).
 */
function parseOpenCodeSseFrame(frame: string): OpenCodeEventEnvelope | null {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) {
    return null;
  }
  try {
    return JSON.parse(dataLine.slice(5)) as OpenCodeEventEnvelope;
  } catch {
    return null;
  }
}

/**
 * Opens one private `/api/event` connection for one side question — the
 * fetch is issued immediately, before the caller prompts, so no frame of the
 * turn is missed. The shared stream is tied to the run registry's lifecycle;
 * a side question needs an isolated, short-lived reader it can abort with
 * the question.
 */
function openOpenCodeEventStream(
  client: OpenCodeApiClient,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): AsyncGenerator<OpenCodeEventEnvelope> {
  const responsePromise = fetchImpl(`${client.endpoint.url}/api/event`, {
    headers: { authorization: client.endpoint.authorization, accept: 'text/event-stream' },
    signal,
  });

  return (async function* () {
    const response = await responsePromise;
    if (!response.ok || !response.body) {
      throw new Error(`the OpenCode event stream answered ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const event = parseOpenCodeSseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event) {
            yield event;
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
}

/**
 * Asks one question on the fork and resolves the assembled answer. The
 * `openEvents` seam exists for tests: production opens the private SSE
 * connection, tests script frames instead.
 */
export async function askOpenCodeSideQuestion(
  request: SideQuestionRequest,
  sink: SideQuestionSink,
  deps: {
    client?: OpenCodeApiClient;
    createQuery?: ProviderRuntimeContext['createQuery'];
    fetch?: typeof fetch;
  } = {},
): Promise<SideQuestionOutcome> {
  if (!request.providerSessionId) {
    return {
      status: 'error',
      error: 'This OpenCode session has no session to ask a side question on yet.',
      answer: '',
    };
  }

  const client = deps.client ?? await ensureOpenCodeClient();

  // The stream is aborted with the question; the fork outlives neither.
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (request.signal.aborted) {
    abortController.abort();
  } else {
    request.signal.addEventListener('abort', onAbort);
  }

  let childId: string | null = null;
  let aborted = false;
  const segments: TextSegment[] = [];
  let current: TextSegment | null = null;

  const assembled = (): string => segments
    .map((segment) => segment.endedText ?? segment.deltas)
    .filter((text) => text.trim().length > 0)
    .join(SIDE_QUESTION_ANSWER_SEPARATOR);

  const finish = (outcome: SideQuestionOutcome): SideQuestionOutcome => {
    request.signal.removeEventListener('abort', onAbort);
    return outcome;
  };

  // Best effort: a stop of the run and the fork coming off disk. Neither can
  // change the outcome — a delete that exploded (engine already gone) is
  // retried by the next store reconciliation, not by the answer.
  const cleanup = async (): Promise<void> => {
    if (!childId) {
      return;
    }
    try {
      if (aborted) {
        await client.interrupt(childId);
      }
    } catch { /* the run may already be over */ }
    try {
      await client.deleteSession(childId);
    } catch { /* the fork may already be gone */ }
  };

  try {
    // 1. The fork: a real copy of the whole conversation.
    const forked = await client.forkSession(request.providerSessionId, {});
    childId = forked.id;

    // 2. Read-only. If the rules cannot be pinned, the question is refused:
    //    a copy that kept the parent's permissions could mutate anything.
    await client.setPermissions(childId, SIDE_QUESTION_DENY_RULES);

    // 3. The private stream opens before the prompt so no frame is missed.
    const fetchImpl = deps.fetch ?? fetch;
    const events = openOpenCodeEventStream(client, abortController.signal, fetchImpl);
    await client.prompt(childId, { text: buildSideQuestionPrompt(request.question) });

    let terminal: string | null = null;
    for await (const event of events) {
      const data = readObjectRecord(event.data);
      if (readOptionalString(data?.sessionID) !== childId) {
        continue;
      }
      if (TERMINAL_EXECUTION_EVENTS.has(event.type)) {
        terminal = event.type;
        break;
      }
      switch (event.type) {
        case 'session.text.started': {
          if (current) {
            segments.push(current);
          }
          current = { deltas: '', endedText: null };
          break;
        }
        case 'session.text.delta': {
          const delta = readOptionalString(data?.delta) ?? '';
          if (!current) {
            current = { deltas: '', endedText: null };
          }
          if (delta) {
            current.deltas += delta;
            sink.delta(delta);
          }
          break;
        }
        case 'session.text.ended': {
          if (!current) {
            current = { deltas: '', endedText: null };
          }
          // The ended frame carries the finished segment text; the deltas
          // streamed for it are the same content in flight form.
          const text = readOptionalString(data?.text);
          if (typeof text === 'string') {
            current.endedText = text;
          }
          segments.push(current);
          current = null;
          break;
        }
        default:
          break;
      }
    }
    if (current) {
      segments.push(current);
    }

    if (request.signal.aborted) {
      aborted = true;
      return finish({
        status: 'error',
        error: 'The side question was aborted.',
        answer: assembled(),
      });
    }

    const answer = assembled();
    if (terminal === 'session.execution.succeeded') {
      if (answer.length > 0) {
        return finish({ status: 'done', answer });
      }
      return finish({ status: 'error', error: 'OpenCode returned no answer.', answer: '' });
    }
    const reason = terminal?.replace('session.execution.', '') ?? 'no answer';
    return finish({
      status: 'error',
      error: `OpenCode ended the side question (${reason}).`,
      answer,
    });
  } catch (error) {
    if (request.signal.aborted) {
      aborted = true;
      return finish({
        status: 'error',
        error: 'The side question was aborted.',
        answer: assembled(),
      });
    }
    return finish({ status: 'error', error: errorMessage(error), answer: assembled() });
  } finally {
    await cleanup();
  }
}
