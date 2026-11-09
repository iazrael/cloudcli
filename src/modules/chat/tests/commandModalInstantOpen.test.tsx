import assert from 'node:assert/strict';

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { i18n, initI18n } from '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { CommandModalPayload } from '@/modules/chat/hooks/useChatComposerState';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import type { PermissionMode, Project } from '@/shared/types';

/**
 * Built-in modal commands (/cost, /help, /models, /status) open their modal
 * before `/api/commands/execute` answers: on a slow link the round trip took
 * seconds with nothing on screen, so users clicked the token button again. The
 * answer is bound to the opening: a modal the user closed is not reopened and
 * the composer's token count is not overwritten by a late reply.
 */

// Copy assertions need real translations; bundles load per language.
await initI18n();

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };

const BUILTIN_COMMANDS = ['/help', '/models', '/cost', '/status'].map((name) => ({
  name,
  description: name,
  namespace: 'builtin',
  metadata: { type: 'builtin' },
}));

const LOCAL_TOKEN_BUDGET = { used: 1200, total: 200000, inputTokens: 1000, outputTokens: 200 };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Deferred = { resolve: (response: Response) => void; reject: (error: unknown) => void };
let pendingExecutes: Deferred[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

const renderComposer = (tokenBudget: Record<string, unknown> | null = LOCAL_TOKEN_BUDGET) => {
  const messages: Array<{ content?: unknown }> = [];
  const setTokenBudget = vi.fn();
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: { id: 'session-1' },
      currentSessionId: 'session-1',
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'local-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget,
      setTokenBudget,
      sendMessage: () => undefined,
      onSessionEstablished: () => undefined,
      stickToBottomAfterSend: () => undefined,
      addMessage: (message) => { messages.push(message as { content?: unknown }); },
      setPendingPermissionRequests: () => undefined,
    }));
  return { view, messages, setTokenBudget };
};

const typeCommand = async (view: ReturnType<typeof renderComposer>['view'], text: string) => {
  await waitFor(() => assert.equal(view.result.current.slashCommandsCount, BUILTIN_COMMANDS.length));
  await act(async () => { view.result.current.setInput(text); });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

const answerExecute = async (response: Response) => {
  await waitFor(() => assert.equal(pendingExecutes.length, 1));
  await act(async () => {
    pendingExecutes.shift()!.resolve(response);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const SERVER_COST = {
  type: 'builtin',
  action: 'cost',
  data: {
    tokenUsage: { used: 5000, total: 200000 },
    tokenBreakdown: { input: 4000, output: 1000 },
    provider: 'claude',
    model: 'session-model',
  },
};

beforeEach(() => {
  pendingExecutes = [];
  fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target === '/api/commands/list' && init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ builtIn: BUILTIN_COMMANDS, custom: [], count: BUILTIN_COMMANDS.length }));
    }
    if (target === '/api/commands/execute' && init?.method === 'POST') {
      return new Promise<Response>((resolve, reject) => { pendingExecutes.push({ resolve, reject }); });
    }
    return Promise.resolve(jsonResponse({ success: true, data: { skills: [] } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('the token button opens the cost modal with local data before the server answers', async () => {
  const { view, setTokenBudget } = renderComposer();

  act(() => { view.result.current.showCostModal(); });

  const opened = view.result.current.commandModalPayload;
  assert.equal(opened?.kind, 'cost');
  assert.equal(opened?.pending, true);
  assert.deepEqual(opened?.data, {
    provider: 'claude',
    model: 'local-model',
    tokenUsage: { used: 1200, total: 200000 },
    tokenBreakdown: { input: 1000, output: 200 },
  });

  await answerExecute(jsonResponse(SERVER_COST));

  const answered = view.result.current.commandModalPayload;
  assert.equal(answered?.pending, false);
  assert.equal((answered?.data as { model?: string } | undefined)?.model, 'session-model');
  assert.equal(setTokenBudget.mock.calls.length, 1);
});

test('a cost modal opened without local usage carries no token numbers', () => {
  const { view } = renderComposer(null);

  act(() => { view.result.current.showCostModal(); });

  assert.deepEqual(view.result.current.commandModalPayload?.data, { provider: 'claude', model: 'local-model' });
});

test('closing the modal before the answer keeps the late answer from reopening it', async () => {
  const { view, setTokenBudget } = renderComposer();

  act(() => { view.result.current.showCostModal(); });
  act(() => { view.result.current.closeCommandModal(); });
  await answerExecute(jsonResponse(SERVER_COST));

  assert.equal(view.result.current.commandModalPayload, null);
  assert.equal(setTokenBudget.mock.calls.length, 0);
});

test('a failed cost answer keeps the local data on screen and ends the loading state', async () => {
  const { view, messages } = renderComposer();

  act(() => { view.result.current.showCostModal(); });
  await answerExecute(jsonResponse({ message: 'gateway timeout' }, 524));

  const payload = view.result.current.commandModalPayload;
  assert.equal(payload?.kind, 'cost');
  assert.equal(payload?.pending, false);
  assert.equal((payload?.data as { model?: string } | undefined)?.model, 'local-model');
  assert.equal(messages.length, 0);
});

test('a typed /status opens a loading modal at once and fills it from the answer', async () => {
  const { view } = renderComposer();

  await typeCommand(view, '/status');

  assert.deepEqual(view.result.current.commandModalPayload, { kind: 'status', data: {}, pending: true });

  await answerExecute(jsonResponse({ type: 'builtin', action: 'status', data: { version: '9.9.9' } }));

  assert.deepEqual(view.result.current.commandModalPayload, { kind: 'status', data: { version: '9.9.9' }, pending: false });
});

test('a typed /status closed before its answer still clears the composer', async () => {
  const { view } = renderComposer();

  await typeCommand(view, '/status');
  act(() => { view.result.current.closeCommandModal(); });
  await answerExecute(jsonResponse({ type: 'builtin', action: 'status', data: { version: '9.9.9' } }));

  assert.equal(view.result.current.commandModalPayload, null);
  assert.equal(view.result.current.input, '');
});

test('a failed /help answer closes its loading modal and reports the error', async () => {
  const { view, messages } = renderComposer();

  await typeCommand(view, '/help');
  assert.equal(view.result.current.commandModalPayload?.pending, true);

  await answerExecute(jsonResponse({ message: 'boom' }, 500));

  assert.equal(view.result.current.commandModalPayload, null);
  assert.equal(messages.length, 1);
  assert.match(String(messages[0].content), /boom/);
});

const renderModal = (payload: CommandModalPayload) => render(
  <I18nextProvider i18n={i18n}>
  <CommandResultModal
    payload={payload}
    onClose={() => undefined}
    providerModelCatalog={{}}
    providerModelActions={{} as never}
    activeProvider="claude"
    activeProviderModel="local-model"
    currentSessionId="session-1"
    onSelectProviderModel={async () => ({ success: true }) as never}
  />
  </I18nextProvider>,
);

test('a pending status modal shows a loading state instead of placeholder values', () => {
  renderModal({ kind: 'status', data: {}, pending: true });

  assert.ok(screen.getByText('Loading…'));
  assert.equal(screen.queryByText('Runtime online'), null);
});

test('a pending cost modal without local usage says it is reading usage instead of showing 0', () => {
  renderModal({ kind: 'cost', data: { provider: 'cursor', model: 'local-model' }, pending: true });

  assert.ok(screen.getByText('Reading session usage…'));
  assert.equal(screen.queryByText('Total tokens used'), null);
});
